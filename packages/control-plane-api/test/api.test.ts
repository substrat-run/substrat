import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { permissionKey, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
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

    const list = await (await req('/tenants')).json();
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

  // -- entitlements (§4.3) --------------------------------------------------

  it('grants, lists and revokes entitlements', async () => {
    expect(await (await req(`/tenants/${t1}/entitlements`)).json()).toEqual([]);

    const granted = await json(`/tenants/${t1}/entitlements/workorder`, 'PUT');
    expect(await granted.json()).toEqual(['workorder']);

    const revoked = await json(`/tenants/${t1}/entitlements/workorder`, 'DELETE');
    expect(await revoked.json()).toEqual([]);
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

    const all = await (await req('/scopes')).json();
    expect(all).toHaveLength(2);

    const mine = await (await req(`/scopes?tenantId=${t1}`)).json();
    expect(mine).toHaveLength(1);

    const housing = await (await req('/scopes?vertical=housing')).json();
    expect(housing.map((s: { id: string }) => s.id)).toEqual([s1]);

    // Repeatable status params — the console's All / Suspended / Archived tabs.
    const both = await (await req('/scopes?status=active&status=suspended')).json();
    expect(both).toHaveLength(2);
  });

  it('reads one scope record and fails closed on a cross-tenant pair (K-3)', async () => {
    expect((await req(`/tenants/${t1}/scopes/${s1}`)).status).toBe(200);
    // s1 exists — but not under t2. Indistinguishable from absent, on purpose.
    expect((await req(`/tenants/${t2}/scopes/${s1}`)).status).toBe(404);
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

  // -- roles (§4.5) ----------------------------------------------------------

  it('lists roles and filters by tenant and source', async () => {
    await host.admin.defineRole(platformActorId.parse(ulid()), t1, {
      key: 'site-manager',
      permissions: [permissionKey.parse('workorder:read')],
      source: 'vertical',
    });
    const roles = await (await req(`/roles?tenantId=${t1}`)).json();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ tenantId: t1, key: 'site-manager', source: 'vertical' });

    // An unknown source returns nothing rather than 400 — the console filters
    // over sources it has seen, and a typo is an empty list, not an error.
    expect(await (await req('/roles?source=nope')).json()).toEqual([]);
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
    const all = await (await req('/hostnames')).json();
    expect(all.map((h: { hostname: string }) => h.hostname)).toContain('acme.example.com');
    const forScope = await (await req(`/hostnames?scopeId=${s1}`)).json();
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
    const rows = await (await req(`/hostnames?scopeId=${s1}`)).json();
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
    expect(await (await get('/verticals')).json()).toEqual([
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
    const verticals = await (await app.request('/verticals', { headers: auth })).json();
    expect(verticals).toContainEqual(expect.objectContaining({ slug: 'fsm', source: 'cli' }));
  });

  it('forwards compatibility flags to the uploader (nodejs_compat must survive)', async () => {
    const res = await push('flagsdemo', form(manifest({ compatibilityFlags: ['nodejs_compat'] })));
    expect(res.status).toBe(201);
    expect(deployed.at(-1)!.bundle.compatibilityFlags).toEqual(['nodejs_compat']);
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

  it('surfaces an upload failure as a 502 with detail, not a blank 500', async () => {
    const boom = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async () => {
        throw new Error('WfP upload failed (400): compatibility flag nodejs_compat required');
      },
    });
    const res = await boom.request('/verticals/boom/deploy', { method: 'POST', headers: auth, body: form(manifest()) });
    expect(res.status).toBe(502);
    expect((await res.json()).detail).toMatch(/WfP upload failed/);
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
    expect((await acmeReq('/tenants')).status).toBe(403);
    expect((await acmeReq('/scopes')).status).toBe(403);
    expect((await acmeReq('/admin-log')).status).toBe(403);
    expect((await acmeReq('/hostnames')).status).toBe(403);
    // Provisioning an instance is a scope action, not vertical management → 403.
    expect(
      (await acmeReq('/verticals/helpdesk/instances', 'POST', {
        tenantId: acme, scopeId: scopeId.parse(ulid()), owner: ulid(), slug: 'x', name: 'X',
      })).status,
    ).toBe(403);
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

    const mine = await (await acmeReq('/verticals')).json();
    expect(mine.map((v: { slug: string }) => v.slug)).toEqual([`${acmeSlug}/helpdesk`]);
    expect(await (await otherReq('/verticals')).json()).toEqual([]);
    // Staff see the whole registry, bare and prefixed alike.
    const all = await (await staffReq('/verticals')).json();
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
    expect((await (await otherReq('/verticals')).json()).map((v: { slug: string }) => v.slug)).toEqual([
      `${otherSlug}/helpdesk`,
    ]);
  });

  const v1 = ulid();
  it('lets the owner publish a version, and reads it back', async () => {
    expect((await acmeReq('/verticals/helpdesk/versions', 'POST', version(v1, 'helpdesk'))).status).toBe(201);
    const versions = await (await acmeReq('/verticals/helpdesk/versions')).json();
    expect(versions.map((v: { id: string }) => v.id)).toEqual([v1]);
  });

  it('keeps admission staff-only — a builder cannot admit its own version', async () => {
    // admit is not on the builder allowlist → 403 (the confinement, not an ownership check).
    expect((await acmeReq(`/verticals/helpdesk/versions/${v1}/admit`, 'POST')).status).toBe(403);
    // Staff admit it (model B: the human gate).
    expect((await staffReq(`/verticals/helpdesk/versions/${v1}/admit`, 'POST')).status).toBe(200);
  });

  it('lets the owner self-serve non-prod, but keeps prod a staff decision', async () => {
    // dev/staging: the builder promotes its own admitted version.
    expect((await acmeReq('/verticals/helpdesk/channels/dev/promote', 'POST', { versionId: v1 })).status).toBe(200);
    expect((await acmeReq('/verticals/helpdesk/channels/staging/promote', 'POST', { versionId: v1 })).status).toBe(200);
    // prod: staff-only, even for the owner.
    expect((await acmeReq('/verticals/helpdesk/channels/prod/promote', 'POST', { versionId: v1 })).status).toBe(403);
    // Staff promote to prod — but by the FULL id, since staff address a vertical by its
    // real registry id, not a bare name (they have no tenant prefix to apply).
    expect((await staffReq(`/verticals/${encodeURIComponent(`${acmeSlug}/helpdesk`)}/channels/prod/promote`, 'POST', { versionId: v1 })).status).toBe(200);
    // `other` promoting a bare `helpdesk` addresses ITS OWN (empty) `other-co/helpdesk`,
    // never acme's — acme's version id isn't in that namespace, so it cannot be promoted.
    expect((await otherReq('/verticals/helpdesk/channels/dev/promote', 'POST', { versionId: v1 })).status).toBeGreaterThanOrEqual(400);
  });

  it('claims a slug through the deploy/push path too, each tenant in its own namespace', async () => {
    const fd = () => {
      const f = new FormData();
      f.set('manifest', JSON.stringify({
        version: '0.1.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
      }));
      f.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
      return f;
    };
    // Both push a BARE `reports`; each claims its own prefixed id (no collision, §2).
    const acmePush = await app.request('/verticals/reports/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: acme }, body: fd() });
    expect(acmePush.status).toBe(201);
    expect(await acmePush.json()).toMatchObject({ verticalSlug: `${acmeSlug}/reports` });
    const otherPush = await app.request('/verticals/reports/deploy', { method: 'POST', headers: { [BUILDER_HEADER]: other }, body: fd() });
    expect(otherPush.status).toBe(201);
    expect(await otherPush.json()).toMatchObject({ verticalSlug: `${otherSlug}/reports` });

    // Each list holds only that tenant's own verticals — prefixed, isolated.
    expect((await (await acmeReq('/verticals')).json()).map((v: { slug: string }) => v.slug).sort()).toEqual([
      `${acmeSlug}/helpdesk`, `${acmeSlug}/reports`,
    ]);
    expect((await (await otherReq('/verticals')).json()).map((v: { slug: string }) => v.slug).sort()).toEqual([
      `${otherSlug}/helpdesk`, `${otherSlug}/reports`,
    ]);
  });
});
