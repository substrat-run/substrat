/**
 * A login's PLACES as this screen reads them (#1670) — where the signed-in account holds a
 * principal, across every app that signs in at this issuer, and the link into each.
 *
 * No React and no `fetch` in here, for the reason `wire.ts` and `console/paths.ts` give: the
 * issuer's own vitest can import it and pin it. The one thing worth pinning is the link. Its
 * hostname comes from the platform's registration and is validated by the issuer before it is
 * answered, and it is checked again here, because it becomes an `href` on the one page a person
 * trusts to be the issuer's own: nothing but a bare hostname may reach it, so no answer can turn
 * a list row into a `javascript:` URL or a link to a path the issuer never named.
 */

/** One entry, exactly as the issuer answers it: enough to deep-link, nothing more. */
export interface Place {
  tenantId: string;
  scopeId: string;
  hostname: string;
  name: string;
}

/** The same bare-hostname rule the issuer holds a registration to: labels, an optional port. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

function isPlace(value: unknown): value is Place {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tenantId === 'string' &&
    typeof v.scopeId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.hostname === 'string' &&
    HOSTNAME.test(v.hostname)
  );
}

/** `{ places: [...] }`, the answer `/api/account/places` gives a signed-in account. */
export function isPlacesAnswer(value: unknown): value is { places: unknown[] } {
  return !!value && typeof value === 'object' && Array.isArray((value as { places?: unknown }).places);
}

/** The entries of an answer that are places, and none that are not. */
export function placesOf(answer: { places: unknown[] }): Place[] {
  return answer.places.filter(isPlace);
}

/**
 * The link into a place: `https://<hostname>/`, or `http:` for a loopback development host.
 * Null for anything that is not a bare hostname, so a row with a bad one renders as text.
 */
export function placeHref(place: Pick<Place, 'hostname'>): string | null {
  if (!HOSTNAME.test(place.hostname)) return null;
  const host = place.hostname.replace(/:\d+$/, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
  return `${loopback ? 'http' : 'https'}://${place.hostname}/`;
}
