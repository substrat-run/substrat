import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.js';
import { buildAuth, type Auth } from '../src/auth.js';

/**
 * The round-trip for a client that is NOT in `trustedClients` — a self-registering relying
 * party, which is what `allowDynamicClientRegistration: true` exists to invite.
 *
 * `scenario.test.ts` drives the seeded `DEMO_CLIENT`, and that client sets `skipConsent: true`.
 * A trusted client with a session touches neither `loginPage` nor `consentPage` — so the two
 * redirects every external RP takes were the two the suite never took, and both dead-ended on
 * the admin dashboard for as long as the demo has existed (#898).
 *
 * What this pins is the CONTRACT THE SPA IMPLEMENTS. `app/src/App.tsx` renders `/login` and
 * `/consent` because Better Auth sends people there, and it reads `consent_code`, `client_id`
 * and `scope` off the query because that is what Better Auth puts there. Those are library
 * facts, not our choices: if `oidcProvider` changes where it redirects or what it carries, the
 * SPA silently stops resuming the flow. These assertions are what makes that a red test rather
 * than a bug report from someone pointing a real app at a deployed issuer.
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
    // A cleared cookie (`Max-Age=0`) must not be carried forward — Better Auth expires
    // `oidc_login_prompt` the moment it resumes, and replaying it re-enters the flow.
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/** A top-level browser navigation. Better Auth answers these with a 302; a `sec-fetch-mode:
 *  cors` request (what `fetch` sends) gets `{ redirect, url }` as JSON instead. */
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
  });
  const created = await auth.api.signUpEmail({ body: ADMIN });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
});

/** Register a relying party through the dynamic-registration endpoint — no admin, no seed. */
async function registerClient(name: string): Promise<{ clientId: string; clientSecret: string }> {
  const res = await call('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: name }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { client_id: string; client_secret: string };
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

function authorizeUrl(clientId: string, state: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RP_REDIRECT,
    scope: 'openid profile',
    state,
    ...extra,
  });
  return `/api/auth/oauth2/authorize?${q.toString()}`;
}

