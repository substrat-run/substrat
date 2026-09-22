import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
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
 * #1710 on workerd. A hosted vertical's versions are separate scripts, and a Durable Object
 * namespace belongs to its script. So when a push re-points a preview at a new version,
 * the preview's data stays behind unless something moves it. That is a Cloudflare fact,
 * which node's one-database world cannot show. Here each version is its own DO class
 * (`PreviewV{1,2,3}ScopeDO`, identical code, three namespaces), the control-plane API runs
 * over a real `CloudflareScopeHost` directory, and "what the preview serves" is read the
 * way the router reads it: resolve the hostname to a script, then read the scope there.
 *
 * Each version's client calls the same host methods a vertical's `/internal/export`,
 * `/internal/restore`, `/internal/snapshot` and `/internal/delete-scope` routes call
 * (vertical-host), and turns a throw into the `ControlPlaneError` the HTTP hop would.
 */
describe('a preview keeps its data across pushes, on real Durable Object namespaces (#1710)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const slug = 'carry-vert';
  const prod = scopeId.parse(ulid());
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  let dir: CloudflareScopeHost;
  let api: ReturnType<typeof createControlPlaneApi>;
  const version: Record<'v1' | 'v2' | 'v3', string> = { v1: '', v2: '', v3: '' };
  const refOf = new Map<string, string>(); // versionId → its script
  const hostOf = new Map<string, CloudflareScopeHost>(); // script → its namespace
  // Makes v3's restore fail INSIDE the DO's transaction, after its drops: the dump gains a
  // table whose schema the DO refuses, so the import throws and SQLite rolls it all back.
  let sabotageV3 = false;

  const notes = (...bodies: string[]): ScopeDumpTable[] => [
    {
      name: 'pv_notes',
      ddl: 'CREATE TABLE pv_notes (id TEXT PRIMARY KEY, body TEXT)',
      columns: ['id', 'body'],
      rows: bodies.map((b, i) => [`n${i}`, b]),
    },
  ];
  const bodiesIn = (tables: ScopeDumpTable[]): unknown[] =>
    tables.find((tb) => tb.name === 'pv_notes')?.rows.map((r) => r[1]) ?? [];
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
      restoreScope: (_t: unknown, sid: ScopeId, tables: ScopeDumpTable[]) =>
        relay(() =>
          host.restoreScopeLocal(
            sid,
            sabotageV3 && ref === refOf.get(version.v3)
              ? [...tables, { name: 'zz_bad', ddl: 'CREATE TABLE not_zz_bad (x TEXT)', columns: ['x'], rows: [] }]
              : tables,
          ),
        ),
      snapshotScope: (input: { sourceScopeId: ScopeId; newScopeId: ScopeId }) =>
        relay(() => host.snapshotScopeLocal(input.sourceScopeId, input.newScopeId)),
      deleteScope: (input: { scopeId: ScopeId }) => relay(() => host.deleteScopeLocal(input.scopeId)),
    } as unknown as VerticalClient;
  };

  /** What a request to `hostname` is served from: the router's resolution, then that script's scope. */
  const served = async (hostname: string): Promise<{ ref: string; bodies: unknown[] }> => {
    const route = await dir.admin.resolveHostname(hostname);
    expect(route?.deploymentRef).toBeTruthy();
    const ref = route!.deploymentRef!;
    return { ref, bodies: bodiesIn(await hostOf.get(ref)!.exportScopeLocal(route!.scopeId)) };
  };
  const push = async (tag: string, v: keyof typeof version, extra: object = {}) => {
    const res = await api.request(`/verticals/${slug}/previews`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tag, versionId: version[v], ...extra }),
    });
    return { status: res.status, body: (await res.json()) as { scopeId: ScopeId; hostname: string; error?: string } };
  };

  beforeAll(async () => {
    await warmControlPlane(env.PC_CONTROL_PLANE);
    // The directory. Its own scope namespace is not any version's: a hosted control plane
    // serves no vertical's storage.
    dir = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
    await dir.admin.createTenant(staff, { id: t, slug: `carry-${t.toLowerCase()}`, name: 'Carry Co' });
    // PRIVATE (owned, unlisted), so each push self-admits, as a builder's does.
    await dir.admin.registerVertical(staff, { slug, name: 'Carry Vert', source: 'cli', ownerTenant: t });
    const namespaces = { v1: env.PC_V1_SCOPE, v2: env.PC_V2_SCOPE, v3: env.PC_V3_SCOPE };
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const id = ulid();
      const ref = `carry-vert-${id.toLowerCase()}`;
      await dir.admin.publishVersion(staff, {
        id, verticalSlug: slug, version: `1.0.${v.slice(1)}`,
        manifestDigest: `m-${v}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
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
      resolveVerticalVersion: async (s, versionId) => {
        const ref = s === slug ? refOf.get(versionId) : undefined;
        return ref ? clientFor(ref) : undefined;
      },
      resolveVerticalRef: async (ref) => (hostOf.has(ref) ? clientFor(ref) : undefined),
    });
    // The app the previews fork: an install whose data lives in v1's script.
    await dir.provisionScope(staff, { tenantId: t, scopeId: prod, vertical: slug });
    await dir.admin.activateScope(staff, t, prod);
    await dir.admin.bindScopeVersion(staff, t, prod, version.v1);
    await dir.admin.bindHostname(staff, {
      hostname: 'carry-acme.global.substrat.run',
      tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
    await hostFor('v1').restoreScopeLocal(prod, notes('from prod'));
  });

  let preview: ScopeId;
  let url: string;

  it('re-pointing without a carry serves an empty store: the namespaces really are separate', async () => {
    // The bug, reproduced at the directory: a pointer-only rebind, which is all a reuse did.
    const created = await push('bug', 'v1');
    expect(created.status).toBe(201);
    expect((await served(created.body.hostname)).bodies).toEqual(['from prod']);
    await dir.admin.bindScopeVersion(staff, t, created.body.scopeId, version.v2);
    expect(await served(created.body.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: [] });
    // …and the data is still in v1's script, where nothing routes any more.
    expect(bodiesIn(await hostFor('v1').exportScopeLocal(created.body.scopeId))).toEqual(['from prod']);
  });

  it("a second push serves the preview's data from the new version's script", async () => {
    const created = await push('pr-1', 'v1');
    expect(created.status).toBe(201);
    preview = created.body.scopeId;
    url = created.body.hostname;
    expect(await served(url)).toEqual({ ref: refOf.get(version.v1), bodies: ['from prod'] });
    // A reviewer's write on the preview, in v1's script.
    await hostFor('v1').restoreScopeLocal(preview, notes('from prod', 'from review'));

    const second = await push('pr-1', 'v2');
    expect(second.status).toBe(200);
    expect(second.body.scopeId).toBe(preview);
    expect(await served(url)).toEqual({ ref: refOf.get(version.v2), bodies: ['from prod', 'from review'] });
  });

  it('a retried push of the same version carries nothing, so a write since the push survives', async () => {
    await hostFor('v2').restoreScopeLocal(preview, notes('from prod', 'from review', 'after push 2'));
    const retry = await push('pr-1', 'v2');
    expect(retry.status).toBe(200);
    // A re-carry from v1's script would have dropped the last row.
    expect(await served(url)).toEqual({
      ref: refOf.get(version.v2),
      bodies: ['from prod', 'from review', 'after push 2'],
    });
  });

  it("a carry that fails inside the target DO leaves the preview on its old script, and the target's store as it was", async () => {
    // A partial left in v3 by some earlier attempt.
    await hostFor('v3').restoreScopeLocal(preview, notes('stale partial'));
    sabotageV3 = true;
    const failed = await push('pr-1', 'v3');
    sabotageV3 = false;
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatch(/refusing this dump/);
    // Never re-pointed: the URL still serves v2's copy, whole.
    expect(await served(url)).toEqual({
      ref: refOf.get(version.v2),
      bodies: ['from prod', 'from review', 'after push 2'],
    });
    // The DO's transaction rolled back its own drops: v3 holds exactly what it held before.
    expect(bodiesIn(await hostFor('v3').exportScopeLocal(preview))).toEqual(['stale partial']);

    // CI's retry lands it, replacing the partial wholesale.
    const retried = await push('pr-1', 'v3');
    expect(retried.status).toBe(200);
    expect(await served(url)).toEqual({
      ref: refOf.get(version.v3),
      bodies: ['from prod', 'from review', 'after push 2'],
    });
  });

  it('scope bind carries a forked test environment into the version it binds', async () => {
    // The long-lived test environment: a pinned fork of prod, re-pointed by the merge job's
    // `substrat scope bind <id> --version <pushed>`.
    const created = await push('test', 'v1', { ttlHours: null });
    expect(created.status).toBe(201);
    const testEnv = created.body.scopeId;
    await hostFor('v1').restoreScopeLocal(testEnv, notes('from prod', 'qa data'));

    const res = await api.request(`/tenants/${t}/scopes/${testEnv}/version`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ versionId: version.v2 }),
    });
    expect(res.status).toBe(200);
    expect(await served(created.body.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['from prod', 'qa data'] });
  });
});
