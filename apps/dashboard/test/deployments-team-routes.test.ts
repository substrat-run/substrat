import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { dashboardRoutes } from '../src/routes.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The Deployments & previews area on the declared, team-scoped surface (#2170): the team's
 * pushed verticals, their promote/review/history/failures/releases/traffic/issues reads, the
 * installs a vertical still backs, and its previews, each under `/api/teams/:teamId`.
 *
 * Driven through the WORKER over a SQLite host, with the real control plane behind the service
 * binding (only the acts that need a dispatch namespace are recorded instead of run, so "the
 * plane was never asked" is something a test can fail on). Three teams: `sub-a` owns A and is
 * also an owner of B (one login, two teams); C is a stranger's. Each owns one vertical.
 *
 * Every claim is about WHICH TEAM decides: the path names it, the cookie does not, and a team
 * (or a vertical, or an install) that is not the caller's answers exactly as one that does not
 * exist — so the answer is no oracle for another team's resources.
 */
const shared = vi.hoisted(() => ({
  host: null as unknown,
  sessions: new Map<string, { id: string; email: string; name: string; emailVerified: boolean }>(),
  /** The tenant of every scope the worker opened, in order. */
  scopesOpened: [] as string[],
}));

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
          if (key === 'getScope') {
            return (...a: Parameters<SqliteScopeHost['getScope']>) => {
              shared.scopesOpened.push(a[1]);
              return (t as SqliteScopeHost).getScope(...a);
            };
          }
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
  verifySession: async (_env: unknown, token: string | undefined) => (token ? (shared.sessions.get(token) ?? null) : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());

let dir: string;
let host: SqliteScopeHost;
let env: Record<string, unknown>;
/** What the plane was asked to DO (not to read). */
let effects: string[];
/** EVERY request that reached the plane's service binding. */
let planeCalls: string[];
/** Answers a plane request itself (a plane newer than this dashboard), or declines with undefined. */
let planeAnswers: ((method: string, path: string) => Response | undefined) | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-deployments-team-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  shared.sessions.clear();
  shared.scopesOpened.length = 0;
  effects = [];
  planeCalls = [];
  planeAnswers = null;
  for (const m of MODULES) host.registerModule(m);
  await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });

  const plane = tenantPlane(host, staff);
  const stripApi = (u: URL) => u.pathname.replace(/^\/api/, '');
  env = {
    SCOPE: {},
    CONTROL_PLANE: {},
    SESSION_SECRET: 'test-session-secret',
    CP_SERVICE_TOKEN: SERVICE_TOKEN,
    SWEEPER: { idFromName: (name: string) => name, get: () => ({ noteScope: async () => ({ scopes: 1 }) }) },
    CONTROL_PLANE_SVC: {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        const method = init?.method ?? 'GET';
        const path = stripApi(u);
        planeCalls.push(`${method} ${path}${u.search}`);
        const record = () => effects.push(`${method} ${path}`);
        const newer = planeAnswers?.(method, path);
        if (newer) {
          if (method !== 'GET') record();
          return newer;
        }
        // The acts that need a dispatch namespace this host has none of: recorded, not run.
        if (method === 'POST' && /^\/verticals\/[^/]+\/channels\/[^/]+\/promote$/.test(path)) {
          record();
          return new Response(null, { status: 204 });
        }
        if (method === 'POST' && /^\/verticals\/[^/]+\/previews$/.test(path)) {
          record();
          return Response.json({ scopeId: 'S', hostname: 'h', url: 'https://h', versionId: 'v1', reused: true });
        }
        if (method === 'DELETE' && /^\/verticals\/[^/]+\/previews\/[^/]+$/.test(path)) {
          record();
          return Response.json({ deleted: 'pr-1' });
        }
        if (method === 'POST' && path === '/hostnames') {
          record();
          return Response.json({ hostname: 'crm-test.example.com', scopeId: 'S', surface: 'app', status: 'verifying', canonical: false, createdAt: '2026-10-18T00:00:00.000Z' });
        }
        if (method === 'POST' && /\/scopes\/[^/]+\/rebind-vertical$/.test(path)) {
          record();
          return Response.json({});
        }
        if (method === 'GET' && /^\/verticals\/[^/]+\/previews$/.test(path)) {
          return Response.json([{ scopeId: ulid(), tag: 'pr-1', versionId: 'v1', forkedFrom: null, expiresAt: null, hostname: null, url: null }]);
        }
        const res = await plane.request(path + u.search, init);
        if (method === 'DELETE' && res.ok) record();
        return res;
      },
    },
  };
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Team {
  tenant: TenantId;
  dashScope: ScopeId;
  /** The vertical the team pushed. */
  vertical: string;
}

