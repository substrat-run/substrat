import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, rateLimitOf, type Env } from '../src/routes.js';
import { b64url, b64urlDecode, sha256b64url } from '../src/jwt.js';
import { namespaceOf, pkcs8Pem, testStore, type TestStore } from './support.js';

/**
 * The relay's whole job is to stand between a tenant issuer and an upstream while holding
 * a credential neither of them may have (#1544), so the suite drives the real flow end to
 * end — authorize, upstream callback, token, userinfo — over the real store and the real
 * signing, with only the upstream itself faked.
 *
 * The cases that matter most are the ones nobody sees when they work: a code redeemed
 * twice, a verifier that does not match its challenge, a client secret that is close but
 * wrong, a disabled install. Each of those is a sign-in that must NOT happen.
 */

const NOW = 1_770_000_000_000;

/** A JWT-shaped id_token. Only its payload is ever read: the relay is the audience of a
 *  token it asked for over TLS, so it decodes rather than re-verifies (see `unverifiedClaims`). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const encoder = new TextEncoder();
  return [
    b64url(encoder.encode(JSON.stringify({ alg: 'RS256' }))),
    b64url(encoder.encode(JSON.stringify(claims))),
    'signature',
  ].join('.');
}

interface Upstream {
  calls: { url: string; body: URLSearchParams }[];
  fetch: typeof globalThis.fetch;
}

/** A stand-in for Google/GitHub/Apple, recording what the relay sent it. */
function upstream(
  handler: (url: string, body: URLSearchParams) => { status?: number; json: unknown },
): Upstream {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ url, body });
    const { status = 200, json } = handler(url, body);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

let store: TestStore;

const envWith = (over: Partial<Env> = {}): Env => ({
  RELAY: namespaceOf(store) as unknown as Env['RELAY'],
  PLATFORM_SECRET: 'platform-secret',
  GOOGLE_CLIENT_ID: 'platform-google-id',
  GOOGLE_CLIENT_SECRET: 'platform-google-secret',
  GITHUB_CLIENT_ID: 'platform-github-id',
  GITHUB_CLIENT_SECRET: 'platform-github-secret',
  ...over,
});

async function registerInstall(redirectUri = 'https://acme.global.substrat.run/api/auth/callback/platform-google') {
  return store.registerClient({ name: 'An install', redirectUris: [redirectUri] }, NOW);
}

/** The PKCE pair a tenant issuer would generate. */
async function pkce() {
  const verifier = 'a-verifier-that-is-long-enough-to-be-real';
  return { verifier, challenge: await sha256b64url(verifier) };
}

beforeEach(() => {
  store = testStore();
});

describe('discovery', () => {
  it('declares an issuer that matches the URL a tenant configured, per provider', async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request('https://id.substrat.net/google/.well-known/openid-configuration', {}, envWith());
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe('https://id.substrat.net/google');
    expect(doc.authorization_endpoint).toBe('https://id.substrat.net/google/authorize');
    expect(doc.jwks_uri).toBe('https://id.substrat.net/google/jwks.json');
    expect(doc.id_token_signing_alg_values_supported).toEqual(['ES256']);
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('404s a provider this deployment holds no credential for, rather than advertising it', async () => {
    const app = createApp({ now: () => NOW });
    // Apple's credentials are absent from `envWith`, so its whole surface is absent too —
    // a tenant's save-time discovery fails in the form instead of at a first sign-in.
    const res = await app.request('https://id.substrat.net/apple/.well-known/openid-configuration', {}, envWith());
    expect(res.status).toBe(404);
  });

  it('404s a provider it has never heard of', async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request('https://id.substrat.net/facebook/.well-known/openid-configuration', {}, envWith());
    expect(res.status).toBe(404);
  });
});

