import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { scopeRepointContractSuite } from '@substrat-run/contract-tests';
import {
  ControlPlaneError,
  createControlPlaneApi,
  drainScopePlatformRequests,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '@substrat-run/control-plane-api';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1869 on workerd, where hosted restores, forks and preview carries run: the ScopeDO's own
 * `importDump`, reached over RPC, re-points exactly the dump's source scope. A tuple whose
 * entity type is `Scope`, `SCOPE` or `scope` is planted through the dump itself, since the
 * write verbs refuse that type (#1856) and a pre-#1856 scope is the only other way to hold one.
 */
const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

// The shared suite, through `HostAdmin` on the DO's default tuple checker.
scopeRepointContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox });
  return { host, cleanup: async () => host.close() };
});

const TUPLES_DDL =
  'CREATE TABLE _substrat_tuples (subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, ' +
  'expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object))';
const COLUMNS = ['subject', 'relation', 'object', 'expires_at', 'revoked_at'];

/** A dump of one tuples table: a genuine role on `source` plus the three namespace-typed grants. */
const dumpFrom = (source: string, ddl = TUPLES_DDL): ScopeDumpTable[] => [
  {
    name: '_substrat_tuples',
    ddl,
    columns: COLUMNS,
    rows: [
      ['principal:gina', 'role:reader', `scope:${source}`, null, null],
      ['principal:hana', 'granted:perm:read', `Scope:${source}`, '2099-01-01T00:00:00.000Z', null],
      ['principal:ivan', 'granted:perm:read', `SCOPE:${source}`, null, null],
      ['principal:jack', 'granted:perm:read', 'scope:e-1', null, null],
    ],
  },
];
const tuplesIn = (tables: ScopeDumpTable[]): unknown[][] =>
  [...(tables.find((t) => t.name === '_substrat_tuples')?.rows ?? [])].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  );
/** Row `i` of `dumpFrom(source)` as planted, and with its object replaced — the only column a re-point writes. */
const kept = (source: string, i: number): unknown[] => dumpFrom(source)[0]!.rows[i]!;
const moved = (source: string, i: number, object: string) => kept(source, i).map((v, c) => (c === 2 ? object : v));