const signIn = (sub: string) => shared.sessions.set(sub, { id: sub, email: `${sub}@team.test`, name: sub, emailVerified: true });

/** A seeded team owned by `ownerSub`, with one pushed vertical (and one version of it). */
async function team(ownerSub: string, vertical: string): Promise<Team> {
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: `t-${tenant.slice(-6).toLowerCase()}`, name: vertical });
  await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: ownerSub, principal: owner, tenantId: tenant, scopeId: dashScope });
  signIn(ownerSub);
  await host.admin.registerVertical(staff, { slug: vertical, name: vertical, source: 'cli', ownerTenant: tenant });
  await host.admin.publishVersion(staff, {
    id: ulid(),
    verticalSlug: vertical,
    version: '1.0.0',
    manifestDigest: 'manifest-1',
    permissionDigest: 'perm-1',
    migrationDigest: 'mig-1',
    deploymentRef: null,
  });
  return { tenant, dashScope, vertical };
}

/** `sub` is also an owner of `t` (one login, two teams). */
async function alsoOwner(sub: string, t: Team): Promise<void> {
  const p = principalId.parse(ulid());
  await host.admin.assignRole(staff, { principalId: p, roleKey: 'owner', node: { tenantId: t.tenant, scopeId: null } });
  await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal: p, tenantId: t.tenant, scopeId: t.dashScope });
}

/** One request through the worker, as `sub`, optionally with `sb_team` pinned. */
function req(method: string, path: string, opts: { sub?: string | null; cookieTeam?: string; body?: unknown } = {}) {
  const sub = opts.sub === undefined ? 'sub-a' : opts.sub;
  const cookie = [sub ? `sb_session=${sub}` : '', opts.cookieTeam ? `sb_team=${opts.cookieTeam}` : ''].filter(Boolean).join('; ');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const body = opts.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(opts.body) };
  return app.request(path, { method, headers, ...body }, env);
}

const inTeam = (t: Team | TenantId, rest: string) => `/api/teams/${typeof t === 'string' ? t : t.tenant}${rest}`;
const slugPath = (slug: string) => `/deployments/${encodeURIComponent(slug)}`;

/** An answer with the one field that differs per request (its id) and the vertical's name taken out. */
async function bytesOf(res: Response, slug = ''): Promise<{ status: number; body: string }> {
  const text = await res.text();
  return {
    status: res.status,
    body: text.replace(/"requestId":"[^"]*"/g, '"requestId":"-"').split(encodeURIComponent(slug)).join('<slug>').split(slug).join('<slug>'),
  };
}

interface RouteCall {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  rest: string;
  body?: unknown;
}

/** Every declared deployments route, with a path and a body that would otherwise be accepted. */
const routesFor = (slug: string, scope: string = ulid()): RouteCall[] => {
  const d = slugPath(slug);
  return [
    { name: 'list-deployments', method: 'GET', rest: '/deployments' },
    { name: 'promote-deployment', method: 'POST', rest: `${d}/promote`, body: { channel: 'prod', versionId: 'v1' } },
    { name: 'get-promotion-review', method: 'GET', rest: `${d}/promote-review?versionId=v1` },
    { name: 'list-channel-history', method: 'GET', rest: `${d}/channels/prod/history` },
    { name: 'list-deployment-failures', method: 'GET', rest: `${d}/failures` },
    { name: 'get-deployment-releases', method: 'GET', rest: `${d}/releases` },
    { name: 'get-deployment-traffic', method: 'GET', rest: `${d}/traffic?hours=6` },
    { name: 'list-deployment-issues', method: 'GET', rest: `${d}/issues` },
    { name: 'delete-deployment', method: 'DELETE', rest: d },
    { name: 'list-bound-scopes', method: 'GET', rest: `${d}/scopes` },
    { name: 'review-scope-move', method: 'POST', rest: `${d}/scopes/move-review`, body: { scopeIds: [scope], target: 'elsewhere/x' } },
    { name: 'move-scopes', method: 'POST', rest: `${d}/scopes/move`, body: { scopeIds: [scope], target: 'elsewhere/x' } },
    { name: 'retire-scopes', method: 'POST', rest: `${d}/scopes/retire`, body: { scopeIds: [scope], confirm: '1' } },
    { name: 'list-previews', method: 'GET', rest: `${d}/previews` },
    { name: 'create-preview', method: 'POST', rest: `${d}/previews`, body: { tag: 'pr-1', versionId: 'v1' } },
    { name: 'delete-preview', method: 'DELETE', rest: `${d}/previews/pr-1` },
    { name: 'bind-preview-domain', method: 'POST', rest: `${d}/previews/pr-1/domain`, body: { domain: 'crm-test.example.com' } },
  ];
};

