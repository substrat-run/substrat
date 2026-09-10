import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AuthProvider, AuthSubject } from './provider.js';

/**
 * Standard OIDC as an `AuthProvider` — token-based, so it covers Supabase (now an OIDC
 * issuer), Auth0, AuthHero, Keycloak, Zitadel, … all the same way. Login happens at the
 * issuer (the SPA redirects / uses the issuer's client and gets a token); the app just
 * VERIFIES the presented JWT against the issuer's JWKS and reads the subject. There are no
 * server-side auth endpoints to run, so `handle` is informational.
 *
 * workerd-safe: `jose` + Web Crypto only (the same stack `@substrat-run/oidc-rp` uses).
 */
export interface OidcConfig {
  /** The issuer URL (`iss`) — its `/.well-known/openid-configuration` gives the JWKS. */
  issuer: string;
  /** Expected audience (`aud`), if the issuer sets one for this app. */
  audience?: string;
  /** Override the JWKS URI (skip discovery) — e.g. a self-hosted issuer. */
  jwksUri?: string;
  /** Inject the key resolver directly — tests / a static JWKS. Defaults to the issuer's remote JWKS. */
  keys?: JWTVerifyGetKey;
}

/** Discover the JWKS URI from the issuer's OIDC metadata, cached per issuer for the isolate. */
const discoveryCache = new Map<string, Promise<string>>();
function discoverJwksUri(issuer: string): Promise<string> {
  let p = discoveryCache.get(issuer);
  if (!p) {
    p = (async () => {
      const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${res.status}`);
      const meta = (await res.json()) as { jwks_uri?: string };
      if (!meta.jwks_uri) throw new Error(`OIDC discovery for ${issuer} has no jwks_uri`);
      return meta.jwks_uri;
    })();
    discoveryCache.set(issuer, p);
  }
  return p;
}

function bearerFrom(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
  return null;
}

export function oidcAuthProvider(cfg: OidcConfig): AuthProvider {
  let keysPromise: Promise<JWTVerifyGetKey> | undefined;
  const getKeys = async (): Promise<JWTVerifyGetKey> => {
    if (cfg.keys) return cfg.keys;
    if (!keysPromise) {
      keysPromise = (async () => {
        const jwksUri = cfg.jwksUri ?? (await discoverJwksUri(cfg.issuer));
        return createRemoteJWKSet(new URL(jwksUri));
      })();
    }
    return keysPromise;
  };

  async function verify(token: string): Promise<AuthSubject | null> {
    try {
      const { payload } = await jwtVerify(token, await getKeys(), {
        issuer: cfg.issuer,
        ...(cfg.audience ? { audience: cfg.audience } : {}),
      });
      if (!payload.sub) return null;
      const meta = payload as Record<string, unknown>;
      // `email_verified`, read exactly as `@substrat-run/oidc-rp` reads it on the
      // browser-login path: a boolean when the issuer asserts one, and the `"true"` /
      // `"false"` strings some issuers in the Auth0 lineage emit instead — anything else,
      // the claim's absence included, stays `undefined` rather than becoming a guess.
      // Written out here rather than imported so this subpath keeps its two-module
      // dependency (jose + this file) and a bearer-only consumer needs no hono.
      const verified = meta['email_verified'];
      return {
        sub: String(payload.sub),
        email: typeof meta['email'] === 'string' ? (meta['email'] as string) : null,
        emailVerified:
          typeof verified === 'boolean'
            ? verified
            : verified === 'true'
              ? true
              : verified === 'false'
                ? false
                : undefined,
        name:
          typeof meta['name'] === 'string'
            ? (meta['name'] as string)
            : typeof (meta['user_metadata'] as { name?: unknown })?.name === 'string'
              ? ((meta['user_metadata'] as { name: string }).name)
              : null,
      };
    } catch {
      return null; // bad signature / expired / wrong issuer — resolve to nobody, fail closed
    }
  }

  return {
    async handle() {
      return Response.json({
        provider: 'oidc',
        issuer: cfg.issuer,
        note: 'authenticate at the issuer, then present the token as `Authorization: Bearer`',
      });
    },
    async resolve(headers) {
      const token = bearerFrom(headers);
      return token ? verify(token) : null;
    },
  };
}
