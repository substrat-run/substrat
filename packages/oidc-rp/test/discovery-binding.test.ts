import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beginLogin, completeLogin, type OidcEnv } from '../src/index.js';

/**
 * What a discovery document is trusted with. It names the token endpoint the client secret
 * goes to and the keys an ID token is verified against, so:
 *   - it must state the issuer it was fetched for (OIDC Discovery §4.3), else the ID token's
 *     `iss` check compares the document with itself;
 *   - the token endpoint is https (loopback http for a dev issuer) but NOT held to the
 *     issuer's origin, because real providers serve it from another host;
 *   - the credentialed requests (token POST, userinfo) never follow a redirect;
 *   - the discovery GET itself does not follow a redirect off its own origin.
 *
 * Every case gets its own issuer, since discovery is cached per issuer for the isolate.
 */

const APP = 'https://app.test';
let n = 0;
let issuer: string;
let env: OidcEnv;
let goodKey: CryptoKey;
let goodJwks: { keys: object[] };
let evilKey: CryptoKey;
let evilJwks: { keys: object[] };

/** What the stub does this round; every field has a well-behaved default in `beforeEach`. */
let doc: Record<string, unknown>;
let discoveryRedirect: string | null;
let tokenBehaviour: 'ok' | 'redirect';
let sparse: boolean;
let signAs: { key: 'good' | 'evil'; iss: string };
let nonce = '';
let requests: { url: string; redirect?: string; method?: string }[];

beforeAll(async () => {
  const good = await generateKeyPair('RS256');
  goodKey = good.privateKey as CryptoKey;
  goodJwks = { keys: [{ ...(await exportJWK(good.publicKey)), alg: 'RS256', kid: 'k1' }] };
  const evil = await generateKeyPair('RS256');
  evilKey = evil.privateKey as CryptoKey;
  evilJwks = { keys: [{ ...(await exportJWK(evil.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  issuer = `https://issuer-${++n}.test`;
  env = {
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'client-1',
    OIDC_CLIENT_SECRET: 'client-secret-1',
    SESSION_SECRET: 'session-secret-000000000000000000000001',
  };
  doc = {};
  discoveryRedirect = null;
  tokenBehaviour = 'ok';
  sparse = false;
  signAs = { key: 'good', iss: issuer };
  requests = [];

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, redirect: init?.redirect, method: init?.method });
    if (url === `${issuer}/.well-known/openid-configuration`) {
      if (discoveryRedirect) return new Response(null, { status: 302, headers: { location: discoveryRedirect } });
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        ...doc,
      });
    }
    if (url.endsWith('/userinfo')) return Response.json({ sub: 'u-1', email: 'a@example.test' });
    if (url.endsWith('/.well-known/openid-configuration')) {
      // A discovery document served from somewhere else (a redirect target).
      return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.endsWith('/jwks')) return Response.json(url.startsWith('https://evil.test') ? evilJwks : goodJwks);
    if (url.endsWith('/token')) {
      if (tokenBehaviour === 'redirect') {
        return new Response(null, { status: 307, headers: { location: 'https://evil.test/collect' } });
      }
      const idToken = await new SignJWT(sparse ? { sub: 'u-1', nonce } : { sub: 'u-1', email: 'a@example.test', name: 'A', nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(signAs.iss)
        .setAudience('client-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signAs.key === 'good' ? goodKey : evilKey);
      return Response.json({ id_token: idToken, access_token: 'at-1', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => vi.unstubAllGlobals());

async function login() {
  const { location, flow } = await beginLogin(env, APP);
  const authorize = new URL(location);
  nonce = authorize.searchParams.get('nonce')!;
  const callback = new URL(`${APP}/api/auth/callback?code=c-1&state=${authorize.searchParams.get('state')}`);
  return completeLogin(env, APP, callback, flow);
}

const tokenPosts = () => requests.filter((r) => r.method === 'POST');

describe('discovery is bound to the configured issuer', () => {
  it('refuses a document that names a different issuer, before anything is sent to it', async () => {
    doc = { issuer: 'https://other.test' };
    await expect(login()).rejects.toThrow(/different issuer/);
    expect(tokenPosts()).toEqual([]);
  });

  it('does not accept an ID token minted against keys a foreign document names', async () => {
    doc = { issuer: 'https://evil.test', jwks_uri: 'https://evil.test/jwks' };
    signAs = { key: 'evil', iss: 'https://evil.test' };
    await expect(login()).rejects.toThrow();
  });

  it('accepts the document when only a trailing slash differs, either way round', async () => {
    doc = { issuer: `${issuer}/` };
    signAs = { key: 'good', iss: `${issuer}/` };
    expect((await login()).user.id).toBe('u-1');
    const slashed = `https://issuer-slash-${n}.test/`;
    env = { ...env, OIDC_ISSUER: slashed };
    issuer = slashed.replace(/\/$/, '');
    doc = {};
    signAs = { key: 'good', iss: issuer };
    expect((await login()).user.id).toBe('u-1');
  });

  it('does not cache the refusal: an issuer that is corrected is usable', async () => {
    doc = { issuer: 'https://other.test' };
    await expect(login()).rejects.toThrow(/different issuer/);
    doc = {};
    expect((await login()).user.id).toBe('u-1');
  });
});

describe('the token endpoint', () => {
  it('must be https: a plaintext endpoint is refused and receives nothing', async () => {
    doc = { token_endpoint: 'http://token.example.test/token' };
    await expect(login()).rejects.toThrow(/not https/);
    expect(requests.some((r) => r.url.startsWith('http://token.example.test'))).toBe(false);
  });

  it('may live on another origin than the issuer (positive twin)', async () => {
    doc = { token_endpoint: 'https://token.example.test/token' };
    expect((await login()).user.id).toBe('u-1');
    expect(requests.some((r) => r.url === 'https://token.example.test/token' && r.method === 'POST')).toBe(true);
  });

  it('allows plaintext on a loopback issuer, the dev case', async () => {
    issuer = `http://localhost:${8000 + n}`;
    env = { ...env, OIDC_ISSUER: issuer };
    signAs = { key: 'good', iss: issuer };
    expect((await login()).user.id).toBe('u-1');
  });

  it('is asked not to follow a redirect, and a 30x fails the login without a second request', async () => {
    tokenBehaviour = 'redirect';
    await expect(login()).rejects.toThrow(/token exchange failed \(307\)/);
    expect(tokenPosts().every((r) => r.redirect === 'manual')).toBe(true);
    expect(requests.some((r) => r.url.startsWith('https://evil.test'))).toBe(false);
  });
});

describe('userinfo', () => {
  it('carries the bearer without following a redirect', async () => {
    sparse = true;
    doc = { userinfo_endpoint: `${issuer}/userinfo` };
    expect((await login()).user.email).toBe('a@example.test');
    expect(requests.find((r) => r.url.endsWith('/userinfo'))?.redirect).toBe('manual');
  });
});

describe('the discovery fetch', () => {
  it('does not follow a redirect off the issuer origin', async () => {
    discoveryRedirect = 'https://evil.test/.well-known/openid-configuration';
    await expect(beginLogin(env, APP)).rejects.toThrow(/redirected away/);
    expect(requests.some((r) => r.url.startsWith('https://evil.test'))).toBe(false);
  });

  it('follows one that stays on the issuer origin (positive twin)', async () => {
    discoveryRedirect = `${issuer}/moved/.well-known/openid-configuration`;
    expect((await beginLogin(env, APP)).location).toContain('/authorize');
  });
});
