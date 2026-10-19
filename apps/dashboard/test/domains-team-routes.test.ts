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
import { patchRows, rewrittenPlane, SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The Domains area — the team's custom domains and each app's hostnames — declared under
 * `/api/teams/:teamId` (#2170).
 *
 * They drive the WORKER, the way a request reaches it: the facts under test are that the
 * team comes from the path, that the membership check precedes everything, and that the
 * app-level writes still ask the caller's ROLE (`dashboard:provision-app`) in that team. Only the
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


describe('the Domains routes take their team from the path (#2170)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const second = tenantId.parse(ulid());
  const stranger = tenantId.parse(ulid());
  const dashOf = { [tenant]: scopeId.parse(ulid()), [second]: scopeId.parse(ulid()) } as Record<string, ReturnType<typeof scopeId.parse>>;
  const handle: Record<string, Dash> = {};
  /** Each team's installed app: a real scope in the directory, with its default hostname bound. */
  let mine: string;
  let theirs: string;
  let mineRow: Row & { hostname: string };
  let theirsRow: Row & { hostname: string };
  let planeCalls: string[];
  let env: Record<string, unknown>;

  const subs = { owner: 'sub-owner', member: 'sub-member', viewer: 'sub-viewer' } as const;
  const appsOf = (t: string) => allApps(handle[t]!);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-domains-team-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    planeCalls = [];

    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.createTenant(staff, { id: stranger, slug: 'stranger', name: 'Stranger' });
    await host.admin.registerVertical(staff, { slug: VERTICAL, name: 'Widgets', source: 'cli' });
    await host.admin.setVerticalListed(staff, VERTICAL, true);
    for (const t of [tenant, second]) {
      const p = principalId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: t, scopeId: dashOf[t]!, owner: p, slug: `t-${t.slice(-6).toLowerCase()}`, name: `Team ${t.slice(-4)}` });
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: subs.owner, principal: p, tenantId: t, scopeId: dashOf[t]! });
      const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
      handle[t] = dash;
    }
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

  beforeEach(async () => {
    mineRow = await install(tenant, 'Mine');
    theirsRow = await install(second, 'Theirs');
    mine = mineRow.app_scope_id;
    theirs = theirsRow.app_scope_id;
    planeCalls = [];
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const install = async (t: string, name: string) => {
    const res = await send('POST', `/api/teams/${t}/apps`, { body: { verticalSlug: VERTICAL, name } });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Row & { hostname: string };
  };

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

  const DOMAIN = { hostname: 'Shop.Acme.Example', appScopeId: '' };
  const hostsOf = async (t: string, appScope: string) =>
    ((await (await send('GET', `/api/teams/${t}/apps/${appScope}/hostnames`)).json()) as { bindings: { hostname: string }[] }).bindings.map((b) => b.hostname);
  const domainsOf = async (t: string) =>
    ((await (await send('GET', `/api/teams/${t}/domains`)).json()) as { entries: { hostname: string }[] }).entries.map((d) => d.hostname);

  /** The seven declared routes against a team, each aimed at an app that team really has. */
  const calls = (t: string, appScope: string) =>
    [
      ['list-domains', 'GET', `/api/teams/${t}/domains`, undefined],
      ['add-domain', 'POST', `/api/teams/${t}/domains`, { ...DOMAIN, appScopeId: appScope }],
      ['verify-domain', 'POST', `/api/teams/${t}/domains/shop.acme.example/verify`, undefined],
      ['remove-domain', 'DELETE', `/api/teams/${t}/domains/shop.acme.example`, undefined],
      ['list-app-hostnames', 'GET', `/api/teams/${t}/apps/${appScope}/hostnames`, undefined],
      ['add-app-hostname', 'POST', `/api/teams/${t}/apps/${appScope}/hostnames`, { surface: 'admin', domain: 'admin.acme.example' }],
      ['remove-app-hostname', 'DELETE', `/api/teams/${t}/apps/${appScope}/hostnames/admin.acme.example`, undefined],
    ] as const;

  it('a team the caller is not in is a 404 on every route, and the plane is never asked', async () => {
    for (const team of [stranger, tenantId.parse(ulid())]) {
      for (const [name, method, path, body] of calls(team, mine)) {
        expect((await send(method, path, { body })).status, `${name} on ${team}`).toBe(404);
      }
    }
    expect(planeCalls).toEqual([]);
  });

  it('no session is a 401 before the input is looked at', async () => {
    for (const [name, method, path] of calls(tenant, mine)) {
      expect((await send(method, path, { sub: '', body: name === 'add-domain' ? {} : undefined })).status, name).toBe(401);
    }
    expect(planeCalls).toEqual([]);
  });

  it('the cookie routes these replaced are gone — and so is the cookie app list', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/domains', undefined],
      ['POST', '/api/domains', { ...DOMAIN, appScopeId: mine }],
      ['POST', '/api/domains/shop.acme.example/verify', undefined],
      ['DELETE', '/api/domains/shop.acme.example', undefined],
      ['GET', `/api/apps/${mine}/hostnames`, undefined],
      ['POST', `/api/apps/${mine}/hostnames`, { surface: 'admin' }],
      ['DELETE', `/api/apps/${mine}/hostnames/admin.acme.example`, undefined],
      ['GET', '/api/apps', undefined],
    ] as const) {
      const res = await send(method, path, { cookieTeam: tenant, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(planeCalls).toEqual([]);
  });

  describe('a request for team B is not decided by the cookie of team A', () => {
    it('add, list, verify and remove a domain act on the path’s own team with the cookie pinning the other', async () => {
      const added = await send('POST', `/api/teams/${second}/domains`, { cookieTeam: tenant, body: { ...DOMAIN, appScopeId: theirs } });
      expect(added.status).toBe(201);
      // Lower-cased, and the control plane's published row shape (status + the DNS records to publish).
      expect(await added.json()).toMatchObject({ hostname: 'shop.acme.example', status: 'pending', validationRecords: [] });
      expect(await domainsOf(second)).toEqual(['shop.acme.example']);
      expect(await domainsOf(tenant)).toEqual([]);
      const listed = await send('GET', `/api/teams/${second}/domains`, { cookieTeam: tenant });
      expect(await listed.json()).toMatchObject({
        entries: [{ hostname: 'shop.acme.example', appScopeId: theirs, app: 'Theirs', surface: 'app', primary: false }],
        nextCursor: null,
      });
      const verified = await send('POST', `/api/teams/${second}/domains/shop.acme.example/verify`, { cookieTeam: tenant });
      expect(verified.status).toBe(200);
      expect(await verified.json()).toMatchObject({ hostname: 'shop.acme.example' });
      // Team A cannot touch it through its own path: the plane narrows to A, which holds no such domain.
      expect((await send('POST', `/api/teams/${tenant}/domains/shop.acme.example/verify`, { cookieTeam: second })).status).toBe(404);
      expect((await send('DELETE', `/api/teams/${tenant}/domains/shop.acme.example`, { cookieTeam: second })).status).toBe(404);
      expect(await domainsOf(second)).toEqual(['shop.acme.example']);

      const removed = await send('DELETE', `/api/teams/${second}/domains/Shop.Acme.Example`, { cookieTeam: tenant });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ deleted: 'shop.acme.example' });
      expect(await domainsOf(second)).toEqual([]);
    });

    it('an app of team A, asked for through team B’s path, is a 404 on add-domain and on every hostname route', async () => {
      const beforeA = await hostsOf(tenant, mine);
      for (const [name, method, path, body] of calls(second, mine).filter(([n]) => ['add-domain', 'list-app-hostnames', 'add-app-hostname', 'remove-app-hostname'].includes(n))) {
        // The cookie pins A, the app is A's, the path names B: B decides, and B has no such app.
        expect((await send(method, path, { cookieTeam: tenant, body })).status, name).toBe(404);
      }
      expect(await hostsOf(tenant, mine)).toEqual(beforeA);
      expect(await domainsOf(tenant)).toEqual([]);
      expect(await domainsOf(second)).toEqual([]);
    });

    it('app hostnames list, bind and unbind in the path’s own team', async () => {
      const bound = await send('POST', `/api/teams/${second}/apps/${theirs}/hostnames`, { cookieTeam: tenant, body: { surface: 'admin', domain: 'Admin.Acme.Example' } });
      expect(bound.status).toBe(201);
      expect(await bound.json()).toMatchObject({ hostname: 'admin.acme.example', surface: 'admin', canonical: true, status: 'pending' });
      const view = (await (await send('GET', `/api/teams/${second}/apps/${theirs}/hostnames`, { cookieTeam: tenant })).json()) as {
        bindings: { hostname: string }[];
        defaultHostname: string;
      };
      expect(view.defaultHostname).toBe(theirsRow.hostname);
      expect(view.bindings.map((b) => b.hostname).sort()).toEqual(['admin.acme.example', theirsRow.hostname].sort());
      // Team A's own app is untouched, and the domain shows in B's team list, not A's.
      expect(await hostsOf(tenant, mine)).toEqual([mineRow.hostname]);
      expect(await domainsOf(second)).toEqual(['admin.acme.example']);

      const unbound = await send('DELETE', `/api/teams/${second}/apps/${theirs}/hostnames/admin.acme.example`, { cookieTeam: tenant });
      expect(unbound.status).toBe(200);
      expect(await unbound.json()).toEqual({ deleted: 'admin.acme.example' });
      expect(await hostsOf(second, theirs)).toEqual([theirsRow.hostname]);
    });
  });

  describe('the guards of the cookie routes still hold', () => {
    it('add-domain: an unknown app is a 404 and nothing is bound; bad input is a 400 before the plane', async () => {
      expect((await send('POST', `/api/teams/${tenant}/domains`, { body: { ...DOMAIN, appScopeId: scopeId.parse(ulid()) } })).status).toBe(404);
      expect(planeCalls).toEqual([]);
      for (const body of [{ appScopeId: mine }, { ...DOMAIN, hostname: '  ', appScopeId: mine }, { ...DOMAIN, hostname: 'x'.repeat(254), appScopeId: mine }]) {
        expect((await send('POST', `/api/teams/${tenant}/domains`, { body })).status, JSON.stringify(body)).toBe(400);
      }
      expect(planeCalls).toEqual([]);
      expect(await domainsOf(tenant)).toEqual([]);
    });

    it('remove-domain: a hostname the team does not own is a 404 — another team’s domain is left alone', async () => {
      expect((await send('POST', `/api/teams/${second}/domains`, { body: { ...DOMAIN, appScopeId: theirs } })).status).toBe(201);
      expect((await send('DELETE', `/api/teams/${tenant}/domains/shop.acme.example`)).status).toBe(404);
      expect(await domainsOf(second)).toEqual(['shop.acme.example']);
    });

    it('app hostnames: the default hostname is refused (409), an unbound one is a 404, and a platform name cannot be typed in', async () => {
      expect((await send('DELETE', `/api/teams/${tenant}/apps/${mine}/hostnames/${mineRow.hostname}`)).status).toBe(409);
      expect((await send('DELETE', `/api/teams/${tenant}/apps/${mine}/hostnames/nope.acme.example`)).status).toBe(404);
      expect((await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { body: { surface: 'admin', domain: 'x.substrat.run' } })).status).toBe(409);
      expect(await hostsOf(tenant, mine)).toEqual([mineRow.hostname]);
    });

    it('app hostnames: the platform mint (no domain) lands active on its own label', async () => {
      const res = await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { body: { surface: 'admin' } });
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await res.json()).toMatchObject({ surface: 'admin', status: 'active', canonical: true });
    });

    it('add-app-hostname: bad input is a 400 before anything is bound', async () => {
      for (const body of [{}, { surface: '' }, { surface: 'x'.repeat(33) }, { surface: 'admin', domain: '' }]) {
        expect((await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { body })).status, JSON.stringify(body)).toBe(400);
      }
      expect(await hostsOf(tenant, mine)).toEqual([mineRow.hostname]);
    });
  });

  describe('app hostname writes still ask the caller’s role in that team', () => {
    it('a viewer is refused bind and unbind (403) and the bindings are left as they were', async () => {
      expect((await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { body: { surface: 'admin', domain: 'admin.acme.example' } })).status).toBe(201);
      const before = await hostsOf(tenant, mine);
      expect((await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { sub: subs.viewer, body: { surface: 'second', domain: 'second.acme.example' } })).status).toBe(403);
      expect((await send('DELETE', `/api/teams/${tenant}/apps/${mine}/hostnames/admin.acme.example`, { sub: subs.viewer })).status).toBe(403);
      expect(await hostsOf(tenant, mine)).toEqual(before);
    });

    it('a viewer of team A holds nothing in team B: a 404 there, whichever team the cookie pins', async () => {
      for (const [name, method, path, body] of calls(second, theirs)) {
        expect((await send(method, path, { sub: subs.viewer, cookieTeam: tenant, body })).status, name).toBe(404);
      }
    });

    it('the twin: a member, who manages apps, binds and unbinds through the same routes', async () => {
      expect((await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { sub: subs.member, body: { surface: 'admin', domain: 'admin.acme.example' } })).status).toBe(201);
      expect((await send('DELETE', `/api/teams/${tenant}/apps/${mine}/hostnames/admin.acme.example`, { sub: subs.member })).status).toBe(200);
    });
  });

  /**
   * #2401: the plane owns the hostname statuses and the DNS record types. One this dashboard does
   * not know is answered as the plane named it, never refused: for add-domain the bind has already
   * committed by the time the answer is read, so a refusal would report a failure for a write that
   * happened.
   */
  describe('a plane newer than this dashboard', () => {
    const FUTURE_RECORD = { type: 'cname-flattened', name: '_x.acme.example', value: 'edge.example', status: null };
    beforeEach(() => {
      // Every hostname row the plane answers, in a status and with a record type this dashboard does not know.
      env.CONTROL_PLANE_SVC = rewrittenPlane(
        env.CONTROL_PLANE_SVC,
        (p) => p.includes('/hostnames'),
        patchRows((o) => ('hostname' in o && 'status' in o ? { ...o, status: 'quarantined', validationRecords: [FUTURE_RECORD] } : undefined)),
      );
    });

    it('add-domain answers 201 for the bind that committed; list and verify answer 200; each as the plane named it', async () => {
      const added = await send('POST', `/api/teams/${tenant}/domains`, { body: { ...DOMAIN, appScopeId: mine } });
      expect(added.status, await added.clone().text()).toBe(201);
      expect(await added.json()).toMatchObject({ hostname: 'shop.acme.example', status: 'quarantined', validationRecords: [FUTURE_RECORD] });
      const listed = await send('GET', `/api/teams/${tenant}/domains`);
      expect(listed.status, await listed.clone().text()).toBe(200);
      expect(await listed.json()).toMatchObject({ entries: [{ hostname: 'shop.acme.example', status: 'quarantined', validationRecords: [FUTURE_RECORD] }] });
      const verified = await send('POST', `/api/teams/${tenant}/domains/shop.acme.example/verify`);
      expect(verified.status, await verified.clone().text()).toBe(200);
      expect(await verified.json()).toMatchObject({ hostname: 'shop.acme.example', status: 'quarantined', validationRecords: [FUTURE_RECORD] });
    });

    it('an app’s hostnames: the bind answers 201 and the list 200, with the record type as the plane named it', async () => {
      const bound = await send('POST', `/api/teams/${tenant}/apps/${mine}/hostnames`, { body: { surface: 'admin', domain: 'admin.acme.example' } });
      expect(bound.status, await bound.clone().text()).toBe(201);
      expect(await bound.json()).toMatchObject({ hostname: 'admin.acme.example', status: 'quarantined', validationRecords: [FUTURE_RECORD] });
      const listed = await send('GET', `/api/teams/${tenant}/apps/${mine}/hostnames`);
      expect(listed.status, await listed.clone().text()).toBe(200);
      expect(await listed.json()).toMatchObject({ bindings: expect.arrayContaining([expect.objectContaining({ hostname: 'admin.acme.example', validationRecords: [FUTURE_RECORD] })]) });
    });
  });

  it('the declared surface lists exactly the seven domain routes', () => {
    expect(
      Object.entries(dashboardRoutes)
        // A preview's custom domain is the Deployments area's, not this one's.
        .filter(([name]) => /domain|hostname/.test(name) && !name.includes('preview'))
        .map(([name, r]) => `${r.http.method} ${r.http.path} ${name}`)
        .sort(),
    ).toEqual([
      'DELETE /apps/{scopeId}/hostnames/{hostname} dashboard/remove-app-hostname',
      'DELETE /domains/{hostname} dashboard/remove-domain',
      'GET /apps/{scopeId}/hostnames dashboard/list-app-hostnames',
      'GET /domains dashboard/list-domains',
      'POST /apps/{scopeId}/hostnames dashboard/add-app-hostname',
      'POST /domains dashboard/add-domain',
      'POST /domains/{hostname}/verify dashboard/verify-domain',
    ]);
  });
});
