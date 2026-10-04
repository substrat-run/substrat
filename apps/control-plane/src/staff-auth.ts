import type { StaffSessionReader } from '@substrat-run/control-plane-api';
import {
  emailRefusalMessage,
  identifyEmail,
  sessionFromHeaders,
  verifySession,
  type EmailIdentityEnv,
  type OidcEnv,
  type SessionUser,
} from '@substrat-run/oidc-rp';

/**
 * The staff readers' environment: the OIDC relying party's, plus the one break-glass.
 *
 * The roster's key is the session's email, so it counts only when the issuer asserted
 * `email_verified: true` about it (#1359) — by default, with nothing configured.
 * `OIDC_ALLOW_UNVERIFIED_EMAIL` is the deployment-wide opt-out, and `identifyEmail` is
 * what makes it loud while it is on.
 */
export interface StaffAuthEnv extends OidcEnv, EmailIdentityEnv {}

/**
 * The address a session proves, or null — the one place both readers decide it. Fails
 * closed: `false` and an absent claim both resolve to no staff identity, because the
 * roster keys on the address and an unverified one is someone else's key.
 */
function staffIdentityOf(env: StaffAuthEnv, user: SessionUser | null): { email: string } | null {
  if (!user) return null;
  const { email } = identifyEmail(env, user);
  return email ? { email } : null;
}

/** The session a request presents — the `sb_session` cookie, else a CLI bearer. */
async function presentedSession(env: StaffAuthEnv, headers: Headers): Promise<SessionUser | null> {
  const cookie = await sessionFromHeaders(env, headers);
  if (cookie) return cookie;
  const header = headers.get('authorization') ?? '';
  const token = /^bearer /i.test(header) ? header.slice(7).trim() : undefined;
  return await verifySession(env, token);
}

/**
 * Why a request that DID present a valid session was not taken as staff, as the sentence
 * to show — or null when it presented none, or one whose address passes. The 401 the API
 * answers with says only `unauthenticated`; a person holding a perfectly good session that
 * predates the claim (#1373) would read that as "signed out" with no idea why, so the
 * worker swaps the body for this. Only the two refusals a person can act on are named:
 * an address the roster would never key on anyway (`no-email`) stays a plain 401.
 */
export async function staffRefusalOf(env: StaffAuthEnv, headers: Headers): Promise<string | null> {
  // With the break-glass on, the reader already admitted the address: the 401 is about
  // something else (the roster), and asking again would log a second admission.
  if (env.OIDC_ALLOW_UNVERIFIED_EMAIL === 'true') return null;
  const user = await presentedSession(env, headers);
  if (!user) return null;
  const { refused } = identifyEmail(env, user);
  return refused === 'unverified' || refused === 'unasserted' ? emailRefusalMessage(refused) : null;
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
