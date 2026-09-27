import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { scopeRepointContractSuite } from '@substrat-run/contract-tests';
import {
  ControlPlaneError,
  createControlPlaneApi,
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

  it('exact, with grants on a third scope: refused, and the target keeps what it held', async () => {
    const dest = scopeId.parse(ulid());
    await host.restoreScopeLocal(dest, dumpFrom(source), { sourceScopeId: source, exact: true });
    const before = tuplesIn(await host.exportScopeLocal(dest));
    const third = scopeId.parse(ulid());
    const mixed = dumpFrom(source).map((t) => ({ ...t, rows: [...t.rows, ['principal:lena', 'role:reader', `scope:${third}`, null, null]] }));
    await expect(host.restoreScopeLocal(dest, mixed, { sourceScopeId: source, exact: true })).rejects.toThrow(
      new RegExp(`restore refused: the dump holds grants on 1 scope\\(s\\) other than its source .*scope:${third}`),
    );
    expect(tuplesIn(await host.exportScopeLocal(dest))).toEqual(before);
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
      restoreScope: (
        _t: unknown,
        sid: ScopeId,
        tables: ScopeDumpTable[],
        opts?: { sourceScopeId?: ScopeId; exact?: boolean },
      ) => relay(() => host.restoreScopeLocal(sid, tables, { sourceScopeId: opts?.sourceScopeId, exact: opts?.exact })),
      deleteScope: (input: { scopeId: ScopeId }) => relay(() => host.deleteScopeLocal(input.scopeId)),
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
    dir = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
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
});
