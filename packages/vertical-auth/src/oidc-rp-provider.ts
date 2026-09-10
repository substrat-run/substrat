import {
  beginLogin,
  completeLogin,
  federatedLogoutUrl,
  verifySession,
  readCookie,
  safePath,
  SESSION_COOKIE,
  FLOW_COOKIE,
  LOGOUT_HINT_COOKIE,
  LOGOUT_PATH,
  SESSION_MAXAGE,
  FLOW_MAXAGE,
  type OidcEnv,
} from '@substrat-run/oidc-rp';
import type { AuthProvider, AuthSubject } from './provider.js';
import { oidcAuthProvider } from './oidc.js';
import { resolveCookieDomain } from './cookie-domain.js';

/**
 * Standard OIDC as a full RELYING PARTY `AuthProvider` — the browser-login counterpart
 * of `oidcAuthProvider` (which only verifies presented bearer tokens). `handle` owns the
 * server-side Authorization-Code + PKCE round-trip on the same paths every provider uses
 * (`/api/auth/login` → issuer → `/api/auth/callback` → session cookie → `/api/auth/logout`),
 * and `resolve` verifies the session cookie — falling back to bearer verification so API
 * clients keep working against the same instance.
 *
 * Config is a PLAIN OBJECT, not worker env: a hosted vertical builds it per request from
 * the scope's delivered `substrat:auth` (vertical-auth-detach.md §2.2-§2.3) plus the
 * tenant's DO-minted session secret — one script, many issuers. The `oidc-rp` internals
 * already take their env as a parameter everywhere, so this is the same battle-tested
 * flow the dashboard and console run, pointed at per-instance config.
 */
export interface OidcRpConfig {
  /** The issuer origin — a team's Auth Server app, Supabase, Auth0, Keycloak, … */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Signs the flow + session cookies. Per-instance (DO-minted), never a worker binding. */
  sessionSecret: string;
  /** Expected `aud` for PRESENTED bearer tokens (the API-client path), if the issuer sets one. */
  audience?: string;
  /**
   * Share the login across every surface under this parent domain (`acme.se` covers
   * `crm.` and `eka.` alike) — the session cookie is set with `Domain=…` instead of
   * host-only. Delivered per scope (`substrat:auth`), validated against the request host
   * where the cookie is set (cookie-domain.ts); invalid ⇒ host-only, never broken sign-in.
   */
  cookieDomain?: string;
}

const envOf = (cfg: OidcRpConfig): OidcEnv => ({
  OIDC_ISSUER: cfg.issuer,
  OIDC_CLIENT_ID: cfg.clientId,
  OIDC_CLIENT_SECRET: cfg.clientSecret,
  SESSION_SECRET: cfg.sessionSecret,
});

