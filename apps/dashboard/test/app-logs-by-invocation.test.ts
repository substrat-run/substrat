import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * `GET /api/apps/:scopeId/observability/logs?invocationId=` (#1525).
 *
 * Driven through the WORKER because the fact under test is a route forwarding a
 * parameter: the authority's own suite proves `tenantLogs` can put the id on the wire, and
 * stays green if this route never hands it one. The plane behind the service binding is a
 * recorder, so what is asserted is the request the dashboard makes on the team's behalf —
 * which is the whole tenant boundary at this hop: the tenant is pinned by the session,
 * the scope by the team's own app rows, and the id can only narrow what those two allow.
 * The plane's own half (an id from another tenant matches nothing) is in
 * `packages/control-plane-api/test/cf-tenant-logs.test.ts`.
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

describe('the app logs route forwards an invocation id (#1525)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  /** Every `/observability/tenant-logs` request that reached the plane, as a URL. */
  let logReads: URL[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-logs-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    logReads = [];

    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'logs', name: 'Logs' });
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
          if (path === '/observability/tenant-logs' || path === '/observability/tenant-metrics' || path === '/observability/tenant-metrics-series') {
            logReads.push(u);
            return Response.json([]);
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

  const read = (scope: string, query = '') =>
    app.request(
      `/api/apps/${scope}/observability/logs${query}`,
      { headers: { cookie: 'sb_session=sub-owner' } },
      env,
    );

  const CALL = '01J8Z3KX0Q5R7T9V1W2Y4A6B8C';

  it('puts the id on the request to the plane, beside the team’s tenant and this app’s scope', async () => {
    const res = await read(appScope, `?invocationId=${CALL}&hours=24`);
    expect(res.status).toBe(200);
    expect(logReads).toHaveLength(1);
    const ask = logReads[0]!;
    expect(ask.searchParams.get('invocationId')).toBe(CALL);
    expect(ask.searchParams.get('tenantId')).toBe(tenant);
    expect(ask.searchParams.get('scopeId')).toBe(appScope);
  });

  it('sends none when the caller named none — the read is the unfiltered one it always was', async () => {
    const res = await read(appScope, '?hours=24');
    expect(res.status).toBe(200);
    expect(logReads[0]!.searchParams.has('invocationId')).toBe(false);
  });

  it('does not turn an empty id into "no id" — the plane is left to refuse it', async () => {
    await read(appScope, '?invocationId=');
    expect(logReads[0]!.searchParams.get('invocationId')).toBe('');
  });

  it('still refuses an app that is not the team’s, with or without an id', async () => {
    const stranger = scopeId.parse(ulid());
    expect((await read(stranger, `?invocationId=${CALL}`)).status).toBe(404);
    expect(logReads).toEqual([]);
  });
  it('forwards an absolute metric window and confines both aggregate and chart reads to owned apps', async () => {
    const bounds = new URLSearchParams({ since: '2026-09-01T10:07:00Z', until: '2026-09-01T10:29:00Z', hours: '72' });
    for (const path of [`/api/apps/${appScope}/observability/metrics`, '/api/observability/traffic']) {
      const response = await app.request(`${path}?${bounds}`, { headers: { cookie: 'sb_session=sub-owner' } }, env);
      expect(response.status).toBe(200);
      const sent = logReads.at(-1)!;
      expect(sent.searchParams.get('since')).toBe('2026-09-01T10:07:00.000Z');
      expect(sent.searchParams.get('until')).toBe('2026-09-01T10:29:00.000Z');
      expect(sent.searchParams.get('tenantId')).toBe(tenant);
      expect(sent.searchParams.getAll('scopeId')).toEqual([appScope]);
    }
    const count = logReads.length;
    const foreign = scopeId.parse(ulid());
    expect((await app.request(`/api/observability/traffic?${bounds}&scopeId=${foreign}`, { headers: { cookie: 'sb_session=sub-owner' } }, env)).status).toBe(404);
    expect(logReads).toHaveLength(count);
    expect((await app.request(`/api/observability/traffic?since=bad&until=bad`, { headers: { cookie: 'sb_session=sub-owner' } }, env)).status).toBe(400);
  });

});
