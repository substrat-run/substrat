import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * `GET /api/apps/:scopeId/processes` (#1744), driven through the worker with the same
 * seams as `app-requests.test.ts`: the plane behind the service binding is a recorder.
 *
 * What is under test is what this route adds to the replay: it takes the declaration
 * from the version the scope RUNS and hands it over, asks for the period and the one
 * before it, pins the tenant and scope, and turns each reason there is nothing to draw
 * into its own answer rather than an error.
 *
 * The original header, kept for the seams it explains:
 * `GET /api/apps/:scopeId/observability/requests/:kind` (#1746).
 *
 * Driven through the WORKER because the facts under test are what a route forwards and
 * what it refuses to: the facet filters and window go through, and the tenant and scope
 * come only from the session and the team's own app rows. The plane behind the service binding is a
 * recorder, so what is asserted is the request the dashboard makes on the team's behalf —
 * which is the whole tenant boundary at this hop: the tenant is pinned by the session,
 * the scope by the team's own app rows, and the id can only narrow what those two allow.
 * The plane's own half (parsing the filters, forcing the tenant) is in
 * `packages/control-plane-api/test/api.test.ts`.
 *
 * The seams the worker cannot run in Node are replaced the way `deployments-role-gate`
 * replaces them: `cloudflare:workers`, the Cloudflare host (a SQLite host stands in), and
 * session verification (the cookie IS the OIDC `sub`).
 */
const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule') return () => undefined;
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());


const LIFECYCLE = {
  field: 'state',
  initial: 'new',
  states: { new: { on: { 'acme/open': 'open' } }, open: { on: { 'acme/close': 'closed' } }, closed: { terminal: true } },
};

describe('the process map route (#1744)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  let asks: { path: string; body: Record<string, unknown> }[];
  let env: Record<string, unknown>;
  let plane: { bound: string | null; model: unknown; flow: number };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-processes-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    asks = [];
    plane = { bound: 'VERSION1', model: { entities: {}, lifecycles: { ticket: LIFECYCLE } }, flow: 200 };

    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'processes', name: 'Processes' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, {
      provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope,
    });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: 'acme/widgets', name: 'Widgets' });

    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '');
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path === `/tenants/${tenant}/scopes/${appScope}`) return Response.json({ verticalVersionId: plane.bound });
          if (path.endsWith('/versions') || path.endsWith('/channels') || path === '/scopes') {
            return Response.json({ entries: [], nextCursor: null });
          }
          if (path.endsWith('/versions/VERSION1/model')) return Response.json({ model: plane.model });
          if (path.endsWith('/lifecycle-flow')) {
            asks.push({ path, body: JSON.parse(String(init?.body)) });
            if (plane.flow !== 200) return Response.json({ error: 'no such route' }, { status: plane.flow });
            return Response.json({ observation: { events: 1, complete: true }, edges: [], states: [], funnel: { started: 0, reached: {} } });
          }
          return Response.json({ error: `unexpected ${path}` }, { status: 500 });
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (scope: string, query = '') =>
    app.request(`/api/apps/${scope}/processes${query}`, { headers: { cookie: 'sb_session=sub-owner' } }, env);

  it('replays the running version\'s lifecycle for the period and the one before it, tenant and scope pinned', async () => {
    const res = await get(appScope, `?period=24h&tenantId=${tenantId.parse(ulid())}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: string; lifecycle: unknown; unavailable: unknown; processes: unknown[] };
    expect(body).toMatchObject({ entity: 'ticket', lifecycle: LIFECYCLE, unavailable: null });
    expect(asks.map((a) => a.path)).toEqual([
      `/tenants/${tenant}/scopes/${appScope}/lifecycle-flow`,
      `/tenants/${tenant}/scopes/${appScope}/lifecycle-flow`,
    ]);
    const [current, previous] = asks.map((a) => a.body as { entityType: string; lifecycle: unknown; since: string; until: string });
    expect(current!.lifecycle).toEqual(LIFECYCLE);
    expect(current!.entityType).toBe('ticket');
    expect(Date.parse(current!.until) - Date.parse(current!.since)).toBe(24 * 3_600_000);
    // The two windows meet exactly.
    expect(previous!.until).toBe(current!.since);
  });

  it('says why there is nothing to draw, one reason per next step', async () => {
    plane.model = { entities: {} };
    expect(await (await get(appScope)).json()).toMatchObject({ unavailable: 'no-lifecycles', processes: [] });
    plane.model = { entities: {}, lifecycles: { ticket: LIFECYCLE } };
    plane.flow = 404;
    expect(await (await get(appScope)).json()).toMatchObject({ unavailable: 'not-yet-available', entity: 'ticket', lifecycle: LIFECYCLE });
    plane.flow = 502;
    expect(await (await get(appScope)).json()).toMatchObject({ unavailable: 'not-yet-available' });
  });

  it('refuses an unknown period or entity, and another team\'s app, before replaying anything', async () => {
    expect((await get(appScope, '?period=1y')).status).toBe(400);
    expect((await get(appScope, '?entity=nothing')).status).toBe(404);
    expect((await get(scopeId.parse(ulid()))).status).toBe(404);
    expect(asks).toHaveLength(0);
  });

  it('passes a plane failure that is not a missing route on as a failure', async () => {
    plane.flow = 500;
    expect((await get(appScope)).status).toBeGreaterThanOrEqual(500);
  });
});
