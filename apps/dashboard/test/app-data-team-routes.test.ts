import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {}, defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper', ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
          const value = Reflect.get(t, key) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
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

describe('the app Data reads use the path team (#2170)', () => {
  const staff = platformActorId.parse(ulid());
  const teams = [tenantId.parse(ulid()), tenantId.parse(ulid())] as const;
  const apps = [scopeId.parse(ulid()), scopeId.parse(ulid())] as const;
  const stranger = tenantId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let env: Record<string, unknown>;
  let planeCalls: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-data-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const module of MODULES) host.registerModule(module);
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    for (const [index, team] of teams.entries()) {
      const owner = principalId.parse(ulid());
      const dashboardScope = scopeId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: team, scopeId: dashboardScope, owner, slug: `team-${index}`, name: `Team ${index}` });
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'sub-owner', principal: owner, tenantId: team, scopeId: dashboardScope });
      const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
      await dash.invoke('dashboard/provision-app', { appScopeId: apps[index], verticalSlug: 'acme/widgets', name: `App ${index}` });
      await host.provisionScope(staff, { tenantId: team, scopeId: apps[index] });
    }
    planeCalls = [];
    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname.replace(/^\/api/, '') + new URL(String(url)).search;
        planeCalls.push(`${init?.method ?? 'GET'} ${path}`);
        return plane.request(path, init);
      } },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { cookie: `sb_session=sub-owner; sb_team=${teams[1]}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);

  it('reads team A with team B in the cookie, refuses an unrelated team and app, and removes cookie routes', async () => {
    const base = `/api/teams/${teams[0]}/apps/${apps[0]}`;
    const queries = [
      ['/tables', 'GET'], ['/tables/sqlite_master', 'GET'], ['/facets', 'GET'],
      ['/history?entityType=widget&entityId=one', 'GET'], ['/cause?eventId=01ARZ3NDEKTSV4RRFFQ69G5FAV', 'GET'],
      ['/effects?eventId=01ARZ3NDEKTSV4RRFFQ69G5FAV', 'GET'], ['/invocation?invocationId=one', 'GET'],
      ['/denials', 'GET'], ['/dead-letters', 'GET'], ['/query', 'POST'],
    ] as const;
    for (const [suffix, method] of queries) {
      const result = await send(method, base + suffix, method === 'POST' ? { sql: 'SELECT name FROM sqlite_master LIMIT 1' } : undefined);
      expect(result.status, suffix).toBe(200);
    }
    const select = await send('POST', base + '/query', { sql: 'SELECT name FROM sqlite_master LIMIT 1' });
    expect(((await select.json()) as { columns: string[] }).columns).toEqual(['name']);
    const write = await send('POST', base + '/query', { sql: 'DELETE FROM sqlite_master' });
    expect(write.status).toBe(400);
    expect(await write.text()).toContain('read-only console');

    planeCalls.length = 0;
    expect((await send('GET', `/api/teams/${stranger}/apps/${apps[0]}/tables`)).status).toBe(404);
    expect(planeCalls).toEqual([]);
    expect((await send('GET', `/api/teams/${teams[0]}/apps/${apps[1]}/tables`)).status).toBe(404);
    for (const [suffix, method] of queries) {
      expect((await send(method, `/api/apps/${apps[0]}${suffix}`, method === 'POST' ? { sql: 'SELECT 1' } : undefined)).status, suffix).toBe(404);
    }
  });
});
