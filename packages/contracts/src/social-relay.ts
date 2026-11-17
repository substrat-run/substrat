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
 * does the platform rotate and deliver again. Rotating on every delivery instead would let two
 * overlapping reconciles deliver secrets out of order and leave the older one in place.
 */
export const SOCIAL_RELAY_CONFIG_KEY = 'substrat:social-relay';

/**
 * The verticals the reconciler registers at the relay. Exact slugs, never a pattern: a
 * registration spends the platform's upstream client, so only the platform's own issuer
 * gets one — a builder's vertical that happens to be named the same lives under
 * `<tenant>/<name>` and is not matched.
 */
export const SOCIAL_RELAY_VERTICALS: readonly string[] = ['auth-server'];

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

/** What an issuer answers (409, as the `error`) when a delivery carries no secret and it holds none. */
export const SOCIAL_RELAY_SECRET_NEEDED = 'social_relay_secret_needed';

/** The delivered value of `substrat:social-relay`. */
export const socialRelayDelivery = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500).optional(),
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
