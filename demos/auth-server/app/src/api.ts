import { createAuthClient } from 'better-auth/client';
import { adminClient } from 'better-auth/client/plugins';

/**
 * The Better Auth browser client, pointed at THIS issuer (same origin, `/api/auth`). The
 * dashboard is the issuer's own first relying party: it signs in here and the `adminClient`
 * gives it the typed admin surface (list/create/ban/role/remove) — all gated server-side by
 * the `admin` role, so a non-admin session can call nothing.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient()],
});

export interface Session {
  sub: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  emailVerified?: boolean;
  createdAt?: string | Date;
}

/**
 * What the SPA needs before anyone is signed in: whether the issuer still has to be
 * bootstrapped, and whether self-service sign-up is open. One unauthenticated read, because
 * all three pre-auth screens (setup, sign-in, sign-up) have to be reachable without a session.
 */
export interface IssuerState {
  needsSetup: boolean;
  signupEnabled: boolean;
  /** The upstream buttons to draw. Id and label only — see the DO's `issuerState`. */
  providers: PublicProvider[];
}

/** An upstream provider as the SIGNED-OUT screen may know it. */
export interface PublicProvider {
  id: string;
  label: string;
}

export async function setupState(): Promise<IssuerState> {
  const res = await fetch('/api/setup-state');
  return res.json();
}

/** Create the first administrator (only possible while there are no users). */
export async function createFirstAdmin(body: { email: string; password: string; name: string }): Promise<void> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'setup failed');
}

/** The current session (subject + role), or null. */
export async function currentSession(): Promise<Session | null> {
  const res = await fetch('/api/session');
  return res.json();
}

/**
 * The pending authorize request, as `oauthProvider` hands it to `/login`, `/signup` and
 * `/consent`: the ENTIRE original query, signed. This replaced the old plugin's
 * `oidc_login_prompt` cookie, and the difference is the whole contract — the server no longer
 * remembers the request on its own, so a page that does not send this back resumes NOTHING.
 * Sign-in succeeds, a session appears, and the relying party is never told: #898's failure
 * with a new mechanism.
 */
export function pendingOAuthQuery(url: URL): string | null {
  const query = url.search.replace(/^\?/, '');
  // `sig` is the plugin's signature over the rest; its presence is what distinguishes an
  // authorize hand-off from someone who simply typed /login.
  return query && url.searchParams.has('sig') ? query : null;
}

/**
 * Sign in — and report whether an OIDC authorize request was RESUMED by doing so.
 *
 * `oauth_query` is the pending request, verified server-side against its signature and
 * stashed; the plugin's after-hook then sees the new session cookie, re-runs `authorize`, and
 * answers THIS request with `{ redirect: true, url }` instead of a session. The browser
 * client's default `redirectPlugin` navigates there on its own, so there is nothing for us to
 * do but stay out of the way: `resumed` exists so the caller does not also re-render the
 * dashboard over a page that is already leaving.
 */
export async function signIn(email: string, password: string, oauthQuery?: string | null): Promise<{ resumed: boolean }> {
  const { data, error } = await authClient.signIn.email({
    email,
    password,
    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
  } as Parameters<typeof authClient.signIn.email>[0]);
  if (error) throw new Error(error.message ?? 'sign-in failed');
  const resume = data as unknown as { redirect?: boolean; url?: string } | null;
  return { resumed: Boolean(resume?.redirect && resume.url) };
}

/**
 * Create an account. Refused by the issuer unless an administrator has turned sign-up on —
 * the hidden screen is the courtesy, `disableSignUp` is the gate.
 *
 * Resumes a pending authorize request exactly as `signIn` does: `autoSignIn` sets a session,
 * and the plugin's after-hook fires on ANY response that carries a new session cookie, not
 * just sign-in. So someone sent here by a relying party can create an account and land back at
 * that app's callback, instead of stranded on a dashboard they cannot use.
 */
