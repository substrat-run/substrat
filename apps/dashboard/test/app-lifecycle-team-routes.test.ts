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
const version = ulid();
let dir: string;
let host: SqliteScopeHost;
let planeCalls: string[];
let restoreBodies: unknown[];
let env: Record<string, unknown>;
const store = { binding: 'GRAPH', driver: 'counter', tables: [{
  name: 'held', ddl: 'CREATE TABLE held (id TEXT)', columns: ['id'], rows: [['saved']],
}] };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-app-lifecycle-team-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  for (const module of MODULES) host.registerModule(module);
  await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
  for (const [i, id] of team.entries()) {
    const dashboardScope = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: id, scopeId: dashboardScope, owner, slug: `team-${i}`, name: `Team ${i}` });
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'owner', principal: owner, tenantId: id, scopeId: dashboardScope });
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const principal = principalId.parse(ulid());
      const roleKey = role === 'viewer' && i === 1 ? 'admin' : role;
      await host.admin.assignRole(staff, { principalId: principal, roleKey, node: { tenantId: id, scopeId: null } });
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: role, principal, tenantId: id, scopeId: dashboardScope });
    }
    await (await host.getScope(node.principal, node.tenantId, node.scopeId)).invoke('dashboard/provision-app', {
      appScopeId: appScope[i]!, verticalSlug: 'acme/widgets', name: `App ${i}`,
    });
  }
  planeCalls = [];
  restoreBodies = [];
  env = {
    SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
    CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace(/^\/api/, '');
      planeCalls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
      if (path.includes('/verticals/')) {
        if (path.includes('/channels')) return Response.json({ entries: [{ channel: 'prod', versionId: version }], nextCursor: null });
        if (path.includes('/versions')) return Response.json({ entries: [{ id: version, version: '1.0.0', admission: 'admitted', admissionNote: null, deploymentRef: null, createdAt: '2026-10-01T00:00:00Z' }], nextCursor: null });
      }
      if (path.endsWith('/bookmarks')) return Response.json([{ bookmark: 'before', takenAt: '2026-10-01T00:00:00Z', pending: [] }]);
      if (path.endsWith('/migrations')) return Response.json([]);
      if (path.endsWith('/export')) return Response.json({ tenantId: team[0], scopeId: appScope[0], capturedAt: '2026-10-01T00:00:00Z', masked: true, tables: [{ name: 't', ddl: 'CREATE TABLE t (x)', columns: ['x'], rows: [] }], stores: [store] });
      if (path.endsWith('/snapshots')) return Response.json({ id: scopeId.parse(ulid()) }, { status: 201 });
      if (path.endsWith('/restore')) {
        restoreBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ restored: appScope[0], tables: 1 });
      }
      if (path.endsWith('/rewind')) return Response.json({ rewindingTo: 'before' });
      if (path.endsWith('/version')) return Response.json({});
      if (path.includes('/binding-impact')) return Response.json({ affected: [] });
      if (path.endsWith(`/scopes/${appScope[0]}`)) return Response.json({ verticalVersionId: version });
      if (path.endsWith(`/scopes/${appScope[1]}`)) return Response.json({ verticalVersionId: version });
      return Response.json({ entries: [], nextCursor: null });
    } },
  };
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { planeCalls.length = 0; restoreBodies.length = 0; });

