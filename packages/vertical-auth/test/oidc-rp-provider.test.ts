import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mintSession, SESSION_COOKIE, FLOW_COOKIE } from '@substrat-run/oidc-rp';
import { oidcRpAuthProvider, type OidcRpConfig } from '../src/oidc-rp-provider.js';

/**
 * The RP `AuthProvider` end-to-end against a STUBBED issuer: discovery, the authorize
 * redirect (PKCE + state + nonce in a signed flow cookie), the callback's code→token
 * exchange with a real RS256-signed ID token verified against the stub's JWKS, and
 * session resolution. This is the security-critical path of vertical-auth-detach.md
 * §2.3 — the same flow every hosted vertical will run, exercised without a worker.
 */

const ISSUER = 'https://issuer.test';
const APP = 'https://meridian-acme.global.substrat.test';

const cfg: OidcRpConfig = {
  issuer: ISSUER,
  clientId: 'meridian-acme',
  clientSecret: 'client-secret-1',
  sessionSecret: 'session-secret-000000000000000000000001',
};

let privateKey: CryptoKey;
let jwks: { keys: object[] };
/** The next ID-token claims the stub token endpoint will sign and return. */
let nextClaims: Record<string, unknown> = {};
/** Every form body the token endpoint received, for asserting PKCE/code wiring. */
let tokenRequests: URLSearchParams[] = [];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };

  // The issuer, as a fetch stub: discovery + JWKS + token endpoint. `oidc-rp` reaches
  // everything through global fetch, so this is the entire fake.
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
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      const idToken = await new SignJWT(nextClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(cfg.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({ id_token: idToken, access_token: 'at', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => {
  tokenRequests = [];
});

// Cast: the pinned workers-types Headers predates getSetCookie; node (where this runs) has it.
const setCookies = (res: Response): string[] =>
  (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
const cookieValue = (cookies: string[], name: string): string | undefined => {
  const hit = cookies.find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.split(';')[0]!.slice(name.length + 1)) : undefined;
};

describe('oidcRpAuthProvider', () => {
  it('login redirects to the issuer with PKCE, state, nonce and the callback redirect_uri', async () => {
    const res = await oidcRpAuthProvider(cfg).handle(new Request(`${APP}/api/auth/login?returnTo=/admin`));
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.origin).toBe(ISSUER);
    expect(u.pathname).toBe('/authorize');
    expect(u.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(`${APP}/api/auth/callback`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(cookieValue(setCookies(res), FLOW_COOKIE)).toBeTruthy();
  });

  it('callback exchanges the code, verifies the ID token, and sets the session cookie', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const login = await provider.handle(new Request(`${APP}/api/auth/login?returnTo=/admin`));
    const authorize = new URL(login.headers.get('location')!);
    const flow = cookieValue(setCookies(login), FLOW_COOKIE)!;

    nextClaims = {
      sub: 'user-77',
      email: 'pat@acme.test',
      name: 'Pat',
      nonce: authorize.searchParams.get('nonce'),
    };
    const cb = await provider.handle(
      new Request(`${APP}/api/auth/callback?code=c0de&state=${authorize.searchParams.get('state')}`, {
        headers: { cookie: `${FLOW_COOKIE}=${encodeURIComponent(flow)}` },
      }),
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/admin');
    const session = cookieValue(setCookies(cb), SESSION_COOKIE);
    expect(session).toBeTruthy();
    // The exchange carried the PKCE verifier matching login's challenge, and the secret.
    const tokenReq = tokenRequests[0]!;
    expect(tokenReq.get('code')).toBe('c0de');
    expect(tokenReq.get('code_verifier')).toBeTruthy();
    expect(tokenReq.get('client_secret')).toBe(cfg.clientSecret);

    // …and the minted session RESOLVES to the issuer's subject.
    const subject = await provider.resolve(new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(session!)}` }));
    expect(subject).toEqual({ sub: 'user-77', email: 'pat@acme.test', name: 'Pat' });
  });

  it('callback with a WRONG state fails opaquely — no session, redirect to the error page', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const login = await provider.handle(new Request(`${APP}/api/auth/login`));
    const flow = cookieValue(setCookies(login), FLOW_COOKIE)!;
    const cb = await provider.handle(
      new Request(`${APP}/api/auth/callback?code=c0de&state=forged`, {
        headers: { cookie: `${FLOW_COOKIE}=${encodeURIComponent(flow)}` },
      }),
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/?error=auth');
    expect(cookieValue(setCookies(cb), SESSION_COOKIE)).toBeUndefined();
  });

  it('resolve rejects a session signed with a DIFFERENT instance secret (no cross-instance reuse)', async () => {
    const otherEnv = {
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: cfg.clientId,
      OIDC_CLIENT_SECRET: cfg.clientSecret,
      SESSION_SECRET: 'a-different-tenant-secret-000000000000',
    };
    const forged = await mintSession(otherEnv, { id: 'user-77', email: 'pat@acme.test' });
    const subject = await oidcRpAuthProvider(cfg).resolve(
      new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}` }),
    );
    expect(subject).toBeNull();
  });

  it('logout clears the session cookie and honors a same-origin returnTo only', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const out = await provider.handle(new Request(`${APP}/api/auth/logout?returnTo=/bye`));
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/bye');
    expect(setCookies(out).find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toContain('Max-Age=0');
    const evil = await provider.handle(new Request(`${APP}/api/auth/logout?returnTo=https://evil.test/x`));
    expect(evil.headers.get('location')).toBe('/');
  });

  it('answers other /api/auth/* paths with JSON 404 pointing at the issuer', async () => {
    const res = await oidcRpAuthProvider(cfg).handle(
      new Request(`${APP}/api/auth/sign-up/email`, { method: 'POST' }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { issuer: string }).issuer).toBe(ISSUER);
  });
});
