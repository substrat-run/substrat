import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, problemDetail, scopeId, substratError, tenantId, toProblem, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The dashboard's refusals answer by their CODE (#113), not by a pattern over their sentence:
 * the worker driven the way a request reaches it, the real control plane over a SQLite host
 * behind the service binding (the `bind-ack-route.test.ts` harness). Each case is a refusal
 * the worker used to recognise by its words (`/permission denied/`, `/not one of your
 * deployments/`, `/not bound/`, `'read-only console'`); the sentence is asserted byte for byte
 * beside the status, because the words are unchanged and only what decides the status moved.
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
const SLUG = 'acme/ledger';
const OWNER_SUB = 'sub-owner';
const MANAGER_SUB = 'sub-manager';
const TEAM_NAME = 'Refusal codes';
const staff = platformActorId.parse(ulid());

describe('the dashboard answers a refusal by its code, not its sentence (#113)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  let appScope: ScopeId;
  let env: Record<string, unknown>;
  /** A refusal the plane answers the hostname bind with, in place of the bind itself. */
  let bindRefusal: Response | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-refusal-codes-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);

    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'refusal-codes', name: TEAM_NAME });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: OWNER_SUB, principal: owner, tenantId: tenant, scopeId: dashScope });
    // Somebody who may manage members and read, and is not the owner.
    const manager = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: MANAGER_SUB, principal: manager, tenantId: tenant, scopeId: dashScope });
    for (const permission of ['dashboard:manage-members', 'dashboard:read'] as const) {
      await host.admin.grant(staff, { principalId: manager, permission: permission as never, node: { tenantId: tenant, scopeId: null }, grantedBy: owner });
    }

    await host.admin.registerVertical(staff, { slug: SLUG, name: SLUG, source: 'cli', ownerTenant: tenant });
    const versionId = ulid();
    await host.admin.publishVersion(staff, {
      id: versionId, verticalSlug: SLUG, version: '1.0.0', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null, manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [] } }),
    });
    await host.admin.admitVersion(staff, versionId);
    appScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: appScope, vertical: SLUG });
    await host.admin.activateScope(staff, tenant, appScope);
    await host.admin.bindScopeVersion(staff, tenant, appScope, versionId);
    const dash = await host.getScope(owner, tenant, dashScope);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: SLUG, name: 'Ledger' });

    bindRefusal = undefined;
    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          if (bindRefusal && init?.method === 'POST' && u.pathname === '/api/hostnames') return bindRefusal;
          return plane.request(u.pathname.replace(/^\/api/, '') + u.search, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The answer as the web client's `call()` reads it: the status, and the sentence. */
  const send = async (method: string, path: string, body?: object, sub = OWNER_SUB) => {
    const res = await app.request(
      `/api${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', cookie: `sb_session=${sub}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
    return { status: res.status, detail: problemDetail(await res.json().catch(() => null)) };
  };

  it('a hostname that is not the app\'s is a 404, not the route\'s 409', async () => {
    expect(await send('DELETE', `/apps/${appScope}/hostnames/nobody.example.com`)).toEqual({
      status: 404,
      detail: "'nobody.example.com' is not bound to this app",
    });
  });

  it('the twin: a refusal that is not a missing binding keeps the route\'s 409', async () => {
    const res = await send('POST', `/apps/${appScope}/hostnames`, { surface: 'app', domain: 'not a domain' });
    expect(res).toEqual({ status: 409, detail: "'not a domain' is not a valid domain name" });
  });

  it('binding a hostname without the permission keeps its 403 through the route\'s 409', async () => {
    const res = await send('POST', `/apps/${appScope}/hostnames`, { surface: 'app', domain: 'shop.example.com' }, MANAGER_SUB);
    expect(res.status).toBe(403);
    expect(res.detail).toMatch(/^permission denied: dashboard:provision-app/);
  });

  it('the plane\'s own permission_denied, relayed, keeps its 403 too — by its code', async () => {
    const refusal = toProblem(substratError('permission_denied', 'permission denied: hostnames:bind'));
    bindRefusal = Response.json(refusal, { status: 403 });
    expect(await send('POST', `/apps/${appScope}/hostnames`, { surface: 'app', domain: 'shop.example.com' })).toEqual({
      status: 403,
      detail: 'permission denied: hostnames:bind',
    });
  });

  it('the twin: the plane\'s 403 that is not a permission denial is the route\'s 409, as it always was', async () => {
    bindRefusal = Response.json(toProblem(substratError('forbidden', 'only previews may be deleted')), { status: 403 });
    expect((await send('POST', `/apps/${appScope}/hostnames`, { surface: 'app', domain: 'shop.example.com' })).status).toBe(409);
  });

  it('a slug that is not the team\'s own deployment is a 404', async () => {
    expect(await send('GET', '/deployments/billing/promote-review?versionId=v')).toEqual({
      status: 404,
      detail: "vertical 'billing' is not one of your deployments",
    });
  });

  it('only the owner may delete the organization: a manager is refused 403', async () => {
    expect(await send('POST', '/teams/delete', { confirm: TEAM_NAME }, MANAGER_SUB)).toEqual({
      status: 403,
      detail: 'permission denied: only the owner can delete the organization',
    });
  });

  it('the SQL console relays the gate\'s refusal as the plane\'s 400, with its sentence', async () => {
    const res = await send('POST', `/apps/${appScope}/query`, { sql: 'DELETE FROM x' });
    expect(res.status).toBe(400);
    expect(res.detail).toMatch(/^read-only console: /);
  });
});