/** The cookie-scoped paths these routes replaced. */
const COOKIE_PATHS: Array<readonly [string, string]> = [
  ['GET', '/api/deployments'],
  ['POST', '/api/deployments/acme%2Fhr/promote'],
  ['GET', '/api/deployments/acme%2Fhr/promote-review?versionId=v1'],
  ['GET', '/api/deployments/acme%2Fhr/channels/prod/history'],
  ['GET', '/api/deployments/acme%2Fhr/failures'],
  ['GET', '/api/deployments/acme%2Fhr/releases'],
  ['GET', '/api/deployments/acme%2Fhr/traffic'],
  ['GET', '/api/deployments/acme%2Fhr/issues'],
  ['DELETE', '/api/deployments/acme%2Fhr'],
  ['GET', '/api/deployments/acme%2Fhr/scopes'],
  ['POST', '/api/deployments/acme%2Fhr/scopes/move-review'],
  ['POST', '/api/deployments/acme%2Fhr/scopes/move'],
  ['POST', '/api/deployments/acme%2Fhr/scopes/retire'],
  ['GET', '/api/deployments/acme%2Fhr/previews'],
  ['POST', '/api/deployments/acme%2Fhr/previews'],
  ['DELETE', '/api/deployments/acme%2Fhr/previews/pr-1'],
  ['POST', '/api/deployments/acme%2Fhr/previews/pr-1/domain'],
];

/** A, B (also owned by sub-a) and C (a stranger's). */
async function teams() {
  const a = await team('sub-a', 'acme/hr');
  const b = await team('sub-b', 'bravo/crm');
  const c = await team('sub-c', 'charlie/x');
  await alsoOwner('sub-a', b);
  return { a, b, c };
}

describe('the declared deployments surface', () => {
  it('is exactly these seventeen routes, each under /api/teams/:teamId', async () => {
    const declared = Object.entries(dashboardRoutes)
      .filter(([, r]) => r.http.path.startsWith('/deployments'))
      .map(([name, r]) => `${r.http.method} ${r.http.path} ${name}`)
      .sort();
    expect(declared).toHaveLength(17);
    // The test's own table agrees: one entry per declared route, by name.
    expect(routesFor('x').map((r) => r.name).sort()).toEqual(
      Object.keys(dashboardRoutes)
        .filter((n) => dashboardRoutes[n as keyof typeof dashboardRoutes].http.path.startsWith('/deployments'))
        .map((n) => n.replace('dashboard/', ''))
        .sort(),
    );
  });

  it('the cookie routes are gone', async () => {
    await teams();
    for (const [method, path] of COOKIE_PATHS) {
      expect((await req(method, path, { body: {} })).status, `${method} ${path}`).toBe(404);
    }
  });

  it('no session is a 401 on every route', async () => {
    const { a } = await teams();
    for (const r of routesFor(a.vertical)) {
      expect((await req(r.method, inTeam(a, r.rest), { sub: null, body: r.body })).status, r.name).toBe(401);
    }
  });
});