describe("the ScopeDO's importDump picks the rows to re-point (#1869)", () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox });
  const source = scopeId.parse(ulid());

  it('source named and held by the dump: only scope:<source> moves; Scope, SCOPE and scope:e-1 stay byte for byte', async () => {
    const dest = scopeId.parse(ulid());
    await host.restoreScopeLocal(dest, dumpFrom(source), { sourceScopeId: source });
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual([
      moved(source, 0, `scope:${dest}`),
      kept(source, 1),
      kept(source, 2),
      kept(source, 3),
    ]);
  });

  it('source is the destination (a carry onto a new version): nothing moves', async () => {
    await host.restoreScopeLocal(source, dumpFrom(source), { sourceScopeId: source });
    expect(tuplesIn(await host.exportScopeLocal(source))).toEqual([kept(source, 0), kept(source, 1), kept(source, 2), kept(source, 3)]);
  });

  it('no source named (a platform that predates the field): the case-sensitive prefix, so Scope and SCOPE stay', async () => {
    const dest = scopeId.parse(ulid());
    await host.restoreScopeLocal(dest, dumpFrom(source));
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual([
      moved(source, 0, `scope:${dest}`),
      kept(source, 1),
      kept(source, 2),
      // The documented limit of the fallback: exactly `scope` cannot be told from a node grant.
      moved(source, 3, `scope:${dest}`),
    ]);
  });

  it('a source the dump does not hold falls back the same way, rather than stranding the genuine grant', async () => {
    const dest = scopeId.parse(ulid());
    await host.restoreScopeLocal(dest, dumpFrom(source), { sourceScopeId: dest });
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual([
      moved(source, 0, `scope:${dest}`),
      kept(source, 1),
      kept(source, 2),
      moved(source, 3, `scope:${dest}`),
    ]);
  });

  it('exact (platform-exported) with no row on the source: nothing moves, where the fallback would move scope:e-1', async () => {
    const self = scopeId.parse(ulid());
    const bare = dumpFrom(self).map((t) => ({ ...t, rows: t.rows.slice(1) }));
    await host.restoreScopeLocal(self, bare, { sourceScopeId: self, exact: true });
    expect(tuplesIn(await host.exportScopeLocal(self))).toEqual([kept(self, 1), kept(self, 2), kept(self, 3)]);
  });

  it('exact with no source named is refused before anything is dropped; the twin with a source lands', async () => {
    const dest = scopeId.parse(ulid());
    await host.restoreScopeLocal(dest, dumpFrom(source), { sourceScopeId: source, exact: true });
    const before = tuplesIn(await host.exportScopeLocal(dest));
    await expect(host.restoreScopeLocal(dest, dumpFrom(dest), { exact: true })).rejects.toThrow(
      /`exact` needs the scope the dump came from/,
    );
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual(before);
  });

  it('snapshotScopeLocal of a scope holding no grant on itself copies scope:e-1 byte for byte', async () => {
    // The CP-less snapshot is a platform copy: its re-point is exact and never falls back.
    const self = scopeId.parse(ulid());
    await host.restoreScopeLocal(self, dumpFrom(self).map((t) => ({ ...t, rows: t.rows.slice(1) })), {
      sourceScopeId: self,
      exact: true,
    });
    const snap = scopeId.parse(ulid());
    await host.snapshotScopeLocal(self, snap);
    expect(tuplesIn(await host.exportScopeLocal(snap))).toEqual([kept(self, 1), kept(self, 2), kept(self, 3)]);
  });

  it('grants on a third scope: a caller-supplied dump is refused and the target kept; a platform copy leaves them be', async () => {
    const dest = scopeId.parse(ulid());
    await host.restoreScopeLocal(dest, dumpFrom(source), { sourceScopeId: source, exact: true });
    const before = tuplesIn(await host.exportScopeLocal(dest));
    const third = scopeId.parse(ulid());
    const strayRow = ['principal:lena', 'role:reader', `scope:${third}`, null, null];
    const mixed = dumpFrom(source).map((t) => ({ ...t, rows: [...t.rows, strayRow] }));
    await expect(host.restoreScopeLocal(dest, mixed, { sourceScopeId: source })).rejects.toThrow(
      new RegExp(`restore refused: the dump holds grants on 1 scope\\(s\\) other than its source .*scope:${third}`),
    );
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual(before);
    // A revoked third-scope grant (K-21 tombstone) authorizes nothing, so it does not refuse.
    const revoked = ['principal:lena', 'role:reader', `scope:${third}`, null, '2026-01-01T00:00:00.000Z'];
    const tombstoned = dumpFrom(source).map((t) => ({ ...t, rows: [...t.rows, revoked] }));
    await host.restoreScopeLocal(dest, tombstoned, { sourceScopeId: source });
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual([...before, revoked]);
    // The platform exported it, so the third-scope row authorized nothing in the source: kept as is.
    await host.restoreScopeLocal(dest, mixed, { sourceScopeId: source, exact: true });
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual([
      moved(source, 0, `scope:${dest}`),
      kept(source, 1),
      kept(source, 2),
      kept(source, 3),
      strayRow,
    ]);
  });

  it('a dump that declares the object column COLLATE NOCASE does not make the match fold case again', async () => {
    const dest = scopeId.parse(ulid());
    const nocase = TUPLES_DDL.replace('object TEXT NOT NULL', 'object TEXT NOT NULL COLLATE NOCASE');
    await host.restoreScopeLocal(dest, dumpFrom(source, nocase), { sourceScopeId: source });
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual([
      moved(source, 0, `scope:${dest}`),
      kept(source, 1),
      kept(source, 2),
      kept(source, 3),
    ]);
    // …and with no source, where the fallback compares a prefix.
    const blind = scopeId.parse(ulid());
    await host.restoreScopeLocal(blind, dumpFrom(source, nocase));
    const rows = tuplesIn(await host.exportScopeLocal(blind));
    expect(rows[1]).toEqual(kept(source, 1));
    expect(rows[2]).toEqual(kept(source, 2));
  });
  // #1883's twin of the node refusal (`adapter-sqlite/test/scope-repoint.test.ts`): the DO's
  // KERNEL_DDL builds `_substrat_roles`, so a dump carrying it restores, rows by column name.
  it('a dump carrying _substrat_roles, a table only this host builds in a scope, lands here', async () => {
    const dest = scopeId.parse(ulid());
    const roles: ScopeDumpTable = {
      name: '_substrat_roles',
      ddl:
        'CREATE TABLE _substrat_roles (tenant_id TEXT NOT NULL, role_key TEXT NOT NULL, permissions TEXT NOT NULL, ' +
        'source TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (tenant_id, role_key))',
      columns: ['tenant_id', 'role_key', 'permissions', 'source', 'revoked_at'],
      rows: [['tenant-a', 'reader', '["perm:read"]', 'vertical', null]],
    };
    await host.restoreScopeLocal(dest, [...dumpFrom(source), roles], { sourceScopeId: source });
    const back = (await host.exportScopeLocal(dest)).find((t) => t.name === '_substrat_roles');
    expect(back?.rows).toEqual(roles.rows);
  });
});

