import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createControlPlaneApi, UNSAFE_devPlatformActorAuth } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * The `/api/deployments` write routes ask the caller's ROLE (#1595).
 *
 * Every one of them used to authenticate the caller and check the vertical was theirs and
 * stop there, so a `viewer` — who holds `dashboard:read` and nothing else — could promote
 * prod, delete a vertical, or make and reap previews. The dashboard's own scope is the only
 * place a caller's role is known, and nothing below the seam asks: the plane sees the
 * dashboard's credential, not the person.
 *
 * These drive the WORKER — the route, the way a request reaches it — because the fact under
 * test is that a route calls the gate. A test of the `dashboard/authorize-scope-change`
 * operation alone (which #1592's suite has) stays green while a route forgets to invoke it,
 * which is the exact defect. Only the seams the worker cannot run in Node are replaced:
 * `cloudflare:workers` and the Cloudflare host (a SQLite host stands in), and the session
 * verification (the cookie IS the OIDC `sub`). The control plane behind the service binding
 * is the real `createControlPlaneApi` over that same host; only the acts that need a
 * dispatch namespace (promote, previews, hostname bind) are recorded instead of run, so
 * "the plane was never asked" is something a refusal can assert.
 *
 * One test per route per side, on purpose: when one regresses, the name says which.
 */

// The mocks are hoisted above the imports; the host they hand out is set per test.
const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  ControlPlaneDO: class {},
  // `hostFor` builds one per request and registers the modules on it; the shared SQLite
  // host already carries them, so registration is the one call that must not repeat.
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule') return () => undefined;
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
  // The session cookie carries the OIDC `sub` directly; an empty one is no session.
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

// Named through a variable on purpose: `tsconfig.json` EXCLUDES `src/worker.ts` (it is
// typechecked by `tsconfig.worker.json`, where declaration emit is off), and a literal
// specifier would pull it back into the config that cannot compile it.
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());

