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

/** Is the issuer awaiting its first administrator? */
export async function setupState(): Promise<{ needsSetup: boolean }> {
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
 * Sign in — and report whether an OIDC authorize request was RESUMED by doing so.
 *
 * When a relying party sent the visitor here, Better Auth stashed the authorize request in
 * the signed `oidc_login_prompt` cookie. Its after-hook notices the new session, re-runs
 * `authorize`, and answers THIS request with `{ redirect: true, url }` instead of a session.
 * The client's default `redirectPlugin` navigates there on its own, so there is nothing for
 * us to do but stay out of the way: `resumed` exists so the caller does not also re-render
 * the dashboard over a page that is already leaving.
 */
export async function signIn(email: string, password: string): Promise<{ resumed: boolean }> {
  const { data, error } = await authClient.signIn.email({ email, password });
  if (error) throw new Error(error.message ?? 'sign-in failed');
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

/* ---- the OIDC consent screen ---- */

/**
 * An authorize request waiting on an answer, as `/consent?…` carries it. Better Auth puts
 * these three in the query when it redirects to `consentPage`; `test/untrusted-client.test.ts`
 * pins the names, because they are the library's choice rather than ours.
 */
export interface ConsentRequest {
  consentCode: string;
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
  const consentCode = url.searchParams.get('consent_code');
  const clientId = url.searchParams.get('client_id');
  if (!consentCode || !clientId) return null;
  return {
    consentCode,
    clientId,
    scopes: (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean),
  };
}

/** Who is asking. Session-gated by the issuer, so a stranger cannot enumerate the registry. */
export async function oauthClient(clientId: string): Promise<OAuthClient | null> {
  const res = await fetch(`/api/auth/oauth2/client/${encodeURIComponent(clientId)}`);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Answer the consent request. Either way the issuer replies with the URI to send the browser
 * to — the RP's own callback, carrying an authorization code on accept and `access_denied` on
 * refuse. A denial is an answer the relying party receives, not a dead end.
 */
export async function answerConsent(input: { accept: boolean; consentCode: string }): Promise<string> {
  const res = await fetch('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept: input.accept, consent_code: input.consentCode }),
  });
  const body = (await res.json().catch(() => ({}))) as { redirectURI?: string; error_description?: string; message?: string };
  if (!res.ok || !body.redirectURI) {
    throw new Error(body.error_description ?? body.message ?? 'could not record your answer');
  }
  return body.redirectURI;
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