describe('authorize', () => {
  it('sends the person to the upstream with the PLATFORM client and the relay callback', async () => {
    const app = createApp({ now: () => NOW });
    const client = await registerInstall();
    const { challenge } = await pkce();
    const res = await app.request(
      `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://acme.global.substrat.run/api/auth/callback/platform-google')}` +
        `&state=tenant-state&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      envWith(),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe('platform-google-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://id.substrat.net/google/callback');
    // The tenant's own state never reaches the upstream; what travels is our flow id.
    expect(location.searchParams.get('state')).not.toBe('tenant-state');
    // Consent is remembered per (user, client), and this client is shared by every
    // install — so the account chooser is forced back in front of the person.
    expect(location.searchParams.get('prompt')).toBe('select_account');
  });

  it('renders rather than redirects when the client or its redirect URI is wrong', async () => {
    const app = createApp({ now: () => NOW });
    const client = await registerInstall();
    const { challenge } = await pkce();
    const unknown = await app.request(
      `https://id.substrat.net/google/authorize?response_type=code&client_id=nobody` +
        `&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      envWith(),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();

    const wrongUri = await app.request(
      `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      envWith(),
    );
    expect(wrongUri.status).toBe(400);
    expect(wrongUri.headers.get('location')).toBeNull();
  });

  it('refuses a round with no PKCE, and says so at the client', async () => {
    const app = createApp({ now: () => NOW });
    const client = await registerInstall();
    const res = await app.request(
      `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://acme.global.substrat.run/api/auth/callback/platform-google')}&state=s`,
      {},
      envWith(),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin).toBe('https://acme.global.substrat.run');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s');
  });

  it('turns a disabled install away — the per-install kill switch', async () => {
    const app = createApp({ now: () => NOW });
    const client = await registerInstall();
    await store.setClientDisabled(client.clientId, true);
    const { challenge } = await pkce();
    const res = await app.request(
      `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://acme.global.substrat.run/api/auth/callback/platform-google')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      envWith(),
    );
    expect(res.status).toBe(403);
  });

  it('stops one install from spending everyone else’s quota', async () => {
    const app = createApp({ now: () => NOW });
    const client = await registerInstall();
    const { challenge } = await pkce();
    const url =
      `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
      `&redirect_uri=${encodeURIComponent('https://acme.global.substrat.run/api/auth/callback/platform-google')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;
    const env = envWith({ AUTHORIZE_RATE_LIMIT: '2' });
    expect((await app.request(url, {}, env)).status).toBe(302);
    expect((await app.request(url, {}, env)).status).toBe(302);
    const third = await app.request(url, {}, env);
    const location = new URL(third.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('temporarily_unavailable');
    expect(location.origin).toBe('https://acme.global.substrat.run');
  });
});

/** Drive a whole round and return what the tenant issuer would hold at the end of it. */
async function signInThroughGoogle(options: { nonce?: string } = {}) {
  const google = upstream(() => ({
    json: {
      access_token: 'upstream-access',
      id_token: fakeIdToken({
        sub: 'google-subject-1',
        email: 'person@example.com',
        email_verified: true,
        name: 'A Person',
        picture: 'https://example.com/a.png',
      }),
    },
  }));
  const app = createApp({ now: () => NOW, fetchImpl: google.fetch });
  const env = envWith();
  const redirectUri = 'https://acme.global.substrat.run/api/auth/callback/platform-google';
  const client = await registerInstall(redirectUri);
  const { verifier, challenge } = await pkce();

  const started = await app.request(
    `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&state=tenant-state` +
      `&code_challenge=${challenge}&code_challenge_method=S256` +
      (options.nonce ? `&nonce=${options.nonce}` : ''),
    {},
    env,
  );
  const flowId = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';

  const back = await app.request(
    `https://id.substrat.net/google/callback?code=upstream-code&state=${flowId}`,
    {},
    env,
  );
  const returned = new URL(back.headers.get('location') ?? '');
  return { app, env, client, verifier, google, returned, redirectUri, flowId };
}

describe('the round trip', () => {
  it('returns the tenant to its own redirect with a code and its own state', async () => {
    const { returned, google } = await signInThroughGoogle();
    expect(returned.origin + returned.pathname).toBe(
      'https://acme.global.substrat.run/api/auth/callback/platform-google',
    );
    expect(returned.searchParams.get('state')).toBe('tenant-state');
    expect(returned.searchParams.get('code')).toBeTruthy();
    // The platform secret went to the upstream, and only to the upstream.
    expect(google.calls[0]?.body.get('client_secret')).toBe('platform-google-secret');
    expect(google.calls[0]?.body.get('redirect_uri')).toBe('https://id.substrat.net/google/callback');
  });

  it('mints an id_token the tenant can verify against the published JWKS', async () => {
    const { app, env, client, verifier, returned } = await signInThroughGoogle({ nonce: 'tenant-nonce' });
    const res = await app.request(
      'https://id.substrat.net/google/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: returned.searchParams.get('code') ?? '',
          redirect_uri: 'https://acme.global.substrat.run/api/auth/callback/platform-google',
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code_verifier: verifier,
        }).toString(),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id_token: string; access_token: string; token_type: string };
    expect(body.token_type).toBe('Bearer');

    const [rawHeader, rawPayload, rawSignature] = body.id_token.split('.') as [string, string, string];
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(rawPayload))) as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: 'https://id.substrat.net/google',
      aud: client.clientId,
      sub: 'google-subject-1',
      email: 'person@example.com',
      email_verified: true,
      name: 'A Person',
      nonce: 'tenant-nonce',
    });

    // Verified the way a relying party would: fetch the JWKS, import the key, check ES256.
    const jwks = (await (await app.request('https://id.substrat.net/google/jwks.json', {}, env)).json()) as {
      keys: (JsonWebKey & { kid: string })[];
    };
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(rawHeader))) as { kid: string; alg: string };
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    expect(header.alg).toBe('ES256');
    expect(jwk).toBeDefined();
    const key = await crypto.subtle.importKey('jwk', jwk!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlDecode(rawSignature),
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    );
    expect(ok).toBe(true);

    const userinfo = await app.request(
      'https://id.substrat.net/google/userinfo',
      { headers: { authorization: `Bearer ${body.access_token}` } },
      env,
    );
    expect(await userinfo.json()).toMatchObject({ sub: 'google-subject-1', email: 'person@example.com' });
  });

  const redeem = async (
    over: Partial<Record<'code' | 'redirect_uri' | 'client_secret' | 'code_verifier', string>>,
    round: Awaited<ReturnType<typeof signInThroughGoogle>>,
  ) =>
    round.app.request(
      'https://id.substrat.net/google/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: round.returned.searchParams.get('code') ?? '',
          redirect_uri: round.redirectUri,
          client_id: round.client.clientId,
          client_secret: round.client.clientSecret,
          code_verifier: round.verifier,
          ...over,
        }).toString(),
      },
      round.env,
    );

  it('redeems a code exactly once', async () => {
    const round = await signInThroughGoogle();
    expect((await redeem({}, round)).status).toBe(200);
    const replay = await redeem({}, round);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a verifier that does not match the challenge', async () => {
    const round = await signInThroughGoogle();
    const res = await redeem({ code_verifier: 'not-the-verifier-that-was-committed-to' }, round);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a redirect URI that differs from the one the code was issued for', async () => {
    const round = await signInThroughGoogle();
    const res = await redeem({ redirect_uri: 'https://acme.global.substrat.run/elsewhere' }, round);
    expect(res.status).toBe(400);
  });

  it('refuses a wrong client secret before it looks at the code', async () => {
    const round = await signInThroughGoogle();
    const res = await redeem({ client_secret: 'nearly-right' }, round);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
    // and the code survives an authentication failure, so a typo costs nobody their sign-in
    expect((await redeem({}, round)).status).toBe(200);
  });

  it('completes a flow exactly once, so a replayed callback cannot mint a second code', async () => {
    const round = await signInThroughGoogle();
    // The very same callback again — the flow it names was consumed on the first pass.
    const again = await round.app.request(
      `https://id.substrat.net/google/callback?code=upstream-code&state=${round.flowId}`,
      {},
      round.env,
    );
    expect(again.status).toBe(400);
    expect(again.headers.get('location')).toBeNull();
  });

  it('refuses a callback naming a flow nobody started', async () => {
    const round = await signInThroughGoogle();
    const forged = await round.app.request(
      'https://id.substrat.net/google/callback?code=upstream-code&state=never-issued',
      {},
      round.env,
    );
    expect(forged.status).toBe(400);
  });
});

