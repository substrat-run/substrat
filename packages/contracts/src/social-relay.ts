import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * PLATFORM-PROVIDED social sign-in for a team Auth Server (#1544).
 *
 * The platform's social relay (`apps/social-relay`, id.substrat.net) holds one OAuth client per
 * upstream — Google, GitHub, Apple — and serves one OpenID issuer per provider in front of them.
 * Each Auth Server install gets its OWN client at the relay, registered by the platform, never by
 * the install: the redirect URIs are built from hostnames the platform issued or bound.
 *
 * This module is the vocabulary the control plane's reconciler and the Auth Server share. The
 * reconciler delivers one entry through the issuer's platform-gated `/internal/configure`:
 *
 *     substrat:social-relay  =  { "clientId": "…", "clientSecret": "…",
 *                                 "providers": [{ "id": "github", "label": "GitHub",
 *                                                 "issuer": "https://id.substrat.net/github",
 *                                                 "endpoints": { … } }, …] }
 *
 * The value is the WHOLE set of providers the relay serves, not a delta, so re-sending it is a
 * no-op and a provider that drops out is switched off. `demos/auth-server/src/social-relay.ts`
 * turns it into provider rows, each named `relayProviderId(id)`, created switched off.
 *
 * `clientSecret` is present only when the platform has one to give — when the relay client was
 * just created, or its secret just rotated. The relay stores secrets hashed and cannot hand an
 * existing one back, so an ordinary re-delivery carries none and the issuer keeps the one it
 * holds. An issuer that holds none answers `SOCIAL_RELAY_SECRET_NEEDED` (409), and only then
 * does the platform rotate and deliver again.
 *
 * Every delivery also carries `generation`, the relay's count of the client's secrets (#3275): 1
 * for the secret handed out at creation, one more for each rotation. The relay accepts only the
 * newest, so the generation says which secret is live without anyone reading one back:
 *
 *   - with a secret, it is that secret's generation, and an issuer holding a NEWER one refuses the
 *     delivery (`SOCIAL_RELAY_DELIVERY_STALE`) — a slow delivery from a run that rotated earlier
 *     can never overwrite the secret a later rotation delivered;
 *   - without one, it is the relay's current generation, and an issuer holding an OLDER one knows
 *     its secret is dead and says so (`SOCIAL_RELAY_SECRET_STALE`), which the platform answers
 *     with one rotation — the stuck install heals on its next reconcile.
 *
 * Rotation and its delivery are serialized per client at the relay itself: a rotation is a
 * compare-and-set on the generation the caller saw, and it takes a short lease that refuses any
 * other rotation of that client until the delivery is made (`packages/control-plane-api`,
 * `reconcileSocialRelay`). So two reconciles can never both rotate, and the generation is the
 * guard that holds even if that serialization is ever bypassed.
 */
export const SOCIAL_RELAY_CONFIG_KEY = 'substrat:social-relay';

/**
 * The verticals the reconciler registers at the relay. Exact slugs, never a pattern: a
 * registration spends the platform's upstream client, so only the platform's own issuer
 * gets one — a builder's vertical that happens to be named the same lives under
 * `<tenant>/<name>` and is not matched.
 *
 * Both of the platform's lineages: the bare `auth-server` it was first registered under, and
 * `substrat-9yjbbn/auth-server`, the platform workspace's own lineage that the bare platform
 * verticals were retired onto (#389, `manyfold` → `substrat-9yjbbn/manyfold`). An install of
 * the standard Auth Server is bound to the second, and with the bare slug alone every relay
 * path — hostname trigger, staff pass, the install's own call — refused it as "not an Auth
 * Server install". Only the platform workspace can push under its prefix: a builder's prefix
 * is fixed by its own authentication.
 */
export const SOCIAL_RELAY_VERTICALS: readonly string[] = ['auth-server', 'substrat-9yjbbn/auth-server'];

/**
 * The provider id an install holds a relay provider under. Suffixed, because the bare ids
 * (`github`, `google`, `apple`) are Better Auth's built-in providers, which an install may
 * also configure with its own credential.
 */
export function relayProviderId(upstream: string): string {
  return `${upstream}-relay`;
}

/** The path an Auth Server answers a provider's callback on (`callbackPath` in the issuer). */
export function relayCallbackPath(upstream: string): string {
  return `/api/auth/callback/${relayProviderId(upstream)}`;
}

/** The discovery endpoints the issuer stores on a generic row; the relay states them. */
export const socialRelayEndpoints = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
});
export type SocialRelayEndpoints = z.infer<typeof socialRelayEndpoints>;