export async function signUp(
  input: { name: string; email: string; password: string },
  oauthQuery?: string | null,
): Promise<{ resumed: boolean }> {
  const { data, error } = await authClient.signUp.email({
    ...input,
    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
  } as Parameters<typeof authClient.signUp.email>[0]);
  if (error) throw new Error(error.message ?? 'sign-up failed');
  const resume = data as unknown as { redirect?: boolean; url?: string } | null;
  return { resumed: Boolean(resume?.redirect && resume.url) };
}

export async function signOut(): Promise<void> {
  await authClient.signOut();
}

/** Request a password-reset email (sent through the email adapter). */
export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
  if (error) throw new Error(error.message ?? 'could not send reset email');
}

export async function listUsers(): Promise<AdminUser[]> {
  const { data, error } = await authClient.admin.listUsers({ query: { limit: 200 } });
  if (error) throw new Error(error.message ?? 'could not list users');
  return (data?.users ?? []) as AdminUser[];
}

export async function createUser(body: { email: string; password: string; name: string; role: 'admin' | 'user' }): Promise<void> {
  const { error } = await authClient.admin.createUser(body);
  if (error) throw new Error(error.message ?? 'could not create user');
}

export async function setRole(userId: string, role: 'admin' | 'user'): Promise<void> {
  const { error } = await authClient.admin.setRole({ userId, role });
  if (error) throw new Error(error.message ?? 'could not set role');
}

export async function banUser(userId: string): Promise<void> {
  const { error } = await authClient.admin.banUser({ userId });
  if (error) throw new Error(error.message ?? 'could not ban user');
}

export async function unbanUser(userId: string): Promise<void> {
  const { error } = await authClient.admin.unbanUser({ userId });
  if (error) throw new Error(error.message ?? 'could not unban user');
}

export async function removeUser(userId: string): Promise<void> {
  const { error } = await authClient.admin.removeUser({ userId });
  if (error) throw new Error(error.message ?? 'could not remove user');
}

/* ---- one person: what the user-detail screen at /users/:id reads and does ---- */

/**
 * One user, read through the list with an equality filter rather than by fetching all 200 and
 * finding the id in the browser. The filter is what makes a pasted `/users/<id>` link honest:
 * a deep link has to answer for a person past whatever page the list happens to show, and
 * "not on the first page" must not render as "no such person".
 *
 * `null` means the id matched nobody — the screen's 404, not an error.
 */
export async function getUser(userId: string): Promise<AdminUser | null> {
  const { data, error } = await authClient.admin.listUsers({
    query: { limit: 1, filterField: 'id', filterOperator: 'eq', filterValue: userId },
  });
  if (error) throw new Error(error.message ?? 'could not read that user');
  return ((data?.users ?? []) as AdminUser[])[0] ?? null;
}

/**
 * How this person can sign in. Served by the issuer's own admin API, not Better Auth's:
 * `listAccounts` answers only for the session making the call, so an administrator looking at
 * somebody else had no read at all (#1278). The password hash and the stored upstream tokens
 * stay on the server — see the endpoint in `src/admin-api.ts`.
 */
