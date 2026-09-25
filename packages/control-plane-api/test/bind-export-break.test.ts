import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  deploymentRefFor,
  stableDeploymentRefFor,
  type VerticalClient,
} from '../src/index.js';

/**
 * The bind gate over HTTP (#1756): `POST /tenants/:t/scopes/:s/version`.
 *
 * The host refuses a bind that drops an export an app in the scope's tenant imports, whoever
 * calls. This route moves data BEFORE it binds (the #1710 carry, and a snapshot), so it asks
 * the same question first and refuses before any byte moves. Each fake deployment keeps its
 * own scope → dump map, as `api.test.ts`'s carry suite does, so "nothing was carried" is read
 * off the calls and the stores rather than assumed.
 *
 * Who can actually call it: staff, and a tenant's own credential (the dashboard's, confined to
 * the tenant in the path). A builder's push token cannot — the route is not in its allowlist.
 */
describe('the bind gate route (#1756)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const PRODUCER = 'acme/ledger';
  const CONSUMER = 'acme/desk';
  const TYPE = 'ledger.entry-made';

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let asTenant: Record<string, string>;
  let asOtherTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let producerScope: ScopeId;
  let consumerScope: ScopeId;
  let v1: string;
  let kept: string;
  let dropped: string;

  const refOf = new Map<string, string>(); // versionId → its script
  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>(); // script → scope → dump
  const calls: string[] = [];
  const storeOf = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  const deployment = (ref: string): VerticalClient =>
    ({
      exportScope: async (sid: string) => {
        calls.push(`export ${ref}`);
        return storeOf(ref).get(sid) ?? [];
      },
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[]) => {
        calls.push(`restore ${ref}`);
        storeOf(ref).set(sid, tables);
        return { tables: tables.length };
      },
      snapshotScope: async (input: { sourceScopeId: string; newScopeId: string }) => {
        calls.push(`snapshot ${ref}`);
        storeOf(ref).set(input.newScopeId, storeOf(ref).get(input.sourceScopeId) ?? []);
        return { tables: 1 };
      },
    }) as unknown as VerticalClient;
  const table = (...ids: string[]): ScopeDumpTable[] => [
    { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: ids.map((id) => [id]) },
  ];
  const rows = (versionId: string) => storeOf(refOf.get(versionId)!).get(producerScope)?.[0]?.rows;

  const registry = (extra: object) => JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], ...extra } });
  const publish = async (slug: string, manifestJson: string, migrationDigest = 'g'): Promise<string> => {
    const id = ulid();
    const ref = `${slug.replace('/', '-')}-${id.toLowerCase()}`;
    await host.admin.publishVersion(staff, {
      id, verticalSlug: slug, version: `1.0.${id.slice(-4).toLowerCase()}`, manifestDigest: `m-${id}`,
      permissionDigest: 'p', migrationDigest, deploymentRef: ref, manifestJson,
    });
    await host.admin.admitVersion(staff, id);
    refOf.set(id, ref);
    return id;
  };
  const exporting = (v: number | null) =>
    registry(v === null ? {} : { exports: [{ type: TYPE, schemaVersion: v, readPermission: 'ledger:read', declaredBy: ['@test/x'] }] });
  const install = async (tenant: typeof t, slug: string, versionId: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: slug });
    await host.admin.activateScope(staff, tenant, s);
    await host.admin.bindScopeVersion(staff, tenant, s, versionId);
    return s;
  };
  const bind = (headers: Record<string, string>, body: object, tenant: string = t, s: string = producerScope) =>
    app.request(`/tenants/${tenant}/scopes/${s}/version`, { method: 'POST', headers, body: JSON.stringify(body) });
  const boundTo = async () => (await host.admin.getScopeRecord(staff, t, producerScope))?.verticalVersionId;
  const tokenFor = async (tenant: string) => {
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: tenant }) });
    expect(minted.status).toBe(201);
    return { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-bind-export-break-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
      resolveVerticalVersion: async (s, versionId) => {
        const ref = s === PRODUCER ? refOf.get(versionId) : undefined;
        return ref ? deployment(ref) : undefined;
      },
      resolveVerticalRef: async (ref) => deployment(ref),
    });
    for (const [tenant, slug] of [[t, 'acme'], [other, 'other']] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
    }
    for (const slug of [PRODUCER, CONSUMER]) await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    v1 = await publish(PRODUCER, exporting(1));
    kept = await publish(PRODUCER, exporting(1));
    dropped = await publish(PRODUCER, exporting(null));
    const consumerVersion = await publish(
      CONSUMER,
      registry({ imports: [{ from: PRODUCER, type: TYPE, schemaVersion: 1, declaredBy: ['@test/y'] }] }),
    );
    // A primary install NOT on a serving script: it routes by its bound version's own script,
    // so a bind carries its data into the incoming version's script before the pointer moves.
    producerScope = await install(t, PRODUCER, v1);
    consumerScope = await install(t, CONSUMER, consumerVersion);
    storeOf(refOf.get(v1)!).set(producerScope, table('row-1'));

    asTenant = await tokenFor(t);
    asOtherTenant = await tokenFor(other);
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses before carrying anything, with the listing, and the pointer stays where the data is', async () => {
    calls.length = 0;
    for (const body of [{ versionId: dropped }, { versionId: dropped, snapshot: true }]) {
      const res = await bind(asStaff, body);
      expect(res.status).toBe(409);
      const said = (await res.json()) as { error: string; exportBreaks: { affected: { scopeId: string; incoming: number | null }[] } };
      expect(said.error).toMatch(/^this bind drops or re-versions 1 exported event type\(s\) that 1 installed app\(s\) in this tenant/);
      expect(said.exportBreaks.affected).toMatchObject([{ scopeId: consumerScope, incoming: null }]);
    }
    expect(calls).toEqual([]);
    expect(await boundTo()).toBe(v1);
    expect(rows(dropped)).toBeUndefined();
  });

  it('a version that keeps the export carries and binds with no acknowledgement', async () => {
    calls.length = 0;
    const res = await bind(asStaff, { versionId: kept });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`export ${refOf.get(v1)}`, `restore ${refOf.get(kept)}`]);
    expect(await boundTo()).toBe(kept);
    expect(rows(kept)).toEqual([['row-1']]);
  });

  it('if the break appears between the question and the bind, the host still refuses, and nothing is half-bound', async () => {
    // The race: the route read "no break" (as it would just before a promote landed), carried,
    // and the host then refused. The carry wrote a copy into the incoming script; the pointer
    // did not move, so the scope still serves from the copy it had, untouched.
    const impact = vi.spyOn(host.admin, 'bindingImpact').mockResolvedValueOnce([]);
    storeOf(refOf.get(kept)!).set(producerScope, table('row-1', 'row-2'));
    calls.length = 0;
    try {
      const res = await bind(asStaff, { versionId: dropped });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/^this bind drops or re-versions/);
    } finally {
      impact.mockRestore();
    }
    expect(calls).toEqual([`export ${refOf.get(kept)}`, `restore ${refOf.get(dropped)}`]);
    expect(await boundTo()).toBe(kept);
    expect(rows(kept)).toEqual([['row-1'], ['row-2']]);

    // What the carry left in the incoming script is overwritten by the next carry, from where
    // the data still is: a write the scope took meanwhile is not lost to the stale copy.
    storeOf(refOf.get(kept)!).set(producerScope, table('row-1', 'row-2', 'row-3'));
    calls.length = 0;
    const acked = await bind(asStaff, { versionId: dropped, acknowledge: { exportBreak: true } });
    expect(acked.status).toBe(200);
    expect(calls).toEqual([`export ${refOf.get(kept)}`, `restore ${refOf.get(dropped)}`]);
    expect(await boundTo()).toBe(dropped);
    expect(rows(dropped)).toEqual([['row-1'], ['row-2'], ['row-3']]);
  });

  it("a tenant's own credential binds with the acknowledgement; another tenant's and a builder's cannot bind at all", async () => {
    // Back to an exporting version, so the next move is a break again.
    await host.admin.bindScopeVersion(staff, t, producerScope, v1, { acknowledge: { exportBreak: true } });
    for (const who of [asOtherTenant, asBuilder]) {
      const res = await bind(who, { versionId: dropped, acknowledge: { exportBreak: true } });
      expect(res.status).toBe(403);
      expect(await boundTo()).toBe(v1);
    }
    const unacked = await bind(asTenant, { versionId: dropped });
    expect(unacked.status).toBe(409);
    expect(await boundTo()).toBe(v1);
    const acked = await bind(asTenant, { versionId: dropped, acknowledge: { exportBreak: true } });
    expect(acked.status).toBe(200);
    expect(await boundTo()).toBe(dropped);
  });

  describe('a move onto the serving script is judged before any data moves', () => {
    // The vertical serves a version, and a scope still on its own version adopts onto it. The
    // route flips first and binds second, so this is where the reviewer's bypass lived: the
    // bind is refused, then the adopt used to move the scope onto the same code unasked.
    const SERVING = 'acme-ledger-serving';
    const serve = (versionId: string) =>
      host.admin.setVerticalServing(staff, PRODUCER, { ref: SERVING, versionId, doClasses: [], migrationTag: 'g' });
    // Legacy: routed by its own version's script. A scope provisioned while the vertical serves
    // in place is born on the serving script, so the route is cleared back, as a pre-#286 one's is.
    const legacy = async (): Promise<ScopeId> => {
      const s = await install(t, PRODUCER, v1);
      await host.admin.setScopeServingRef(staff, t, s, null);
      storeOf(refOf.get(v1)!).set(s, table('legacy-row'));
      return s;
    };
    const post = (path: string, headers: Record<string, string>, body?: object) =>
      app.request(path, { method: 'POST', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const recordOf = async (s: ScopeId) => {
      const r = await host.admin.getScopeRecord(staff, t, s);
      return { servingRef: r?.servingRef ?? null, verticalVersionId: r?.verticalVersionId };
    };

    it('a bind refused is not an adopt allowed: adopt-serving refuses the same move, and moves nothing', async () => {
      await serve(dropped);
      const s = await legacy();
      expect((await bind(asStaff, { versionId: dropped }, t, s)).status).toBe(409);

      calls.length = 0;
      const adopt = await post(`/tenants/${t}/scopes/${s}/adopt-serving`, asStaff);
      expect(adopt.status).toBe(409);
      const said = (await adopt.json()) as { error: string; exportBreaks: { affected: { scopeId: string }[] } };
      expect(said.error).toMatch(/^this bind drops or re-versions/);
      expect(said.exportBreaks.affected.map((b) => b.scopeId)).toEqual([consumerScope]);
      expect(calls).toEqual([]);
      expect(await recordOf(s)).toMatchObject({ servingRef: null, verticalVersionId: v1 });

      // Acknowledged, the data moves and so does the scope.
      const acked = await post(`/tenants/${t}/scopes/${s}/adopt-serving`, asStaff, { acknowledge: { exportBreak: true } });
      expect(acked.status).toBe(200);
      expect(await recordOf(s)).toMatchObject({ servingRef: SERVING, verticalVersionId: dropped });
      expect(storeOf(SERVING).get(s)?.[0]?.rows).toEqual([['legacy-row']]);
    });

    it('a tenant can adopt, so a tenant is asked too', async () => {
      await serve(dropped);
      const s = await legacy();
      const refused = await post(`/tenants/${t}/scopes/${s}/adopt-serving`, asTenant);
      expect(refused.status).toBe(409);
      expect(await recordOf(s)).toMatchObject({ servingRef: null });
      const acked = await post(`/tenants/${t}/scopes/${s}/adopt-serving`, asTenant, { acknowledge: { exportBreak: true } });
      expect(acked.status).toBe(200);
    });

    it('rebind-vertical within one lineage is an adopt, and refused the same way', async () => {
      await serve(dropped);
      const s = await legacy();
      calls.length = 0;
      const refused = await post(`/tenants/${t}/scopes/${s}/rebind-vertical`, asStaff, { vertical: PRODUCER });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { exportBreaks?: unknown }).exportBreaks).toBeDefined();
      expect(calls).toEqual([]);
      expect(await recordOf(s)).toMatchObject({ servingRef: null, verticalVersionId: v1 });
      const acked = await post(`/tenants/${t}/scopes/${s}/rebind-vertical`, asStaff, {
        vertical: PRODUCER,
        acknowledge: { exportBreak: true },
      });
      expect(acked.status).toBe(200);
      expect(await recordOf(s)).toMatchObject({ servingRef: SERVING, verticalVersionId: dropped });
    });

    it('rebind-vertical ACROSS lineages is not judged, even from a scope on its serving script', async () => {
      // The known gap, held as a gap rather than turned into a phantom: the scope runs `kept` from
      // PRODUCER's serving script while its pointer says `dropped`. Routing it onto ANOTHER
      // vertical's script is not a move of PRODUCER's code, so it is not measured as one — which
      // would read "kept → dropped" and refuse, after the data had already been copied across.
      const OTHER = 'acme/ledger2';
      const OTHER_SERVING = 'acme-ledger2-serving';
      await host.admin.registerVertical(staff, { slug: OTHER, name: OTHER, source: 'cli' });
      const l1 = await publish(OTHER, registry({}));
      await host.admin.setVerticalServing(staff, OTHER, { ref: OTHER_SERVING, versionId: l1, doClasses: [], migrationTag: 'g' });
      await serve(kept);
      const s = await install(t, PRODUCER, v1); // born on PRODUCER's serving script
      await host.admin.bindScopeVersion(staff, t, s, dropped); // runs `kept` all the same
      expect(await recordOf(s)).toMatchObject({ servingRef: SERVING, verticalVersionId: dropped });
      storeOf(SERVING).set(s, table('crossing-row'));
      const res = await post(`/tenants/${t}/scopes/${s}/rebind-vertical`, asStaff, { vertical: OTHER });
      expect(res.status).toBe(200);
      expect(await recordOf(s)).toMatchObject({ servingRef: OTHER_SERVING, verticalVersionId: l1 });
      expect(storeOf(OTHER_SERVING).get(s)?.[0]?.rows).toEqual([['crossing-row']]);
    });

    it('the twin: a vertical serving a version that keeps the export adopts unasked', async () => {
      await serve(kept);
      const s = await legacy();
      const adopt = await post(`/tenants/${t}/scopes/${s}/adopt-serving`, asStaff);
      expect(adopt.status).toBe(200);
      expect(await recordOf(s)).toMatchObject({ servingRef: SERVING, verticalVersionId: kept });
    });
  });

  it('a snapshot is not taken for a bind that the break reaches after the carry, and is when acknowledged', async () => {
    // The delegated `--snapshot` path carries, then snapshots, then binds. A promote landing
    // after the first question would otherwise leave an archive behind for a refused bind, so
    // the question is asked again right before the snapshot.
    const s = await install(t, PRODUCER, v1);
    await host.admin.setScopeServingRef(staff, t, s, null);
    storeOf(refOf.get(v1)!).set(s, table('snap-row'));
    const crossing = await publish(PRODUCER, exporting(null), 'g2');
    const scopesNow = async () => (await host.admin.listScopes(staff, { tenantId: t })).length;
    const before = await scopesNow();
    const impact = vi.spyOn(host.admin, 'bindingImpact').mockResolvedValueOnce([]);
    calls.length = 0;
    try {
      const res = await bind(asStaff, { versionId: crossing, snapshot: true }, t, s);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { exportBreaks?: unknown }).exportBreaks).toBeDefined();
    } finally {
      impact.mockRestore();
    }
    expect(calls).toEqual([`export ${refOf.get(v1)}`, `restore ${refOf.get(crossing)}`]);
    expect(await scopesNow()).toBe(before);
    expect((await host.admin.getScopeRecord(staff, t, s))?.verticalVersionId).toBe(v1);

    // The twin: acknowledged, the same bind snapshots first and binds.
    calls.length = 0;
    const acked = await bind(asStaff, { versionId: crossing, snapshot: true, acknowledge: { exportBreak: true } }, t, s);
    expect(acked.status).toBe(200);
    expect(calls.filter((c) => c.startsWith('snapshot '))).toEqual([`snapshot ${refOf.get(v1)}`]);
    expect(await scopesNow()).toBe(before + 1);
    expect((await host.admin.getScopeRecord(staff, t, s))?.verticalVersionId).toBe(crossing);
  });

  it('a version not admitted is refused as that, before any acknowledgement is asked for', async () => {
    // Unadmitted AND dropping the export: the answer is the admission refusal, so nobody is
    // asked to acknowledge a break for a bind that could not happen anyway.
    await host.admin.setVerticalListed(staff, PRODUCER, true);
    const pending = ulid();
    await host.admin.publishVersion(staff, {
      id: pending, verticalSlug: PRODUCER, version: '9.9.9', manifestDigest: 'm-pending', permissionDigest: 'p',
      migrationDigest: 'g', deploymentRef: `acme-ledger-${pending.toLowerCase()}`, manifestJson: exporting(null),
    });
    await host.admin.setVerticalListed(staff, PRODUCER, false);
    await host.admin.bindScopeVersion(staff, t, producerScope, v1, { acknowledge: { exportBreak: true } });
    calls.length = 0;
    const res = await bind(asStaff, { versionId: pending });
    expect(res.status).toBe(409);
    const said = (await res.json()) as { error?: string; detail?: string; exportBreaks?: unknown };
    expect(JSON.stringify(said)).toMatch(/not admitted/);
    expect(said.exportBreaks).toBeUndefined();
    expect(calls).toEqual([]);
    // The twin: the admitted version that drops the same export asks for the acknowledgement.
    const twin = await bind(asStaff, { versionId: dropped });
    expect(twin.status).toBe(409);
    expect(((await twin.json()) as { exportBreaks?: unknown }).exportBreaks).toBeDefined();
    expect(await boundTo()).toBe(v1);
  });

  it('the impact read is the same answer as a read: staff and the tenant may ask, another tenant and a builder may not', async () => {
    await host.admin.bindScopeVersion(staff, t, producerScope, v1, { acknowledge: { exportBreak: true } });
    const ask = (headers: Record<string, string>, versionId: string, tenant: string = t) =>
      app.request(`/tenants/${tenant}/scopes/${producerScope}/binding-impact?versionId=${versionId}`, { headers });
    for (const who of [asStaff, asTenant]) {
      const res = await ask(who, dropped);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { affected: { scopeId: string }[] }).affected.map((b) => b.scopeId)).toEqual([consumerScope]);
    }
    // The twin: a version that keeps the export breaks nothing.
    expect(await (await ask(asTenant, kept)).json()).toEqual({ affected: [] });
    expect((await ask(asOtherTenant, dropped)).status).toBe(403);
    expect((await ask(asBuilder, dropped)).status).toBe(403);
    expect(await boundTo()).toBe(v1);
  });

  it('an acknowledgement of something a bind has no gate for is refused as a malformed body', async () => {
    const before = await boundTo();
    const res = await bind(asStaff, { versionId: kept, acknowledge: { permissionChange: true } });
    expect(res.status).toBe(400);
    expect(await boundTo()).toBe(before);
  });
});

