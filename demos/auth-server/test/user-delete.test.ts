import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import { adminEraseUser, eraseUser } from '../src/user-erasure.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * Deleting a person (#3346). Better Auth's `admin/remove-user` — what the console used to call —
 * deleted sessions and sign-in methods and was then refused the `user` row by the OAuth tables'
 * foreign keys: a 500, a person still listed, and a refresh token still minting tokens at every
 * app they had used. So the case that matters is a person who HAS signed in to an app, and what
 * is asserted is both that the rows are gone and that the credentials they backed stop working.
 */

const ORIGIN = 'http://localhost:8877';
const RP = 'http://localhost:9999/cb';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const MEMBER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'Plain Member' };

let db: Database.Database;
let auth: Auth;
let api: ReturnType<typeof createAdminApi>;
let adminId: string;
let memberId: string;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return { columnNames: [], toArray: () => objects, raw: () => [][Symbol.iterator]() };
    },
  };
}

const call = (path: string, init?: RequestInit): Promise<Response> => auth.handler(new Request(`${ORIGIN}${path}`, init) as never);

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

async function signInAs(who: { email: string; password: string }): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

const deleteUser = (userId: string, cookie: string): Promise<Response> =>
  Promise.resolve(api.request(`http://localhost/users/${userId}`, { method: 'DELETE', headers: { cookie } }));

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The member signs in to a relying party the real way — authorize, consent, code, token — so
 * the consent and the token rows are the plugin's own, not rows a test guessed the shape of.
 */
async function signInToRelyingParty(cookie: string) {
  const reg = (await (
    await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [RP], client_name: 'Probe RP', application_type: 'native' }),
    })
  ).json()) as { client_id: string; client_secret: string };
  const basic = `Basic ${btoa(`${reg.client_id}:${reg.client_secret}`)}`;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: RP,
    scope: 'openid profile offline_access',
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });
  const authorize = await call(`/api/auth/oauth2/authorize?${query}`, { headers: { 'sec-fetch-mode': 'navigate', cookie } });
  const oauthQuery = new URL(`http://x${authorize.headers.get('location')}`).search.slice(1);
  const consent = (await (
    await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    })
  ).json()) as { url: string };
  const code = new URL(consent.url).searchParams.get('code') ?? '';
  const token = await call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: RP, code_verifier: verifier }).toString(),
  });
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as { access_token: string; refresh_token: string };
  const refresh = () =>
    call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    });
  return { clientId: reg.client_id, accessToken: tokens.access_token, refresh };
}

const count = (table: string, column: string, value: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number }).n;

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
  });
  for (const who of [ADMIN, MEMBER]) {
    const created = await auth.api.signUpEmail({ body: who });
    db.prepare('UPDATE user SET role = ?, email_verified = 1 WHERE id = ?').run(who === ADMIN ? 'admin' : 'user', created.user.id);
    if (who === ADMIN) adminId = created.user.id;
    else memberId = created.user.id;
  }
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    auth.api.getSession({ headers: headers as never }).then((s) => {
      const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
    });
  api = createAdminApi({
    sql: sqlExecOf(db),
    session,
    effectiveCfg: () => ({}),
    auth: () => auth.api as never,
    offeredProviders: () => [],
    transaction: (fn) => db.transaction(fn)(),
  });
});