describe('github', () => {
  it('re-emits only the primary VERIFIED address, never the public profile one', async () => {
    const github = upstream((url) => {
      if (url.endsWith('/login/oauth/access_token')) return { json: { access_token: 'gh-token' } };
      if (url.endsWith('/user')) {
        return { json: { id: 4711, login: 'someone', name: 'Some One', email: 'public@example.com' } };
      }
      return {
        json: [
          { email: 'old@example.com', primary: false, verified: true },
          { email: 'unverified@example.com', primary: true, verified: false },
          { email: 'real@example.com', primary: true, verified: true },
        ],
      };
    });
    const app = createApp({ now: () => NOW, fetchImpl: github.fetch });
    const env = envWith();
    const redirectUri = 'https://acme.global.substrat.run/api/auth/callback/platform-github';
    const client = await store.registerClient({ name: 'An install', redirectUris: [redirectUri] }, NOW);
    const { verifier, challenge } = await pkce();
    const started = await app.request(
      `https://id.substrat.net/github/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      env,
    );
    const flowId = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const back = await app.request(`https://id.substrat.net/github/callback?code=c&state=${flowId}`, {}, env);
    const code = new URL(back.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const token = await app.request(
      'https://id.substrat.net/github/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code_verifier: verifier,
        }).toString(),
      },
      env,
    );
    const { id_token } = (await token.json()) as { id_token: string };
    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(id_token.split('.')[1] as string)),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: '4711', email: 'real@example.com', email_verified: true, name: 'Some One' });
  });
});