/**
 * The preview paths through the control plane, over real Durable Object namespaces: a
 * preview FORK copies prod into a new scope (source = prod), and a later push CARRIES the
 * preview onto the new version's script (source = destination). Each version is its own DO
 * class, as in preview-carry.test.ts, and the client forwards what `/internal/restore`
 * forwards (vertical-host), `sourceScopeId` included.
 */
describe('preview fork and carry re-point on real DO namespaces (#1869)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const slug = 'repoint-vert';
  const prod = scopeId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: CloudflareScopeHost;
  let api: ReturnType<typeof createControlPlaneApi>;
  const version: Record<'v1' | 'v2', string> = { v1: '', v2: '' };
  const refOf = new Map<string, string>();
  const hostOf = new Map<string, CloudflareScopeHost>();
  const hostFor = (v: keyof typeof version) => hostOf.get(refOf.get(version[v])!)!;

  const relay = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new ControlPlaneError(500, e instanceof Error ? e.message : String(e));
    }
  };
  const clientFor = (ref: string): VerticalClient => {
    const host = hostOf.get(ref)!;
    return {
      exportScope: (sid: ScopeId) => relay(() => host.exportScopeLocal(sid)),
      exportScopeStamped: (sid: ScopeId) => relay(() => host.exportScopeStampedLocal(sid)),
      restoreScope: (
        _t: unknown,
        sid: ScopeId,
        tables: ScopeDumpTable[],
        opts?: {
          sourceScopeId?: ScopeId;
          exact?: boolean;
          loadStamp?: string;
          expect?: { loadStamp: string | null; revision: string | null };
        },
      ) =>
        relay(() =>
          host.restoreScopeLocal(sid, tables, {
            sourceScopeId: opts?.sourceScopeId,
            exact: opts?.exact,
            loadStamp: opts?.loadStamp,
            expect: opts?.expect,
          }),
        ),
      loadMarker: (sid: ScopeId) => relay(() => host.loadMarkerLocal(sid)),
      keptCopy: (sid: ScopeId) => relay(() => host.keptCopyLocal(sid)),
      releaseKeptCopy: (input: { scopeId: ScopeId; revision: string | null }) =>
        relay(() => host.releaseKeptCopyLocal(input.scopeId, input.revision)),
      deleteScope: (input: { scopeId: ScopeId }) => relay(() => host.deleteScopeLocal(input.scopeId)),
      // #1722: what a carry's cleanup calls once the bind lands.
      readScopeTable: (sid: ScopeId, input: { table: string; limit: number; offset: number }) =>
        relay(() => host.introspectScopeTable(sid, input)),
      wipeCarriedCopy: (input: {
        scopeId: ScopeId;
        expectLoadStamp: string | null;
        expectRevision?: string | null;
        protectIfChanged?: boolean;
        carriedTo: string;
        at: string;
      }) =>
        relay(async () => ({
          wiped: await host.wipeCarriedLocal(
            input.scopeId,
            input.expectLoadStamp,
            { to: input.carriedTo, at: input.at },
            input.expectRevision,
            input.protectIfChanged,
          ),
        })),
    } as unknown as VerticalClient;
  };
  const push = async (tag: string, v: keyof typeof version) => {
    const res = await api.request(`/verticals/${slug}/previews`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tag, versionId: version[v] }),
    });
    return { status: res.status, body: (await res.json()) as { scopeId: ScopeId; error?: string } };
  };

  beforeAll(async () => {
    await warmControlPlane(env.PC_CONTROL_PLANE);
    dir = new CloudflareScopeHost({ scope: env.PC_SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
    await dir.admin.createTenant(staff, { id: t, slug: `repoint-${t.toLowerCase()}`, name: 'Repoint Co' });
    await dir.admin.registerVertical(staff, { slug, name: 'Repoint Vert', source: 'cli', ownerTenant: t });
    const namespaces = { v1: env.PC_V1_SCOPE, v2: env.PC_V2_SCOPE };
    for (const v of ['v1', 'v2'] as const) {
      const id = ulid();
      const ref = `repoint-vert-${id.toLowerCase()}`;
      await dir.admin.publishVersion(staff, {
        id, verticalSlug: slug, version: `1.0.${v.slice(1)}`,
        manifestDigest: `m-${v}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
        manifestJson: JSON.stringify({
          version: `1.0.${v.slice(1)}`, entry: 'worker.js', compatibilityDate: '2025-01-01',
          doClasses: ['ScopeDO'],
          bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
          digests: { manifest: `m-${v}`, permission: 'p', migration: 'g' },
          registry: { permissions: [], roles: [], entityGrants: [] },
        }),
      });
      version[v] = id;
      refOf.set(id, ref);
      hostOf.set(ref, new CloudflareScopeHost({ scope: namespaces[v], controlPlane: env.PC_CONTROL_PLANE, secretBox }));
    }
    api = createControlPlaneApi({
      host: dir,
      authenticate: UNSAFE_devPlatformActorAuth(),
      platformBaseDomains: ['global.substrat.run'],
      provisionRetryDelaysMs: [1],
      deployVertical: async () => {},
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' },
      ],
      resolveVerticalVersion: async (s, versionId) => {
        const ref = s === slug ? refOf.get(versionId) : undefined;
        return ref ? clientFor(ref) : undefined;
      },
      resolveVerticalRef: async (ref) => (hostOf.has(ref) ? clientFor(ref) : undefined),
    });
    // Prod's data, planted rows included, lives in v1's script.
    await dir.provisionScope(staff, { tenantId: t, scopeId: prod, vertical: slug });
    await dir.admin.activateScope(staff, t, prod);
    await dir.admin.bindScopeVersion(staff, t, prod, version.v1);
    // A preview URL is derived from the source's platform hostname.
    await dir.admin.bindHostname(staff, {
      hostname: 'repoint-acme.global.substrat.run',
      tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
    await dir.admin.setHostnameStatus(staff, 'repoint-acme.global.substrat.run', 'active');
    await hostFor('v1').restoreScopeLocal(prod, dumpFrom(prod), { sourceScopeId: prod });
  });

  it('a preview fork moves the scope grant onto the preview, and a carry to the next version moves nothing', async () => {
    const created = await push('pr-7', 'v1');
    expect(created.body.error).toBeUndefined();
    expect(created.status).toBe(201);
    const preview = created.body.scopeId;
    const forked = tuplesIn(await hostFor('v1').exportScopeLocal(preview));
    expect(forked).toEqual([moved(prod, 0, `scope:${preview}`), kept(prod, 1), kept(prod, 2), kept(prod, 3)]);

    const second = await push('pr-7', 'v2');
    expect(second.status).toBe(200);
    expect(second.body.scopeId).toBe(preview);
    // The carry landed in v2's script, row for row what v1 held.
    expect(tuplesIn(await hostFor('v2').exportScopeLocal(preview))).toEqual(forked);
  });

  it('a prod holding no grant on itself: the fork and the carry move nothing, scope:e-1 included', async () => {
    // Both are platform-exported, so the re-point is exact and never falls back.
    await hostFor('v1').restoreScopeLocal(prod, dumpFrom(prod).map((t) => ({ ...t, rows: t.rows.slice(1) })), {
      sourceScopeId: prod,
      exact: true,
    });
    const created = await push('pr-8', 'v1');
    expect(created.status).toBe(201);
    const preview = created.body.scopeId;
    const want = [kept(prod, 1), kept(prod, 2), kept(prod, 3)];
    expect(tuplesIn(await hostFor('v1').exportScopeLocal(preview))).toEqual(want);
    expect((await push('pr-8', 'v2')).status).toBe(200);
    expect(tuplesIn(await hostFor('v2').exportScopeLocal(preview))).toEqual(want);
  });

  it("#1686: a preview fork carries none of prod's capability rows; a carry keeps the preview's own", async () => {
    await hostFor('v1').restoreScopeLocal(prod, [...dumpFrom(prod), ...capTables('prod')], { sourceScopeId: prod });
    const created = await push('pr-9', 'v1');
    expect(created.status).toBe(201);
    const preview = created.body.scopeId;
    expect(capsIn(await hostFor('v1').exportScopeLocal(preview))).toEqual(none);
    expect(capsIn(await hostFor('v1').exportScopeLocal(prod))).toEqual(held('prod'));
    // A link minted IN the preview is the preview's own, and a carry onto the next version keeps it.
    await hostFor('v1').restoreScopeLocal(preview, [...dumpFrom(preview), ...capTables('pr-9')], { sourceScopeId: preview });
    expect((await push('pr-9', 'v2')).status).toBe(200);
    expect(capsIn(await hostFor('v2').exportScopeLocal(preview))).toEqual(held('pr-9'));
  });

  it("#1686: the drain run on a preview fork executes none of prod's pending intents; on prod it runs them", async () => {
    const intentId = ulid();
    await hostFor('v1').restoreScopeLocal(prod, [...dumpFrom(prod), pendingIntent(intentId)], { sourceScopeId: prod });
    const created = await push('pr-10', 'v1');
    expect(created.status).toBe(201);
    const preview = created.body.scopeId;
    // The real drain, with the handler counting what it was asked to run.
    const ran: string[] = [];
    const drain = (sid: ScopeId) =>
      drainScopePlatformRequests(
        hostFor('v1'),
        { tenantId: t, scopeId: sid, vertical: slug, versionId: version.v1 },
        { 'provision-sibling': async (_ctx, r) => (ran.push(`${sid}:${r.id}`), { status: 'done' }) },
      );
    expect(await drain(preview)).toMatchObject({ drained: 0, done: 0 });
    expect(ran).toEqual([]);
    // The twin: prod's own drain runs it, once.
    expect(await drain(prod)).toMatchObject({ drained: 1, done: 1 });
    expect(ran).toEqual([`${prod}:${intentId}`]);
  });
});

/**
 * #1686 on workerd: capability rows never cross a scope id. The rows are planted through the
 * dump, so each path below loads the same two tables; which of them arrives is the property.
 */
const capTables = (marker: string): ScopeDumpTable[] => [
  {
    name: '_substrat_capabilities',
    ddl: 'CREATE TABLE _substrat_capabilities (id TEXT PRIMARY KEY, token_hash TEXT, mode TEXT, minted_by TEXT, minted_at TEXT)',
    columns: ['id', 'token_hash', 'mode', 'minted_by', 'minted_at'],
    rows: [[`cap-${marker}`, `hash-${marker}`, 'act', '"principal:gina"', '2026-01-01T00:00:00.000Z']],
  },
  {
    name: '_substrat_capability_sessions',
    ddl: 'CREATE TABLE _substrat_capability_sessions (token_hash TEXT PRIMARY KEY, capability_id TEXT, created_at TEXT, expires_at TEXT)',
    columns: ['token_hash', 'capability_id', 'created_at', 'expires_at'],
    rows: [[`session-${marker}`, `cap-${marker}`, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']],
  },
];
/** The ids in each capability table of a scope's export, keyed by table. */
const capsIn = (tables: ScopeDumpTable[]): Record<string, unknown[]> =>
  Object.fromEntries(
    ['_substrat_capabilities', '_substrat_capability_sessions'].map((name) => [
      name,
      (tables.find((t) => t.name === name)?.rows ?? []).map((r) => r[0]),
    ]),
  );
const held = (marker: string) => ({
  _substrat_capabilities: [`cap-${marker}`],
  _substrat_capability_sessions: [`session-${marker}`],
});
const none = { _substrat_capabilities: [], _substrat_capability_sessions: [] };
/** A dumped intent journal holding one still-pending `provision-sibling` intent. */
const pendingIntent = (id: string): ScopeDumpTable => ({
  name: '_substrat_platform_requests',
  ddl: 'CREATE TABLE _substrat_platform_requests (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, requested_by TEXT, status TEXT, requested_at TEXT)',
  columns: ['id', 'kind', 'payload', 'requested_by', 'status', 'requested_at'],
  rows: [[id, 'provision-sibling', '{"slug":"twice","name":"Twice","owner":"gina"}', JSON.stringify(ulid()), 'pending', '2026-01-01T00:00:00.000Z']],
});

describe("the ScopeDO's importDump keeps capability rows in their scope (#1686)", () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox });

  it('a restore into the scope the dump came from keeps both tables; the same dump onto another scope keeps neither', async () => {
    const self = scopeId.parse(ulid());
    await host.restoreScopeLocal(self, [...dumpFrom(self), ...capTables('a')], { sourceScopeId: self });
    expect(capsIn(await host.exportScopeLocal(self))).toEqual(held('a'));
    const other = scopeId.parse(ulid());
    await host.restoreScopeLocal(other, [...dumpFrom(self), ...capTables('a')], { sourceScopeId: self });
    expect(capsIn(await host.exportScopeLocal(other))).toEqual(none);
    // The rest of the dump arrived: only the capability rows were left behind.
    expect(tuplesIn(await host.exportScopeLocal(other))).toHaveLength(4);
  });

  it('a restore that names no source counts as a copy, even into the scope it came from', async () => {
    const self = scopeId.parse(ulid());
    await host.restoreScopeLocal(self, [...dumpFrom(self), ...capTables('b')]);
    expect(capsIn(await host.exportScopeLocal(self))).toEqual(none);
  });

  it('a table name in another case is the same table, and is left behind too', async () => {
    const self = scopeId.parse(ulid());
    const shouted = capTables('c').map((t) => ({
      ...t,
      name: t.name.toUpperCase(),
      ddl: t.ddl.replace(t.name, t.name.toUpperCase()),
    }));
    const other = scopeId.parse(ulid());
    await host.restoreScopeLocal(other, [...dumpFrom(self), ...shouted], { sourceScopeId: self });
    expect(capsIn(await host.exportScopeLocal(other))).toEqual(none);
    // The twin: the same shouted tables restored into their own scope land in the kernel's table.
    await host.restoreScopeLocal(self, [...dumpFrom(self), ...shouted], { sourceScopeId: self });
    expect(capsIn(await host.exportScopeLocal(self))).toEqual(held('c'));
  });

  it('snapshotScopeLocal leaves them behind, and the source keeps its own', async () => {
    const self = scopeId.parse(ulid());
    await host.restoreScopeLocal(self, [...dumpFrom(self), ...capTables('d')], { sourceScopeId: self });
    const snap = scopeId.parse(ulid());
    await host.snapshotScopeLocal(self, snap);
    expect(capsIn(await host.exportScopeLocal(snap))).toEqual(none);
    expect(capsIn(await host.exportScopeLocal(self))).toEqual(held('d'));
  });
});
