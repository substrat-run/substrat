import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { resolveScopedEnvSpec } from '@substrat-run/contracts';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { AUTH_SERVER_ENV } from '../src/manifest.js';
import { createAdminApi } from '../src/admin-api.js';
import { ACCOUNT_LINKING, ALLOW_SIGNUP, REQUIRE_EMAIL_VERIFICATION, deliveredConfig, isTruthy } from '../src/settings.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';
import { publicProvidersFrom, readProviders } from '../src/providers.js';
import type { SignInPolicy } from '../src/sign-in-policy.js';
import { OAUTH_QUERY_AFTER_VERIFICATION } from '../src/email-verification-wire.js';

/**
 * Self-service sign-up: the setting, the endpoint it controls, and the OIDC flow it has to
 * survive.
 *
 * Hiding the sign-up screen is a courtesy; `emailAndPassword.disableSignUp` is the control,
 * so the refusal is asserted at the ENDPOINT, not in the SPA. Two things could quietly break
 * the feature and are pinned here:
 *
 *   - Bootstrapping the first administrator goes through the same `signUpEmail` route, so a
 *     closed issuer must still be able to create one — otherwise `ALLOW_SIGNUP=false` (the
 *     default) would make a fresh install unusable.
 *   - Someone a relying party sent here must be able to create an account and land back at
 *     THAT application, not on this dashboard. Better Auth's oidcProvider hook resumes on any
 *     response carrying a new session cookie, which includes sign-up — that is a library fact
 *     the whole sign-up-during-login path rests on (#898 was the same failure on sign-in).
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const NEWCOMER = { email: 'newcomer@auth.test', password: 'newcomer-pass', name: 'New Comer' };
const RP_REDIRECT = 'http://localhost:9999/cb';

let db: Database.Database;
let sql: SqlExec;
let mail: MockEmailTransport;
/** The relying party's sign-in policy, when a test gives it one. */
let policy: SignInPolicy | undefined;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

/** The config merge both runtimes use: declared env-spec over env, overlaid with `cfg:` rows. */
const config = (): Record<string, string | undefined> =>
  resolveScopedEnvSpec(AUTH_SERVER_ENV, {}, deliveredConfig(sql, AUTH_SERVER_ENV)).values;

/** Better Auth as the DO builds it — per request, so a settings change is visible immediately. */
const authFor = (overrides?: { allowSignup?: boolean }): Auth =>
  buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: mail,
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: overrides?.allowSignup ?? isTruthy(config()[ALLOW_SIGNUP]),
    requireEmailVerification: isTruthy(config()[REQUIRE_EMAIL_VERIFICATION]),
    signInPolicyFor: () => policy,
  });

const call = (path: string, init?: RequestInit): Promise<Response> =>
  authFor().handler(new Request(`${ORIGIN}${path}`, init) as never);

const signUpCall = (who: { email: string; password: string; name: string }): Promise<Response> =>
  call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
    body: JSON.stringify(who),
  });

/** base64url — PKCE's encoding. OAuth 2.1 makes `code_challenge` mandatory on authorize. */
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function cookiesFrom(...responses: Response[]): string {
  return responses
    .flatMap((res) => res.headers.getSetCookie())
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function adminApi() {
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    authFor()
      .api.getSession({ headers: headers as never })
      .then((s) => {
        const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
        return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
      });
  return createAdminApi({ sql, session, effectiveCfg: config, auth: () => authFor().api as never, offeredProviders: () => publicProvidersFrom(readProviders(sql)), transaction: (fn) => fn() });
}

async function adminCookie(): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

beforeEach(async () => {
  db = new Database(':memory:');
  mail = new MockEmailTransport();
  policy = undefined;
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  // The bootstrap path: sign-up forced on, exactly as the DO seeds its first admin.
  const created = await authFor({ allowSignup: true }).api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
});

describe('sign-up is off unless an administrator turns it on', () => {
  it('is off with no config at all', () => {
    expect(isTruthy(config()[ALLOW_SIGNUP])).toBe(false);
  });

  it('refuses sign-up at the endpoint while it is off', async () => {
    const res = await signUpCall(NEWCOMER);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/sign up is not enabled/i);
    expect(db.prepare('SELECT COUNT(*) AS c FROM user').get()).toEqual({ c: 1 });
  });

  it('still lets the FIRST administrator be created while it is off', async () => {
    // The bootstrap in `beforeEach` ran on a closed issuer. Without the override, a default
    // install could never create anybody — including the admin who would open sign-up.
    const admin = db.prepare('SELECT role FROM user WHERE email = ?').get(ADMIN.email) as { role: string };
    expect(admin.role).toBe('admin');
  });

  it('still lets an administrator create accounts while it is off', async () => {
    // Better Auth's admin plugin writes through the internal adapter rather than the sign-up
    // route, so `disableSignUp` does not reach it. The dashboard's "+ New user" keeps working.
    const res = await call('/api/auth/admin/create-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await adminCookie() },
      body: JSON.stringify({ email: 'made@auth.test', password: 'made-by-admin', name: 'Made', role: 'user' }),
    });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM user').get()).toEqual({ c: 2 });
  });
});

