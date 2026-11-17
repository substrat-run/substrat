import { afterEach, describe, expect, it, vi } from 'vitest';
import { signConnectState } from '@substrat-run/control-plane-api';
import { FortnoxMock } from '@substrat-run/connector-fortnox';
import { ulid } from '@substrat-run/kernel';

/**
 * #2422: a company's Fortnox administrator can approve fewer scopes than the consent asked for.
 * The callback still stores the connection — its keys work — and tells whoever is there what is
 * missing: the vertical a round came from gets `missing`, and the dashboard's own page says it.
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

afterEach(() => vi.unstubAllGlobals());

/** One consent round through the callback, against the mock, with the plane answering the store. */
const callback = async (grantedScope: string, returnUrl?: string) => {
  const fortnox = new FortnoxMock({ consentCode: 'code-1' });
  fortnox.grantedScope = grantedScope;
  // The callback reaches Fortnox through the kernel's `globalFetch`, which reads the global per call.
  vi.stubGlobal('fetch', ((input: string, init?: RequestInit) => fortnox.fetch(String(input), init as never)) as typeof fetch);
  const stored: unknown[] = [];
  const plane = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path.endsWith('/tenant-tokens')) return Response.json({ token: 'tenant-token' });
      stored.push(JSON.parse(String(init?.body ?? 'null')));
      return Response.json({ connectionId: ulid(), created: true, granted: [] });
    },
  };
  const state = await signConnectState(PLATFORM_SECRET, {
    tenantId: ulid(),
    scopeId: ulid(),
    vertical: 'bureau-books',
    provider: 'fortnox',
    principal: ulid(),
    exp: Date.now() + 60_000,
    ...(returnUrl ? { returnUrl } : {}),
  });
  const res = await app.request(
    `/api/integrations/fortnox/callback?state=${encodeURIComponent(state)}&code=code-1`,
    {},
    {
      SESSION_SECRET: 'dashboard-session-secret-32-bytes',
      PLATFORM_SECRET,
      FORTNOX_CLIENT_ID: 'client-id',
      FORTNOX_CLIENT_SECRET: 'client-secret',
      FORTNOX_OAUTH_BASE: fortnox.oauthBase,
      FORTNOX_API_BASE: fortnox.apiBase,
      CONTROL_PLANE_SVC: plane,
      CP_SERVICE_TOKEN: 'service-token',
    },
  );
  return { res, stored };
};

describe('a Fortnox consent that granted fewer scopes than it asked for', () => {
  it('stores the connection and hands the vertical what is missing', async () => {
    const { res, stored } = await callback('bookkeeping companyinformation supplierinvoice', 'https://books.bureau.example/fortnox');

    expect(stored).toHaveLength(1);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('connected')).toBe('1');
    expect(back.searchParams.get('missing')).toBe('archive connectfile');
  });

  it('names the missing scopes on its own page, and says nothing when the consent covers them', async () => {
    const short = await callback('bookkeeping companyinformation');
    const page = await short.res.text();
    expect(short.stored).toHaveLength(1);
    expect(page).toContain('Fortnox granted fewer permissions than were asked for.');
    expect(page).toContain('Missing: supplierinvoice, archive, connectfile.');

    const whole = await callback('bookkeeping companyinformation supplierinvoice archive connectfile');
    expect(await whole.res.text()).not.toContain('fewer permissions');
  });
});
