import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { assetHash, permissionKey, platformActorId, principalId, scopeId, tenantId, type EntitlementGrant, type ScopeBackup, type ScopeDump, type ScopeDumpTable } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  ControlPlaneError,
  DeployUploadError,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
  deploymentRefFor,
  stableDeploymentRefFor,
} from '../src/index.js';

/**
 * The transport contract (control-plane.md §4.5). These drive the HTTP surface
 * end-to-end against a real adapter — the routes, the Zod boundary, the error
 * mapping, and the one property the whole surface exists to preserve: the actor
 * is stamped from the authenticated request and cannot be supplied by the caller.
 */
describe('control-plane API', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const t2 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());

  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const req = (path: string, init?: RequestInit) =>
    app.request(path, { headers: auth, ...init });
  const json = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-api-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -- the actor seam (§4.4/§6) ---------------------------------------------

  it('refuses every request without an actor, fail closed', async () => {
    const bare = await app.request('/tenants');
    expect(bare.status).toBe(401);
    // A write is refused before it reaches the host, not after.
    const write = await app.request('/tenants', {
      method: 'POST',
      body: JSON.stringify({ id: tenantId.parse(ulid()), slug: 'ghost', name: 'Ghost' }),
    });
    expect(write.status).toBe(401);
    expect(await host.admin.listTenants(staff)).toHaveLength(0);
  });

  it('refuses a malformed actor rather than writing it to the log', async () => {
    const res = await app.request('/tenants', { headers: { [DEV_ACTOR_HEADER]: 'not-a-ulid' } });
    expect(res.status).toBe(401);
  });

  it('stamps the audit actor from the request — a body actor cannot forge it', async () => {
    const impostor = platformActorId.parse(ulid());
    const res = await json('/tenants', 'POST', {
      id: t1,
      slug: 'acme-co',
      name: 'Acme Co',
      // There is no route that accepts an actor; this rides along to prove it is
      // dropped at the Zod boundary rather than reaching the audit row (§4.4:
      // stamped platform-side, "never supplied by the caller").
      actor: impostor,
    });
    expect(res.status).toBe(201);

    const rows = (await host.admin.auditLog(staff, { tenantId: t1 })).filter(
      (r) => r.action === 'createTenant',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(staff);
    expect(rows[0]!.actor).not.toBe(impostor);
  });

  // -- tenant registry (§4.1) -----------------------------------------------

  it('creates a tenant, idempotently, and reads it back', async () => {
    const again = await json('/tenants', 'POST', { id: t1, slug: 'acme-co', name: 'Acme Co' });
    expect(again.status).toBe(201); // idempotent — a no-op, not an error

    const got = await req(`/tenants/${t1}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: t1, slug: 'acme-co', status: 'active' });

    const list = (await (await req('/tenants')).json()).entries;
    expect(list).toHaveLength(1);
  });

  it('maps a tenant slug collision to 409', async () => {
    const res = await json('/tenants', 'POST', {
      id: tenantId.parse(ulid()),
      slug: 'acme-co',
      name: 'Impostor',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already taken/);
  });

  it('maps an unknown tenant to 404', async () => {
    expect((await req(`/tenants/${tenantId.parse(ulid())}`)).status).toBe(404);
  });

  it('rejects a malformed body at the Zod boundary with 400', async () => {
    const res = await json('/tenants', 'POST', { id: 'nope', slug: 'x', name: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid request');
  });

  it('transitions tenant status', async () => {
    const res = await json(`/tenants/${t1}/status`, 'PATCH', { status: 'suspended' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'suspended' });
    await json(`/tenants/${t1}/status`, 'PATCH', { status: 'active' });
  });

  it('renames a tenant display name; the slug stays put', async () => {
    const before = (await (await req(`/tenants/${t1}`)).json()) as { slug: string };
    const res = await json(`/tenants/${t1}`, 'PATCH', { name: 'Acme Renamed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Acme Renamed', slug: before.slug });
    // A blank name is refused at the Zod boundary.
    expect((await json(`/tenants/${t1}`, 'PATCH', { name: '  ' })).status).toBe(400);
  });

  // -- entitlements (§4.3) --------------------------------------------------

  it('grants, lists and revokes entitlements', async () => {
    expect(await (await req(`/tenants/${t1}/entitlements`)).json()).toEqual([]);

    // A bodyless PUT is the pre-#33 bare flag grant: a perpetual boolean.
    const granted = await json(`/tenants/${t1}/entitlements/workorder`, 'PUT');
    expect(await granted.json()).toMatchObject([
      { entitlementKey: 'workorder', expiresAt: null, quota: null, plan: null },
    ]);

    const revoked = await json(`/tenants/${t1}/entitlements/workorder`, 'DELETE');
    expect(await revoked.json()).toEqual([]);
  });

  it('carries the plan half (#33) in the PUT body; a bare re-grant preserves it', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const granted = await json(`/tenants/${t1}/entitlements/workorder`, 'PUT', {
      expiresAt: until,
      quota: 500,
      plan: 'pro',
    });
    expect(await granted.json()).toMatchObject([
      { entitlementKey: 'workorder', expiresAt: until, quota: 500, plan: 'pro' },
    ]);

    // PATCH semantics across HTTP: an idempotent bodyless re-grant (retried
    // provisioning) must not erase the plan and turn a trial perpetual.
    const regranted = await json(`/tenants/${t1}/entitlements/workorder`, 'PUT');
    expect(await regranted.json()).toMatchObject([
      { entitlementKey: 'workorder', expiresAt: until, quota: 500, plan: 'pro' },
    ]);

    // Malformed plan fields are refused at the Zod boundary.
    expect((await json(`/tenants/${t1}/entitlements/workorder`, 'PUT', { quota: -1 })).status).toBe(400);
    expect((await json(`/tenants/${t1}/entitlements/workorder`, 'PUT', { expiresAt: 'tomorrow' })).status).toBe(400);

    await json(`/tenants/${t1}/entitlements/workorder`, 'DELETE');
  });

  // -- identity mirror (builder-plane.md §4) --------------------------------

  it('mirrors an identity link in and out — the builder-plane whoami feed', async () => {
    const principal = principalId.parse(ulid());
    const link = { provider: 'authhero', externalId: 'auth0|mirror-user', principal };
    const put = await json(`/tenants/${t1}/identities`, 'PUT', link);
    expect(put.status).toBe(204);
    // Idempotent: the dashboard re-mirrors on every load.
    expect((await json(`/tenants/${t1}/identities`, 'PUT', link)).status).toBe(204);

    // The link now answers exactly the read builder auth performs (userId → tenants).
    expect(await host.admin.listIdentityTenants(staff, 'authhero', 'auth0|mirror-user')).toEqual([t1]);

    const del = await json(`/tenants/${t1}/identities/${principal}`, 'DELETE');
    expect(del.status).toBe(204);
    expect(await host.admin.listIdentityTenants(staff, 'authhero', 'auth0|mirror-user')).toEqual([]);
  });

  it('rejects a malformed identity link at the Zod boundary with 400', async () => {
    const res = await json(`/tenants/${t1}/identities`, 'PUT', { provider: 'authhero' });
    expect(res.status).toBe(400);
  });

  // -- the scope directory (§3.2/§4.2) --------------------------------------

  it('provisions a scope and returns the directory record', async () => {
    const res = await json('/scopes', 'POST', {
      tenantId: t1,
      scopeId: s1,
      slug: 'brf-vasastan',
      kind: 'brf',
      name: 'Brf Vasastan',
      vertical: 'housing',
      jurisdiction: 'global',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: s1,
      tenantId: t1,
      slug: 'brf-vasastan',
      kind: 'brf',
      vertical: 'housing',
      jurisdiction: 'global',
      // Not `active`: the directory row exists before the vertical has built the
      // scope, and `activateScope` is the confirmation that it has (K-31).
      status: 'provisioning',
    });

    expect((await json(`/tenants/${t1}/scopes/${s1}/activate`, 'POST')).status).toBe(200);
    const activated = await (await req(`/tenants/${t1}/scopes/${s1}`)).json();
    expect(activated.status).toBe('active');
  });

  it('gates eu/us jurisdiction at the boundary until enforcement exists (K-32)', async () => {
    // `eu` is a storable value but not a provisionable one: accepting it would
    // record a residency claim with no mechanism. Refused with 400, not written.
    const res = await json('/scopes', 'POST', {
      tenantId: t1,
      scopeId: s1,
      slug: 'brf-eu',
      name: 'Brf EU',
      jurisdiction: 'eu',
    });
    expect(res.status).toBe(400);
  });

  it('refuses to provision under an unknown tenant with 409', async () => {
    const res = await json('/scopes', 'POST', {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
    });
    expect(res.status).toBe(409);
  });

  it('lists scopes and filters by tenant, status and vertical', async () => {
    await json('/tenants', 'POST', { id: t2, slug: 'other-co', name: 'Other Co' });
    const s2 = scopeId.parse(ulid());
    await json('/scopes', 'POST', { tenantId: t2, scopeId: s2, slug: 'other-scope' });
    await json(`/tenants/${t2}/scopes/${s2}/activate`, 'POST');

    const all = (await (await req('/scopes')).json()).entries;
    expect(all).toHaveLength(2);

    const mine = (await (await req(`/scopes?tenantId=${t1}`)).json()).entries;
    expect(mine).toHaveLength(1);

    const housing = (await (await req('/scopes?vertical=housing')).json()).entries;
    expect(housing.map((s: { id: string }) => s.id)).toEqual([s1]);

    // Repeatable status params — the console's All / Suspended / Archived tabs.
    const both = (await (await req('/scopes?status=active&status=suspended')).json()).entries;
    expect(both).toHaveLength(2);
  });

  it('reads one scope record and fails closed on a cross-tenant pair (K-3)', async () => {
    expect((await req(`/tenants/${t1}/scopes/${s1}`)).status).toBe(200);
    // s1 exists — but not under t2. Indistinguishable from absent, on purpose.
    expect((await req(`/tenants/${t2}/scopes/${s1}`)).status).toBe(404);
  });

  it('reports fleet migration progress in the §5.3 shape (#49)', async () => {
    const res = await req('/fleet/migrations');
    expect(res.status).toBe(200);
    const p = (await res.json()) as {
      release: string;
      total: number;
      migrated: number;
      pending: number;
      failed: number;
      complete: boolean;
      stragglers: unknown[];
      summary: string;
    };
    // This host registers no modules, so the frontier is 0 and every live scope
    // is at it — the honest reading of "nothing to migrate". The shape is the
    // contract; the interesting numbers are proven against real modules in the
    // adapter suites.
    expect(p.release).toBe('0');
    expect(p.total).toBeGreaterThan(0);
    expect(p.migrated).toBe(p.total);
    expect(p.pending).toBe(0);
    expect(p.failed).toBe(0);
    expect(p.complete).toBe(true);
    expect(p.stragglers).toEqual([]);
    expect(p.summary).toMatch(/^release 0: \d+\/\d+ migrated, 0 pending, 0 failed$/);
    // Narrowable by vertical — each deployment has its own frontier.
    const narrowed = (await (await req('/fleet/migrations?vertical=housing')).json()) as { total: number };
    expect(narrowed.total).toBe(1);
  });

  it('introspects a scope database, read-only (§5.4 admin-query RPC)', async () => {
    // The table list — a fresh scope already has the `_substrat_*` spine, flagged system.
    const tablesRes = await req(`/tenants/${t1}/scopes/${s1}/tables`);
    expect(tablesRes.status).toBe(200);
    const tables = (await tablesRes.json()) as { name: string; rowCount: number; system: boolean }[];
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((t) => (t.name.startsWith('_substrat') ? t.system : true))).toBe(true);
    const spine = tables.find((t) => t.name === '_substrat_migrations');
    expect(spine?.system).toBe(true);

    // A bounded page of one table — columns come back, rows are positional.
    const pageRes = await req(`/tenants/${t1}/scopes/${s1}/tables/_substrat_migrations?limit=5`);
    expect(pageRes.status).toBe(200);
    const page = (await pageRes.json()) as { columns: string[]; limit: number };
    expect(page.columns.length).toBeGreaterThan(0);
    expect(page.limit).toBe(5);

    // An unknown table is a 404, not a blind query.
    expect((await req(`/tenants/${t1}/scopes/${s1}/tables/no_such_table`)).status).toBe(404);
    // Cross-tenant fails closed (K-3): another tenant's pair reads as absent.
    expect((await req(`/tenants/${t2}/scopes/${s1}/tables`)).status).toBe(404);
  });

  it('runs a read-only console query and maps the gate refusal to 400 (#219)', async () => {
    const queryRes = await json(`/tenants/${t1}/scopes/${s1}/query`, 'POST', {
      sql: 'SELECT version FROM _substrat_migrations ORDER BY version',
    });
    expect(queryRes.status).toBe(200);
    const result = (await queryRes.json()) as { columns: string[]; rows: unknown[][]; truncated: boolean };
    expect(result.columns).toEqual(['version']);
    expect(result.truncated).toBe(false);

    // A write shape is the GATE's refusal — a 400 naming the console, never a 500.
    const writeRes = await json(`/tenants/${t1}/scopes/${s1}/query`, 'POST', {
      sql: 'DELETE FROM _substrat_migrations',
    });
    expect(writeRes.status).toBe(400);
    expect(((await writeRes.json()) as { error: string }).error).toContain('read-only console');

    // Cross-tenant fails closed (K-3), same as the table reads.
    expect((await json(`/tenants/${t2}/scopes/${s1}/query`, 'POST', { sql: 'SELECT 1' })).status).toBe(404);
  });

  it('delegates introspection to the vertical that owns the scope (connected mode)', async () => {
    // A scope whose data lives in a VERTICAL's deployment, not this control plane's own
    // (empty-module) scope host — the real prod shape (K-31). The route must ask the vertical.
    const sV = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sV, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sV);

    const calls: string[] = [];
    const fakeVertical = {
      listScopeTables: async (s: string) => {
        calls.push(`list:${s}`);
        return [{ name: 'widget', rowCount: 2, system: false }];
      },
      readScopeTable: async (s: string, input: { table: string }) => {
        calls.push(`read:${s}:${input.table}`);
        return { table: input.table, columns: ['id'], rows: [['a'], ['b']], rowCount: 2, limit: 50, offset: 0 };
      },
    } as unknown as VerticalClient;

    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });
    const dreq = (path: string) => delegated.request(path, { headers: auth });

    expect(await (await dreq(`/tenants/${t1}/scopes/${sV}/tables`)).json()).toEqual([
      { name: 'widget', rowCount: 2, system: false },
    ]);
    expect((await (await dreq(`/tenants/${t1}/scopes/${sV}/tables/widget`)).json()).rows).toEqual([['a'], ['b']]);
    // Proof the read went to the VERTICAL, not this host's own (empty) scope DB.
    expect(calls).toEqual([`list:${sV}`, `read:${sV}:widget`]);
  });

  it("relays the vertical's own introspection refusal instead of collapsing to 500", async () => {
    // The "Couldn't load the database — internal error" incident: a vertical answered
    // /internal/tables with an honest JSON 501, and the /tables route let it fall to the
    // generic error boundary, which flattened it into 500 "internal error". The boundary
    // now passes a ControlPlaneError through verbatim — status AND message.
    const sR = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sR, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sR);
    const refusing = {
      listScopeTables: async () => {
        throw new ControlPlaneError(501, 'demo-vert does not implement GET /internal/tables');
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': refusing },
    });
    const res = await delegated.request(`/tenants/${t1}/scopes/${sR}/tables`, { headers: auth });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain('does not implement');
  });

  it('gathers the tenant entitlements itself and delivers them WITH provisioning (#310)', async () => {
    const sE = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    // The tenant holds a plan on the shared control plane BEFORE the vertical is asked.
    await host.admin.grantEntitlement(staff, t1, 'housing', { quota: 25, plan: 'pro' });

    let captured: { entitlements?: EntitlementGrant[] } | undefined;
    const fakeVertical = {
      provisionInstance: async (input: { entitlements?: EntitlementGrant[] }) => {
        captured = input;
        return { tenantId: t1, scopeId: sE, owner };
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });

    // The request body carries NO entitlements — the platform is authoritative and gathers them.
    const res = await delegated.request('/verticals/demo-vert/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tenantId: t1, scopeId: sE, owner, slug: 'acme-hr', name: 'Acme HR' }),
    });
    expect(res.status).toBe(201);
    // The full grant view (quota/plan) reached the vertical, gathered by the platform itself.
    expect(captured?.entitlements?.find((e) => e.entitlementKey === 'housing')).toMatchObject({
      entitlementKey: 'housing',
      quota: 25,
      plan: 'pro',
    });
  });

  // -- #332: builder-triggerable recovery for a scope bricked to zero tuples ---

  it('re-provisions a scope to repair the #332 lockout — delegates to the vertical, no owner, re-gathered entitlements', async () => {
    const sP = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sP, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sP);
    await host.admin.grantEntitlement(staff, t1, 'housing', { quota: 10, plan: 'pro' });

    let captured: { tenantId?: string; scopeId?: string; owner?: string; entitlements?: EntitlementGrant[] } | undefined;
    const fakeVertical = {
      reconcileInstance: async (input: { tenantId: string; scopeId: string; entitlements?: EntitlementGrant[] }) => {
        captured = input;
        return { tenantId: t1, scopeId: sP, owner };
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });

    // The request body is empty — the platform delivers no owner (it never persisted one) and
    // gathers the tenant's entitlements itself, exactly as at provision.
    const res = await delegated.request(`/tenants/${t1}/scopes/${sP}/provision`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scopeId: sP, owner });
    expect(captured).toMatchObject({ tenantId: t1, scopeId: sP });
    expect(captured?.owner).toBeUndefined(); // the vertical re-sources the owner; the CP never sends one
    expect(captured?.entitlements?.find((e) => e.entitlementKey === 'housing')).toMatchObject({ quota: 10, plan: 'pro' });
  });

  it("relays the vertical's reconcile refusal (no owner of record) instead of collapsing to 500", async () => {
    const sN = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sN, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sN);
    const refusing = {
      reconcileInstance: async () => {
        throw new ControlPlaneError(409, 'no owner of record for scope — cannot reconcile; re-run the full install');
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': refusing },
    });
    const res = await delegated.request(`/tenants/${t1}/scopes/${sN}/provision`, { method: 'POST', headers: auth });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no owner of record/);
  });

  it('404s a provision for a scope the tenant does not own', async () => {
    const res = await json(`/tenants/${t1}/scopes/${scopeId.parse(ulid())}/provision`, 'POST', {});
    expect(res.status).toBe(404);
  });

  // -- per-instance config delivery (vertical-auth-detach.md §2.2) -----------

  it('delivers per-instance config through the vertical that owns the scope', async () => {
    const sC = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sC, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sC);

    const configured: unknown[] = [];
    const fakeVertical = {
      configureInstance: async (input: unknown) => {
        configured.push(input);
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });
    const entries = [
      { key: 'ADMIN_EMAIL', value: 'root@acme.test' },
      { key: 'PUBLIC_ORIGIN', value: 'https://auth.acme.test' },
    ];
    const res = await delegated.request(`/tenants/${t1}/scopes/${sC}/configure`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ entries }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 2 });
    // The delivery went to the VERTICAL's deployment, addressed by tenant + scope
    // (tenant rides along for CP-less verticals that shard storage per tenant).
    expect(configured).toEqual([{ tenantId: t1, scopeId: sC, entries }]);
  });

  it('answers 501 when the scope has no reachable vertical deployment', async () => {
    // Co-located/contract-test hosts run no vertical code — "authored but not
    // delivered" must be distinguishable from a failure, so: 501, not 500.
    const sN = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sN });
    await host.admin.activateScope(staff, t1, sN);
    const res = await json(`/tenants/${t1}/scopes/${sN}/configure`, 'POST', {
      entries: [{ key: 'A', value: '1' }],
    });
    expect(res.status).toBe(501);
  });

  it('diagnoses a lineage fork on the config-delivery 501 (#399)', async () => {
    // The egeryds shape: a scope installed under one slug while every version was pushed
    // under another (the push slug comes from package.json `name`), so no version resolves
    // and delivery 501s. The body must NAME the fork and the slug, not just say
    // "no deployment is bound" — that generic message cost a multi-hour hunt.
    const sF = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sF, vertical: 'egeryds-substrat' });
    await host.admin.activateScope(staff, t1, sF);
    const res = await json(`/tenants/${t1}/scopes/${sF}/configure`, 'POST', {
      entries: [{ key: 'SUPABASE_URL', value: 'https://x.supabase.co' }],
    });
    expect(res.status).toBe(501);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/lineage fork/i);
    expect(error).toContain('egeryds-substrat');
    expect(error).toMatch(/substrat\.slug/);
  });

  it('refuses a table-less restore with an actionable 422, not a bare internal error (#321)', async () => {
    const sB = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sB, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sB);
    const res = await json(`/tenants/${t1}/scopes/${sB}/restore`, 'POST', {
      tenantId: t1,
      scopeId: sB,
      capturedAt: new Date().toISOString(),
      tables: [],
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/no tables/);
  });

  it('flags an active scope with an empty role projection as a platform condition (#321)', async () => {
    const sH = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sH, vertical: 'health-vert' });
    await host.admin.activateScope(staff, t1, sH);
    const rolesOf = (rowCount: number) =>
      ({
        listScopeTables: async () => [
          { name: '_substrat_roles', rowCount, system: true },
          { name: 'customers', rowCount: 3, system: false },
        ],
      }) as unknown as VerticalClient;

    // Empty projection on an ACTIVE scope: identity resolves but every check denies — the
    // silent failure the field report chased. It must read as a platform condition.
    const emptyApp = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'health-vert': rolesOf(0) },
    });
    const empty = await (await emptyApp.request(`/tenants/${t1}/scopes/${sH}/health`, { headers: auth })).json();
    expect(empty).toMatchObject({ status: 'active', roleCount: 0, roleProjectionEmpty: true });

    // A populated projection is healthy — the flag is not raised.
    const healthyApp = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'health-vert': rolesOf(4) },
    });
    const healthy = await (await healthyApp.request(`/tenants/${t1}/scopes/${sH}/health`, { headers: auth })).json();
    expect(healthy).toMatchObject({ roleCount: 4, roleProjectionEmpty: false });
  });

  it("propagates the vertical's own refusal status instead of collapsing to 500", async () => {
    const sR = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sR, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sR);
    const refusing = {
      configureInstance: async () => {
        throw new ControlPlaneError(501, 'demo-vert does not implement POST /internal/configure');
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': refusing },
    });
    const res = await delegated.request(`/tenants/${t1}/scopes/${sR}/configure`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ entries: [{ key: 'A', value: '1' }] }),
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain('does not implement');
  });

  // -- snapshots (preview-and-snapshots.md §3/§9) ----------------------------

  it('snapshots and reaps in-process when no vertical is bound (co-located mode)', async () => {
    const sP = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sP });
    await host.admin.activateScope(staff, t1, sP);

    const res = await json(`/tenants/${t1}/scopes/${sP}/snapshots`, 'POST', {});
    expect(res.status).toBe(201);
    const snap = (await res.json()) as { id: string; forkedFrom: string; kind: string; status: string };
    expect(snap.forkedFrom).toBe(sP);
    expect(snap.kind).toBe('archive');
    expect(snap.status).toBe('active');

    // The fork-only refusal surfaces as 409; the fork itself deletes.
    expect((await json(`/tenants/${t1}/scopes/${sP}`, 'DELETE')).status).toBe(409);
    expect((await json(`/tenants/${t1}/scopes/${snap.id}`, 'DELETE')).status).toBe(200);
    expect((await req(`/tenants/${t1}/scopes/${snap.id}`)).status).toBe(404);
  });

  it('orchestrates snapshot + reap through the vertical; directory row lands here', async () => {
    const sV2 = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sV2, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sV2);

    const snaps: { sourceScopeId: string; newScopeId: string }[] = [];
    const deletes: string[] = [];
    const fakeVertical = {
      snapshotScope: async (input: { sourceScopeId: string; newScopeId: string }) => {
        snaps.push(input);
        return { tables: 7 };
      },
      deleteScope: async (input: { scopeId: string }) => {
        deletes.push(input.scopeId);
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });
    const djson = (path: string, method: string, body?: unknown) =>
      delegated.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await djson(`/tenants/${t1}/scopes/${sV2}/snapshots`, 'POST', { expiresAt });
    expect(res.status).toBe(201);
    const snap = (await res.json()) as {
      id: string; forkedFrom: string; kind: string; status: string; expiresAt: string;
    };
    // The DATA hop went to the vertical, naming source and destination…
    expect(snaps).toEqual([{ sourceScopeId: sV2, newScopeId: snap.id }]);
    // …and the DIRECTORY row landed here: active, with provenance + expiry.
    expect(snap.forkedFrom).toBe(sV2);
    expect(snap.kind).toBe('archive');
    expect(snap.status).toBe('active');
    expect(snap.expiresAt).toBe(expiresAt);

    // Reap: the primary is refused BEFORE any delegation; the fork's wipe reaches
    // the vertical, then the row disappears here.
    expect((await djson(`/tenants/${t1}/scopes/${sV2}`, 'DELETE')).status).toBe(409);
    expect(deletes).toEqual([]);
    expect((await djson(`/tenants/${t1}/scopes/${snap.id}`, 'DELETE')).status).toBe(200);
    expect(deletes).toEqual([snap.id]);
    expect((await delegated.request(`/tenants/${t1}/scopes/${snap.id}`, { headers: auth })).status).toBe(404);
  });

  it('bind-version with snapshot: true forks through the vertical only across a migration change', async () => {
    await host.admin.registerVertical(staff, { slug: 'snap-vert', name: 'Snap Vert', source: 'builtin' });
    const pub = async (version: string, mig: string) => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: 'snap-vert', version,
        manifestDigest: `m-${version}`, permissionDigest: 'p', migrationDigest: mig,
        deploymentRef: null,
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const vA = await pub('1.0.0', 'gA');
    const vB = await pub('2.0.0', 'gB'); // migration change vs vA
    const vB2 = await pub('2.0.1', 'gB'); // code-only vs vB

    const sV3 = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sV3, vertical: 'snap-vert' });
    await host.admin.activateScope(staff, t1, sV3);
    await host.admin.bindScopeVersion(staff, t1, sV3, vA);

    const snaps: unknown[] = [];
    const fakeVertical = {
      snapshotScope: async (input: unknown) => {
        snaps.push(input);
        return { tables: 1 };
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'snap-vert': fakeVertical },
    });
    const djson = (path: string, method: string, body?: unknown) =>
      delegated.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    // gA → gB crosses a migration digest: snapshotted through the vertical, then bound.
    const cross = await djson(`/tenants/${t1}/scopes/${sV3}/version`, 'POST', { versionId: vB, snapshot: true });
    expect(cross.status).toBe(200);
    expect(snaps).toHaveLength(1);
    expect(((await cross.json()) as { verticalVersionId: string }).verticalVersionId).toBe(vB);

    // gB → gB2 is code-only: the flag is set but the digest is unchanged — no snapshot.
    const code = await djson(`/tenants/${t1}/scopes/${sV3}/version`, 'POST', { versionId: vB2, snapshot: true });
    expect(code.status).toBe(200);
    expect(snaps).toHaveLength(1);
  });

  // -- per-PR previews (preview-and-snapshots.md §2/§9, D-43) ----------------

  it('forks prod into a preview, rebinds on re-run, and reaps on delete', async () => {
    // A PRIVATE vertical (owned by t1, unlisted) with two admitted versions.
    await host.admin.registerVertical(staff, {
      slug: 'prev-vert', name: 'Prev Vert', source: 'cli', ownerTenant: t1,
    });
    const pub = async (version: string): Promise<string> => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: 'prev-vert', version,
        manifestDigest: `m-${version}`, permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: null,
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const v1 = await pub('1.0.0');
    const v2 = await pub('1.0.1');

    // The prod scope to fork, with a canonical platform hostname to derive the URL from.
    const prod = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: prod, vertical: 'prev-vert' });
    await host.admin.activateScope(staff, t1, prod);
    await host.admin.bindScopeVersion(staff, t1, prod, v1);
    await host.admin.bindHostname(staff, {
      hostname: 'helpdesk-acme.global.substrat.run',
      tenantId: t1, scopeId: prod, surface: 'app', region: null, canonical: true,
    });

    let exports = 0;
    const restores: { scopeId: string; tables: number }[] = [];
    const deletes: string[] = [];
    const fakeVertical = {
      exportScope: async (): Promise<ScopeDumpTable[]> => {
        exports += 1;
        return [{ name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] }];
      },
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[]) => {
        restores.push({ scopeId: sid, tables: tables.length });
        return { tables: tables.length };
      },
      deleteScope: async (input: { scopeId: string }) => {
        deletes.push(input.scopeId);
      },
    } as unknown as VerticalClient;
    const dapp = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'prev-vert': fakeVertical },
      platformBaseDomains: ['global.substrat.run'],
    });
    const dj = (path: string, method: string, body?: unknown) =>
      dapp.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    // Create: forks prod, binds v1, mints a non-canonical --pr-7 URL from the prod label.
    const created = await dj('/verticals/prev-vert/previews', 'POST', { tag: 'pr-7', versionId: v1 });
    expect(created.status).toBe(201);
    const c = (await created.json()) as { scopeId: string; hostname: string; url: string; reused: boolean };
    expect(c.reused).toBe(false);
    expect(c.hostname).toBe('helpdesk-acme--pr-7.global.substrat.run');
    expect(c.url).toBe('https://helpdesk-acme--pr-7.global.substrat.run');
    expect(exports).toBe(1);
    expect(restores).toEqual([{ scopeId: c.scopeId, tables: 1 }]);

    // The directory row is a preview fork of prod, bound to v1, with an expiry for GC.
    const row = await (await dj(`/tenants/${t1}/scopes/${c.scopeId}`, 'GET')).json() as {
      kind: string; forkedFrom: string; verticalVersionId: string; expiresAt: string | null;
    };
    expect(row.kind).toBe('preview');
    expect(row.forkedFrom).toBe(prod);
    expect(row.verticalVersionId).toBe(v1);
    expect(row.expiresAt).toBeTruthy();
    const firstExpiry = row.expiresAt;

    // List shows it under its tag.
    const list = (await (await dj('/verticals/prev-vert/previews', 'GET')).json()) as {
      tag: string; scopeId: string; hostname: string;
    }[];
    expect(list.find((p) => p.tag === 'pr-7')?.scopeId).toBe(c.scopeId);

    // Re-run with the SAME tag (a PR synchronize): rebinds the new version onto the SAME
    // fork — no second export — and comes back reused.
    const again = await dj('/verticals/prev-vert/previews', 'POST', { tag: 'pr-7', versionId: v2 });
    expect(again.status).toBe(200);
    const a = (await again.json()) as { scopeId: string; reused: boolean };
    expect(a.reused).toBe(true);
    expect(a.scopeId).toBe(c.scopeId);
    expect(exports).toBe(1); // still one — the fork was reused
    expect(((await (await dj(`/tenants/${t1}/scopes/${c.scopeId}`, 'GET')).json()) as { verticalVersionId: string }).verticalVersionId).toBe(v2);

    // Reuse must RENEW the GC deadline, not leave it at first-creation (#509 ask (a)) —
    // otherwise a preview CI re-pushes to dies 72h after its first create. Passing an
    // explicit short TTL moves the deadline strictly earlier than the default-72h original.
    const renew = await dj('/verticals/prev-vert/previews', 'POST', { tag: 'pr-7', versionId: v2, ttlHours: 1 });
    expect(renew.status).toBe(200);
    const renewedExpiry = ((await (await dj(`/tenants/${t1}/scopes/${c.scopeId}`, 'GET')).json()) as { expiresAt: string }).expiresAt;
    expect(renewedExpiry).toBeTruthy();
    expect(new Date(renewedExpiry).getTime()).toBeLessThan(new Date(firstExpiry!).getTime());

    // `ttlHours: null` on reuse PINS the fork — a long-lived preview environment.
    const pin = await dj('/verticals/prev-vert/previews', 'POST', { tag: 'pr-7', versionId: v2, ttlHours: null });
    expect(pin.status).toBe(200);
    expect(((await (await dj(`/tenants/${t1}/scopes/${c.scopeId}`, 'GET')).json()) as { expiresAt: string | null }).expiresAt).toBeNull();

    // A FRESH fork can be born pinned too (the provision path, not the reuse setter).
    const pinned = await dj('/verticals/prev-vert/previews', 'POST', { tag: 'pr-pin', versionId: v1, ttlHours: null });
    expect(pinned.status).toBe(201);
    const pinnedId = ((await pinned.json()) as { scopeId: string }).scopeId;
    expect(((await (await dj(`/tenants/${t1}/scopes/${pinnedId}`, 'GET')).json()) as { expiresAt: string | null }).expiresAt).toBeNull();

    // Delete reaps the fork (through the vertical) + its hostname + the row; a second
    // delete is an idempotent no-op success (the PR-close job never fails on a re-run).
    const del = await dj('/verticals/prev-vert/previews/pr-7', 'DELETE');
    expect(del.status).toBe(200);
    expect((await del.json() as { deleted: string }).deleted).toBe(c.scopeId);
    expect(deletes).toEqual([c.scopeId]);
    expect((await dapp.request(`/tenants/${t1}/scopes/${c.scopeId}`, { headers: auth })).status).toBe(404);
    const hosts = ((await (await dj(`/hostnames?scopeId=${c.scopeId}`, 'GET')).json()) as { entries: unknown[] }).entries;
    expect(hosts).toHaveLength(0);
    expect((await (await dj('/verticals/prev-vert/previews/pr-7', 'DELETE')).json() as { deleted: string | null }).deleted).toBeNull();
  });

  it('re-forks after a create died mid-fork, instead of adopting the empty leftover', async () => {
    // The regression this pins: a create that fails AFTER the directory row (K-31 two-phase)
    // leaves a `provisioning` preview whose DO never received the dump. The generated CI
    // workflow retries `preview create` on a transient — and the retry used to match that row
    // by (kind, slug) alone and take the REUSE branch, which rebinds the version and the
    // hostname but never copies data. The PR then went green on a preview with an empty
    // database. Observed live on egeryds/crm-eff PR #21: attempt 1 → `400: internal error`,
    // attempt 2 → `✓ preview 'pr-21' updated … against a fork of prod`, zero rows in it.
    const tR = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: tR, slug: 'retry-co', name: 'Retry Co' });
    await host.admin.registerVertical(staff, {
      slug: 'retry-vert', name: 'Retry Vert', source: 'cli', ownerTenant: tR,
    });
    const pub = async (version: string): Promise<string> => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: 'retry-vert', version,
        manifestDigest: `m-${version}`, permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: null,
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const v1 = await pub('1.0.0');
    const v2 = await pub('1.0.1');

    const prod = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tR, scopeId: prod, vertical: 'retry-vert' });
    await host.admin.activateScope(staff, tR, prod);
    await host.admin.bindScopeVersion(staff, tR, prod, v1);
    await host.admin.bindHostname(staff, {
      hostname: 'retry-acme.global.substrat.run',
      tenantId: tR, scopeId: prod, surface: 'app', region: null, canonical: true,
    });

    let exports = 0;
    const restores: string[] = [];
    const deletes: string[] = [];
    const fakeVertical = {
      exportScope: async (): Promise<ScopeDumpTable[]> => {
        exports += 1;
        return [{ name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] }];
      },
      // The transient: the FIRST restore blows up, every later one lands.
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[]) => {
        if (restores.length === 0) {
          restores.push(sid);
          throw new Error('vertical refused restore: Internal Server Error');
        }
        restores.push(sid);
        return { tables: tables.length };
      },
      deleteScope: async (input: { scopeId: string }) => {
        deletes.push(input.scopeId);
      },
    } as unknown as VerticalClient;
    const dapp = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'retry-vert': fakeVertical },
      platformBaseDomains: ['global.substrat.run'],
    });
    const dj = (path: string, method: string, body?: unknown) =>
      dapp.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    // Attempt 1 dies in the data copy, leaving the half-built row behind.
    const failed = await dj('/verticals/retry-vert/previews', 'POST', { tag: 'pr-9', versionId: v1 });
    expect(failed.ok).toBe(false);
    const stranded = ((await (await dj(`/scopes?tenantId=${tR}&vertical=retry-vert`, 'GET')).json()) as {
      entries: { id: string; kind: string; status: string }[];
    }).entries.find((s) => s.kind === 'preview');
    expect(stranded?.status).toBe('provisioning');

    // Attempt 2 — what CI's retry does. It must FORK AGAIN, not adopt: a fresh scope id, a
    // second export, and a restore that actually carried the dump.
    const ok = await dj('/verticals/retry-vert/previews', 'POST', { tag: 'pr-9', versionId: v2 });
    expect(ok.status).toBe(201);
    const p = (await ok.json()) as { scopeId: string; hostname: string; reused: boolean };
    expect(p.reused).toBe(false);
    expect(p.scopeId).not.toBe(stranded!.id);
    expect(exports).toBe(2);
    expect(restores).toEqual([stranded!.id, p.scopeId]);

    // The leftover is gone — reaped through the vertical (bytes) and out of the directory
    // (row + its `--pr-9` hostname), which is what frees the tag for the fresh fork.
    expect(deletes).toEqual([stranded!.id]);
    expect((await dapp.request(`/tenants/${tR}/scopes/${stranded!.id}`, { headers: auth })).status).toBe(404);
    expect(p.hostname).toBe('retry-acme--pr-9.global.substrat.run');
    const hosts = ((await (await dj(`/hostnames?scopeId=${p.scopeId}`, 'GET')).json()) as {
      entries: { hostname: string }[];
    }).entries;
    expect(hosts.map((h) => h.hostname)).toEqual(['retry-acme--pr-9.global.substrat.run']);

    // And the healthy preview is live: status active, forked from prod, bound to v2.
    const row = (await (await dj(`/tenants/${tR}/scopes/${p.scopeId}`, 'GET')).json()) as {
      status: string; kind: string; forkedFrom: string; verticalVersionId: string;
    };
    expect(row).toMatchObject({ status: 'active', kind: 'preview', forkedFrom: prod, verticalVersionId: v2 });
  });

  it('lets a LISTED vertical owner preview a PENDING version into their own scope (#509 (d))', async () => {
    // Publishing widens who may INSTALL, not who may preview their own code. A listed
    // vertical's owner still forks their own prod scope and runs their (not-yet-admitted)
    // PR code on it — the same own-tenant blast radius a private vertical self-admits under.
    await host.admin.registerVertical(staff, {
      slug: 'listed-prev', name: 'Listed Prev', source: 'cli', ownerTenant: t1,
    });
    await host.admin.setVerticalListed(staff, 'listed-prev', true);
    const publish = async (version: string, admit: boolean): Promise<string> => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: 'listed-prev', version,
        manifestDigest: `m-${version}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      });
      if (admit) await host.admin.admitVersion(staff, id);
      return id;
    };
    const live = await publish('1.0.0', true); // the admitted version the prod scope runs
    const pending = await publish('1.1.0', false); // the un-admitted PR code to rehearse

    const prod = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: prod, vertical: 'listed-prev' });
    await host.admin.activateScope(staff, t1, prod);
    await host.admin.bindScopeVersion(staff, t1, prod, live);
    await host.admin.bindHostname(staff, {
      hostname: 'shop-acme.global.substrat.run',
      tenantId: t1, scopeId: prod, surface: 'app', region: null, canonical: true,
    });

    const fakeVertical = {
      exportScope: async (): Promise<ScopeDumpTable[]> => [
        { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] },
      ],
      restoreScope: async () => ({ tables: 1 }),
      deleteScope: async () => {},
    } as unknown as VerticalClient;
    const lapp = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'listed-prev': fakeVertical },
      platformBaseDomains: ['global.substrat.run'],
    });
    const lj = (path: string, method: string, body?: unknown) =>
      lapp.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    // The pending version binds onto the preview fork — the carve-out the admission gate now makes.
    const res = await lj('/verticals/listed-prev/previews', 'POST', { tag: 'pr-1', versionId: pending });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { scopeId: string; hostname: string; reused: boolean };
    expect(created.reused).toBe(false);
    expect(created.hostname).toBe('shop-acme--pr-1.global.substrat.run');
    const row = (await (await lj(`/tenants/${t1}/scopes/${created.scopeId}`, 'GET')).json()) as {
      kind: string; verticalVersionId: string;
    };
    expect(row.kind).toBe('preview');
    expect(row.verticalVersionId).toBe(pending); // runs the un-admitted PR code

    // The very same pending version must STILL be refused on a live (non-preview) scope —
    // the carve-out is preview-only, the install gate is intact.
    await expect(host.admin.bindScopeVersion(staff, t1, prod, pending)).rejects.toThrow(/not admitted/);
  });

  it('refuses a preview for a first-party vertical — no owner scope to fork', async () => {
    await host.admin.registerVertical(staff, {
      slug: 'firstparty', name: 'First Party', source: 'builtin', ownerTenant: null,
    });
    await host.admin.setVerticalListed(staff, 'firstparty', true);
    const res = await json('/verticals/firstparty/previews', 'POST', { tag: 'pr-1', versionId: ulid() });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no owner tenant/i);
  });

  it('forks a vertical addressed by its QUALIFIED registry id (#498)', async () => {
    // A builder push addresses the prefixed id `<tenant>/<label>` — the shape `resolveVerticalId`
    // hands every preview route. The preview scope slug must be derived from the BARE label, or
    // `provisionScope`'s DNS-label parse rejects the `/` with a 400 the create never recovers from.
    await host.admin.registerVertical(staff, {
      slug: 'acme/prev-q', name: 'Prev Q', source: 'cli', ownerTenant: t1,
    });
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id, verticalSlug: 'acme/prev-q', version: '1.0.0',
      manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
    });
    await host.admin.admitVersion(staff, id);

    const prod = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: prod, vertical: 'acme/prev-q' });
    await host.admin.activateScope(staff, t1, prod);
    await host.admin.bindScopeVersion(staff, t1, prod, id);
    await host.admin.bindHostname(staff, {
      hostname: 'prev-q-acme.global.substrat.run',
      tenantId: t1, scopeId: prod, surface: 'app', region: null, canonical: true,
    });

    const fakeVertical = {
      exportScope: async (): Promise<ScopeDumpTable[]> => [
        { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] },
      ],
      restoreScope: async (_t: string, _sid: string, tables: ScopeDumpTable[]) => ({ tables: tables.length }),
      deleteScope: async (_input: { scopeId: string }) => {},
    } as unknown as VerticalClient;
    const dapp = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'acme/prev-q': fakeVertical },
      platformBaseDomains: ['global.substrat.run'],
    });
    const path = `/verticals/${encodeURIComponent('acme/prev-q')}/previews`;
    const dj = (p: string, method: string, body?: unknown) =>
      dapp.request(p, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    // Before the fix this POST 400'd on the scope slug `acme/prev-q--pr-9`; now it forks cleanly.
    const created = await dj(path, 'POST', { tag: 'pr-9', versionId: id });
    expect(created.status).toBe(201);
    const c = (await created.json()) as { scopeId: string; hostname: string };
    expect(c.hostname).toBe('prev-q-acme--pr-9.global.substrat.run');
    // The preview scope carries the BARE-label slug, and delete's reap-match agrees with it.
    const row = (await (await dj(`/tenants/${t1}/scopes/${c.scopeId}`, 'GET')).json()) as { slug: string };
    expect(row.slug).toBe('prev-q--pr-9');
    const del = await dj(`${path}/pr-9`, 'DELETE');
    expect(((await del.json()) as { deleted: string | null }).deleted).toBe(c.scopeId);
  });

  it("provisions a clean-room (empty, source-less) preview — a vertical's first environment (#509 (b))", async () => {
    // A brand-new vertical with NO prod scope. A fork has nothing to copy; `empty:true`
    // provisions an EMPTY scope instead, so the first environment can be a throwaway preview.
    await host.admin.registerVertical(staff, {
      slug: 'cleanroom', name: 'Clean Room', source: 'cli', ownerTenant: t1,
    });
    const vId = ulid();
    await host.admin.publishVersion(staff, {
      id: vId, verticalSlug: 'cleanroom', version: '1.0.0',
      manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
    });
    // private (owned, unlisted) → self-admits, so the version binds. Configure the platform
    // suffixes the SAME way production does — the bare apex FIRST, then the jurisdiction
    // domain — since that ordering is exactly what stranded clean-room previews: taking
    // `platformBaseDomains[0]` minted on the certless `*.substrat.run` instead of the
    // wildcard-backed `*.global.substrat.run`. A single-entry list masked the bug.
    const capp = createControlPlaneApi({
      host, authenticate: UNSAFE_devPlatformActorAuth(), platformBaseDomains: ['substrat.run', 'global.substrat.run'],
    });
    const cj = (p: string, method: string, body?: unknown) =>
      capp.request(p, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

    // With no source scope, the URL follows the tenant-app convention `<vertical>-<tenant>`.
    const tSlug = ((await (await cj(`/tenants/${t1}`, 'GET')).json()) as { slug: string }).slug;

    const res = await cj('/verticals/cleanroom/previews', 'POST', { tag: 'pr-1', versionId: vId, empty: true });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { scopeId: string; hostname: string; reused: boolean };
    expect(created.reused).toBe(false);
    // The jurisdiction segment MUST be present — this is the regression guard: the wildcard
    // DNS/cert lives on `*.global.substrat.run`, so a hostname without `.global.` never resolves.
    expect(created.hostname).toBe(`cleanroom-${tSlug}--pr-1.global.substrat.run`);

    const row = (await (await cj(`/tenants/${t1}/scopes/${created.scopeId}`, 'GET')).json()) as {
      kind: string; forkedFrom: string | null; verticalVersionId: string; expiresAt: string | null;
    };
    expect(row.kind).toBe('preview');
    expect(row.forkedFrom).toBeNull(); // NOT a fork — the clean-room distinction the reaper now handles
    expect(row.verticalVersionId).toBe(vId);
    expect(row.expiresAt).toBeTruthy();

    // It deletes like any preview — deleteSnapshot now accepts a non-fork preview scope.
    const del = await cj('/verticals/cleanroom/previews/pr-1', 'DELETE');
    expect(((await del.json()) as { deleted: string | null }).deleted).toBe(created.scopeId);

    // `empty` and a sourceScopeId are mutually exclusive — the request is refused, not guessed.
    const bad = await cj('/verticals/cleanroom/previews', 'POST', {
      tag: 'pr-2', versionId: vId, empty: true, sourceScopeId: scopeId.parse(ulid()),
    });
    expect(bad.status).toBe(400);
  });

  // -- the governed pull (preview-and-snapshots.md §6/§8) --------------------

  it('exports a scope masked by default; ?full=true is the break-glass', async () => {
    const sE = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sE });
    await host.admin.activateScope(staff, t1, sE);

    const masked = await req(`/tenants/${t1}/scopes/${sE}/export`);
    expect(masked.status).toBe(200);
    const dump = (await masked.json()) as { masked: boolean; tables: { name: string }[]; scopeId: string };
    expect(dump.masked).toBe(true);
    expect(dump.scopeId).toBe(sE);
    // The spine came along — the dump is the whole scope.
    expect(dump.tables.some((t) => t.name === '_substrat_migrations')).toBe(true);

    const full = await req(`/tenants/${t1}/scopes/${sE}/export?full=true`);
    expect(((await full.json()) as { masked: boolean }).masked).toBe(false);
  });

  it('restores a full dump into an existing scope; unknown scope 404s', async () => {
    const sR = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sR });
    await host.admin.activateScope(staff, t1, sR);
    // A FULL export round-trips (the masked default deliberately does not — masked
    // rows restored would silently replace real data with redactions).
    const dump = (await (await req(`/tenants/${t1}/scopes/${sR}/export?full=true`)).json()) as {
      tenantId: string; scopeId: string; capturedAt: string; tables: unknown[]; masked: boolean;
    };
    const res = await json(`/tenants/${t1}/scopes/${sR}/restore`, 'POST', {
      tenantId: dump.tenantId, scopeId: dump.scopeId, capturedAt: dump.capturedAt, tables: dump.tables,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: sR, tables: dump.tables.length });

    const missing = await json(`/tenants/${t1}/scopes/${scopeId.parse(ulid())}/restore`, 'POST', {
      tenantId: t1, scopeId: sR, capturedAt: dump.capturedAt, tables: [],
    });
    expect(missing.status).toBe(404);
  });

  it('masks PII columns and JSON payload keys in a delegated export', async () => {
    const sM = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sM, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t1, sM);

    const customerRows = [['c1', 'anna@example.com', 'Anna Ek', 7]];
    const outboxRows = [['e1', JSON.stringify({ customerEmail: 'anna@example.com', total: '120.00' })]];
    const fakeVertical = {
      exportScope: async () => [
        { name: 'customers', ddl: 'CREATE TABLE customers (id TEXT, email TEXT, name TEXT, visits INTEGER)', columns: ['id', 'email', 'name', 'visits'], rows: customerRows },
        { name: '_substrat_outbox', ddl: 'CREATE TABLE _substrat_outbox (id TEXT, payload TEXT)', columns: ['id', 'payload'], rows: outboxRows },
      ],
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });

    const res = await delegated.request(`/tenants/${t1}/scopes/${sM}/export`, { headers: auth });
    expect(res.status).toBe(200);
    const dump = (await res.json()) as { masked: boolean; tables: { name: string; rows: unknown[][] }[] };
    expect(dump.masked).toBe(true);
    const customers = dump.tables.find((t) => t.name === 'customers')!;
    // email + name masked; id and the count untouched (ids keep the copy debuggable).
    expect(customers.rows[0]).toEqual(['c1', '[masked]', '[masked]', 7]);
    // The fat event payload keeps its SHAPE; the PII key inside is masked.
    const outbox = dump.tables.find((t) => t.name === '_substrat_outbox')!;
    expect(JSON.parse(outbox.rows[0]![1] as string)).toEqual({
      customerEmail: '[masked]',
      total: '120.00',
    });

    // Break-glass: full fidelity, verbatim.
    const full = await delegated.request(`/tenants/${t1}/scopes/${sM}/export?full=true`, { headers: auth });
    const fullDump = (await full.json()) as { masked: boolean; tables: { name: string; rows: unknown[][] }[] };
    expect(fullDump.masked).toBe(false);
    expect(fullDump.tables.find((t) => t.name === 'customers')!.rows).toEqual(customerRows);
  });

  it('refuses to export a jurisdiction-pinned scope (K-32)', async () => {
    const sJ = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t1, scopeId: sJ, jurisdiction: 'eu' });
    await host.admin.activateScope(staff, t1, sJ);
    const res = await req(`/tenants/${t1}/scopes/${sJ}/export`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/jurisdiction/);
  });

  it('walks the lifecycle and maps an illegal transition to 409', async () => {
    const suspended = await json(`/tenants/${t1}/scopes/${s1}/suspend`, 'POST');
    expect(await suspended.json()).toMatchObject({ status: 'suspended' });

    // Only legal transitions exist; the graph is enforced below the seam.
    const illegal = await json(`/tenants/${t1}/scopes/${s1}/unarchive`, 'POST');
    expect(illegal.status).toBe(409);
    expect((await illegal.json()).error).toMatch(/illegal scope transition/);

    const archived = await json(`/tenants/${t1}/scopes/${s1}/archive`, 'POST');
    expect(await archived.json()).toMatchObject({ status: 'archived' });

    const restored = await json(`/tenants/${t1}/scopes/${s1}/unarchive`, 'POST');
    expect(await restored.json()).toMatchObject({ status: 'active' });
  });

  it('reap: refuses a non-archived scope (409), then wipes via the vertical and keeps the tombstone (§4.4)', async () => {
    // A dedicated tenant so this test's archive/reap entries do not perturb the shared
    // admin-log counts other tests assert on t1.
    const tR = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: tR, slug: 'reap-co', name: 'Reap Co' });
    const sR = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tR, scopeId: sR, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, tR, sR);

    const deletes: string[] = [];
    const fakeVertical = {
      deleteScope: async (input: { scopeId: string }) => {
        deletes.push(input.scopeId);
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });
    const djson = (path: string, method: string) =>
      delegated.request(path, { method, headers: auth });

    // Active scope refused BEFORE any delegation — the vertical is never asked to wipe it.
    const early = await djson(`/tenants/${tR}/scopes/${sR}/reap`, 'POST');
    expect(early.status).toBe(409);
    expect((await early.json()).error).toMatch(/not archived/);
    expect(deletes).toEqual([]);

    // A scope that still resolves a hostname is refused too — and, like the archived-only
    // gate, BEFORE any delegation, so the vertical never wipes a scope that is still online.
    // This is the regression the incident exposed: a console archive does not release
    // hostnames, so reap must fence on them itself rather than assume the release.
    await host.admin.bindHostname(staff, {
      hostname: 'reap-me.example.com',
      tenantId: tR,
      scopeId: sR,
      surface: 'app',
      region: null,
      canonical: true,
    });
    await host.admin.archiveScope(staff, tR, sR);
    const stillBound = await djson(`/tenants/${tR}/scopes/${sR}/reap`, 'POST');
    expect(stillBound.status).toBe(409);
    expect((await stillBound.json()).error).toMatch(/still resolves hostname 'reap-me\.example\.com'/);
    expect(deletes).toEqual([]); // the wipe never reached the vertical

    // Unbind (the visible, reversible step) and only then does reap go through: the storage
    // wipe reaches the vertical, and the directory row SURVIVES here as a `reaped` tombstone.
    await host.admin.unbindHostname(staff, 'reap-me.example.com');
    const reaped = await djson(`/tenants/${tR}/scopes/${sR}/reap`, 'POST');
    expect(reaped.status).toBe(200);
    expect(await reaped.json()).toMatchObject({ status: 'reaped' });
    expect(deletes).toEqual([sR]);
    // The tombstone is still resolvable (200, not the fork-delete's 404).
    expect((await delegated.request(`/tenants/${tR}/scopes/${sR}`, { headers: auth })).status).toBe(200);
  });

  /**
   * #493 — a reap wipes a scope's storage irreversibly, so the recoverable copy is a
   * property of the ROUTE, not of the operator remembering. What these pin is the
   * ordering (copy durable BEFORE any byte is wiped) and the refusals that keep it
   * honest: an asked-for backup with nowhere to go must stop the reap, not skip the copy.
   */
  describe('backup before reap (#493)', () => {
    /** An in-memory `ScopeBackupStore`, recording into a shared ordering log. */
    function fakeStore(order: string[], opts: { fail?: boolean } = {}) {
      const held = new Map<string, { backup: ScopeBackup; dump: ScopeDump }>();
      const key = (t: string, s: string, at: string) => `${t}/${s}/${at}`;
      return {
        held,
        store: {
          put: async ({ vertical, dump }: { vertical: string | null; dump: ScopeDump }) => {
            if (opts.fail) throw new Error('bucket unavailable');
            const backup: ScopeBackup = {
              tenantId: dump.tenantId,
              scopeId: dump.scopeId,
              vertical,
              capturedAt: dump.capturedAt,
              size: JSON.stringify(dump).length,
              tables: dump.tables.length,
            };
            held.set(key(dump.tenantId, dump.scopeId, dump.capturedAt), { backup, dump });
            order.push(`backup:${dump.scopeId}`);
            return backup;
          },
          list: async ({ tenantId: t, scopeId: s }: { tenantId: string; scopeId: string }) =>
            [...held.values()].filter((v) => v.backup.tenantId === t && v.backup.scopeId === s).map((v) => v.backup),
          get: async (i: { tenantId: string; scopeId: string; capturedAt: string }) =>
            held.get(key(i.tenantId, i.scopeId, i.capturedAt))?.dump ?? null,
        },
      };
    }

    /** A vertical holding one table of real rows, recording its wipe into the same log. */
    function fakeVerticalFor(order: string[]) {
      return {
        exportScope: async (): Promise<ScopeDumpTable[]> => [
          {
            name: 'customers',
            ddl: 'CREATE TABLE customers (id TEXT, email TEXT)',
            columns: ['id', 'email'],
            rows: [['c1', 'anna@example.com']],
          },
        ],
        deleteScope: async (input: { scopeId: string }) => {
          order.push(`wipe:${input.scopeId}`);
        },
      } as unknown as VerticalClient;
    }

    /** An archived, unbound scope — the one state a reap is legal from. */
    async function archivedScope(slug: string) {
      const t = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug, name: slug });
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.archiveScope(staff, t, s);
      return { t, s };
    }

    it('stores a full dump BEFORE the wipe, names it in the response and on the admin log, and serves it back', async () => {
      const order: string[] = [];
      const { store, held } = fakeStore(order);
      const { t, s } = await archivedScope('backup-co');
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
        scopeBackups: store,
      });

      const res = await api.request(`/tenants/${t}/scopes/${s}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; backup: ScopeBackup };
      expect(body.status).toBe('reaped');

      // THE property: the copy was durable before the bytes went. A wipe-then-backup
      // ordering would still produce a stored object — of an already-emptied scope.
      expect(order).toEqual([`backup:${s}`, `wipe:${s}`]);

      // Full fidelity, not the export route's masked default: a masked copy restores a
      // structurally-valid but factually wrong scope, which is not a backup.
      expect(body.backup).toMatchObject({ tenantId: t, scopeId: s, vertical: 'demo-vert', tables: 1 });
      const stored = [...held.values()][0]!.dump;
      expect(stored.tables.find((x) => x.name === 'customers')!.rows[0]).toEqual(['c1', 'anna@example.com']);

      // The admin log answers "was there a copy, and where" from the reap entry itself.
      const log = await host.admin.auditLog(staff, { tenantId: t, limit: 50 });
      const entry = log.find((e) => e.action === 'reapScope')!;
      expect((entry.after as { backupRef?: string }).backupRef).toBe(
        `/tenants/${t}/scopes/${s}/backups/${body.backup.capturedAt}`,
      );

      // Readable AFTER the reap — the directory row survives as a tombstone, and the
      // copy is what makes the wipe survivable rather than merely recorded.
      const listed = await api.request(`/tenants/${t}/scopes/${s}/backups`, { headers: auth });
      expect(await listed.json()).toHaveLength(1);
      const fetched = await api.request(
        `/tenants/${t}/scopes/${s}/backups/${body.backup.capturedAt}`,
        { headers: auth },
      );
      expect(fetched.status).toBe(200);
      expect((await fetched.json()) as ScopeDump).toMatchObject({ tenantId: t, scopeId: s });
    });

    it('refuses the reap when a backup is asked for and no store is configured — the scope survives', async () => {
      const order: string[] = [];
      const { t, s } = await archivedScope('no-store-co');
      // No `scopeBackups`: the misconfigured-platform case. Silently reaping here is
      // exactly the failure mode the explicit ask exists to prevent.
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
      });

      const res = await api.request(`/tenants/${t}/scopes/${s}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: true }),
      });
      expect(res.status).toBe(501);
      expect((await res.json()).error).toMatch(/no backup target configured/);
      expect(order).toEqual([]); // the wipe never reached the vertical
      expect((await host.admin.getScopeRecord(staff, t, s))!.status).toBe('archived');
    });

    it('aborts the reap when the store throws — a wipe never outruns a failed copy', async () => {
      const order: string[] = [];
      const { store } = fakeStore(order, { fail: true });
      const { t, s } = await archivedScope('store-down-co');
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
        scopeBackups: store,
      });

      const res = await api.request(`/tenants/${t}/scopes/${s}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: true }),
      });
      // 502 with the store's own detail, not a bare 500: "the bucket is down" and "the
      // reap broke" are different facts, and only one of them leaves data intact (#321).
      expect(res.status).toBe(502);
      const err = (await res.json()) as { error: string; detail: string };
      expect(err.error).toMatch(/the scope was NOT reaped/);
      expect(err.detail).toMatch(/bucket unavailable/);
      expect(order).toEqual([]);
      expect((await host.admin.getScopeRecord(staff, t, s))!.status).toBe('archived');
    });

    it('backup:false is the explicit unrecoverable wipe; omitting it reaps unbacked only where no store exists', async () => {
      const order: string[] = [];
      const { store, held } = fakeStore(order);
      const { t, s } = await archivedScope('opt-out-co');
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
        scopeBackups: store,
      });

      const res = await api.request(`/tenants/${t}/scopes/${s}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'reaped', backup: null });
      expect(order).toEqual([`wipe:${s}`]);
      expect(held.size).toBe(0);

      // And the pre-#493 caller — a bare POST with no body — still works where the
      // platform has no store at all (self-host, embedded), rather than 501ing.
      const bare = await archivedScope('legacy-caller-co');
      const noStore = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
      });
      const legacy = await noStore.request(`/tenants/${bare.t}/scopes/${bare.s}/reap`, {
        method: 'POST',
        headers: auth,
      });
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toMatchObject({ status: 'reaped', backup: null });
    });

    it('refuses to back up a jurisdiction-pinned scope rather than move its data to the global store (K-32)', async () => {
      const order: string[] = [];
      const { store } = fakeStore(order);
      const t = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: 'eu-pinned-co', name: 'EU Pinned Co' });
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert', jurisdiction: 'eu' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.archiveScope(staff, t, s);
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
        scopeBackups: store,
      });

      const res = await api.request(`/tenants/${t}/scopes/${s}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: true }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/pinned to 'eu'.*out of that jurisdiction/s);
      // Refusing the BACKUP refuses the REAP: we do not wipe what we may not copy.
      expect(order).toEqual([]);
      expect((await host.admin.getScopeRecord(staff, t, s))!.status).toBe('archived');
    });

    it('tenant reap takes NO backup by default (§4.8 is an erasure path), and one per scope when asked', async () => {
      const order: string[] = [];
      const { store, held } = fakeStore(order);

      // Default: erasure. Writing the customer's data to a bucket the reap does not
      // clear would defeat the Art. 17 request the teardown may exist to satisfy.
      const erase = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: erase, slug: 'erase-co', name: 'Erase Co' });
      const sE = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: erase, scopeId: sE, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, erase, sE);
      await host.admin.setTenantStatus(staff, erase, 'deleting');
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { 'demo-vert': fakeVerticalFor(order) },
        scopeBackups: store,
      });
      const erased = await api.request(`/tenants/${erase}/reap`, { method: 'POST', headers: auth });
      expect(erased.status).toBe(200);
      expect(order).toEqual([`wipe:${sE}`]);
      expect(held.size).toBe(0);

      // Opt in: retiring a tenant, not erasing one.
      const keep = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: keep, slug: 'retire-co', name: 'Retire Co' });
      const sK = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: keep, scopeId: sK, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, keep, sK);
      await host.admin.setTenantStatus(staff, keep, 'deleting');
      const retired = await api.request(`/tenants/${keep}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: true }),
      });
      expect(retired.status).toBe(200);
      expect(order.slice(1)).toEqual([`backup:${sK}`, `wipe:${sK}`]);
      expect(held.size).toBe(1);
    });
  });

  /**
   * #40 — the directory's own backup/restore routes. The scope backups above protect one
   * customer; these protect the map that makes every customer addressable, and unlike a
   * scope the directory has no point-in-time recovery to fall back on.
   *
   * What these pin is the surface an operator meets in an emergency: what is held, how a
   * copy is taken by hand, and the guard that stands between a legitimate recovery and a
   * replayed restore that would roll a working platform backwards.
   */
  describe('directory backups (#40)', () => {
    /** An in-memory `DirectoryBackupStore` over the one directory. */
    function fakeDirectoryStore() {
      const copies = new Map<string, DirectoryDump>();
      return {
        copies,
        store: {
          put: async ({ dump }: { dump: DirectoryDump }) => {
            copies.set(dump.capturedAt, dump);
            return {
              capturedAt: dump.capturedAt,
              size: JSON.stringify(dump).length,
              tables: dump.tables.length,
            };
          },
          list: async () =>
            [...copies.values()]
              .map((d) => ({
                capturedAt: d.capturedAt,
                size: JSON.stringify(d).length,
                tables: d.tables.length,
              }))
              .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)),
          get: async ({ capturedAt }: { capturedAt: string }) => copies.get(capturedAt) ?? null,
          delete: async ({ capturedAt }: { capturedAt: string }) => {
            copies.delete(capturedAt);
          },
        },
      };
    }

    it('takes a copy on demand, lists it, and serves the dump back as a restore source', async () => {
      const { store, copies } = fakeDirectoryStore();
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        directoryBackups: store,
      });

      const taken = await api.request('/directory/backups', { method: 'POST', headers: auth });
      expect(taken.status).toBe(201);
      const meta = (await taken.json()) as { capturedAt: string; tables: number };
      expect(meta.tables).toBeGreaterThan(0);
      expect(copies.size).toBe(1);

      const listed = await api.request('/directory/backups', { headers: auth });
      expect(await listed.json()).toHaveLength(1);

      // The dump itself — real directory tables, not a stub.
      const dumped = await api.request(`/directory/backups/${meta.capturedAt}`, { headers: auth });
      const dump = (await dumped.json()) as DirectoryDump;
      expect(dump.tables.map((t) => t.name)).toContain('tenants');

      // A copy that does not exist is a 404, not an empty dump that would restore an
      // empty platform.
      const missing = await api.request('/directory/backups/2020-01-01T00:00:00.000Z', { headers: auth });
      expect(missing.status).toBe(404);
    });

    it('refuses a restore onto a directory that still has tenants, unless overwrite is explicit', async () => {
      const { store } = fakeDirectoryStore();
      const api = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        directoryBackups: store,
      });
      const taken = await api.request('/directory/backups', { method: 'POST', headers: auth });
      const { capturedAt } = (await taken.json()) as { capturedAt: string };

      // A tenant that did not exist when the copy was taken — this is what a replayed
      // restore would silently destroy, and it is created here rather than inherited so
      // the guard is tested against a directory this test knows the shape of.
      const later = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: later, slug: 'post-backup-co', name: 'Post Backup Co' });

      // The dangerous case: a well-formed restore replayed against a control plane that
      // has already recovered.
      const refused = await api.request('/directory/restore', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ capturedAt }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain('overwrite=true');

      // Said out loud, it proceeds — and the platform is still readable afterwards.
      const done = await api.request('/directory/restore', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ capturedAt, overwrite: true }),
      });
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({ capturedAt });
      // A restore REPLACES: what was created after the copy is gone, and the platform
      // still answers through the directory it just rewrote.
      expect(await host.admin.getTenant(staff, later)).toBeUndefined();
      const tenants = await api.request('/tenants', { headers: auth });
      expect(tenants.status).toBe(200);

      // Audited in the log it just replaced — the entry after a restored history is the
      // restore itself, which is what makes the seam legible rather than silent.
      const log = await host.admin.auditLog(staff, { action: 'restoreDirectory' });
      expect(log).toHaveLength(1);
      expect(log[0]!.after).toMatchObject({ capturedAt });
    });

    it('answers 501 with no store bound — loudly unconfigured, never an empty list', async () => {
      const api = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      for (const [path, method] of [
        ['/directory/backups', 'GET'],
        ['/directory/backups', 'POST'],
        ['/directory/backups/2026-08-06T00:00:00.000Z', 'GET'],
        ['/directory/restore', 'POST'],
      ] as const) {
        const res = await api.request(path, { method, headers: auth, ...(method === 'POST' ? { body: '{}' } : {}) });
        // An empty list would read as "backups run, there just are none" — the exact
        // false belief a DR surface must not be able to create.
        expect(res.status).toBe(501);
      }
    });
  });

  it('tenant reap: refuses a non-deleting tenant (409), then reaps every scope via the vertical and keeps the tombstone (§4.8)', async () => {
    const tR = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: tR, slug: 'tenant-reap-co', name: 'Tenant Reap Co' });
    // Two scopes in different states: an active one (must be archived first) and an
    // already-archived one. Both must have their storage wiped through the vertical.
    const sActive = scopeId.parse(ulid());
    const sArch = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tR, scopeId: sActive, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, tR, sActive);
    await host.provisionScope(staff, { tenantId: tR, scopeId: sArch, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, tR, sArch);
    await host.admin.archiveScope(staff, tR, sArch);
    // The active scope still resolves a hostname — tenant teardown must force PAST the
    // per-scope bound-hostname guard (releasing every name is the point of a tenant reap),
    // unlike the interactive per-scope route above which the same binding would block.
    await host.admin.bindHostname(staff, {
      hostname: 'tenant-reap-me.example.com',
      tenantId: tR,
      scopeId: sActive,
      surface: 'app',
      region: null,
      canonical: true,
    });

    const deletes: string[] = [];
    const fakeVertical = {
      deleteScope: async (input: { scopeId: string }) => {
        deletes.push(input.scopeId);
      },
    } as unknown as VerticalClient;
    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { 'demo-vert': fakeVertical },
    });
    const djson = (path: string, method: string) => delegated.request(path, { method, headers: auth });

    // An active tenant is refused BEFORE any scope is touched — reap only follows delete.
    const early = await djson(`/tenants/${tR}/reap`, 'POST');
    expect(early.status).toBe(409);
    expect((await early.json()).error).toMatch(/not deleting/);
    expect(deletes).toEqual([]);

    // Mark for deletion, then reap now: every scope's storage is wiped through the
    // vertical and the tenant lands as a `reaped` tombstone.
    await host.admin.setTenantStatus(staff, tR, 'deleting');
    const reaped = await djson(`/tenants/${tR}/reap`, 'POST');
    expect(reaped.status).toBe(200);
    expect(await reaped.json()).toMatchObject({ status: 'reaped' });
    // Both scopes were wiped through the vertical (active one archived first, en route).
    expect(deletes.sort()).toEqual([sActive, sArch].sort());
    // Both scope rows are `reaped` tombstones…
    expect((await host.admin.getScopeRecord(staff, tR, sActive))!.status).toBe('reaped');
    expect((await host.admin.getScopeRecord(staff, tR, sArch))!.status).toBe('reaped');
    // …the tenant row survives as a tombstone (resolvable, status reaped)…
    expect((await host.admin.getTenant(staff, tR))!.status).toBe('reaped');
    // …and a second reap is refused (terminal).
    expect((await djson(`/tenants/${tR}/reap`, 'POST')).status).toBe(409);
  });

  // -- roles (§4.5) ----------------------------------------------------------

  it('lists roles and filters by tenant and source', async () => {
    await host.admin.defineRole(platformActorId.parse(ulid()), t1, {
      key: 'site-manager',
      permissions: [permissionKey.parse('workorder:read')],
      source: 'vertical',
    });
    const roles = (await (await req(`/roles?tenantId=${t1}`)).json()).entries;
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ tenantId: t1, key: 'site-manager', source: 'vertical' });

    // An unknown source returns nothing rather than 400 — the console filters
    // over sources it has seen, and a typo is an empty list, not an error.
    expect((await (await req('/roles?source=nope')).json()).entries).toEqual([]);
  });

  it('exposes no route that writes a role', async () => {
    // defineRole stays off the wire: creating a role is a permission change, and
    // the permission diff is a human checkpoint.
    expect((await json('/roles', 'POST', { key: 'x', permissions: ['a:b'], source: 'vertical' })).status).toBe(404);
  });

  // -- the admin log (§4.4/§4.5) --------------------------------------------

  it('returns the admin log newest-first with a continuation cursor', async () => {
    const res = await req(`/admin-log?tenantId=${t1}&order=desc&limit=2`);
    const { entries, nextCursor } = await res.json();
    expect(entries).toHaveLength(2);
    expect(nextCursor).toBe(entries[1].id);
    // Newest first: ULID order is chronological.
    expect(entries[0].id > entries[1].id).toBe(true);

    // The cursor carries the page forward with no client-side assembly.
    const page2 = await (await req(`/admin-log?tenantId=${t1}&order=desc&limit=2&cursor=${nextCursor}`)).json();
    expect(page2.entries[0].id < nextCursor).toBe(true);
  });

  it('filters the admin log by action and scope', async () => {
    const { entries } = await (
      await req(`/admin-log?tenantId=${t1}&action=suspendScope&action=archiveScope`)
    ).json();
    expect(entries.length).toBe(2);
    expect(entries.every((e: { action: string }) => ['suspendScope', 'archiveScope'].includes(e.action))).toBe(true);
    // Lifecycle rows carry the scope's vertical — the target, stamped host-side.
    expect(entries.every((e: { vertical: string }) => e.vertical === 'housing')).toBe(true);

    const byScope = await (await req(`/admin-log?scopeId=${s1}`)).json();
    expect(byScope.entries.every((e: { scopeId: string }) => e.scopeId === s1)).toBe(true);
  });

  it('rejects an unknown action filter at the boundary', async () => {
    expect((await req('/admin-log?action=deleteEverything')).status).toBe(400);
  });

  it('returns a null cursor on an empty page', async () => {
    const { entries, nextCursor } = await (
      await req(`/admin-log?tenantId=${tenantId.parse(ulid())}`)
    ).json();
    expect(entries).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  // -- the hostname map (§4.7, K-26) -----------------------------------------

  it('binds a hostname, which does not serve until it is activated', async () => {
    const created = await json('/hostnames', 'POST', {
      hostname: 'ACME.Example.com',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
      canonical: true,
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    // Normalized at the schema: DNS is case-insensitive, so the map is too.
    expect(body.hostname).toBe('acme.example.com');
    expect(body.status).toBe('pending');
    expect(await host.admin.resolveHostname('acme.example.com')).toBeUndefined();

    const activated = await json('/hostnames/acme.example.com/status', 'PATCH', { status: 'active' });
    expect(activated.status).toBe(200);
    expect((await activated.json()).status).toBe('active');
    expect(await host.admin.resolveHostname('acme.example.com')).toMatchObject({ scopeId: s1 });
  });

  it('lists hostnames, filtered by scope', async () => {
    const all = (await (await req('/hostnames')).json()).entries;
    expect(all.map((h: { hostname: string }) => h.hostname)).toContain('acme.example.com');
    const forScope = (await (await req(`/hostnames?scopeId=${s1}`)).json()).entries;
    expect(forScope.every((h: { scopeId: string }) => h.scopeId === s1)).toBe(true);
  });

  it('records a failure reason rather than losing it', async () => {
    await json('/hostnames', 'POST', {
      hostname: 'broken.example.com',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
    });
    await json('/hostnames/broken.example.com/status', 'PATCH', {
      status: 'failed',
      note: 'DNS validation timed out',
    });
    const rows = (await (await req(`/hostnames?scopeId=${s1}`)).json()).entries;
    const row = rows.find((h: { hostname: string }) => h.hostname === 'broken.example.com');
    expect(row.status).toBe('failed');
    expect(row.statusNote).toContain('DNS validation');
  });

  it('refuses to move a hostname to another scope over HTTP', async () => {
    const res = await json('/hostnames', 'POST', {
      hostname: 'acme.example.com',
      tenantId: t2,
      scopeId: scopeId.parse(ulid()),
      surface: 'app',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a malformed binding at the boundary', async () => {
    expect((await json('/hostnames', 'POST', { hostname: '', tenantId: t1, scopeId: s1, surface: 'app' })).status).toBe(400);
    expect((await json('/hostnames', 'POST', { hostname: 'x.example.com', tenantId: 'nope', scopeId: s1, surface: 'app' })).status).toBe(400);
    expect((await json('/hostnames/acme.example.com/status', 'PATCH', { status: 'sideways' })).status).toBe(400);
  });

  it('audits the staff writes, and does not offer resolveHostname at all', async () => {
    const { entries } = await (await req('/admin-log?action=bindHostname')).json();
    expect(entries.length).toBeGreaterThan(0);
    // The router's per-request read is not a staff action and has no route here
    // (K-24). A 404 rather than a resolution is the point.
    expect((await req('/hostnames/acme.example.com/resolve')).status).toBe(404);
  });

  // -- instances (K-31) -------------------------------------------------------

  it('501s for a vertical with no deployment bound, rather than pretending', async () => {
    // A control plane that silently does nothing is worse than one that says it
    // cannot: the caller would believe an instance exists.
    const res = await json('/verticals/ghost/instances', 'POST', {
      tenantId: t1,
      scopeId: scopeId.parse(ulid()),
      owner: ulid(),
      slug: 'acme',
      name: 'Acme AB',
    });
    expect(res.status).toBe(501);
  });

  it('calls the vertical, presenting the platform secret', async () => {
    let seen: Request | undefined;
    const vertical = new VerticalClient({
      platformSecret: 'shhh',
      fetch: (async (url: string, init: RequestInit) => {
        seen = new Request(url, init);
        return new Response(
          JSON.stringify({ tenantId: t1, scopeId: s1, owner: '01JZ00000000000000000000OW' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });
    const withVertical = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
    });

    const res = await withVertical.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        tenantId: t1,
        scopeId: s1,
        owner: '01JZ00000000000000000000OW',
        slug: 'acme',
        name: 'Acme AB',
      }),
    });

    expect(res.status).toBe(201);
    expect(seen?.headers.get('x-substrat-platform')).toBe('shhh');
    expect(new URL(seen!.url).pathname).toBe('/internal/provision');
  });

  it('falls through to resolveVertical for a pushed vertical (dispatch swap)', async () => {
    let seen: Request | undefined;
    let resolvedSlug: string | undefined;
    const pushed = new VerticalClient({
      platformSecret: 'shhh',
      fetch: (async (url: string, init: RequestInit) => {
        seen = new Request(url, init);
        return new Response(
          JSON.stringify({ tenantId: t1, scopeId: s1, owner: '01JZ00000000000000000000OW' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });
    const withResolver = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      // No static binding — only the dispatch resolver, as a deployed control plane has.
      resolveVertical: async (slug) => {
        resolvedSlug = slug;
        return slug === 'pushed' ? pushed : undefined;
      },
    });

    const res = await withResolver.request('/verticals/pushed/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        tenantId: t1,
        scopeId: s1,
        owner: '01JZ00000000000000000000OW',
        slug: 'acme',
        name: 'Acme AB',
      }),
    });

    expect(res.status).toBe(201);
    expect(resolvedSlug).toBe('pushed');
    expect(seen?.headers.get('x-substrat-platform')).toBe('shhh');
  });

  it('501s when neither a static binding nor resolveVertical yields a vertical', async () => {
    const withResolver = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      resolveVertical: async () => undefined,
    });
    const res = await withResolver.request('/verticals/ghost/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        tenantId: t1,
        scopeId: s1,
        owner: '01JZ00000000000000000000OW',
        slug: 'x',
        name: 'X',
      }),
    });
    expect(res.status).toBe(501);
  });

  it('surfaces a refusal from the vertical rather than swallowing it', async () => {
    // A 403 here means the secrets do not match — a deployment error someone must
    // see, not a transient failure to paper over.
    const vertical = new VerticalClient({
      platformSecret: 'wrong',
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'not a platform call' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    const withVertical = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
    });

    const res = await withVertical.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        tenantId: t1,
        scopeId: scopeId.parse(ulid()),
        owner: '01JZ00000000000000000000OW',
        slug: 'acme',
        name: 'Acme AB',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('still requires an actor', async () => {
    const res = await app.request('/verticals/fsm/instances', {
      method: 'POST',
      body: JSON.stringify({ tenantId: t1, scopeId: s1, owner: 'x', slug: 'a', name: 'A' }),
    });
    expect(res.status).toBe(401);
  });

  // -- #424 case 2: transient vertical failures retry instead of one-shot failing ----

  const flakyVertical = (failures: number, failStatus = 503) => {
    let calls = 0;
    const vertical = new VerticalClient({
      platformSecret: 'shhh',
      fetch: (async () => {
        calls++;
        if (calls <= failures) {
          return new Response('script settings still propagating', { status: failStatus });
        }
        return new Response(
          JSON.stringify({ tenantId: t1, scopeId: s1, owner: '01JZ00000000000000000000OW' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });
    return { vertical, calls: () => calls };
  };

  const installBody = () =>
    JSON.stringify({
      tenantId: t1,
      scopeId: scopeId.parse(ulid()),
      owner: '01JZ00000000000000000000OW',
      slug: 'acme',
      name: 'Acme AB',
    });

  it('rides out a transient 5xx from the vertical: the retry converges to 201', async () => {
    // The binding-attach → script-settings propagation race: the vertical 503s once,
    // then succeeds. Idempotent at the far end (K-31), so the endpoint retries rather
    // than surfacing a one-shot failure the operator must manually re-run.
    const { vertical, calls } = flakyVertical(1);
    const api = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
      provisionRetryDelaysMs: [1, 1],
    });
    const res = await api.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: installBody(),
    });
    expect(res.status).toBe(201);
    expect(calls()).toBe(2);
  });

  it('an honest refusal (4xx) is never retried — the real message surfaces immediately', async () => {
    const { vertical, calls } = flakyVertical(99, 403);
    const api = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
      provisionRetryDelaysMs: [1, 1],
    });
    const res = await api.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: installBody(),
    });
    expect(res.status).toBe(403);
    expect(calls()).toBe(1);
  });

  it('exhausted retries surface the LAST error, verbatim body included', async () => {
    const { vertical, calls } = flakyVertical(99, 503);
    const api = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: { fsm: vertical },
      provisionRetryDelaysMs: [1],
    });
    const res = await api.request('/verticals/fsm/instances', {
      method: 'POST',
      headers: auth,
      body: installBody(),
    });
    expect(res.status).toBe(503);
    expect(calls()).toBe(2);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('script settings still propagating');
  });
});

