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

export interface IssuerSettings {
  allowSignup: boolean;
}

export async function issuerSettings(): Promise<IssuerSettings> {
  return admin('/settings');
}

export async function setIssuerSettings(patch: IssuerSettings): Promise<IssuerSettings> {
  return admin('/settings', { method: 'PATCH', body: JSON.stringify(patch) });
}
