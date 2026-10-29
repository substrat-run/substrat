import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * A mail connection's **Send test** door (#2343). The message leaves the tenant's own mailbox, so
 * the door takes no recipient: it sends to the signed-in person's own verified address, read from
 * the session. The team is the path's, and a caller outside it is refused before the plane is asked.
 *
 * Driven through the worker with the seams `integrations-fleet.test.ts` uses; the session stand-in
 * carries an email, verified unless the login's name says otherwise.
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

const VERTICAL = 'acme/desk';
const staff = platformActorId.parse(ulid());

describe('the Send test door on a mail connection (#2343)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  const connection = ulid();
  let sends: unknown[];
  let planeCalls: string[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-send-test-door-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    sends = [];
    planeCalls = [];

    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'desk', name: 'Desk' });
    const viewer = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: tenant, scopeId: null } });
    for (const [sub, principal] of [['owner', owner], ['owner-unverified', owner], ['viewer', viewer]] as const) {
      await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    }
    await (await host.getScope(node.principal, node.tenantId, node.scopeId)).invoke('dashboard/provision-app', {
      appScopeId: appScope, verticalSlug: VERTICAL, name: 'Desk',
    });

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
              entries: [{ slug: VERTICAL, name: 'Desk', source: 'registry', ownerTenant: null, listed: true, requires: ['microsoft365'] }],
              nextCursor: null,
            });
          }
          if (path === `/tenants/${tenant}/connections` && method === 'GET') {
            return Response.json([{
              id: connection, tenantId: tenant, vertical: VERTICAL, provider: 'microsoft365', label: 'Microsoft 365',
              status: 'active', externalAccountRef: null, scopes: [], expiresAt: null, lastOkAt: null, lastError: null,
              lastErrorAt: null, createdAt: '2026-10-01T09:00:00.000Z',
            }]);
          }
          if (path === `/tenants/${tenant}/connections/${connection}/send-test`) {
            sends.push(JSON.parse(String(init?.body)));
            return Response.json({ ok: false, status: 403, error: "Exchange refused to send as 'office@acme.example'" });
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

  const sendTest = (sub: string, team: string = tenant, body: unknown = { from: 'office@acme.example', to: 'someone@else.example' }) =>
    app.request(`/api/teams/${team}/apps/${appScope}/integrations/microsoft365/connections/${connection}/send-test`, {
      method: 'POST',
      headers: { cookie: `sb_session=${sub}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, env);

  it('sends to the signed-in person’s own address, never one in the request, and answers in the connector’s words', async () => {
    const res = await sendTest('owner');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, status: 403, error: "Exchange refused to send as 'office@acme.example'" });
    expect(sends).toEqual([{ from: 'office@acme.example', to: 'owner@example.com' }]);
  });

  it('a session whose address the issuer did not verify is refused, and nothing is sent', async () => {
    expect((await sendTest('owner-unverified')).status).toBe(400);
    expect(sends).toEqual([]);
  });

  it('a team the caller is not in is a 404 before the plane is asked; a viewer of the team is a 403', async () => {
    expect((await sendTest('owner', tenantId.parse(ulid()))).status).toBe(404);
    expect(planeCalls).toEqual([]);
    expect((await sendTest('viewer')).status).toBe(403);
    expect(sends).toEqual([]);
  });
});