describe('apple', () => {
  it('signs its own client secret and keeps the name that only arrives once', async () => {
    const apple = upstream(() => ({
      json: { id_token: fakeIdToken({ sub: 'apple-subject', email: 'a@privaterelay.appleid.com', email_verified: 'true' }) },
    }));
    const app = createApp({ now: () => NOW, fetchImpl: apple.fetch });
    const env = envWith({
      APPLE_CLIENT_ID: 'net.substrat.relay',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY: await pkcs8Pem(),
    });
    const redirectUri = 'https://acme.global.substrat.run/api/auth/callback/platform-apple';
    const client = await store.registerClient({ name: 'An install', redirectUris: [redirectUri] }, NOW);
    const { verifier, challenge } = await pkce();

    const started = await app.request(
      `https://id.substrat.net/apple/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      env,
    );
    // Apple will not return a name or an email to a plain redirect response mode.
    expect(new URL(started.headers.get('location') ?? '').searchParams.get('response_mode')).toBe('form_post');
    const flowId = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const back = await app.request(
      'https://id.substrat.net/apple/callback',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: 'apple-code',
          state: flowId,
          user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }),
        }).toString(),
      },
      env,
    );
    const code = new URL(back.headers.get('location') ?? '').searchParams.get('code') ?? '';

    // The client secret Apple was sent is a freshly signed ES256 assertion, not a stored string.
    const assertion = apple.calls[0]?.body.get('client_secret') ?? '';
    const [header, payload] = assertion.split('.') as [string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(header)))).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(payload)))).toMatchObject({
      iss: 'TEAM123456',
      sub: 'net.substrat.relay',
      aud: 'https://appleid.apple.com',
    });

    const token = await app.request(
      'https://id.substrat.net/apple/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code_verifier: verifier,
        }).toString(),
      },
      env,
    );
    const { id_token } = (await token.json()) as { id_token: string };
    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(id_token.split('.')[1] as string)),
    ) as Record<string, unknown>;
    // The string "true" Apple sends becomes a boolean, because a trusted-email decision
    // downstream reads this field and "false" is truthy.
    expect(claims).toMatchObject({ sub: 'apple-subject', email_verified: true, name: 'Ada Lovelace' });
  });
});

describe('the platform surface', () => {
  it('registers a client only for the platform', async () => {
    const app = createApp({ now: () => NOW });
    const body = JSON.stringify({ name: 'An install', redirectUris: ['https://acme.global.substrat.run/cb'] });

    const anonymous = await app.request(
      'https://id.substrat.net/internal/clients',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      envWith(),
    );
    expect(anonymous.status).toBe(403);

    const authorized = await app.request(
      'https://id.substrat.net/internal/clients',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-substrat-platform': 'platform-secret' },
        body,
      },
      envWith(),
    );
    expect(authorized.status).toBe(201);
    const created = (await authorized.json()) as { clientId: string; clientSecret: string };
    expect(created.clientId).toBeTruthy();
    expect(await store.verifyClientSecret(created.clientId, created.clientSecret)).toBe(true);
  });

  it('refuses a redirect URI that is not https, and one carrying a fragment', async () => {
    const app = createApp({ now: () => NOW });
    for (const uri of ['http://acme.example/cb', 'https://acme.example/cb#x']) {
      const res = await app.request(
        'https://id.substrat.net/internal/clients',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-substrat-platform': 'platform-secret' },
          body: JSON.stringify({ name: 'An install', redirectUris: [uri] }),
        },
        envWith(),
      );
      expect(res.status).toBe(400);
    }
  });

  it('answers an unknown /internal path with JSON, never a page', async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request(
      'https://id.substrat.net/internal/nothing',
      { headers: { 'x-substrat-platform': 'platform-secret' } },
      envWith(),
    );
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('rounds that must not interfere', () => {
  it('lets two people sign in at once, seconds apart', async () => {
    // The bug this pins cost the FIRST of two overlapping sign-ins its round: a second
    // `/authorize` swept the first one's flow, and the person came back to "this sign-in
    // round has expired". Nothing about it was visible with a frozen clock.
    let clock = NOW;
    const google = upstream(() => ({ json: { id_token: fakeIdToken({ sub: 'subject', email: 'a@example.com' }) } }));
    const app = createApp({ now: () => clock, fetchImpl: google.fetch });
    const env = envWith();
    const redirectUri = 'https://acme.global.substrat.run/api/auth/callback/platform-google';
    const client = await registerInstall(redirectUri);
    const { challenge } = await pkce();
    const start = async () => {
      const res = await app.request(
        `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
        {},
        env,
      );
      return new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
    };

    const first = await start();
    clock += 1_500;
    const second = await start();
    clock += 1_500;

    for (const flowId of [first, second]) {
      const back = await app.request(`https://id.substrat.net/google/callback?code=c&state=${flowId}`, {}, env);
      expect(new URL(back.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    }
  });

  it('cannot spend one provider\u2019s round at another\u2019s callback', async () => {
    // A leaked flow id replayed at a different provider must MISS, not be consumed and
    // then rejected: consuming it would destroy the round it belongs to, and would make
    // the relay spend the platform's credentials at an upstream nobody chose.
    const google = upstream(() => ({ json: { id_token: fakeIdToken({ sub: 'subject' }) } }));
    const app = createApp({ now: () => NOW, fetchImpl: google.fetch });
    const env = envWith();
    const redirectUri = 'https://acme.global.substrat.run/api/auth/callback/platform-google';
    const client = await registerInstall(redirectUri);
    const { challenge } = await pkce();
    const started = await app.request(
      `https://id.substrat.net/google/authorize?response_type=code&client_id=${client.clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      env,
    );
    const flowId = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const crossed = await app.request(`https://id.substrat.net/github/callback?code=c&state=${flowId}`, {}, env);
    expect(crossed.status).toBe(400);
    // No upstream exchange was attempted with anyone's credentials...
    expect(google.calls).toHaveLength(0);
    // ...and the round it belongs to still completes.
    const back = await app.request(`https://id.substrat.net/google/callback?code=c&state=${flowId}`, {}, env);
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
  });
});

describe('bad input at the token endpoint', () => {
  it('answers a malformed Basic credential with 401, not 500', async () => {
    const app = createApp({ now: () => NOW });
    const res = await app.request(
      'https://id.substrat.net/google/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ###not-base64###' },
        body: 'grant_type=authorization_code&code=x',
      },
      envWith(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('the rate limit setting', () => {
  it('treats anything that is not a positive number as the default, never as no limit', () => {
    expect(rateLimitOf('5')).toBe(5);
    // A typo used to read as NaN, which removed the limit the setting exists to impose.
    expect(rateLimitOf('twelve')).toBe(120);
    expect(rateLimitOf('')).toBe(120);
    expect(rateLimitOf(undefined)).toBe(120);
    expect(rateLimitOf('-1')).toBe(120);
  });
});