describe('the team in the path is the authority', () => {
  it('a team the caller is not in is a 404 on every route — the bytes of a team that does not exist, with the plane never asked', async () => {
    const { c } = await teams();
    shared.scopesOpened.length = 0;
    planeCalls.length = 0;
    const ghost = tenantId.parse(ulid());
    for (const r of routesFor(c.vertical)) {
      const stranger = await bytesOf(await req(r.method, inTeam(c, r.rest), { body: r.body }));
      const unknown = await bytesOf(await req(r.method, inTeam(ghost, r.rest), { body: r.body }));
      expect(stranger.status, r.name).toBe(404);
      // The team id is the one thing that differs between the two requests.
      expect(stranger.body.split(c.tenant).join('-'), r.name).toBe(unknown.body.split(ghost).join('-'));
    }
    expect(shared.scopesOpened).not.toContain(c.tenant);
    expect(planeCalls).toEqual([]);
    expect(effects).toEqual([]);
  });

  it('with sb_team pinned to A, the path names B and B is what is read', async () => {
    const { a, b } = await teams();
    const slugs = async (t: Team, cookieTeam: string) =>
      ((await (await req('GET', inTeam(t, '/deployments'), { cookieTeam })).json()) as Array<{ slug: string }>).map((d) => d.slug);
    expect(await slugs(b, a.tenant)).toEqual(['bravo/crm']);
    expect(await slugs(a, b.tenant)).toEqual(['acme/hr']);
    // …and the row is the declared shape: the version is there, the list is B's alone.
    const res = await req('GET', inTeam(b, '/deployments'), { cookieTeam: a.tenant });
    expect(await res.json()).toEqual([
      expect.objectContaining({
        slug: 'bravo/crm',
        displaySlug: 'crm',
        listed: false,
        channels: [],
        versions: [expect.objectContaining({ version: '1.0.0', admission: expect.any(String), schemaChange: false, origin: null })],
      }),
    ]);
  });

  it('another team’s vertical, asked for through your own path, answers as one that does not exist — on every route that names a vertical', async () => {
    const { a, b } = await teams();
    for (const r of routesFor(b.vertical).filter((x) => x.name !== 'list-deployments')) {
      const theirs = await bytesOf(await req(r.method, inTeam(a, r.rest), { body: r.body }), b.vertical);
      const nobodys = routesFor('nobody/nothing').find((x) => x.name === r.name)!;
      const none = await bytesOf(await req(nobodys.method, inTeam(a, nobodys.rest), { body: nobodys.body }), 'nobody/nothing');
      expect(theirs.status, r.name).toBeGreaterThanOrEqual(400);
      expect(theirs, r.name).toEqual(none);
    }
    // Nothing reached the plane as an act, and B's vertical is still registered.
    expect(effects).toEqual([]);
    expect((await host.admin.listVerticals(staff)).map((v) => v.slug)).toContain('bravo/crm');
  });

  it('its own vertical, through its own path, is the positive twin on every route', async () => {
    const { a } = await teams();
    const expected: Record<string, number> = {
      'promote-deployment': 200,
      'create-preview': 201,
      'bind-preview-domain': 201,
      'review-scope-move': 404, // the install is not bound to this vertical (below), not the vertical not being ours
      'move-scopes': 404,
      'retire-scopes': 404,
    };
    for (const r of routesFor(a.vertical).filter((x) => x.name !== 'delete-deployment')) {
      const res = await req(r.method, inTeam(a, r.rest), { body: r.body });
      expect(res.status, `${r.name}: ${await res.clone().text()}`).toBe(expected[r.name] ?? 200);
    }
  });
});

