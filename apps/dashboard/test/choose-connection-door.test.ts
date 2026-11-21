import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * The door choosing which of the team's Stripe accounts one app's checkouts go through (#3221). The
 * app's Integrations tab says which one it pays through, and a person who manages integrations moves
 * it, attributed to them. Driven through the worker with the seams `send-test-door.test.ts` uses.
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
  verifySession: async (_env: unknown, token: string | undefined) =>
    token ? { id: token, email: `${token}@example.com`, emailVerified: !token.includes('unverified') } : null,
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const VERTICAL = 'acme/shop';
const staff = platformActorId.parse(ulid());

describe("the door choosing an app's payment account (#3221)", () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  const first = ulid();
  const second = ulid();
  const ownOfApp = ulid();
  let chosen: unknown[];
  let planeCalls: string[];
  let env: Record<string, unknown>;

  const row = (id: string, account: string, ownerScopeId: string | null = null) => ({
    id, tenantId: tenant, vertical: VERTICAL, provider: 'stripe', label: `Stripe ${account}`, status: 'active',
    externalAccountRef: `${account}:test`, scopes: [], expiresAt: null, lastOkAt: null, lastError: null,
    lastErrorAt: null, createdAt: '2026-11-01T09:00:00.000Z', ownerScopeId,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-choose-connection-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    chosen = [];
    planeCalls = [];

    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'shop', name: 'Shop' });
    const viewer = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: tenant, scopeId: null } });
    for (const [sub, principal] of [['owner', owner], ['viewer', viewer]] as const) {
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    }
    await (await host.getScope(node.principal, node.tenantId, node.scopeId)).invoke('dashboard/provision-app', {
      appScopeId: appScope, verticalSlug: VERTICAL, name: 'Shop',
    });

    const choice = `/tenants/${tenant}/scopes/${appScope}/connections/stripe/choice`;
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const path = new URL(String(url)).pathname.replace(/^\/api/, '');
          const method = init?.method ?? 'GET';
          planeCalls.push(`${method} ${path}`);
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path === '/verticals') {
            return Response.json({
              entries: [{ slug: VERTICAL, name: 'Shop', source: 'registry', ownerTenant: null, listed: true, requires: ['stripe'] }],
              nextCursor: null,
            });
          }
          if (path === `/tenants/${tenant}/connections` && method === 'GET') {
            return Response.json([row(first, 'acct_first'), row(second, 'acct_second'), row(ownOfApp, 'acct_own', appScope)]);
          }
          if (path === choice && method === 'GET') return Response.json({ provider: 'stripe', scopeId: appScope, chosen: first, bound: [first] });
          if (path === choice && method === 'PUT') {
            const body = JSON.parse(String(init?.body)) as { connectionId: string };
            chosen.push(body);
            return Response.json({ provider: 'stripe', scopeId: appScope, chosen: body.connectionId, bound: [body.connectionId] });
          }
          return Response.json({ error: `unexpected ${method} ${path}` }, { status: 500 });
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const choose = (sub: string, connection: string) =>
    app.request(`/api/teams/${tenant}/apps/${appScope}/integrations/stripe/connections/${connection}/chosen`, {
      method: 'PUT',
      headers: { cookie: `sb_session=${sub}`, 'content-type': 'application/json' },
      body: '{}',
    }, env);

  it("says which account the app pays through, and moves it to another for the person who chose", async () => {
    const tab = await app.request(`/api/teams/${tenant}/apps/${appScope}/integrations`, { headers: { cookie: 'sb_session=owner' } }, env);
    expect(tab.status).toBe(200);
    const stripe = ((await tab.json()) as { providers: { provider: string; takesPayments: boolean; paysThrough?: unknown }[] }).providers.find((p) => p.provider === 'stripe');
    expect(stripe).toMatchObject({ takesPayments: true, paysThrough: { chosen: first, bound: [first] } });

    const res = await choose('owner', second);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ chosen: second, bound: [second] });
    expect(chosen).toEqual([{ connectionId: second, chosenBy: expect.any(String) }]);
  });

  it("refuses a viewer before the plane is asked to choose, and an app's own or unknown connection", async () => {
    expect((await choose('viewer', second)).status).toBe(403);
    expect((await choose('owner', ownOfApp)).status).toBe(404);
    expect((await choose('owner', ulid())).status).toBe(404);
    expect(chosen).toEqual([]);
  });
});