describe('the /api/deployments write routes ask the caller’s role (#1595)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  /** What the plane was asked to DO (not to read) — a refused route leaves this empty. */
  let effects: string[];
  /** EVERY request that reached the plane's service binding: reads, ownership lookups, token mints. */
  let planeCalls: string[];
  let env: Record<string, unknown>;

  /** One login per role: the cookie value is its `sub`. */
  const subs = { owner: 'sub-owner', member: 'sub-member', viewer: 'sub-viewer' } as const;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-deployments-role-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    effects = [];
    planeCalls = [];

    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'roles', name: 'Roles' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const link = (sub: string, principal: typeof owner) =>
      host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    await link(subs.owner, owner);
    for (const role of ['member', 'viewer'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
      await link(subs[role], p);
    }

    // The vertical the team owns: private, so every act below is self-serve for its owner.
    await host.admin.registerVertical(staff, { slug: 'acme/hr', name: 'HR', source: 'cli', ownerTenant: tenant });

    const plane = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const method = init?.method ?? 'GET';
          const path = u.pathname.replace(/^\/api/, '') + u.search;
          planeCalls.push(`${method} ${path}`);
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          const acts =
            (method === 'POST' && /^\/verticals\/[^/]+\/channels\/[^/]+\/promote$/.test(u.pathname.replace(/^\/api/, ''))) ||
            (method === 'POST' && /^\/verticals\/[^/]+\/previews$/.test(u.pathname.replace(/^\/api/, ''))) ||
            (method === 'DELETE' && /^\/verticals\/[^/]+\/previews\/[^/]+$/.test(u.pathname.replace(/^\/api/, ''))) ||
            (method === 'POST' && u.pathname.replace(/^\/api/, '') === '/hostnames');
          if (acts) {
            effects.push(`${method} ${path}`);
            if (u.pathname.endsWith('/promote')) return new Response(null, { status: 204 });
            if (method === 'DELETE') return Response.json({ deleted: 'pr-1' });
            if (u.pathname.endsWith('/previews')) {
              return Response.json({ scopeId: 'S', hostname: 'h', url: 'https://h', versionId: 'v1', reused: false });
            }
            return Response.json({ hostname: 'crm-test.example.com', status: 'verifying' }, { status: 200 });
          }
          // A preview must exist for the domain route to find it; that read is the plane's own list.
          if (method === 'GET' && /^\/verticals\/[^/]+\/previews$/.test(u.pathname.replace(/^\/api/, ''))) {
            return Response.json([
              { scopeId: scopeId.parse(ulid()), tag: 'pr-1', versionId: 'v1', forkedFrom: null, expiresAt: null, hostname: null, url: null },
            ]);
          }
          const res = await plane.request(path, init);
          if (method === 'DELETE' && res.ok) effects.push(`${method} ${path}`);
          return res;
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const asRole = (role: keyof typeof subs, method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { cookie: `sb_session=${subs[role]}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  const PROMOTE = ['POST', '/api/deployments/acme%2Fhr/promote', { channel: 'prod', versionId: 'v1' }] as const;
  const DELETE = ['DELETE', '/api/deployments/acme%2Fhr', undefined] as const;
  const PREVIEW_CREATE = ['POST', '/api/deployments/acme%2Fhr/previews', { tag: 'pr-1', versionId: 'v1' }] as const;
  const PREVIEW_DELETE = ['DELETE', '/api/deployments/acme%2Fhr/previews/pr-1', undefined] as const;
  const PREVIEW_DOMAIN = ['POST', '/api/deployments/acme%2Fhr/previews/pr-1/domain', { domain: 'crm-test.example.com' }] as const;

  async function refused(call: readonly [string, string, unknown]) {
    const res = await asRole('viewer', call[0], call[1], call[2]);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/permission denied/i);
    // Refused BEFORE the plane was contacted at all — not after an ownership read, not after
    // a token mint. `effects` alone would stay green with the gate moved below a read.
    expect(planeCalls).toEqual([]);
    expect(effects).toEqual([]);
  }

  async function allowed(call: readonly [string, string, unknown], expectStatus: number[]) {
    // The twin: the roles that manage the team's apps go through the SAME route.
    for (const role of ['owner', 'member'] as const) {
      const res = await asRole(role, call[0], call[1], call[2]);
      expect(expectStatus, `${role}: ${call[0]} ${call[1]} → ${res.status} ${await res.clone().text()}`).toContain(res.status);
    }
    expect(effects.length).toBeGreaterThan(0);
  }

  // -- promote ---------------------------------------------------------------

  it('promote: a viewer is refused', async () => {
    await refused(PROMOTE);
  });
  it('promote: an owner and a member still promote', async () => {
    await allowed(PROMOTE, [204]);
  });

  // -- delete the vertical ---------------------------------------------------

  it('delete vertical: a viewer is refused, and the vertical is still there', async () => {
    await refused(DELETE);
    expect((await host.admin.listVerticals(staff)).map((v) => v.slug)).toContain('acme/hr');
  });
  it('delete vertical: an owner still deletes it', async () => {
    // Owner alone: a second delete would find nothing to delete, which is not what is asked.
    const res = await asRole('owner', ...DELETE);
    expect(res.status).toBe(204);
    expect((await host.admin.listVerticals(staff)).map((v) => v.slug)).not.toContain('acme/hr');
  });
  it('delete vertical: a member still deletes it', async () => {
    const res = await asRole('member', ...DELETE);
    expect(res.status).toBe(204);
    expect((await host.admin.listVerticals(staff)).map((v) => v.slug)).not.toContain('acme/hr');
  });

  // -- create a preview ------------------------------------------------------

  it('create preview: a viewer is refused', async () => {
    await refused(PREVIEW_CREATE);
  });
  it('create preview: an owner and a member still create one', async () => {
    await allowed(PREVIEW_CREATE, [200, 201]);
  });

  // -- reap a preview --------------------------------------------------------

  it('reap preview: a viewer is refused', async () => {
    await refused(PREVIEW_DELETE);
  });
  it('reap preview: an owner and a member still reap one', async () => {
    await allowed(PREVIEW_DELETE, [200]);
  });

  // -- a preview's custom domain ---------------------------------------------

  it('preview domain: a viewer is refused', async () => {
    await refused(PREVIEW_DOMAIN);
  });
  it('preview domain: an owner and a member still bind one', async () => {
    await allowed(PREVIEW_DOMAIN, [200, 201]);
  });
});
