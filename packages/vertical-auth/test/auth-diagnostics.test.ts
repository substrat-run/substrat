import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { AUTH_DIAGNOSTICS_KEY, type AuthCheck } from '@substrat-run/contracts/auth-diagnostics';
import { oidcAuthProvider, type OidcConfig } from '../src/oidc.js';
import { mintSession, SESSION_COOKIE } from '@substrat-run/oidc-rp';
import { oidcRpAuthProvider } from '../src/oidc-rp-provider.js';
import { verificationReason } from '../src/auth-diagnostics.js';

const ISSUER = 'https://issuer.example';
const slots = globalThis as Record<symbol, unknown>;
const original = slots[AUTH_DIAGNOSTICS_KEY];
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let checks: AuthCheck[];
beforeAll(async () => { pair = await generateKeyPair('RS256'); });
beforeEach(() => {
  checks = [];
  slots[AUTH_DIAGNOSTICS_KEY] = { record: (check: AuthCheck) => checks.push(check) };
});
afterEach(() => { slots[AUTH_DIAGNOSTICS_KEY] = original; });

async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ iss: ISSUER, sub: 'private-subject', email: 'private@example.test', exp: Math.floor(Date.now() / 1000) + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256' }).sign(pair.privateKey);
}
const headers = (value: string) => new Headers({ authorization: `Bearer ${value}` });
const provider = (config: Partial<OidcConfig> = {}) => oidcAuthProvider({ issuer: ISSUER, keys: async () => pair.publicKey, ...config });

describe('bearer diagnostics with real signed tokens', () => {
  it.each([
    [{ iss: 'https://other.example' }, {}, 'issuer-invalid'],
    [{ aud: 'other-client' }, { audience: 'this-client' }, 'audience-invalid'],
    [{ exp: 1 }, {}, 'token-expired'],
    [{ nbf: 9999999999 }, {}, 'token-not-active'],
    [{ sub: undefined }, {}, 'subject-missing'],
    [{ aud: 'another-app' }, { clientId: 'this-app' }, 'token-not-for-app'],
    [{ substrat_delegation: {} }, {}, 'assertion-not-access-token'],
    [{ act: {} }, {}, 'delegation-refused'],
  ] as const)('refuses %j and records only its category', async (claims, config, reason) => {
    expect(await provider(config).resolve(headers(await token(claims)))).toBeNull();
    expect(checks).toEqual([{ stage: 'bearer', outcome: 'refused', reason }]);
  });

  it('distinguishes a verified identity from absent credentials', async () => {
    const auth = provider();
    expect(await auth.resolve(headers(await token()))).toMatchObject({ sub: 'private-subject' });
    expect(await auth.resolve(new Headers())).toBeNull();
    expect(checks).toEqual([
      { stage: 'bearer', outcome: 'accepted', reason: 'verified' },
      { stage: 'bearer', outcome: 'absent', reason: 'credential-missing' },
    ]);
  });

  it('distinguishes invalid signatures, malformed tokens, and unavailable keys', async () => {
    const other = await generateKeyPair('RS256');
    expect(await provider({ keys: async () => other.publicKey }).resolve(headers(await token()))).toBeNull();
    expect(await provider().resolve(headers('not-a-jwt'))).toBeNull();
    expect(await provider({ keys: async () => { throw new Error('secret in resolver error'); } }).resolve(headers(await token()))).toBeNull();
    expect(checks.map((c) => c.reason)).toEqual(['signature-invalid', 'token-invalid', 'key-resolution-failed']);
  });

  it('reports discovery failure without disclosing the configuration or exception', async () => {
    // A refused issuer is rejected before network access.
    const auth = oidcAuthProvider({ issuer: 'http://untrusted.example' });
    expect(await auth.resolve(headers(await token()))).toBeNull();
    expect(checks).toEqual([{ stage: 'bearer', outcome: 'error', reason: 'discovery-failed' }]);
  });

  it('preserves both acceptance and refusal when the diagnostic sink throws', async () => {
    slots[AUTH_DIAGNOSTICS_KEY] = { record: () => { throw new Error('observer fault'); } };
    expect(await provider().resolve(headers(await token()))).toMatchObject({ sub: 'private-subject' });
    expect(await provider().resolve(headers(await token({ exp: 1 })))).toBeNull();
  });

  it('records a valid session and distinguishes an invalid cookie before bearer fallback', async () => {
    const cfg = { issuer: ISSUER, clientId: 'app', clientSecret: 'test-client', sessionSecret: 'test-session-secret-at-least-32-bytes' };
    const auth = oidcRpAuthProvider(cfg);
    const session = await mintSession({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: cfg.clientId, OIDC_CLIENT_SECRET: cfg.clientSecret, SESSION_SECRET: cfg.sessionSecret }, { id: 'private-person' });
    expect(await auth.resolve(new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` }))).toMatchObject({ sub: 'private-person' });
    expect(await auth.resolve(new Headers({ cookie: `${SESSION_COOKIE}=invalid-cookie` }))).toBeNull();
    expect(checks).toEqual([
      { stage: 'session', outcome: 'accepted', reason: 'verified' },
      { stage: 'session', outcome: 'refused', reason: 'session-invalid' },
      { stage: 'bearer', outcome: 'absent', reason: 'credential-missing' },
    ]);
  });

  it('recognises errors from another bundle by code without logging arbitrary messages', () => {
    expect(verificationReason({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'aud', message: 'private' })).toBe('audience-invalid');
    expect(verificationReason(new Error('issuer mismatch'))).toBeUndefined();
  });
});
