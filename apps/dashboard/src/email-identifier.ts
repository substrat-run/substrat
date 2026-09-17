import type { SessionUser } from '@substrat-run/oidc-rp';

/**
 * The dashboard's one opt-in for trusting an address as an identifier (#1359) — the same
 * variable, spelling and fork the control plane's staff roster reads
 * (`apps/control-plane/src/staff-auth.ts`).
 *
 * `OIDC_REQUIRE_EMAIL_VERIFIED` — `"true"` makes the session's email count as WHO someone
 * is only when the issuer asserted `email_verified: true` about it. Off unless set to
 * exactly `"true"`. It is a per-issuer fact rather than a default because an issuer that
 * never emits the claim is indistinguishable from one that says "unverified", and turning
 * the gate on against it refuses every invite acceptance on the platform.
 */
export interface EmailIdentifierEnv {
  OIDC_REQUIRE_EMAIL_VERIFIED?: string;
}

/**
 * Whether the gate refuses this session's address as an identifier. With the gate on it
 * fails closed: `false` and an absent claim are both refused. Off, nothing is refused, so
 * every call site keeps exactly the behaviour it had before the gate existed.
 *
 * Only where an address BECOMES an identity — accepting an invite, seeding a roster owner,
 * signing a support-desk identity. Authentication itself stays ungated: a session with an
 * unverified address is still a valid sign-in, it just may not be someone by address.
 */
export function emailRefusedAsIdentifier(
  env: EmailIdentifierEnv,
  user: Pick<SessionUser, 'emailVerified'>,
): boolean {
  return env.OIDC_REQUIRE_EMAIL_VERIFIED === 'true' && user.emailVerified !== true;
}