describe('an administrator deletes a person who has signed in to an app', () => {
  it('erases every row that names them, and every credential they held stops working at once', async () => {
    const memberCookie = await signInAs(MEMBER);
    const rp = await signInToRelyingParty(memberCookie);
    // The rest of what can name a person, planted where no flow in a unit test reaches.
    const now = Date.now();
    db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, access_token, updated_at) VALUES ('acc-gh', 'gh-42', 'github', ?, 'up-at', ?)").run(memberId, now);
    // One row per shape a flow writes for a person, and decoys that only CONTAIN the member's id —
    // an imported id is any string, so `${id}b` and `${id}:1` are other people (#3346 review).
    const sessionId = (db.prepare('SELECT id FROM session WHERE user_id = ? LIMIT 1').get(memberId) as { id: string }).id;
    const verification = db.prepare('INSERT INTO verification (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)');
    for (const [id, identifier, value] of [
      ['v-reset', 'reset-password:tok', memberId],
      ['v-invite', `invite-password:${memberId}`, 'set'],
      ['v-attempt', `phone-attempt:${memberId}:5:0`, 'attempt'],
      ['v-skip', `bankid-email-skip:${memberId}:1`, 'skipped'],
      ['v-challenge', `phone-challenge:${sessionId}`, '{"phone":"+46700000000","enrolled":false}'],
      ['v-github', 'github-email:digest-1', JSON.stringify({ userId: memberId, email: MEMBER.email })],
      ['v-github-proof', 'github-email-proof:digest-2', JSON.stringify({ pendingKey: 'github-email:digest-1', email: MEMBER.email })],
      ['v-bankid', 'bankid-email:hash-1', JSON.stringify({ userId: memberId, personalNumber: '190001010000', name: 'M' })],
      ['v-bankid-challenge', 'bankid-email-challenge:hash-1', 'code'],
      ['v-bankid-sends', 'bankid-email-sends:hash-1:0', 'sent'],
      ['keep-value', 'reset-password:x', `${memberId}b`],
      ['keep-attempt', `phone-attempt:${memberId}:1:5:0`, 'attempt'],
      ['keep-json', 'github-email:digest-3', JSON.stringify({ userId: `${memberId}b` })],
      ['keep-challenge', 'phone-challenge:another-session', '{}'],
    ]) {
      verification.run(id, identifier, value, now + 60_000);
    }
    db.prepare("INSERT INTO place_member (sub, app_scope_id) VALUES (?, 'app-a')").run(memberId);
    db.prepare('INSERT INTO user_activity (user_id, last_login_at, logins_count) VALUES (?, ?, 3)').run(memberId, now);
    db.prepare("INSERT INTO user_client_activity (user_id, client_id, last_token_at) VALUES (?, ?, ?)").run(memberId, rp.clientId, now);
    db.prepare("UPDATE oauth_client SET user_id = ? WHERE client_id = ?").run(memberId, rp.clientId);
    db.prepare("INSERT INTO sign_in_attempt (method, outcome, phase, user_id) VALUES ('password', 'success', 'done', ?)").run(memberId);
    for (const table of ['session', 'oauth_consent', 'oauth_access_token', 'oauth_refresh_token']) {
      expect(count(table, 'user_id', memberId), `${table} before`).toBeGreaterThan(0);
    }
    // The access token works before, so its refusal after is the deletion's doing.
    expect((await call('/api/auth/oauth2/userinfo', { headers: { authorization: `Bearer ${rp.accessToken}` } })).status).toBe(200);

    const logged = vi.spyOn(console, 'log');
    const res = await deleteUser(memberId, await signInAs(ADMIN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: memberId });
    const line = logged.mock.calls.map(([l]) => JSON.parse(String(l)) as Record<string, unknown>).find((l) => l.message === 'user deleted');
    expect(line).toMatchObject({ userId: memberId, by: adminId });
    logged.mockRestore();

    for (const [table, column] of [
      ['user', 'id'],
      ['session', 'user_id'],
      ['account', 'user_id'],
      ['oauth_consent', 'user_id'],
      ['oauth_access_token', 'user_id'],
      ['oauth_refresh_token', 'user_id'],
      ['oauth_client', 'user_id'],
      ['place_member', 'sub'],
      ['user_activity', 'user_id'],
      ['user_client_activity', 'user_id'],
      ['sign_in_attempt', 'user_id'],
    ] as const) {
      expect(count(table, column, memberId), `${table}.${column}`).toBe(0);
    }
    expect((db.prepare('SELECT id FROM verification ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual([
      'keep-attempt',
      'keep-challenge',
      'keep-json',
      'keep-value',
    ]);
    // Kept: the client (it is the app's, not the person's) and the log row, without its who.
    expect(count('oauth_client', 'client_id', rp.clientId)).toBe(1);
    expect((db.prepare('SELECT count(*) AS n FROM sign_in_attempt').get() as { n: number }).n).toBe(1);

    // Every credential the person held, refused on its next use.
    expect(await auth.api.getSession({ headers: new Headers({ cookie: memberCookie }) as never })).toBeNull();
    expect((await call('/api/auth/oauth2/userinfo', { headers: { authorization: `Bearer ${rp.accessToken}` } })).status).toBe(401);
    const refreshed = await rp.refresh();
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    expect(await refreshed.text()).not.toContain('access_token');
  });

  it('lets the same address sign up again as a new subject', async () => {
    expect((await deleteUser(memberId, await signInAs(ADMIN))).status).toBe(200);
    const again = await auth.api.signUpEmail({ body: MEMBER });
    expect(again.user.id).not.toBe(memberId);
    expect(again.user.email).toBe(MEMBER.email);
  });

  it("leaves Better Auth's own remove-user refused, so no door half-deletes", async () => {
    const res = await call('/api/auth/admin/remove-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await signInAs(ADMIN) },
      body: JSON.stringify({ userId: memberId }),
    });
    expect(res.status).toBe(403);
    expect(count('user', 'id', memberId)).toBe(1);
    expect(count('account', 'user_id', memberId)).toBe(1);
  });
});

