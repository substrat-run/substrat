import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * A preview's OWN sign-in client at the team auth-server its parent signs in with (#1704).
 *
 * A preview forks a prod scope into a new scope, bound to the PR's version. That version is
 * its own dispatch script, and a Durable Object namespace belongs to its script, so the
 * fork's config store starts empty and nothing of the parent's delivered config reaches it
 * — not at create, and not after any later push, which binds yet another script. The
 * parent's `substrat:auth` holds a client secret, and the platform neither keeps a copy of
 * delivered config nor reads one back. So a preview is not handed the parent's client: it
 * gets a client of its own, minted at the same issuer, and delivered through the ordinary
 * `/internal/configure`. Prod's client is never touched and never learns a preview's
 * callback. Reaping the preview deletes its client.
 *
 * This module is the vocabulary between the two ends of that protocol: the control plane,
 * which decides when, and the team auth-server (`demos/auth-server`), which mints and
 * deletes. Three platform-gated routes on the issuer, each addressed by the issuer's OWN
 * scope and refused unless that scope is the named tenant's instance:
 *
 *   - `POST   /internal/preview-client/check` — does the parent sign in HERE? Read-only.
 *   - `POST   /internal/preview-client`       — mint the preview's client (re-checks first).
 *   - `DELETE /internal/preview-client`       — delete the preview's clients, and only those.
 *
 * ## "The parent signs in here" is a platform fact, not a URI match
 *
 * Dynamic client registration is open at a team auth-server, and a callback URL is public.
 * So "some client redirects to the parent's callback" proves nothing by itself: anybody can
 * register one. The issuer claims a parent only when it holds a binding for the parent
 * scope that ONLY the platform writes — a `place_app` row (#1670) or an `oauth_resource`
 * row marked for that scope (#1619), both delivered by the dashboard through the
 * platform-gated `/internal/configure` — AND an enabled client whose redirect URIs contain
 * one of the parent's callbacks. The control plane asks every auth-server of the tenant and
 * mints only where exactly one claims.
 *
 * ## Deletion is by tag, and by generation
 *
 * Every client minted here is recorded in the issuer's own `preview_client` table with the
 * preview scope it belongs to and a generation the issuer assigns (monotonic per issuer, so
 * the order is the issuer's own). A delete selects from that table and nothing else, so no
 * delete can reach a client the platform did not mint for that preview — prod's included.
 * A delete that keeps one client removes only the tagged clients OLDER than it, and says
 * whether a newer one exists (`superseded`) or the kept one is gone (`kept: false`).
 */

/** Where a vertical's OIDC relying party receives the issuer's redirect. */
export const OIDC_CALLBACK_PATH = '/api/auth/callback';

/** The callback a relying party at `hostname` registers — exact-match, as issuers compare it. */
export function oidcCallbackUrl(hostname: string): string {
  return `https://${hostname}${OIDC_CALLBACK_PATH}`;
}

/** The issuer-side path of all three verbs (the check hangs off it as `/check`). */
export const PREVIEW_CLIENT_PATH = '/internal/preview-client';

/** An absolute `https:` URL (`http:` on loopback, for a local issuer), no fragment. */
const redirectUri = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      return (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) && !u.hash && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'an absolute https URL with no fragment or credentials');

/** Every hostname the parent answers on, as the callback each would have registered. */
const parentRedirectUris = z.array(redirectUri).min(1).max(32);

/** The issuer the call addresses: its own scope, and the tenant that scope must belong to. */
const issuerAddress = {
  tenantId,
  scopeId,
};

/** `POST /internal/preview-client/check` — read-only: does the parent sign in here? */
export const previewClientCheck = z.object({
  ...issuerAddress,
  parentScopeId: scopeId,
  parentRedirectUris,
});
export type PreviewClientCheck = z.infer<typeof previewClientCheck>;

/** The check's answer. */
export const previewClientClaim = z.object({ claimed: z.boolean() });
export type PreviewClientClaim = z.infer<typeof previewClientClaim>;

/**
 * `POST /internal/preview-client` — mint the preview's client. The issuer re-runs the check
 * first and refuses (409) a parent it does not claim. The client it registers carries
 * EXACTLY `redirectUri` and `postLogoutRedirectUri`; either one equal to a parent callback
 * is refused, so a preview client can never stand in for prod's.
 */
export const previewClientMint = previewClientCheck.extend({
  previewScopeId: scopeId,
  redirectUri,
  postLogoutRedirectUri: redirectUri,
  clientName: z.string().trim().min(1).max(200),
});
export type PreviewClientMint = z.infer<typeof previewClientMint>;

/** What a mint answers — ONCE. The issuer stores the secret hashed, and nobody stores it here. */
export const mintedPreviewClient = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  generation: z.number().int().positive(),
});
export type MintedPreviewClient = z.infer<typeof mintedPreviewClient>;

/**
 * `DELETE /internal/preview-client` — delete a preview's clients. With neither option, every
 * client minted for the preview (the reap). With `keep`, the ones minted BEFORE it (a push
 * that has just delivered its own). With `only`, that one client if it is the preview's (a
 * mint whose delivery failed cleaning up after itself).
 */
export const previewClientRetire = z
  .object({
    ...issuerAddress,
    previewScopeId: scopeId,
    keep: z.string().min(1).optional(),
    only: z.string().min(1).optional(),
  })
  .refine((b) => !(b.keep && b.only), 'pass keep or only, not both');
export type PreviewClientRetire = z.infer<typeof previewClientRetire>;

/**
 * What a delete did. `kept` is null without `keep`; otherwise whether the kept client still
 * exists. `superseded` is true when a client NEWER than the kept one exists for the preview:
 * another push minted after this one, and it — not this one — owns what happens next.
 */
export const retiredPreviewClients = z.object({
  deleted: z.array(z.string()),
  kept: z.boolean().nullable(),
  superseded: z.boolean(),
});
export type RetiredPreviewClients = z.infer<typeof retiredPreviewClients>;

/**
 * What `preview create` reports about the preview's login — the `auth` field of its answer.
 * Never a secret: the client id and issuer, and the callback, are all the output carries.
 *
 *   - `wired` — a team auth-server claimed the parent; the preview has its own client there.
 *   - `unregistered` — no team auth-server claimed the parent: an external issuer, a builtin
 *     login, or a team install whose binding the dashboard has not delivered yet.
 *   - `ambiguous` — more than one claimed, so the platform chose none.
 *   - `unknown` — some auth-server could not be asked (it predates this, or did not answer),
 *     and none that could claimed the parent.
 *   - `superseded` — a newer push owns the preview; this push delivered nothing to it.
 *   - `not-applicable` — a clean-room preview has no parent to sign in like.
 */
export const previewAuthStatus = z.enum(['wired', 'unregistered', 'ambiguous', 'unknown', 'superseded', 'not-applicable']);
export type PreviewAuthStatus = z.infer<typeof previewAuthStatus>;

export const previewAuth = z.object({
  status: previewAuthStatus,
  /** The preview's callback — what an external issuer would need registered. */
  callbackUrl: z.string().nullable(),
  /** `wired` only. */
  issuer: z.string().optional(),
  issuerScopeId: scopeId.optional(),
  clientId: z.string().optional(),
  /** `ambiguous` / `unknown`: the auth-servers involved, and for `unknown` what went wrong. */
  issuers: z.array(z.object({ issuerScopeId: scopeId, problem: z.string().optional() })).optional(),
  /** One or more lines, written for the person reading `preview create`'s output. */
  note: z.string(),
});
export type PreviewAuth = z.infer<typeof previewAuth>;
