import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

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

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

it('keeps an open app Previews tab on its path team after another tab switches the cookie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-app-snapshot-team-'));
  const host = new SqliteScopeHost({ dir });
  shared.host = host;
  try {
    for (const module of MODULES) host.registerModule(module);
    const staff = platformActorId.parse(ulid());
    const sub = 'sub-owner';
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });

    const teams = [tenantId.parse(ulid()), tenantId.parse(ulid())] as const;
    const apps = [scopeId.parse(ulid()), scopeId.parse(ulid())] as const;
    const otherApp = scopeId.parse(ulid());
    for (const [i, team] of teams.entries()) {
      const dashboardScope = scopeId.parse(ulid());
      const principal = principalId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: team, scopeId: dashboardScope, owner: principal, slug: `team-${i}`, name: `Team ${i}` });
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal, tenantId: team, scopeId: dashboardScope });
      const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
      await dash.invoke('dashboard/provision-app', { appScopeId: apps[i]!, verticalSlug: 'acme/widgets', name: `App ${i}` });
      if (i === 0) await dash.invoke('dashboard/provision-app', { appScopeId: otherApp, verticalSlug: 'acme/widgets', name: 'Other app' });
    }

    const record = (appScope: string) => ({
      id: scopeId.parse(ulid()), kind: 'archive', forkedFrom: appScope,
      forkedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, verticalVersionId: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const snapshots = new Map<string, ReturnType<typeof record>[]>([
      [apps[0], [record(apps[0])]], [apps[1], [record(apps[1])]], [otherApp, [record(otherApp)]],
    ]);
    const planeCalls: string[] = [];
    const env = {
      SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
      CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname.replace(/^\/api/, '');
        planeCalls.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
        const appScope = path.match(/\/scopes\/([^/]+)\/snapshots$/)?.[1];
        if (appScope) {
          const rows = snapshots.get(appScope) ?? [];
          if (init?.method === 'POST') {
            const created = record(appScope);
            rows.push(created);
            snapshots.set(appScope, rows);
            return Response.json({ id: created.id }, { status: 201 });
          }
          return Response.json(rows);
        }
        if (init?.method === 'DELETE') {
          for (const rows of snapshots.values()) {
            const index = rows.findIndex((row) => path.endsWith(`/scopes/${row.id}`));
            if (index >= 0) rows.splice(index, 1);
          }
          return new Response(null, { status: 204 });
        }
        return Response.json([]);
      } },
    };
    const send = (method: string, path: string, body?: unknown) => app.request(path, {
      method,
      headers: { cookie: `sb_session=${sub}; sb_team=${teams[1]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    const path = `/api/teams/${teams[0]}/apps/${apps[0]}/snapshots`;
    const first = snapshots.get(apps[0])![0]!;
    const second = snapshots.get(apps[1])![0]!;

    const read = await send('GET', path);
    expect(read.status).toBe(200);
    expect((await read.json()) as Array<{ id: string }>).toMatchObject([{ id: first.id }]);
    const created = await send('POST', path, { ttlDays: 7 });
    expect(created.status).toBe(201);
    expect(snapshots.get(apps[0])).toHaveLength(2);
    expect(snapshots.get(apps[1])).toMatchObject([{ id: second.id }]);
    expect((await send('DELETE', `${path}/${first.id}`)).status).toBe(200);
    expect(snapshots.get(apps[0])).toHaveLength(1);
    expect(snapshots.get(apps[1])).toMatchObject([{ id: second.id }]);

    const foreign = snapshots.get(otherApp)![0]!;
    const beforeForeignCalls = planeCalls.length;
    expect((await send('DELETE', `${path}/${foreign.id}`)).status).toBe(404);
    expect(snapshots.get(otherApp)).toMatchObject([{ id: foreign.id }]);
    expect(planeCalls.slice(beforeForeignCalls).every((call) => !call.startsWith('DELETE '))).toBe(true);

    const outsidePath = `/api/teams/${tenantId.parse(ulid())}/apps/${apps[1]}/snapshots`;
    const beforeOutsideCalls = planeCalls.length;
    expect((await send('GET', outsidePath)).status).toBe(404);
    expect((await send('POST', outsidePath, {})).status).toBe(404);
    expect((await send('DELETE', `${outsidePath}/${second.id}`)).status).toBe(404);
    expect(planeCalls).toHaveLength(beforeOutsideCalls);
    expect(snapshots.get(apps[1])).toMatchObject([{ id: second.id }]);

    expect((await send('GET', `/api/apps/${apps[0]}/snapshots`)).status).toBe(404);
    expect((await send('POST', `/api/apps/${apps[0]}/snapshots`, {})).status).toBe(404);
    expect((await send('DELETE', `/api/apps/${apps[0]}/snapshots/${first.id}`)).status).toBe(404);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
