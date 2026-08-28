/**
 * The Cloudflare read of "who is on the other end" — normalised ONCE, here.
 *
 * Cloudflare puts what it knows about a request's origin on `request.cf`: country,
 * region, city, timezone, and a dozen more fields (colo, ASN, TLS version, bot
 * score) that answer questions a vertical does not ask. This is the only place the
 * platform reads that object. Everything above it — a host's harness, a vertical's
 * operation input, a row in a table — sees `ClientContext` from contracts, and would
 * see the identical shape from a node dev server or a future edge that says the same
 * things in headers.
 *
 * What is normalised, and why:
 *
 *   - `country` `T1` (Tor) and `XX` (unknown) are Cloudflare's sentinels, not
 *     countries. They become null rather than a two-letter code a UI would try to
 *     render as a flag.
 *   - `region` is the NAME (`Stockholm County`), not `regionCode`; codes are
 *     per-country schemes and a person reads the name.
 *   - Every field is a string or absent on `cf`, and absent on a request that did not
 *     come through the edge (`wrangler dev`, the vitest pool) — so each is read
 *     defensively and missing means null, never a throw.
 *   - Latitude, longitude and postal code are NOT carried. They locate a person to a
 *     street, and nothing a support desk does needs more than the city.
 *
 * `IncomingRequestCfProperties` is typed loosely (`unknown`) at the seam on purpose:
 * the workers-types shape has changed between majors, and a structural read that
 * tolerates a missing field survives that where a typed one would not compile.
 */
import { clientContextOf, EMPTY_GEO, type ClientContext, type ClientGeo } from '@substrat-run/contracts';

/** What a Worker's `Request` carries beyond the standard: the edge's own facts. */
export interface CloudflareRequestLike {
  readonly headers: { get(name: string): string | null };
  readonly cf?: unknown;
}

const NOT_A_COUNTRY = new Set(['T1', 'XX']);

function str(cf: Record<string, unknown>, key: string): string | null {
  const v = cf[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * The geo half of `request.cf`, in the platform's shape.
 *
 * Takes the `cf` object rather than the request so a caller holding the object some
 * other way (a queued job that stashed it, a test) can use it too.
 */
export function cloudflareGeo(cf: unknown): ClientGeo {
  if (!cf || typeof cf !== 'object') return EMPTY_GEO;
  const o = cf as Record<string, unknown>;
  const country = str(o, 'country');
  const continent = str(o, 'continent');
  return {
    country: country && /^[A-Z]{2}$/.test(country) && !NOT_A_COUNTRY.has(country) ? country : null,
    region: str(o, 'region'),
    city: str(o, 'city'),
    timezone: str(o, 'timezone'),
    continent: continent && /^[A-Z]{2}$/.test(continent) ? continent : null,
  };
}

/** The whole `ClientContext` for a request that came through Cloudflare's edge. */
export function cloudflareClientContext(request: CloudflareRequestLike): ClientContext {
  return clientContextOf(request.headers, cloudflareGeo(request.cf));
}
