import type { StaffSessionReader } from '@substrat-run/control-plane-api';
import {
  sessionFromHeaders,
  verifySession,
  type OidcEnv,
  type SessionUser,
} from '@substrat-run/oidc-rp';

/**
 * The staff readers' environment: the OIDC relying party's, plus one opt-in.
 *
 * `OIDC_REQUIRE_EMAIL_VERIFIED` (#1359) — `"true"` makes the roster's key, the session's
 * email, count only when the issuer asserted `email_verified: true` about it. Off unless
 * set to exactly `"true"`, the same spelling `ALLOW_DEV_ACTOR` reads. It is a per-issuer
 * fact rather than a default because an issuer that never emits the claim is
 * indistinguishable from one that says "unverified", and turning the gate on against it
 * locks the whole roster out of the control plane. Set it once the platform issuer is
 * known to send the claim.
 */
export interface StaffAuthEnv extends OidcEnv {
  OIDC_REQUIRE_EMAIL_VERIFIED?: string;
}

/**
 * The address a session proves, or null — the one place both readers decide it. With the
 * gate on it fails closed: `false` and an absent claim both resolve to no staff identity,
 * because the roster keys on the address and an unverified one is someone else's key.
 */
function staffIdentityOf(env: StaffAuthEnv, user: SessionUser | null): { email: string } | null {
  if (!user?.email) return null;
  if (env.OIDC_REQUIRE_EMAIL_VERIFIED === 'true' && user.emailVerified !== true) return null;
  return { email: user.email };
}

/**
 * The control plane's STAFF authentication on the edge: an OIDC session against the
 * platform's AuthHero instance, reduced to the provider-agnostic
 * `StaffSessionReader` the API expects. This is the seam the old Better Auth note
 * promised — "when this moves to AuthHero, only the session reader changes."
 *
 * Authentication only. Who counts as staff, and under which actor id, remains the
 * D1 staff roster (`staff-roster.ts`, #42) — this only proves the email. Anyone
 * AuthHero can authenticate gets a session cookie, but the roster refuses everyone
 * unlisted and `sessionPlatformAuth` fails closed, so the roster stays the one gate.
 *
 * workerd-safe (Web Crypto + jose, no `node:*`). Stateless: the session is the
 * signed cookie the OIDC relying party set — no auth database here anymore.
 */
export function oidcStaffSessionReader(env: StaffAuthEnv): StaffSessionReader {
  return async (headers) => staffIdentityOf(env, await sessionFromHeaders(env, headers));
}

/**
 * The same staff authentication, but for a NON-browser caller (the CLI): the session
 * token arrives as `Authorization: Bearer <token>` rather than the `sb_session` cookie.
 * It is the identical signed session `verifySession` accepts — the CLI obtained it
 * through the login broker (cli-auth.ts) — so this only changes where the token is read
 * from. The roster (`d1StaffRoster`) remains the single gate, exactly as for the cookie.
 */
export function oidcStaffBearerReader(env: StaffAuthEnv): StaffSessionReader {
  return async (headers) => {
    const header = headers.get('authorization') ?? '';
    const token = /^bearer /i.test(header) ? header.slice(7).trim() : undefined;
    return staffIdentityOf(env, await verifySession(env, token));
  };
}
