/**
 * The test that matters: drive the PLATFORM'S OWN relying party against this issuer.
 *
 * A dev issuer is only worth having if the app in front of it runs its production login
 * path, so asserting the endpoints in isolation would miss the point — `@substrat-run/oidc-rp`
 * is the code that must be satisfied, PKCE, state, nonce, JWKS verification and all. If this
 * suite passes, a vertical needs no dev branch to log in locally.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { beginLogin, completeLogin, identifyEmail, type OidcEnv } from '@substrat-run/oidc-rp';
import { createDevIssuer, DEV_CLIENT_ID } from '../src/issuer.js';
import { devLogin } from '../src/harness.js';
import { TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE, mcpResourceOf } from '@substrat-run/contracts';
import { decodeJwt } from 'jose';
import type { DevPersona } from '../src/personas.js';

// Loopback, as the real dev issuer is: the RP sends the client secret over plain http only there.
const ISSUER = 'http://localhost:8879';
const APP = 'http://app.test';

const PERSONAS: DevPersona[] = [
  { sub: 'dev|anna', name: 'Anna Lindqvist', email: 'anna@example.test', note: 'office-admin' },
  { sub: 'dev|harald', name: 'Harald Berg', email: 'harald@example.test', note: 'technician' },
];

/** A master app and its plugin (#3161): the plugin lets the master call it as the person. */
const MASTER = 'master-client';
const PLUGIN = 'plugin-client';
/** A host that delegates to the master on the `mcp` channel only. */
const MCP_ONLY = 'mcp-only-client';

const app = createDevIssuer({
  personas: PERSONAS,
  allowedRedirectPrefixes: [APP],
  delegations: [
    { host: PLUGIN, actor: MASTER, permissions: ['notes.read', 'notes.write'], channels: ['peer'] },
    { host: MCP_ONLY, actor: MASTER, permissions: ['notes.read'] },
    // An app delegating to itself, which the exchange refuses all the same.
    { host: MASTER, actor: MASTER, permissions: ['notes.read'], channels: ['peer'] },
  ],
});

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
    // The dev issuer asserts every persona's address verified, so a local login passes the
    // platform's default `email_verified` rule (#1359) exactly as a real one does.
    expect(done.user.emailVerified).toBe(true);
    expect(identifyEmail({}, done.user)).toEqual({ email: 'harald@example.test' });
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

  // RFC 6750 §3.1: no bearer presented → the bare challenge; a bearer that fails → invalid_token.
  it.each([
    ['no Authorization header', undefined, 'Bearer'],
    ['a non-Bearer scheme', 'Basic YTpi', 'Bearer'],
    ['a token that does not verify', 'Bearer nope', 'Bearer error="invalid_token"'],
    ['a valid token for a user it does not serve', 'ghost', 'Bearer error="invalid_token"'],
  ])('refuses /userinfo with %s as a problem document and the matching challenge', async (_name, auth, challenge) => {
    let authorization = auth;
    if (auth === 'ghost') {
      // Same key and origin, so the signature and issuer check out; only the persona is gone.
      const other = createDevIssuer({ personas: [{ sub: 'dev|ghost', name: 'Ghost', email: 'g@example.test', note: '' }] });
      const minted = await other.fetch(
        new Request(`${ISSUER}/dev/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sub: 'dev|ghost' }),
        }),
      );
      authorization = `Bearer ${((await minted.json()) as { access_token: string }).access_token}`;
    }
    const res = await app.fetch(new Request(`${ISSUER}/userinfo`, { headers: authorization ? { authorization } : {} }));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('www-authenticate')).toBe(challenge);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
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
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'validation_failed', detail: expect.stringContaining('dev|nobody') });
  });
});

/**
 * `devLogin` holds a bearer to the rule a hosted vertical on a team auth-server is held to
 * (#1683): it must be this app's own token. So the documented script flow —
 * `curl /dev/token {sub}`, then present the access token — only keeps working because the
 * door's DEFAULT audience is the client the harness signs in as.
 */
describe('the door and the harness agree on whose token it is (#1683)', () => {
  const login = devLogin({
    issuer: ISSUER,
    directory: { listIdentityTenants: async () => [], resolveIdentity: async () => undefined },
    actor: 'actor' as never,
    provider: 'oidc:dev-issuer',
  });
  const mint = async (body: Record<string, unknown>) =>
    ((await (
      await app.fetch(
        new Request(`${ISSUER}/dev/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sub: 'dev|anna', ...body }),
        }),
      )
    ).json()) as { access_token: string }).access_token;
  const as = (token: string, host?: string) =>
    login.subject(new Headers({ authorization: `Bearer ${token}`, ...(host ? { host } : {}) }));

  it('mints for the harness client by default, and the harness admits it', async () => {
    const token = await mint({});
    expect(decodeJwt(token).aud).toBe(DEV_CLIENT_ID);
    expect((await as(token))?.sub).toBe('dev|anna');
  });

  it("refuses a token minted for some other audience — the old default 'dev' included", async () => {
    expect(await as(await mint({ audience: 'dev' }))).toBeNull();
    expect(await as(await mint({ audience: 'someone-elses-client' }))).toBeNull();
  });

  it("admits an MCP token for this origin's own endpoint, and not another's", async () => {
    const token = await mint({ audience: mcpResourceOf('http://localhost:8871') });
    expect((await as(token, 'localhost:8871'))?.sub).toBe('dev|anna');
    expect(await as(token, 'localhost:8872')).toBeNull();
  });
});