describe('a self-registering relying party completes the round-trip', () => {
  it('registers itself without an admin', async () => {
    const { clientId, clientSecret } = await registerClient('Probe RP');
    expect(clientId).toBeTruthy();
    expect(clientSecret).toBeTruthy();
  });

  it('sends a signed-out visitor to /login carrying the authorize request', async () => {
    const { clientId } = await registerClient('Signed-out RP');
    const res = await call(authorizeUrl(clientId, 'st-login'), { headers: NAVIGATE });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    // The path the SPA must render. `loginPage: '/login'` in src/auth.ts is one half of this
    // agreement; App.tsx's `/login` branch is the other.
    expect(location.startsWith('/login?')).toBe(true);
    // The original request rides in the query AND in the signed cookie. The SPA needs neither
    // — it is the cookie Better Auth reads back to resume — but a dropped cookie is the one
    // way the resume silently stops happening, so pin it.
    expect(cookiesFrom(res)).toContain('oidc_login_prompt=');
  });

  it('resumes the authorize request on sign-in and hands the SPA a redirect', async () => {
    const { clientId } = await registerClient('Resuming RP');
    const authorize = await call(authorizeUrl(clientId, 'st-resume'), { headers: NAVIGATE });

    // Sign in exactly as the SPA does: a same-origin `fetch` carrying the prompt cookie.
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { ...FROM_FETCH, cookie: cookiesFrom(authorize) },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(signIn.status).toBe(200);

    // Better Auth's own after-hook re-runs `authorize` and answers the SIGN-IN request with
    // where to go next. The browser client's default `redirectPlugin` navigates on exactly
    // this shape, which is why the SPA needs no resume code of its own — but it does need to
    // render wherever this points, and for an untrusted client it points at /consent.
    const body = (await signIn.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expect(body.url?.startsWith('/consent?')).toBe(true);
    expect(new URL(`http://x${body.url}`).searchParams.get('consent_code')).toBeTruthy();
  });

  it('sends a signed-in visitor to /consent with the client and scopes to display', async () => {
    const { clientId } = await registerClient('Consenting RP');
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const res = await call(authorizeUrl(clientId, 'st-consent'), {
      headers: { ...NAVIGATE, cookie: cookiesFrom(signIn) },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('/consent?')).toBe(true);
    // The three things the consent screen is built from. App.tsx reads all three by these
    // names; `scope` is space-separated (URL-encoded as `+`).
    const params = new URL(`http://x${location}`).searchParams;
    expect(params.get('consent_code')).toBeTruthy();
    expect(params.get('client_id')).toBe(clientId);
    expect(params.get('scope')).toBe('openid profile');
  });

  it('names the client for the consent screen', async () => {
    const { clientId } = await registerClient('Nameable RP');
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    // Session-gated, so a stranger cannot enumerate the client registry.
    const res = await call(`/api/auth/oauth2/client/${clientId}`, { headers: { cookie: cookiesFrom(signIn) } });
    expect(res.ok).toBe(true);
    const client = (await res.json()) as { clientId: string; name: string };
    expect(client.clientId).toBe(clientId);
    // Without this the screen can only say "an application" — asking someone to approve a
    // random id is not consent.
    expect(client.name).toBe('Nameable RP');
  });

  it('approving consent returns the RP callback with a usable code', async () => {
    const { clientId, clientSecret } = await registerClient('Approving RP');
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const authorize = await call(authorizeUrl(clientId, 'st-approve'), {
      headers: { ...NAVIGATE, cookie: cookiesFrom(signIn) },
    });
    const consentCode = new URL(`http://x${authorize.headers.get('location')}`).searchParams.get('consent_code');

    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { ...FROM_FETCH, cookie: cookiesFrom(signIn, authorize) },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    });
    expect(consent.status).toBe(200);
    const { redirectURI } = (await consent.json()) as { redirectURI: string };

    // The RP's own callback, at last — with the code and the state it opened the flow with.
    const back = new URL(redirectURI);
    expect(`${back.origin}${back.pathname}`).toBe(RP_REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-approve');
    const code = back.searchParams.get('code');
    expect(code).toBeTruthy();

    // And the code redeems. This is the assertion that makes the whole path real rather than
    // a plausible-looking chain of redirects: the RP gets a signed id_token for the user.
    const token = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: RP_REDIRECT,
        client_id: clientId,
        client_secret: clientSecret,
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
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const authorize = await call(authorizeUrl(clientId, 'st-deny'), {
      headers: { ...NAVIGATE, cookie: cookiesFrom(signIn) },
    });
    const consentCode = new URL(`http://x${authorize.headers.get('location')}`).searchParams.get('consent_code');

    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { ...FROM_FETCH, cookie: cookiesFrom(signIn, authorize) },
      body: JSON.stringify({ accept: false, consent_code: consentCode }),
    });
    expect(consent.status).toBe(200);
    const { redirectURI } = (await consent.json()) as { redirectURI: string };

    // Deny is an ANSWER, not a dead end — the RP is told, at its own callback.
    expect(redirectURI.startsWith(RP_REDIRECT)).toBe(true);
    expect(new URL(redirectURI).searchParams.get('error')).toBe('access_denied');
  });
});

describe('prompt=none answers without any UI', () => {
  it('answers login_required at the callback when signed out', async () => {
    const { clientId } = await registerClient('Silent RP');
    const res = await call(authorizeUrl(clientId, 'st-none', { prompt: 'none' }), { headers: NAVIGATE });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(RP_REDIRECT)).toBe(true);
    expect(new URL(location).searchParams.get('error')).toBe('login_required');
  });

  it('answers consent_required at the callback when signed in without consent', async () => {
    const { clientId } = await registerClient('Silent Consented RP');
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const res = await call(authorizeUrl(clientId, 'st-none-2', { prompt: 'none' }), {
      headers: { ...NAVIGATE, cookie: cookiesFrom(signIn) },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    // Never /consent — `prompt=none` promises no interaction, so the answer goes to the RP.
    expect(location.startsWith(RP_REDIRECT)).toBe(true);
    expect(new URL(location).searchParams.get('error')).toBe('consent_required');
  });
});

describe('re-authentication (prompt=login) needs the login page even with a session', () => {
  it('sends a signed-in visitor back to /login rather than straight through', async () => {
    const { clientId } = await registerClient('Reauth RP');
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const res = await call(authorizeUrl(clientId, 'st-reauth', { prompt: 'login' }), {
      headers: { ...NAVIGATE, cookie: cookiesFrom(signIn) },
    });

    expect(res.status).toBe(302);
    expect((res.headers.get('location') ?? '').startsWith('/login?')).toBe(true);
    // This is why App.tsx cannot pick its screen from session state alone: here there IS a
    // session and the correct screen is still sign-in. Choosing by session would render the
    // dashboard and strand the re-authentication.
    expect(cookiesFrom(res)).toContain('oidc_login_prompt=');
  });
});
