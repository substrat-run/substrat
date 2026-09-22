import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
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
  /**
   * Set ONLY when the issuer is shared with other clients (a team auth-server, #1683): the
   * relying-party client this app is there. A bearer must then be this app's own token,
   * not merely one the issuer signed — see `isOwnToken`. Absent, any `aud` passes, as it
   * always has, because an issuer the operator configured by hand is theirs and its knob
   * is `audience`. Ignored when `audience` is set: an explicit audience keeps winning.
   */
  clientId?: string;
  /**
   * With `clientId`: this app's MCP resource identifier on an origin — `mcpResourceOf` from
   * `@substrat-run/contracts`, handed in rather than imported so this subpath keeps its
   * jose-only dependency. An access token whose `aud` names it is this app's own too.
   */
  resourceOf?: (origin: string) => string;
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

/**
 * The MCP resource identifiers this request's own origin answers to — the `aud` an access
 * token minted for this app's MCP endpoint carries (#1619). Built with the caller's
 * `resourceOf` — `mcpResourceOf`, the one spelling the endpoint, the dashboard and the
 * issuer all share.
 *
 * The request URL is the answer when the caller hands it over. Every caller written
 * before #1683 passes headers alone, so the `Host` header stands in, under both schemes
 * because it carries none. That is sound only because this list can do nothing but admit
 * a token that would otherwise be REFUSED — today's behaviour admitted every token, so no
 * value of `Host` makes this check weaker than what it replaces. And the router
 * dispatches by hostname, so a request naming another vertical's host does not reach
 * this one. The strings are only ever compared for equality with a signed `aud`, so a
 * `Host` that is not a bare authority builds one that matches nothing.
 */
function ownResources(headers: Headers, url: string | undefined, resourceOf: (origin: string) => string): string[] {
  if (url) {
    try {
      return [resourceOf(new URL(url).origin)];
    } catch {
      return [];
    }
  }
  const host = headers.get('host')?.toLowerCase();
  if (!host) return [];
  return [resourceOf(`https://${host}`), resourceOf(`http://${host}`)];
}

/**
 * Whether a verified token was minted FOR this app, rather than only BY its issuer
 * (#1683). Every client of a team auth-server shares one issuer and one JWKS, so signature
 * and `iss` say nothing about which app a token is for: without this, any client's
 * `id_token` — including one an anonymous dynamic registration obtained — and another
 * vertical's MCP access token resolved to the user they name on every route.
 *
 * Admitted, in order:
 *
 *  1. **`aud` names this app's own MCP resource.** An access token for this app's
 *     endpoint. Its `azp` is the MCP *client's* id, never ours, so this has to come first.
 *  2. **An authorized party that is us.** When `azp` or `client_id` is present, every one
 *     present must equal our client id — and then the token was issued to our client,
 *     whatever its `aud`. When one is present and is someone else, that is the answer:
 *     refused, even with our id in `aud` (OIDC Core §3.1.3.7, item 5).
 *  3. **No authorized party, and `aud` is exactly our client id.** Our own `id_token`:
 *     Better Auth, like most issuers, puts no `azp` on one. A multi-valued `aud` with no
 *     `azp` is refused — OIDC Core asks for `azp` exactly then, and without it nothing
 *     says which of the audiences the token was handed to.
 *
 * Everything else is refused, a token with neither `aud` nor an authorized party included.
 */
function isOwnToken(payload: JWTPayload, clientId: string, resources: readonly string[]): boolean {
  const aud = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
  if (resources.some((r) => aud.includes(r))) return true;
  const parties = [payload['azp'], payload['client_id']].filter((v): v is string => typeof v === 'string');
  if (parties.length > 0) return parties.every((p) => p === clientId);
  return aud.length === 1 && aud[0] === clientId;
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

  async function verify(token: string, headers: Headers, url: string | undefined): Promise<AuthSubject | null> {
    try {
      const { payload } = await jwtVerify(token, await getKeys(), {
        issuer: cfg.issuer,
        ...(cfg.audience ? { audience: cfg.audience } : {}),
      });
      if (!payload.sub) return null;
      if (!cfg.audience && cfg.clientId) {
        const resources = cfg.resourceOf ? ownResources(headers, url, cfg.resourceOf) : [];
        if (!isOwnToken(payload, cfg.clientId, resources)) return null;
      }
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
    async resolve(headers, url) {
      const token = bearerFrom(headers);
      return token ? verify(token, headers, url) : null;
    },
  };
}
