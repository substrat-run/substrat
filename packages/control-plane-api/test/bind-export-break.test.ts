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
    }) as unknown as VerticalClient;
  const table = (...ids: string[]): ScopeDumpTable[] => [
    { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: ids.map((id) => [id]) },
  ];
  const rows = (versionId: string) => storeOf(refOf.get(versionId)!).get(producerScope)?.[0]?.rows;

  const registry = (extra: object) => JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], ...extra } });
  const publish = async (slug: string, manifestJson: string): Promise<string> => {
    const id = ulid();
    const ref = `${slug.replace('/', '-')}-${id.toLowerCase()}`;
    await host.admin.publishVersion(staff, {
      id, verticalSlug: slug, version: `1.0.${id.slice(-4).toLowerCase()}`, manifestDigest: `m-${id}`,
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref, manifestJson,
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

  it('an acknowledgement of something a bind has no gate for is refused as a malformed body', async () => {
    const res = await bind(asStaff, { versionId: v1, acknowledge: { permissionChange: true } });
    expect(res.status).toBe(400);
    expect(await boundTo()).toBe(dropped);
  });
});
