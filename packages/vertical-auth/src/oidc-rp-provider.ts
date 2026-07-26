import {
  beginLogin,
  completeLogin,
  verifySession,
  readCookie,
  safePath,
  SESSION_COOKIE,
  FLOW_COOKIE,
  SESSION_MAXAGE,
  FLOW_MAXAGE,
  type OidcEnv,
} from '@substrat-run/oidc-rp';
import type { AuthProvider, AuthSubject } from './provider.js';
import { oidcAuthProvider } from './oidc.js';

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
}

const envOf = (cfg: OidcRpConfig): OidcEnv => ({
  OIDC_ISSUER: cfg.issuer,
  OIDC_CLIENT_ID: cfg.clientId,
  OIDC_CLIENT_SECRET: cfg.clientSecret,
  SESSION_SECRET: cfg.sessionSecret,
});

/** Serialize one Set-Cookie value — HttpOnly, Lax, path=/ (the oidc-rp mount's flags). */
function cookie(name: string, value: string, origin: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (origin.startsWith('https:')) parts.push('Secure');
  return parts.join('; ');
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

    if (url.pathname === '/api/auth/login') {
      const screen = url.searchParams.get('screen_hint');
      const { location, flow } = await beginLogin(env, origin, {
        returnTo: safePath(url.searchParams.get('returnTo')),
        loginHint: url.searchParams.get('login_hint') || undefined,
        screenHint: screen === 'signup' || screen === 'login' ? screen : undefined,
      });
      return redirectWith(location, [cookie(FLOW_COOKIE, flow, origin, FLOW_MAXAGE)]);
    }

    if (url.pathname === '/api/auth/callback') {
      const flow = readCookie(request.headers.get('cookie'), FLOW_COOKIE);
      const clearFlow = cookie(FLOW_COOKIE, '', origin, 0);
      try {
        const { session, returnTo } = await completeLogin(env, origin, url, flow);
        return redirectWith(safePath(returnTo) ?? '/', [
          clearFlow,
          cookie(SESSION_COOKIE, session, origin, SESSION_MAXAGE),
        ]);
      } catch (err) {
        // Loud in the logs, opaque to the browser — same stance as the oidc-rp mount.
        console.error('oidc.callback.failed', { reason: err instanceof Error ? err.message : String(err) });
        return redirectWith('/?error=auth', [clearFlow]);
      }
    }

    if (url.pathname === '/api/auth/logout') {
      return redirectWith(safePath(url.searchParams.get('returnTo')) ?? '/', [
        cookie(SESSION_COOKIE, '', origin, 0),
      ]);
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
    if (session) return { sub: session.id, email: session.email ?? null, name: session.name ?? null };
    // No cookie session — an API client presenting the issuer's own token directly.
    return bearerVerifier(cfg).resolve(headers);
  }

  return { handle, resolve };
}