describe('the dashboard toggle', () => {
  it('opens sign-up and the very next attempt succeeds', async () => {
    const api = adminApi();
    const cookie = await adminCookie();

    const before = await api.request('http://localhost/settings', { headers: { cookie } });
    expect(await before.json()).toEqual({ allowSignup: false, requireEmailVerification: false, accountLinking: 'link', machineScopes: [], issuerTheme: {}, defaultLocale: 'en' });

    const patched = await api.request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ allowSignup: true }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ allowSignup: true, requireEmailVerification: false, accountLinking: 'link', machineScopes: [], issuerTheme: {}, defaultLocale: 'en' });

    // It landed on the SAME declared key the platform's Env tab and a wrangler var write to,
    // so there is only ever one answer to "is sign-up open".
    expect(config()[ALLOW_SIGNUP]).toBe('true');

    const res = await signUpCall(NEWCOMER);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM user').get()).toEqual({ c: 2 });
  });

  it('stores an issuer theme, and refuses one it would not serve', async () => {
    const api = adminApi();
    const cookie = await adminCookie();
    const patch = (issuerTheme: unknown) =>
      api.request('http://localhost/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ issuerTheme }),
      });

    expect((await patch({ colorPrimary: '#e5833a', css: '.card { width: 440px; }' })).status).toBe(200);
    expect(JSON.parse(config().ISSUER_THEME!)).toEqual({ colorPrimary: '#e5833a', css: '.card { width: 440px; }' });

    const refused = await patch({ css: '@import "https://evil.example/x.css";' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('@import');
    expect(JSON.parse(config().ISSUER_THEME!).css).toBe('.card { width: 440px; }');
  });

  it('closes sign-up again', async () => {
    const api = adminApi();
    const cookie = await adminCookie();
    for (const allowSignup of [true, false]) {
      await api.request('http://localhost/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ allowSignup }),
      });
    }
    expect((await signUpCall(NEWCOMER)).status).toBe(400);
  });

  it('refuses a non-boolean value with a readable message', async () => {
    const res = await adminApi().request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: await adminCookie() },
      body: JSON.stringify({ allowSignup: 'yes please' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('the account-linking mode', () => {
  it('writes the declared key and leaves the sign-up decision alone', async () => {
    const api = adminApi();
    const cookie = await adminCookie();
    // Open sign-up first, so the linking patch has something it could clobber.
    await api.request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ allowSignup: true }),
    });

    // A PARTIAL patch: the panel names only what changed. A whole-object PUT would make every
    // control a chance to revert another one from a copy it read before the change.
    const res = await api.request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ accountLinking: 'block' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowSignup: true, requireEmailVerification: false, accountLinking: 'block', machineScopes: [], issuerTheme: {}, defaultLocale: 'en' });
    // Same declared key the platform's Env tab and a wrangler var write to — one answer.
    expect(config()[ACCOUNT_LINKING]).toBe('block');
  });

  it('refuses a value that is neither mode, and a patch that names nothing', async () => {
    const cookie = await adminCookie();
    // Not a boolean toggle: an issuer's third answer to this question ("keep both accounts")
    // is one the library cannot give, so an unknown value is a typo and never a new policy.
    const bogus = await adminApi().request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ accountLinking: 'separate' }),
    });
    expect(bogus.status).toBe(400);
    // An empty patch answered 200 would report success for a request that set nothing.
    const empty = await adminApi().request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});

/** The admin's settings PATCH, as the dashboard sends it. */
async function patchSettings(patch: Record<string, unknown>): Promise<Response> {
  return adminApi().request('http://localhost/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: await adminCookie() },
    body: JSON.stringify(patch),
  });
}

/**
 * A relying party registered the way an app does (RFC 7591, no session), and a stranger it
 * sent here: no session, so the plugin answers `/login` with the whole request signed into the
 * query — where the SPA offers "Create an account". Returns that signed query.
 */
async function arriveFromRelyingParty(
  state: string,
  extra: Record<string, string> = {},
  page = '/login',
): Promise<{ clientId: string; oauthQuery: string }> {
  const registered = await call('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: 'Sender', application_type: 'native' }),
  });
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const authorize = await call(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: RP_REDIRECT,
      scope: 'openid profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    })}`,
    { headers: { 'sec-fetch-mode': 'navigate' } },
  );
  const location = authorize.headers.get('location') ?? '';
  expect(location.startsWith(`${page}?`)).toBe(true);
  return { clientId, oauthQuery: new URL(`http://x${location}`).search.replace(/^\?/, '') };
}

