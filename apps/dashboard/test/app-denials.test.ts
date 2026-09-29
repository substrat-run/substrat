import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { DENIAL_LIMIT_MAX, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * `GET /api/apps/:scopeId/denials` (#1828), driven through the worker with the same seams
 * as `app-processes.test.ts`: the plane behind the service binding is a recorder. What the
 * route adds is the gate — the team's own app, the tenant pinned — and the input rules.
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



describe('the refusals route (#1828)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  let asks: URL[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-denials-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    asks = [];
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'denials', name: 'Denials' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: 'acme/widgets', name: 'Widgets' });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '');
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path === '/scopes') return Response.json({ entries: [], nextCursor: null });
          if (path.endsWith('/denials')) {
            asks.push(u);
            return Response.json([{ id: 'D1', permission: 'refunds:issue' }]);
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

  const get = (scope: string, query = '') => app.request(`/api/apps/${scope}/denials${query}`, { headers: { cookie: 'sb_session=sub-owner' } }, env);

  it('reads the app’s denial log, tenant and scope pinned, and hands back the page size', async () => {
    const res = await get(appScope, '?until=2026-09-29T12:00:00.000Z&limit=50');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [{ id: 'D1', permission: 'refunds:issue' }], limit: 50 });
    const ask = asks[0]!;
    expect(ask.pathname).toBe(`/api/tenants/${tenant}/scopes/${appScope}/denials`);
    expect(ask.searchParams.get('until')).toBe('2026-09-29T12:00:00.000Z');
    expect(ask.searchParams.get('limit')).toBe('50');
  });

  it('caps the page at the log’s own maximum', async () => {
    const res = await get(appScope, '?limit=100000');
    expect(((await res.json()) as { limit: number }).limit).toBe(DENIAL_LIMIT_MAX);
  });

  it('refuses a bad window or page size, and another team’s app, before asking the plane', async () => {
    expect((await get(appScope, '?until=yesterday')).status).toBe(400);
    expect((await get(appScope, '?limit=0')).status).toBe(400);
    expect((await get(scopeId.parse(ulid()))).status).toBe(404);
    expect(asks).toHaveLength(0);
  });
});
