import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
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

describe('the app request reads (#1746)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  /** Every request read that reached the plane, as a URL. */
  let reads: URL[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-requests-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    reads = [];

    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'requests', name: 'Requests' });
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
        fetch: async (url: string | URL | Request) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '');
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path.startsWith('/observability/tenant-request')) {
            reads.push(u);
            if (u.searchParams.get('hours') === '501') return Response.json({ error: 'not configured' }, { status: 501 });
            return Response.json({ ok: path });
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

  const read = (scope: string, kind: string, query = '') =>
    app.request(`/api/apps/${scope}/observability/requests/${kind}${query}`, { headers: { cookie: 'sb_session=sub-owner' } }, env);

  it('reaches each plane read, with the facet filters and window as they arrived', async () => {
    const q = '?hours=3&level=warn&level=error&operation=acme%2Fcreate&status=409&buckets=120&facet=level';
    for (const [kind, route] of [['volume', 'tenant-request-volume'], ['facets', 'tenant-request-facets'], ['list', 'tenant-requests']]) {
      const res = await read(appScope, kind!, q);
      expect(res.status).toBe(200);
      const ask = reads.at(-1)!;
      expect(ask.pathname).toBe(`/api/observability/${route}`);
      expect(ask.searchParams.getAll('level')).toEqual(['warn', 'error']);
      expect(ask.searchParams.get('operation')).toBe('acme/create');
      expect(ask.searchParams.get('buckets')).toBe('120');
      expect(ask.searchParams.get('tenantId')).toBe(tenant);
      expect(ask.searchParams.get('scopeId')).toBe(appScope);
    }
  });

  it('never lets the query name the tenant or the scope', async () => {
    const other = tenantId.parse(ulid());
    await read(appScope, 'list', `?tenantId=${other}&scopeId=${scopeId.parse(ulid())}`);
    const ask = reads.at(-1)!;
    expect(ask.searchParams.getAll('tenantId')).toEqual([tenant]);
    expect(ask.searchParams.getAll('scopeId')).toEqual([appScope]);
  });

  it("404s an app that is not this team's, and an unknown read, before asking the plane", async () => {
    expect((await read(scopeId.parse(ulid()), 'volume')).status).toBe(404);
    expect((await read(appScope, 'patterns')).status).toBe(404);
    expect(reads).toHaveLength(0);
  });

  it('passes the plane\'s 501 on as a 501', async () => {
    expect((await read(appScope, 'volume', '?hours=501')).status).toBe(501);
  });
});
