import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * A login's PLACES — where it holds a principal, across every app that signs in at one
 * identity pool (#1670).
 *
 * K-22 makes a login a different principal in every scope, and each tenant's directory can
 * say who a `sub` is *there*. Nothing could say where *else*. The answer lives with the
 * pool, not with any vertical: the issuer that mints the `sub` keeps an index keyed on it
 * (K-23, K-25), and shows it only to the login it belongs to, on the issuer's own origin.
 * Verticals never read it. Three parties write to it, and this module is the vocabulary
 * they share:
 *
 *   - **The platform** says which apps are places at all. The dashboard delivers, per team,
 *     the whole set of its apps that sign in at this issuer, each with the client id it
 *     registered there, the hostname it answers on and its name. A vertical never names a
 *     tenant, a hostname or a display name; those are the platform's facts.
 *   - **A vertical** says only "this `sub` is, or is no longer, bound in my scope",
 *     authenticated as the client the platform registered for it. The issuer keeps an
 *     addition only when it has itself issued to that client for that `sub`.
 *   - **The issuer** answers the signed-in login with its own entries, each exactly a
 *     `place`, and nothing about any other login or tenant.
 */

/**
 * The delivered-config key through which the platform tells a team auth-server which of a
 * team's apps sign in there: `${PLACES_CONFIG_PREFIX}<tenant id>`, whose value is that
 * team's WHOLE set as a JSON array of `placeRegistration`, or `""` for none. Keyed by team
 * rather than by app so that an app the team deleted, or moved to another issuer, drops out
 * of the next delivery by itself; one team's delivery never touches another team's rows.
 */
export const PLACES_CONFIG_PREFIX = 'substrat:places:';

/** A hostname as a deep link names it: lowercase labels, an optional port, no scheme. */
const placeHostname = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/, 'a bare hostname');

/** A display name: one line of plain text, bounded. */
const placeName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'no control characters');

/** One app, as the platform registers it at the issuer it signs in with. */
export const placeRegistration = z
  .object({
    /** The app's own scope, which is also the scope its entries name. */
    appScopeId: scopeId,
    /** The OIDC client the platform registered for this app at this issuer. */
    clientId: z.string().min(1).max(256),
    /** Where the app answers — the deep link. */
    hostname: placeHostname,
    /** What the app is called, as the team named it. */
    name: placeName,
  })
  .strict();

export type PlaceRegistration = z.infer<typeof placeRegistration>;

/** More apps than any team signs in at one issuer; a bound on what one delivery writes. */
export const MAX_PLACE_REGISTRATIONS = 500;

export const placeRegistrations = z.array(placeRegistration).max(MAX_PLACE_REGISTRATIONS);

/**
 * ONE ENTRY of a login's places, and the whole of what the account surface says about it:
 * enough to deep-link, nothing more about the tenant (#1670's Decision). The issuer
 * projects to exactly these keys and a test pins the set.
 */
export const place = z
  .object({
    tenantId,
    scopeId,
    hostname: placeHostname,
    name: placeName,
  })
  .strict();

export type Place = z.infer<typeof place>;

/**
 * Where an issuer says it keeps a places index: `${issuer}${PLACES_DISCOVERY_PATH}`. A
 * vertical reports only to an issuer that answers it, so an external issuer (Supabase,
 * Auth0, …) never receives a report: its pool is not one the platform keeps an index for.
 */
export const PLACES_DISCOVERY_PATH = '/.well-known/substrat-places';

export const placesDiscovery = z.object({ report_endpoint: z.string().url() });

/**
 * The most subjects one whole-set report may carry. A scope with more is refused and
 * logged rather than half-reported: a partial replace would REMOVE every entry it left out.
 */
export const MAX_PLACE_MEMBERS = 10_000;

const subject = z.string().min(1).max(256);

const reportAuth = {
  /** The client the platform registered for this app at the issuer, and its secret. */
  client_id: z.string().min(1).max(256),
  client_secret: z.string().min(1).max(512),
  /** The scope the report is about. It must be the app scope the platform registered. */
  scope_id: scopeId,
};

/**
 * What a vertical tells the issuer. `present` / `absent` follow one binding as it changes;
 * `replace` is the repair, the WHOLE set of subjects bound in the scope, which drops every
 * entry it does not name and so heals a lost `absent` as well as a lost `present`.
 */
export const placeReport = z.discriminatedUnion('op', [
  z.object({ ...reportAuth, op: z.literal('present'), sub: subject }).strict(),
  z.object({ ...reportAuth, op: z.literal('absent'), sub: subject }).strict(),
  z.object({ ...reportAuth, op: z.literal('replace'), subs: z.array(subject).max(MAX_PLACE_MEMBERS) }).strict(),
]);

export type PlaceReport = z.infer<typeof placeReport>;
