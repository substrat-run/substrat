import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PLACES_CONFIG_PREFIX, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { SERVICE_TOKEN_HEADER } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * #3177: the dashboard is the writer of the issuer-only config keys, so its credential is
 * minted with `issuerConfig`, and a plane that holds those keys to the claim delivers them.
 * Driven through the worker over the real plane (the `request-id-route.test.ts` harness).
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
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const OWNER_SUB = 'sub-owner';
const staff = platformActorId.parse(ulid());

describe('the dashboard mints its credential with issuerConfig (#3177)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let team: string;
  let plane: ReturnType<typeof tenantPlane>;
  const mints: { body: Record<string, unknown>; token: string }[] = [];
  let env: Record<string, unknown>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-issuer-config-mint-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    const tenant = tenantId.parse(ulid());
    team = tenant;
    const dashScope = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'mint', name: 'Mint' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: OWNER_SUB, principal: owner, tenantId: tenant, scopeId: dashScope });
    plane = tenantPlane(host, staff, { requireIssuerConfigClaim: true });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const res = await plane.request(u.pathname.replace(/^\/api/, '') + u.search, init);
          if (u.pathname.endsWith('/tenant-tokens') && res.ok) {
            const { token } = (await res.clone().json()) as { token: string };
            mints.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, token });
          }
          return res;
        },
      },
    };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks for the claim, and the token it gets passes the issuer-only refusal', async () => {
    const res = await app.request(`/api/teams/${team}/deployments`, { headers: { cookie: `sb_session=${OWNER_SUB}` } }, env);
    expect(res.status).toBe(200);
    expect(mints.length).toBeGreaterThan(0);
    for (const m of mints) expect(m.body.issuerConfig).toBe(true);
    // An unknown scope: past the refusal, the plane answers 404. Refused, it would be a 403.
    const delivered = await plane.request(`/tenants/${team}/scopes/${scopeId.parse(ulid())}/configure`, {
      method: 'POST',
      headers: { [SERVICE_TOKEN_HEADER]: mints[0]!.token, 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ key: `${PLACES_CONFIG_PREFIX}${team}`, value: '{}' }] }),
    });
    expect(delivered.status).toBe(404);
  });
});
