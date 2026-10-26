import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, ROLES, provisionDashboard } from '../src/index.js';

/**
 * `POST /api/apps/:scopeId/restore` (#1869): the uploaded file's own `scopeId` reaches the
 * control plane as a SEPARATE `sourceScopeId` hint for the grant re-point, and the body's
 * `tenantId`/`scopeId` (which pick the keys that open sealed payloads) are unchanged by it.
 * And the route is a team owner's or admin's (#2573): a member, who manages the team's apps
 * otherwise, is refused before the plane is asked for anything, the safety copy included.
 *
 * Driven through the WORKER, with the plane behind the service binding a recorder, the way
 * `app-requests.test.ts` drives it; the seams the worker cannot run in Node are replaced the
 * same way.
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

describe('the app restore route: who may upload (#2573), and the re-point hint (#1869)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  /** Every restore body that reached the plane. */
  let restores: Record<string, unknown>[];
  /** Every path the plane was asked for. */
  let planeCalls: string[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-restore-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    restores = [];
    planeCalls = [];

    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'restores', name: 'Restores' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const link = (sub: string, principal: typeof owner) =>
      host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    await link('sub-owner', owner);
    for (const role of ['admin', 'member'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
      await link(`sub-${role}`, p);
    }
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: 'acme/widgets', name: 'Widgets' });

    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const path = new URL(String(url)).pathname.replace(/^\/api/, '');
          planeCalls.push(path);
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path.endsWith('/snapshots')) return Response.json({ id: ulid() }, { status: 201 });
          if (path.endsWith('/restore')) {
            restores.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Response.json({ restored: appScope, tables: 1 });
          }
          return Response.json({ entries: [] });
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const upload = (file: Record<string, unknown>, as: 'owner' | 'admin' | 'member' = 'owner') =>
    app.request(
      `/api/apps/${appScope}/restore`,
      {
        method: 'POST',
        headers: { cookie: `sb_session=sub-${as}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tables: [{ name: 't', ddl: 'CREATE TABLE t (x)', columns: ['x'], rows: [] }], ...file }),
      },
      env,
    );

  it('a member is refused with 403 before the plane is asked for anything, the safety copy included', async () => {
    const res = await upload({}, 'member');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('permission denied: dashboard:restore-app-data');
    expect(planeCalls).toEqual([]);
  });

  it('a team whose roles predate the key: the first upload heals them, so an admin restores and a member still cannot', async () => {
    // The role rows as a tenant provisioned before #2573 stores them: no restore key anywhere.
    for (const role of ROLES) {
      const old = role.permissions.filter((p) => p !== 'dashboard:restore-app-data');
      await host.admin.defineRole(staff, tenant, { ...role, permissions: old });
    }
    expect((await host.admin.listRoles(staff, { tenantId: tenant })).flatMap((r) => r.permissions)).not.toContain('dashboard:restore-app-data');
    // The very first request resolves the caller and re-defines the drifted roles before the route
    // runs, so there is no first-try 403 for an admin.
    expect((await upload({}, 'admin')).status).toBe(200);
    expect((await upload({}, 'member')).status).toBe(403);
  });

  it('an owner and an admin restore', async () => {
    for (const as of ['owner', 'admin'] as const) expect((await upload({}, as)).status).toBe(200);
    expect(restores).toHaveLength(2);
  });

  it("sends the file's scopeId as sourceScopeId, and leaves tenantId/scopeId as the destination", async () => {
    const source = scopeId.parse(ulid());
    const res = await upload({ tenantId: tenantId.parse(ulid()), scopeId: source });
    expect(res.status).toBe(200);
    expect(restores).toHaveLength(1);
    // The key-selection ids are the destination's, exactly as before; the hint is its own field.
    expect(restores[0]).toMatchObject({ tenantId: tenant, scopeId: appScope, sourceScopeId: source });
  });

  it('sends no hint for a file with no scopeId, or one that is not a scope id', async () => {
    for (const file of [{}, { scopeId: 'not-a-scope' }, { scopeId: 42 }]) {
      expect((await upload(file)).status).toBe(200);
    }
    expect(restores).toHaveLength(3);
    for (const body of restores) {
      expect(body).toMatchObject({ tenantId: tenant, scopeId: appScope });
      expect(body).not.toHaveProperty('sourceScopeId');
    }
  });
});
