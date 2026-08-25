import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';

/**
 * The round-trip an ordinary relying party takes, over `@better-auth/oauth-provider`.
 *
 * What this pins is THE CONTRACT THE SPA IMPLEMENTS, and the 1.7 migration changed every
 * clause of it. `app/src/App.tsx` renders `/login`, `/signup` and `/consent` because the
 * plugin sends people there, and `app/src/api.ts` reads and returns what the plugin puts in
 * those URLs. Those are library facts, not our choices:
 *
 *   - The pending request is no longer a server-side cookie the plugin remembers. It is the
 *     WHOLE signed query on the redirect, and the page must hand it back as `oauth_query`.
 *     A sign-in that omits it succeeds and resumes NOTHING — the relying party is never told,
 *     which is exactly #898's symptom with a new mechanism, and is why the omission is
 *     asserted here rather than assumed impossible.
 *   - Consent takes `{ accept, oauth_query }` and answers `{ redirect_uri }` — not
 *     `consent_code` and `redirectURI`.
 *   - The authorization-code redirect now also carries `iss` (RFC 9207).
 *   - **PKCE is mandatory.** OAuth 2.1, and the plugin enforces it for every client rather
 *     than only for public ones: an authorize request without `code_challenge` is refused at
 *     the callback with `invalid_request`. Every relying party pointed at this issuer needs
 *     it, which is the one change here an existing integration cannot ignore.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const RP_REDIRECT = 'http://localhost:9999/cb';

let auth: Auth;
let sqlite: Database.Database;

function call(path: string, init?: RequestInit): Promise<Response> {
  return auth.handler(new Request(`${ORIGIN}${path}`, init) as never);
}

/** The `name=value` pairs off a response's Set-Cookie headers, as a request `cookie` header. */
function cookiesFrom(...responses: Response[]): string {
  return responses
    .flatMap((res) => res.headers.getSetCookie())
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/** A top-level browser navigation (the plugin answers these with a 302). */
const NAVIGATE = { 'sec-fetch-mode': 'navigate' } as const;
/** What the SPA's `authClient` sends: an ordinary same-origin `fetch`. */
const FROM_FETCH = { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' } as const;

beforeAll(async () => {
  sqlite = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) sqlite.exec(stmt);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(sqlite, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    // Seeding this suite's admin goes through `signUpEmail`, which is the bootstrap path —
    // the issuer itself defaults to sign-up closed (see `test/signup.test.ts`).
    allowSignup: true,
  });
  const created = await auth.api.signUpEmail({ body: ADMIN });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
});

/** Register a relying party through the dynamic-registration endpoint — no admin, no seed. */
async function registerClient(name: string): Promise<{ clientId: string; clientSecret: string }> {
  const res = await call('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: name, application_type: 'native' }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { client_id: string; client_secret: string };
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** base64url, the encoding PKCE's `code_challenge` is transmitted in. */
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** One PKCE pair. Web Crypto — the same API the worker runtime has. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

function authorizeUrl(
  clientId: string,
  state: string,
  challenge: string,
  extra: Record<string, string> = {},
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RP_REDIRECT,
    scope: 'openid profile',
    state,
    // OAuth 2.1: the plugin refuses an authorize request without these.
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });
  return `/api/auth/oauth2/authorize?${q.toString()}`;
}

async function signInAs(who: { email: string; password: string }): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

/** The signed query the plugin parks on `/login` or `/consent` — the request itself. */
function oauthQueryOf(location: string): string {
  return new URL(`http://x${location}`).search.replace(/^\?/, '');
}

