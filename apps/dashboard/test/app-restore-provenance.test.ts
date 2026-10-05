import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * `POST /api/apps/:scopeId/restore` (#1869): the uploaded file's own `scopeId` reaches the
 * control plane as a SEPARATE `sourceScopeId` hint for the grant re-point, and the body's
 * `tenantId`/`scopeId` (which pick the keys that open sealed payloads) are unchanged by it.
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

describe("an app upload's own scope reaches the plane as a separate re-point hint (#1869)", () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  /** Every restore body that reached the plane. */
  let restores: Record<string, unknown>[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-app-restore-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    restores = [];

    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'restores', name: 'Restores' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, {
      provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope,
    });
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

  const upload = (file: Record<string, unknown>) =>
    app.request(
      `/api/apps/${appScope}/restore`,
      {
        method: 'POST',
        headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
        body: JSON.stringify({ tables: [{ name: 't', ddl: 'CREATE TABLE t (x)', columns: ['x'], rows: [] }], ...file }),
      },
      env,
    );

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
