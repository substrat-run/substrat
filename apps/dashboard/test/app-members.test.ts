import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { DENIAL_LIMIT_MAX, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * An installed app's members from the dashboard (#1150), driven through the worker with
 * `app-denials.test.ts`'s seams: the plane behind the service binding is a recorder. What the
 * dashboard adds at this hop is the gate — the team's own app, the tenant pinned — and the
 * PERSON: the tenant token it mints for each request names the signed-in principal, which the
 * plane hands the app as the caller every change is bounded by. The plane's half is
 * `packages/control-plane-api/test/members-routes.test.ts`; the bound itself is
 * `packages/vertical-auth/test/members-surface.test.ts`, against a real host.
 */
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

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());



describe('the app members routes (#1150)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  const member = principalId.parse(ulid());
  let owner: ReturnType<typeof principalId.parse>;
  let asks: { path: string; method: string; body: unknown }[];
  let mints: unknown[];
  let refuse: { status: number; error: string } | null;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-members-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    asks = [];
    mints = [];
    refuse = null;
    owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'members', name: 'Members' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: 'acme/desk', name: 'Desk' });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '');
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          if (path === '/tenant-tokens') {
            mints.push(body);
            return Response.json({ token: 'tenant-token' });
          }
          if (path === '/scopes') return Response.json({ entries: [], nextCursor: null });
          if (path.includes('/members')) {
            asks.push({ path, method: init?.method ?? 'GET', body });
            if (refuse) return Response.json({ error: refuse.error }, { status: refuse.status });
            if (path.endsWith('/members') && (init?.method ?? 'GET') === 'GET') return Response.json({ roles: ['agent'], members: [], invites: [] });
            if (path.endsWith('/members')) return Response.json({ principal: member, roleKey: 'agent', email: null, acceptUrl: 'https://desk.example/?invite=t' }, { status: 201 });
            if (path.endsWith('/remove')) return Response.json({ revoked: ['agent'], unbound: 1, inviteWithdrawn: false });
            return Response.json({ principal: member, from: 'agent', to: 'lead' });
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

  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);

  it('lists, invites, moves and removes through the plane, as the signed-in person, on the team’s own app', async () => {
    expect((await call(`/api/apps/${appScope}/members`)).status).toBe(200);
    expect((await call(`/api/apps/${appScope}/members`, 'POST', { roleKey: 'agent', email: 'kim@example.test' })).status).toBe(201);
    expect((await call(`/api/apps/${appScope}/members/${member}/role`, 'POST', { from: 'agent', to: 'lead' })).status).toBe(200);
    expect(await (await call(`/api/apps/${appScope}/members/${member}/remove`, 'POST')).json())
      .toEqual({ revoked: ['agent'], unbound: 1, inviteWithdrawn: false });
    const base = `/tenants/${tenant}/scopes/${appScope}/members`;
    expect(asks).toEqual([
      { path: base, method: 'GET', body: undefined },
      { path: base, method: 'POST', body: { roleKey: 'agent', email: 'kim@example.test' } },
      { path: `${base}/${member}/role`, method: 'POST', body: { from: 'agent', to: 'lead' } },
      { path: `${base}/${member}/remove`, method: 'POST', body: undefined },
    ]);
    // Every plane call rode a token minted for THIS person in THIS tenant — the caller the app bounds.
    expect(mints.length).toBeGreaterThan(0);
    for (const m of mints) expect(m).toEqual({ tenantId: tenant, principal: owner });
  });

  it('relays the app’s refusal as given', async () => {
    refuse = { status: 403, error: "you cannot invite at 'lead': you do not hold perm:use" };
    const res = await call(`/api/apps/${appScope}/members`, 'POST', { roleKey: 'lead' });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/do not hold perm:use/);
  });

  it('refuses another team’s app, and a malformed change, before asking the plane', async () => {
    const other = scopeId.parse(ulid());
    expect((await call(`/api/apps/${other}/members`)).status).toBe(404);
    expect((await call(`/api/apps/${other}/members/${member}/remove`, 'POST')).status).toBe(404);
    expect((await call(`/api/apps/${appScope}/members`, 'POST', { roleKey: '' })).status).toBe(400);
    expect((await call(`/api/apps/${appScope}/members/${member}/role`, 'POST', { to: 'lead' })).status).toBe(400);
    expect((await call(`/api/apps/${appScope}/members/not-a-principal/remove`, 'POST')).status).toBe(400);
    expect(asks).toHaveLength(0);
  });
});
