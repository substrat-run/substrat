/**
 * The test that matters: drive the PLATFORM'S OWN relying party against this issuer.
 *
 * A dev issuer is only worth having if the app in front of it runs its production login
 * path, so asserting the endpoints in isolation would miss the point — `@substrat-run/oidc-rp`
 * is the code that must be satisfied, PKCE, state, nonce, JWKS verification and all. If this
 * suite passes, a vertical needs no dev branch to log in locally.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { beginLogin, completeLogin, type OidcEnv } from '@substrat-run/oidc-rp';
import { createDevIssuer } from '../src/issuer.js';
import type { DevPersona } from '../src/personas.js';

const ISSUER = 'http://issuer.test';
const APP = 'http://app.test';

const PERSONAS: DevPersona[] = [
  { sub: 'dev|anna', name: 'Anna Lindqvist', email: 'anna@example.test', note: 'office-admin' },
  { sub: 'dev|harald', name: 'Harald Berg', email: 'harald@example.test', note: 'technician' },
];

const app = createDevIssuer({ personas: PERSONAS, allowedRedirectPrefixes: [APP] });

const env: OidcEnv = {
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'callout-dev',
  OIDC_CLIENT_SECRET: 'not-checked-by-a-dev-issuer',
  SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long',
};

/**
 * Route the issuer's own origin into the Hono app and leave everything else alone — the RP
 * fetches discovery, the token endpoint and the JWKS by absolute URL, and jose's remote key
 * set uses the same global.
 */
let realFetch: typeof globalThis.fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as RequestInfo | URL, init);
    if (!req.url.startsWith(ISSUER)) return realFetch(input as RequestInfo, init);
    // `app.fetch` may answer synchronously; jose calls `.catch()` on what it gets back.
    return Promise.resolve(app.fetch(req));
  }) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Follow one `/authorize` GET without following its redirect. */
const authorize = (url: string) => app.fetch(new Request(url, { redirect: 'manual' }));

describe('discovery', () => {
  it('advertises the endpoints and algorithms the relying party needs', async () => {
    const doc = (await (await app.fetch(new Request(`${ISSUER}/.well-known/openid-configuration`))).json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
    expect(doc.jwks_uri).toBe(`${ISSUER}/jwks.json`);
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('publishes exactly one signing key', async () => {
    const jwks = (await (await app.fetch(new Request(`${ISSUER}/jwks.json`))).json()) as { keys: { kid: string; d?: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe('substrat-dev-issuer');
    // The published half must be the PUBLIC one — a `d` here would hand out the private key.
    expect(jwks.keys[0]?.d).toBeUndefined();
  });
});

describe('the full login round-trip', () => {
  it('carries a picked persona all the way to a verified session', async () => {
    const { location, flow } = await beginLogin(env, APP, { returnTo: '/orders' });

    // The picker: no user chosen yet, so this is a page, not a redirect.
    const picker = await authorize(location);
    expect(picker.status).toBe(200);
    const html = await picker.text();
    expect(html).toContain('Anna Lindqvist');
    expect(html).toContain('Harald Berg');
    expect(html).toContain('callout-dev'); // it says who is asking

    // Pick Harald — the same request plus `sub`, which is what the picker's links are.
    const picked = await authorize(`${location}&sub=${encodeURIComponent('dev|harald')}`);
    expect(picked.status).toBe(302);
    const back = new URL(picked.headers.get('location') ?? '');
    expect(back.origin + back.pathname).toBe(`${APP}/api/auth/callback`);
    expect(back.searchParams.get('code')).toBeTruthy();

    // The RP completes it: state check, token exchange, JWKS signature, nonce.
    const done = await completeLogin(env, APP, back, flow);
    expect(done.user.id).toBe('dev|harald');
    expect(done.user.email).toBe('harald@example.test');
    expect(done.user.name).toBe('Harald Berg');
    expect(done.returnTo).toBe('/orders');
    expect(done.session).toBeTruthy();
  });

  it('rejects a code replayed with someone else’s login flow', async () => {
    const first = await beginLogin(env, APP);
    const second = await beginLogin(env, APP);
    const picked = await authorize(`${first.location}&sub=${encodeURIComponent('dev|anna')}`);
    const back = new URL(picked.headers.get('location') ?? '');
    // `second.flow` carries a different state, and state mismatch is the RP's first gate.
    await expect(completeLogin(env, APP, back, second.flow)).rejects.toThrow(/state mismatch/);
  });

  it('rejects an exchange whose PKCE verifier does not match', async () => {
    const { location } = await beginLogin(env, APP);
    const picked = await authorize(`${location}&sub=${encodeURIComponent('dev|anna')}`);
    const code = new URL(picked.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const res = await app.fetch(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${APP}/api/auth/callback`,
          client_id: env.OIDC_CLIENT_ID,
          code_verifier: 'a-verifier-that-was-never-the-one-challenged',
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_description: string }).error_description).toMatch(/PKCE/);
  });

  it('rejects an exchange redirected somewhere other than where the code was issued', async () => {
    const { location } = await beginLogin(env, APP);
    const picked = await authorize(`${location}&sub=${encodeURIComponent('dev|anna')}`);
    const code = new URL(picked.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const res = await app.fetch(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://localhost:9999/api/auth/callback',
          client_id: env.OIDC_CLIENT_ID,
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('what the issuer refuses', () => {
  it('will not redirect anywhere but loopback and the configured prefixes', async () => {
    const res = await authorize(
      `${ISSUER}/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent('https://evil.example/steal')}`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/loopback/);
  });

  it('reports an unknown response_type back to the relying party as an OAuth error', async () => {
    const res = await authorize(
      `${ISSUER}/authorize?response_type=token&client_id=x&redirect_uri=${encodeURIComponent(`${APP}/cb`)}&state=s1`,
    );
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location') ?? '');
    expect(back.searchParams.get('error')).toBe('unsupported_response_type');
    expect(back.searchParams.get('state')).toBe('s1');
  });

  it('fails prompt=none rather than showing the picker it was told not to show', async () => {
    const res = await authorize(
      `${ISSUER}/authorize?response_type=code&client_id=x&prompt=none&redirect_uri=${encodeURIComponent(`${APP}/cb`)}`,
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('login_required');
  });

  it('will not issue a code for a persona it does not serve', async () => {
    const { location } = await beginLogin(env, APP);
    const res = await authorize(`${location}&sub=${encodeURIComponent('dev|nobody')}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Unknown user');
  });
});

describe('the non-interactive door', () => {
  it('mints a token a bearer verifier accepts, with no browser', async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/dev/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'dev|anna', audience: 'callout-dev' }),
      }),
    );
    expect(res.status).toBe(200);
    const { access_token: token } = (await res.json()) as { access_token: string };

    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${ISSUER}/jwks.json`)), {
      issuer: ISSUER,
      audience: 'callout-dev',
    });
    expect(payload.sub).toBe('dev|anna');
    expect(payload.email).toBe('anna@example.test');
  });

  it('refuses a sub it does not know', async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/dev/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'dev|nobody' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
