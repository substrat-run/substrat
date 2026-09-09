import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beginLogin, completeLogin, type OidcEnv } from '../src/index.js';

/**
 * The callback's code→token exchange, against a STUBBED issuer, focused on where the
 * profile claims come from.
 *
 * OIDC Core §5.4 routes scope-requested claims (`email`, `name`, …) to UserInfo whenever
 * an access token is issued — always, in the authorization-code flow — so a provider is
 * entirely within spec to return an ID token carrying nothing but `sub` and the protocol
 * claims. Providers split on this, and reading only the ID token quietly produced a
 * session with no address against the spec-faithful half.
 */

const ISSUER = 'https://issuer.test';
const APP = 'https://app.test';

const env: OidcEnv = {
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'client-1',
  OIDC_CLIENT_SECRET: 'client-secret-1',
  SESSION_SECRET: 'session-secret-000000000000000000000001',
};

let privateKey: CryptoKey;
let jwks: { keys: object[] };

/** What the stubbed issuer does on this test's round trip. */
let idTokenClaims: Record<string, unknown>;
let userInfo: { status: number; body: unknown } | null;
let advertiseUserInfo: boolean;
let issueAccessToken: boolean;
let userInfoRequests: { authorization: string | null }[];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  idTokenClaims = {};
  userInfo = null;
  advertiseUserInfo = true;
  issueAccessToken = true;
  userInfoRequests = [];

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        ...(advertiseUserInfo ? { userinfo_endpoint: `${ISSUER}/userinfo` } : {}),
      });
    }
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    if (url === `${ISSUER}/token`) {
      const nonce = new URLSearchParams(String(init?.body)).get('__nonce');
      const idToken = await new SignJWT({ nonce, ...idTokenClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(env.OIDC_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({
        id_token: idToken,
        ...(issueAccessToken ? { access_token: 'at-1', token_type: 'Bearer' } : {}),
      });
    }
    if (url === `${ISSUER}/userinfo`) {
      userInfoRequests.push({
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (!userInfo) throw new Error('userinfo called with nothing staged');
      return new Response(JSON.stringify(userInfo.body), {
        status: userInfo.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Drive a full round trip. `beginLogin` mints the real signed flow cookie, so the state
 * and nonce under test are the ones the library itself produced — the nonce rides to the
 * stub through a spare form field so the signed ID token can echo it back.
 */
async function login(): Promise<Awaited<ReturnType<typeof completeLogin>>> {
  const { location, flow } = await beginLogin(env, APP);
  const authorize = new URL(location);
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
  const callback = new URL(`${APP}/api/auth/callback?code=c-1&state=${state}`);
  return completeLogin(env, APP, callback, flow);
}

describe('the profile claims OIDC Core §5.4 routes to UserInfo', () => {
  it('fetches them when the ID token carries only sub', async () => {
    idTokenClaims = { sub: 'u-1' };
    userInfo = { status: 200, body: { sub: 'u-1', email: 'a@example.test', name: 'A Person' } };

    const { user } = await login();

    expect(user).toEqual({ id: 'u-1', email: 'a@example.test', name: 'A Person' });
    // The access token is what authorizes the call — it used to be discarded unread.
    expect(userInfoRequests).toEqual([{ authorization: 'Bearer at-1' }]);
  });

  it('does not call UserInfo when the ID token already carried them', async () => {
    idTokenClaims = { sub: 'u-1', email: 'a@example.test', name: 'A Person' };

    const { user } = await login();

    expect(user.email).toBe('a@example.test');
    // A provider that includes the claims pays no extra round trip and is unchanged.
    expect(userInfoRequests).toEqual([]);
  });

  it('lets the ID token win — UserInfo fills gaps, it never overwrites', async () => {
    idTokenClaims = { sub: 'u-1', email: 'signed@example.test' };
    userInfo = { status: 200, body: { sub: 'u-1', email: 'other@example.test', name: 'A Person' } };

    const { user } = await login();

    // The name was missing and is filled; the address was signed into a token we
    // verified, and nothing unsigned may replace it.
    expect(user.email).toBe('signed@example.test');
    expect(user.name).toBe('A Person');
  });
});

describe('what it refuses, and what it merely shrugs at', () => {
  it('refuses a UserInfo response for a different subject (§5.3.2)', async () => {
    idTokenClaims = { sub: 'u-1' };
    userInfo = { status: 200, body: { sub: 'someone-else', email: 'a@example.test' } };

    // Not using the values is the floor the spec sets. Refusing the login says it out
    // loud: a mismatch is never a quirk, it is a response about a different person.
    await expect(login()).rejects.toThrow(/sub does not match/);
  });

  it('refuses a UserInfo response with no sub at all', async () => {
    idTokenClaims = { sub: 'u-1' };
    userInfo = { status: 200, body: { email: 'a@example.test' } };

    await expect(login()).rejects.toThrow(/sub does not match/);
  });

  for (const [label, stage] of [
    ['the endpoint answers non-2xx', () => { userInfo = { status: 403, body: { error: 'nope' } }; }],
    ['the endpoint answers something that is not JSON', () => { userInfo = { status: 200, body: undefined }; }],
    ['the issuer advertises no userinfo_endpoint', () => { advertiseUserInfo = false; }],
    ['no access token came back with the code', () => { issueAccessToken = false; }],
  ] as const) {
    it(`stands the login up when ${label}`, async () => {
      idTokenClaims = { sub: 'u-1' };
      stage();

      const { user } = await login();

      // The ID token is the authentication; this is enrichment, and enrichment must
      // never be able to lock anyone out.
      expect(user).toEqual({ id: 'u-1', email: undefined, name: undefined });
    });
  }
});