/**
 * The vertical + version registry surface (#31; orchestration.md §5.6). Drives the
 * built HostAdmin methods over HTTP: register → publish (pending) → admit → promote
 * through the digest-diff checkpoint → bind a scope. The interesting property is that
 * the two human checkpoints fire at promotion, and a non-admitted version is unbindable.
 */
describe('control-plane API — vertical registry', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const sc = scopeId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const json = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: auth });

  // Two versions of one vertical: v2 changes the permission surface, v1 does not.
  const v1 = ulid();
  const v2 = ulid();
  const version = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    verticalSlug: 'fsm',
    version: id.slice(-6),
    manifestDigest: 'man-1',
    permissionDigest: 'perm-1',
    migrationDigest: 'mig-1',
    deploymentRef: null,
    ...over,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-reg-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    await json('/tenants', 'POST', { id: t1, slug: 'acme', name: 'Acme' });
    await json('/scopes', 'POST', { tenantId: t1, scopeId: sc, slug: 'main', vertical: 'fsm' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers a vertical and lists it', async () => {
    const res = await json('/verticals', 'POST', { slug: 'fsm', name: 'Field Service', source: 'builtin' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: 'fsm', name: 'Field Service', source: 'builtin' });
    expect((await (await get('/verticals')).json()).entries).toEqual([
      expect.objectContaining({ slug: 'fsm' }),
    ]);
  });

  it('publishes a version pending — a push is not a deploy', async () => {
    const res = await json('/verticals/fsm/versions', 'POST', version(v1));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: v1, admission: 'pending', deploymentRef: null });
  });

  it('refuses a version whose body slug contradicts the path', async () => {
    const res = await json('/verticals/other/versions', 'POST', version(ulid()));
    expect(res.status).toBe(400);
  });

  it('refuses to publish under an unregistered vertical (404)', async () => {
    const res = await json('/verticals/ghost/versions', 'POST', version(ulid(), { verticalSlug: 'ghost' }));
    expect(res.status).toBe(404);
  });

  it('admits a version', async () => {
    const res = await json(`/verticals/fsm/versions/${v1}/admit`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: v1, admission: 'admitted' });
  });

  it('promotes the first version to prod with no acknowledgement needed', async () => {
    // Nothing to diff against on a first promotion — the gate is about change.
    const res = await json('/verticals/fsm/channels/prod/promote', 'POST', { versionId: v1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel: 'prod', versionId: v1 });
  });

  it('refuses a non-admitted version at both bind and promote', async () => {
    await json('/verticals/fsm/versions', 'POST', version(v2, { permissionDigest: 'perm-2' }));
    // v2 is still pending.
    expect((await json('/verticals/fsm/channels/prod/promote', 'POST', { versionId: v2 })).status).toBe(409);
    expect((await json(`/tenants/${t1}/scopes/${sc}/version`, 'POST', { versionId: v2 })).status).toBe(409);
  });

  it('fires the permission checkpoint: promotion refuses a changed digest without acknowledgement', async () => {
    await json(`/verticals/fsm/versions/${v2}/admit`, 'POST');
    // v2's permission digest differs from v1 (the current prod version) → refused.
    expect((await json('/verticals/fsm/channels/prod/promote', 'POST', { versionId: v2 })).status).toBe(409);
    // Acknowledged → promotes.
    const ok = await json('/verticals/fsm/channels/prod/promote', 'POST', {
      versionId: v2,
      acknowledge: { permissionChange: true },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ channel: 'prod', versionId: v2 });
  });

  it('binds an admitted version to a scope', async () => {
    const res = await json(`/tenants/${t1}/scopes/${sc}/version`, 'POST', { versionId: v2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: sc, verticalVersionId: v2 });
  });

  it('introspection resolves the scope’s BOUND version, not the prod channel (#220)', async () => {
    // `sc` is now bound to v2. A scope's data DO lives in the deployment of the version
    // it is bound to (each push is a separate WfP script + DO namespace) — so the Data
    // view must reach the BOUND-version deployment, keyed by `verticalVersionId`, and
    // must NOT fall through to the prod-channel resolver.
    const calls: string[] = [];
    const boundClient = {
      listScopeTables: async (s: string) => {
        calls.push(`bound:${s}`);
        return [{ name: 'widget', rowCount: 0, system: false }];
      },
    } as unknown as VerticalClient;
    const prodClient = {
      listScopeTables: async () => {
        calls.push('prod');
        return [];
      },
    } as unknown as VerticalClient;

    const delegated = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      resolveVertical: async () => prodClient, // prod-channel fallback — must NOT be used
      resolveVerticalVersion: async (slug, versionId) => {
        calls.push(`resolve:${slug}:${versionId}`);
        return boundClient;
      },
    });

    const res = await delegated.request(`/tenants/${t1}/scopes/${sc}/tables`, { headers: auth });
    expect(await res.json()).toEqual([{ name: 'widget', rowCount: 0, system: false }]);
    // The bound-version resolver was consulted with v2's id and its client used; the
    // prod-channel resolver was never called.
    expect(calls).toEqual([`resolve:fsm:${v2}`, `bound:${sc}`]);
  });

  it('rejects a fresh pending version, and admitting it afterward conflicts', async () => {
    const v3 = ulid();
    await json('/verticals/fsm/versions', 'POST', version(v3));
    expect((await json(`/verticals/fsm/versions/${v3}/reject`, 'POST', { note: 'no' })).status).toBe(200);
    expect((await json(`/verticals/fsm/versions/${v3}/admit`, 'POST')).status).toBe(409);
  });

  // The permission registry read (D-39, #336) — the dashboard's Permissions tab consumes it.
  it('serves the declared permission registry from a version’s retained manifest', async () => {
    const v4 = ulid();
    const registry = {
      permissions: [{ key: 'fsm:job-create', description: 'Open a job', declaredBy: ['fsm'] }],
      roles: [{ key: 'agent', permissions: ['fsm:job-create'], source: 'vertical' }],
      entityGrants: [{ entityType: 'job', permissions: ['fsm:job-create'] }],
    };
    const manifestJson = JSON.stringify({
      version: v4.slice(-6),
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry,
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
    });
    await json('/verticals/fsm/versions', 'POST', version(v4, { manifestJson }));
    const res = await get(`/verticals/fsm/versions/${v4}/registry`);
    expect(res.status).toBe(200);
    // The manifest round-trips through Zod (entityGrants defaults etc.), so match on shape.
    expect(await res.json()).toEqual({ registry });
  });

  it('returns a null registry for a version that retained no manifest (pre-#286)', async () => {
    // v1 was published from the bare `version()` fixture — no manifestJson.
    const res = await get(`/verticals/fsm/versions/${v1}/registry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registry: null });
  });

  it('maps the bound-scope delete refusal to a 409 naming the count — not a bare 500', async () => {
    // `sc` is still bound to fsm. The refusal message carries the blast radius and
    // the way out (delete or rebind), so it must survive mapError instead of
    // collapsing into the generic "internal error" (the console's 2026-08-03 shape).
    const refused = await json('/verticals/fsm', 'DELETE');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/still backs 1 scope\(s\) — delete or rebind/);
    // A vertical backing no scopes deletes cleanly through the same route.
    await json('/verticals', 'POST', { slug: 'unbound', name: 'Unbound', source: 'builtin' });
    const ok = await json('/verticals/unbound', 'DELETE');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ slug: 'unbound', deleted: true });
  });
});

/**
 * The deploy seam (self-serve-deploy.md) — `substrat push` uploads a built bundle,
 * the endpoint validates the sandbox contract, forwards to an injected uploader, and
 * records a PENDING version. The uploader is faked here; the real one calls the WfP
 * dispatch API in apps/control-plane.
 */
describe('control-plane API — deploy', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const deployed: {
    ref: string;
    bundle: {
      doClasses: string[];
      entry: string;
      modules: unknown[];
      bindings: { type: string; name: string; id?: string }[];
      compatibilityFlags: string[];
    };
  }[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-deploy-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async (ref, bundle) => {
        deployed.push({ ref, bundle: bundle as never });
      },
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (over: Record<string, unknown> = {}) => ({
    version: '0.1.0',
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: ['ScopeDO'],
    bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
    digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
    registry: { permissions: [], roles: [], entityGrants: [] },
    ...over,
  });
  function form(m: Record<string, unknown>, entryName = 'worker.js', body = 'export default {}') {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(m));
    fd.set(entryName, new Blob([body], { type: 'application/javascript+module' }), entryName);
    return fd;
  }
  const push = (slug: string, fd: FormData) =>
    app.request(`/verticals/${slug}/deploy`, { method: 'POST', headers: auth, body: fd });

  it('uploads a bundle, registers the vertical, and records a pending version', async () => {
    const res = await push('fsm', form(manifest()));
    expect(res.status).toBe(201);
    const version = await res.json();
    expect(version).toMatchObject({ verticalSlug: 'fsm', version: '0.1.0', admission: 'pending' });
    // deploymentRef is the dispatch script name: slug-<lowercased versionId>, CF-valid.
    expect(version.deploymentRef).toBe(`fsm-${version.id.toLowerCase()}`);
    expect(deployed.at(-1)!.ref).toBe(version.deploymentRef);
    expect(deployed.at(-1)!.bundle.doClasses).toEqual(['ScopeDO']);
    expect(deployed.at(-1)!.bundle.modules).toHaveLength(1);
    const verticals = (await (await app.request('/verticals', { headers: auth })).json()).entries;
    expect(verticals).toContainEqual(expect.objectContaining({ slug: 'fsm', source: 'cli' }));
  });

  it('forwards compatibility flags to the uploader (nodejs_compat must survive)', async () => {
    const res = await push('flagsdemo', form(manifest({ compatibilityFlags: ['nodejs_compat'] })));
    expect(res.status).toBe(201);
    expect(deployed.at(-1)!.bundle.compatibilityFlags).toEqual(['nodejs_compat']);
  });

  /**
   * Static assets (#340). The bytes are inert and public, so they are accepted; their
   * content-address is a dedup key shared by the whole dispatch namespace, so it is
   * verified. Everything below is that one distinction, exercised.
   */
  describe('static assets', () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    /** A form carrying modules AND `asset:`-prefixed parts, with honest hashes by default. */
    async function formWithAssets(
      files: { path: string; body: string; contentType?: string }[],
      over: Record<string, unknown> = {},
      corrupt?: (rows: { path: string; hash: string; size: number; contentType: string }[]) => void,
    ): Promise<FormData> {
      const rows = [];
      for (const f of files) {
        rows.push({
          path: f.path,
          hash: await assetHash(bytes(f.body), f.path),
          size: bytes(f.body).byteLength,
          contentType: f.contentType ?? 'text/html; charset=utf-8',
        });
      }
      corrupt?.(rows);
      const fd = form(manifest({ assets: { ...over, files: rows } }));
      for (const f of files) {
        const part = `asset:${f.path}`;
        fd.set(part, new Blob([f.body], { type: f.contentType ?? 'text/html; charset=utf-8' }), part);
      }
      return fd;
    }

    it('splits asset parts from module parts and forwards the verified bytes', async () => {
      const res = await push(
        'assetdemo',
        await formWithAssets(
          [
            { path: '/index.html', body: '<!doctype html>' },
            { path: '/assets/app.js', body: 'console.log(1)', contentType: 'text/javascript' },
          ],
          { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
        ),
      );
      expect(res.status).toBe(201);
      const bundle = deployed.at(-1)!.bundle as unknown as {
        modules: unknown[];
        assets: { notFoundHandling: string; runWorkerFirst: string[]; files: { path: string; content?: Uint8Array }[] };
      };
      // The worker module is still exactly one — an asset part never enters the code path.
      expect(bundle.modules).toHaveLength(1);
      expect(bundle.assets.files.map((f) => f.path).sort()).toEqual(['/assets/app.js', '/index.html']);
      expect(bundle.assets.notFoundHandling).toBe('single-page-application');
      expect(bundle.assets.runWorkerFirst).toEqual(['/api/*']);
      const index = bundle.assets.files.find((f) => f.path === '/index.html')!;
      expect(new TextDecoder().decode(index.content!)).toBe('<!doctype html>');
    });

    it('REFUSES bytes that do not match their declared hash — the dedup key is namespace-wide', async () => {
      // The attack this closes: store content under a hash it does not have, and a DIFFERENT
      // vertical whose asset legitimately hashes there could serve these bytes instead.
      const fd = await formWithAssets([{ path: '/index.html', body: '<!doctype html>' }], {}, (rows) => {
        rows[0]!.hash = 'f'.repeat(32);
      });
      const res = await push('poisondemo', fd);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/does not match its declared content hash/);
    });

    it('refuses a declared size the bytes do not have', async () => {
      const fd = await formWithAssets([{ path: '/index.html', body: 'abc' }], {}, (rows) => {
        rows[0]!.size = 999;
      });
      expect((await push('sizedemo', fd)).status).toBe(400);
    });

    it('refuses a manifest entry with no uploaded part, and a part in no manifest', async () => {
      const missing = form(
        manifest({ assets: { files: [{ path: '/gone.html', hash: 'a'.repeat(32), size: 1, contentType: 'text/html' }] } }),
      );
      expect((await push('missingdemo', missing)).status).toBe(400);

      const extra = await formWithAssets([{ path: '/index.html', body: 'x' }]);
      extra.set('asset:/stowaway.js', new Blob(['x'], { type: 'text/javascript' }), 'asset:/stowaway.js');
      const res = await push('extrademo', extra);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/absent from the manifest/);
    });

    it('a vertical that declares no assets forwards no assets block', async () => {
      expect((await push('plaindemo', form(manifest()))).status).toBe(201);
      expect((deployed.at(-1)!.bundle as { assets?: unknown }).assets).toBeUndefined();
    });
  });

  it('carries a pushed vertical’s declared envSpec into the registry', async () => {
    const envSpec = [
      { key: 'API_TOKEN', description: 'Upstream API credential', secret: true, required: true },
      { key: 'PUBLIC_ORIGIN', description: 'The public URL', required: false, secret: false },
    ];
    const res = await push('cfgdemo', form(manifest({ envSpec })));
    expect(res.status).toBe(201);
    // The registry now carries the spec — a defaulted, validated round-trip — so the
    // dashboard renders a config form for this pushed vertical exactly like a builtin.
    const registered = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'cfgdemo');
    expect(registered?.envSpec).toBeDefined();
    expect(registered?.envSpec?.map((s) => s.key)).toEqual(['API_TOKEN', 'PUBLIC_ORIGIN']);
    expect(registered?.envSpec?.find((s) => s.key === 'API_TOKEN')?.secret).toBe(true);
  });

  it('carries declared surfaces to the registry, and warns when a bound surface is dropped', async () => {
    // First push declares both surfaces — the registry carries them (K-26; the
    // dashboard's hostname-binding picker), like envSpec: metadata, never behavior.
    const surfaces = [
      { name: 'app', label: 'Egeryds CRM' },
      { name: 'eka', label: 'EKA — ekonomernas avstämning' },
    ];
    const first = await push('surfy', form(manifest({ surfaces })));
    expect(first.status).toBe(201);
    expect((await first.json()).warnings).toBeUndefined();
    const registered = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'surfy');
    expect(registered?.surfaces).toEqual(surfaces);

    // A hostname is bound to surface 'eka' of a scope running the vertical...
    const t = tenantId.parse(ulid());
    const sc = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'surfy-co', name: 'Surfy' });
    await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: 'surfy', jurisdiction: 'global' });
    await host.admin.activateScope(staff, t, sc);
    await host.admin.bindHostname(staff, {
      hostname: 'crm-eka.global.substrat.run', tenantId: t, scopeId: sc, surface: 'eka', region: null, canonical: true,
    });

    // ...so a version that stops declaring 'eka' pushes fine but NAMES the drift —
    // the URL keeps resolving (routing never keys on the declaration); the warning is
    // the same spirit as the permission-surface gate, advisory tier.
    const second = await push('surfy', form(manifest({ version: '0.1.1', surfaces: [surfaces[0]] })));
    expect(second.status).toBe(201);
    const body = await second.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('crm-eka.global.substrat.run');
    expect(body.warnings[0]).toContain(`surface 'eka'`);

    // A push declaring NOTHING opts out of the check — no warning, not a false one.
    const third = await push('surfy', form(manifest({ version: '0.1.2' })));
    expect((await third.json()).warnings).toBeUndefined();

    // A malformed declaration is refused at the Zod boundary, like any manifest field.
    expect((await push('surfy', form(manifest({ version: '0.1.3', surfaces: [{ name: '' }] })))).status).toBe(400);
  });

  /**
   * The workspace pin (package.json `substrat.tenant`) travels with the push and is
   * HONORED for staff: the claim lands prefixed and owned exactly as the equivalent
   * builder push — not platform-owned with the pin silently dropped. This is the
   * dual-hat footgun: staff auth is a superset tried first, so an account on the
   * staff roster can never push as a builder, and before this its pinned pushes
   * claimed slugs the pinned workspace could neither see nor self-serve.
   */
  describe('the pinned workspace on a staff push', () => {
    const sesamy = tenantId.parse(ulid());
    beforeAll(async () => {
      await host.admin.createTenant(staff, { id: sesamy, slug: 'sesamy', name: 'Sesamy' });
    });
    const pinned = (slug: string, pin: string, over: Record<string, unknown> = {}) => {
      const fd = form(manifest(over));
      fd.set('tenant', pin);
      return push(slug, fd);
    };

    it('claims the slug for the pinned tenant — prefixed, owned, self-admitting', async () => {
      const res = await pinned('crm', 'sesamy');
      expect(res.status).toBe(201);
      // Prefixed like a builder push, and ADMITTED: owned + unlisted is a PRIVATE
      // vertical, so the version self-admits instead of waiting for a staff vouch.
      expect(await res.json()).toMatchObject({ verticalSlug: 'sesamy/crm', admission: 'admitted' });
      const row = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'sesamy/crm');
      expect(row?.ownerTenant).toBe(sesamy);
    });

    it('accepts the tenant ID as the pin, and a re-push is idempotent', async () => {
      const res = await pinned('crm', sesamy, { version: '0.1.1' });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ verticalSlug: 'sesamy/crm', admission: 'admitted' });
    });

    it('keeps a legacy BARE row owned by the pin addressable as itself', async () => {
      // A hand-registered bare slug owned by the tenant (predates prefixed claims):
      // the pinned push lands on it rather than forking a prefixed twin.
      await app.request('/verticals', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'legacy', name: 'legacy', source: 'cli', ownerTenant: sesamy }),
      });
      const res = await pinned('legacy', 'sesamy');
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ verticalSlug: 'legacy', admission: 'admitted' });
    });

    it('404s an unknown workspace pin instead of guessing an owner', async () => {
      expect((await pinned('crm', 'nope')).status).toBe(404);
    });

    it('refuses to silently fork a platform-owned bare name; --allow-fork claims it prefixed (#388)', async () => {
      // 'fsm' was claimed platform-owned by the unpinned test above; the pinned push of
      // the same bare name would land under the tenant prefix — a SECOND same-named
      // lineage whose pushes the existing installs never see (the "two manyfolds" bug).
      // Refused with the fix named, before any upload...
      const before = deployed.length;
      const refused = await pinned('fsm', 'sesamy');
      expect(refused.status).toBe(409);
      const err = (await refused.json()).error;
      expect(err).toContain(`'sesamy/fsm'`);
      expect(err).toContain('--allow-fork');
      expect(deployed.length).toBe(before); // nothing reached the namespace
      // ...and landing only as a deliberate choice. No clobber either way: the bare
      // row stays platform-owned, the acked claim is prefixed.
      const fd = form(manifest());
      fd.set('tenant', 'sesamy');
      fd.set('allowFork', '1');
      const acked = await push('fsm', fd);
      expect(acked.status).toBe(201);
      expect(await acked.json()).toMatchObject({ verticalSlug: 'sesamy/fsm' });
      const bare = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'fsm');
      expect(bare?.ownerTenant).toBeNull();
    });

    it('an unpinned staff push keeps the platform-owned behavior, pending admission', async () => {
      const res = await push('plain', form(manifest()));
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ verticalSlug: 'plain', admission: 'pending' });
    });
  });

  it('surfaces an upload throw with no upstream status as a 502 with detail, not a blank 500', async () => {
    const boom = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async () => {
        throw new Error('WfP upload failed (500): namespace unreachable');
      },
    });
    const res = await boom.request('/verticals/boom/deploy', { method: 'POST', headers: auth, body: form(manifest()) });
    expect(res.status).toBe(502);
    expect((await res.json()).detail).toMatch(/WfP upload failed/);
  });

  it('answers a bad-bundle rejection (upstream 4xx) as a 422, not a 502 that reads as an outage (#307)', async () => {
    const boom = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async () => {
        // A module-top-level throw surfaces as CF 10021 inside a 400 — the builder's own
        // script, well-formed HTTP but refused.
        throw new DeployUploadError(400, "WfP upload failed (400): {\"errors\":[{\"code\":10021,\"message\":\"Uncaught Error: api catalog drift\"}]}");
      },
    });
    const res = await boom.request('/verticals/boom/deploy', { method: 'POST', headers: auth, body: form(manifest()) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('deploy rejected');
    expect(body.detail).toMatch(/api catalog drift/);
  });

  it('keeps an upstream 5xx (a platform failure) as a 502', async () => {
    const boom = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async () => {
        throw new DeployUploadError(503, 'WfP upload failed (503): upstream unavailable');
      },
    });
    const res = await boom.request('/verticals/boom/deploy', { method: 'POST', headers: auth, body: form(manifest()) });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('deploy upload failed');
  });

  it("forwards a vertical's own D1 binding (with its database id) to the uploader", async () => {
    const res = await push(
      'd1demo',
      form(
        manifest({
          bindings: [
            { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
            { type: 'd1', name: 'AUTH_DB', id: 'db-abc-123' },
          ],
        }),
      ),
    );
    expect(res.status).toBe(201);
    const forwarded = deployed.at(-1)!.bundle.bindings;
    expect(forwarded).toContainEqual({ type: 'd1', name: 'AUTH_DB', id: 'db-abc-123' });
  });

  it('refuses a CONTROL_PLANE binding — the sandbox contract (403)', async () => {
    const res = await push(
      'evil',
      form(manifest({ bindings: [{ type: 'durable_object_namespace', name: 'CONTROL_PLANE', class_name: 'ControlPlaneDO' }] })),
    );
    expect(res.status).toBe(403);
  });

  it('refuses a cross-script DO binding (403)', async () => {
    const res = await push(
      'evil',
      form(manifest({ bindings: [{ type: 'durable_object_namespace', name: 'X', class_name: 'ScopeDO', script_name: 'substrat-control-plane' }] })),
    );
    expect(res.status).toBe(403);
  });

  it('refuses a service binding to a platform worker (403)', async () => {
    const res = await push('evil', form(manifest({ bindings: [{ type: 'service', name: 'CP' }] })));
    expect(res.status).toBe(403);
  });

  it('400s when the entry module is not among the uploaded files', async () => {
    const res = await push('fsm', form(manifest({ entry: 'missing.js' })));
    expect(res.status).toBe(400);
  });

  it('501s when deploy is not configured on the control plane', async () => {
    const bare = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    const res = await bare.request('/verticals/fsm/deploy', { method: 'POST', headers: auth, body: form(manifest()) });
    expect(res.status).toBe(501);
  });
});

/**
 * Builder authz (builder-plane.md §4). A second principal kind — a tenant user — on
 * the same surface, confined to the vertical-management routes and to the verticals
 * their tenant OWNS (the `owner_tenant` column, Phase 1b). Staff remain a superset.
 *
 * The builder session is stubbed by a test header (the real reader — session → user →
 * selected tenant — wires in a later phase; this package holds no identity provider).
 * Staff requests carry `x-platform-actor`; builder requests carry only `x-test-builder`,
 * so staff auth is tried and declines before the builder path runs.
 */
describe('control-plane API — builder authz', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid()); // a builder tenant — owns 'acme-co/helpdesk'
  const other = tenantId.parse(ulid()); // a different builder tenant
  const acmeActor = platformActorId.parse(ulid());
  const otherActor = platformActorId.parse(ulid());
  // The tenant SLUGS form the vertical-id prefix (§5): a bare `helpdesk` push by acme
  // becomes `acme-co/helpdesk`, by other becomes `other-co/helpdesk` — no claim race.
  const acmeSlug = 'acme-co';
  const otherSlug = 'other-co';

  // The stub builder reader: a header names the acting tenant; its audited actor + slug
  // are derived. Anything else is not a builder session (null → fall through to 401).
  const BUILDER_HEADER = 'x-test-builder';
  const builders: Record<string, { actor: ReturnType<typeof platformActorId.parse>; slug: string }> = {
    [acme]: { actor: acmeActor, slug: acmeSlug },
    [other]: { actor: otherActor, slug: otherSlug },
  };
  const authenticateBuilder = (req: Request) => {
    const t = req.headers.get(BUILDER_HEADER);
    const b = t ? builders[t] : undefined;
    return b ? { actor: b.actor, tenantId: tenantId.parse(t!), tenantSlug: b.slug } : null;
  };

  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const asBuilder = (t: string) => ({ [BUILDER_HEADER]: t, 'content-type': 'application/json' });
  const call =
    (headers: Record<string, string>) => (path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  const staffReq = call(asStaff);
  const acmeReq = call(asBuilder(acme));
  const otherReq = call(asBuilder(other));

  const version = (id: string, slug: string, over: Record<string, unknown> = {}) => ({
    id,
    verticalSlug: slug,
    version: id.slice(-6),
    manifestDigest: 'm1',
    permissionDigest: 'p1',
    migrationDigest: 'g1',
    deploymentRef: null,
    ...over,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-builder-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder,
      deployVertical: async () => {},
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a request that is neither staff nor a builder, fail closed', async () => {
    const res = await app.request('/verticals', { headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('confines a builder to the vertical-management surface (default-deny)', async () => {
    // None of these are on the builder allowlist — a builder gets 403, not the data.
    // (`/hostnames` and the directory reads under `/scopes` moved ONTO the allowlist,
    // tenant-narrowed — their confinement is covered by their own describes below.)
    expect((await acmeReq('/tenants')).status).toBe(403);
    expect((await acmeReq('/admin-log')).status).toBe(403);
    expect((await acmeReq('/roles')).status).toBe(403);
    // Provisioning an instance is a scope action, not vertical management → 403.
    expect(
      (await acmeReq('/verticals/helpdesk/instances', 'POST', {
        tenantId: acme, scopeId: scopeId.parse(ulid()), owner: ulid(), slug: 'x', name: 'X',
      })).status,
    ).toBe(403);
    // A lineage crossing re-homes data under a different registry owner — staff-only (#389).
    expect(
      (await acmeReq(`/tenants/${acme}/scopes/${scopeId.parse(ulid())}/rebind-vertical`, 'POST', {
        vertical: 'acme-co/helpdesk',
      })).status,
    ).toBe(403);
  });

  it('narrows the directory reads to the builder’s own tenant (#424 CLI parity)', async () => {
    // The tenants exist in the directory (idempotent across the suite's shared host).
    await host.admin.createTenant(staff, { id: acme, slug: acmeSlug, name: 'Acme' }).catch(() => {});
    await host.admin.createTenant(staff, { id: other, slug: otherSlug, name: 'Other' }).catch(() => {});
    const sAcme = scopeId.parse(ulid());
    const sOther = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: acme, scopeId: sAcme, jurisdiction: 'global', vertical: `${acmeSlug}/helpdesk` });
    await host.provisionScope(staff, { tenantId: other, scopeId: sOther, jurisdiction: 'global', vertical: `${otherSlug}/helpdesk` });

    // GET /scopes: the tenant filter is FORCED to the caller's own — asking for the
    // other tenant's rows still returns only yours (never a 403-vs-data choice).
    const rows = ((await (await acmeReq(`/scopes?tenantId=${other}`)).json()) as { entries: Array<{ id: string }> }).entries;
    expect(rows.map((s) => s.id)).toEqual([sAcme]);

    // Per-scope reads: own tenant answers; a foreign tenant is hidden as 404 (K-3).
    expect((await acmeReq(`/tenants/${acme}/scopes/${sAcme}`)).status).toBe(200);
    expect((await acmeReq(`/tenants/${other}/scopes/${sOther}`)).status).toBe(404);
    expect((await acmeReq(`/tenants/${acme}/scopes/${sAcme}/health`)).status).toBe(200);
    expect((await acmeReq(`/tenants/${other}/scopes/${sOther}/health`)).status).toBe(404);
  });

  it('claims a bare slug under the tenant prefix, stamping the owner', async () => {
    // The builder pushes a BARE `helpdesk`; the id becomes `<tenantSlug>/helpdesk` (§5),
    // and the owner is stamped from the principal — a forged ownerTenant in the body loses.
    const res = await acmeReq('/verticals', 'POST', { slug: 'helpdesk', name: 'Helpdesk', source: 'cli' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: `${acmeSlug}/helpdesk`, ownerTenant: acme });
  });

  it('filters GET /verticals to the caller — a builder sees only what it owns', async () => {
    // Staff register a platform-owned vertical (bare, no prefix); acme must not see it.
    await staffReq('/verticals', 'POST', { slug: 'callout', name: 'Callout', source: 'builtin' });

    const mine = (await (await acmeReq('/verticals')).json()).entries;
    expect(mine.map((v: { slug: string }) => v.slug)).toEqual([`${acmeSlug}/helpdesk`]);
    expect((await (await otherReq('/verticals')).json()).entries).toEqual([]);
    // Staff see the whole registry, bare and prefixed alike.
    const all = (await (await staffReq('/verticals')).json()).entries;
    expect(all.map((v: { slug: string }) => v.slug).sort()).toEqual([`${acmeSlug}/helpdesk`, 'callout']);
  });

  it('gives each tenant its own namespace — two builders can hold the same bare name', async () => {
    // The prefix is the whole point (§2): `helpdesk` is really `<tenant>/helpdesk`, so
    // `other` claiming a bare `helpdesk` gets ITS OWN `other-co/helpdesk` — no claim race,
    // no collision with acme's.
    const res = await otherReq('/verticals', 'POST', { slug: 'helpdesk', name: 'Help', source: 'cli' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: `${otherSlug}/helpdesk`, ownerTenant: other });
    // And other still cannot see acme's — its list holds only its own helpdesk.
    expect((await (await otherReq('/verticals')).json()).entries.map((v: { slug: string }) => v.slug)).toEqual([
      `${otherSlug}/helpdesk`,
    ]);
  });

  const v1 = ulid();
  it('lets the owner publish a version, and reads it back', async () => {
    expect((await acmeReq('/verticals/helpdesk/versions', 'POST', version(v1, 'helpdesk'))).status).toBe(201);
    const versions = (await (await acmeReq('/verticals/helpdesk/versions')).json()).entries;
    expect(versions.map((v: { id: string }) => v.id)).toEqual([v1]);
  });

  it('keeps admission staff-only — a builder cannot admit its own version', async () => {
    // admit is not on the builder allowlist → 403 (the confinement, not an ownership check).
    expect((await acmeReq(`/verticals/helpdesk/versions/${v1}/admit`, 'POST')).status).toBe(403);
    // Staff admit it (model B: the human gate).
    expect((await staffReq(`/verticals/helpdesk/versions/${v1}/admit`, 'POST')).status).toBe(200);
  });

  it('keeps publish staff-only — a builder cannot list its own vertical; staff can (marketplace-publish.md §5)', async () => {
    const full = encodeURIComponent(`${acmeSlug}/helpdesk`);
    // /listing is not on the builder allowlist → 403 (the review gate, not an ownership check).
    expect((await acmeReq('/verticals/helpdesk/listing', 'POST', { listed: true })).status).toBe(403);
    // Staff publish it (by the full registry id) → listed.
    const res = await staffReq(`/verticals/${full}/listing`, 'POST', { listed: true });
    expect(res.status).toBe(200);
    expect((await res.json()).listed).toBe(true);
    // Staff can unpublish too.
    expect((await staffReq(`/verticals/${full}/listing`, 'POST', { listed: false })).status).toBe(200);
  });

  it('runs the whole publish flow — builder requests, staff reviews and lists (marketplace-publish.md §5)', async () => {
    const full = `${acmeSlug}/helpdesk`;
    const find = async () =>
      (await (await staffReq('/verticals')).json()).entries.find((v: { slug: string }) => v.slug === full) as {
        listed: boolean;
        publishRequestedAt?: string | null;
      };

    // The owner requests publishing its OWN vertical with a BARE slug (control plane forms the id).
    expect((await acmeReq('/verticals/helpdesk/publish-request', 'POST', {})).status).toBe(200);
    const requested = await find();
    expect(requested.publishRequestedAt).toBeTruthy();
    expect(requested.listed).toBe(false); // still private — awaiting review

    // The owner still cannot flip the listing itself (the staff review gate).
    expect((await acmeReq('/verticals/helpdesk/listing', 'POST', { listed: true })).status).toBe(403);

    // Staff reviews and lists it → published, and the pending request is resolved.
    const res = await staffReq(`/verticals/${encodeURIComponent(full)}/listing`, 'POST', { listed: true });
    expect(res.status).toBe(200);
    const after = await find();
    expect(after.listed).toBe(true);
    expect(after.publishRequestedAt).toBeFalsy();
  });

  it('retires dev/staging; prod of a LISTED vertical is a staff decision', async () => {
    // dev/staging are retired (#509) — a non-prod promote is refused with the previews pointer.
    const dev = await acmeReq('/verticals/helpdesk/channels/dev/promote', 'POST', { versionId: v1 });
    expect(dev.status).toBe(400);
    expect(((await dev.json()) as { error: string }).error).toMatch(/retired|preview/i);
    expect((await acmeReq('/verticals/helpdesk/channels/staging/promote', 'POST', { versionId: v1 })).status).toBe(400);
    // prod: helpdesk was LISTED by the publish-flow test above, so its audience is
    // every tenant and prod promotion is staff-only again — even for the owner. (A
    // PRIVATE vertical's owner self-serves prod; the deploy-path test below covers it.)
    expect((await acmeReq('/verticals/helpdesk/channels/prod/promote', 'POST', { versionId: v1 })).status).toBe(403);
    // Staff promote to prod — but by the FULL id, since staff address a vertical by its
    // real registry id, not a bare name (they have no tenant prefix to apply).
    expect((await staffReq(`/verticals/${encodeURIComponent(`${acmeSlug}/helpdesk`)}/channels/prod/promote`, 'POST', { versionId: v1 })).status).toBe(200);
    // `other` promoting a bare `helpdesk` addresses ITS OWN (empty) `other-co/helpdesk`,
    // never acme's — acme's version id isn't in that namespace, so it cannot be promoted.
    expect((await otherReq('/verticals/helpdesk/channels/prod/promote', 'POST', { versionId: v1 })).status).toBeGreaterThanOrEqual(400);
  });

  it('claims a slug through the deploy/push path too, each tenant in its own namespace', async () => {
    const fd = () => {
      const f = new FormData();
      f.set('manifest', JSON.stringify({
        version: '0.1.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
        registry: { permissions: [], roles: [], entityGrants: [] },
      }));
      f.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
      return f;
    };
    // Both push a BARE `reports`; each claims its own prefixed id (no collision, §2).
    const acmePush = await app.request('/verticals/reports/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd() });
    expect(acmePush.status).toBe(201);
    expect(await acmePush.json()).toMatchObject({ verticalSlug: `${acmeSlug}/reports` });
    // `other`'s claim of the same bare name is NOT refused as a fork (#388): acme's
    // `reports` is private and foreign, so the fork guard must not see it — refusing
    // here would leak its existence. Existence-hiding bounds the guard.
    const otherPush = await app.request('/verticals/reports/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: other }, body: fd() });
    expect(otherPush.status).toBe(201);
    expect(await otherPush.json()).toMatchObject({ verticalSlug: `${otherSlug}/reports` });

    // Each list holds only that tenant's own verticals — prefixed, isolated.
    expect((await (await acmeReq('/verticals')).json()).entries.map((v: { slug: string }) => v.slug).sort()).toEqual([
      `${acmeSlug}/helpdesk`, `${acmeSlug}/reports`,
    ]);
    expect((await (await otherReq('/verticals')).json()).entries.map((v: { slug: string }) => v.slug).sort()).toEqual([
      `${otherSlug}/helpdesk`, `${otherSlug}/reports`,
    ]);
  });

  it('honors or refuses a builder push’s workspace pin — never silently redirects it', async () => {
    const fd = (pin?: string, version = '0.1.0') => {
      const f = new FormData();
      f.set('manifest', JSON.stringify({
        version, entry: 'worker.js', compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
        registry: { permissions: [], roles: [], entityGrants: [] },
      }));
      f.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
      if (pin) f.set('tenant', pin);
      return f;
    };
    // Pinned to a DIFFERENT workspace: refused with the mismatch named — the builder's
    // workspace is fixed by auth, and intent is never silently reinterpreted.
    const wrong = await app.request('/verticals/pinned/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd(otherSlug) });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toMatch(/pinned to workspace/);
    // Pinned to its OWN workspace (slug or id): unchanged claim under its prefix.
    const right = await app.request('/verticals/pinned/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd(acmeSlug) });
    expect(right.status).toBe(201);
    expect(await right.json()).toMatchObject({ verticalSlug: `${acmeSlug}/pinned` });
    const byId = await app.request('/verticals/pinned/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd(acme, '0.1.1') });
    expect(byId.status).toBe(201);
  });

  it('lets a builder address its own vertical by FULL id too — effectiveSlug is idempotent', async () => {
    // The deploy response returns the full registry id (`verticalSlug`); follow-up
    // calls (the CLI's same-run --promote) send it back. That must not double-prefix.
    const versions = (await (await acmeReq(`/verticals/${encodeURIComponent(`${acmeSlug}/helpdesk`)}/versions`)).json()).entries;
    expect(versions.map((v: { id: string }) => v.id)).toEqual([v1]);
  });

  it("a PRIVATE vertical is the owner's end to end: push lands admitted, prod self-serves, history reads back", async () => {
    // `reports` was pushed through the deploy path above and never listed, so its
    // version self-admitted (builder-plane.md §4-revised) — no staff step anywhere.
    const [pushed] = (await (await acmeReq('/verticals/reports/versions')).json()).entries;
    expect(pushed.admission).toBe('admitted');

    // The owner promotes prod itself — merge-to-main's shape (`push --promote prod`).
    expect((await acmeReq('/verticals/reports/channels/prod/promote', 'POST', { versionId: pushed.id })).status).toBe(200);

    // The go-live timeline reads back, owner-narrowed: acme sees its promotion...
    const history = (await (await acmeReq('/verticals/reports/channels/prod/history')).json()).entries;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ versionId: pushed.id, fromVersionId: null });
    // ...`other`'s own `reports` timeline is its own (empty), and a slug it does not
    // own 404s indistinguishably from an absent one.
    expect((await (await otherReq('/verticals/reports/channels/prod/history')).json()).entries).toEqual([]);
    expect((await otherReq('/verticals/nonexistent/channels/prod/history')).status).toBe(404);
  });

  it('refuses a builder push that would fork a VISIBLE same-named lineage; --allow-fork lands it (#388)', async () => {
    const fd = (allowFork = false) => {
      const f = new FormData();
      f.set('manifest', JSON.stringify({
        version: '0.1.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
        registry: { permissions: [], roles: [], entityGrants: [] },
      }));
      f.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
      if (allowFork) f.set('allowFork', '1');
      return f;
    };
    // Bare `callout` is platform-owned (staff registered it above) — a name acme CAN
    // see. Acme's bare push would claim `acme-co/callout`, a second lineage whose
    // pushes the existing installs never see → refused with the fix named.
    const refused = await app.request('/verticals/callout/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd() });
    expect(refused.status).toBe(409);
    const err = (await refused.json()).error;
    expect(err).toContain(`'${acmeSlug}/callout'`);
    expect(err).toContain('platform-owned');
    expect(err).toContain('--allow-fork');
    // Acknowledged, the same push claims the prefixed id as a deliberate second lineage.
    const acked = await app.request('/verticals/callout/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd(true) });
    expect(acked.status).toBe(201);
    expect(await acked.json()).toMatchObject({ verticalSlug: `${acmeSlug}/callout` });
  });

  /**
   * The hostname map, tenant-narrowed (K-26 multi-surface exposure): a builder binds
   * a URL to a surface of ITS OWN scopes — the self-serve the dashboard already
   * performs for it over the service token, now first-class for the CLI. The
   * narrowing is the whole test: a foreign tenant's rows must be invisible (list),
   * unnameable (bind), and indistinguishable from absent (status/unbind → 404).
   */
  describe('the hostname map, tenant-narrowed', () => {
    const acmeScope = scopeId.parse(ulid());
    const otherScope = scopeId.parse(ulid());

    beforeAll(async () => {
      // Directory rows for both builder tenants and one scope each, staff-provisioned
      // (provisioning stays outside the builder allowlist — only bindings are self-serve).
      for (const [t, slug, scope] of [
        [acme, acmeSlug, acmeScope],
        [other, otherSlug, otherScope],
      ] as const) {
        await staffReq('/tenants', 'POST', { id: t, slug, name: slug });
        await staffReq('/scopes', 'POST', {
          tenantId: t, scopeId: scope, slug: `${slug}-crm`, name: 'CRM', vertical: 'helpdesk', jurisdiction: 'global',
        });
      }
      await staffReq('/hostnames', 'POST', {
        hostname: `other-crm.global.substrat.run`, tenantId: other, scopeId: otherScope, surface: 'app', canonical: true,
      });
    });

    it('lets a builder bind a surface hostname on its own scope — and only its own tenant', async () => {
      const res = await acmeReq('/hostnames', 'POST', {
        hostname: 'acme-crm-eka.global.substrat.run', tenantId: acme, scopeId: acmeScope, surface: 'eka', canonical: true,
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ surface: 'eka', status: 'pending', canonical: true });
      // ...and may activate it (a platform hostname rides the wildcard cert).
      expect(
        (await acmeReq('/hostnames/acme-crm-eka.global.substrat.run/status', 'PATCH', { status: 'active' })).status,
      ).toBe(200);
      // Naming another tenant in the body is refused outright.
      expect(
        (await acmeReq('/hostnames', 'POST', {
          hostname: 'squat.global.substrat.run', tenantId: other, scopeId: otherScope, surface: 'app',
        })).status,
      ).toBe(403);
      // The region column is an EU-residency claim (K-30) — never builder-suppliable.
      expect(
        (await acmeReq('/hostnames', 'POST', {
          hostname: 'eu-claim.example.com', tenantId: acme, scopeId: acmeScope, surface: 'app', region: 'eu',
        })).status,
      ).toBe(403);
    });

    it('narrows a builder’s list to its own tenant — a foreign tenantId in the query loses silently', async () => {
      const mine = (await (await acmeReq('/hostnames')).json()).entries;
      expect(mine.map((h: { hostname: string }) => h.hostname)).toEqual(['acme-crm-eka.global.substrat.run']);
      const widened = (await (await acmeReq(`/hostnames?tenantId=${other}`)).json()).entries;
      expect(widened.map((h: { hostname: string }) => h.hostname)).toEqual(['acme-crm-eka.global.substrat.run']);
      // Staff still see the whole map.
      const all = (await (await staffReq('/hostnames')).json()).entries;
      expect(all.map((h: { hostname: string }) => h.hostname).sort()).toEqual([
        'acme-crm-eka.global.substrat.run', 'other-crm.global.substrat.run',
      ]);
    });

    it('404s a builder acting on a foreign hostname — indistinguishable from absent', async () => {
      expect(
        (await acmeReq('/hostnames/other-crm.global.substrat.run/status', 'PATCH', { status: 'failed' })).status,
      ).toBe(404);
      expect((await acmeReq('/hostnames/other-crm.global.substrat.run', 'DELETE')).status).toBe(404);
      // The foreign row survived untouched.
      const rows = (await (await staffReq(`/hostnames?scopeId=${otherScope}`)).json()).entries;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hostname: 'other-crm.global.substrat.run', status: 'pending' });
      // Its own binding it may unbind.
      expect((await acmeReq('/hostnames/acme-crm-eka.global.substrat.run', 'DELETE')).status).toBe(200);
      expect((await (await acmeReq('/hostnames')).json()).entries).toEqual([]);
    });
  });
});

describe('control-plane API — observability proxy', () => {
  let dir: string;
  let host: SqliteScopeHost;

  const staff = platformActorId.parse(ulid());
  const builderTenant = tenantId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  // A stub reader that records what the routes hand it — the proxy's job is the Zod
  // boundary + the staff gate, not Cloudflare's answers.
  const seen: { metrics: unknown[]; logs: unknown[] } = { metrics: [], logs: [] };
  const reader = {
    serviceMetrics: async (input: unknown) => {
      seen.metrics.push(input);
      return [
        {
          service: 'substrat-router',
          namespace: null,
          requests: 120,
          errors: 3,
          subrequests: 240,
          cpuTimeP50: 900,
          cpuTimeP99: 4200,
        },
      ];
    },
    recentLogs: async (input: unknown) => {
      seen.logs.push(input);
      return [];
    },
  };

  const BUILDER_HEADER = 'x-test-builder';
  const appWith = (observability?: typeof reader) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: (req: Request) =>
        req.headers.get(BUILDER_HEADER)
          ? { actor: platformActorId.parse(ulid()), tenantId: builderTenant, tenantSlug: 'builder-co' }
          : null,
      observability,
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-obs-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('501s when no reader is configured — absent capability, not a crash', async () => {
    const app = appWith(undefined);
    expect((await app.request('/observability/metrics', { headers: asStaff })).status).toBe(501);
    expect((await app.request('/observability/logs', { headers: asStaff })).status).toBe(501);
  });

  it('proxies metrics for staff, with the hours window parsed and bounded', async () => {
    const app = appWith(reader);
    const res = await app.request('/observability/metrics?hours=48', { headers: asStaff });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ service: 'substrat-router', requests: 120 }]);
    expect(seen.metrics.at(-1)).toEqual({ hours: 48 });

    // Defaulted when omitted; refused (400 at the Zod boundary) when out of range.
    await app.request('/observability/metrics', { headers: asStaff });
    expect(seen.metrics.at(-1)).toEqual({ hours: 24 });
    expect((await app.request('/observability/metrics?hours=9000', { headers: asStaff })).status).toBe(400);
  });

  it('proxies logs with service/level narrowing passed through', async () => {
    const app = appWith(reader);
    const res = await app.request('/observability/logs?service=my-worker&level=error&limit=50', {
      headers: asStaff,
    });
    expect(res.status).toBe(200);
    expect(seen.logs.at(-1)).toEqual({ services: ['my-worker'], level: 'error', hours: 1, limit: 50 });
  });

  it('accepts a repeated service param — one query over a whole set of deployed units', async () => {
    const app = appWith(reader);
    const res = await app.request('/observability/logs?service=my-worker&service=my-worker-v2', { headers: asStaff });
    expect(res.status).toBe(200);
    expect(seen.logs.at(-1)).toEqual({ services: ['my-worker', 'my-worker-v2'], hours: 1, limit: 100 });

    // No service at all is the fleet view — narrowing absent, not empty.
    await app.request('/observability/logs', { headers: asStaff });
    expect(seen.logs.at(-1)).toEqual({ hours: 1, limit: 100 });

    // Bounded like every input: each extra service is another backend query.
    const many = Array.from({ length: 21 }, (_, i) => `service=w${i}`).join('&');
    expect((await app.request(`/observability/logs?${many}`, { headers: asStaff })).status).toBe(400);
  });

  it('passes the message search term to the reader as a contract field, bounded like every input', async () => {
    const app = appWith(reader);
    await app.request(`/observability/logs?service=my-worker&search=${encodeURIComponent('TypeError: undefined')}`, {
      headers: asStaff,
    });
    expect(seen.logs.at(-1)).toEqual({ services: ['my-worker'], search: 'TypeError: undefined', hours: 1, limit: 100 });
    expect(
      (await app.request(`/observability/logs?service=my-worker&search=${'x'.repeat(201)}`, { headers: asStaff })).status,
    ).toBe(400);
  });

  it('refuses a builder — staff-only until owner-narrowing exists (default-deny)', async () => {
    // The observability routes are NOT in BUILDER_ROUTES: without narrowing to owned
    // scripts, a builder reading fleet metrics would see every tenant's traffic.
    const app = appWith(reader);
    const asBuilder = { [BUILDER_HEADER]: builderTenant, 'content-type': 'application/json' };
    expect((await app.request('/observability/metrics', { headers: asBuilder })).status).toBe(403);
    expect((await app.request('/observability/logs', { headers: asBuilder })).status).toBe(403);
  });
});

/**
 * #321: a LEGACY scope's data must survive a prod promote. Pre-#286, a legacy scope
 * (servingRef null) routes through its bound version's per-version dispatch script; a
 * naive promote rebinds it to the incoming version's fresh, empty script and strands the
 * data (`0001-init` re-runs against empty storage). This drives the WHOLE promote path
 * against a STATEFUL dispatch fake — per-script scope storage the export/restore verbs
 * actually read and write. That fidelity is exactly what the no-op deploy fake lacked,
 * and the reason the bug shipped green: a promote must ADOPT a legacy scope onto the
 * stable serving script (moving its bytes) before it advances the version pointer.
 */
describe('control-plane API — adopt-on-promote (#321)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };

  // A Durable Object namespace, modelled: data belongs to the SCRIPT it was written
  // under. ref → (scopeId → dump tables). Rerouting a scope to a different script that
  // was never written its bytes resolves EMPTY — the whole hazard #321 is about.
  let scripts: Map<string, Map<string, ScopeDumpTable[]>>;
  let failServeRef: string | null; // when set, an upload to THIS ref throws (a flaky serve)
  // Every upload this suite performs, so a test can assert what a PROMOTE re-sent (#340).
  const uploads: { ref: string; assets?: { files: { path: string; hash: string; content?: Uint8Array }[] } }[] = [];

  const ensure = (ref: string) => {
    let s = scripts.get(ref);
    if (!s) scripts.set(ref, (s = new Map()));
    return s;
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
    dir = mkdtempSync(join(tmpdir(), 'cp-adopt-'));
    scripts = new Map();
    failServeRef = null;
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      // A clean-room environment derives its `--<tag>` hostname from the tenant-app
      // convention, which needs a platform base domain (the follow-on-promote test below
      // creates one). Harmless to the legacy-scope tests, which mint no previews.
      platformBaseDomains: ['global.substrat.run'],
      deployVertical: async (ref, bundle) => {
        if (ref === failServeRef) throw new Error('WfP upload failed (500): namespace unreachable');
        uploads.push({ ref, assets: bundle.assets as never });
        ensure(ref); // registering a script creates its (empty) storage namespace
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

  const manifest = (over: Record<string, unknown> = {}) => ({
    version: '0.1.0',
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: ['ScopeDO'],
    bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
    digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
    registry: { permissions: [], roles: [], entityGrants: [] },
    ...over,
  });
  // A staff push pinned to a tenant registers `<tenantSlug>/crm` owned + auto-admitted
  // (private) — a dispatch-backed vertical, so `deploymentRef` is set and the serve path
  // engages. The pin isolates each test on its own prefixed vertical.
  const push = (pinTenantSlug: string, m: Record<string, unknown>) => {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(m));
    fd.set('tenant', pinTenantSlug);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    return app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
  };
  const promote = (slug: string, versionId: string) =>
    app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
  const customers: ScopeDumpTable = {
    name: 'customers',
    ddl: 'CREATE TABLE customers(name TEXT)',
    columns: ['name'],
    rows: [['Acme AB']],
  };

  // Set up a legacy scope: push v1, provision the scope BEFORE any prod promote (so it is
  // born servingRef-null), bind it to v1, and seed its data into v1's per-version script.
  const legacyScope = async (pin: string) => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: pin, name: pin });
    const v1res = await push(pin, manifest({ version: '0.1.0' }));
    const v1 = await v1res.json();
    const slug: string = v1.verticalSlug;
    const sc = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
    await host.admin.activateScope(staff, t, sc);
    await host.admin.bindScopeVersion(staff, t, sc, v1.id);
    ensure(deploymentRefFor(slug, v1.id)).set(sc, [customers]); // its data lives on v1's script
    return { t, slug, sc, v1: v1.id as string };
  };

  it('keeps a legacy scope’s data across a prod promote — adopted onto the serving script, not stranded', async () => {
    const { t, slug, sc, v1 } = await legacyScope('adopt-co');
    // Sanity: the scope is legacy (no serving ref yet) and its data is on v1's script.
    expect((await host.admin.getScopeRecord(staff, t, sc))?.servingRef ?? null).toBeNull();

    const v2res = await push('adopt-co', manifest({ version: '0.2.0' }));
    const v2 = (await v2res.json()).id as string;
    const res = await promote(slug, v2);
    expect(res.status).toBe(200);

    const stable = stableDeploymentRefFor(slug);
    const rec = await host.admin.getScopeRecord(staff, t, sc);
    // The invariant: the scope now routes to the STABLE serving script, not v2's
    // per-version archive script, and its version pointer advanced.
    expect(rec?.servingRef).toBe(stable);
    expect(rec?.verticalVersionId).toBe(v2);
    // The bytes followed: the serving script holds the row; the fresh v2 archive script
    // was NEVER written the scope (that is what stranding would have looked like).
    expect(scripts.get(stable)?.get(sc)).toEqual([customers]);
    expect(scripts.get(deploymentRefFor(slug, v2))?.has(sc)).toBeFalsy();
    // v1's script is left intact (data-first: the adopt copies, it does not move).
    expect(scripts.get(deploymentRefFor(slug, v1))?.get(sc)).toEqual([customers]);
  });

  it('a promote re-attaches the version’s static assets from the retained manifest (#340)', async () => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'asset-co', name: 'asset-co' });
    const body = '<!doctype html>';
    const files = [
      {
        path: '/index.html',
        hash: await assetHash(new TextEncoder().encode(body), '/index.html'),
        size: body.length,
        contentType: 'text/html; charset=utf-8',
      },
    ];
    const fd = new FormData();
    fd.set(
      'manifest',
      JSON.stringify(manifest({ assets: { notFoundHandling: 'single-page-application', files } })),
    );
    fd.set('tenant', 'asset-co');
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    fd.set('asset:/index.html', new Blob([body], { type: 'text/html; charset=utf-8' }), 'asset:/index.html');
    const pushed = await (await app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd })).json();

    const before = uploads.length;
    expect((await promote(pushed.verticalSlug, pushed.id)).status).toBe(200);

    // The serving upload carries the SAME content addresses the push did — read back from
    // the retained manifest, with no bytes. That is what lets the runtime's namespace-wide
    // dedup re-attach the files instead of the promote silently serving a code-only script.
    const serve = uploads.slice(before).find((u) => u.ref === stableDeploymentRefFor(pushed.verticalSlug));
    expect(serve?.assets?.files.map((f) => f.path)).toEqual(['/index.html']);
    expect(serve!.assets!.files[0]!.hash).toBe(files[0]!.hash);
    expect(serve!.assets!.files[0]!.content).toBeUndefined();
  });

  it('a failed in-place serve strands nothing — the retry adopts the still-intact data', async () => {
    const { t, slug, sc, v1 } = await legacyScope('retry-co');
    const v2 = (await (await push('retry-co', manifest({ version: '0.2.0' }))).json()).id as string;
    const stable = stableDeploymentRefFor(slug);

    // First promote: the serve upload fails.
    failServeRef = stable;
    const failed = await promote(slug, v2);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toMatch(/in-place serve failed/);
    // Nothing was rebound or stranded: the scope is untouched, its data still on v1.
    const mid = await host.admin.getScopeRecord(staff, t, sc);
    expect(mid?.servingRef ?? null).toBeNull();
    expect(mid?.verticalVersionId).toBe(v1);
    expect(scripts.get(deploymentRefFor(slug, v1))?.get(sc)).toEqual([customers]);
    expect(scripts.get(stable)?.get(sc)).toBeUndefined();

    // Retry: the serve succeeds and the still-intact data is adopted.
    failServeRef = null;
    const ok = await promote(slug, v2);
    expect(ok.status).toBe(200);
    const rec = await host.admin.getScopeRecord(staff, t, sc);
    expect(rec?.servingRef).toBe(stable);
    expect(rec?.verticalVersionId).toBe(v2);
    expect(scripts.get(stable)?.get(sc)).toEqual([customers]);
  });

  it('backfills every still-legacy scope of a vertical in one call (idempotent)', async () => {
    const { t, slug, sc } = await legacyScope('backfill-co');
    // A second legacy scope on the same vertical.
    const sc2 = scopeId.parse(ulid());
    const v1 = (await host.admin.getScopeRecord(staff, t, sc))!.verticalVersionId!;
    await host.provisionScope(staff, { tenantId: t, scopeId: sc2, vertical: slug });
    await host.admin.activateScope(staff, t, sc2);
    await host.admin.bindScopeVersion(staff, t, sc2, v1);
    ensure(deploymentRefFor(slug, v1)).set(sc2, [customers]);

    // Promote so a serving script exists, but adopt only the FIRST scope automatically by
    // pretending the second predates it: it is already active + legacy, so the vertical-
    // wide backfill must pick it up. (Both are adopted by the promote; re-running the
    // backfill must then be a no-op — the idempotency the runbook depends on.)
    const v2 = (await (await push('backfill-co', manifest({ version: '0.2.0' }))).json()).id as string;
    expect((await promote(slug, v2)).status).toBe(200);

    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/adopt-serving`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Both scopes are already on the serving script after the promote → all reported as
    // already-adopted, none freshly adopted. A second run never double-moves data.
    expect(body.adopted).toEqual([]);
    expect([...body.alreadyAdopted].sort()).toEqual([sc, sc2].sort());
    const stable = stableDeploymentRefFor(slug);
    expect(scripts.get(stable)?.get(sc)).toEqual([customers]);
    expect(scripts.get(stable)?.get(sc2)).toEqual([customers]);
  });

  it('reports prod’s SERVING version, not the promoted pointer, when an in-place serve fails (#321)', async () => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'serve-co', name: 'serve-co' });
    const v1 = await (await push('serve-co', manifest({ version: '0.1.0' }))).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200); // serving := v1

    const v2 = (await (await push('serve-co', manifest({ version: '0.2.0' }))).json()).id as string;
    failServeRef = stableDeploymentRefFor(slug); // the next in-place serve upload throws
    const failed = await promote(slug, v2);
    expect(failed.status).toBe(502); // pointer moved to v2, but the serve failed
    failServeRef = null;

    const channels = (await (
      await app.request(`/verticals/${encodeURIComponent(slug)}/channels`, { headers: auth })
    ).json()).entries;
    const prod = channels.find((c: { channel: string }) => c.channel === 'prod');
    // The channel pointer is honestly recorded (it IS an audited promotion decision)...
    expect(prod.versionId).toBe(v2);
    // ...but the serving truth is surfaced alongside it: the scopes still run v1. This is
    // what stops `versions` reporting v2 as deployed when it is not.
    expect(prod.servingVersionId).toBe(v1.id);
  });

  // The dashboard's "test environment" (auto-follow main): a pinned clean-room preview with a
  // custom domain. It must track prod without any per-push action — the load-bearing claim the
  // Environments UI is built on. Because a clean-room scope carries NO `forkedFrom`, the
  // adopt-on-promote cascade advances it to each newly promoted version exactly like a real
  // install; a FORK, being a point-in-time copy, is deliberately left pinned by a promote.
  it('auto-follows prod across a promote for a clean-room env, but leaves a fork pinned', async () => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'follow-co', name: 'follow-co' });
    const v1res = await (await push('follow-co', manifest({ version: '0.1.0' }))).json();
    const slug = v1res.verticalSlug as string;
    const v1 = v1res.id as string;
    expect((await promote(slug, v1)).status).toBe(200); // serving := v1, a stable script exists

    // A real install scope with data — the fork's source (and proof the env is isolated from it).
    const prod = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: prod, vertical: slug });
    await host.admin.activateScope(staff, t, prod);
    await host.admin.bindScopeVersion(staff, t, prod, v1);
    ensure(stableDeploymentRefFor(slug)).set(prod, [customers]); // lives on the serving script

    // The clean-room environment the UI creates: empty, pinned until deleted (ttlHours null).
    const envRes = await app.request(`/verticals/${encodeURIComponent(slug)}/previews`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'test', versionId: v1, empty: true, ttlHours: null }),
    });
    expect(envRes.status).toBe(201);
    const env = (await envRes.json()) as { scopeId: string };
    // Born on v1 — the version it was pinned to at creation.
    expect((await host.admin.getScopeRecord(staff, t, env.scopeId))?.verticalVersionId).toBe(v1);

    // Ship main: push v2, promote to prod.
    const v2 = (await (await push('follow-co', manifest({ version: '0.2.0' }))).json()).id as string;
    expect((await promote(slug, v2)).status).toBe(200);

    // The guarantee: the clean-room env advanced to v2 with no per-push action (auto-follow main),
    // exactly like the real install alongside it.
    expect((await host.admin.getScopeRecord(staff, t, env.scopeId))?.verticalVersionId).toBe(v2);
    expect((await host.admin.getScopeRecord(staff, t, prod))?.verticalVersionId).toBe(v2);
  });

  // #389 — the cross-lineage rebind: retire one lineage's install onto another, data carried.
  // Rides this describe's stateful dispatch fake: bytes belong to the script they were
  // written under, so a rebind that flips routing without moving them reads empty.
  const rebind = (t: string, sc: string, body: Record<string, unknown>) =>
    app.request(`/tenants/${t}/scopes/${encodeURIComponent(sc)}/rebind-vertical`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // A second lineage under its own pin, promoted so a serving script exists.
  const targetLineage = async (pin: string, m: Record<string, unknown>) => {
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: pin, name: pin });
    const v = await (await push(pin, manifest(m))).json();
    expect((await promote(v.verticalSlug, v.id)).status).toBe(200);
    return { slug: v.verticalSlug as string, versionId: v.id as string };
  };

  it('rebinds a scope onto a different lineage — data moved, directory crossed, source intact (#389)', async () => {
    const { t, slug, sc } = await legacyScope('rebind-src');
    const v2 = (await (await push('rebind-src', manifest({ version: '0.2.0' }))).json()).id as string;
    expect((await promote(slug, v2)).status).toBe(200); // adopt onto the source serving script
    const target = await targetLineage('rebind-dst', { version: '0.1.0' }); // same migration digest g1

    const res = await rebind(t, sc, { vertical: target.slug });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.servingRef).toBe(stableDeploymentRefFor(target.slug));

    // The directory crossed in one act: slug, version pointer, and routing ref.
    const rec = await host.admin.getScopeRecord(staff, t, sc);
    expect(rec?.vertical).toBe(target.slug);
    expect(rec?.verticalVersionId).toBe(target.versionId);
    expect(rec?.servingRef).toBe(stableDeploymentRefFor(target.slug));
    // The bytes followed — and the source script's copy is intact (it is the backout).
    expect(scripts.get(stableDeploymentRefFor(target.slug))?.get(sc)).toEqual([customers]);
    expect(scripts.get(stableDeploymentRefFor(slug))?.get(sc)).toEqual([customers]);

    // Idempotent: a re-run reports already-bound and moves nothing.
    const again = await (await rebind(t, sc, { vertical: target.slug })).json();
    expect(again.alreadyBound).toBe(true);
  });

  it('refuses a lineage crossing whose migration surfaces differ, unless acknowledged (#389)', async () => {
    const { t, slug, sc } = await legacyScope('gate-src');
    const v2 = (await (await push('gate-src', manifest({ version: '0.2.0' }))).json()).id as string;
    expect((await promote(slug, v2)).status).toBe(200);
    // The target lineage's migration history diverges (g2 ≠ g1).
    const target = await targetLineage('gate-dst', {
      version: '0.1.0',
      digests: { manifest: 'm1', permission: 'p1', migration: 'g2' },
    });

    const refused = await rebind(t, sc, { vertical: target.slug });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/migration surfaces differ/);
    // Nothing moved, nothing crossed.
    const rec = await host.admin.getScopeRecord(staff, t, sc);
    expect(rec?.vertical).toBe(slug);
    expect(scripts.get(stableDeploymentRefFor(target.slug))?.has(sc)).toBeFalsy();

    // The operator read both diffs: the acknowledged crossing proceeds.
    const acked = await rebind(t, sc, { vertical: target.slug, ackMigrations: true });
    expect(acked.status).toBe(200);
    expect((await host.admin.getScopeRecord(staff, t, sc))?.vertical).toBe(target.slug);
    expect(scripts.get(stableDeploymentRefFor(target.slug))?.get(sc)).toEqual([customers]);
  });

  it('rebinds directory-only on abandonData — no bytes carried, gate bypassed, source intact (#389)', async () => {
    // The prod shape this exists for: a scope whose source script predates
    // `/internal/export` (#236) and so cannot be dumped at all. The scope stays
    // LEGACY (servingRef null) — the carried path would have to reach its
    // per-version script; abandonData never touches it.
    const { t, slug, sc, v1 } = await legacyScope('abandon-src');
    // The target's migration history diverges (g2 ≠ g1): with no data carried the
    // frontier gate has nothing to protect, so no acknowledgement is demanded.
    const target = await targetLineage('abandon-dst', {
      version: '0.1.0',
      digests: { manifest: 'm1', permission: 'p1', migration: 'g2' },
    });

    const res = await rebind(t, sc, { vertical: target.slug, abandonData: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dataAbandoned).toBe(true);
    expect(body.servingRef).toBe(stableDeploymentRefFor(target.slug));

    // The directory crossed in one act — slug, version pointer, routing ref.
    const rec = await host.admin.getScopeRecord(staff, t, sc);
    expect(rec?.vertical).toBe(target.slug);
    expect(rec?.verticalVersionId).toBe(target.versionId);
    expect(rec?.servingRef).toBe(stableDeploymentRefFor(target.slug));
    // NO bytes moved: the target script was never written the scope (it will be
    // re-provisioned), and the source script's copy is intact — it is the backout.
    expect(scripts.get(stableDeploymentRefFor(target.slug))?.has(sc)).toBeFalsy();
    expect(scripts.get(deploymentRefFor(slug, v1))?.get(sc)).toEqual([customers]);
  });

  it('refuses a rebind to a lineage with no serving script, and an unknown scope (#389)', async () => {
    const { t, sc } = await legacyScope('norefuse-src');
    // Pushed but never promoted: no serving script to receive the data.
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: 'norefuse-dst', name: 'norefuse-dst' });
    const bare = await (await push('norefuse-dst', manifest({ version: '0.1.0' }))).json();
    const res = await rebind(t, sc, { vertical: bare.verticalSlug });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no serving script/);

    expect((await rebind(t, scopeId.parse(ulid()), { vertical: bare.verticalSlug })).status).toBe(404);
  });
});

