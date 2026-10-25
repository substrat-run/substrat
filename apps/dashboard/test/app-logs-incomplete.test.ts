import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { LOGS_INCOMPLETE_HEADER } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * `GET /api/teams/:teamId/apps/:scopeId/observability/logs` forwards the plane's logs-incomplete
 * header (#2521), as the team route does for the service grain (#2520).
 *
 * Driven through the WORKER, for the reason `app-logs-by-invocation` gives: the authority's own
 * suite proves it can read the header, and stays green if the route never hands it on. The plane
 * behind the service binding answers as `GET /observability/tenant-logs` does — the list, and
 * `x-substrat-logs-incomplete: 1` beside it exactly when the read may be missing lines. What is
 * asserted is what the browser receives: the header exactly then, and the body the same list either way.
 *
 * The seams the worker cannot run in Node are replaced the way `app-logs-by-invocation` replaces them.
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

describe('the app logs route forwards the plane’s logs-incomplete header (#2521)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  /** What the plane's `/observability/logs` answers; a test sets it. */
  let planeHeaders: Record<string, string>;
  const line = { timestamp: 1_722_700_000_000, level: 'info', message: 'a line', service: 'acme-widgets-v1', outcome: 'ok', raw: { a: 1 } };
  let env: Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-team-logs-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    planeHeaders = {};
    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'logs', name: 'Logs' });
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
        fetch: async (url: string | URL | Request) => {
          const path = new URL(String(url)).pathname.replace(/^\/api/, '');
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path === '/observability/tenant-logs') return Response.json([line], { headers: planeHeaders });
          return Response.json({ error: `unexpected ${path}` }, { status: 500 });
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = () =>
    app.request(`/api/teams/${tenant}/apps/${appScope}/observability/logs?hours=24`, { headers: { cookie: 'sb_session=sub-owner' } }, env);

  it('sets the header on the answer exactly when the plane did, and the body is the list either way', async () => {
    planeHeaders = { [LOGS_INCOMPLETE_HEADER]: '1' };
    const short = await read();
    expect(short.status).toBe(200);
    expect(short.headers.get(LOGS_INCOMPLETE_HEADER)).toBe('1');
    const shortBody = (await short.json()) as unknown[];

    planeHeaders = {};
    const whole = await read();
    expect(whole.status).toBe(200);
    expect(whole.headers.has(LOGS_INCOMPLETE_HEADER)).toBe(false);
    expect(await whole.json()).toEqual(shortBody);
    expect(shortBody).toHaveLength(1);
  });
});
