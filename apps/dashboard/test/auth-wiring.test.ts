import { describe, it, expect } from 'vitest';
import { registerOidcClient, authConfigFor } from '../src/auth-wiring.js';

/**
 * Install-time identity wiring (vertical-auth-detach.md §2.4): dynamic client
 * registration against an issuer's discovery document, and the `substrat:auth` value a
 * choice resolves to. The fetch is injected, so these drive the real code paths —
 * discovery, RFC 7591 body/response mapping, failure surfacing — without a network.
 */

const ISSUER = 'https://auth-acme.global.substrat.test';
const REGISTER = `${ISSUER}/api/auth/oauth2/register`;
const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/auth/oauth2/authorize`,
  token_endpoint: `${ISSUER}/api/auth/oauth2/token`,
  jwks_uri: `${ISSUER}/api/auth/jwks`,
  registration_endpoint: REGISTER,
};

/**
 * An issuer, as the injected fetch sees it. `discovery` replaces the document (or the whole
 * response); anything that is not the discovery URL is taken as a registration POST — so a
 * registration sent somewhere it should not be is RECORDED, not thrown away as unexpected.
 */
function issuerFetch(
  overrides: {
    discovery?: () => Response;
    doc?: Record<string, unknown>;
    registration?: () => unknown;
  } = {},
): {
  fetchImpl: typeof fetch;
  registrations: Array<Record<string, unknown>>;
  posts: Array<{ url: string; redirect?: string }>;
  discoveries: Array<{ url: string; redirect?: string }>;
} {
  const registrations: Array<Record<string, unknown>> = [];
  const posts: Array<{ url: string; redirect?: string }> = [];
  const discoveries: Array<{ url: string; redirect?: string }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const res = await answer(url, init);
    // Follow a redirect the way the runtime does unless the caller said `manual` — so a POST
    // that loses its `redirect: 'manual'` really does land somewhere else in this test.
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && init?.redirect !== 'manual') {
      return fetchImpl(new URL(location, url).toString(), init);
    }
    return res;
  }) as unknown as typeof fetch;
  const answer = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      discoveries.push({ url, redirect: init?.redirect });
      if (overrides.discovery) return overrides.discovery();
      return Response.json(overrides.doc ?? DOC);
    }
    posts.push({ url, redirect: init?.redirect });
    registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (overrides.registration && posts.length === 1) return overrides.registration() as Response;
    return Response.json({ client_id: 'generated-id', client_secret: 'generated-secret' });
  };
  return { fetchImpl, registrations, posts, discoveries };
}

const register = (fetchImpl: typeof fetch, issuer = ISSUER) =>
  registerOidcClient(issuer, { appName: 'X', redirectUri: 'https://x/cb' }, fetchImpl);

describe('registerOidcClient', () => {
  it('registers at the DISCOVERED endpoint with the callback redirect and secret-post auth', async () => {
    const { fetchImpl, registrations, posts, discoveries } = issuerFetch();
    const client = await registerOidcClient(
      ISSUER,
      { appName: 'People', redirectUri: 'https://people-acme.global.substrat.test/api/auth/callback' },
      fetchImpl,
    );
    expect(client).toEqual({ clientId: 'generated-id', clientSecret: 'generated-secret' });
    expect(registrations).toEqual([
      {
        client_name: 'People',
        redirect_uris: ['https://people-acme.global.substrat.test/api/auth/callback'],
        // oidc-rp presents the secret in the token-request BODY, so the client must be
        // registered to match — a basic-auth-only client would fail every exchange.
        token_endpoint_auth_method: 'client_secret_post',
      },
    ]);
    // Neither request follows a redirect: the discovery GET is walked same-origin by
    // oidc-rp, and the POST's response carries the client secret.
    expect(discoveries).toEqual([{ url: `${ISSUER}/.well-known/openid-configuration`, redirect: 'manual' }]);
    expect(posts).toEqual([{ url: REGISTER, redirect: 'manual' }]);
  });

  it('surfaces a refusal with the issuer named, and rejects a credential-less response', async () => {
    const refusing = issuerFetch({ registration: () => Response.json({ error: 'registration disabled' }, { status: 403 }) });
    await expect(register(refusing.fetchImpl)).rejects.toThrow(/registration at .* failed \(403\)/);

    const empty = issuerFetch({ registration: () => Response.json({}) });
    await expect(register(empty.fetchImpl)).rejects.toThrow(/no client credentials/);
  });

  it('treats a redirect from the registration endpoint as a failure', async () => {
    const moved = issuerFetch({
      registration: () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/register' } }),
    });
    await expect(register(moved.fetchImpl)).rejects.toThrow(/failed \(307\)/);
    expect(moved.posts).toEqual([{ url: REGISTER, redirect: 'manual' }]);
  });

  it('refuses a plaintext registration_endpoint from an https issuer, and sends nothing to it', async () => {
    for (const plaintext of ['http://localhost:8080/register', 'http://auth-acme.global.substrat.test/register']) {
      const f = issuerFetch({ doc: { ...DOC, registration_endpoint: plaintext } });
      await expect(register(f.fetchImpl), plaintext).rejects.toThrow(/registration_endpoint is not https/);
      expect(f.posts).toEqual([]);
    }
    const notUrl = issuerFetch({ doc: { ...DOC, registration_endpoint: 42 } });
    await expect(register(notUrl.fetchImpl)).rejects.toThrow(/registration_endpoint/);
    expect(notUrl.posts).toEqual([]);
  });

  it('admits a plaintext loopback registration_endpoint for a loopback dev issuer (the positive twin)', async () => {
    const dev = 'http://localhost:8879';
    const f = issuerFetch({
      doc: {
        issuer: dev,
        authorization_endpoint: `${dev}/authorize`,
        token_endpoint: `${dev}/token`,
        jwks_uri: `${dev}/jwks`,
        registration_endpoint: `${dev}/register`,
      },
    });
    expect(await register(f.fetchImpl, dev)).toEqual({ clientId: 'generated-id', clientSecret: 'generated-secret' });
    expect(f.posts).toEqual([{ url: `${dev}/register`, redirect: 'manual' }]);
  });

  it('refuses a document that names a different issuer, or is served from off the issuer origin', async () => {
    const other = issuerFetch({ doc: { ...DOC, issuer: 'https://other.test' } });
    await expect(register(other.fetchImpl)).rejects.toThrow(/different issuer/);
    expect(other.posts).toEqual([]);

    const away = issuerFetch({
      discovery: () =>
        new Response(null, { status: 302, headers: { location: 'https://other.test/.well-known/openid-configuration' } }),
    });
    await expect(register(away.fetchImpl)).rejects.toThrow(/away from its origin/);
    expect(away.discoveries).toHaveLength(1);
    expect(away.posts).toEqual([]);
  });

  it('does not fall back when discovery fails: an issuer a login would refuse gets no client', async () => {
    const down = issuerFetch({ discovery: () => new Response('down', { status: 503 }) });
    await expect(register(down.fetchImpl)).rejects.toThrow(/discovery failed \(503\)/);
    expect(down.posts).toEqual([]);
  });

  it('falls back to the default path ON THE ISSUER ORIGIN when the document names no registration_endpoint', async () => {
    const { registration_endpoint: _omit, ...withoutRegistration } = DOC;
    const f = issuerFetch({ doc: withoutRegistration });
    expect(await register(f.fetchImpl, `${ISSUER}/`)).toEqual({ clientId: 'generated-id', clientSecret: 'generated-secret' });
    expect(f.posts).toEqual([{ url: REGISTER, redirect: 'manual' }]);
  });

  it('bounds the whole registration: an issuer that never answers fails within the timeout', async () => {
    // Hangs until aborted, like a connection that is accepted and never answered.
    const hangAt = (hangOn: 'discovery' | 'post') => {
      const signals: Array<AbortSignal | undefined> = [];
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        signals.push(init?.signal ?? undefined);
        const isDiscovery = url.endsWith('/.well-known/openid-configuration');
        if (isDiscovery && hangOn === 'post') return Response.json(DOC);
        return await new Promise<Response>((_, reject) => {
          if (!init?.signal) return; // no bound: hang forever, and the race below says so
          init.signal.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }) as unknown as typeof fetch;
      return { fetchImpl, signals };
    };
    for (const stage of ['discovery', 'post'] as const) {
      const { fetchImpl, signals } = hangAt(stage);
      const outcome = await Promise.race([
        registerOidcClient(ISSUER, { appName: 'X', redirectUri: 'https://x/cb' }, fetchImpl, 50).then(
          () => 'resolved',
          (e: unknown) => `rejected: ${e instanceof Error ? e.name : String(e)}`,
        ),
        new Promise<string>((r) => setTimeout(() => r('still hanging'), 2_000)),
      ]);
      expect(outcome, stage).toBe('rejected: TimeoutError');
      // Every request carried the one bound.
      expect(signals.every((s) => s instanceof AbortSignal), stage).toBe(true);
    }
  });

  it('refuses a plaintext issuer before anything is fetched', async () => {
    const f = issuerFetch();
    await expect(register(f.fetchImpl, 'http://auth-acme.global.substrat.test')).rejects.toThrow(/not https/);
    expect(f.discoveries).toEqual([]);
    expect(f.posts).toEqual([]);
  });
});

describe('authConfigFor', () => {
  it('external: passes the hand-configured issuer through verbatim', async () => {
    const cfg = await authConfigFor(
      { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs', audience: 'aud' },
      { appName: 'People', redirectUri: 'https://people/cb' },
    );
    expect(cfg).toEqual({ mode: 'oidc', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs', audience: 'aud' });
  });

  it('auth-server: registers the client first, then wires its minted credentials', async () => {
    const calls: Array<{ issuer: string; appName: string; redirectUri: string }> = [];
    const cfg = await authConfigFor(
      { source: 'auth-server', issuer: ISSUER },
      {
        appName: 'People',
        redirectUri: 'https://people/cb',
        registerClient: async (issuer, input) => {
          calls.push({ issuer, ...input });
          return { clientId: 'minted-id', clientSecret: 'minted-secret' };
        },
      },
    );
    expect(calls).toEqual([{ issuer: ISSUER, appName: 'People', redirectUri: 'https://people/cb' }]);
    expect(cfg).toEqual({ mode: 'oidc', issuer: ISSUER, clientId: 'minted-id', clientSecret: 'minted-secret' });
  });
});
