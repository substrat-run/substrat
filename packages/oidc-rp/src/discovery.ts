/**
 * OIDC discovery, held to what a discovery document is trusted with. Its own module (and the
 * `./discovery` subpath) so a caller that only needs a verified `jwks_uri` — a bearer verifier —
 * takes no dependency on the login flow.
 */

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

/**
 * Loopback hosts, where OAuth 2.1 still permits plain HTTP for local development —
 * `packages/dev-issuer` is exactly that, and every demo's dev login runs through it.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** HTTPS, or HTTP on a loopback host. The same rule the issuer applies to its own upstreams. */
export function isHttpsOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

export function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    return isHttpsOrLoopback(new URL(value));
  } catch {
    return false;
  }
}


/** How many same-origin redirects a discovery fetch follows (a trailing-slash bounce, say). */
const DISCOVERY_MAX_REDIRECTS = 3;

/**
 * GET the discovery document, following a redirect only while it stays on the origin it
 * started at: the document is what names the token endpoint and the keys, so where it is
 * served from is the trust root, and a redirect off that origin is a failure.
 */
async function fetchDiscovery(url: string): Promise<Response> {
  const origin = new URL(url).origin;
  let target = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) throw new Error(`OIDC discovery at ${url} answered ${res.status} with no Location`);
    const next = new URL(location, target);
    // The origin includes the scheme, so https -> http on the same host is off-origin too.
    if (next.origin !== origin) throw new Error(`OIDC discovery at ${url} redirected away from its origin`);
    if (hop >= DISCOVERY_MAX_REDIRECTS) throw new Error(`OIDC discovery at ${url} redirected more than ${DISCOVERY_MAX_REDIRECTS} times`);
    target = next.toString();
  }
}

/**
 * An issuer identifier as a comparison key: parsed, so the host's case and a default port do
 * not matter, with one trailing slash dropped. The path stays case-sensitive. Null when it is
 * not a URL at all.
 */
function issuerKey(issuer: string): string | null {
  try {
    const u = new URL(issuer);
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}

// Discovery + JWKS, cached per issuer for the life of the isolate.
const discoveryCache = new Map<string, Promise<Discovery>>();
/**
 * The issuer's discovery document, held to what it is trusted with: it must come from an
 * https issuer (or a loopback one, for a dev issuer), because a plaintext discovery fetch can
 * be rewritten in flight with the `issuer` intact; it must state the issuer it was fetched
 * for; and it names no plaintext `jwks_uri`. Exported so every path that trusts a discovery
 * document for the same issuer (a bearer verifier's key lookup) shares this one.
 */
export function discoverIssuer(issuer: string): Promise<Discovery> {
  const key = issuerKey(issuer);
  if (!key || !isHttpsOrLoopback(new URL(issuer))) {
    // Not cached: nothing was asked of anyone.
    return Promise.reject(new Error('OIDC issuer is not https'));
  }
  const cached = discoveryCache.get(key);
  if (cached) return cached;
  const url = `${key}/.well-known/openid-configuration`;
  // A FAILURE IS NOT CACHED. Concurrent callers still share the one in-flight fetch, but
  // the entry is evicted the moment it rejects — otherwise one lookup against an issuer
  // that happened to be down poisons the isolate for its whole life, and every later
  // login replays that rejection after the issuer has recovered. Federated logout makes
  // that reachable in a way it was not before: it degrades to a local sign-out, so the
  // request that poisoned the cache is the one that looked like it worked.
  const pending: Promise<Discovery> = fetchDiscovery(url)
    .then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}) at ${url}`);
      const d = (await r.json()) as Discovery;
      // OIDC Discovery §4.3: the `issuer` the document states MUST be the one it was fetched
      // for. The ID token is checked against `d.issuer` and its keys come from `d.jwks_uri`, so
      // without this the document vouches for itself. Fail closed, and (below) do not cache it.
      if (typeof d.issuer !== 'string' || issuerKey(d.issuer) !== key) {
        throw new Error(`OIDC discovery at ${url} names a different issuer`);
      }
      // The keys an ID token is verified against are fetched from here, so not in plaintext.
      if (typeof d.jwks_uri !== 'string' || !isHttpsOrLoopbackUrl(d.jwks_uri)) {
        throw new Error(`OIDC discovery at ${url} names a jwks_uri that is not https`);
      }
      return d;
    })
    .catch((err: unknown) => {
      if (discoveryCache.get(key) === pending) discoveryCache.delete(key);
      throw err;
    });
  discoveryCache.set(key, pending);
  return pending;
}

