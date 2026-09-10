import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { LOGOUT_HINT_COOKIE, SESSION_COOKIE, FLOW_COOKIE } from '@substrat-run/oidc-rp';
import { oidcRpAuthProvider, type OidcRpConfig } from '../src/oidc-rp-provider.js';

/**
 * RP-initiated logout through the hosted-vertical provider — the same question
 * `packages/oidc-rp`'s own logout suite asks of the mounted routes, asked here because a
 * vertical never mounts those: it composes THIS provider, and until now that half kept no
 * ID token and could therefore only ever ask the issuer to log someone out anonymously.
 *
 * What that costs is a screen. Without `id_token_hint` an OP cannot tell a real sign-out
 * from a link someone was tricked into following, so OIDC RP-Initiated Logout §2 says it
 * SHOULD ask the person to confirm — and Better Auth's provider does exactly that, with a
 * "Confirm logout" page in the middle of what the person already asked for. The hint is
 * what turns that into a straight redirect, so the cookie carrying it has to survive from
 * the login callback to the logout request.
 */

const APP = 'https://crm-acme.global.substrat.test';

let issuers = 0;
let ISSUER: string;
let cfg: OidcRpConfig;
/** What this test's issuer advertises — `null` for one offering no RP-initiated logout. */
let endSessionEndpoint: string | null;

let privateKey: CryptoKey;
let jwks: { keys: object[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
});