/** One provider the relay serves, as `GET /providers` lists it and the delivery carries it. */
export const socialRelayProvider = z.object({
  id: z.string().regex(/^[a-z0-9]{1,32}$/),
  label: z.string().min(1).max(100),
  issuer: z.string().url(),
  endpoints: socialRelayEndpoints,
});
export type SocialRelayProvider = z.infer<typeof socialRelayProvider>;

export const socialRelayProviders = z.object({ providers: z.array(socialRelayProvider).max(32) });

/**
 * What an issuer answers (409, as the `detail`) when a delivery carries no secret and it holds none
 * it can vouch for: none for this client, or one held from before generations were delivered,
 * which may or may not be the live one. A reconcile the install itself asked for never rotates on
 * this answer when the install says it holds a client.
 */
export const SOCIAL_RELAY_SECRET_NEEDED = 'social_relay_secret_needed';

/**
 * What an issuer answers (409) when a delivery carries no secret and the relay's generation is
 * newer than the secret it holds: that secret was rotated out and cannot work. Rotating replaces
 * nothing that signs anyone in, so every reconcile rotates on it, the install's own included.
 */
export const SOCIAL_RELAY_SECRET_STALE = 'social_relay_secret_stale';

/**
 * What an issuer answers (409) when a delivery carries a secret OLDER than the one it holds — a
 * run that rotated, then delivered after a later rotation's secret had landed. Nothing is written.
 */
export const SOCIAL_RELAY_DELIVERY_STALE = 'social_relay_delivery_stale';

/** The delivered value of `substrat:social-relay`. */
export const socialRelayDelivery = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500).optional(),
  /**
   * The secret's generation when `clientSecret` is present, else the relay's current one (#3275).
   * Optional only for a delivery from a control plane or relay older than generations, which the
   * issuer handles as it always did.
   */
  generation: z.number().int().positive().optional(),
  providers: z.array(socialRelayProvider).max(32),
});
export type SocialRelayDelivery = z.infer<typeof socialRelayDelivery>;

/**
 * Where an Auth Server install asks the control plane to reconcile ITS OWN relay client (#1544):
 * the self-heal for an install whose install-time reconcile failed, that predates the relay, or
 * that was registered before the relay gained a provider. Gated like every relay the control
 * plane serves (the platform credential, and the caller the egress worker proves), and held to
 * the caller's own scope there.
 *
 * `hasClient` is what the install says about itself: that it holds a relay client already. It
 * can only NARROW what the call may do — with it the platform never rotates the client's secret,
 * and without it a rotation still happens only when the install's own delivery answers
 * `SOCIAL_RELAY_SECRET_NEEDED`, which an install holding a working secret never does.
 */
export const SOCIAL_RELAY_SELF_PATH = '/internal/social-relay/self';

export const socialRelaySelfRequest = z.object({
  tenantId,
  scopeId,
  hasClient: z.boolean(),
});
export type SocialRelaySelfRequest = z.infer<typeof socialRelaySelfRequest>;

/**
 * What the self call answers on a 200: the reconcile's outcome. `delivered` names the providers
 * delivered; `skipped` says why nothing was (no hostname yet, no provider, or a rotation only a
 * platform operator may make). Read loosely by the install, which shows it to its operator.
 */
export const socialRelaySelfOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('delivered'), providers: z.array(z.string()), rotated: z.boolean() }).passthrough(),
  z.object({ status: z.literal('skipped'), reason: z.string() }).passthrough(),
]);
export type SocialRelaySelfOutcome = z.infer<typeof socialRelaySelfOutcome>;
