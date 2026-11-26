import { afterEach, describe, expect, it, vi } from 'vitest';
import { signConnectState } from '@substrat-run/control-plane-api';
import { FortnoxMock } from '@substrat-run/connector-fortnox';
import { ulid } from '@substrat-run/kernel';

/**
 * #3410: a round a vertical asked for as a scope's OWN connection ends at the control plane's
 * `…/connections/consented`, carrying the signed state as it arrived, never at the tenant's upsert:
 * the plane verifies the state again and takes the scope from it. A bind the scope's landing refuses
 * after the store is told to the vertical, rather than reported as connected.
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
const RETURN = 'https://books.store.example/fortnox';

afterEach(() => vi.unstubAllGlobals());

/** One scope's own round through the callback; the plane answers the store with `answer`. */
const callback = async (answer: Record<string, unknown>) => {
  const fortnox = new FortnoxMock({ consentCode: 'code-1' });
  vi.stubGlobal('fetch', ((input: string, init?: RequestInit) => fortnox.fetch(String(input), init as never)) as typeof fetch);
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const plane = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path.endsWith('/tenant-tokens')) return Response.json({ token: 'tenant-token' });
      calls.push({ path, body: JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown> });
      return Response.json({ connectionId: ulid(), created: true, granted: [], ...answer });
    },
  };
  const tenantId = ulid();
  const scopeId = ulid();
  const state = await signConnectState(PLATFORM_SECRET, {
    tenantId,
    scopeId,
    vertical: 'acme-stores',
    provider: 'fortnox',
    principal: ulid(),
    owner: 'scope',
    returnUrl: RETURN,
    exp: Date.now() + 60_000,
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
  return { res, calls, state, tenantId, scopeId };
};

describe("a Fortnox consent round asked for as a scope's own connection", () => {
  it('relays the signed state to the plane, which stores and binds it, and returns connected', async () => {
    const { res, calls, state, tenantId, scopeId } = await callback({ scopeId: '', bound: { scopeId: '', options: {} } });

    expect(calls).toEqual([
      {
        path: `/api/tenants/${tenantId}/connections/consented`,
        body: { state, label: 'Fortnox — Testbolaget AB', externalAccountRef: '123456', secret: expect.objectContaining({ tenantId: '123456' }) },
      },
    ]);
    // The scope is the claim's to name, not this worker's.
    expect(JSON.stringify(calls[0]!.body)).not.toContain(scopeId);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('connected')).toBe('1');
  });

  it('tells the vertical when the company was stored but its landing refused the binding', async () => {
    const { res } = await callback({ bound: null, bindRefusal: 'no on-request landing' });

    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect([back.searchParams.get('error'), back.searchParams.get('connected')]).toEqual(['bind_failed', null]);
  });
});