describe('signing up mid-authorize returns to the relying party', () => {
  it('resumes the pending authorize request instead of landing on the dashboard', async () => {
    // Open sign-up the way an administrator would.
    await patchSettings({ allowSignup: true });
    const { clientId, oauthQuery } = await arriveFromRelyingParty('st-signup');

    // They sign UP rather than in, handing the request back — exactly what the SPA's sign-up
    // screen posts. Nothing on the server remembers it otherwise.
    const signedUp = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
      body: JSON.stringify({ ...NEWCOMER, oauth_query: oauthQuery }),
    });
    expect(signedUp.status).toBe(200);

    // The answer is the resume, not a session payload: the browser client navigates here on
    // its own, so a new account continues to the application that asked for it.
    const body = (await signedUp.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expect(body.url?.startsWith('/consent?')).toBe(true);
    expect(new URL(`http://x${body.url}`).searchParams.get('client_id')).toBe(clientId);
  });
});

describe('with REQUIRE_EMAIL_VERIFICATION on, the verification link returns to the relying party', () => {
  const SESSION_COOKIE = /session_token=[^;]/;
  /** The link in the last verification mail, as the path this issuer serves it at. */
  const lastLink = (): URL => new URL(/(https?:\/\/\S+\/verify-email\?\S+)/.exec(mail.last!.text)![1]!);
  const verified = (email: string) =>
    (db.prepare('SELECT email_verified AS v FROM user WHERE email = ?').get(email) as { v: number }).v;

  beforeEach(async () => {
    expect((await patchSettings({ allowSignup: true, requireEmailVerification: true })).status).toBe(200);
  });

  it('signs up, verifies, and lands at the application’s callback with a code', async () => {
    const { clientId, oauthQuery } = await arriveFromRelyingParty('st-verify');

    const signedUp = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
      body: JSON.stringify({ ...NEWCOMER, oauth_query: oauthQuery }),
    });
    // No session and so no resume: the account exists, unverified, and the mail is the way on.
    expect(signedUp.status).toBe(200);
    expect(((await signedUp.json()) as { token: string | null }).token).toBeNull();
    expect(signedUp.headers.getSetCookie().join(';')).not.toMatch(SESSION_COOKIE);
    expect(verified(NEWCOMER.email)).toBe(0);
    expect(mail.last!.to).toEqual([{ email: NEWCOMER.email }]);

    // The link's callback is the relying party's own authorize request, re-issued — not `/`,
    // which is where Better Auth sends it when nothing says otherwise.
    const link = lastLink();
    const callback = new URL(link.searchParams.get('callbackURL')!, ORIGIN);
    expect(callback.pathname).toBe('/api/auth/oauth2/authorize');
    expect(callback.searchParams.get('client_id')).toBe(clientId);
    expect(callback.searchParams.get('state')).toBe('st-verify');
    // Only the relying party's own request: the signature's bookkeeping stays behind.
    expect([...callback.searchParams.keys()].filter((k) => k === 'sig' || k === 'exp' || k.startsWith('ba_'))).toEqual([]);

    // Clicking it verifies the address, signs them in, and sends the browser to that request.
    const clicked = await call(`${link.pathname}${link.search}`, { headers: { 'sec-fetch-mode': 'navigate' } });
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get('location')).toBe(link.searchParams.get('callbackURL'));
    expect(verified(NEWCOMER.email)).toBe(1);
    const cookie = cookiesFrom(clicked);
    expect(cookie).toMatch(SESSION_COOKIE);

    // Authorize answers a signed-in person: consent for this client, then the code at its callback.
    const authorize = await call(`${callback.pathname}${callback.search}`, { headers: { 'sec-fetch-mode': 'navigate', cookie } });
    const consentAt = authorize.headers.get('location') ?? '';
    expect(consentAt.startsWith('/consent?')).toBe(true);
    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie },
      body: JSON.stringify({ accept: true, oauth_query: new URL(`http://x${consentAt}`).search.replace(/^\?/, '') }),
    });
    const back = new URL(((await consent.json()) as { url: string }).url);
    expect(`${back.origin}${back.pathname}`).toBe(RP_REDIRECT);
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('st-verify');
  });

  it('answers what asked for a fresh sign-in, so a relying party that asked for sign-up gets its code', async () => {
    // `prompt=create` is how a relying party asks for the sign-up screen — this PR's case.
    // `login` and `max_age=0` ask for a fresh sign-in too; `consent` is not about signing in.
    const { clientId, oauthQuery } = await arriveFromRelyingParty(
      'st-create',
      { prompt: 'login create consent', max_age: '0' },
      '/signup',
    );
    const signedUp = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
      body: JSON.stringify({ ...NEWCOMER, oauth_query: oauthQuery }),
    });
    expect(signedUp.status).toBe(200);
    const link = lastLink();
    const callback = new URL(link.searchParams.get('callbackURL')!, ORIGIN);
    expect(callback.searchParams.get('prompt')).toBe('consent');
    expect(callback.searchParams.has('max_age')).toBe(false);

    // Re-issued verbatim, the click would land on `/signup` again, signed in and verified.
    const cookie = cookiesFrom(await call(`${link.pathname}${link.search}`, { headers: { 'sec-fetch-mode': 'navigate' } }));
    const authorize = await call(`${callback.pathname}${callback.search}`, { headers: { 'sec-fetch-mode': 'navigate', cookie } });
    const next = authorize.headers.get('location') ?? '';
    expect(next.startsWith('/consent?')).toBe(true);
    expect(new URL(`http://x${next}`).searchParams.get('client_id')).toBe(clientId);
  });

  it('refuses an unverified sign-in only after the password, with a fresh link that also returns', async () => {
    // An account made on the issuer directly, before any application sent its holder anywhere.
    expect((await signUpCall(NEWCOMER)).status).toBe(200);
    const { clientId, oauthQuery } = await arriveFromRelyingParty('st-again');
    const signIn = (password: string) =>
      call('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
        body: JSON.stringify({ email: NEWCOMER.email, password, oauth_query: oauthQuery }),
      });

    // A wrong password learns nothing about verification, and mails nobody.
    const sentBefore = mail.sent.length;
    expect((await signIn('not-the-password')).status).toBe(401);
    expect(mail.sent.length).toBe(sentBefore);

    const refused = await signIn(NEWCOMER.password);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe('EMAIL_NOT_VERIFIED');
    expect(mail.sent.length).toBe(sentBefore + 1);
    const callback = new URL(lastLink().searchParams.get('callbackURL')!, ORIGIN);
    expect(callback.pathname).toBe('/api/auth/oauth2/authorize');
    expect(callback.searchParams.get('client_id')).toBe(clientId);
    expect(callback.searchParams.get('state')).toBe('st-again');
  });

  it('leaves a verified person’s sign-in to resume the ordinary way', async () => {
    // The admin's address is verified (`beforeEach` at the top). Setting a callback here would
    // add a `Location` to a response the plugin answers with its own resume.
    const { clientId, oauthQuery } = await arriveFromRelyingParty('st-verified');
    const res = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, oauth_query: oauthQuery }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expect(new URL(`http://x${body.url}`).searchParams.get('client_id')).toBe(clientId);
  });

  it('for a client requiring an SMS code, the link returns to it and authorize asks for password and code', async () => {
    // The SPA cannot send `oauth_query` with the password half of password + SMS: the plugin
    // would resume on the password alone. The request rides under its own name instead.
    policy = { providers: [], password: true, passwordSecondFactor: 'sms' };
    expect((await signUpCall(NEWCOMER)).status).toBe(200);
    const { clientId, oauthQuery } = await arriveFromRelyingParty('st-sms');
    const refused = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
      body: JSON.stringify({ email: NEWCOMER.email, password: NEWCOMER.password, [OAUTH_QUERY_AFTER_VERIFICATION]: oauthQuery }),
    });
    expect(refused.status).toBe(403);
    const link = lastLink();
    const callback = new URL(link.searchParams.get('callbackURL')!, ORIGIN);
    expect(callback.pathname).toBe('/api/auth/oauth2/authorize');
    expect(callback.searchParams.get('client_id')).toBe(clientId);

    // The link's session is a password one, which this client refuses: authorize sends the
    // person to sign in again — password, then code — instead of issuing a code for it.
    const cookie = cookiesFrom(await call(`${link.pathname}${link.search}`, { headers: { 'sec-fetch-mode': 'navigate' } }));
    const authorize = await call(`${callback.pathname}${callback.search}`, { headers: { 'sec-fetch-mode': 'navigate', cookie } });
    const next = authorize.headers.get('location') ?? '';
    expect(next.startsWith('/login?')).toBe(true);
    expect(new URL(`http://x${next}`).searchParams.get('client_id')).toBe(clientId);
  });

  it('leaves a verified person’s password half of password + SMS exactly as it was', async () => {
    const { oauthQuery } = await arriveFromRelyingParty('st-sms-verified');
    const res = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, [OAUTH_QUERY_AFTER_VERIFICATION]: oauthQuery }),
    });
    // Signed in, not resumed and not redirected: the SMS step is what resumes it.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { redirect?: boolean; token?: string };
    expect(body.redirect).toBe(false);
    expect(body.token).toBeTruthy();
  });

  it('is the declared key, written beside the sign-up decision without touching it', () => {
    expect(config()[REQUIRE_EMAIL_VERIFICATION]).toBe('true');
    expect(config()[ALLOW_SIGNUP]).toBe('true');
  });
});