/** A form POST to `/token`. */
const token = (form: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, one);
  return app.fetch(new Request(`${ISSUER}/token`, { method: 'POST', body }));
};

/** What `/dev/token` mints for a persona: an id_token whose `aud` is `audience`, no `azp`. */
const idTokenFor = async (audience: string, sub = 'dev|anna') =>
  ((await (
    await app.fetch(
      new Request(`${ISSUER}/dev/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub, audience }),
      }),
    )
  ).json()) as { id_token: string }).id_token;

describe('offline_access: a refresh token, and a fresh id_token for it (#3161)', () => {
  const codeFor = async (scope: string) => {
    const q = new URLSearchParams({ response_type: 'code', client_id: MASTER, redirect_uri: `${APP}/cb`, scope, sub: 'dev|anna' });
    const res = await authorize(`${ISSUER}/authorize?${q.toString()}`);
    return new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
  };
  const redeem = async (scope: string) =>
    (await (
      await token({ grant_type: 'authorization_code', code: await codeFor(scope), client_id: MASTER, redirect_uri: `${APP}/cb` })
    ).json()) as { refresh_token?: string; scope: string };

  it('issues one only when offline_access was asked for, and refreshes it to the claims a login gives', async () => {
    expect(await redeem('openid email profile')).not.toHaveProperty('refresh_token');
    const issued = await redeem('openid email profile offline_access');
    expect(issued.refresh_token).toBeTruthy();
    expect(issued.scope).toBe('openid email profile offline_access');

    const res = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token ?? '', client_id: MASTER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id_token: string; refresh_token: string };
    const claims = decodeJwt(body.id_token);
    expect(claims).toEqual({
      iss: ISSUER,
      aud: MASTER,
      sub: 'dev|anna',
      name: 'Anna Lindqvist',
      email: 'anna@example.test',
      email_verified: true,
      iat: expect.any(Number),
      exp: (claims.iat ?? 0) + 3600,
    });
    expect(decodeJwt(body.refresh_token)).toMatchObject({ typ: 'refresh', sub: 'dev|anna', cid: MASTER });
  });

  it('refuses a refresh by another client, and a refresh token presented as anything else', async () => {
    const refresh = (await redeem('openid offline_access')).refresh_token ?? '';
    const res = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: PLUGIN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    // And a code is not a refresh token, which would redeem it without its PKCE verifier.
    const code = await codeFor('openid offline_access');
    expect(((await (await token({ grant_type: 'refresh_token', refresh_token: code, client_id: MASTER })).json()) as { error: string }).error).toBe('invalid_grant');
    // Not a code, not a bearer at /userinfo, not the person's token at the client's own door.
    const asCode = await token({ grant_type: 'authorization_code', code: refresh, client_id: MASTER, redirect_uri: `${APP}/cb` });
    expect(((await asCode.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await app.fetch(new Request(`${ISSUER}/userinfo`, { headers: { authorization: `Bearer ${refresh}` } }))).status).toBe(401);
    const door = devLogin({
      issuer: ISSUER,
      clientId: MASTER,
      directory: { listIdentityTenants: async () => [], resolveIdentity: async () => undefined },
      actor: 'actor' as never,
      provider: 'oidc:dev-issuer',
    });
    expect(await door.subject(new Headers({ authorization: `Bearer ${refresh}` }))).toBeNull();
  });
});

describe('the peer token exchange: the master calls its plugin as the person (#3161)', () => {
  const exchange = async (subject: string, extra: Record<string, string | string[]> = {}) => {
    const res = await token({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      client_id: MASTER,
      subject_token: subject,
      subject_token_type: TOKEN_TYPE.idToken,
      requested_token_type: TOKEN_TYPE.accessToken,
      audience: PLUGIN,
      ...extra,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('mints a token for the plugin, as the person, with the granted keys, and the plugin’s ordinary door refuses it', async () => {
    const res = await exchange(await idTokenFor(MASTER));
    expect(res).toEqual({
      status: 200,
      body: {
        access_token: expect.any(String),
        issued_token_type: TOKEN_TYPE.accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'notes.read notes.write',
      },
    });
    const claims = decodeJwt(res.body['access_token'] as string);
    expect(claims).toEqual({
      iss: ISSUER,
      sub: 'dev|anna',
      aud: PLUGIN,
      azp: MASTER,
      client_id: MASTER,
      scope: 'notes.read notes.write',
      act: { iss: ISSUER, sub: MASTER },
      substrat_delegation: { stage: 'peer', host: PLUGIN, actor: MASTER },
      email: 'anna@example.test',
      email_verified: true,
      jti: expect.any(String),
      iat: expect.any(Number),
      exp: (claims.iat ?? 0) + 300,
    });
    // It carries `act`, so the plugin's ordinary door does not take it as the person's own.
    const door = devLogin({
      issuer: ISSUER,
      clientId: PLUGIN,
      directory: { listIdentityTenants: async () => [], resolveIdentity: async () => undefined },
      actor: 'actor' as never,
      provider: 'oidc:dev-issuer',
    });
    expect(await door.subject(new Headers({ authorization: `Bearer ${res.body['access_token'] as string}` }))).toBeNull();
    // The twin: narrowed to what was asked.
    expect((await exchange(await idTokenFor(MASTER), { scope: 'notes.read notes.delete' })).body['scope']).toBe('notes.read');
  });

  it.each([
    ['a host that does not delegate to it', { audience: 'nobody-client' }, 'invalid_target'],
    ['a host whose grant names only mcp', { audience: MCP_ONLY }, 'invalid_target'],
    ['itself as the host', { audience: MASTER }, 'invalid_target'],
    ['no requested access token', { requested_token_type: TOKEN_TYPE.jwt }, 'invalid_request'],
    ['no client_id', { client_id: '' }, 'invalid_request'],
    ['a scope outside the grant', { scope: 'notes.delete' }, 'invalid_scope'],
  ])('refuses %s', async (_why, extra, error) => {
    const res = await exchange(await idTokenFor(MASTER), extra);
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe(error);
  });

  it('refuses a subject token issued to another client — the plugin’s own login of the person included', async () => {
    expect((await exchange(await idTokenFor(PLUGIN))).body['error']).toBe('invalid_grant');
  });

  it('refuses a subject that is already delegated: no chaining', async () => {
    const peer = (await exchange(await idTokenFor(MASTER))).body['access_token'] as string;
    expect((await exchange(peer, { subject_token_type: TOKEN_TYPE.accessToken })).body['error']).toBe('invalid_grant');
  });
});
