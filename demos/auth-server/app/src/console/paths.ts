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

/** And for `/providers/<provider id>` and Sign-in providers. */
export const PROVIDERS_PATH = '/providers';

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
 * The provider id in `/providers/<provider id>`, or null. The same two duties again, and the
 * NARROWEST alphabet of the three because the server's is narrow: a provider id is either a
 * catalogue slug (`google`, `microsoft`, `github`, `supabase`) or one an operator named for a
 * generic OIDC upstream, and `src/providers.ts`'s `GENERIC_ID_PATTERN` accepts only lowercase
 * letters, digits and interior hyphens up to 40 characters — because the id becomes the
 * callback path segment an upstream has registered. Restated here rather than imported: this
 * file is browser code and that one is the issuer's server half, so the two are kept apart on
 * purpose. Restating it can only ever be too strict, never too loose, and too strict shows up
 * as a "no such provider" screen rather than as a redirect that leaves the issuer.
 */
export function providerDetailId(pathname: string): string | null {
  const match = /^\/providers\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/.exec(pathname);
  return match?.[1] ?? null;
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
  const providerId = providerDetailId(pathname);
  if (providerId) return `${PROVIDERS_PATH}/${providerId}`;
  return null;
}
