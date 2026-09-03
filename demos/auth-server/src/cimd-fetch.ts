import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';

/**
 * The CIMD metadata transport for **workerd** — the Durable Object this issuer runs in.
 *
 * ## What the plugin asks for, and what this can honour
 *
 * `@better-auth/cimd` states its transport contract as a security requirement, not a type:
 *
 *   > The transport MUST resolve the hostname exactly once, reject RFC 6890 special-use
 *   > addresses, pin the approved address for the connection, and refuse redirects.
 *
 * It ships `@better-auth/cimd/node`, which does all four with `node:dns`. Our Node dev
 * server uses exactly that. **This file exists because workerd cannot.** There is no DNS
 * API in the Workers runtime, so "resolve once and pin the answer" is not expressible: by
 * the time `fetch` is called the runtime owns resolution, and nothing we can write sits
 * between the two. Three of the four clauses are implementable here; the pinning one is not.
 *
 * | Clause | Here |
 * |---|---|
 * | Refuse redirects | `redirect: 'manual'` — the response is returned, never followed |
 * | Reject special-use addresses | by hostname, below |
 * | Resolve exactly once | **not expressible** — the runtime resolves |
 * | Pin the resolved address | **not expressible** — see above |
 *
 * ## Why that is tolerable HERE, stated as a mitigation and not as the guarantee
 *
 * Pinning defends against DNS rebinding: a name that answers with a public address when it
 * is checked and a private one when it is fetched. The attack needs the second answer to be
 * reachable. A Worker's `fetch` egresses from Cloudflare's edge and has no route into
 * RFC 1918, loopback, or link-local space, so the rebind lands on an address the runtime
 * will not connect to.
 *
 * That is a property of where this code runs, not a property of this code. It is weaker
 * than the guarantee — a hosted issuer behind a private network path, or a runtime that
 * later gains one, would not inherit it — so it is written down rather than assumed. If
 * this issuer ever needs the real thing, the fetch has to move to a boundary that can
 * resolve: the D-46 egress hop (`apps/vertical-egress`) is where that would go.
 *
 * The hostname checks below are therefore defence in depth, not the defence. They refuse
 * the *obvious* special-use names before a request is made, which turns a whole class of
 * misconfiguration into a refusal rather than a request Cloudflare happens to drop.
 */

/**
 * Literal special-use hosts, refused before any request.
 *
 * Names only — a name is all we have. This cannot catch a public name that RESOLVES into
 * special-use space; that is exactly the clause we cannot honour, and pretending a
 * substring check covers it would be worse than the honest gap above.
 */
function isSpecialUseHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|]$/g, '');
  const isIpv6 = host.includes(':');
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

  // A single label never resolves through the public DNS root — `localhost`, `local`,
  // a container alias, a name a search domain would complete. A CIMD `client_id` is a
  // public URL by definition, so one label always means the local resolver.
  if (!isIpv6 && !isIpv4 && !host.includes('.')) return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // RFC 6761 special-use names that must never leave a local resolver.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true;
  }
  // IPv6: loopback / unspecified, link-local (fe80::/10), unique-local (fc00::/7),
  // multicast (ff00::/8 — `ff02::1` is every host on the link).
  if (host === '::1' || host === '::') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^ff[0-9a-f]{2}:/i.test(host)) return true;
  // IPv4 literals, including the ones inside an IPv4-mapped IPv6 address.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if (a === 10 || a === 127 || a === 0) return true; // private / loopback / this-host
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
    if (a >= 224) return true; // multicast / reserved / broadcast
  }
  return false;
}

/** Raised for a metadata URL this transport refuses to request at all. */
export class CimdFetchRefused extends Error {
  constructor(reason: string, readonly url: string) {
    super(`cimd: refusing to fetch ${url} — ${reason}`);
    this.name = 'CimdFetchRefused';
  }
}

/**
 * Fetch a CIMD-owned resource from workerd.
 *
 * Throws rather than returning a failed `Response` for a URL it will not request: a refusal
 * to make the request at all is a different fact from a server that answered badly, and the
 * plugin's own error path should not have to tell them apart by status code.
 */
export const fetchClientMetadataResource: ClientMetadataResourceFetch = (input, init) => {
  const raw = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CimdFetchRefused('not a valid absolute URL', raw);
  }

  // A `client_id` IS its metadata URL, so plain HTTP would mean a client identifier anyone
  // on the path can rewrite.
  if (url.protocol !== 'https:') throw new CimdFetchRefused('only https: is fetched', raw);
  if (url.username || url.password) throw new CimdFetchRefused('URL carries credentials', raw);
  if (isSpecialUseHost(url.hostname)) {
    throw new CimdFetchRefused('special-use host', raw);
  }

  return fetch(url, {
    ...init,
    // The contract's one clause workerd CAN meet exactly. A followed redirect is a second,
    // unchecked URL — the whole point of validating the first one.
    redirect: 'manual',
  });
};