export async function adminSignInMethods(userId: string): Promise<AdminSignInMethod[]> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/sign-in-methods`);
  if (!res.ok) throw new Error(await adminError(res, 'could not read their sign-in methods'));
  return ((await res.json()) as { methods: AdminSignInMethod[] }).methods;
}

/** One row of `account`, minus everything that is a credential. */
export interface AdminSignInMethod {
  id: string;
  /** `credential` for a password; otherwise the provider id, e.g. `google` or `bankid`. */
  provider: string;
  /** The subject the upstream knows them by — what tells two Google accounts apart. */
  accountId: string;
  issuer: string | null;
  createdAt: string | null;
}

/** A live session of this person, as the admin plugin reports it. */
export interface AdminSession {
  id: string;
  token: string;
  createdAt?: string | Date;
  expiresAt?: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function listUserSessions(userId: string): Promise<AdminSession[]> {
  const { data, error } = await authClient.admin.listUserSessions({ userId });
  if (error) throw new Error(error.message ?? 'could not read their sessions');
  return (data?.sessions ?? []) as AdminSession[];
}

/**
 * Revoke ONE session — keyed by its token, which is what the plugin deletes on. That token is
 * the credential itself, so it is never rendered; it rides from the list read to this call and
 * no further.
 */
export async function revokeUserSession(sessionToken: string): Promise<void> {
  const { error } = await authClient.admin.revokeUserSession({ sessionToken });
  if (error) throw new Error(error.message ?? 'could not revoke that session');
}

export async function revokeUserSessions(userId: string): Promise<void> {
  const { error } = await authClient.admin.revokeUserSessions({ userId });
  if (error) throw new Error(error.message ?? 'could not revoke their sessions');
}

/**
 * Ban with the two things a ban needs to be reviewable later: why, and until when. The list
 * screen's bare `banUser` left both null, so the person's own error message said nothing and
 * no operator could tell a mistake from a decision.
 *
 * `days` is optional and its absence is the permanent ban — the plugin reads seconds, so the
 * conversion lives here rather than in the screen.
 *
 * The contract is enforced HERE rather than in the form, because a helper that quietly dropped
 * an empty reason would recreate the bare unreviewable ban this call exists to replace — and
 * the next caller would recreate it again. A blank reason and a zero, negative or fractional
 * expiry are refused before the request is made.
 */
export async function banUserWithReason(userId: string, reason: string, days?: number): Promise<void> {
  const why = reason.trim();
  if (!why) {
    throw new Error('A ban needs a reason: it is what this person is told at sign-in, and what makes the ban reviewable later.');
  }
  if (days !== undefined && !(Number.isInteger(days) && days > 0)) {
    throw new Error('An expiry is a whole number of days greater than zero — leave it empty for a ban with no end date.');
  }
  const { error } = await authClient.admin.banUser({
    userId,
    banReason: why,
    ...(days === undefined ? {} : { banExpiresIn: days * 24 * 60 * 60 }),
  });
  if (error) throw new Error(error.message ?? 'could not ban that user');
}

export async function setUserPassword(userId: string, newPassword: string): Promise<void> {
  const { error } = await authClient.admin.setUserPassword({ userId, newPassword });
  if (error) throw new Error(error.message ?? 'could not set their password');
}

/**
 * Mark the address verified, and it is not cosmetic. Better Auth refuses to attach an upstream
 * provider to an existing account at sign-in unless the local row is verified, and an account
 * an administrator created here never is — so without this lever the only symptom is a person
 * who cannot sign in with Google and an operator with nothing to do about it.
 */
export async function markEmailVerified(userId: string): Promise<void> {
  const { error } = await authClient.admin.updateUser({ userId, data: { emailVerified: true } });
  if (error) throw new Error(error.message ?? 'could not mark the address verified');
}

/** The issuer's own admin API answers `{ error }`; a proxy or a crash does not. */
async function adminError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback} (${res.status})`;
}

/* ---- the OIDC consent screen ---- */

/**
 * An authorize request waiting on an answer, as `/consent?…` carries it. The signed query IS
 * the request — there is no server-side consent code any more — and `client_id` / `scope` are
 * read out of it for display. `test/oidc-flow.test.ts` pins the parameter names, because they
 * are the library's choice rather than ours.
 */
export interface ConsentRequest {
  oauthQuery: string;
  clientId: string;
  scopes: string[];
}

/** The relying party as the issuer knows it — what the consent screen names. */
export interface OAuthClient {
  clientId: string;
  name: string;
  icon: string | null;
}

/** Read the pending consent request off the current URL, or null if there is none. */
export function pendingConsent(url: URL): ConsentRequest | null {
  const oauthQuery = pendingOAuthQuery(url);
  const clientId = url.searchParams.get('client_id');
  if (!oauthQuery || !clientId) return null;
  return {
    oauthQuery,
    clientId,
    scopes: (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean),
  };
}

/**
 * Who is asking. The pre-login endpoint answers with the publicly showable fields for a
 * client id inside a signed authorize request — so this works with OR without a session,
 * which is what lets the LOGIN screen name the application too, not just the consent screen.
 */
