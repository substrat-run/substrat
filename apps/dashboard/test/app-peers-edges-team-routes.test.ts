import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, problemDetail, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {}, defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper', ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, { get(t, key) {
        if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
        const value = Reflect.get(t, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
      } });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => token ? { id: token } : null,
}));

const { default: app } = (await import(/* @vite-ignore */ '../src/worker.js')) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const staff = platformActorId.parse(ulid());
const team = [tenantId.parse(ulid()), tenantId.parse(ulid())] as const;
const appScope = [scopeId.parse(ulid()), scopeId.parse(ulid())] as const;
const peer = 'acme/peer';
const replay = { mode: 'replay', from: peer, after: null, acknowledge: 'rerun-handlers', reason: 'review' };
let dir: string;
let host: SqliteScopeHost;
let planeCalls: string[];
let env: Record<string, unknown>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-app-peers-team-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  for (const module of MODULES) host.registerModule(module);
  await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
  for (const [i, id] of team.entries()) {
    const dashboardScope = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: id, scopeId: dashboardScope, owner, slug: `team-${i}`, name: `Team ${i}` });
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'owner', principal: owner, tenantId: id, scopeId: dashboardScope });
    const viewer = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: i === 0 ? 'viewer' : 'admin', node: { tenantId: id, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'viewer', principal: viewer, tenantId: id, scopeId: dashboardScope });
    await (await host.getScope(node.principal, node.tenantId, node.scopeId)).invoke('dashboard/provision-app', {
      appScopeId: appScope[i]!, verticalSlug: 'acme/widgets', name: `App ${i}`,
    });
  }
  planeCalls = [];
  env = {
    SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
    CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace(/^\/api/, '');
      planeCalls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
      if (path.includes('/verticals/')) return Response.json({ entries: [], nextCursor: null });
      if (path.endsWith('/peer-grants')) return Response.json(init?.method ? {
        operationId: ulid(), vertical: peer, calls: init.method === 'DELETE' ? 'off' : 'on', changed: true, permissions: [],
      } : []);
      if (path.endsWith('/peer-bindings')) return Response.json(init?.method === 'PUT'
        ? { changed: true, previous: null, operationId: ulid() } : []);
      if (path.endsWith('/import-cursor')) return Response.json({
        replayId: ulid(), mode: 'replay', source: { vertical: peer, scopeId: appScope[0] },
        previous: null, cursor: null, archived: { journal: 0, deliveries: 0 },
      });
      if (path.endsWith('/cross-vertical/edges')) return Response.json({
        tenantId: team[0], checkedAt: '2026-10-01T00:00:00Z', edges: [], unavailable: null,
        history: { available: true, reason: null },
      });
      if (path === '/scopes') return Response.json({ entries: [{
        id: appScope[0], name: 'App 0', status: 'active',
      }], nextCursor: null });
      if (path.endsWith(`/scopes/${appScope[0]}`) || path.endsWith(`/scopes/${appScope[1]}`)) return Response.json({ verticalVersionId: null });
      return Response.json({ entries: [], nextCursor: null });
    } },
  };
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { planeCalls.length = 0; });

const send = (as: 'owner' | 'viewer', method: string, path: string, body?: unknown) => app.request(path, {
  method, headers: { cookie: `sb_session=${as}; sb_team=${team[1]}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
const path = (suffix: string) => `/api/teams/${team[0]}/apps/${appScope[0]}/${suffix}`;

it('keeps peer and edge calls on the path team when another tab switches the cookie', async () => {
  expect((await send('owner', 'GET', path('peers'))).status).toBe(200);
  expect((await send('owner', 'POST', path('peers/switch'), { vertical: peer, to: 'off', reason: 'review' })).status).toBe(200);
  expect((await send('owner', 'PUT', path('peers/binding'), { vertical: peer, targetScopeId: null })).status).toBe(200);
  expect((await send('owner', 'GET', path('edges'))).status).toBe(200);
  expect((await send('owner', 'POST', path('edges/move'), replay)).status).toBe(200);
  expect((await send('owner', 'GET', path('scopes'))).status).toBe(200);
  expect(planeCalls.some((call) => call.includes(`/tenants/${team[0]}/scopes/${appScope[0]}`))).toBe(true);
  expect(planeCalls.every((call) => !call.includes(`/tenants/${team[1]}/scopes/${appScope[1]}`))).toBe(true);
});

it('refuses a non-member or another team’s app before control-plane work and removes cookie routes', async () => {
  expect((await send('owner', 'GET', `/api/teams/${team[0]}/apps/${appScope[1]}/peers`)).status).toBe(404);
  expect((await send('owner', 'POST', `/api/teams/${tenantId.parse(ulid())}/apps/${appScope[0]}/edges/move`, replay)).status).toBe(404);
  expect(planeCalls).toHaveLength(0);
  for (const suffix of ['peers', 'edges', 'scopes']) {
    expect((await send('owner', 'GET', `/api/apps/${appScope[0]}/${suffix}`)).status).toBe(404);
  }
  for (const [method, suffix] of [['POST', 'peers/switch'], ['PUT', 'peers/binding'], ['POST', 'edges/move']] as const) {
    expect((await send('owner', method, `/api/apps/${appScope[0]}/${suffix}`, {})).status).toBe(404);
  }
});

it('answers the app version reads for the path team whichever team the cookie pins, and their cookie routes are gone', async () => {
  const reads = ['deployments', 'deployments/V1/assets', 'permissions', 'model', 'processes', 'schedules'];
  for (const suffix of reads) {
    expect((await send('owner', 'GET', `/api/teams/${tenantId.parse(ulid())}/apps/${appScope[0]}/${suffix}`)).status, suffix).toBe(404);
  }
  expect(planeCalls).toHaveLength(0);
  for (const suffix of reads) {
    const res = await send('owner', 'GET', path(suffix));
    expect(res.status, `${suffix}: ${await res.clone().text()}`).toBe(200);
    expect((await send('owner', 'GET', `/api/teams/${team[0]}/apps/${appScope[1]}/${suffix}`)).status, suffix).toBe(404);
  }
  expect(planeCalls.some((call) => call.includes(`/tenants/${team[0]}/scopes/${appScope[0]}`))).toBe(true);
  expect(planeCalls.every((call) => !call.includes(`/tenants/${team[1]}/`))).toBe(true);
  // The cookie pins team 1 and this is team 1's own app, so a cookie route would have answered it.
  for (const suffix of reads) {
    expect((await send('owner', 'GET', `/api/apps/${appScope[1]}/${suffix}`)).status, suffix).toBe(404);
  }
});

it('uses the path-team app-management role on all three writes', async () => {
  for (const [method, suffix, body] of [
    ['POST', 'peers/switch', { vertical: peer, to: 'off', reason: 'review' }],
    ['PUT', 'peers/binding', { vertical: peer, targetScopeId: null }],
    ['POST', 'edges/move', replay],
  ] as const) {
    const response = await send('viewer', method, path(suffix), body);
    expect(response.status).toBe(403);
    expect(problemDetail(await response.json())).toBe('permission denied: dashboard:provision-app');
  }
  expect(planeCalls).toHaveLength(0);
});