const send = (as: 'owner' | 'admin' | 'member' | 'viewer', method: string, path: string, body?: unknown) => app.request(path, {
  method,
  headers: { cookie: `sb_session=${as}; sb_team=${team[1]}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
const path = (suffix: string) => `/api/teams/${team[0]}/apps/${appScope[0]}/${suffix}`;

it('keeps a dump store through export and restore route parsing', async () => {
  const exported = await send('owner', 'GET', path('export'));
  expect(exported.status).toBe(200);
  const dump = await exported.json() as { tables: unknown[]; stores: unknown[] };
  expect(dump.stores).toEqual([store]);
  const restored = await send('owner', 'POST', path('restore'), { tables: dump.tables, stores: dump.stores });
  expect(restored.status).toBe(200);
  expect(restoreBodies).toHaveLength(1);
  expect(restoreBodies[0]).toMatchObject({ stores: [store] });
});

it('keeps lifecycle reads and writes on the path team after another tab switches the cookie', async () => {
  expect((await send('owner', 'GET', path('bookmarks'))).status).toBe(200);
  expect((await send('owner', 'GET', path('migrations'))).status).toBe(200);
  expect((await send('owner', 'GET', path('release-comparison'))).status).toBe(200);
  expect((await send('owner', 'GET', path('export'))).status).toBe(200);
  expect((await send('owner', 'POST', path('update'), {})).status).toBe(200);
  expect((await send('owner', 'POST', path('bind'), { versionId: version })).status).toBe(200);
  expect((await send('owner', 'POST', path('rewind'), { bookmark: 'before' })).status).toBe(200);
  expect((await send('owner', 'POST', path('restore'), { tables: [{ name: 't', ddl: 'CREATE TABLE t (x)', columns: ['x'], rows: [] }] })).status).toBe(200);
  expect(planeCalls.some((call) => call.includes(`/tenants/${team[0]}/scopes/${appScope[0]}`))).toBe(true);
  expect(planeCalls.every((call) => !call.includes(`/tenants/${team[1]}/scopes/${appScope[1]}`))).toBe(true);

  const before = planeCalls.length;
  expect((await send('owner', 'GET', `/api/teams/${team[0]}/apps/${appScope[1]}/bookmarks`)).status).toBe(404);
  expect((await send('owner', 'POST', `/api/teams/${tenantId.parse(ulid())}/apps/${appScope[0]}/rewind`, { bookmark: 'before' })).status).toBe(404);
  expect(planeCalls).toHaveLength(before);
  for (const suffix of ['bookmarks', 'migrations', 'release-comparison', 'export']) {
    expect((await send('owner', 'GET', `/api/apps/${appScope[0]}/${suffix}`)).status).toBe(404);
  }
  for (const suffix of ['update', 'bind', 'rewind', 'restore']) {
    expect((await send('owner', 'POST', `/api/apps/${appScope[0]}/${suffix}`, {})).status).toBe(404);
  }
});

it('refuses a viewer bind before asking the plane for impact or binding', async () => {
  const before = planeCalls.length;
  const response = await send('viewer', 'POST', path('bind'), { versionId: version });
  expect(response.status).toBe(403);
  expect(problemDetail(await response.json())).toBe('permission denied: dashboard:provision-app');
  expect(planeCalls).toHaveLength(before);
  // The same person is an admin in the cookie team: that role applies only to its own path.
  expect((await send('viewer', 'POST', `/api/teams/${team[1]}/apps/${appScope[1]}/bind`, { versionId: version })).status).toBe(200);
});

it('refuses a viewer update even when the app already runs prod', async () => {
  const before = planeCalls.length;
  const response = await send('viewer', 'POST', path('update'), {});
  expect(response.status).toBe(403);
  expect(problemDetail(await response.json())).toBe('permission denied: dashboard:provision-app');
  expect(planeCalls).toHaveLength(before);
  expect((await send('viewer', 'POST', `/api/teams/${team[1]}/apps/${appScope[1]}/update`, {})).status).toBe(200);
});

it('keeps the rewind and restore gates in the path team', async () => {
  const before = planeCalls.length;
  const rewind = await send('viewer', 'POST', path('rewind'), { bookmark: 'before' });
  expect(rewind.status).toBe(403);
  expect(problemDetail(await rewind.json())).toBe('permission denied: dashboard:provision-app');
  const restore = await send('viewer', 'POST', path('restore'), {
    tables: [{ name: 't', ddl: 'CREATE TABLE t (x)', columns: ['x'], rows: [] }],
  });
  expect(restore.status).toBe(403);
  expect(problemDetail(await restore.json())).toBe('permission denied: dashboard:restore-app-data');
  expect(planeCalls).toHaveLength(before);
});

it('lets app managers update and bind through the path team', async () => {
  for (const as of ['admin', 'member'] as const) {
    expect((await send(as, 'POST', path('update'), {})).status).toBe(200);
    expect((await send(as, 'POST', path('bind'), { versionId: version })).status).toBe(200);
  }
});
