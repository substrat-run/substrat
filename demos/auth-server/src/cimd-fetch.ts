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
 * The IPv4 special-use ranges of RFC 6890, judged on the octets rather than on text.
 * `URL` canonicalises every IPv4 spelling — decimal, octal, hex — into a dotted quad
 * before we see it, so this is the only form that needs deciding.
 */
function isSpecialUseV4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-host / private / loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/**
 * An IPv6 literal as its eight hextets, or `null` if it is not one.
 *
 * Parsed rather than pattern-matched because the ranges that matter are bit prefixes,
 * and the same address has many spellings: `::ffff:127.0.0.1` and `::ffff:7f00:1` are
 * one address, and `URL` hands back whichever it prefers.
 */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(':')) return null;

  let rest = text;
  // A trailing dotted quad (`::ffff:127.0.0.1`) is two hextets in disguise.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
  if (dotted) {
    const [a = -1, b = -1, c = -1, d = -1] = (dotted[1] ?? '').split('.').map(Number);
    if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    rest = `${rest.slice(0, dotted.index)}${hex4((a << 8) | b)}:${hex4((c << 8) | d)}`;
  }

  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const hextetsOf = (part: string) =>
    part === ''
      ? []
      : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : Number.NaN));
  const head = hextetsOf(halves[0] ?? '');
  const tail = halves.length === 2 ? hextetsOf(halves[1] ?? '') : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;

  const gap = 8 - head.length - tail.length;
  if (halves.length === 2 ? gap < 0 : gap !== 0) return null;
  return [...head, ...(Array(halves.length === 2 ? gap : 0).fill(0) as number[]), ...tail];
}

/** RFC 6890's IPv6 side, plus the three ways an IPv4 address hides inside one. */
function isSpecialUseIpv6(hextets: number[]): boolean {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = hextets;
  const zeroPrefix = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  const embedsV4 =
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compat — which is also where ::1 and :: land)
    (zeroPrefix && (h5 === 0xffff || h5 === 0)) ||
    // 64:ff9b::/96, the well-known NAT64 prefix
    (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0);
  if (embedsV4 && isSpecialUseV4(h6 >> 8, h6 & 0xff, h7 >> 8)) return true;

  if ((h0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((h0 & 0xff00) === 0xff00) return true; // multicast ff00::/8 — ff02::1 is every host
  return false;
}

/**
 * Special-use hosts, refused before any request.
 *
 * Names only — a name is all we have. This cannot catch a public name that RESOLVES into
 * special-use space; that is exactly the clause we cannot honour, and pretending a
 * substring check covers it would be worse than the honest gap above. What it can do is
 * decide the *literal* correctly however it is spelled, which is why the address forms
 * below are parsed rather than matched.
 */
function isSpecialUseHost(hostname: string): boolean {
  // `URL` hands back the canonical host, which keeps two things a comparison would trip
  // over: the brackets around an IPv6 literal, and a fully-qualified name's terminal dot.
  // `localhost.` IS localhost, and one trailing dot is enough to slip past every suffix
  // test below.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/\.$/, '');

  if (host.includes(':')) {
    const hextets = parseIpv6(host);
    // An address literal we cannot parse is not one to fetch: fail closed.
    return hextets === null ? true : isSpecialUseIpv6(hextets);
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isSpecialUseV4(Number(v4[1]), Number(v4[2]), Number(v4[3]));

  // A single label never resolves through the public DNS root — `localhost`, `local`, a
  // container alias, a name a search domain would complete. A CIMD `client_id` is a public
  // URL by definition, so one label always means the local resolver. An empty host lands
  // here too, and is refused for the same reason.
  if (!host.includes('.')) return true;

  if (host.endsWith('.localhost')) return true;
  // RFC 6761 special-use names that must never leave a local resolver.
  return host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa');
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
