import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { discoverIssuer, isAllowedEndpoint, issuerRefusal } from '@substrat-run/oidc-rp/discovery';
import type { AuthProvider, AuthSubject } from './provider.js';

/**
 * Standard OIDC as an `AuthProvider` — token-based, so it covers Supabase (now an OIDC
 * issuer), Auth0, AuthHero, Keycloak, Zitadel, … all the same way. Login happens at the
 * issuer (the SPA redirects / uses the issuer's client and gets a token); the app just
 * VERIFIES the presented JWT against the issuer's JWKS and reads the subject. There are no
 * server-side auth endpoints to run, so `handle` is informational.
 *
 * workerd-safe: `jose`, Web Crypto and `@substrat-run/oidc-rp/discovery` (the bound discovery
 * the login path uses; no login flow and no `hono`).
 */
export interface OidcConfig {
  /**
   * The issuer URL (`iss`). Must be `https` (loopback `http` for a dev issuer); its
   * `/.well-known/openid-configuration` gives the JWKS, and must name this issuer.
   */
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
   * small dependency set (jose + oidc-rp's discovery). An access token whose `aud` names it is
   * this app's own too.
   */
  resourceOf?: (origin: string) => string;
  /**
   * Accept DELEGATED tokens (#1824, RFC 8693 `act`) for this app's MCP endpoint, from these
   * actors only. Absent, every token carrying `act` is refused, whatever else it says: a
   * host that has not opted in must never take another app's call for the user's own. Needs
   * `resourceOf` (a shared issuer), and admits a delegated token only on a request that
   * passes its URL — see `delegationOf`.
   */
  delegation?: DelegationOption;
  /** Override the JWKS URI (skip discovery) — e.g. a self-hosted issuer. */
  jwksUri?: string;
  /** Inject the key resolver directly — tests / a static JWKS. Defaults to the issuer's remote JWKS. */
  keys?: JWTVerifyGetKey;
}

/** Which apps this one lets act for its users (#1824). */
export interface DelegationOption {
  /**
   * The actors' client ids at the issuer — the `sub` of a delegated token's `act`, and its
   * authorized party. An empty list admits nobody.
   */
  actors: readonly string[];
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
 *  2. **An authorized party that is us** — unless `aud` names ANOTHER app's MCP resource.
 *     When `azp` or `client_id` is present, every one present must equal our client id —
 *     and then the token was issued to our client, whatever its `aud`. When one is present
 *     and is someone else, that is the answer: refused, even with our id in `aud` (OIDC
 *     Core §3.1.3.7, item 5). The exception (#1824): a token for another app's MCP endpoint
 *     is that endpoint's, even when our client is the one it was issued to — as the MCP
 *     client, or as the actor of a delegation — so it is refused here, where it would
 *     otherwise stand for the user at our own API with no limit on what it may do.
 *  3. **No authorized party, and `aud` is exactly our client id.** Our own `id_token`:
 *     Better Auth, like most issuers, puts no `azp` on one. A multi-valued `aud` with no
 *     `azp` is refused — OIDC Core asks for `azp` exactly then, and without it nothing
 *     says which of the audiences the token was handed to.
 *
 * Everything else is refused, a token with neither `aud` nor an authorized party included.
 * A token carrying `act` never reaches this: it is a delegation, judged by `delegationOf`.
 */
function isOwnToken(
  payload: JWTPayload,
  clientId: string,
  resources: readonly string[],
  resourceOf: ((origin: string) => string) | undefined,
): boolean {
  const aud = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
  if (resources.some((r) => aud.includes(r))) return true;
  if (resourceOf && aud.some((a) => isMcpResource(a, resourceOf))) return false;
  const parties = [payload['azp'], payload['client_id']].filter((v): v is string => typeof v === 'string');
  if (parties.length > 0) return parties.every((p) => p === clientId);
  return aud.length === 1 && aud[0] === clientId;
}

/**
 * Whether `value` is the MCP resource identifier of SOME origin — the one spelling
 * `resourceOf` gives every endpoint, and so every `aud` the issuer mints for one. A client
 * id or a userinfo URL is not one.
 */
function isMcpResource(value: string, resourceOf: (origin: string) => string): boolean {
  try {
    const url = new URL(value);
    return resourceOf(url.origin) === `${url.origin}${url.pathname}`;
  } catch {
    return false;
  }
}

/**
 * The delegation a token carrying `act` stands for, or null when it is not one this app
 * takes (#1824). The shape is what the team auth-server's second exchange mints
 * (`demos/auth-server/src/token-exchange.ts`): the user as `sub`, the actor's client as
 * `act.sub` and as the authorized party, one MCP resource as `aud`, and the delegated
 * permission keys as `scope`.
 *
 * Every condition is required, and each refuses on its own:
 *
 *  - **The host opted in** (`cfg.delegation`) **and names this actor.** Without the option
 *    nothing with `act` is admitted, so a host that has not upgraded is never exposed.
 *  - **One actor, of this issuer.** `act` is an object whose `iss` is the token's own and
 *    whose `sub` is a string, with no nested `act`: a chain of actors is not something any
 *    exchange here mints, and nothing reads past the first.
 *  - **Issued to that actor.** Every present `azp` / `client_id` equals `act.sub`, and at
 *    least one is present.
 *  - **For this endpoint, on this request.** `aud` is exactly one value, this app's own
 *    MCP resource on the request's origin, AND the request is to that resource. Unlike a
 *    user's MCP token (`isOwnToken` rule 1, which any route admits), a delegated token
 *    stands for the user only where a ceiling is applied to it — the MCP endpoint — so a
 *    caller that passes no `url`, or a REST route, never admits one.
 *  - **A scope, and an expiry.** `scope` is a non-empty space-separated list (the grammar
 *    the exchange writes, RFC 6749 §3.3), and `exp` is present. `jwtVerify` has already
 *    refused a token whose `exp` has passed.
 */
function delegationOf(
  payload: JWTPayload,
  delegation: DelegationOption,
  resourceOf: (origin: string) => string,
  url: string | undefined,
): { actor: string; scope: string[] } | null {
  const act = payload['act'];
  if (act === null || typeof act !== 'object' || Array.isArray(act)) return null;
  const { iss, sub: actor, act: prior } = act as Record<string, unknown>;
  if (prior !== undefined || iss !== payload.iss) return null;
  if (typeof actor !== 'string' || !delegation.actors.includes(actor)) return null;

  const parties = [payload['azp'], payload['client_id']].filter((p) => p !== undefined);
  if (parties.length === 0 || !parties.every((p) => p === actor)) return null;

  const aud = typeof payload.aud === 'string' ? payload.aud : Array.isArray(payload.aud) && payload.aud.length === 1 ? payload.aud[0] : null;
  if (!aud || !url) return null;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (aud !== resourceOf(target.origin) || aud !== `${target.origin}${target.pathname}`) return null;

  if (typeof payload.exp !== 'number') return null;
  const scope = typeof payload['scope'] === 'string' ? [...new Set(payload['scope'].split(' ').filter((s) => s.length > 0))] : [];
  if (scope.length === 0) return null;
  return { actor, scope };
}

export function oidcAuthProvider(cfg: OidcConfig): AuthProvider {
  let keysPromise: Promise<JWTVerifyGetKey> | undefined;
  const getKeys = async (): Promise<JWTVerifyGetKey> => {
    if (cfg.keys) return cfg.keys;
    if (!keysPromise) {
      // The login path's discovery, not a second one: bound to this issuer, https, no redirect
      // off its origin (`discoverIssuer`). A failure is evicted here too, so an issuer that was
      // down or answered wrongly once is asked again rather than refused for the isolate's life.
      const pending: Promise<JWTVerifyGetKey> = (async () => {
        const jwksUri = cfg.jwksUri ?? (await discoverIssuer(cfg.issuer)).jwks_uri;
        // An override skips discovery, not the transport rule: the keys are fetched from it.
        // Nor the issuer rule: with no discovery, nothing else has looked at `cfg.issuer`.
        if (cfg.jwksUri) {
          const refused = issuerRefusal(cfg.issuer);
          if (refused) throw new Error(refused);
          if (!isAllowedEndpoint(cfg.issuer, cfg.jwksUri)) throw new Error('jwksUri is not https');
        }
        return createRemoteJWKSet(new URL(jwksUri));
      })();
      pending.catch(() => {
        if (keysPromise === pending) keysPromise = undefined;
      });
      keysPromise = pending;
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
      // A token carrying `act` is a delegation, on every configuration: admitted only through
      // the opt-in, and never by the rules below, which would take it as the user's own.
      let delegation: AuthSubject['delegation'];
      if (payload['act'] !== undefined) {
        const admitted = cfg.delegation && cfg.resourceOf ? delegationOf(payload, cfg.delegation, cfg.resourceOf, url) : null;
        if (!admitted) return null;
        delegation = admitted;
      } else if (!cfg.audience && cfg.clientId) {
        const resources = cfg.resourceOf ? ownResources(headers, url, cfg.resourceOf) : [];
        if (!isOwnToken(payload, cfg.clientId, resources, cfg.resourceOf)) return null;
      }
      const meta = payload as Record<string, unknown>;
      // `email_verified`, read exactly as `@substrat-run/oidc-rp` reads it on the
      // browser-login path: a boolean when the issuer asserts one, and the `"true"` /
      // `"false"` strings some issuers in the Auth0 lineage emit instead — anything else,
      // the claim's absence included, stays `undefined` rather than becoming a guess.
      // Written out here rather than imported so this subpath keeps a small dependency
      // set (jose + oidc-rp's discovery, no login flow) and a bearer-only consumer needs no hono.
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
        ...(typeof payload.exp === 'number' ? { expiresAt: new Date(payload.exp * 1000).toISOString() } : {}),
        ...(delegation ? { delegation } : {}),
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
