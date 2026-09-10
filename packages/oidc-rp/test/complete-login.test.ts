import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  beginLogin,
  completeLogin,
  mintSession,
  verifySession,
  USERINFO_TIMEOUT_MS,
  type OidcEnv,
} from '../src/index.js';

/**
 * The callback's code→token exchange, against a STUBBED issuer, focused on where the
 * profile claims come from.
 *
 * OIDC Core §5.4 routes scope-requested claims (`email`, `name`, …) to UserInfo whenever
 * an access token is issued — always, in the authorization-code flow — so a provider is
 * entirely within spec to return an ID token carrying nothing but `sub` and the protocol
 * claims. Providers split on this, and reading only the ID token quietly produced a
 * session with no address against the spec-faithful half.
 *
 * **Every case gets its own issuer URL**, and that is load-bearing rather than tidy:
 * discovery and JWKS are cached per issuer for the life of the isolate, so a shared
 * issuer would hand the second case the first case's metadata. The "advertises no
 * userinfo_endpoint" case in particular would then still call the endpoint it was
 * supposed to prove it never looks up, and pass for the wrong reason.
 */

const APP = 'https://app.test';

let issuers = 0;
let ISSUER: string;
let env: OidcEnv;

let privateKey: CryptoKey;
let jwks: { keys: object[] };

/** What the stubbed issuer does on this test's round trip. */
let idTokenClaims: Record<string, unknown>;
let userInfo: { status: number; body: unknown } | 'never answers' | null;
let advertiseUserInfo: boolean;
let issueAccessToken: boolean;
let userInfoRequests: { authorization: string | null; deadline: boolean }[];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  ISSUER = `https://issuer-${++issuers}.test`;
  env = {
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'client-1',
    OIDC_CLIENT_SECRET: 'client-secret-1',
    SESSION_SECRET: 'session-secret-000000000000000000000001',
  };
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
      const signal = init?.signal ?? null;
      userInfoRequests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        deadline: signal !== null && !signal.aborted,
      });
      if (!userInfo) throw new Error('userinfo called with nothing staged');
      // The endpoint that accepts the connection and then says nothing: it answers only
      // when the caller's own deadline gives up on it, which is the whole point.
      if (userInfo === 'never answers') {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      }
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
    // The access token is what authorizes the call — it used to be discarded unread —
    // and the call carries a deadline, because a `fetch` with no signal has none.
    expect(userInfoRequests).toEqual([{ authorization: 'Bearer at-1', deadline: true }]);
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

  for (const [label, stage, calls] of [
    ['the endpoint answers non-2xx', () => { userInfo = { status: 403, body: { error: 'nope' } }; }, 1],
    ['the endpoint answers something that is not JSON', () => { userInfo = { status: 200, body: undefined }; }, 1],
    // These two never reach the endpoint at all, and the request count is what says so:
    // a login that degraded because the call failed would look identical from the user.
    ['the issuer advertises no userinfo_endpoint', () => { advertiseUserInfo = false; }, 0],
    ['no access token came back with the code', () => { issueAccessToken = false; }, 0],
  ] as const) {
    it(`stands the login up when ${label}`, async () => {
      idTokenClaims = { sub: 'u-1' };
      stage();

      const { user } = await login();

      // The ID token is the authentication; this is enrichment, and enrichment must
      // never be able to lock anyone out.
      expect(user).toEqual({ id: 'u-1', email: undefined, name: undefined });
      expect(userInfoRequests).toHaveLength(calls);
    });
  }

  it(
    'stands the login up when the endpoint accepts the connection and never answers',
    async () => {
      idTokenClaims = { sub: 'u-1' };
      userInfo = 'never answers';

      // Real time, because the deadline is a real one: this is the case where an
      // unbounded fetch would hang the callback instead of degrading, so the test waits
      // for the actual signal rather than asserting one was merely attached.
      const { user } = await login();

      expect(user).toEqual({ id: 'u-1', email: undefined, name: undefined });
      expect(userInfoRequests).toEqual([{ authorization: 'Bearer at-1', deadline: true }]);
    },
    USERINFO_TIMEOUT_MS + 5_000,
  );
});

