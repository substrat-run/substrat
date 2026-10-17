import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mountOidcRoutes, tokenAuthOf, SESSION_COOKIE, type OidcEnv } from '../src/index.js';

/**
 * How the client secret reaches the token endpoint (`OIDC_TOKEN_AUTH`). An issuer holds the
 * method per client and refuses the other one, so what is asserted is the request the issuer
 * would see: where the secret is, and that it is in exactly one place.
 */

const APP = 'https://app.test';

let n = 0;
let ISSUER: string;
let env: OidcEnv;
let privateKey: CryptoKey;
let jwks: { keys: object[] };
let seen: { authorization: string | null; body: URLSearchParams } | undefined;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  n += 1;
  ISSUER = `https://token-auth-${n}.test`;
  env = {
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'client-1',
    OIDC_CLIENT_SECRET: 's3cret:with/odd%chars',
    SESSION_SECRET: 'session-secret-000000000000000000000001',
  };
  seen = undefined;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body));
      seen = { authorization: new Headers(init?.headers).get('authorization'), body };
      const idToken = await new SignJWT({ nonce: body.get('__nonce'), sub: 'u-1', email: 'a@example.test', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience('client-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({ id_token: idToken, access_token: 'at-1', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A full login through the mounted routes; resolves to the callback's response. */
async function login(e: OidcEnv): Promise<Response> {
  const a = new Hono<{ Bindings: OidcEnv }>();
  mountOidcRoutes(a);
  const start = await a.request(`${APP}/api/auth/login`, {}, e);
  const flow = /sb_oidc_flow=([^;]+)/.exec((start.headers as unknown as { getSetCookie(): string[] }).getSetCookie().join('\n'))?.[1];
  const authorize = new URL(start.headers.get('location')!);

  const original = globalThis.fetch;
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/token')) {
      const body = new URLSearchParams(String(init?.body));
      body.set('__nonce', authorize.searchParams.get('nonce')!);
      return original(input as RequestInfo, { ...init, body });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch);
  return a.request(
    `${APP}/api/auth/callback?code=c-1&state=${authorize.searchParams.get('state')}`,
    { headers: { cookie: `sb_oidc_flow=${flow}` } },
    e,
  );
}

const signedIn = (res: Response): boolean =>
  (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().some((h) => h.startsWith(`${SESSION_COOKIE}=`));

describe('OIDC_TOKEN_AUTH', () => {
  it('posts the secret in the body by default, as it always did', async () => {
    const res = await login(env);
    expect(signedIn(res)).toBe(true);
    expect(seen!.authorization).toBeNull();
    expect(seen!.body.get('client_secret')).toBe('s3cret:with/odd%chars');
  });

  it('sends it as HTTP Basic when asked, with the id and secret form-urlencoded first, and not in the body', async () => {
    const res = await login({ ...env, OIDC_TOKEN_AUTH: 'basic' });
    expect(signedIn(res)).toBe(true);
    const expected = `Basic ${btoa(`${encodeURIComponent('client-1')}:${encodeURIComponent('s3cret:with/odd%chars')}`)}`;
    expect(seen!.authorization).toBe(expected);
    expect(seen!.body.has('client_secret')).toBe(false);
    // The code and verifier still travel in the body.
    expect(seen!.body.get('code')).toBe('c-1');
    expect(seen!.body.get('code_verifier')).toBeTruthy();
  });

  it('applies the alternate issuer\'s own setting to an alt login, not the default\'s', async () => {
    const both = {
      ...env,
      OIDC_ALT_ISSUER: ISSUER,
      OIDC_ALT_CLIENT_ID: 'client-1',
      OIDC_ALT_CLIENT_SECRET: 'alt-secret',
    };
    const a = new Hono<{ Bindings: OidcEnv }>();
    mountOidcRoutes(a);
    // Default basic, alternate unset (post): an alt round posts.
    const start = await a.request(`${APP}/api/auth/login?idp=alt`, {}, { ...both, OIDC_TOKEN_AUTH: 'basic' });
    const flow = /sb_oidc_flow=([^;]+)/.exec((start.headers as unknown as { getSetCookie(): string[] }).getSetCookie().join('\n'))![1];
    const authorize = new URL(start.headers.get('location')!);
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/token')) {
        const body = new URLSearchParams(String(init?.body));
        body.set('__nonce', authorize.searchParams.get('nonce')!);
        return original(input as RequestInfo, { ...init, body });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch);
    const res = await a.request(
      `${APP}/api/auth/callback?code=c-1&state=${authorize.searchParams.get('state')}`,
      { headers: { cookie: `sb_oidc_flow=${flow}` } },
      { ...both, OIDC_TOKEN_AUTH: 'basic' },
    );
    expect(signedIn(res)).toBe(true);
    expect(seen!.authorization).toBeNull();
    expect(seen!.body.get('client_secret')).toBe('alt-secret');
  });

  it('refuses a value it does not know, rather than guessing a method', async () => {
    expect(() => tokenAuthOf({ OIDC_TOKEN_AUTH: 'Basic' })).toThrow(/must be 'basic' or 'post'/);
    const res = await login({ ...env, OIDC_TOKEN_AUTH: 'jwt' });
    expect(signedIn(res)).toBe(false);
    expect(res.headers.get('location')).toBe('/?error=auth');
    expect(seen).toBeUndefined();
  });

  it('reads unset and empty as post', () => {
    expect(tokenAuthOf({})).toBe('post');
    expect(tokenAuthOf({ OIDC_TOKEN_AUTH: '' })).toBe('post');
    expect(tokenAuthOf({ OIDC_TOKEN_AUTH: 'post' })).toBe('post');
    expect(tokenAuthOf({ OIDC_TOKEN_AUTH: 'basic' })).toBe('basic');
  });
});
