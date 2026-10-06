import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  createControlPlaneApi,
  serviceTokenAuth,
  tenantTokenAuth,
  type VerticalClient,
} from '@substrat-run/control-plane-api';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * #2064, end to end from the dashboard's own route to the plane that audits the change: a member
 * change that WENT THROUGH but whose admin-log outcome row could not be written. The plane
 * answers that as a success carrying `auditWarning`, and the dashboard relays it as one: the
 * invite's one-time accept link reaches the browser, rather than an error the user retries into
 * a second invite. The real control-plane API stands behind the service binding here, not a
 * recorder, so the shape relayed is the one the producer writes.
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
const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
const SERVICE_TOKEN = 'service-token';
const TENANT_SECRET = 'tenant-token-secret';

describe('a member change whose outcome row is lost reaches the dashboard as a success (#2064)', () => {
  let dirs: string[];
  let host: SqliteScopeHost;
  let plane: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  const member = principalId.parse(ulid());
  let env: Record<string, unknown>;

  const vertical = {
    inviteMember: async () => ({ principal: member, roleKey: 'agent', email: null, acceptUrl: 'https://desk.example/?invite=once' }),
    changeMemberRole: async () => undefined,
    removeMember: async () => ({ revoked: ['agent'], unbound: 1, inviteWithdrawn: false }),
  } as unknown as VerticalClient;

  beforeEach(async () => {
    dirs = [mkdtempSync(join(tmpdir(), 'substrat-members-audit-')), mkdtempSync(join(tmpdir(), 'substrat-members-plane-'))];
    host = new SqliteScopeHost({ dir: dirs[0]! });
    plane = new SqliteScopeHost({ dir: dirs[1]! });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'members', name: 'Members' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: 'acme/desk', name: 'Desk' });

    // The plane's directory: the same tenant and app scope, bound to a hostname for the link.
    await plane.admin.createTenant(staff, { id: tenant, slug: 'members', name: 'Members' });
    await plane.provisionScope(staff, { tenantId: tenant, scopeId: appScope, vertical: 'acme/desk' });
    await plane.admin.activateScope(staff, tenant, appScope);
    await plane.admin.bindHostname(staff, {
      hostname: 'members-desk.global.substrat.run', tenantId: tenant, scopeId: appScope, surface: 'app', region: null, canonical: true,
    });
    // Every admin row written for the person fails on `applied`: the change goes through, its row does not.
    const attributed = plane.attributed;
    plane.attributed = (...args: Parameters<SqliteScopeHost['attributed']>) => {
      const view = attributed.apply(plane, args);
      const record = view.admin.recordMemberChange;
      view.admin.recordMemberChange = async (actor, entry) => {
        if (entry.phase === 'applied') throw new Error('admin log unavailable');
        return record(actor, entry);
      };
      return view;
    };
    const api = createControlPlaneApi({
      host: plane,
      authenticate: serviceTokenAuth(SERVICE_TOKEN, serviceActor),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      tenantTokenSecret: TENANT_SECRET,
      verticals: { 'acme/desk': vertical },
    });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          return api.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, init);
        },
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await host.close();
    await plane.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const call = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, env);

  it('the invite answers 201 with its accept link and the warning; the role change and removal answer success too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invited = await call(`/api/apps/${appScope}/members`, { roleKey: 'agent' });
    expect(invited.status).toBe(201);
    const link = (await invited.json()) as { acceptUrl: string; auditWarning: string; operationId: string };
    expect(link.acceptUrl).toBe('https://desk.example/?invite=once');
    expect(link.auditWarning).toMatch(/the invite completed, but its outcome could not be written/);
    expect(link.operationId).toEqual(expect.any(String));

    const moved = await call(`/api/apps/${appScope}/members/${member}/role`, { from: 'agent', to: 'lead' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { auditWarning: string }).auditWarning).toMatch(/the role change completed/);

    const removed = await call(`/api/apps/${appScope}/members/${member}/remove`, {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ revoked: ['agent'], auditWarning: expect.stringMatching(/the removal completed/) });
  });

  it('twin: with the log writable the same invite answers 201 with no warning', async () => {
    plane.attributed = SqliteScopeHost.prototype.attributed;
    const invited = await call(`/api/apps/${appScope}/members`, { roleKey: 'agent' });
    expect(invited.status).toBe(201);
    const link = (await invited.json()) as Record<string, unknown>;
    expect(link.acceptUrl).toBe('https://desk.example/?invite=once');
    expect(link).not.toHaveProperty('auditWarning');
  });
});