/**
 * `email_verified` — carried from wherever the address came from, all the way through the
 * session, and decided by nobody here (#1359).
 *
 * The claim is three-state and these tests are written around that: `true` and `false` are
 * the issuer asserting something, absent is the issuer saying nothing. Collapsing the third
 * into `false` is what would lock out every user of an IdP that never emits it, so the
 * distinction has to survive the mint/verify round trip as well as the login.
 */
describe('email_verified, carried and not decided', () => {
  /** A session cookie, verified straight back — the shape a later request would see. */
  const roundTrip = async (user: Awaited<ReturnType<typeof login>>['user']) =>
    verifySession(env, await mintSession(env, user));

  for (const [claim, expected] of [
    [true, true],
    [false, false],
    // Auth0's lineage has emitted the strings. `"false"` mattering is the point: dropping
    // it would turn a negative assertion into silence.
    ['true', true],
    ['false', false],
    // Neither a boolean nor one of those two strings — unreadable is not an assertion.
    [1, undefined],
    [{ verified: true }, undefined],
  ] as const) {
    it(`reads ${JSON.stringify(claim)} from the ID token as ${String(expected)}, and the session keeps it`, async () => {
      idTokenClaims = { sub: 'u-1', email: 'a@example.test', name: 'A Person', email_verified: claim };

      const { user } = await login();

      expect(user.emailVerified).toBe(expected);
      expect((await roundTrip(user))?.emailVerified).toBe(expected);
    });
  }

  it('leaves it undefined when the issuer asserts nothing — including across the session', async () => {
    idTokenClaims = { sub: 'u-1', email: 'a@example.test', name: 'A Person' };

    const { user } = await login();

    // An issuer that never emits the claim is not an issuer saying "unverified", and a
    // session minted from one is indistinguishable from a session minted before this
    // field existed — which is what every live session is for the rest of its seven days.
    expect(user.emailVerified).toBeUndefined();
    expect(await roundTrip(user)).toEqual({
      id: 'u-1',
      email: 'a@example.test',
      name: 'A Person',
      emailVerified: undefined,
    });
  });

  it('takes it from UserInfo when UserInfo is where the address came from', async () => {
    idTokenClaims = { sub: 'u-1' };
    userInfo = {
      status: 200,
      body: { sub: 'u-1', email: 'a@example.test', name: 'A Person', email_verified: true },
    };

    const { user } = await login();

    expect(user).toEqual({
      id: 'u-1',
      email: 'a@example.test',
      name: 'A Person',
      emailVerified: true,
    });
  });

  it('ignores a UserInfo flag when the address was signed into the ID token', async () => {
    idTokenClaims = { sub: 'u-1', email: 'signed@example.test' };
    userInfo = {
      status: 200,
      body: { sub: 'u-1', email: 'other@example.test', name: 'A Person', email_verified: true },
    };

    const { user } = await login();

    // The name is filled from UserInfo, as always. The flag is not: it would be an
    // unsigned "verified" vouching for an address it was never about — UserInfo's own
    // address having already lost to the ID token's on the line above.
    expect(user.name).toBe('A Person');
    expect(user.email).toBe('signed@example.test');
    expect(user.emailVerified).toBeUndefined();
  });

  it('does not spend a UserInfo round trip merely looking for the flag', async () => {
    idTokenClaims = { sub: 'u-1', email: 'a@example.test', name: 'A Person' };

    const { user } = await login();

    // Nothing is staged at the endpoint, so a call here would throw rather than degrade.
    // Most issuers never emit the claim, and `undefined` is already the honest answer.
    expect(userInfoRequests).toEqual([]);
    expect(user.emailVerified).toBeUndefined();
  });
});