/**
 * Custom-hostname issuance end-to-end (#305, §4.7). A stub provisioner stands in for
 * Cloudflare for SaaS — the control plane's job is to drive it: a custom bind kicks off
 * `create` (→ `verifying` + DNS records), a platform mint rides the wildcard (→ `active`
 * with no CF call), `/verify` re-polls, and a bare public suffix is refused at the door.
 */
describe('control-plane API — custom-hostname issuance (#305)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const json = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

  // A scripted provisioner: `create` hands back verifying + a TXT record; `check` reads
  // whatever the current test told it to return next.
  let nextCheck: { customHostnameId: string; status: 'verifying' | 'active' | 'failed'; note: string | null; records: never[] };
  const removed: string[] = [];
  const provisioner = {
    create: async (hostname: string) => ({
      customHostnameId: 'ch_' + hostname,
      status: 'verifying' as const,
      note: null,
      records: [
        { type: 'hostname' as const, name: hostname, value: 'edge.substrat.run', status: 'pending' },
        { type: 'txt' as const, name: '_cf.' + hostname, value: 'tok', status: null },
      ],
    }),
    check: async () => nextCheck,
    remove: async (id: string) => {
      removed.push(id);
    },
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-api-issuance-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      provisionHostname: provisioner as never,
      platformBaseDomains: ['substrat.run'],
    });
    await host.admin.createTenant(staff, { id: t1, slug: 'acme-co', name: 'Acme Co' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'demo-vert' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a platform mint rides the wildcard — straight to active, no CF call', async () => {
    const res = await json('/hostnames', 'POST', {
      hostname: 'acme-app.substrat.run',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
      canonical: true,
    });
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.customHostnameId).toBeNull();
    expect(await host.admin.resolveHostname('acme-app.substrat.run')).toMatchObject({ scopeId: s1 });
  });

  it('a custom bind kicks off issuance — verifying, with DNS records to publish', async () => {
    const res = await json('/hostnames', 'POST', {
      hostname: 'legal.acme.com',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
      canonical: true,
    });
    const body = await res.json();
    expect(body.status).toBe('verifying');
    expect(body.customHostnameId).toBe('ch_legal.acme.com');
    const cname = body.validationRecords.find((r: { type: string }) => r.type === 'hostname');
    const txt = body.validationRecords.find((r: { type: string }) => r.type === 'txt');
    expect(cname).toBeTruthy();
    expect(txt).toMatchObject({ name: '_cf.legal.acme.com' });
    // Not servable until it goes active.
    expect(await host.admin.resolveHostname('legal.acme.com')).toBeUndefined();
  });

  it('/verify re-polls and flips to active when Cloudflare validates', async () => {
    nextCheck = { customHostnameId: 'ch_legal.acme.com', status: 'active', note: null, records: [] };
    const res = await json('/hostnames/legal.acme.com/verify', 'POST');
    expect((await res.json()).status).toBe('active');
    expect(await host.admin.resolveHostname('legal.acme.com')).toMatchObject({ scopeId: s1 });
  });

  it('/verify heals a platform mint stranded in custom issuance (#423) — active, relics gone, CF object released', async () => {
    // Recreate the #423 shape below the API: a mint bound while PLATFORM_BASE_DOMAINS
    // was unset walked custom issuance — CF id + publish-these-records, stuck `verifying`.
    await host.admin.bindHostname(staff, {
      hostname: 'stranded.global.substrat.run',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
      region: null,
      canonical: false,
    });
    await host.admin.setHostnameIssuance(staff, 'stranded.global.substrat.run', {
      status: 'verifying',
      note: null,
      customHostnameId: 'ch_relic',
      validationRecords: [
        { type: 'hostname', name: 'stranded.global.substrat.run', value: 'cname.substrat.run', status: 'active' },
      ],
    });
    expect(await host.admin.resolveHostname('stranded.global.substrat.run')).toBeUndefined();

    const res = await json('/hostnames/stranded.global.substrat.run/verify', 'POST');
    const body = await res.json();
    // Active with no relics: nothing left for any surface to render as publish-this-DNS
    // guidance on the platform's own zone.
    expect(body).toMatchObject({ status: 'active', customHostnameId: null, validationRecords: [] });
    expect(removed).toContain('ch_relic'); // the mistaken CF object is released
    expect(await host.admin.resolveHostname('stranded.global.substrat.run')).toMatchObject({ scopeId: s1 });
  });

  it('refuses a bare public suffix at the door (D-35 registrable-suffix guard)', async () => {
    const res = await json('/hostnames', 'POST', {
      hostname: 'co.uk',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/public suffix/);
  });

  it('unbinding a custom hostname releases the Cloudflare object', async () => {
    await json('/hostnames/legal.acme.com', 'DELETE');
    expect(removed).toContain('ch_legal.acme.com');
  });
});