export async function oauthClient(clientId: string, oauthQuery: string | null): Promise<OAuthClient | null> {
  const res = await fetch('/api/auth/oauth2/public-client-prelogin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { client_id?: string; client_name?: string; logo_uri?: string };
  return { clientId: body.client_id ?? clientId, name: body.client_name ?? '', icon: body.logo_uri ?? null };
}

/**
 * Answer the consent request. Either way the issuer replies with the URI to send the browser
 * to — the RP's own callback, carrying an authorization code on accept and `access_denied` on
 * refuse. A denial is an answer the relying party receives, not a dead end.
 */
export async function answerConsent(input: { accept: boolean; oauthQuery: string }): Promise<string> {
  const res = await fetch('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept: input.accept, oauth_query: input.oauthQuery }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    // A same-origin `fetch` gets Better Auth's redirect envelope; a top-level navigation gets
    // a 302 and never reaches here. `redirect_uri` is the documented field name and is
    // accepted too, so this reads whichever the plugin sends.
    url?: string;
    redirect_uri?: string;
    error_description?: string;
    message?: string;
  };
  const target = body.url ?? body.redirect_uri;
  if (!res.ok || !target) {
    throw new Error(body.error_description ?? body.message ?? 'could not record your answer');
  }
  return target;
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  registration_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

/** The issuer's OIDC discovery document — shown in the dashboard so operators can wire RPs. */
export async function discovery(): Promise<Discovery | null> {
  const res = await fetch('/.well-known/openid-configuration');
  if (!res.ok) return null;
  return res.json();
}


/**
 * Sign in through an UPSTREAM provider — "continue with Microsoft".
 *
 * The pending authorize request rides along exactly as it does on the password path, and it
 * has to: this navigates away to Microsoft, and nothing on the far side remembers a relying
 * party was waiting. `oauthProvider` handles that case explicitly — its before-hook special-
 * cases `/sign-in/social` and puts the pending request into the OAuth STATE that survives the
 * round-trip, so the callback that sets the session also resumes the authorize. Drop
 * `oauth_query` here and sign-in works while the relying party is silently abandoned, which is
 * #898 wearing a different hat.
 *
 * There is nothing to await: the response is a redirect to the provider and the browser
 * client's `redirectPlugin` follows it. `errorCallbackURL` is what makes a refusal visible —
 * "account not linked" is a real outcome (see the trust toggle in the providers panel) and
 * without it the browser comes back to a blank sign-in screen with no reason given.
 *
 * `returnTo` is where the browser lands afterwards, and it is the ONLY thing carrying a
 * pasted console URL across this round trip: nothing else survives the navigation to the
 * provider and back. Callers pass `returnTarget(...)`, an allowlist of the console's own
 * paths — this value ends up in a redirect the issuer performs, so an arbitrary one would be
 * an open redirect with a trip through Google attached. The refusal comes back to the SAME
 * screen, so retrying after "connect it under Sign-in methods" still lands where it was going.
 */
export async function signInSocial(
  providerId: string,
  oauthQuery?: string | null,
  returnTo = '/',
): Promise<void> {
  const { error } = await authClient.signIn.social({
    provider: providerId,
    callbackURL: returnTo,
    errorCallbackURL: `${returnTo}?social_error=1`,
    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
  } as Parameters<typeof authClient.signIn.social>[0]);
  if (error) throw new Error(error.message ?? `could not start sign-in with ${providerId}`);
}

/**
 * Better Auth's refusal codes, as prose. The codes are the library's (`error=` on the
 * callback's error redirect), the words are ours, and both entry points below share them —
 * a sign-in refused at the door and a link refused from inside the account fail for the same
 * reasons and should say the same things.
 *
 * `account not linked` is the one anyone actually meets, and it has THREE fixes, in the order
 * they should be tried: the person connects the provider from their own account (no policy
 * change, and the account keeps its id), an administrator trusts the provider so the join
 * happens at sign-in, or the local address gets verified — Better Auth requires that of the
 * LOCAL row before an implicit join, whatever the provider is trusted with.
 */
const REFUSALS: Record<string, string> = {
  'account not linked':
    'That account already exists here, and this provider is not one of its sign-in methods yet. ' +
    'Sign in the way you did before and connect it under “Sign-in methods” — the account keeps ' +
    'its identity, so everything signed in through this issuer still knows you. An administrator ' +
    'can also make the join happen at sign-in by trusting the provider, which additionally ' +
    'requires the local account to have a verified email address.',
  email_does_not_match:
    'That provider account has a different email address from the one you are signed in as, so it ' +
    'was not connected. Sign in with the matching address, or connect an account that uses this one.',
  account_already_linked_to_different_user:
    'That provider account is already a sign-in method for someone else here. It can only belong ' +
    'to one account, so disconnect it there first.',
  unable_to_link_account:
    'The provider would not be accepted as a sign-in method for this account. It reported no ' +
    'verified email address, and it is not trusted here — an administrator can trust it in the ' +
    'Sign-in providers panel.',
};

/** One refusal code, translated; unknown codes keep the library's own words. */
function refusalText(url: URL, fallback: string): string {
  const code = url.searchParams.get('error') ?? '';
  // Codes arrive underscored (`account_not_linked`); the sign-in path spells that one with
  // spaces before it is url-ified, so both shapes are normalized to the keys above.
  // `Object.hasOwn` rather than a bare lookup: `code` is whatever the query string carried, so
  // `constructor` or `toString` would otherwise resolve up the prototype chain and hand back a
  // *function* as the refusal — which React renders by throwing, on the very screen that exists
  // to explain a refusal.
  const key = Object.hasOwn(REFUSALS, code) ? code : code.replace(/[_-]/g, ' ');
  const translated = Object.hasOwn(REFUSALS, key) ? REFUSALS[key] : undefined;
  if (translated) return translated;
  // `||`, not `??`: an absent `error` is read as `''` above, and a nullish fallback would
  // return that empty string — which renders as no message at all, leaving exactly the blank
  // screen these functions exist to prevent.
  return url.searchParams.get('error_description') || code || fallback;
}

/**
 * The reason a social sign-in came back refused, as Better Auth puts it on the error redirect.
 * Read on the SIGNED-OUT screen: `signInSocial` sends refusals to `/?social_error=1`.
 */
export function socialErrorFrom(url: URL): string | null {
  if (!url.searchParams.has('social_error') && !url.searchParams.has('error')) return null;
  return refusalText(url, 'sign-in was refused');
}

/**
 * The same, for a refused LINK — `connectProvider` sends those to `/account?link_error=1`, a
 * different marker on purpose: a signed-in person is bounced back into the console, where
 * nothing reads the sign-in screen's error and the failure would otherwise be silent. The
 * path matters as much as the marker: it has to be the screen that READS the marker, which
 * is the account screen, not wherever the console happens to open.
 */
export function linkErrorFrom(url: URL): string | null {
  if (!url.searchParams.has('link_error')) return null;
  return refusalText(url, 'the provider was not connected');
}

/* ---- the sign-in methods on your own account ---- */

/**
 * One way this account can be signed into: `credential` is a password, `bankid` a BankID,
 * anything else is an upstream provider's id. The `id` is the ACCOUNT row's rather than the
 * provider's — one person may hold two accounts with the same provider, and that id is what
 * disconnecting addresses.
 */
export interface SignInMethod {
  id: string;
  provider: string;
  createdAt: string | null;
}

/** Every sign-in method on the CURRENT session's account. */
export async function signInMethods(): Promise<SignInMethod[]> {
  const { data, error } = await authClient.listAccounts();
  if (error) throw new Error(error.message ?? 'could not read your sign-in methods');
  return (data ?? []).map((account) => ({
    id: account.id,
    provider: account.providerId,
    createdAt: account.createdAt ? new Date(account.createdAt).toISOString() : null,
  }));
}

/**
 * Add an upstream provider to the account that is ALREADY signed in — the answer to "that
 * account exists here but is not linked to this provider", and the one that needs no policy
 * change from an administrator.
 *
 * The difference from `signInSocial` is the whole feature. That one asks the issuer to decide
 * whether a stranger holding a verified address may become an existing account; this one
 * rides a session, so the OAuth state carries `link: { userId }` and the callback attaches the
 * upstream account to THAT user id. Nothing is created and nothing is merged: the account
 * keeps its id, so every relying party's `sub` keeps meaning the same person.
 *
 * Navigates away — the browser client's redirect plugin follows the `url` this answers — so
 * nothing after it runs on success. Refusals come back through `errorCallbackURL`, which is
 * why it is set: without it a refused link lands somewhere that says nothing happened.
 *
 * Both callbacks name `/account` rather than `/`. Now that the console routes, `/` is not a
 * screen — it is replaced with whichever section the viewer may see first, and that hop drops
 * the query string. Coming back to `/` would land an administrator on the user list with the
 * refusal silently gone, which is the exact failure `errorCallbackURL` exists to prevent.
 */
export async function connectProvider(providerId: string): Promise<void> {
  const { error } = await authClient.linkSocial({
    provider: providerId,
    callbackURL: '/account',
    errorCallbackURL: '/account?link_error=1',
  } as Parameters<typeof authClient.linkSocial>[0]);
  if (error) throw new Error(error.message ?? `could not start connecting ${providerId}`);
}

/**
 * Remove one sign-in method. Better Auth refuses the LAST one (an account nobody can sign
 * into is not a state to offer), and requires a recent session — an old one is asked to sign
 * in again rather than quietly failing.
 */
export async function disconnectProvider(accountId: string): Promise<void> {
  const { error } = await authClient.unlinkAccount({ accountId });
  if (error) throw new Error(error.message ?? 'could not disconnect that sign-in method');
}

/* ---- per-client theming ---- */

/**
 * The theme a relying party's operator stored in its client `metadata.theme` — the
 * vocabulary `src/branding.ts` defines and sanitizes (Clerk-shaped names, one CSS custom
 * property each; see `applyClientTheme` in App.tsx for the mapping). Every key optional;
 * an empty object is the unbranded default, and is also what an unknown or disabled
 * client id answers — deliberately indistinguishable, so this read is not a registry oracle.
 */
export interface ClientTheme {
  colorPrimary?: string;
  colorPrimaryForeground?: string;
  colorBackground?: string;
  colorPanel?: string;
  colorInput?: string;
  colorText?: string;
  colorMutedText?: string;
  borderRadius?: string;
  logoUrl?: string;
  title?: string;
}

/** The sanitized theme for a client id. Any failure is the default theme, never an error —
 *  a person mid-sign-in must reach the form whatever happened to the branding read. */
export async function clientBranding(clientId: string): Promise<ClientTheme> {
  try {
    const res = await fetch(`/api/branding?client_id=${encodeURIComponent(clientId)}`);
    if (!res.ok) return {};
    return ((await res.json()) as { theme?: ClientTheme }).theme ?? {};
  } catch {
    return {};
  }
}

/* ---- BankID sign-in ---- */

/**
 * BankID is not a redirect flow: the browser stays HERE while the person approves in the
 * BankID app, so these four calls are the whole conversation. `start` opens an order; the
 * QR endpoint serves a fresh frame each second (the code is computed server-side — the
 * secret behind it never reaches this page); `collect` polls every two seconds and, on
 * completion, IS the sign-in — the response sets the session cookie.
 *
 * A pending authorize request resumes exactly as the password path does: `oauth_query`
 * rides in the collect body, and the issuer answers the completing poll with the redirect
 * envelope instead of a status. The caller watches for it and navigates.
 */
export interface BankIdStart {
  orderRef: string;
  /** `bankid:///?autostarttoken=…` — same-device start, rendered as a link/button. */
  autoStartUrl: string;
  /** The first animated-QR frame (the raw `bankid.…` string, not an image). */
  qr: string;
}

export type BankIdCollectResult =
  | { status: 'pending' | 'failed' | 'complete'; hintCode: string | null }
  | { redirect: boolean; url: string };

export async function bankidStart(): Promise<BankIdStart> {
  return authApi('/bankid/start', { method: 'POST', body: JSON.stringify({}) });
}

export async function bankidQr(orderRef: string): Promise<string> {
  return (await authApi<{ qr: string }>('/bankid/qr', { method: 'POST', body: JSON.stringify({ orderRef }) })).qr;
}

export async function bankidCollect(orderRef: string, oauthQuery?: string | null): Promise<BankIdCollectResult> {
  return authApi('/bankid/collect', {
    method: 'POST',
    body: JSON.stringify({ orderRef, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }),
  });
}

export async function bankidCancel(orderRef: string): Promise<void> {
  await authApi('/bankid/cancel', { method: 'POST', body: JSON.stringify({ orderRef }) }).catch(() => undefined);
}

/* ---- the relying-party registry ---- */

/**
 * Two servers answer this panel, and the split is deliberate.
 *
 * Everything that CHANGES a client is `oauthProvider`'s own endpoint under `/api/auth/*`,
 * gated by the `clientPrivileges` hook (administrators only). The hand-written registry that
 * used to sit behind `/api/admin/clients` is gone with the 1.6 plugin that made it necessary.
 *
 * The LIST is still ours, because the library's `/oauth2/get-clients` answers "the clients
 * YOU created" — filtered by the caller's user id. An issuer's registry also holds clients
 * another admin registered and clients that registered themselves with no user at all, and an
 * operator who cannot see those cannot withdraw them. Both paths return the same RFC 7591
 * field names, so this file has one client shape.
 */
async function authApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(body.error_description ?? body.message ?? body.error ?? `request failed (${res.status})`);
  }
  return body as T;
}

