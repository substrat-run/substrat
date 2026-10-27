import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { walkAll } from '../src/walk-all.js';

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
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

// `tsconfig.json` excludes the worker entry; the route is exercised through Hono.
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown, ctx?: unknown): Response | Promise<Response> };
};

const staff = platformActorId.parse(ulid());
const vertical = 'acme/widgets';
const sub = 'sub-owner';

it('keeps an open app environment form on its path team after another tab switches the cookie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-app-env-team-'));
  const host = new SqliteScopeHost({ dir });
  shared.host = host;
  try {
    for (const module of MODULES) host.registerModule(module);
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    await host.admin.registerVertical(staff, {
      slug: vertical,
      name: 'Widgets',
      source: 'cli',
      envSpec: [{ key: 'COLOR', description: 'Theme color', required: false, secret: false }],
    });

    const teams = [tenantId.parse(ulid()), tenantId.parse(ulid())] as const;
    const apps = [scopeId.parse(ulid()), scopeId.parse(ulid())] as const;
    const dashboards = [] as Array<Awaited<ReturnType<SqliteScopeHost['getScope']>>>;
    for (const [i, team] of teams.entries()) {
      const scope = scopeId.parse(ulid());
      const principal = principalId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: team, scopeId: scope, owner: principal, slug: `team-${i}`, name: `Team ${i}` });
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal, tenantId: team, scopeId: scope });
      const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
      dashboards.push(dash);
      await dash.invoke('dashboard/provision-app', { appScopeId: apps[i]!, verticalSlug: vertical, name: `App ${i}` });
      await dash.invoke('dashboard/set-app-env', { appScopeId: apps[i]!, entries: [{ key: 'COLOR', value: i === 0 ? 'red' : 'blue', secret: false }] });
    }

    const planeCalls: string[] = [];
    const env = {
      SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
      CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request) => {
        planeCalls.push(new URL(String(url)).pathname);
        return Response.json({ detail: 'unavailable' }, { status: 501 });
      } },
    };
    const send = (method: string, path: string, body?: unknown) => app.request(path, {
      method,
      headers: { cookie: `sb_session=${sub}; sb_team=${teams[1]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    const path = `/api/teams/${teams[0]}/apps/${apps[0]}/env`;
    const values = async (i: number) => walkAll(dashboards[i]!, 'dashboard/list-app-env', { appScopeId: apps[i]! });

    const read = await send('GET', path);
    expect(read.status).toBe(200);
    expect((await read.json()) as { values: unknown[] }).toMatchObject({ values: [{ key: 'COLOR', value: 'red' }] });
    expect((await send('PUT', path, { entries: [{ key: 'COLOR', value: 'green', secret: false }] })).status).toBe(200);
    expect(await values(0)).toMatchObject([{ key: 'COLOR', value: 'green' }]);
    expect(await values(1)).toMatchObject([{ key: 'COLOR', value: 'blue' }]);
    expect((await send('DELETE', `${path}/COLOR`)).status).toBe(200);
    expect(await values(0)).toEqual([]);
    expect(await values(1)).toMatchObject([{ key: 'COLOR', value: 'blue' }]);

    const outside = tenantId.parse(ulid());
    const outsidePath = `/api/teams/${outside}/apps/${apps[1]}/env`;
    const beforeCalls = planeCalls.length;
    expect((await send('GET', outsidePath)).status).toBe(404);
    expect((await send('PUT', outsidePath, { entries: [{ key: 'COLOR', value: 'orange', secret: false }] })).status).toBe(404);
    expect((await send('DELETE', `${outsidePath}/COLOR`)).status).toBe(404);
    expect(planeCalls).toHaveLength(beforeCalls);
    expect(await values(1)).toMatchObject([{ key: 'COLOR', value: 'blue' }]);

    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const oldPath = `/api/apps/${apps[0]}/env${method === 'DELETE' ? '/COLOR' : ''}`;
      expect((await send(method, oldPath, method === 'PUT' ? { entries: [] } : undefined)).status).toBe(404);
    }
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
