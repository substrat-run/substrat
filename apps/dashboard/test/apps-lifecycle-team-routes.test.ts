import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { dashboardRoutes } from '../src/routes.js';
import { allApps } from '../src/walk-all.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The Apps lifecycle writes — install, remove, retry, resume — declared under
 * `/api/teams/:teamId` (#2170).
 *
 * They drive the WORKER, the way a request reaches it: the facts under test are that the
 * team comes from the path, that the membership check precedes everything, and that the
 * handler still asks the caller's ROLE (`dashboard:provision-app`) in that team. Only the
 * seams the worker cannot run in Node are replaced (see `apps-team-routes`). The control
 * plane behind the service binding is the real one over the same host, except that the
 * vertical round-trip a hosted instance needs (`POST /verticals/…/instances`) is answered,
 * so an install can reach `active`; every plane request is recorded, so "the plane was
 * never asked" is something a refusal can assert.
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

// Named through a variable: `tsconfig.json` excludes `src/worker.ts` (see findings-role-gate).
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown, ctx?: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());
const VERTICAL = 'acme/widgets';

type Dash = Awaited<ReturnType<SqliteScopeHost['getScope']>>;
interface Row {
  id: string;
  app_scope_id: string;
  name: string;
  status: string;
  vertical_slug: string;
}

