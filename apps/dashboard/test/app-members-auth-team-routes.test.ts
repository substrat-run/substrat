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

it('keeps app owner, roster and auth reads on the path team when another tab switches the cookie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-app-identity-team-'));
  const host = new SqliteScopeHost({ dir });
  shared.host = host;
  try {
    for (const module of MODULES) host.registerModule(module);
    const staff = platformActorId.parse(ulid());
    const sub = 'sub-owner';
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    const teams = [tenantId.parse(ulid()), tenantId.parse(ulid())] as const;
    const apps = [scopeId.parse(ulid()), scopeId.parse(ulid())] as const;
    for (const [i, team] of teams.entries()) {
      const dashboardScope = scopeId.parse(ulid());
      const principal = principalId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: team, scopeId: dashboardScope, owner: principal, slug: `team-${i}`, name: `Team ${i}` });
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal, tenantId: team, scopeId: dashboardScope });
      const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
      await dash.invoke('dashboard/provision-app', { appScopeId: apps[i]!, verticalSlug: 'acme/widgets', name: `App ${i}` });
    }

    const planeCalls: string[] = [];
    const env = {
      SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
      CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        const path = requestUrl.pathname;
        planeCalls.push(path);
        if (path === '/api/tenant-tokens') return Response.json({ token: 'tenant-token' });
        if (path === '/api/scopes') return Response.json({ entries: [], nextCursor: null });
        if (path.endsWith('/owner-seat')) return Response.json({ state: 'unclaimed', owner: null, firstSignIn: null, claimLink: null });
        if (path.endsWith('/owner-claim')) return Response.json({ claimUrl: 'https://app.example/?claim=once', expiresAt: '2026-11-01T00:00:00Z' }, { status: 201 });
        if (path.endsWith('/members') && (init?.method ?? 'GET') === 'GET') return Response.json({ roles: ['member'], members: [], invites: [] });
        if (path.endsWith('/members')) return Response.json({ principal: principalId.parse(ulid()), roleKey: 'member', email: null, acceptUrl: 'https://app.example/?invite=once' }, { status: 201 });
        if (path.endsWith('/role')) return Response.json({ principal: path.split('/').at(-2), from: 'member', to: 'admin' });
        if (path.endsWith('/remove')) return Response.json({ revoked: ['member'], unbound: 1, inviteWithdrawn: false });
        if (path === '/api/hostnames') return Response.json(requestUrl.searchParams.get('scopeId') === apps[0]
          ? [{ hostname: 'app.example', surface: 'app', status: 'active', statusNote: null, canonical: true, createdAt: '2026-10-01T00:00:00Z', validationRecords: [] }]
          : []);
        if (path.endsWith('/configure')) return Response.json({});
        return Response.json({ detail: 'unavailable' }, { status: 501 });
      } },
    };
    const send = (method: string, path: string, body?: unknown) => app.request(path, {
      method,
      headers: { cookie: `sb_session=${sub}; sb_team=${teams[1]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    const path = `/api/teams/${teams[0]}/apps/${apps[0]}`;

    expect((await send('GET', `${path}/owner-seat`)).status).toBe(200);
    expect((await send('GET', `${path}/members`)).status).toBe(200);
    expect((await send('GET', `${path}/auth`)).status).toBe(200);
    const choice = { source: 'external', issuer: 'https://issuer.example', clientId: 'client' };
    expect((await send('PUT', `${path}/auth`, { choice })).status).toBe(200);
    expect(await (await send('GET', `${path}/auth`)).json()).toMatchObject({ auth: { issuer: choice.issuer, clientId: choice.clientId } });
    expect(await (await send('GET', `/api/teams/${teams[1]}/apps/${apps[1]}/auth`)).json()).toMatchObject({ auth: null });
    expect((await send('POST', `${path}/owner-claim`)).status).toBe(201);
    expect((await send('POST', `${path}/members`, { roleKey: 'member' })).status).toBe(201);
    const member = principalId.parse(ulid());
    expect((await send('POST', `${path}/members/${member}/role`, { from: 'member', to: 'admin' })).status).toBe(200);
    expect((await send('POST', `${path}/members/${member}/remove`)).status).toBe(200);
    expect(planeCalls.some((call) => call.includes(`/tenants/${teams[0]}/scopes/${apps[0]}/owner-seat`))).toBe(true);
    expect(planeCalls.some((call) => call.includes(`/tenants/${teams[0]}/scopes/${apps[0]}/members`))).toBe(true);
    expect(planeCalls.some((call) => call.includes(`/tenants/${teams[1]}/scopes/${apps[1]}`))).toBe(false);

    const before = planeCalls.length;
    const outside = `/api/teams/${tenantId.parse(ulid())}/apps/${apps[0]}`;
    expect((await send('GET', `${outside}/owner-seat`)).status).toBe(404);
    expect((await send('POST', `${outside}/owner-claim`)).status).toBe(404);
    expect((await send('GET', `${outside}/members`)).status).toBe(404);
    expect((await send('GET', `${outside}/auth`)).status).toBe(404);
    expect((await send('POST', `${outside}/members`, { roleKey: 'member' })).status).toBe(404);
    expect((await send('POST', `${outside}/members/${member}/role`, { from: 'member', to: 'admin' })).status).toBe(404);
    expect((await send('POST', `${outside}/members/${member}/remove`)).status).toBe(404);
    expect((await send('PUT', `${outside}/auth`, { choice: { source: 'external', issuer: 'https://issuer.example', clientId: 'client' } })).status).toBe(404);
    expect(planeCalls).toHaveLength(before);

    const crossTeam = `/api/teams/${teams[0]}/apps/${apps[1]}`;
    expect((await send('GET', `${crossTeam}/owner-seat`)).status).toBe(404);
    expect((await send('GET', `${crossTeam}/auth`)).status).toBe(404);
    expect((await send('POST', `${crossTeam}/members`, { roleKey: 'member' })).status).toBe(404);
    for (const [method, suffix, body] of [
      ['GET', 'owner-seat'], ['POST', 'owner-claim'], ['GET', 'members'], ['POST', 'members', { roleKey: 'member' }],
      ['POST', `members/${member}/role`, { from: 'member', to: 'admin' }], ['POST', `members/${member}/remove`],
      ['GET', 'auth'], ['PUT', 'auth', { choice: { source: 'external', issuer: 'https://issuer.example', clientId: 'client' } }],
    ] as const) {
      expect((await send(method, `/api/apps/${apps[0]}/${suffix}`, body)).status).toBe(404);
    }
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses an app owner claim to a viewer before minting a link, while an owner can mint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-app-owner-claim-'));
  const host = new SqliteScopeHost({ dir });
  shared.host = host;
  try {
    for (const module of MODULES) host.registerModule(module);
    const staff = platformActorId.parse(ulid());
    const team = tenantId.parse(ulid());
    const dashboardScope = scopeId.parse(ulid());
    const appScope = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    const viewer = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: team, scopeId: dashboardScope, owner, slug: 'team', name: 'Team' });
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: team, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'sub-owner', principal: owner, tenantId: team, scopeId: dashboardScope });
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'sub-viewer', principal: viewer, tenantId: team, scopeId: dashboardScope });
    await (await host.getScope(node.principal, node.tenantId, node.scopeId)).invoke('dashboard/provision-app', {
      appScopeId: appScope, verticalSlug: 'acme/widgets', name: 'App',
    });
    const minted: string[] = [];
    const env = {
      SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
      CONTROL_PLANE_SVC: { fetch: async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        if (path === '/api/tenant-tokens') return Response.json({ token: 'tenant-token' });
        if (path.endsWith('/owner-claim')) {
          minted.push(path);
          return Response.json({ claimUrl: 'https://app.example/?claim=once', expiresAt: '2026-11-01T00:00:00Z' }, { status: 201 });
        }
        return Response.json({ detail: 'unavailable' }, { status: 501 });
      } },
    };
    const claim = (sub: string) => app.request(`/api/teams/${team}/apps/${appScope}/owner-claim`, {
      method: 'POST', headers: { cookie: `sb_session=${sub}; sb_team=${team}` },
    }, env);

    expect((await claim('sub-viewer')).status).toBe(403);
    expect(minted).toHaveLength(0);
    expect((await claim('sub-owner')).status).toBe(201);
    expect(minted).toHaveLength(1);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
