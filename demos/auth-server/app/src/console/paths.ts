/**
 * The console's dynamic paths, and nothing else.
 *
 * Split out of `routes.ts` — which is the same routing — for one reason: what is here has a
 * server-shaped duty and no React in it. `returnTarget` hands a path to an upstream provider as
 * `callbackURL` and reads it back out of a redirect, so the parsers below are the whole of what
 * stops "whatever was in the address bar" from riding through Google and back. Keeping them
 * free of `@substrat-run/ui` is what lets the issuer's own vitest — a `nodenext` program that
 * cannot compile a bundler-resolved TSX package — import and test them directly.
 */

/** The section a path belongs to, so `/users/<id>` keeps Users lit in the nav. */
export const USERS_PATH = '/users';

/** Likewise for `/applications/<client id>` and Applications. */
export const APPLICATIONS_PATH = '/applications';

/**
 * The id in `/users/<id>`, or null for anything else. Deliberately strict about the shape
 * rather than accepting any tail: this value is interpolated into an API path AND is an
 * open-redirect parameter by way of `returnTarget`, so "url-safe id characters only" is the
 * property both callers need. Better Auth mints 32-character ids from that alphabet.
 */
export function userDetailId(pathname: string): string | null {
  const match = /^\/users\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * The client id in `/applications/<client id>`, or null. Same two duties as `userDetailId` and
 * so the same shape rule, with a wider alphabet for a narrow reason: a client id is not always
 * minted from the same alphabet a user id is. This issuer's own console row is the literal
 * `console` (`src/console-client.ts`), a self-registering relying party may be given a UUID,
 * and both have to be a place. Dots and hyphens are added for those; the characters that would
 * make this a redirect rather than a path — `/`, `:`, `\`, `%` — still cannot appear, because
 * the pattern is anchored and names the alphabet rather than excluding one. Widening it to
 * dots costs one extra condition: an id of nothing but dots is `.` or `..`, which a browser
 * resolves away rather than visits, so it is not an id and is refused here.
 */
export function applicationDetailId(pathname: string): string | null {
  const match = /^\/applications\/([A-Za-z0-9_.-]{1,128})$/.exec(pathname);
  const id = match?.[1] ?? null;
  return id && /[A-Za-z0-9_-]/.test(id) ? id : null;
}

/**
 * The detail screen this path is, re-composed from the id it parsed — or null if it is not one.
 *
 * Re-built rather than returned as given, deliberately: what leaves here is a string this file
 * assembled from an id it just checked, not the one the address bar handed over, so there is no
 * tail of the input left to smuggle anything through.
 */
export function detailTarget(pathname: string): string | null {
  const userId = userDetailId(pathname);
  if (userId) return `${USERS_PATH}/${userId}`;
  const clientId = applicationDetailId(pathname);
  if (clientId) return `${APPLICATIONS_PATH}/${clientId}`;
  return null;
}
