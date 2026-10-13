import { describe, expect, it, vi } from 'vitest';
import { signConnectState } from '@substrat-run/control-plane-api';

/**
 * The scopes the dashboard's Fortnox Connect asks for at the consent screen (#2265). The
 * connector never chooses them — its caller passes them in — so the only place a dropped
 * scope shows is the redirect the landing builds. Fortnox grants exactly what is asked for
 * and cannot widen it later, so this reads the redirect's own `scope` parameter.
 */

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    registerModule() {}
    registerExecutor() {}
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PLATFORM_SECRET = 'platform-secret-value-32-bytes-min';
const base = {
  SESSION_SECRET: 'dashboard-session-secret-32-bytes',
  PLATFORM_SECRET,
  FORTNOX_CLIENT_ID: 'client-id',
  FORTNOX_CLIENT_SECRET: 'client-secret',
};

/** An in-session platform round: signed, no row behind it, so the landing asks nothing else. */
const landing = async (env: Record<string, unknown>) => {
  const token = await signConnectState(PLATFORM_SECRET, {
    tenantId: '01J000000000000000000TEN',
    scopeId: '01J00000000000000000APP',
    vertical: 'bureau-books',
    provider: 'fortnox',
    principal: '01J00000000000000BUREAU',
    exp: Date.now() + 60_000,
  });
  const res = await app.request(`/api/integrations/fortnox/connect?token=${encodeURIComponent(token)}`, {}, env);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('scope');
};

describe('the scopes the Fortnox consent redirect requests', () => {
  it('asks for bookkeeping, companyinformation and supplierinvoice by default', async () => {
    expect(await landing(base)).toBe('bookkeeping companyinformation supplierinvoice');
  });

  it('lets FORTNOX_SCOPES replace the default whole, not add to it', async () => {
    expect(await landing({ ...base, FORTNOX_SCOPES: 'bookkeeping' })).toBe('bookkeeping');
  });
});
