/**
 * How long the signed authorize query a sign-in rides on stays usable, judged without the
 * device's clock. Pure, so a node test can load it.
 *
 * The query carries `exp` (seconds) and `ba_iat` (the issue time in MILLISECONDS), both stamped
 * by the issuer's clock (`signParams` in @better-auth/oauth-provider). Comparing `exp` with
 * `Date.now()` would trust the device: one running half an hour fast would see every fresh
 * sign-in as expired, and "Start again" could not recover it. Their difference is the window
 * the issuer granted, which no clock skew changes, so the deadline is that window measured from
 * when this page loaded, on the device's own clock.
 *
 * The server stays the authority — it refuses the send and the verify alike — and this is only
 * a hint that lets the screen say so before someone types a number. It errs late (bar the
 * second `exp` is floored to): the time between issue and page load is not subtracted, and a
 * reload restarts the window, so
 * a refusal from the server (`isExpiredSignIn`) also switches the screen to "Start again".
 */
export function signInDeadline(oauthQuery: string | null, loadedAt: number): number | null {
  if (!oauthQuery) return null;
  const params = new URLSearchParams(oauthQuery);
  const exp = Number(params.get('exp'));
  const issuedAt = Number(params.get('ba_iat'));
  if (!(exp > 0 && issuedAt > 0 && Number.isFinite(exp) && Number.isFinite(issuedAt))) return null;
  return loadedAt + (exp * 1000 - issuedAt);
}

/** The error the issuer answers for a signed query it no longer accepts — expired or not its own. */
export const isExpiredSignIn = (message: string) => message === 'invalid_signature';

/** The authorize request the signed query came from, without the signature material, so
 *  starting again yields a fresh login page instead of one that is already dead. */
export function restartUrl(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);
  for (const key of ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']) params.delete(key);
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}