// An imported id is whatever the previous issuer used (#3346 review): a common word, or one JSON
// has to escape. Ownership must come from each flow's row shape, not from the id looking unique.
it('erases an imported id by its rows, not by what other rows happen to contain', () => {
  const now = Date.now();
  for (const [i, id] of ['attempt', 'a"b', 'a\nb'].entries()) {
    db.prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, 'Imported', ?, 1)").run(id, `imported-${i}@import.test`);
  }
  const verification = db.prepare('INSERT INTO verification (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)');
  for (const [id, identifier, value] of [
    ['v-reset', 'reset-password:tok', 'attempt'],
    ['keep-attempt', `phone-attempt:${memberId}:5:0`, 'attempt'],
    ['v-quoted', 'github-email:digest-q', JSON.stringify({ userId: 'a"b' })],
    ['v-newline-attempt', 'phone-attempt:a\nb:5:0', 'attempt'],
    ['v-newline-skip', 'bankid-email-skip:a\nb:1', 'skipped'],
    ['keep-other-skip', 'bankid-email-skip:a\nb:2:1', 'skipped'],
  ]) {
    verification.run(id, identifier, value, now + 60_000);
  }
  const sql = sqlExecOf(db);
  eraseUser(sql, 'attempt');
  eraseUser(sql, 'a"b');
  eraseUser(sql, 'a\nb');
  expect((db.prepare('SELECT id FROM verification ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual([
    'keep-attempt',
    'keep-other-skip',
  ]);
});

describe('the guard rails', () => {
  it('refuses an unknown person, your own account, and a non-administrator', async () => {
    const admin = await signInAs(ADMIN);
    expect((await deleteUser('nobody', admin)).status).toBe(404);
    const self = await deleteUser(adminId, admin);
    expect(self.status).toBe(409);
    expect(((await self.json()) as { error: string }).error).toMatch(/your own account/);
    expect((await deleteUser(adminId, await signInAs(MEMBER))).status).toBe(403);
    expect(count('user', 'id', adminId)).toBe(1);
  });

  // The console cannot reach this one — its caller is an administrator who is not the one being
  // deleted — so it is held at the function every door shares.
  it('refuses the last administrator, whoever asks', () => {
    const sql = sqlExecOf(db);
    expect(adminEraseUser(sql, adminId, memberId)).toEqual({ refused: expect.stringMatching(/last administrator/), status: 409 });
    expect(count('user', 'id', adminId)).toBe(1);
  });
});
