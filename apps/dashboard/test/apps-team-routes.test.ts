import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { APP_EVENT_KINDS } from '../src/app-event-kinds.js';
import { dashboardMigrations } from '../src/module.js';
import { dashboardRoutes } from '../src/routes.js';
import { rewrittenPlane, SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The Apps read routes, declared under `/api/teams/:teamId` (#2170).
 *
 * The cookie routes (`/api/apps…`) keep working beside them and share ONE implementation,
 * so each case here pairs the team path with its cookie twin: same team, same body.
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

describe('the Apps read routes take their team from the path (#2170)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const second = tenantId.parse(ulid());
  const stranger = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const secondDash = scopeId.parse(ulid());
  /** Three apps in `tenant` (oldest first) and one in `second`. */
  const apps = [scopeId.parse(ulid()), scopeId.parse(ulid()), scopeId.parse(ulid())];
  const secondApp = scopeId.parse(ulid());
  /** The owner's handle on `tenant`'s dashboard scope — where an operation records an app's event. */
  let dash: Awaited<ReturnType<SqliteScopeHost['getScope']>>;
  let planeCalls: string[];
  /** What the list route hands `waitUntil` (the MCP and places reconcile passes) — settled before the host closes. */
  let background: Promise<unknown>[];
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-apps-team-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    planeCalls = [];
    background = [];

    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.createTenant(staff, { id: stranger, slug: 'stranger', name: 'Stranger' });
    // The owner is in two teams, each with its own dashboard scope and its own apps.
    for (const [t, scope, slug, own] of [
      [tenant, dashScope, 'first', apps],
      [second, secondDash, 'second', [secondApp]],
    ] as const) {
      const p = principalId.parse(ulid());
      const node = await provisionDashboard(host, { tenantId: t, scopeId: scope, owner: p, slug, name: slug });
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: p, tenantId: t, scopeId: scope });
      const scopeHandle = await host.getScope(node.principal, node.tenantId, node.scopeId);
      if (t === tenant) dash = scopeHandle;
      for (const appScopeId of own) {
        await scopeHandle.invoke('dashboard/provision-app', { appScopeId, verticalSlug: 'acme/widgets', name: `${slug}-${appScopeId.slice(-4)}` });
      }
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
          planeCalls.push(`${init?.method ?? 'GET'} ${path}`);
          return plane.request(path, init);
        },
      },
    };
  });

  afterEach(async () => {
    await Promise.allSettled(background);
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The owner's request, with whichever team the shared cookie happens to pin. */
  const get = (path: string, cookieTeam?: string) =>
    app.request(
      path,
      { headers: { cookie: `sb_session=sub-owner${cookieTeam ? `; sb_team=${cookieTeam}` : ''}` } },
      env,
      { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => undefined },
    );
  const json = async (res: Response) => {
    expect(res.status).toBe(200);
    return (await res.json()) as { entries: Array<Record<string, unknown>>; nextCursor: string | null };
  };

  it('a caller in two teams lists the apps of the team the path names, whatever the cookie pins', async () => {
    const mine = await json(await get(`/api/teams/${tenant}/apps`, second));
    expect(mine.entries.map((a) => a.app_scope_id).sort()).toEqual([...apps].sort());
    const theirs = await json(await get(`/api/teams/${second}/apps`, tenant));
    expect(theirs.entries.map((a) => a.app_scope_id)).toEqual([secondApp]);
  });

  it('the cookie list route is gone, and the declared one answers its output schema alone', async () => {
    // The last caller of the cookie list (the Domains view's app picker) moved to the path.
    expect((await get('/api/apps', tenant)).status).toBe(404);
    for (const t of [tenant, second]) {
      const declared = await json(await get(`/api/teams/${t}/apps`));
      expect(declared.entries.length).toBeGreaterThan(0);
      // The stored column the cookie route used to leak (`deleted_at`) is not in the published shape.
      expect(declared.entries.some((a) => 'deleted_at' in a)).toBe(false);
    }
  });

  it('pages by cursor: every app once, newest first, and a declared limit is enforced', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await json(await get(`/api/teams/${tenant}/apps${q}`));
      expect(page.entries.length).toBeLessThanOrEqual(2);
      seen.push(...page.entries.map((a) => a.app_scope_id as string));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(apps));
    for (const q of ['limit=0', 'limit=201', 'limit=1.5', 'cursor=']) {
      expect((await get(`/api/teams/${tenant}/apps?${q}`)).status, q).toBe(400);
    }
  });

  it('install steps and events: same as the cookie route, and only for the path’s own team', async () => {
    const [a] = apps;
    expect(await (await get(`/api/teams/${tenant}/apps/${a}/steps`, second)).json()).toEqual(
      await (await get(`/api/apps/${a}/steps`, tenant)).json(),
    );
    const events = await json(await get(`/api/teams/${tenant}/apps/${a}/events`, second));
    expect(events.entries.map((e) => e.kind)).toEqual(['created']);
    expect(events).toEqual(await json(await get(`/api/apps/${a}/events`, tenant)));
    // The twin that matters: another team's app, asked through this team's path, has no trail here.
    const foreign = await json(await get(`/api/teams/${tenant}/apps/${secondApp}/events`, tenant));
    expect(foreign.entries).toEqual([]);
  });

  describe('the declared output is every shape the cookie route can return', () => {
    it('events: a hostname bind, an unbind and a resume read back — not a 400 from the output parse', async () => {
      const [a] = apps;
      await dash.invoke('dashboard/bind-app-hostname', { appScopeId: a, detail: 'shop.example.com' });
      await dash.invoke('dashboard/unbind-app-hostname', { appScopeId: a, detail: 'shop.example.com' });
      await dash.invoke('dashboard/resume-app', { appScopeId: a });
      const declared = await json(await get(`/api/teams/${tenant}/apps/${a}/events`));
      expect(declared.entries.map((e) => e.kind).sort()).toEqual(['created', 'hostname-bound', 'hostname-unbound', 'resumed']);
      expect(declared).toEqual(await json(await get(`/api/apps/${a}/events`, tenant)));
    });

    it('drift: every kind the shared constant lists is accepted by the route’s output schema', () => {
      const output = dashboardRoutes['dashboard/list-app-events'].output;
      for (const kind of APP_EVENT_KINDS) {
        const row = { id: 'E', app_scope_id: 'S', kind, detail: null, actor: 'A', created_at: '2026-10-12T00:00:00.000Z' };
        expect(output.safeParse({ entries: [row], nextCursor: null }).success, kind).toBe(true);
      }
    });

    it('drift: the constant is exactly the kinds the table’s latest CHECK admits', () => {
      const checks = dashboardMigrations
        .map((m) => /dashboard_app_events_new \([\s\S]*?kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(m.sql)?.[1])
        .filter((list): list is string => list !== undefined);
      const latest = checks[checks.length - 1]!.split(',').map((k) => k.trim().replace(/'/g, ''));
      expect([...APP_EVENT_KINDS].sort()).toEqual(latest.sort());
    });

    it('steps: recorded running, done and failed steps read back through the declared schema', async () => {
      const [a] = apps;
      await dash.invoke('dashboard/record-install-step', { appScopeId: a, step: 'directory', seq: 0, status: 'done' });
      await dash.invoke('dashboard/record-install-step', { appScopeId: a, step: 'provision', seq: 1, status: 'failed', error: 'boom' });
      await dash.invoke('dashboard/record-install-step', { appScopeId: a, step: 'activate', seq: 2, status: 'running' });
      const res = await get(`/api/teams/${tenant}/apps/${a}/steps`);
      expect(res.status).toBe(200);
      const steps = (await res.json()) as Array<{ step: string; status: string; last_error: string | null }>;
      expect(steps.map((s) => [s.step, s.status, s.last_error])).toEqual([
        ['directory', 'done', null],
        ['provision', 'failed', 'boom'],
        ['activate', 'running', null],
      ]);
      // The cookie route also leaks the row's `app_scope_id` (the caller already holds it); the declared one answers its schema.
      const old = (await (await get(`/api/apps/${a}/steps`, tenant)).json()) as Array<{ app_scope_id: string }>;
      expect(steps).toEqual(old.map(({ app_scope_id: _same, ...row }) => row));
    });
  });

  it('audit: an empty ?scopeId= is no narrowing on either route — the whole team log', async () => {
    const whole = await json(await get(`/api/teams/${tenant}/audit`));
    expect(await json(await get(`/api/teams/${tenant}/audit?scopeId=`))).toEqual(whole);
    expect(await json(await get('/api/audit?scopeId=', tenant))).toEqual(whole);
  });

  it('audit: a foreign scopeId is a 404 even where no control plane is bound; an own one then needs it (503)', async () => {
    const unbound = { ...env, CONTROL_PLANE_SVC: undefined };
    const ask = (path: string) =>
      app.request(path, { headers: { cookie: `sb_session=sub-owner; sb_team=${tenant}` } }, unbound, {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      });
    for (const path of [`/api/teams/${tenant}/apps/${secondApp}/audit`, `/api/teams/${tenant}/audit?scopeId=${secondApp}`, `/api/apps/${secondApp}/audit`, `/api/audit?scopeId=${secondApp}`]) {
      expect((await ask(path)).status, path).toBe(404);
    }
    expect((await ask(`/api/teams/${tenant}/apps/${apps[0]}/audit`)).status).toBe(503);
  });

  it('audit: the team log and one app’s log match the cookie routes; a foreign app is a 404', async () => {
    const whole = await json(await get(`/api/teams/${tenant}/audit`, second));
    expect(whole.entries.length).toBeGreaterThan(0);
    expect(whole).toEqual(await json(await get('/api/audit', tenant)));
    const [a] = apps;
    expect(await json(await get(`/api/teams/${tenant}/apps/${a}/audit`, second))).toEqual(
      await json(await get(`/api/apps/${a}/audit`, tenant)),
    );
    expect(await json(await get(`/api/teams/${tenant}/audit?scopeId=${a}`, second))).toEqual(
      await json(await get(`/api/audit?scopeId=${a}`, tenant)),
    );
    expect((await get(`/api/teams/${tenant}/apps/${secondApp}/audit`)).status).toBe(404);
    expect((await get(`/api/teams/${tenant}/audit?scopeId=${secondApp}`)).status).toBe(404);
  });

  it('audit (#2401): an action and an audited outcome this dashboard does not know are listed as the plane named them, on both routes', async () => {
    // The plane owns both sets: a newer one names an action, or an outcome, the dashboard's contracts do not.
    env.CONTROL_PLANE_SVC = rewrittenPlane(
      env.CONTROL_PLANE_SVC,
      (p) => p.endsWith('/admin-log'),
      (body) => {
        const page = body as { entries: Array<Record<string, unknown>> };
        return { ...page, entries: page.entries.map((e) => ({ ...e, action: 'frobnicateScope', audited: { operationId: 'op-1', outcome: 'reconsidered', superseded: false } })) };
      },
    );
    const [a] = apps;
    // One admin action against the app, so its own log has a row to answer.
    await host.provisionScope(staff, { tenantId: tenant, scopeId: a! });
    for (const path of [`/api/teams/${tenant}/audit`, `/api/teams/${tenant}/audit?scopeId=${a}`, `/api/teams/${tenant}/apps/${a}/audit`]) {
      const page = await json(await get(path));
      expect(page.entries.length, path).toBeGreaterThan(0);
      for (const e of page.entries) expect(e, path).toMatchObject({ action: 'frobnicateScope', audited: { outcome: 'reconsidered' } });
    }
  });

  it('a team the caller is not in is a 404 on every route, and the plane is not asked', async () => {
    const [a] = apps;
    for (const team of [stranger, tenantId.parse(ulid())]) {
      for (const p of ['/apps', `/apps/${a}/steps`, `/apps/${a}/events`, `/apps/${a}/audit`, '/audit']) {
        expect((await get(`/api/teams/${team}${p}`)).status, `${team}${p}`).toBe(404);
      }
    }
    expect(planeCalls).toEqual([]);
  });

  it('no session is a 401 before the input is looked at', async () => {
    const res = await app.request(`/api/teams/${tenant}/apps?limit=0`, { headers: {} }, env);
    expect(res.status).toBe(401);
  });
});
