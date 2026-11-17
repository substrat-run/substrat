import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * An app's mail-in address in the dashboard (#2611): Settings → Integrations reads it and requests,
 * rotates and revokes it, through the control plane's tenant door. What these routes add over that
 * door is the in-scope check — `dashboard:manage-integrations`, for the read too, since whoever
 * reads an address can send mail into the app — and the attribution: the plane is told which
 * signed-in person the check passed for. Driven through the worker with the seams
 * `integrations-fleet.test.ts` uses; the plane is a fake that records what it was asked.
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

const staff = platformActorId.parse(ulid());
const PROVIDER = 'authhero';

describe("an app's mail-in address in the dashboard (#2611)", () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  /** What the plane's mail-in door was sent, in order. */
  let asked: { method: string; body: unknown }[];
  /** The plane's answer to a POST; a test swaps in a refusal. */
  let answer: () => Response;
  let env: Record<string, unknown>;

  const address = (over: Record<string, unknown> = {}) => ({
    address: 'mail+books-abcdefghijklmnop@in.example.test',
    connectionId: ulid(),
    tenantId: tenant,
    scopeId: appScope,
    vertical: 'acme/books',
    operation: 'books/receive-mail',
    permission: 'books:receive-mail',
    allowlist: [],
    createdAt: '2026-11-17T09:00:00.000Z',
    createdBy: owner,
    stats: { received: 3, delivered: 2, rejected: 1, deadLettered: 0, pending: 1, lastReceivedAt: '2026-11-17T10:00:00.000Z', lastRejectedAt: null, lastRejectReason: null },
    ...over,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-dashboard-mail-in-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'bureau', name: 'Bureau' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
    for (const role of ['member', 'viewer'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: `sub-${role}`, principal: p, tenantId: tenant, scopeId: dashScope });
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
    }
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: 'acme/books', name: 'Books' });

    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const path = new URL(String(url)).pathname.replace(/^\/api/, '');
          const method = init?.method ?? 'GET';
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path === `/tenants/${tenant}/scopes/${appScope}/mail-in`) {
            asked.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
            if (method === 'GET') return Response.json({ address: address(), landing: { operation: 'books/receive-mail', permission: 'books:receive-mail' }, receiving: true });
            return answer();
          }
          if (path === `/tenants/${tenant}/identities`) return Response.json([]);
          return Response.json({ detail: `unexpected ${method} ${path}` }, { status: 500 });
        },
      },
    };
  });

  beforeEach(() => {
    asked = [];
    answer = () => Response.json({ address: address() });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (as: string, method: 'GET' | 'POST', body?: unknown) =>
    app.request(
      `/api/teams/${tenant}/apps/${appScope}/mail-in`,
      { method, headers: { cookie: `sb_session=sub-${as}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
      env,
    );

  it('reads the standing, and requests, rotates and revokes as the signed-in owner', async () => {
    const read = await call('owner', 'GET');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ address: { address: 'mail+books-abcdefghijklmnop@in.example.test', stats: { pending: 1 } }, receiving: true });

    expect((await call('owner', 'POST', { action: 'request', allowlist: ['Me@Owner.example', '@supplier.example'] })).status).toBe(200);
    expect((await call('owner', 'POST', { action: 'rotate' })).status).toBe(200);
    answer = () => Response.json({ address: null });
    const revoked = await call('owner', 'POST', { action: 'revoke' });
    expect(await revoked.json()).toEqual({ address: null });

    // The allowlist is normalised before it leaves, and every act names the person the check was for.
    expect(asked).toEqual([
      { method: 'GET', body: null },
      { method: 'POST', body: { action: 'request', createdBy: owner, allowlist: ['me@owner.example', '@supplier.example'] } },
      { method: 'POST', body: { action: 'rotate', createdBy: owner } },
      { method: 'POST', body: { action: 'revoke', createdBy: owner } },
    ]);
  });

  it('refuses a member or viewer, and a malformed allowlist, before the plane is asked', async () => {
    for (const role of ['member', 'viewer']) {
      expect((await call(role, 'GET')).status, role).toBe(403);
      expect((await call(role, 'POST', { action: 'request' })).status, role).toBe(403);
    }
    expect((await call('owner', 'POST', { action: 'request', allowlist: ['not an address'] })).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("answers the plane's refusal in the plane's words", async () => {
    const detail = "vertical 'acme/books' declares no mail-in landing";
    answer = () => Response.json({ type: 'about:blank', title: 'Conflict', status: 409, detail }, { status: 409, headers: { 'content-type': 'application/problem+json' } });
    const res = await call('owner', 'POST', { action: 'request' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('declares no mail-in landing');
  });
});
