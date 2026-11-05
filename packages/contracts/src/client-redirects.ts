import { z } from 'zod';
import { oidcCallbackUrl } from './preview-client.js';

/**
 * Which hostnames an app's OIDC client at a team auth-server answers on (#2904).
 *
 * An app's relying party builds its callback and its post-logout target from the Host it
 * was reached on, and an issuer matches both exactly against what the client registered.
 * Install registers the default hostname only, so a surface hostname or a custom domain
 * bound later met a refused `redirect_uri` at sign-in and a refused
 * `post_logout_redirect_uri` at sign-out. The dashboard knows both halves (the app's active
 * bindings and the client it registered), so it tells the issuer:
 *
 *     substrat:redirects:<app scope id>  =  {"clientId":"…","hostnames":["desk.example",…]}
 *
 * through the issuer's ordinary platform-gated `/internal/configure`. The value is the app's
 * WHOLE set of active hostnames, so a repeat is a no-op and a hostname that went away drops
 * out; `""` is the un-registration (an app deleted, or moved to another issuer). A delivery
 * names hostnames only: the issuer derives every URI from them with the functions below, so
 * no delivery can register an arbitrary redirect. The issuer's half is
 * `demos/auth-server/src/client-redirects.ts`.
 */
export const CLIENT_REDIRECTS_CONFIG_PREFIX = 'substrat:redirects:';

/** More hostnames than any app binds; a bound on what one delivery writes. */
export const MAX_CLIENT_REDIRECT_HOSTNAMES = 32;

/** A bare hostname: lowercase labels, no scheme, no port (every hosted binding is https on 443). */
const redirectHostname = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/, 'a bare hostname');

/** One app's delivery, when it has a client there. */
export const clientRedirects = z
  .object({
    /** The client the platform registered for the app at this issuer. */
    clientId: z.string().min(1).max(256),
    /** Every hostname the app actively answers on. */
    hostnames: z.array(redirectHostname).min(1).max(MAX_CLIENT_REDIRECT_HOSTNAMES),
  })
  .strict();

export type ClientRedirects = z.infer<typeof clientRedirects>;

/**
 * Where a relying party sends the browser back after the issuer's logout. oidc-rp's
 * `federatedLogout` sends the app's root when the person returns to it and `LOGGED_OUT_PATH`
 * otherwise, so both are registered.
 */
export const OIDC_POST_LOGOUT_PATHS = ['/', '/api/auth/logged-out'] as const;

/** The post-logout targets a relying party at `hostname` registers, exact-match. */
export function oidcPostLogoutUrls(hostname: string): string[] {
  return OIDC_POST_LOGOUT_PATHS.map((path) => `https://${hostname}${path}`);
}

/** Every URI a set of hostnames registers, as the issuer stores them. */
export function clientRedirectUris(hostnames: readonly string[]): { redirectUris: string[]; postLogoutRedirectUris: string[] } {
  return {
    redirectUris: hostnames.map(oidcCallbackUrl),
    postLogoutRedirectUris: hostnames.flatMap(oidcPostLogoutUrls),
  };
}