describe('a self-registering relying party completes the round-trip', () => {
  it('registers itself without an admin', async () => {
    const { clientId, clientSecret } = await registerClient('Probe RP');
    expect(clientId).toBeTruthy();
    expect(clientSecret).toBeTruthy();
  });

  it('sends a signed-out visitor to /login carrying the whole signed request', async () => {
    const { clientId } = await registerClient('Signed-out RP');
    const res = await call(authorizeUrl(clientId, 'st-login', (await pkce()).challenge), { headers: NAVIGATE });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    // The path the SPA must render. `loginPage: '/login'` in src/auth.ts is one half of this
    // agreement; App.tsx's `/login` branch is the other.
    expect(location.startsWith('/login?')).toBe(true);
    // And the request rides in the QUERY, signed. There is no cookie holding it any more:
    // `pendingOAuthQuery` in the SPA reads exactly this, and `sig` is how it knows an
    // authorize hand-off from someone who typed the URL.
    const params = new URL(`http://x${location}`).searchParams;
    expect(params.get('client_id')).toBe(clientId);
    expect(params.get('sig')).toBeTruthy();
    expect(params.get('scope')).toBe('openid profile');
  });

  it('resumes the authorize request when sign-in hands the query back', async () => {
    const { clientId } = await registerClient('Resuming RP');
    const authorize = await call(authorizeUrl(clientId, 'st-resume', (await pkce()).challenge), { headers: NAVIGATE });
    const oauthQuery = oauthQueryOf(authorize.headers.get('location') ?? '');

    // Sign in exactly as the SPA does: a same-origin `fetch` carrying `oauth_query`.
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: FROM_FETCH,
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, oauth_query: oauthQuery }),
    });
    expect(signIn.status).toBe(200);

    // The plugin's after-hook re-runs `authorize` and answers the SIGN-IN request with where
    // to go next. The browser client's default `redirectPlugin` navigates on exactly this
    // shape, which is why the SPA needs no resume code of its own.
    const body = (await signIn.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expect(body.url?.startsWith('/consent?')).toBe(true);
  });

  it('resumes NOTHING when sign-in omits the query — the failure the SPA must not have', async () => {
    const { clientId } = await registerClient('Forgetful RP');
    await call(authorizeUrl(clientId, 'st-forgot', (await pkce()).challenge), { headers: NAVIGATE });

    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: FROM_FETCH,
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(signIn.status).toBe(200);
    const body = (await signIn.json()) as { redirect?: boolean; url?: string };
    // A session, and silence: the relying party is never told. This is what threading
    // `oauth_query` through `signIn`/`signUp` in `app/src/api.ts` exists to prevent, and the
    // reason it cannot be dropped as "the server remembers anyway" — it does not.
    expect(body.redirect).toBeFalsy();
  });

  it('sends a signed-in visitor to /consent with the client and scopes to display', async () => {
    const { clientId } = await registerClient('Consenting RP');
    const cookie = await signInAs(ADMIN);
    const res = await call(authorizeUrl(clientId, 'st-consent', (await pkce()).challenge), { headers: { ...NAVIGATE, cookie } });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('/consent?')).toBe(true);
    // What the consent screen is built from. App.tsx reads these by exactly these names.
    const params = new URL(`http://x${location}`).searchParams;
    expect(params.get('client_id')).toBe(clientId);
    expect(params.get('scope')).toBe('openid profile');
    expect(params.get('sig')).toBeTruthy();
  });

  it('names the client for the consent screen — and for the LOGIN screen, before any session', async () => {
    const { clientId } = await registerClient('Nameable RP');
    const authorize = await call(authorizeUrl(clientId, 'st-name', (await pkce()).challenge), { headers: NAVIGATE });
    const oauthQuery = oauthQueryOf(authorize.headers.get('location') ?? '');

    // No cookie at all: this is the signed-out login screen asking who is asking. The old
    // plugin's client read was session-gated, so the login page could only say "an
    // application"; `public-client-prelogin` is what makes naming it possible.
    const res = await call('/api/auth/oauth2/public-client-prelogin', {
      method: 'POST',
      headers: FROM_FETCH,
      body: JSON.stringify({ client_id: clientId, oauth_query: oauthQuery }),
    });
    expect(res.ok).toBe(true);
    const client = (await res.json()) as { client_id: string; client_name: string };
    expect(client.client_id).toBe(clientId);
    expect(client.client_name).toBe('Nameable RP');
  });

  it('approving consent returns the RP callback with a usable code', async () => {
    const { clientId, clientSecret } = await registerClient('Approving RP');
    const cookie = await signInAs(ADMIN);
    const { verifier, challenge } = await pkce();
    const authorize = await call(authorizeUrl(clientId, 'st-approve', challenge), { headers: { ...NAVIGATE, cookie } });
    const oauthQuery = oauthQueryOf(authorize.headers.get('location') ?? '');

    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { ...FROM_FETCH, cookie },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    });
    expect(consent.status).toBe(200);
    // A same-origin `fetch` (what the SPA sends) gets Better Auth's redirect envelope rather
    // than a 302 — `{ redirect, url }`, not the old `{ redirectURI }`. `answerConsent` reads
    // exactly this, and a navigation would have been answered with a 302 instead.
    const { url: redirectUri } = (await consent.json()) as { redirect: boolean; url: string };

    const back = new URL(redirectUri);
    expect(`${back.origin}${back.pathname}`).toBe(RP_REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-approve');
    // RFC 9207: the issuer identifies itself on the callback so an RP cannot be confused
    // about which authorization server answered. New in this plugin.
    // The CLEAN origin — the identity every relying party is configured with, kept across
    // the migration by pinning the jwt plugin's issuer (see `src/auth.ts`).
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    const code = back.searchParams.get('code');
    expect(code).toBeTruthy();

    // And the code redeems. This is the assertion that makes the whole path real rather than
    // a plausible-looking chain of redirects: the RP gets a signed id_token for the user.
    const token = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // `client_secret_basic` is what a dynamically registered client gets by default now,
        // and the plugin REFUSES the secret in the form body for such a client
        // ("cannot use client_secret_post"). The old plugin accepted either. A relying party
        // that posts its secret in the body must be registered with
        // `token_endpoint_auth_method: 'client_secret_post'` — which is what `seedDemoClient`
        // sets, and what an integration carried over from 1.6 will need.
        authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: RP_REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { id_token?: string; access_token?: string };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();
    // A three-part JWS signed by the JWKS key — not an opaque string.
    expect((tokens.id_token ?? '').split('.')).toHaveLength(3);
  });

  it('denying consent returns the RP callback with access_denied', async () => {
    const { clientId } = await registerClient('Denying RP');
    const cookie = await signInAs(ADMIN);
    const authorize = await call(authorizeUrl(clientId, 'st-deny', (await pkce()).challenge), { headers: { ...NAVIGATE, cookie } });
    const oauthQuery = oauthQueryOf(authorize.headers.get('location') ?? '');

    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { ...FROM_FETCH, cookie },
      body: JSON.stringify({ accept: false, oauth_query: oauthQuery }),
    });
    expect(consent.status).toBe(200);
    const { url: redirectUri } = (await consent.json()) as { redirect: boolean; url: string };

    // Deny is an ANSWER, not a dead end — the RP is told, at its own callback.
    expect(redirectUri.startsWith(RP_REDIRECT)).toBe(true);
    expect(new URL(redirectUri).searchParams.get('error')).toBe('access_denied');
  });

  it('refuses a consent answer whose query was tampered with', async () => {
    const { clientId } = await registerClient('Tampering RP');
    const cookie = await signInAs(ADMIN);
    const authorize = await call(authorizeUrl(clientId, 'st-tamper', (await pkce()).challenge), { headers: { ...NAVIGATE, cookie } });
    const oauthQuery = oauthQueryOf(authorize.headers.get('location') ?? '');

    // The request now travels through the browser instead of a server-side cookie, so its
    // signature is the only thing standing between a user and rewriting their own
    // authorization — a widened scope, someone else's redirect_uri.
    const tampered = oauthQuery.replace('scope=openid+profile', 'scope=openid+profile+offline_access');
    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { ...FROM_FETCH, cookie },
      body: JSON.stringify({ accept: true, oauth_query: tampered }),
    });
    expect(consent.status).toBeGreaterThanOrEqual(400);
  });
});

describe('prompt=none answers without any UI', () => {
  it('answers login_required at the callback when signed out', async () => {
    const { clientId } = await registerClient('Silent RP');
    const res = await call(authorizeUrl(clientId, 'st-none', (await pkce()).challenge, { prompt: 'none' }), { headers: NAVIGATE });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(RP_REDIRECT)).toBe(true);
    expect(new URL(location).searchParams.get('error')).toBe('login_required');
  });
});
