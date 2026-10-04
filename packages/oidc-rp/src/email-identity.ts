import type { SessionUser } from './index.js';

/**
 * Whether a session's address may be used as WHO someone is (#1359).
 *
 * An address is an identifier wherever something is keyed on it — the control plane's
 * staff roster, the builder studio's staff check, a dashboard invite addressed to it, the
 * support desk's signed visitor identity. Any issuer account can CARRY any address; only
 * the issuer's `email_verified: true` says the person behind the session controls it. So
 * every one of those places asks this one function, and the default answer is: only a
 * verified address identifies anyone.
 *
 * It fails closed on all three non-`true` states, and tells them apart because each one
 * asks the person for something different:
 *
 *  - `unverified` — the issuer said `false`. Verify the address with the sign-in provider.
 *  - `unasserted` — the session carries no claim at all. Every session minted before the
 *    claim was carried (#1373) reads this way for the rest of its life (seven days), as
 *    does one from an issuer that never emits it. Signing in again is the fix for the
 *    first; the platform issuer emits the claim on every login.
 *  - `no-email` — nothing to identify by.
 *
 * Authentication itself is not gated here: a session with an unverified address is still
 * a valid sign-in, it just may not be someone BY ADDRESS.
 */
export type EmailIdentity =
  | { email: string; refused?: undefined }
  | { email: null; refused: EmailRefusal };

export type EmailRefusal = 'no-email' | 'unverified' | 'unasserted';

/**
 * `OIDC_ALLOW_UNVERIFIED_EMAIL` — the break-glass, and the only way to turn the rule off.
 * `"true"` exactly (the spelling `ALLOW_DEV_ACTOR` reads) admits an address the issuer did
 * not verify. It is an environment value on purpose — never a request parameter, a roster
 * column or a tenant setting — so it is one deployment-wide decision an operator made, and
 * it is loud while it is on: a warning when an isolate first reads it, and another for
 * every address it lets through.
 */
export interface EmailIdentityEnv {
  OIDC_ALLOW_UNVERIFIED_EMAIL?: string;
}

/** The variable's name, for the messages that tell an operator what is switched on. */
const ALLOW_UNVERIFIED_EMAIL = 'OIDC_ALLOW_UNVERIFIED_EMAIL';

/** One warning per isolate that the opt-out is on — the closest a worker has to startup. */
let announced = false;

/**
 * Why a session's address does not identify anyone, or null when it does — the rule alone,
 * with no break-glass and no logging, for a caller that only needs to explain a refusal.
 */
export function emailRefusalOf(user: Pick<SessionUser, 'email' | 'emailVerified'>): EmailRefusal | null {
  if (!user.email) return 'no-email';
  if (user.emailVerified === true) return null;
  return user.emailVerified === false ? 'unverified' : 'unasserted';
}

export function identifyEmail(
  env: EmailIdentityEnv,
  user: Pick<SessionUser, 'id' | 'email' | 'emailVerified'>,
): EmailIdentity {
  const refused = emailRefusalOf(user);
  if (!user.email) return { email: null, refused: 'no-email' };
  if (refused === null) return { email: user.email };
  if (env.OIDC_ALLOW_UNVERIFIED_EMAIL !== 'true') return { email: null, refused };
  if (!announced) {
    announced = true;
    console.warn(
      `[email-verified] ${ALLOW_UNVERIFIED_EMAIL}=true: an address the issuer did not verify is accepted as an identifier on this deployment (#1359)`,
    );
  }
  // The subject, never the address: this line is about the decision, and logs are not
  // where an unverified address should be collected.
  console.warn(`[email-verified] admitted an ${refused} address by ${ALLOW_UNVERIFIED_EMAIL} (sub ${user.id})`);
  return { email: user.email };
}

/** The sentence a person is shown for each refusal — what to do, not what went wrong. */
export function emailRefusalMessage(refused: EmailRefusal): string {
  switch (refused) {
    case 'unasserted':
      return 'your session was signed in before email verification was checked — sign in again';
    case 'unverified':
      return 'your email address is not verified — verify it with your sign-in provider, then sign in again';
    case 'no-email':
      return 'your sign-in carries no email address';
  }
}
