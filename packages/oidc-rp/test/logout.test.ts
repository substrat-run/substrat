import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mountOidcRoutes, LOGOUT_HINT_COOKIE, SESSION_COOKIE, type OidcEnv } from '../src/index.js';

/**
 * RP-initiated logout, driven through the mounted routes rather than a helper — the
 * question is what the browser is *sent to*, and only the routes decide that.
 *
 * The thing under test is `id_token_hint`. Without it an OP cannot tell a real sign-out
 * from a link someone was tricked into following, so OIDC RP-Initiated Logout §2 says it
 * SHOULD ask the person to confirm, and Better Auth's provider does exactly that: a
 * "Confirm logout" interstitial in the middle of what the person already asked for. The
 * hint is what turns that into a straight redirect, so the cookie carrying it has to
 * survive from the login callback to the logout request — which is the part a helper-level
 * test cannot see.
 */

const APP = 'https://app.test';

let issuers = 0;
let ISSUER: string;
let env: OidcEnv;

let privateKey: CryptoKey;
let jwks: { keys: object[] };
/** Whether this test's issuer advertises RP-initiated logout at all. */
let advertiseEndSession: boolean;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  // Per-case issuer: discovery is cached per issuer for the life of the isolate, so a
  // shared one would hand the second case the first case's metadata.
  ISSUER = `https://issuer-logout-${++issuers}.test`;
  env = {
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'client-1',
    OIDC_CLIENT_SECRET: 'client-secret-1',
    SESSION_SECRET: 'session-secret-000000000000000000000001',
  };
  advertiseEndSession = true;

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        ...(advertiseEndSession
          ? { end_session_endpoint: `${ISSUER}/api/auth/oauth2/end-session` }
          : {}),
      });
    }
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    if (url === `${ISSUER}/token`) {
      const nonce = new URLSearchParams(String(init?.body)).get('__nonce');
      const idToken = await new SignJWT({ nonce, sub: 'u-1', email: 'a@example.test', sid: 's-1' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(env.OIDC_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({ id_token: idToken, access_token: 'at-1', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => vi.unstubAllGlobals());

function app(): Hono<{ Bindings: OidcEnv }> {
  const a = new Hono<{ Bindings: OidcEnv }>();
  mountOidcRoutes(a);
  return a;
}

/**
 * The `set-cookie` headers, unjoined. `getSetCookie` is the only correct way to read
 * them — `get('set-cookie')` returns one comma-joined string — and it exists in every
 * runtime this package targets; the cast is only because the `@cloudflare/workers-types`
 * `Headers` this project compiles tests against does not declare it yet.
 */
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

/** Every `set-cookie` the response carries, as name → value. */
function cookiesOf(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of setCookies(res)) {
    const pair = header.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return jar;
}

/** The `set-cookie` header for one cookie, whole — attributes included. */
function setCookieFor(res: Response, name: string): string | undefined {
  return setCookies(res).find((h) => h.startsWith(`${name}=`));
}

/**
 * A full login through the mounted routes, returning the cookies the browser now holds.
 * The nonce rides to the stubbed token endpoint through a spare form field so the signed
 * ID token can echo back the one the library itself minted.
 */
async function signIn(a: Hono<{ Bindings: OidcEnv }>): Promise<Map<string, string>> {
  const start = await a.request(`${APP}/api/auth/login`, {}, env);
  const flow = cookiesOf(start).get('sb_oidc_flow')!;
  const authorize = new URL(start.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  const nonce = authorize.searchParams.get('nonce')!;

  const original = globalThis.fetch;
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== `${ISSUER}/token`) return original(input as RequestInfo, init);
    const body = new URLSearchParams(String(init?.body));
    body.set('__nonce', nonce);
    return original(input as RequestInfo, { ...init, body });
  }) as typeof fetch);

  const back = await a.request(
    `${APP}/api/auth/callback?code=c-1&state=${state}`,
    { headers: { cookie: `sb_oidc_flow=${flow}` } },
    env,
  );
  expect(back.status).toBe(302);
  return cookiesOf(back);
}

describe('federated logout', () => {
  it('hands the issuer the ID token from this login, so no confirmation is needed', async () => {
    const a = app();
    const jar = await signIn(a);
    const hint = jar.get(LOGOUT_HINT_COOKIE);
    expect(hint).toBeTruthy();

    const res = await a.request(
      `${APP}/api/auth/logout?federated`,
      { headers: { cookie: `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)}; ${LOGOUT_HINT_COOKIE}=${hint}` } },
      env,
    );

    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/api/auth/oauth2/end-session`);
    expect(to.searchParams.get('id_token_hint')).toBe(hint);
    // Still both of the things the OP matches the request against.
    expect(to.searchParams.get('client_id')).toBe('client-1');
    expect(to.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/`);
  });

  it('scopes the hint cookie to the logout path, so it rides one request and not every one', async () => {
    const a = app();
    const start = await a.request(`${APP}/api/auth/login`, {}, env);
    const flow = cookiesOf(start).get('sb_oidc_flow')!;
    const authorize = new URL(start.headers.get('location')!);
    const nonce = authorize.searchParams.get('nonce')!;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== `${ISSUER}/token`) return original(input as RequestInfo, init);
      const body = new URLSearchParams(String(init?.body));
      body.set('__nonce', nonce);
      return original(input as RequestInfo, { ...init, body });
    }) as typeof fetch);
    const back = await a.request(
      `${APP}/api/auth/callback?code=c-1&state=${authorize.searchParams.get('state')}`,
      { headers: { cookie: `sb_oidc_flow=${flow}` } },
      env,
    );

    const header = setCookieFor(back, LOGOUT_HINT_COOKIE)!;
    expect(header).toContain('Path=/api/auth/logout');
    expect(header).toContain('HttpOnly');
    // The session cookie is the one that must reach every route; the hint must not.
    expect(setCookieFor(back, SESSION_COOKIE)).toContain('Path=/');
  });

  it('clears the hint on the way out, on the path it was set with', async () => {
    const a = app();
    const jar = await signIn(a);

    const res = await a.request(
      `${APP}/api/auth/logout?federated`,
      { headers: { cookie: `${LOGOUT_HINT_COOKIE}=${jar.get(LOGOUT_HINT_COOKIE)}` } },
      env,
    );

    // A Max-Age=0 whose path does not match the original deletes nothing, so the path is
    // the assertion — not merely that something was cleared.
    const cleared = setCookieFor(res, LOGOUT_HINT_COOKIE)!;
    expect(cleared).toContain('Path=/api/auth/logout');
    expect(cleared).toMatch(/Max-Age=0/);
  });

  it('still logs out when there is no hint — a session minted before this version', async () => {
    const a = app();
    const jar = await signIn(a);

    // The browser holds the session but not the hint: the OP will show its confirmation
    // page, which is correct, and the next login puts the hint back.
    const res = await a.request(
      `${APP}/api/auth/logout?federated`,
      { headers: { cookie: `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)}` } },
      env,
    );

    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/api/auth/oauth2/end-session`);
    expect(to.searchParams.has('id_token_hint')).toBe(false);
  });

  it('stays local when the issuer advertises no end-session endpoint', async () => {
    advertiseEndSession = false;
    const a = app();
    const jar = await signIn(a);

    const res = await a.request(
      `${APP}/api/auth/logout?federated&returnTo=/bye`,
      { headers: { cookie: `${LOGOUT_HINT_COOKIE}=${jar.get(LOGOUT_HINT_COOKIE)}` } },
      env,
    );

    expect(res.headers.get('location')).toBe('/bye');
  });

  it('does not reach the issuer without ?federated', async () => {
    const a = app();
    const jar = await signIn(a);

    const res = await a.request(
      `${APP}/api/auth/logout`,
      { headers: { cookie: `${LOGOUT_HINT_COOKIE}=${jar.get(LOGOUT_HINT_COOKIE)}` } },
      env,
    );

    expect(res.headers.get('location')).toBe('/');
  });
});
