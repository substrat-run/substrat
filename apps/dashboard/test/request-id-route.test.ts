import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { REQUEST_ID_HEADER, platformActorId, problem, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { patchRows, rewrittenPlane, SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * #2192: the dashboard worker itself stamps its answers — driven the way a request reaches
 * it, over the real control plane on a SQLite host behind the service binding (the
 * `refusal-codes-route.test.ts` harness). `request-id.test.ts` pins the middleware's own
 * cases; this one pins that the worker mounts it first and that its `onError` envelope
 * carries the id.
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
  // A stand-in route where the worker mounts the real ones, so the case below holds the order:
  // a middleware registered after this route would never run for it.
  mountOidcRoutes: (app: { get(path: string, h: (c: { redirect(url: string): Response }) => Response): void }) =>
    app.get('/api/auth/login', (c) => c.redirect('https://issuer.example/authorize')),
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PROVIDER = 'authhero';
const OWNER_SUB = 'sub-owner';
const staff = platformActorId.parse(ulid());

describe('the dashboard worker stamps every answer with a request id (#2192)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let env: Record<string, unknown>;
  /** The team the owner belongs to: the declared routes name it in their path. */
  let team: string;
  /** When set, the plane answers every call but the credential mint with a 500. */
  let planeDown: boolean;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-request-id-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    const tenant = tenantId.parse(ulid());
    team = tenant;
    const dashScope = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'request-id', name: 'Request id' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: OWNER_SUB, principal: owner, tenantId: tenant, scopeId: dashScope });

    planeDown = false;
    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          // The credential mint answers; the read after it is what fails, and its detail is relayed.
          if (planeDown && !String(url).endsWith('/tenant-tokens')) {
            return new Response(JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'internal', detail: 'refused Bearer eyJhbGciOi.secret-jwt token=abc' }), {
              status: 500,
              headers: { 'content-type': 'application/problem+json' },
            });
          }
          const u = new URL(String(url));
          return plane.request(u.pathname.replace(/^\/api/, '') + u.search, init);
        },
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string, opts: { sub?: string; headers?: Record<string, string> } = {}) =>
    app.request(
      `/api${path}`,
      { headers: { ...(opts.sub ? { cookie: `sb_session=${opts.sub}` } : {}), ...opts.headers } },
      env,
    );

  it('the OIDC routes are covered: the middleware is mounted ahead of them', async () => {
    const res = await get('/auth/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://issuer.example/authorize');
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it('a success carries the header', async () => {
    const res = await get(`/teams/${team}/deployments`, { sub: OWNER_SUB });
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it("a 401 a route answered itself carries the header, and is a problem document (#113)", async () => {
    const res = await get('/me');
    expect(res.status).toBe(401);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(problem.safeParse(body).success).toBe(true);
    // The sentence the SPA read before stays, as `error` and as `detail`; the id rides the body.
    expect(body).toMatchObject({ status: 401, detail: 'unauthorized', error: 'unauthorized' });
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER));
  });

  it('/api/support/identity answers its 401 the same way; an unconfigured desk is still plain JSON', async () => {
    const unconfigured = await get('/support/identity');
    expect(unconfigured.status).toBe(200);
    expect(unconfigured.headers.get('content-type')).not.toContain('problem');

    const res = await app.request(
      '/api/support/identity',
      {},
      { ...env, SUPPORT_DESK_ORIGIN: 'https://desk.test', SUPPORT_WIDGET_SECRET: 's' },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
    const body = (await res.json()) as Record<string, unknown>;
    expect(problem.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ status: 401, detail: 'unauthorized', error: 'unauthorized' });
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER));
  });

  it('a thrown 401 rendered by onError carries the id in the problem body, equal to the header', async () => {
    const res = await get(`/teams/${team}/deployments`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(401);
    expect(body.detail).toBe('unauthorized');
    expect(body.requestId).toMatch(ULID);
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER));
  });

  it('a 5xx carries the id in header and body, and the one logged line names the same id', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    planeDown = true;
    const res = await get(`/teams/${team}/deployments`, { sub: OWNER_SUB });
    const id = res.headers.get(REQUEST_ID_HEADER);
    const body = (await res.json()) as Record<string, unknown>;
    // Whichever 5xx the plane's failure is relayed as; the id is what is asserted.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(id).toMatch(ULID);
    expect(body.requestId).toBe(id);
    expect(body).not.toHaveProperty('stack');

    const lines = logged.filter((l) => l.includes('dashboard.request-failed')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: 'dashboard.request-failed',
      requestId: id,
      method: 'GET',
      path: `/api/teams/${team}/deployments`,
      status: res.status,
      errorName: 'ControlPlaneError',
      errorCode: 'internal',
      upstreamStatus: 500,
    });
    // The plane's detail is free text the dashboard did not write: it is never logged.
    expect(logged.join('\n')).not.toMatch(/bearer|eyJhbGciOi|secret-jwt|token=abc/i);
  });

  it('#2401: an answer outside a route’s declared output is a 500 with no detail; the logged line names the route and the issue paths, never a value', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    await host.admin.recordOpsFailure({ actor: staff, operation: 'deploy.mine', tenantId: tenantId.parse(team), message: 'x' });
    // Not a value from a newer vocabulary but a broken one: no reading of the declaration admits it.
    env.CONTROL_PLANE_SVC = rewrittenPlane(
      env.CONTROL_PLANE_SVC,
      (p) => p.endsWith('/findings'),
      patchRows((f) => ('firstSeen' in f ? { ...f, firstSeen: 'a-broken-instant' } : undefined)),
    );
    const res = await get(`/teams/${team}/findings`, { sub: OWNER_SUB });
    const id = res.headers.get(REQUEST_ID_HEADER);
    const text = await res.text();
    expect(res.status, text).toBe(500);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 500, title: 'Internal error', code: 'internal', requestId: id });
    expect(body).not.toHaveProperty('detail');
    // Neither the schema's wording, the field, nor the value the plane sent reaches the caller.
    expect(text).not.toMatch(/firstSeen|a-broken-instant|mountRoutes|datetime|Invalid/);

    const lines = logged.filter((l) => l.includes('dashboard.request-failed')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        event: 'dashboard.request-failed',
        requestId: id,
        method: 'GET',
        path: `/api/teams/${team}/findings`,
        status: 500,
        errorName: 'Substrat.internal',
        errorCode: 'internal',
        route: 'dashboard/list-findings',
        outputPaths: ['entries[].firstSeen'],
      },
    ]);
    expect(logged.join('\n')).not.toContain('a-broken-instant');
  });

  it('two requests get two ids, and an id the caller sends is never echoed', async () => {
    const claimed = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const a = (await get(`/teams/${team}/deployments`, { sub: OWNER_SUB, headers: { [REQUEST_ID_HEADER]: claimed } })).headers.get(REQUEST_ID_HEADER);
    const b = (await get(`/teams/${team}/deployments`, { sub: OWNER_SUB, headers: { [REQUEST_ID_HEADER]: claimed } })).headers.get(REQUEST_ID_HEADER);
    expect(a).toMatch(ULID);
    expect(b).toMatch(ULID);
    expect(a).not.toBe(b);
    expect([a, b]).not.toContain(claimed);
  });
});