/**
 * The promote's own adopt (#321's cascade) under the bind gate (#1756). A private, dispatch-backed
 * vertical's prod promote adopts every owned install still on its own version onto the serving
 * script. The promote gate judged the channel's previous version against the new one; an install
 * lagging behind that was never judged. So the adopt is: refused without an acknowledgement, with
 * nothing moved, and carried by the promote's acknowledgement when one is given.
 */
describe("the promote's adopt of a lagging install (#1756)", () => {
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const TYPE = 'crm.customer-created';
  const TYPE2 = 'crm.customer-touched';
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>();
  const ensure = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  const clientFor = (ref: string) =>
    ({
      exportScope: async (sc: string) => ensure(ref).get(sc) ?? [],
      restoreScope: async (_t: string, sc: string, tables: ScopeDumpTable[]) => {
        ensure(ref).set(sc, tables);
        return { tables: tables.length };
      },
    }) as unknown as VerticalClient;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-bind-cascade-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async (ref) => {
        ensure(ref);
      },
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' },
      ],
      resolveVerticalRef: async (ref) => clientFor(ref),
      resolveVerticalVersion: async (slug, versionId) => clientFor(deploymentRefFor(slug, versionId)),
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // `exported`: TYPE when true, the named type when a string, nothing when false.
  const manifest = (version: string, exported: boolean | string, migration = 'g1') => ({
    version,
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: ['ScopeDO'],
    bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
    digests: { manifest: `m-${version}`, permission: `p-${version}`, migration },
    registry: {
      permissions: [{ key: 'customer:read', description: 'read customers', declaredBy: ['@test/crm'] }],
      roles: [],
      entityGrants: [],
      ...(exported
        ? { exports: [{ type: exported === true ? TYPE : exported, schemaVersion: 1, readPermission: 'customer:read', declaredBy: ['@test/crm'] }] }
        : {}),
    },
  });
  const push = async (pin: string, m: object): Promise<{ id: string; verticalSlug: string }> => {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(m));
    fd.set('tenant', pin);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: staff }, body: fd });
    expect(res.status).toBeLessThan(300);
    return (await res.json()) as { id: string; verticalSlug: string };
  };
  const promote = (slug: string, versionId: string, acknowledge?: object) =>
    app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ versionId, ...(acknowledge ? { acknowledge } : {}) }),
    });

  it('refuses the adopt the promote never judged, moves nothing, and a promote with the acknowledgement moves it', async () => {
    const pin = `cascade-${ulid().slice(-6).toLowerCase()}`;
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: pin, name: pin });
    // A private vertical's install, still on its own version, which exports TYPE…
    const v1 = await push(pin, manifest('0.1.0', true));
    const slug = v1.verticalSlug;
    const sc = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
    await host.admin.activateScope(staff, t, sc);
    await host.admin.bindScopeVersion(staff, t, sc, v1.id);
    ensure(deploymentRefFor(slug, v1.id)).set(sc, [
      { name: 'customers', ddl: 'CREATE TABLE customers(name TEXT)', columns: ['name'], rows: [['Acme AB']] },
    ]);
    // …beside an app in the same tenant that imports it.
    const desk = `${pin}/desk`;
    await host.admin.registerVertical(staff, { slug: desk, name: 'desk', source: 'cli' });
    const deskVersion = ulid();
    await host.admin.publishVersion(staff, {
      id: deskVersion, verticalSlug: desk, version: '1.0.0', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null,
      manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], imports: [{ from: slug, type: TYPE, schemaVersion: 1, declaredBy: ['@test/desk'] }] } }),
    });
    await host.admin.admitVersion(staff, deskVersion);
    const deskScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: deskScope, vertical: desk });
    await host.admin.activateScope(staff, t, deskScope);
    await host.admin.bindScopeVersion(staff, t, deskScope, deskVersion);

    // The first prod promote of a version that drops the export: the promote gate has no previous
    // channel version to judge against, so it passes, and the adopt is what finds the break.
    const v2 = await push(pin, manifest('0.2.0', false));
    const refused = await promote(slug, v2.id);
    expect(refused.status).toBe(409);
    const said = (await refused.json()) as { error: string; exportBreaks?: { affected: { scopeId: string }[] } };
    expect(said.error).toMatch(/^promoted and served, but an app still on its own version was not moved/);
    expect(said.exportBreaks?.affected.map((b) => b.scopeId)).toEqual([deskScope]);
    const stable = stableDeploymentRefFor(slug);
    const unmoved = await host.admin.getScopeRecord(staff, t, sc);
    expect(unmoved?.servingRef ?? null).toBeNull();
    expect(unmoved?.verticalVersionId).toBe(v1.id);
    expect(scripts.get(stable)?.has(sc)).toBeFalsy();

    // The promote's acknowledgement carries to the adopt.
    const acked = await promote(slug, v2.id, { exportBreak: true });
    expect(acked.status).toBe(200);
    const moved = await host.admin.getScopeRecord(staff, t, sc);
    expect(moved).toMatchObject({ servingRef: stable, verticalVersionId: v2.id });
    expect(scripts.get(stable)?.get(sc)?.[0]?.rows).toEqual([['Acme AB']]);
  });

  it("a promote acknowledging a digest change moves its owned installs: that acknowledgement is not the adopt's to carry", async () => {
    // The digest acknowledgements are the promote's own. A bind's acknowledgement is strict, so
    // forwarding the promote's whole acknowledgement refused every such promote after its serve.
    const pin = `digest-${ulid().slice(-6).toLowerCase()}`;
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: pin, name: pin });
    const v1 = await push(pin, manifest('0.1.0', false));
    const slug = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);
    const stable = stableDeploymentRefFor(slug);
    // One install born on the serving script, one legacy install still on its own version's.
    const install = async () => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug });
      await host.admin.activateScope(staff, t, s);
      await host.admin.bindScopeVersion(staff, t, s, v1.id);
      return s;
    };
    const onServing = await install();
    const legacy = await install();
    await host.admin.setScopeServingRef(staff, t, legacy, null);
    ensure(deploymentRefFor(slug, v1.id)).set(legacy, [
      { name: 'customers', ddl: 'CREATE TABLE customers(name TEXT)', columns: ['name'], rows: [['Acme AB']] },
    ]);
    const listScopes = vi.spyOn(host.admin, 'listScopes');
    const backfillRan = () =>
      listScopes.mock.calls.some(([, f]) => f?.vertical === slug && Array.isArray(f.status) && f.status.includes('provisioning'));
    try {
      for (const [version, migration, acknowledge] of [
        ['0.2.0', 'g1', { permissionChange: true }],
        ['0.3.0', 'g3', { permissionChange: true, migrationChange: true }],
      ] as const) {
        const next = await push(pin, manifest(version, false, migration));
        listScopes.mockClear();
        const res = await promote(slug, next.id, acknowledge);
        expect(res.status).toBe(200);
        expect(backfillRan()).toBe(true);
        for (const s of [onServing, legacy]) {
          expect(await host.admin.getScopeRecord(staff, t, s)).toMatchObject({ servingRef: stable, verticalVersionId: next.id });
        }
      }
    } finally {
      listScopes.mockRestore();
    }
    expect(scripts.get(stable)?.get(legacy)?.[0]?.rows).toEqual([['Acme AB']]);
  });

  // An owned install still on a version that exports TYPE, beside an app that imports it, while the
  // channel (and an install on the serving script) are on a version that exports nothing.
  const laggingWorld = async (opts: { gateBreak?: boolean } = {}) => {
    const pin = `lag-${ulid().slice(-6).toLowerCase()}`;
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: pin, name: pin });
    // `old` exports TYPE and is never promoted; the channel starts at `served`, which does not.
    const old = await push(pin, manifest('0.1.0', true));
    const slug = old.verticalSlug;
    // With `gateBreak`, the channel's version exports a second type a second app imports: the
    // promote gate then breaks that app, and the lagging install's adopt breaks the first.
    const served = await push(pin, manifest('0.1.1', opts.gateBreak ? TYPE2 : false));
    expect((await promote(slug, served.id)).status).toBe(200);
    const stable = stableDeploymentRefFor(slug);
    const install = async (versionId: string) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug });
      await host.admin.activateScope(staff, t, s);
      await host.admin.bindScopeVersion(staff, t, s, versionId);
      return s;
    };
    const onServing = await install(served.id);
    // A legacy install still on `old`, which exports TYPE, beside an app that imports it.
    const lagging = await install(old.id);
    await host.admin.setScopeServingRef(staff, t, lagging, null, { acknowledge: { exportBreak: true } });
    ensure(deploymentRefFor(slug, old.id)).set(lagging, [
      { name: 'customers', ddl: 'CREATE TABLE customers(name TEXT)', columns: ['name'], rows: [['Acme AB']] },
    ]);
    const desk = `${pin}/desk`;
    await host.admin.registerVertical(staff, { slug: desk, name: 'desk', source: 'cli' });
    const deskVersion = ulid();
    await host.admin.publishVersion(staff, {
      id: deskVersion, verticalSlug: desk, version: '1.0.0', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null,
      manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], imports: [{ from: slug, type: TYPE, schemaVersion: 1, declaredBy: ['@test/desk'] }] } }),
    });
    await host.admin.admitVersion(staff, deskVersion);
    const deskScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: deskScope, vertical: desk });
    await host.admin.activateScope(staff, t, deskScope);
    await host.admin.bindScopeVersion(staff, t, deskScope, deskVersion);
    let desk2Scope: ScopeId | null = null;
    if (opts.gateBreak) {
      const desk2 = `${pin}/desk2`;
      await host.admin.registerVertical(staff, { slug: desk2, name: 'desk2', source: 'cli' });
      const desk2Version = ulid();
      await host.admin.publishVersion(staff, {
        id: desk2Version, verticalSlug: desk2, version: '1.0.0', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: null,
        manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], imports: [{ from: slug, type: TYPE2, schemaVersion: 1, declaredBy: ['@test/desk2'] }] } }),
      });
      await host.admin.admitVersion(staff, desk2Version);
      desk2Scope = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: desk2Scope, vertical: desk2 });
      await host.admin.activateScope(staff, t, desk2Scope);
      await host.admin.bindScopeVersion(staff, t, desk2Scope, desk2Version);
    }

    const next = await push(pin, manifest('0.2.0', false));
    return { t, slug, stable, onServing, lagging, old, deskScope, desk2Scope, next };
  };

  it('an install refused after the serve is left where it is; every other install still moves, and the backfill still runs', async () => {
    const { t, slug, stable, onServing, lagging, old, deskScope, next } = await laggingWorld();
    // The channel's previous version exports nothing, so the promote gate passes; the adopt of the
    // lagging install is what breaks the desk.
    const listScopes = vi.spyOn(host.admin, 'listScopes');
    let res: Response;
    try {
      res = await promote(slug, next.id, { permissionChange: true });
      expect(listScopes.mock.calls.some(([, f]) => f?.vertical === slug && Array.isArray(f.status) && f.status.includes('provisioning'))).toBe(true);
    } finally {
      listScopes.mockRestore();
    }
    expect(res.status).toBe(409);
    const said = (await res.json()) as { error: string; exportBreaks?: { affected: { scopeId: string }[] } };
    expect(said.error).toMatch(/^promoted and served, but an app still on its own version was not moved/);
    expect(said.exportBreaks?.affected.map((b) => b.scopeId)).toEqual([deskScope]);
    // The install on the serving script moved on; the lagging one did not move at all.
    expect(await host.admin.getScopeRecord(staff, t, onServing)).toMatchObject({ servingRef: stable, verticalVersionId: next.id });
    const still = await host.admin.getScopeRecord(staff, t, lagging);
    expect(still?.servingRef ?? null).toBeNull();
    expect(still?.verticalVersionId).toBe(old.id);
    expect(scripts.get(stable)?.has(lagging)).toBeFalsy();

    // The twin: promoting again acknowledged moves it.
    expect((await promote(slug, next.id, { exportBreak: true })).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, lagging)).toMatchObject({ servingRef: stable, verticalVersionId: next.id });
  });

  it("the promote's impact names the lagging install's break, so its acknowledgement covers what was shown", async () => {
    const { slug, deskScope, next } = await laggingWorld();
    const impact = async (versionId: string) =>
      ((await (
        await app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote-impact?versionId=${versionId}`, { headers: auth })
      ).json()) as { affected: { scopeId: string }[] }).affected;
    // The gate alone sees nothing (the channel's version exports nothing); the adopt would break the desk.
    await expect(host.admin.promotionImpact(staff, slug, 'prod', next.id)).resolves.toEqual([]);
    expect((await impact(next.id)).map((b) => b.scopeId)).toEqual([deskScope]);
    // Promoted acknowledged, the listing it answers with is the same one.
    const res = await promote(slug, next.id, { permissionChange: true, exportBreak: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { exportBreaks?: { affected: { scopeId: string }[] } }).exportBreaks?.affected.map((b) => b.scopeId)).toEqual([
      deskScope,
    ]);
    // The twin: with no install left behind, a further version that exports nothing breaks nothing.
    const later = await push(slug.split('/')[0]!, manifest('0.3.0', false));
    expect(await impact(later.id)).toEqual([]);
  });

  it("the promote's refusal counts what it lists: the gate's break and the lagging install's, together", async () => {
    const { slug, deskScope, desk2Scope, next } = await laggingWorld({ gateBreak: true });
    // The gate alone breaks one app (desk2 loses TYPE2); the lagging install's adopt breaks another.
    expect((await host.admin.promotionImpact(staff, slug, 'prod', next.id)).map((b) => b.scopeId)).toEqual([desk2Scope]);
    const res = await promote(slug, next.id, { permissionChange: true });
    expect(res.status).toBe(409);
    const said = (await res.json()) as { error: string; exportBreaks: { affected: { scopeId: string }[] } };
    expect(said.exportBreaks.affected.map((b) => b.scopeId).sort()).toEqual([deskScope, desk2Scope!].sort());
    expect(said.error).toMatch(/^promotion drops or re-versions 2 exported event type\(s\) that 2 installed app\(s\) in 1 tenant\(s\)/);
  });
});
