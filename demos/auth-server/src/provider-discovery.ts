import { discoveryUrlOf, type ProviderEndpoints } from './providers.js';

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
 */

/**
 * Fetch and validate an issuer's discovery document. Throws with an operator-readable reason;
 * the admin route turns that into the 400 the form shows. The timeout is what stands between
 * "the upstream is down" and an admin request that hangs a Durable Object.
 */
export async function resolveIssuerEndpoints(issuer: string): Promise<ProviderEndpoints> {
  const url = discoveryUrlOf(issuer);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status} — is the issuer URL right?`);
  const doc = (await res.json().catch(() => null)) as Partial<ProviderEndpoints> | null;
  if (!doc?.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(
      `${url} is not an OIDC discovery document (issuer, authorization_endpoint and token_endpoint are required)`,
    );
  }
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    ...(doc.userinfo_endpoint ? { userinfo_endpoint: doc.userinfo_endpoint } : {}),
    ...(doc.end_session_endpoint ? { end_session_endpoint: doc.end_session_endpoint } : {}),
  };
}
