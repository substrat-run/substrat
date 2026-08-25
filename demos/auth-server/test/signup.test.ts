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
import { ALLOW_SIGNUP, deliveredConfig, isTruthy } from '../src/settings.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

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
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: overrides?.allowSignup ?? isTruthy(config()[ALLOW_SIGNUP]),
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
  return createAdminApi({ sql, session, effectiveCfg: config, auth: () => authFor().api as never });
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
    expect(await before.json()).toEqual({ allowSignup: false });

    const patched = await api.request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ allowSignup: true }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ allowSignup: true });

    // It landed on the SAME declared key the platform's Env tab and a wrangler var write to,
    // so there is only ever one answer to "is sign-up open".
    expect(config()[ALLOW_SIGNUP]).toBe('true');

    const res = await signUpCall(NEWCOMER);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM user').get()).toEqual({ c: 2 });
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

describe('signing up mid-authorize returns to the relying party', () => {
  it('resumes the pending authorize request instead of landing on the dashboard', async () => {
    // Open sign-up the way an administrator would.
    const cookie = await adminCookie();
    await adminApi().request('http://localhost/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ allowSignup: true }),
    });

    // Register a relying party the way an app does: RFC 7591, no session.
    const registered = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: 'Sender', application_type: 'native' }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    // A stranger arrives from the RP: no session, so the plugin sends them to `/login` with
    // the whole request signed into the query — where the SPA offers "Create an account".
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const authorize = await call(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: RP_REDIRECT,
        scope: 'openid profile',
        state: 'st-signup',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
      { headers: { 'sec-fetch-mode': 'navigate' } },
    );
    const location = authorize.headers.get('location') ?? '';
    expect(location.startsWith('/login?')).toBe(true);
    const oauthQuery = new URL(`http://x${location}`).search.replace(/^\?/, '');

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