describe('deployments: reads and the two writes', () => {
  it('promote through B’s path, with the cookie on A, promotes B’s vertical and no other — and answers 200 { promoted }', async () => {
    const { a, b } = await teams();
    const res = await req('POST', inTeam(b, `${slugPath(b.vertical)}/promote`), { cookieTeam: a.tenant, body: { channel: 'prod', versionId: 'v1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ promoted: true });
    expect(effects).toEqual([`POST /verticals/${encodeURIComponent(b.vertical)}/channels/prod/promote`]);
  });

  it('a listed vertical is not promoted or deleted self-serve, in its own team', async () => {
    const { a } = await teams();
    await host.admin.setVerticalListed(staff, a.vertical, true);
    const promote = await req('POST', inTeam(a, `${slugPath(a.vertical)}/promote`), { body: { channel: 'prod', versionId: 'v1' } });
    expect(promote.status).toBe(403);
    expect((await req('DELETE', inTeam(a, slugPath(a.vertical)))).status).toBe(403);
    expect(effects).toEqual([]);
  });

  it('delete through B’s path removes B’s vertical and not A’s — and answers 200 { removed }', async () => {
    const { a, b } = await teams();
    const res = await req('DELETE', inTeam(b, slugPath(b.vertical)), { cookieTeam: a.tenant });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    const left = (await host.admin.listVerticals(staff)).map((v) => v.slug);
    expect(left).not.toContain('bravo/crm');
    expect(left).toContain('acme/hr');
  });

  it('a bad hours or a missing version is a 400 in a team the caller is in — the twin of the 404s above', async () => {
    const { a } = await teams();
    expect((await req('GET', inTeam(a, `${slugPath(a.vertical)}/traffic?hours=lots`))).status).toBe(400);
    expect((await req('GET', inTeam(a, `${slugPath(a.vertical)}/promote-review`))).status).toBe(400);
    expect((await req('GET', inTeam(a, `${slugPath(a.vertical)}/channels/dev/history`))).status).toBe(400);
  });

  it('the reads answer their declared shapes', async () => {
    const { a } = await teams();
    const get = async (rest: string) => (await req('GET', inTeam(a, rest))).json();
    expect(await get(`${slugPath(a.vertical)}/channels/prod/history`)).toEqual([]);
    expect(await get(`${slugPath(a.vertical)}/failures`)).toEqual([]);
    expect(await get(`${slugPath(a.vertical)}/issues`)).toEqual([]);
    expect(await get(`${slugPath(a.vertical)}/releases`)).toMatchObject({
      releases: [expect.objectContaining({ version: '1.0.0', isProd: false, scopesPinned: 0 })],
      scopesTrackingProd: 0,
    });
    expect(await get(`${slugPath(a.vertical)}/traffic?hours=6`)).toMatchObject({
      buckets: expect.any(Array),
      markers: expect.any(Array),
      available: expect.any(Boolean),
    });
  });
});

describe('the installs a vertical still backs', () => {
  /** An install bound to `slug`, active. */
  async function install(t: Team, slug: string, handle: string): Promise<ScopeId> {
    const id = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t.tenant, scopeId: id, slug: handle, name: handle, vertical: slug });
    await host.admin.activateScope(staff, t.tenant, id);
    return id;
  }

  it('lists the team’s own installs; another team’s vertical, through this path, is unknown', async () => {
    const { a, b } = await teams();
    const mine = await install(a, a.vertical, 'hr');
    const theirs = await install(b, b.vertical, 'crm');
    const listed = (await (await req('GET', inTeam(a, `${slugPath(a.vertical)}/scopes`))).json()) as { live: number; scopes: Array<{ id: string }> };
    expect(listed.live).toBe(1);
    expect(listed.scopes.map((s) => s.id)).toEqual([mine]);
    expect(listed.scopes.map((s) => s.id)).not.toContain(theirs);
    expect((await req('GET', inTeam(a, `${slugPath(b.vertical)}/scopes`))).status).toBe(404);
  });

  it('an install of another team is not one of this vertical’s: review, move and retire refuse it as they refuse an unknown id, and it is left alone', async () => {
    const { a, b } = await teams();
    await install(a, a.vertical, 'hr');
    const theirs = await install(b, b.vertical, 'crm');
    await host.admin.registerVertical(staff, { slug: 'acme/other', name: 'other', source: 'cli', ownerTenant: a.tenant });
    const call = async (name: 'scopes/move-review' | 'scopes/move' | 'scopes/retire', id: string) =>
      bytesOf(
        await req('POST', inTeam(a, `${slugPath(a.vertical)}/${name}`), {
          body: name === 'scopes/retire' ? { scopeIds: [id], confirm: '1' } : { scopeIds: [id], target: 'acme/other' },
        }),
        id,
      );
    for (const name of ['scopes/move-review', 'scopes/move', 'scopes/retire'] as const) {
      const foreign = await call(name, theirs);
      const unknown = await call(name, ulid());
      expect(foreign.status, name).toBe(404);
      expect(foreign, name).toEqual(unknown);
    }
    expect(effects).toEqual([]);
    expect((await host.admin.getScopeRecord(staff, b.tenant, theirs))?.status).toBe('active');
  });

  it('moves the team’s own install onto another of the team’s verticals, and answers 200 { moved, refusal }', async () => {
    const { a, b } = await teams();
    const mine = await install(a, a.vertical, 'hr');
    await host.admin.registerVertical(staff, { slug: 'acme/other', name: 'other', source: 'cli', ownerTenant: a.tenant });
    // Through B's path with the cookie on A: nothing of A's moves, because B's vertical is B's.
    const wrong = await req('POST', inTeam(b, `${slugPath(b.vertical)}/scopes/move`), { cookieTeam: a.tenant, body: { scopeIds: [mine], target: 'acme/other' } });
    expect(wrong.status).toBe(404);
    expect(effects).toEqual([]);
    // A target that is not the path team's own is refused too.
    const foreignTarget = await req('POST', inTeam(a, `${slugPath(a.vertical)}/scopes/move`), { body: { scopeIds: [mine], target: b.vertical } });
    expect(foreignTarget.status).toBe(404);
    expect(effects).toEqual([]);

    const ok = await req('POST', inTeam(a, `${slugPath(a.vertical)}/scopes/move`), { body: { scopeIds: [mine], target: 'acme/other' } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toEqual({ moved: [mine], refusal: null });
    expect(effects).toEqual([`POST /tenants/${a.tenant}/scopes/${mine}/rebind-vertical`]);
  });

  it('retire asks for the count typed before anything is read or changed', async () => {
    const { a } = await teams();
    const mine = await install(a, a.vertical, 'hr');
    const res = await req('POST', inTeam(a, `${slugPath(a.vertical)}/scopes/retire`), { body: { scopeIds: [mine], confirm: 'yes' } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/type 1 to confirm/);
    expect((await host.admin.getScopeRecord(staff, a.tenant, mine))?.status).toBe('active');
  });

  it('a viewer reads the installs and may not review, move or retire them', async () => {
    const { a } = await teams();
    const viewer = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: a.tenant, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-viewer', principal: viewer, tenantId: a.tenant, scopeId: a.dashScope });
    signIn('sub-viewer');
    const mine = await install(a, a.vertical, 'hr');
    expect((await req('GET', inTeam(a, `${slugPath(a.vertical)}/scopes`), { sub: 'sub-viewer' })).status).toBe(200);
    for (const [name, body] of [
      ['move-review', { scopeIds: [mine], target: 'acme/other' }],
      ['move', { scopeIds: [mine], target: 'acme/other' }],
      ['retire', { scopeIds: [mine], confirm: '1' }],
    ] as const) {
      expect((await req('POST', inTeam(a, `${slugPath(a.vertical)}/scopes/${name}`), { sub: 'sub-viewer', body })).status, name).toBe(403);
    }
    expect(effects).toEqual([]);
  });
});

describe('previews', () => {
  it('with the cookie on A, B’s path creates, lists, reaps and domains B’s previews', async () => {
    const { a, b } = await teams();
    const slug = encodeURIComponent(b.vertical);
    const created = await req('POST', inTeam(b, `${slugPath(b.vertical)}/previews`), { cookieTeam: a.tenant, body: { tag: 'pr-1', versionId: 'v1' } });
    expect(created.status).toBe(201);
    // A reused tag is the same declared status, said in the body.
    expect(await created.json()).toMatchObject({ reused: true, url: 'https://h' });
    const listed = await req('GET', inTeam(b, `${slugPath(b.vertical)}/previews`), { cookieTeam: a.tenant });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([expect.objectContaining({ tag: 'pr-1' })]);
    const reaped = await req('DELETE', inTeam(b, `${slugPath(b.vertical)}/previews/pr-1`), { cookieTeam: a.tenant });
    expect(await reaped.json()).toEqual({ deleted: 'pr-1' });
    const domain = await req('POST', inTeam(b, `${slugPath(b.vertical)}/previews/pr-1/domain`), { cookieTeam: a.tenant, body: { domain: 'CRM-Test.Example.com' } });
    expect(domain.status).toBe(201);
    expect(await domain.json()).toMatchObject({ hostname: 'crm-test.example.com', status: 'verifying' });
    expect(effects).toEqual([`POST /verticals/${slug}/previews`, `DELETE /verticals/${slug}/previews/pr-1`, 'POST /hostnames']);
  });

  it('a tag that is not a DNS label is a 400 before the vertical is looked up', async () => {
    const { a } = await teams();
    const res = await req('POST', inTeam(a, `${slugPath(a.vertical)}/previews`), { body: { tag: 'Not A Label', versionId: 'v1' } });
    expect(res.status).toBe(400);
    expect(effects).toEqual([]);
  });

  it('a preview domain needs the preview to exist under the team’s own vertical', async () => {
    const { a, b } = await teams();
    const res = await req('POST', inTeam(a, `${slugPath(b.vertical)}/previews/pr-1/domain`), { body: { domain: 'x.example.com' } });
    expect(res.status).toBe(404);
    expect(effects).toEqual([]);
  });
});

describe('a plane newer than this dashboard (version skew)', () => {
  it('a preview that was created answers 201 even when its login status is one this dashboard does not know', async () => {
    const { a } = await teams();
    planeAnswers = (method, path) =>
      method === 'POST' && /^\/verticals\/[^/]+\/previews$/.test(path)
        ? Response.json({
            scopeId: 'S',
            hostname: 'h',
            url: 'https://h',
            versionId: 'v1',
            reused: false,
            auth: { status: 'quarantined', callbackUrl: null, note: 'a state from a newer plane' },
          })
        : undefined;
    const res = await req('POST', inTeam(a, `${slugPath(a.vertical)}/previews`), { body: { tag: 'pr-1', versionId: 'v1' } });
    expect(res.status, await res.clone().text()).toBe(201);
    // The write happened, and the answer says what the plane said instead of reporting a failure.
    expect(await res.json()).toMatchObject({ reused: false, auth: { status: 'quarantined', note: 'a state from a newer plane' } });
    expect(effects).toEqual([`POST /verticals/${encodeURIComponent(a.vertical)}/previews`]);
  });

  it('the promote review still opens: a registry or SQL read the dashboard cannot parse reads as "cannot show", and whom it breaks is listed as the plane named them', async () => {
    const { a } = await teams();
    const unknownRegistry = { permissions: [], roles: [{ key: 'owner', permissions: [], source: 'vertical', holder: 'a-holder-from-the-future' }], entityGrants: [] };
    planeAnswers = (method, path) => {
      if (method !== 'GET') return undefined;
      if (/^\/verticals\/[^/]+\/channels$/.test(path)) return Response.json({ entries: [{ channel: 'prod', versionId: 'v1' }], nextCursor: null });
      if (/\/versions\/[^/]+\/registry$/.test(path)) return Response.json({ registry: unknownRegistry });
      if (/\/versions\/[^/]+\/migrations$/.test(path))
        return Response.json({
          migrations: { baseline: 'from-the-future', added: [], changed: [], total: 0, truncated: false },
          review: { base: 'v1', digest: 'a'.repeat(64) },
        });
      if (/\/channels\/prod\/promote-impact$/.test(path))
        return Response.json({
          affected: [{ tenantId: 'not-a-ulid', scopeId: 'also-not', vertical: 'other/app', version: null, type: 'a.thing-from-the-future', schemaVersion: 2, incoming: null }],
          otherTenants: 1,
        });
      return undefined;
    };
    const res = await req('GET', inTeam(a, `${slugPath(a.vertical)}/promote-review?versionId=v2`));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // "Cannot diff" is the answer that makes the dialog ask for an acknowledgement; never "no change".
    expect(body).toMatchObject({
      serving: { versionId: 'v1' },
      incoming: { versionId: 'v2' },
      servingRegistry: null,
      incomingRegistry: null,
      migrations: null,
      review: { base: 'v1', digest: 'a'.repeat(64) },
      exportBreaks: { affected: [expect.objectContaining({ vertical: 'other/app', type: 'a.thing-from-the-future' })], otherTenants: 1 },
    });
  });
});