/** Serialize one Set-Cookie value — HttpOnly, and by default Lax on path=/ (the oidc-rp mount's flags). */
function cookie(
  name: string,
  value: string,
  origin: string,
  maxAge: number,
  domain?: string | null,
  path = '/',
  sameSite: 'Lax' | 'Strict' = 'Lax',
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (origin.startsWith('https:')) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Set the session cookie, host-only or domain-wide. A domain cookie and a host-only
 * cookie with the same name are DISTINCT cookies to the browser, and a stale host-only
 * one (from before `cookieDomain` was configured) would shadow the shared session on
 * this hostname — so setting the domain variant also clears the host-only one, and
 * clearing (logout) always clears both.
 */
function sessionCookies(value: string, origin: string, maxAge: number, domain: string | null): string[] {
  if (!domain) return [cookie(SESSION_COOKIE, value, origin, maxAge)];
  return [cookie(SESSION_COOKIE, value, origin, maxAge, domain), cookie(SESSION_COOKIE, '', origin, 0)];
}

/**
 * The login's ID token, kept ONLY to be handed back to the issuer as `id_token_hint`
 * when this session is signed out federated — see `federatedLogoutUrl`, and the same
 * cookie `mountOidcRoutes` sets.
 *
 * Two attributes differ from the session cookie, both deliberately:
 *
 *  - **`Path=/api/auth/logout`**, so the hint rides exactly one request in the session's
 *    life instead of every one. It is not a credential this app ever reads.
 *  - **`SameSite=Strict`**, where the session is Lax. A Lax cookie IS sent on a
 *    top-level cross-site GET, so a hostile page linking to `?federated` would hand the
 *    OP a valid hint and get the very confirmation page this removes skipped — logout
 *    CSRF against the issuer session. Strict withholds the hint from any cross-site
 *    navigation, which downgrades that case to the confirmation page and leaves the
 *    in-app sign-out (same-site) redirecting straight through. The session cookie stays
 *    Lax because the login callback is itself a cross-site navigation back from the
 *    issuer and must arrive carrying it.
 *
 * The `cookieDomain` treatment follows the session's, for the same reason: on a
 * multi-surface install (K-26) the sign-in is shared, so the sign-out has to work from
 * whichever surface the person is on rather than only the one they logged in through.
 */
function hintCookies(value: string, origin: string, maxAge: number, domain: string | null): string[] {
  if (!domain) return [cookie(LOGOUT_HINT_COOKIE, value, origin, maxAge, null, LOGOUT_PATH, 'Strict')];
  return [
    cookie(LOGOUT_HINT_COOKIE, value, origin, maxAge, domain, LOGOUT_PATH, 'Strict'),
    cookie(LOGOUT_HINT_COOKIE, '', origin, 0, null, LOGOUT_PATH, 'Strict'),
  ];
}

function redirectWith(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

// Bearer verifiers cached per issuer+audience so the JWKS fetch survives across
// requests in an isolate even though the provider object itself is per-request.
const bearerCache = new Map<string, AuthProvider>();
function bearerVerifier(cfg: OidcRpConfig): AuthProvider {
  const key = `${cfg.issuer}|${cfg.audience ?? ''}`;
  let p = bearerCache.get(key);
  if (!p) {
    p = oidcAuthProvider({ issuer: cfg.issuer, ...(cfg.audience ? { audience: cfg.audience } : {}) });
    bearerCache.set(key, p);
  }
  return p;
}

export function oidcRpAuthProvider(cfg: OidcRpConfig): AuthProvider {
  const env = envOf(cfg);

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    // The flow cookie stays HOST-ONLY even with a cookieDomain: the code flow begins and
    // completes on one hostname (redirect_uri is this origin's callback), and a domain-wide
    // flow cookie would only let two surfaces' concurrent logins clobber each other.
    const domain = resolveCookieDomain(cfg.cookieDomain, url.hostname);

    if (url.pathname === '/api/auth/login') {
      const screen = url.searchParams.get('screen_hint');
      // `prompt` is forwarded (allowlisted to the two IdP-recognised values) for the same
      // reason `mountOidcRoutes` forwards it: without it, "sign in as someone else" cannot
      // work against an issuer holding a live SSO session — it silently re-authenticates
      // the user already signed in, and no amount of clicking changes who you are.
      const prompt = url.searchParams.get('prompt');
      const { location, flow } = await beginLogin(env, origin, {
        returnTo: safePath(url.searchParams.get('returnTo')),
        loginHint: url.searchParams.get('login_hint') || undefined,
        screenHint: screen === 'signup' || screen === 'login' ? screen : undefined,
        prompt: prompt === 'login' || prompt === 'select_account' ? prompt : undefined,
      });
      return redirectWith(location, [cookie(FLOW_COOKIE, flow, origin, FLOW_MAXAGE)]);
    }

    if (url.pathname === '/api/auth/callback') {
      const flow = readCookie(request.headers.get('cookie'), FLOW_COOKIE);
      const clearFlow = cookie(FLOW_COOKIE, '', origin, 0);
      try {
        const { session, returnTo, idToken } = await completeLogin(env, origin, url, flow);
        return redirectWith(safePath(returnTo) ?? '/', [
          clearFlow,
          ...sessionCookies(session, origin, SESSION_MAXAGE, domain),
          // Same lifetime as the session, so the two expire together and a stale hint is
          // never the thing left over.
          ...hintCookies(idToken, origin, SESSION_MAXAGE, domain),
        ]);
      } catch (err) {
        // Loud in the logs, opaque to the browser — same stance as the oidc-rp mount.
        console.error('oidc.callback.failed', { reason: err instanceof Error ? err.message : String(err) });
        return redirectWith('/?error=auth', [clearFlow]);
      }
    }

    if (url.pathname === LOGOUT_PATH) {
      const local = safePath(url.searchParams.get('returnTo')) ?? '/';
      const cleared = [...sessionCookies('', origin, 0, domain), ...hintCookies('', origin, 0, domain)];
      /**
       * `?federated` ALSO ends the issuer's own session (OIDC RP-Initiated Logout 1.0).
       * Without it the issuer's cookie silently signs the same person straight back in on
       * the next "Sign in", so the sign-out looks like it never happened — and "use
       * another account" can never work. Opt-in per link, as in `mountOidcRoutes`: a plain
       * logout stays local, which is what a surface sharing an issuer session with others
       * wants.
       *
       * The cookies above are on THIS response, whatever happens next: an issuer that is
       * down, advertises no end-session endpoint, or refuses our
       * `post_logout_redirect_uri` can only leave its own session standing — never keep
       * somebody signed in here.
       */
      if (url.searchParams.has('federated')) {
        const hint = readCookie(request.headers.get('cookie'), LOGOUT_HINT_COOKIE);
        const away = await federatedLogoutUrl(env, origin, local, hint);
        if (away) return redirectWith(away, cleared);
      }
      return redirectWith(local, cleared);
    }

    // Anything else under /api/auth/* (sign-up, password endpoints, …) has no server
    // here — accounts live at the issuer. JSON, never a fall-through to the SPA.
    return Response.json(
      { error: 'this instance authenticates at its OIDC issuer', issuer: cfg.issuer },
      { status: 404 },
    );
  }

  async function resolve(headers: Headers): Promise<AuthSubject | null> {
    const session = await verifySession(env, readCookie(headers.get('cookie'), SESSION_COOKIE));
    if (session) {
      return {
        sub: session.id,
        email: session.email ?? null,
        name: session.name ?? null,
        // Passed through as-is, `undefined` included: the session says what the issuer
        // said, and an absent claim is a fact about the issuer, not a missing value.
        emailVerified: session.emailVerified,
      };
    }
    // No cookie session — an API client presenting the issuer's own token directly.
    return bearerVerifier(cfg).resolve(headers);
  }

  return { handle, resolve };
}
