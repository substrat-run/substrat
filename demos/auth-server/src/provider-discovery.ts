import { isAllowedEndpoint, readDiscovery } from '@substrat-run/oidc-rp/discovery';
import { issuerOf, type ProviderEndpoints } from './providers.js';

/**
 * The auth adapter's discovery boundary — the ONE place this issuer fetches another issuer's
 * OIDC discovery document. Same class as `cimd-fetch.ts`: the issuer IS the relying party
 * here, with no `ctx` and no connector to delegate to, and resolving
 * `/.well-known/openid-configuration` is what an issuer URL MEANS (RFC 8414). The file exists
 * separately from `providers.ts` so the network reach is reviewable in one place — and so the
 * registry logic around it stays module code under the full layer rules.
 *
 * Called at SAVE time only, from the admin route — never per request. `providers.ts` carries
 * the reasoning (`resolveIssuerEndpoints` there in spirit): the per-request Better Auth
 * rebuild both runtimes rely on turns any runtime discovery fetch into a fetch per request,
 * and into unbounded recursion when the upstream's discovery routes back to this issuer.
 *
 * The read itself is `@substrat-run/oidc-rp`'s, uncached — the same rules every platform
 * relying party holds a discovery document to, so this issuer acting as a relying party is
 * held to them too: an https issuer (loopback http in dev), same-origin redirects only, the
 * `issuer` the document states is the one asked for, and a `jwks_uri` that passes the endpoint
 * rule below.
 */

/** The endpoints a person, an authorization code, the client secret or a token is sent to. */
const CREDENTIALED = ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'end_session_endpoint'] as const;

/**
 * Fetch and validate an issuer's discovery document. Throws with an operator-readable reason;
 * the admin route turns that into the 400 the form shows. The timeout is what stands between
 * "the upstream is down" and an admin request that hangs a Durable Object.
 */
export async function resolveIssuerEndpoints(input: string): Promise<ProviderEndpoints> {
  const issuer = issuerOf(input);
  // The document's self-declared issuer becomes the account namespace, so a document free to
  // declare any issuer could collide with another configured provider's accounts — which is
  // why `readDiscovery` refuses one that is not the issuer asked for.
  const doc = await readDiscovery(issuer, { signal: AbortSignal.timeout(10_000) });
  if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
    throw new Error(
      `${issuer} serves no usable OIDC discovery document (authorization_endpoint and token_endpoint are required)`,
    );
  }
  // Decided against the ISSUER, not per endpoint (`isAllowedEndpoint`): plaintext only on
  // loopback, and only when the issuer is itself a loopback dev issuer. An https upstream's
  // document must not be able to name a plaintext endpoint and have the client secret, a
  // code or a token sent there.
  for (const key of CREDENTIALED) {
    const value = doc[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !isAllowedEndpoint(issuer, value)) {
      throw new Error(`the discovery document's ${key} must be https (or http on loopback, for a loopback issuer): ${String(value)}`);
    }
  }
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    ...(doc.userinfo_endpoint ? { userinfo_endpoint: doc.userinfo_endpoint } : {}),
    ...(doc.end_session_endpoint ? { end_session_endpoint: doc.end_session_endpoint } : {}),
  };
}
