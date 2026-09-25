import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { DISCOVERY_FAILURE_TTL_MS } from '@substrat-run/oidc-rp/discovery';
import { oidcAuthProvider } from '../src/oidc.js';

/**
 * The bearer path's key lookup shares the login path's discovery, so what makes that one
 * safe holds here too: the document must state the issuer it was fetched for, a redirect
 * off the issuer's origin is a failure, the issuer is https, and a failure is retried
 * rather than remembered. The `jwks_uri` it yields is what `oidc.ts` then trusts for every
 * bearer, so a document it should have refused must never get a key fetched from it.
 */

let n = 0;
let issuer: string;
let goodKey: CryptoKey;
let evilKey: CryptoKey;
let goodJwks: { keys: object[] };
let evilJwks: { keys: object[] };
let doc: Record<string, unknown>;
let discovery: 'doc' | 'redirect-off-origin' | 'down';
let requests: string[];

beforeAll(async () => {
  const good = await generateKeyPair('RS256');
  goodKey = good.privateKey as CryptoKey;
  goodJwks = { keys: [{ ...(await exportJWK(good.publicKey)), alg: 'RS256', kid: 'k1' }] };
  const evil = await generateKeyPair('RS256');
  evilKey = evil.privateKey as CryptoKey;
  evilJwks = { keys: [{ ...(await exportJWK(evil.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  issuer = `https://bearer-issuer-${++n}.test`;
  doc = {};
  discovery = 'doc';
  requests = [];
  // Behaves as the runtime does: a redirect is followed unless the caller says `manual`, so a
  // caller that forgets to ask is exactly what lands on the attacker's document.
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      if (discovery === 'down') return new Response('down', { status: 503 });
      if (discovery === 'redirect-off-origin') {
        const location = 'https://evil.test/.well-known/openid-configuration';
        if (init?.redirect !== 'manual') return stub(location, init);
        return new Response(null, { status: 302, headers: { location } });
      }
      return Response.json({ issuer, jwks_uri: `${issuer}/jwks`, ...doc });
    }
    if (url === 'https://evil.test/.well-known/openid-configuration') {
      return Response.json({ issuer, jwks_uri: 'https://evil.test/jwks' });
    }
    if (url === `${issuer}/jwks`) return Response.json(goodJwks);
    if (url === 'https://evil.test/jwks') return Response.json(evilJwks);
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  vi.stubGlobal('fetch', stub as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const token = (key: CryptoKey, iss = issuer) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

const resolve = async (provider: ReturnType<typeof oidcAuthProvider>, t: string) =>
  (await provider.resolve(new Headers({ authorization: `Bearer ${t}` })))?.sub ?? null;

describe('a bearer verifier looks its keys up through the bound discovery', () => {
  it('admits a token the issuer signed (positive twin)', async () => {
    expect(await resolve(oidcAuthProvider({ issuer }), await token(goodKey))).toBe('user-1');
  });

  it('refuses a document that names another issuer, and never fetches the keys it points at', async () => {
    doc = { issuer: 'https://evil.test', jwks_uri: 'https://evil.test/jwks' };
    // A token minted against the attacker's keys, carrying the configured `iss`.
    expect(await resolve(oidcAuthProvider({ issuer }), await token(evilKey))).toBeNull();
    expect(requests).not.toContain('https://evil.test/jwks');
  });

  it('does not follow a discovery redirect off the issuer origin', async () => {
    discovery = 'redirect-off-origin';
    expect(await resolve(oidcAuthProvider({ issuer }), await token(evilKey))).toBeNull();
    expect(requests.some((r) => r.startsWith('https://evil.test'))).toBe(false);
  });

  it('refuses a plaintext issuer without asking it anything', async () => {
    const plain = 'http://plain-issuer.example.test';
    expect(await resolve(oidcAuthProvider({ issuer: plain }), await token(goodKey, plain))).toBeNull();
    expect(requests).toEqual([]);
  });

  it('retries after a failure instead of refusing for the isolate’s life', async () => {
    const provider = oidcAuthProvider({ issuer });
    discovery = 'down';
    expect(await resolve(provider, await token(goodKey))).toBeNull();
    discovery = 'doc';
    vi.setSystemTime(Date.now() + DISCOVERY_FAILURE_TTL_MS + 1);
    expect(await resolve(provider, await token(goodKey))).toBe('user-1');
  });

  it('asks a failing issuer once per window however many bearers arrive', async () => {
    discovery = 'down';
    const provider = oidcAuthProvider({ issuer });
    const t = await token(goodKey);
    for (let i = 0; i < 6; i++) expect(await resolve(provider, t)).toBeNull();
    expect(requests.filter((r) => r.includes('openid-configuration'))).toHaveLength(1);
  });
});