async function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as T;
}

/** `web` keeps a secret on a server; `native` is a public client (PKCE, no usable secret). */
export type ApplicationType = 'web' | 'native';
export const APPLICATION_TYPES: ApplicationType[] = ['web', 'native'];

/**
 * A registered relying party, in the plugin's RFC 7591 wire shape. The secret is never here
 * and cannot be: `storeClientSecret` defaults to `hashed`, so the stored value is not the
 * credential. `client_secret_set` is the only honest thing to say about an existing one.
 */
export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
  redirect_uris: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
  application_type?: string;
  disabled?: boolean;
  skip_consent?: boolean;
  user_id?: string;
  client_id_issued_at?: number;
  metadata?: Record<string, unknown>;
  client_secret_set?: boolean;
}

/** The editable half of a client — what the new/edit form collects. */
export interface ClientDraft {
  client_name: string;
  application_type: ApplicationType;
  redirect_uris: string[];
  logo_uri?: string;
  metadata?: Record<string, unknown>;
  skip_consent: boolean;
  disabled: boolean;
}

/** Every registered client — ours, because the library's list is per-owner (see above). */
export async function listOAuthClients(): Promise<RegisteredClient[]> {
  return (await admin<{ clients: RegisteredClient[] }>('/clients')).clients;
}

