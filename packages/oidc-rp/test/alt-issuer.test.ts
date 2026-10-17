import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { envForIdp, idpOf, mountOidcRoutes, verifySession, LOGOUT_HINT_COOKIE, SESSION_COOKIE, type OidcEnv } from '../src/index.js';

/**
 * A second issuer, reached only by `?idp=alt`, driven through the mounted routes: the
 * question is which issuer the browser is sent to and which one the callback believes,
 * and only the routes decide either.
 *
 * Two issuers share one signing key on purpose. Were they separate keys, a token from
 * the wrong issuer would fail on its signature and the test would pass without the
 * `iss`/`aud` check the callback is meant to rely on.
 */

const APP = 'https://app.test';

let n = 0;
let DEFAULT: string;
let ALT: string;
let env: OidcEnv;
let privateKey: CryptoKey;
let jwks: { keys: object[] };
/** Which token endpoints were hit, in order — the proof of where a code was sent. */
let tokenCalls: { issuer: string; clientId: string }[];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  // Discovery is cached per issuer for the life of the isolate: a fresh pair per case.
  n += 1;
  DEFAULT = `https://default-${n}.test`;
  ALT = `https://alt-${n}.test`;
  env = {
    OIDC_ISSUER: DEFAULT,
    OIDC_CLIENT_ID: 'default-client',
    OIDC_CLIENT_SECRET: 'default-secret',
    OIDC_ALT_ISSUER: ALT,
    OIDC_ALT_CLIENT_ID: 'alt-client',
    OIDC_ALT_CLIENT_SECRET: 'alt-secret',
    SESSION_SECRET: 'session-secret-000000000000000000000001',
  };
  tokenCalls = [];

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const issuer of [DEFAULT, ALT]) {
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/end-session`,
        });
      }
      if (url === `${issuer}/jwks`) return Response.json(jwks);
      if (url === `${issuer}/token`) {
        const body = new URLSearchParams(String(init?.body));
        tokenCalls.push({ issuer, clientId: body.get('client_id')! });
        // The ID token is minted by whichever issuer a test says answered (`__as`),
        // addressed to whichever client the request named.
        const as = body.get('__as') ?? issuer;
        const idToken = await new SignJWT({ nonce: body.get('__nonce'), sub: 'u-1', email: 'a@example.test', email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(as)
          .setAudience(body.get('client_id')!)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return Response.json({ id_token: idToken, access_token: 'at-1', token_type: 'Bearer' });
      }
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function app(): Hono<{ Bindings: OidcEnv }> {
  const a = new Hono<{ Bindings: OidcEnv }>();
  mountOidcRoutes(a);
  return a;
}

function cookiesOf(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
    const pair = header.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return jar;
}

/** Start a login, then land the callback. `as` makes the token endpoint sign as another issuer. */
async function login(query: string, opts: { as?: string; env?: OidcEnv } = {}) {
  const e = opts.env ?? env;
  const a = app();
  const start = await a.request(`${APP}/api/auth/login${query}`, {}, e);
  const location = new URL(start.headers.get('location')!, APP);
  const flow = cookiesOf(start).get('sb_oidc_flow');
  if (!flow) return { start, location, callback: undefined as Response | undefined };

  const original = globalThis.fetch;
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    if (String(input).endsWith('/token')) {
      body.set('__nonce', location.searchParams.get('nonce')!);
      if (opts.as) body.set('__as', opts.as);
      return original(input as RequestInfo, { ...init, body });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch);
  const callback = await a.request(
    `${APP}/api/auth/callback?code=c-1&state=${location.searchParams.get('state')}`,
    { headers: { cookie: `sb_oidc_flow=${flow}` } },
    e,
  );
  return { start, location, callback };
}

describe('?idp=alt', () => {
  it('sends a plain login to the default issuer, as it always did', async () => {
    const { location, callback } = await login('');
    expect(location.origin).toBe(DEFAULT);
    expect(location.searchParams.get('client_id')).toBe('default-client');
    expect(tokenCalls).toEqual([{ issuer: DEFAULT, clientId: 'default-client' }]);
    expect(cookiesOf(callback!).get(SESSION_COOKIE)).toBeTruthy();
  });

  it('sends an alt login to the alternate issuer with its own client, and trusts that issuer at the callback', async () => {
    const { location, callback } = await login('?idp=alt');
    expect(location.origin).toBe(ALT);
    expect(location.searchParams.get('client_id')).toBe('alt-client');
    // The redirect URI is the same for both: one callback registered at each issuer.
    expect(location.searchParams.get('redirect_uri')).toBe(`${APP}/api/auth/callback`);
    expect(tokenCalls).toEqual([{ issuer: ALT, clientId: 'alt-client' }]);

    const jar = cookiesOf(callback!);
    // A session minted by either issuer is the same session: it is signed by the app.
    const user = await verifySession(env, jar.get(SESSION_COOKIE));
    expect(user).toMatchObject({ id: 'u-1', email: 'a@example.test', emailVerified: true });
    expect(jar.get(LOGOUT_HINT_COOKIE)).toBeTruthy();
  });

  it('refuses an ID token the default issuer signed for an alt round', async () => {
    const { callback } = await login('?idp=alt', { as: DEFAULT });
    expect(callback!.headers.get('location')).toBe('/?error=auth');
    expect(cookiesOf(callback!).get(SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses an ID token the alternate issuer signed for a default round', async () => {
    const { callback } = await login('', { as: ALT });
    expect(callback!.headers.get('location')).toBe('/?error=auth');
    expect(cookiesOf(callback!).get(SESSION_COOKIE)).toBeUndefined();
  });

  it('does not fall back to the default issuer when the alternate is not configured', async () => {
    const bare: OidcEnv = { ...env, OIDC_ALT_ISSUER: undefined, OIDC_ALT_CLIENT_ID: undefined, OIDC_ALT_CLIENT_SECRET: undefined };
    const { start } = await login('?idp=alt', { env: bare });
    expect(start.headers.get('location')).toBe('/?error=auth');
    expect(cookiesOf(start).get('sb_oidc_flow')).toBeUndefined();
    expect(tokenCalls).toEqual([]);
  });

  it('treats a half-set trio as not configured', () => {
    expect(envForIdp({ ...env, OIDC_ALT_CLIENT_SECRET: undefined }, 'alt')).toBeNull();
    expect(envForIdp({ ...env, OIDC_ALT_ISSUER: '' }, 'alt')).toBeNull();
    expect(envForIdp(env, 'alt')).toMatchObject({ OIDC_ISSUER: ALT, OIDC_CLIENT_ID: 'alt-client', OIDC_CLIENT_SECRET: 'alt-secret' });
    expect(envForIdp(env, undefined)).toBe(env);
  });

  it('accepts the value alt and nothing else', async () => {
    expect(idpOf('alt')).toBe('alt');
    for (const v of ['ALT', 'default', '', 'alt ', null, undefined]) expect(idpOf(v)).toBeUndefined();
    const { location } = await login('?idp=default');
    expect(location.origin).toBe(DEFAULT);
  });

  it('ends the alternate issuer\'s session at sign-out when the login came from it', async () => {
    const a = app();
    const { callback } = await login('?idp=alt');
    const hint = cookiesOf(callback!).get(LOGOUT_HINT_COOKIE)!;
    const res = await a.request(`${APP}/api/auth/logout?federated`, { headers: { cookie: `${LOGOUT_HINT_COOKIE}=${hint}` } }, env);
    const out = new URL(res.headers.get('location')!);
    expect(out.origin).toBe(ALT);
    expect(out.pathname).toBe('/end-session');
    expect(out.searchParams.get('client_id')).toBe('alt-client');
    expect(out.searchParams.get('id_token_hint')).toBe(hint);
  });

  /** The ID-token hint a login at `query` on `loginEnv` leaves. One login per case: `login` stacks its fetch stub. */
  async function hintOf(query: string, loginEnv: OidcEnv): Promise<string> {
    const { callback } = await login(query, { env: loginEnv });
    const hint = cookiesOf(callback!).get(LOGOUT_HINT_COOKIE)!;
    expect(hint).toBeTruthy();
    return hint;
  }

  /** Where a federated sign-out on `logoutEnv` sends the browser holding `hint`. */
  async function signOutWith(hint: string, logoutEnv: OidcEnv): Promise<URL> {
    const res = await app().request(`${APP}/api/auth/logout?federated`, { headers: { cookie: `${LOGOUT_HINT_COOKIE}=${hint}` } }, logoutEnv);
    return new URL(res.headers.get('location')!, APP);
  }

  it('ends the alternate issuer\'s session when its configured issuer carries a trailing slash', async () => {
    // Discovery and the callback compare issuers with one trailing slash dropped, so this
    // login works; sign-out must agree, or it sends the alt token to the default issuer.
    const slashed: OidcEnv = { ...env, OIDC_ALT_ISSUER: `${ALT}/` };
    const hint = await hintOf('?idp=alt', slashed);
    const out = await signOutWith(hint, slashed);
    expect(out.origin).toBe(ALT);
    expect(out.searchParams.get('client_id')).toBe('alt-client');
    expect(out.searchParams.get('id_token_hint')).toBe(hint);
  });

  it('ends the default issuer\'s session when its configured issuer carries a trailing slash', async () => {
    const slashed: OidcEnv = { ...env, OIDC_ISSUER: `${DEFAULT}/` };
    const out = await signOutWith(await hintOf('', slashed), slashed);
    expect(out.origin).toBe(DEFAULT);
    expect(out.searchParams.get('client_id')).toBe('default-client');
  });

  it('ends the alternate issuer\'s session when only the default issuer carries a trailing slash', async () => {
    const slashed: OidcEnv = { ...env, OIDC_ISSUER: `${DEFAULT}/` };
    const out = await signOutWith(await hintOf('?idp=alt', slashed), slashed);
    expect(out.origin).toBe(ALT);
    expect(out.searchParams.get('client_id')).toBe('alt-client');
  });

  it('sends an alt login\'s sign-out to the default issuer once the alternate is unset, as before it existed', async () => {
    const bare: OidcEnv = { ...env, OIDC_ALT_ISSUER: undefined, OIDC_ALT_CLIENT_ID: undefined, OIDC_ALT_CLIENT_SECRET: undefined };
    const out = await signOutWith(await hintOf('?idp=alt', env), bare);
    expect(out.origin).toBe(DEFAULT);
    expect(out.searchParams.get('client_id')).toBe('default-client');
  });

  it('never sends an alt login\'s sign-out to a half-set alternate', async () => {
    // A half-set trio is not configured (envForIdp), at sign-out as at login.
    const hint = await hintOf('?idp=alt', env);
    for (const half of [{ OIDC_ALT_CLIENT_ID: undefined }, { OIDC_ALT_CLIENT_SECRET: '' }]) {
      const out = await signOutWith(hint, { ...env, ...half });
      expect(out.origin).toBe(DEFAULT);
      expect(out.searchParams.get('client_id')).toBe('default-client');
    }
  });

  it('ends the default issuer\'s session at sign-out when the login came from it', async () => {
    const a = app();
    const { callback } = await login('');
    const hint = cookiesOf(callback!).get(LOGOUT_HINT_COOKIE)!;
    const res = await a.request(`${APP}/api/auth/logout?federated`, { headers: { cookie: `${LOGOUT_HINT_COOKIE}=${hint}` } }, env);
    const out = new URL(res.headers.get('location')!);
    expect(out.origin).toBe(DEFAULT);
    expect(out.searchParams.get('client_id')).toBe('default-client');
  });
});