beforeEach(() => {
  // Per-case issuer: discovery is cached per issuer for the life of the isolate, so a
  // shared one would hand the second case the first case's metadata.
  ISSUER = `https://issuer-logout-${++issuers}.test`;
  cfg = {
    issuer: ISSUER,
    clientId: 'crm-acme',
    clientSecret: 'client-secret-1',
    sessionSecret: 'session-secret-000000000000000000000001',
  };
  endSessionEndpoint = `${ISSUER}/api/auth/oauth2/end-session`;

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        ...(endSessionEndpoint ? { end_session_endpoint: endSessionEndpoint } : {}),
      });
    }
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    if (url === `${ISSUER}/token`) {
      const nonce = new URLSearchParams(String(init?.body)).get('__nonce');
      const idToken = await new SignJWT({ nonce, sub: 'u-1', email: 'a@example.test', sid: 's-1' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(cfg.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({ id_token: idToken, access_token: 'at-1', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

afterEach(() => vi.unstubAllGlobals());

// Cast: the pinned workers-types Headers predates getSetCookie; node (where this runs) has it.
const setCookies = (res: Response): string[] =>
  (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];

/** Every Set-Cookie the response carries, as name → value (last write wins, as in a browser). */
function cookiesOf(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of setCookies(res)) {
    const pair = header.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
  }
  return jar;
}

/** The Set-Cookie headers for one cookie name, whole — attributes included. */
const named = (res: Response, name: string): string[] => setCookies(res).filter((c) => c.startsWith(`${name}=`));

/**
 * A full login through the provider, returning the response the browser gets back from
 * the callback. The nonce rides to the stubbed token endpoint through a spare form field
 * so the signed ID token can echo back the one the library itself minted.
 */
async function signIn(provider: ReturnType<typeof oidcRpAuthProvider>): Promise<Response> {
  const login = await provider.handle(new Request(`${APP}/api/auth/login`));
  const flow = cookiesOf(login).get(FLOW_COOKIE)!;
  const authorize = new URL(login.headers.get('location')!);
  const nonce = authorize.searchParams.get('nonce')!;

  const original = globalThis.fetch;
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== `${ISSUER}/token`) return original(input as RequestInfo, init);
    const body = new URLSearchParams(String(init?.body));
    body.set('__nonce', nonce);
    return original(input as RequestInfo, { ...init, body });
  }) as typeof fetch);

  const back = await provider.handle(
    new Request(`${APP}/api/auth/callback?code=c-1&state=${authorize.searchParams.get('state')}`, {
      headers: { cookie: `${FLOW_COOKIE}=${encodeURIComponent(flow)}` },
    }),
  );
  expect(back.status).toBe(302);
  return back;
}

describe('federated logout', () => {
  it('hands the issuer the ID token from this login, so no confirmation is needed', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));
    const hint = jar.get(LOGOUT_HINT_COOKIE);
    expect(hint).toBeTruthy();

    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout?federated`, {
        headers: {
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(jar.get(SESSION_COOKIE)!)}; ${LOGOUT_HINT_COOKIE}=${encodeURIComponent(hint!)}`,
        },
      }),
    );

    expect(out.status).toBe(302);
    const to = new URL(out.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/api/auth/oauth2/end-session`);
    expect(to.searchParams.get('id_token_hint')).toBe(hint);
    // Still both of the things the OP matches the request against.
    expect(to.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(to.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/`);
  });

  it('scopes the hint cookie to the logout path, so it rides one request and not every one', async () => {
    const back = await signIn(oidcRpAuthProvider(cfg));

    const header = named(back, LOGOUT_HINT_COOKIE)[0]!;
    expect(header).toContain('Path=/api/auth/logout');
    expect(header).toContain('HttpOnly');
    // Strict, not Lax: a Lax cookie IS sent on a top-level cross-site GET, which is
    // exactly the navigation a hostile page would use to skip the OP's confirmation.
    expect(header).toContain('SameSite=Strict');
    // The session cookie is the one that must reach every route, and it stays Lax —
    // the login callback is a cross-site navigation back from the issuer.
    const session = named(back, SESSION_COOKIE)[0]!;
    expect(session).toContain('Path=/');
    expect(session).toContain('SameSite=Lax');
  });

  it('clears the hint on the way out, on the path it was set with', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));

    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout?federated`, {
        headers: { cookie: `${LOGOUT_HINT_COOKIE}=${encodeURIComponent(jar.get(LOGOUT_HINT_COOKIE)!)}` },
      }),
    );

    // A Max-Age=0 whose path does not match the original deletes nothing, so the path is
    // the assertion — not merely that something was cleared.
    const cleared = named(out, LOGOUT_HINT_COOKIE)[0]!;
    expect(cleared).toContain('Path=/api/auth/logout');
    expect(cleared).toMatch(/Max-Age=0/);
  });

  it('still logs out when there is no hint — a session minted before this version', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));

    // The browser holds the session but not the hint: the OP will show its confirmation
    // page, which is correct, and the next login puts the hint back.
    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout?federated`, {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(jar.get(SESSION_COOKIE)!)}` },
      }),
    );

    expect(out.status).toBe(302);
    const to = new URL(out.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/api/auth/oauth2/end-session`);
    expect(to.searchParams.has('id_token_hint')).toBe(false);
  });

  it('stays local when the issuer advertises no end-session endpoint', async () => {
    endSessionEndpoint = null;
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));

    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout?federated&returnTo=/hej`, {
        headers: { cookie: `${LOGOUT_HINT_COOKIE}=${encodeURIComponent(jar.get(LOGOUT_HINT_COOKIE)!)}` },
      }),
    );

    expect(out.headers.get('location')).toBe('/hej');
    // …and the local sign-out happened anyway. The issuer's uptime is not allowed to
    // decide whether somebody is signed out HERE.
    expect(named(out, SESSION_COOKIE)[0]).toContain('Max-Age=0');
  });

  it('withholds the hint from a plaintext end-session endpoint, but still signs out', async () => {
    endSessionEndpoint = 'http://logout.test/end-session';
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));

    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout?federated`, {
        headers: { cookie: `${LOGOUT_HINT_COOKIE}=${encodeURIComponent(jar.get(LOGOUT_HINT_COOKIE)!)}` },
      }),
    );

    // The redirect still happens — it carries no secret, and the person is signed out
    // either way. What must not travel over plaintext is the signed assertion about who
    // they are, in a URL that also lands in history and `Referer`.
    const to = new URL(out.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('http://logout.test/end-session');
    expect(to.searchParams.has('id_token_hint')).toBe(false);
    expect(to.searchParams.get('client_id')).toBe(cfg.clientId);
  });

  it('still sends the hint to a loopback endpoint — the dev issuer', async () => {
    endSessionEndpoint = 'http://localhost:8879/logout';
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));
    const hint = jar.get(LOGOUT_HINT_COOKIE)!;

    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout?federated`, {
        headers: { cookie: `${LOGOUT_HINT_COOKIE}=${encodeURIComponent(hint)}` },
      }),
    );

    expect(new URL(out.headers.get('location')!).searchParams.get('id_token_hint')).toBe(hint);
  });

  it('does not reach the issuer without ?federated', async () => {
    const provider = oidcRpAuthProvider(cfg);
    const jar = cookiesOf(await signIn(provider));

    const out = await provider.handle(
      new Request(`${APP}/api/auth/logout`, {
        headers: { cookie: `${LOGOUT_HINT_COOKIE}=${encodeURIComponent(jar.get(LOGOUT_HINT_COOKIE)!)}` },
      }),
    );

    expect(out.headers.get('location')).toBe('/');
    // The hint is still cleared: a plain logout ends this app's session, and a hint that
    // outlived it would be the stale thing left over.
    expect(named(out, LOGOUT_HINT_COOKIE)[0]).toContain('Max-Age=0');
  });

  /**
   * A multi-surface install (K-26): the sign-in is shared across `crm.` and `eka.`, so
   * the hint has to be too — otherwise signing out from the surface you did not log in
   * through is exactly the case that still hits the confirmation page.
   */
  it('follows the session cookie across surfaces when a cookieDomain is configured', async () => {
    const DOMAIN = 'global.substrat.test';
    const provider = oidcRpAuthProvider({ ...cfg, cookieDomain: DOMAIN });
    const back = await signIn(provider);

    const hints = named(back, LOGOUT_HINT_COOKIE);
    expect(hints).toHaveLength(2);
    expect(hints.find((c) => c.includes(`Domain=${DOMAIN}`))).toBeTruthy();
    // …and the host-only twin is cleared, the same hygiene the session cookie gets: two
    // cookies of one name are distinct to a browser, and the host-only one would shadow.
    expect(hints.find((c) => !c.includes('Domain='))).toContain('Max-Age=0');

    const out = await provider.handle(new Request(`${APP}/api/auth/logout`));
    expect(named(out, LOGOUT_HINT_COOKIE).every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
});