/**
 * Register a relying party. The secret comes back here and nowhere else, ever again — it is
 * stored hashed, so no endpoint can return it later.
 */
export async function createOAuthClient(
  draft: ClientDraft,
): Promise<{ client: RegisteredClient; clientSecret: string }> {
  // Through our worker, which calls the plugin's `SERVER_ONLY` admin endpoint: it mints the
  // id, mints and hashes the secret, and validates the redirect URIs — and it is the only
  // variant that can set `skip_consent`, which is exactly why a browser cannot reach it.
  const created = await admin<RegisteredClient & { client_secret?: string }>('/clients', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
  return { client: created, clientSecret: created.client_secret ?? '' };
}

/**
 * Edit a client — OURS, not the plugin's. Every client-mutating endpoint it exposes requires
 * the caller to be the client's registrant, so an operator cannot rename or disable an
 * application someone else registered, and `disabled` is not in its update body at all.
 */
export async function updateOAuthClient(clientId: string, update: Partial<ClientDraft>): Promise<RegisteredClient> {
  return admin(`/clients/${encodeURIComponent(clientId)}`, { method: 'PATCH', body: JSON.stringify(update) });
}

export async function rotateOAuthClientSecret(
  clientId: string,
): Promise<{ client: RegisteredClient; clientSecret: string }> {
  const rotated = await authApi<RegisteredClient & { client_secret?: string }>('/oauth2/client/rotate-secret', {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId }),
  });
  return { client: rotated, clientSecret: rotated.client_secret ?? '' };
}