/**
 * M1 of multi-scope-manyfold.md: a builder adds a SIBLING scope (a new "site") to an app
 * its own tenant already runs. Authorization is the parent app scope — its existence under
 * the tenant proves the entitlement, and the sibling INHERITS its vertical, so a caller can
 * never name a vertical it does not already run. Tenant-narrowed for a builder (K-3 existence
 * hiding); the same provision → materialize-instance → activate sequence createApp runs.
 */
describe('control-plane API — add a sibling scope (M1)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid()); // the builder's tenant — runs 'demo-vert'
  const other = tenantId.parse(ulid()); // a different tenant
  const acmeActor = platformActorId.parse(ulid());
  const parentScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());

  const BUILDER_HEADER = 'x-test-builder';
  const authenticateBuilder = (req: Request) =>
    req.headers.get(BUILDER_HEADER) === acme
      ? { actor: acmeActor, tenantId: acme, tenantSlug: 'acme-co' }
      : null;

  let captured: { scopeId?: string; owner?: string; slug?: string; entitlements?: EntitlementGrant[] } | undefined;
  const fakeVertical = {
    provisionInstance: async (input: { scopeId: string; owner: string; slug: string; entitlements?: EntitlementGrant[] }) => {
      captured = input;
      return { tenantId: acme, scopeId: input.scopeId, owner };
    },
  } as unknown as VerticalClient;

  const asBuilder = { [BUILDER_HEADER]: acme, 'content-type': 'application/json' };
  const post = (headers: Record<string, string>, tenant: string, body: unknown) =>
    app.request(`/tenants/${tenant}/scopes`, { method: 'POST', headers, body: JSON.stringify(body) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-sibling-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder,
      verticals: { 'demo-vert': fakeVertical },
    });
    await host.admin.createTenant(staff, { id: acme, slug: 'acme-co', name: 'Acme' });
    // The parent app scope — what proves acme runs 'demo-vert' and donates the vertical.
    await host.provisionScope(staff, { tenantId: acme, scopeId: parentScope, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, acme, parentScope);
    await host.admin.grantEntitlement(staff, acme, 'demo-vert', { quota: 5, plan: 'pro' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a builder adds a sibling site under its own tenant — inherits the parent vertical, activates, seats the owner', async () => {
    const sibling = scopeId.parse(ulid());
    const res = await post(asBuilder, acme, {
      scopeId: sibling,
      parentScopeId: parentScope,
      owner,
      slug: 'second-site',
      name: 'Second Site',
    });
    expect(res.status).toBe(201);
    const record = (await res.json()) as { status: string; vertical: string | null };
    expect(record.status).toBe('active'); // provision → materialize → activate, all server-side
    expect(record.vertical).toBe('demo-vert'); // inherited from the parent, not caller-named
    // The vertical materialized the instance with the seated owner and the platform-gathered plan.
    expect(captured).toMatchObject({ scopeId: sibling, owner, slug: 'second-site' });
    expect(captured?.entitlements?.find((e) => e.entitlementKey === 'demo-vert')).toMatchObject({
      quota: 5,
      plan: 'pro',
    });
  });

  it('hides another tenant behind a 404 — a builder cannot add a scope outside its own tenant', async () => {
    const res = await post(asBuilder, other, {
      scopeId: scopeId.parse(ulid()),
      parentScopeId: parentScope,
      owner,
      slug: 'x',
      name: 'X',
    });
    expect(res.status).toBe(404);
  });

  it('404s when the parent app scope does not exist under the tenant', async () => {
    const res = await post(asBuilder, acme, {
      scopeId: scopeId.parse(ulid()),
      parentScopeId: scopeId.parse(ulid()), // no such scope
      owner,
      slug: 'x',
      name: 'X',
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Staff tenant-pin slug resolution (#417). Registry rows for pushed verticals are keyed
 * `<tenantSlug>/<slug>`; a BUILDER gets the prefix from auth, but a staff/service caller
 * (the CLI over a service token, the dashboard's tenant-narrowed seam) used to query the
 * bare slug and miss. The `x-substrat-tenant` header now names the workspace such a
 * caller acts for, and every route that ADDRESSES a vertical resolves through one helper
 * that forms the prefix exactly as a pinned push does — existence-guarded, so a pin never
 * redirects a read to a lineage that is not there.
 */
describe('control-plane API — staff tenant-pin resolution (#417)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const mqk = tenantId.parse(ulid());
  const mqkSlug = 'authhero-mqk5x7';
  const full = `${mqkSlug}/authhero-console`;

  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const pinned = (pin: string) => ({ ...asStaff, 'x-substrat-tenant': pin });
  const req = (headers: Record<string, string>) => (path: string, method = 'GET', body?: unknown) =>
    app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const staffReq = req(asStaff);

  const version = (id: string, slug: string) => ({
    id,
    verticalSlug: slug,
    version: id.slice(-6),
    manifestDigest: 'm1',
    permissionDigest: 'p1',
    migrationDigest: 'g1',
    deploymentRef: null,
  });

  const v1 = ulid();
  const legacyV = ulid();
  const calloutV = ulid();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-pin-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });

    // The workspace, its prefixed vertical (as a pinned push lands it), and one version.
    expect((await staffReq('/tenants', 'POST', { id: mqk, slug: mqkSlug, name: 'AuthHero' })).status).toBe(201);
    await staffReq('/verticals', 'POST', { slug: full, name: 'Console', source: 'cli', ownerTenant: mqk });
    const enc = encodeURIComponent(full);
    expect((await staffReq(`/verticals/${enc}/versions`, 'POST', version(v1, full))).status).toBe(201);
    expect((await staffReq(`/verticals/${enc}/versions/${v1}/admit`, 'POST')).status).toBe(200);

    // A bare slug the same workspace owns (a staff hand-registration predating prefixes).
    expect((await staffReq('/verticals', 'POST', { slug: 'legacy', name: 'Legacy', source: 'cli', ownerTenant: mqk })).status).toBe(201);
    expect((await staffReq('/verticals/legacy/versions', 'POST', version(legacyV, 'legacy'))).status).toBe(201);

    // A platform-owned bare vertical — a pin must never redirect reads away from it.
    expect((await staffReq('/verticals', 'POST', { slug: 'callout', name: 'Callout', source: 'builtin' })).status).toBe(201);
    expect((await staffReq('/verticals/callout/versions', 'POST', version(calloutV, 'callout'))).status).toBe(201);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a bare slug to the pinned workspace’s prefixed registry id — the #417 repro', async () => {
    // Unpinned staff read of the bare slug: nothing (the pre-#417 symptom, unchanged).
    expect((await (await staffReq('/verticals/authhero-console/versions')).json()).entries).toEqual([]);
    // Pinned by workspace SLUG: the bare slug reaches `<tenantSlug>/<slug>`.
    const bySlug = (await (await req(pinned(mqkSlug))('/verticals/authhero-console/versions')).json()).entries;
    expect(bySlug.map((v: { id: string }) => v.id)).toEqual([v1]);
    // Pinned by workspace ID (the CLI accepts either).
    const byId = (await (await req(pinned(mqk))('/verticals/authhero-console/versions')).json()).entries;
    expect(byId.map((v: { id: string }) => v.id)).toEqual([v1]);
    // Idempotent: the full id under a pin is not double-prefixed.
    const fullRead = (await (await req(pinned(mqkSlug))(`/verticals/${encodeURIComponent(full)}/versions`)).json()).entries;
    expect(fullRead.map((v: { id: string }) => v.id)).toEqual([v1]);
  });

  it('promotes and reads channels by bare slug under a pin — the whole manage surface resolves', async () => {
    const p = req(pinned(mqkSlug));
    expect((await p('/verticals/authhero-console/channels/prod/promote', 'POST', { versionId: v1 })).status).toBe(200);
    const channels = (await (await p('/verticals/authhero-console/channels')).json()).entries;
    expect(channels).toMatchObject([{ channel: 'prod', versionId: v1 }]);
    // The pointer landed on the PREFIXED lineage — the unpinned full id reads the same rows.
    const direct = (await (await staffReq(`/verticals/${encodeURIComponent(full)}/channels`)).json()).entries;
    expect(direct).toMatchObject([{ channel: 'prod', versionId: v1 }]);
    const history = (await (await p('/verticals/authhero-console/channels/prod/history')).json()).entries;
    expect(history.length).toBe(1);
  });

  it('keeps a bare slug the pinned workspace owns addressable as itself (back-compat)', async () => {
    const rows = (await (await req(pinned(mqkSlug))('/verticals/legacy/versions')).json()).entries;
    expect(rows.map((v: { id: string }) => v.id)).toEqual([legacyV]);
  });

  it('never redirects to a lineage that is not there — platform bare slugs and unknown pins are unchanged', async () => {
    // `callout` is platform-owned and `authhero-mqk5x7/callout` does not exist: the pin is
    // irrelevant here (e.g. a stored default workspace) and must not break the read.
    const callout = (await (await req(pinned(mqkSlug))('/verticals/callout/versions')).json()).entries;
    expect(callout.map((v: { id: string }) => v.id)).toEqual([calloutV]);
    // An unknown pin resolves to the raw slug — today's behavior, not a 404.
    const unknown = (await (await req(pinned('no-such-workspace'))('/verticals/callout/versions')).json()).entries;
    expect(unknown.map((v: { id: string }) => v.id)).toEqual([calloutV]);
  });
});