describe('the Apps lifecycle writes take their team from the path (#2170)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const second = tenantId.parse(ulid());
  const stranger = tenantId.parse(ulid());
  const dashOf = { [tenant]: scopeId.parse(ulid()), [second]: scopeId.parse(ulid()) } as Record<string, ReturnType<typeof scopeId.parse>>;
  const handle: Record<string, Dash> = {};
  /** The first team's apps: one of each state a lifecycle write cares about. */
  const mine = { active: scopeId.parse(ulid()), failed: scopeId.parse(ulid()), stuck: scopeId.parse(ulid()) };
  /** The second team's, same states. */
  const theirs = { active: scopeId.parse(ulid()), failed: scopeId.parse(ulid()), stuck: scopeId.parse(ulid()) };
  let planeCalls: string[];
  let env: Record<string, unknown>;

  const subs = { owner: 'sub-owner', member: 'sub-member', viewer: 'sub-viewer' } as const;

  const appsOf = (t: string) => allApps(handle[t]!);
  const byScope = async (t: string, s: string) => (await appsOf(t)).find((a) => a.app_scope_id === s);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-apps-lifecycle-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    planeCalls = [];

    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.createTenant(staff, { id: stranger, slug: 'stranger', name: 'Stranger' });
    await host.admin.registerVertical(staff, { slug: VERTICAL, name: 'Widgets', source: 'cli' });
    await host.admin.setVerticalListed(staff, VERTICAL, true);
    // The owner is in two teams, each with its own dashboard scope and its own apps.
    for (const [t, own] of [
      [tenant, mine],
      [second, theirs],
    ] as const) {
      const p = principalId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: t, scopeId: dashOf[t]!, owner: p, slug: `t-${t.slice(-6).toLowerCase()}`, name: `Team ${t.slice(-4)}` });
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: subs.owner, principal: p, tenantId: t, scopeId: dashOf[t]! });
      const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
      handle[t] = dash;
      for (const [state, appScopeId] of Object.entries(own)) {
        await dash.invoke('dashboard/provision-app', { appScopeId, verticalSlug: VERTICAL, name: `${state}-${appScopeId.slice(-4)}` });
        if (state === 'active') await dash.invoke('dashboard/mark-app-active', { appScopeId });
        if (state === 'failed') await dash.invoke('dashboard/mark-app-failed', { appScopeId, reason: 'boom' });
      }
    }
    // A member and a viewer of the first team only.
    for (const role of ['member', 'viewer'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: subs[role], principal: p, tenantId: tenant, scopeId: dashOf[tenant]! });
    }

    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '') + u.search;
          const method = init?.method ?? 'GET';
          planeCalls.push(`${method} ${path}`);
          // The vertical's own round-trip (a hosted instance) is the one thing no suite can run.
          if (method === 'POST' && /^\/verticals\/[^/]+\/instances$/.test(u.pathname.replace(/^\/api/, ''))) {
            return Response.json({ ok: true });
          }
          return plane.request(path, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A request as one of the three logins, with whichever team the shared cookie happens to pin. */
  const send = (method: string, path: string, opts: { sub?: string; cookieTeam?: string; body?: unknown } = {}) =>
    app.request(
      path,
      {
        method,
        headers: {
          ...(opts.sub === '' ? {} : { cookie: `sb_session=${opts.sub ?? subs.owner}${opts.cookieTeam ? `; sb_team=${opts.cookieTeam}` : ''}` }),
          'content-type': 'application/json',
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      },
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );

  const INSTALL = { verticalSlug: VERTICAL, name: 'Fresh' };

  /** The four writes against a team, each aimed at an app that team really has. */
  const calls = (t: string, own: typeof mine, rows: { id: string }) =>
    [
      ['install', 'POST', `/api/teams/${t}/apps`, INSTALL],
      ['remove', 'DELETE', `/api/teams/${t}/apps/${rows.id}`, undefined],
      ['retry', 'POST', `/api/teams/${t}/apps/${own.failed}/retry`, undefined],
      ['resume', 'POST', `/api/teams/${t}/apps/${own.stuck}/resume`, undefined],
    ] as const;

  it('a team the caller is not in is a 404 on every write, and neither the plane nor any app is touched', async () => {
    const before = await appsOf(tenant);
    const row = before.find((a) => a.app_scope_id === mine.active)!;
    for (const team of [stranger, tenantId.parse(ulid())]) {
      for (const [name, method, path, body] of calls(team, mine, row)) {
        const res = await send(method, path, { body });
        expect(res.status, `${name} on ${team}`).toBe(404);
      }
    }
    expect(planeCalls).toEqual([]);
    expect(await appsOf(tenant)).toEqual(before);
  });

  it('no session is a 401 before the input is looked at', async () => {
    expect((await send('POST', `/api/teams/${tenant}/apps`, { sub: '', body: { name: '' } })).status).toBe(401);
    for (const [, method, path] of calls(tenant, mine, { id: 'x' })) {
      expect((await send(method, path, { sub: '' })).status, path).toBe(401);
    }
    expect(planeCalls).toEqual([]);
  });

  it('the cookie routes these replaced are gone: nothing answers a lifecycle write by the cookie’s team', async () => {
    const before = await appsOf(tenant);
    const row = before.find((a) => a.app_scope_id === mine.active)!;
    for (const [method, path, body] of [
      ['POST', '/api/apps', INSTALL],
      ['DELETE', `/api/apps/${row.id}`, undefined],
      ['POST', `/api/apps/${mine.failed}/retry`, undefined],
      ['POST', `/api/apps/${mine.stuck}/resume`, undefined],
    ] as const) {
      const res = await send(method, path, { cookieTeam: tenant, body });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(await appsOf(tenant)).toEqual(before);
  });

  describe('a request for team B is not decided by the cookie of team A', () => {
    it('install lands in the team the path names — whichever the cookie pins', async () => {
      const res = await send('POST', `/api/teams/${second}/apps`, { cookieTeam: tenant, body: INSTALL });
      expect(res.status).toBe(201);
      const row = (await res.json()) as Record<string, unknown>;
      expect(row).toMatchObject({ name: 'Fresh', vertical_slug: VERTICAL, status: 'active' });
      // The declared output is the row's published shape; the stored column does not leak.
      expect('deleted_at' in row).toBe(false);
      expect((await appsOf(second)).map((a) => a.name)).toContain('Fresh');
      expect((await appsOf(tenant)).map((a) => a.name)).not.toContain('Fresh');
      // And the other way round.
      expect((await send('POST', `/api/teams/${tenant}/apps`, { cookieTeam: second, body: { ...INSTALL, name: 'Other' } })).status).toBe(201);
      expect((await appsOf(tenant)).map((a) => a.name)).toContain('Other');
      expect((await appsOf(second)).map((a) => a.name)).not.toContain('Other');
    });

    it('an app of team A, asked for through team B’s path, is a 404 and is left exactly as it was', async () => {
      const rowA = (await appsOf(tenant)).find((a) => a.app_scope_id === mine.active)!;
      const beforeA = await appsOf(tenant);
      const beforeB = await appsOf(second);
      for (const [name, method, path] of [
        ['remove', 'DELETE', `/api/teams/${second}/apps/${rowA.id}`],
        ['retry', 'POST', `/api/teams/${second}/apps/${mine.failed}/retry`],
        ['resume', 'POST', `/api/teams/${second}/apps/${mine.stuck}/resume`],
      ] as const) {
        // The cookie pins A, the app is A's, the path names B: B decides, and B has no such app.
        const res = await send(method, path, { cookieTeam: tenant });
        expect(res.status, name).toBe(404);
      }
      expect(await appsOf(tenant)).toEqual(beforeA);
      expect(await appsOf(second)).toEqual(beforeB);
    });

    it('remove, retry and resume act on the path’s own team with the cookie pinning the other', async () => {
      const rowB = (await appsOf(second)).find((a) => a.app_scope_id === theirs.active)!;
      const removed = await send('DELETE', `/api/teams/${second}/apps/${rowB.id}`, { cookieTeam: tenant });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ removed: true });
      expect(await byScope(second, theirs.active)).toBeUndefined();
      // Team A's identically-shaped app is untouched.
      expect((await byScope(tenant, mine.active))?.status).toBe('active');

      const retried = await send('POST', `/api/teams/${second}/apps/${theirs.failed}/retry`, { cookieTeam: tenant });
      expect(retried.status).toBe(201);
      const fresh = (await retried.json()) as Row;
      expect(fresh.app_scope_id).not.toBe(theirs.failed);
      expect(fresh.status).toBe('active');
      expect(await byScope(second, theirs.failed)).toBeUndefined();
      expect((await byScope(tenant, mine.failed))?.status).toBe('failed');

      const resumed = await send('POST', `/api/teams/${second}/apps/${theirs.stuck}/resume`, { cookieTeam: tenant });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ app_scope_id: theirs.stuck, status: 'active' });
      expect((await byScope(tenant, mine.stuck))?.status).toBe('provisioning');
    });
  });

  describe('the status guards of the cookie routes still hold', () => {
    it('retry takes only a failed app, resume only one stuck provisioning (409, nothing written)', async () => {
      const before = await appsOf(tenant);
      for (const s of [mine.active, mine.stuck]) {
        expect((await send('POST', `/api/teams/${tenant}/apps/${s}/retry`)).status, `retry ${s}`).toBe(409);
      }
      for (const s of [mine.active, mine.failed]) {
        expect((await send('POST', `/api/teams/${tenant}/apps/${s}/resume`)).status, `resume ${s}`).toBe(409);
      }
      expect(await appsOf(tenant)).toEqual(before);
    });

    it('an unknown app is a 404 on all three', async () => {
      const ghost = scopeId.parse(ulid());
      for (const [method, path] of [
        ['DELETE', `/api/teams/${tenant}/apps/${ulid()}`],
        ['POST', `/api/teams/${tenant}/apps/${ghost}/retry`],
        ['POST', `/api/teams/${tenant}/apps/${ghost}/resume`],
      ] as const) {
        expect((await send(method, path)).status, path).toBe(404);
      }
    });

    it('install: a vertical whose installs are blocked is a 403 and leaves no row', async () => {
      await host.admin.setVerticalInstallsBlocked(staff, VERTICAL, true);
      const before = await appsOf(tenant);
      const res = await send('POST', `/api/teams/${tenant}/apps`, { body: INSTALL });
      expect(res.status).toBe(403);
      expect(await appsOf(tenant)).toEqual(before);
    });

    it('install: input is parsed at the boundary — a 400 naming the field, before anything is provisioned', async () => {
      const before = await appsOf(tenant);
      for (const body of [{ verticalSlug: VERTICAL }, { ...INSTALL, name: '' }, { ...INSTALL, auth: { source: 'external', issuer: 'http://not-https.example' } }]) {
        expect((await send('POST', `/api/teams/${tenant}/apps`, { body })).status, JSON.stringify(body)).toBe(400);
      }
      expect(await appsOf(tenant)).toEqual(before);
      expect(planeCalls).toEqual([]);
    });
  });

  describe('the write still asks the caller’s role in that team', () => {
    it('a viewer is refused every write (403) and every app is left as it was', async () => {
      const before = await appsOf(tenant);
      const row = before.find((a) => a.app_scope_id === mine.active)!;
      for (const [name, method, path, body] of calls(tenant, mine, row)) {
        const res = await send(method, path, { sub: subs.viewer, body });
        expect(res.status, name).toBe(403);
      }
      expect(await appsOf(tenant)).toEqual(before);
    });

    it('a viewer of team A holds nothing in team B: a 404 there, whichever team the cookie pins', async () => {
      const rowB = (await appsOf(second)).find((a) => a.app_scope_id === theirs.active)!;
      for (const [name, method, path, body] of calls(second, theirs, rowB)) {
        const res = await send(method, path, { sub: subs.viewer, cookieTeam: tenant, body });
        expect(res.status, name).toBe(404);
      }
    });

    it('the twin: a member, who manages apps, goes through the same routes', async () => {
      const row = (await appsOf(tenant)).find((a) => a.app_scope_id === mine.active)!;
      const installed = await send('POST', `/api/teams/${tenant}/apps`, { sub: subs.member, body: INSTALL });
      expect(installed.status, await installed.clone().text()).toBe(201);
      expect((await send('POST', `/api/teams/${tenant}/apps/${mine.failed}/retry`, { sub: subs.member })).status).toBe(201);
      expect((await send('POST', `/api/teams/${tenant}/apps/${mine.stuck}/resume`, { sub: subs.member })).status).toBe(200);
      expect((await send('DELETE', `/api/teams/${tenant}/apps/${row.id}`, { sub: subs.member })).status).toBe(200);
    });
  });

  it('the declared app writes include lifecycle, version, data, preview, identity, environment and email actions', () => {
    expect(
      Object.entries(dashboardRoutes)
        .filter(([name, r]) => r.http.method !== 'GET' && r.http.path.startsWith('/apps') && !name.includes('hostname') && name !== 'dashboard/query-app-scope')
        .map(([name, r]) => `${r.http.method} ${r.http.path} ${name}`)
        .sort(),
    ).toEqual([
      'DELETE /apps/{id} dashboard/remove-app',
      'DELETE /apps/{scopeId}/env/{key} dashboard/delete-app-env',
      'DELETE /apps/{scopeId}/integrations/{provider} dashboard/disconnect-app-integration',
      'DELETE /apps/{scopeId}/integrations/{provider}/connections/{connectionId} dashboard/disconnect-app-connection',
      'DELETE /apps/{scopeId}/snapshots/{snapshotId} dashboard/delete-app-snapshot',
      'POST /apps dashboard/install-app',
      'POST /apps/{scopeId}/bind dashboard/bind-installed-app',
      'POST /apps/{scopeId}/edges/move dashboard/move-app-edge',
      'POST /apps/{scopeId}/email-sender dashboard/set-app-email-sender',
      'POST /apps/{scopeId}/integrations/{provider} dashboard/connect-app-integration',
      'POST /apps/{scopeId}/integrations/{provider}/connections/{connectionId}/verify dashboard/verify-app-connection',
      'POST /apps/{scopeId}/integrations/{provider}/verify dashboard/verify-app-integration',
      'POST /apps/{scopeId}/members dashboard/app-invite-member',
      'POST /apps/{scopeId}/members/{principal}/remove dashboard/app-remove-member',
      'POST /apps/{scopeId}/members/{principal}/role dashboard/app-change-member-role',
      'POST /apps/{scopeId}/owner-claim dashboard/app-owner-claim',
      'POST /apps/{scopeId}/peers/switch dashboard/switch-app-peer',
      // #1749: files an AI note in the team's scope; its team-from-path refusal is in explanations-route.test.ts.
      'POST /apps/{scopeId}/processes/note dashboard/write-process-note',
      'POST /apps/{scopeId}/restore dashboard/restore-installed-app',
      'POST /apps/{scopeId}/resume dashboard/resume-app',
      'POST /apps/{scopeId}/retry dashboard/retry-app',
      'POST /apps/{scopeId}/rewind dashboard/rewind-app',
      'POST /apps/{scopeId}/snapshots dashboard/create-app-snapshot',
      'POST /apps/{scopeId}/update dashboard/update-installed-app',
      'PUT /apps/{scopeId}/auth dashboard/set-app-auth',
      'PUT /apps/{scopeId}/env dashboard/set-app-env',
      'PUT /apps/{scopeId}/peers/binding dashboard/set-app-peer-binding',
    ]);
  });
});