/** Un-register a client. Its tokens and consents reference it, so the schema cascades them. */
export async function deleteOAuthClient(clientId: string): Promise<void> {
  await admin(`/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
}

/* ---- the issuer's own settings (`/api/admin`) ---- */

/**
 * What an upstream sign-in does when its email address already belongs to an account here.
 * `link` joins them (on Better Auth's terms: the address vouched for upstream or the provider
 * trusted, AND the local address verified); `block` never joins implicitly. There is no
 * "separate accounts" value — Better Auth resolves an email to exactly one user.
 */
export type AccountLinkingMode = 'link' | 'block';

export interface IssuerSettings {
  allowSignup: boolean;
  accountLinking: AccountLinkingMode;
}

export async function issuerSettings(): Promise<IssuerSettings> {
  return admin('/settings');
}

/** A partial patch: only the settings named are written, so one control cannot revert another. */
export async function setIssuerSettings(patch: Partial<IssuerSettings>): Promise<IssuerSettings> {
  return admin('/settings', { method: 'PATCH', body: JSON.stringify(patch) });
}

/* ---- the upstream identity providers (`/api/admin`) ---- */

/** A provider the issuer knows how to be a relying party of. Served with the configured rows. */
export interface ProviderCatalogueEntry {
  id: string;
  label: string;
  tenantField?: { label: string; placeholder: string; hint: string };
  /**
   * Set ⇔ this entry is a NAMED GENERIC provider (Supabase): the catalogue names it and its
   * button, and the operator supplies the issuer URL this field describes. Absent, the entry
   * is one Better Auth ships built-in and takes no issuer at all.
   */
  issuerField?: { label: string; placeholder: string; hint: string };
  console: string;
}

/** One configured upstream. The secret is never sent back — only whether there is one. */
export interface ConfiguredProvider {
  id: string;
  clientId: string;
  clientSecretSet: boolean;
  tenantId: string | null;
  /** Set ⇔ a custom (generic OIDC) provider: the upstream's issuer URL. */
  issuer: string | null;
  /** The custom provider's display name — what its sign-in button says. */
  label: string | null;
  allowSignup: boolean;
  trustEmail: boolean;
  disabled: boolean;
  /** The redirect URI to register upstream, so the panel never makes anyone guess it. */
  callbackPath: string;
  updatedAt: number | null;
}

/** The editable half — `clientSecret` omitted on an edit means "keep the stored one". */
export interface ProviderDraft {
  clientId: string;
  clientSecret?: string;
  tenantId?: string | null;
  /** Custom providers only: required there, refused on a catalogue id. */
  issuer?: string | null;
  label?: string | null;
  allowSignup: boolean;
  trustEmail: boolean;
  disabled: boolean;
}

export async function identityProviders(): Promise<{
  catalogue: ProviderCatalogueEntry[];
  providers: ConfiguredProvider[];
}> {
  return admin('/providers');
}

export async function saveIdentityProvider(id: string, draft: ProviderDraft): Promise<ConfiguredProvider> {
  return admin(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(draft) });
}

export async function removeIdentityProvider(id: string): Promise<void> {
  await admin(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* ---- BankID configuration (`/api/admin`) ---- */

/** The stored BankID configuration, as the panel may know it — certificates in, never out. */
export interface BankIdSettings {
  environment: 'test' | 'production';
  certSet: boolean;
  caSet: boolean;
  allowSignup: boolean;
  disabled: boolean;
  updatedAt: number;
}

/** The editable half. Cert/key omitted on an edit means "keep the stored ones";
 *  `caCert: null` clears a trust-anchor override back to the embedded BankID root. */
export interface BankIdDraft {
  environment: 'test' | 'production';
  clientCert?: string;
  clientKey?: string;
  caCert?: string | null;
  allowSignup: boolean;
  disabled: boolean;
}

export async function bankidSettings(): Promise<BankIdSettings | null> {
  return (await admin<{ bankid: BankIdSettings | null }>('/bankid')).bankid;
}

export async function saveBankidSettings(draft: BankIdDraft): Promise<BankIdSettings> {
  return admin('/bankid', { method: 'PUT', body: JSON.stringify(draft) });
}

export async function removeBankid(): Promise<void> {
  await admin('/bankid', { method: 'DELETE' });
}
