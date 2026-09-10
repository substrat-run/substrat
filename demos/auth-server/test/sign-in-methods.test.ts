import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';
import { publicProvidersFrom, readProviders } from '../src/providers.js';

/**
 * The one read behind the user-detail screen: how somebody ELSE signs in.
 *
 * Better Auth's `list-accounts` answers only for the session making the call, so this is ours,
 * and what has to be proven about it is not that it returns rows. It is that the row it
 * returns is missing four columns — the bcrypt hash and the upstream's three tokens — because
 * the table it reads holds all of them and a `SELECT *` would have shipped every one.
 *
 * That is proven at BOTH ends, and it takes both. The JSON an administrator's browser receives
 * is asserted on, so a field added to the projection later has to be thought about — but the
 * handler maps each row to a fresh object, so that assertion alone would still pass over a
 * `SELECT *`, which is the regression it is named for. So the SQL itself is captured and its
 * column list pinned: the read may name these five columns and nothing else, star included.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const MEMBER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'Plain Member' };

let db: Database.Database;
let sql: SqlExec;
/** Every statement the handler ran, so a test can assert on the projection and not only on its output. */
let queries: string[];
let auth: Auth;
let api: ReturnType<typeof createAdminApi>;
let memberId: string;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      queries.push(query);
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

const call = (path: string, init?: RequestInit): Promise<Response> =>
  auth.handler(new Request(`${ORIGIN}${path}`, init) as never);

async function signInAs(who: { email: string; password: string }): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

const adminCall = (path: string, cookie: string): Promise<Response> =>
  Promise.resolve(api.request(`http://localhost${path}`, { headers: { cookie } }));

interface WireMethod {
  id: string;
  provider: string;
  accountId: string;
  issuer: string | null;
  createdAt: string | null;
}

const methodsFor = async (userId: string, cookie: string): Promise<WireMethod[]> =>
  ((await (await adminCall(`/users/${userId}/sign-in-methods`, cookie)).json()) as { methods: WireMethod[] }).methods;

/** The columns the `account` read actually asked SQLite for — `['*']` if somebody starred it. */
function accountReadColumns(): string[] {
  const read = queries.find((q) => /\bFROM\s+account\b/i.test(q));
  expect(read, 'the handler never read `account`').toBeTruthy();
  const projection = /SELECT\s+([\s\S]+?)\s+FROM\s+account\b/i.exec(read!);
  expect(projection, `could not read the projection out of: ${read!}`).toBeTruthy();
  return projection![1]!.split(',').map((c) => c.trim());
}

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  queries = [];
  sql = sqlExecOf(db);
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
    db.prepare('UPDATE user SET role = ?, email_verified = 1 WHERE id = ?').run(
      who === MEMBER ? 'user' : 'admin',
      created.user.id,
    );
    if (who === MEMBER) memberId = created.user.id;
  }
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    auth.api.getSession({ headers: headers as never }).then((s) => {
      const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
    });
  api = createAdminApi({
    sql,
    session,
    effectiveCfg: () => ({}),
    auth: () => auth.api as never,
    // Only the console's lock-out guard reads this (`src/console-client.ts`), which no
    // case here exercises — so the issuer's own enabled upstreams are the honest answer.
    offeredProviders: () => publicProvidersFrom(readProviders(sql)),
  });
});

describe("an administrator's read of another person's sign-in methods", () => {
  it('reports the password as a method without ever shipping the hash', async () => {
    const admin = await signInAs(ADMIN);
    const methods = await methodsFor(memberId, admin);

    expect(methods).toHaveLength(1);
    const [password] = methods;
    expect(password!.provider).toBe('credential');
    expect(password!.createdAt).toMatch(/^\d{4}-/);

    // The hash IS in the row this read comes from — so the test proves the projection, not
    // the absence of the column.
    const stored = db.prepare('SELECT password FROM account WHERE user_id = ?').get(memberId) as {
      password: string | null;
    };
    expect(stored.password).toBeTruthy();
    for (const secret of ['password', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'idToken', 'id_token']) {
      expect(Object.keys(password!), `${secret} reached the browser`).not.toContain(secret);
    }
    expect(JSON.stringify(methods)).not.toContain(stored.password);
  });

  /**
   * The assertion above is about the JSON, and the JSON is built field by field — so it would
   * go on passing over a `SELECT *`, and the very regression it warns about would ship. This
   * one is about the statement: the read asks for five named columns, and a star, an added
   * `password`, or an added token column is a failure here before it is ever a leak there.
   */
  it('asks SQLite for five named columns, so a `SELECT *` fails rather than ships', async () => {
    await methodsFor(memberId, await signInAs(ADMIN));
    expect(accountReadColumns()).toEqual(['id', 'provider_id', 'account_id', 'issuer', 'created_at']);
  });

  it('shows an upstream account by the subject the provider knows them by', async () => {
    // Written straight into `account`, because a real Google round trip is not available in a
    // unit test and the shape of the row is what the screen reads.
    db.prepare(
      `INSERT INTO account (id, issuer, account_id, provider_id, user_id, access_token, id_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('acct-google', 'https://accounts.google.com', 'google-subject-42', 'google', memberId, 'at-secret', 'idt-secret', Date.now());

    const methods = await methodsFor(memberId, await signInAs(ADMIN));
    const google = methods.find((m) => m.provider === 'google');
    expect(google?.accountId).toBe('google-subject-42');
    expect(google?.issuer).toBe('https://accounts.google.com');
    expect(JSON.stringify(methods)).not.toContain('at-secret');
    expect(JSON.stringify(methods)).not.toContain('idt-secret');
  });

  it('answers 404 for an id that is nobody, so "no way in" stays a different answer', async () => {
    const admin = await signInAs(ADMIN);
    expect((await adminCall('/users/nobody-at-all/sign-in-methods', admin)).status).toBe(404);

    // A real account with every method removed is an empty list and a 200 — the state the
    // screen tells an operator to fix by setting a password.
    db.prepare('DELETE FROM account WHERE user_id = ?').run(memberId);
    const res = await adminCall(`/users/${memberId}/sign-in-methods`, admin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { methods: WireMethod[] }).methods).toEqual([]);
  });

  /**
   * Not the library's behaviour for its own sake — the shape of the call `app/src/api.ts`
   * makes. `getUser` reads one person through `list-users` with an equality filter on `id`
   * rather than fetching 200 and finding them in the browser, because a pasted `/users/<id>`
   * has to answer for somebody past whatever page the list happens to show. If an upgrade
   * changed these query parameter names the deep link would quietly start rendering "no such
   * user" for people who exist, and nothing else in the suite would notice.
   */
  it('answers one user by id, which is how a deep link resolves the person it names', async () => {
    const cookie = await signInAs(ADMIN);
    const res = await call(
      `/api/auth/admin/list-users?limit=1&filterField=id&filterOperator=eq&filterValue=${memberId}`,
      { headers: { cookie, 'sec-fetch-mode': 'cors' } },
    );
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as { users: { id: string; email: string }[] };
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(memberId);
    expect(users[0]!.email).toBe(MEMBER.email);
  });

  /**
   * The Sessions panel's Revoke button keys on `session.token`, because that is what
   * `revoke-user-session` deletes on — not the `id` the row is otherwise identified by. If the
   * list ever stopped carrying the token the button would post `undefined` and fail silently,
   * leaving an operator believing they had signed somebody out. So both halves are pinned: the
   * token is in the list, and revoking with it actually ends the session.
   *
   * It is also the reason the token is never rendered. It IS the credential — putting it in a
   * table would hand every administrator a way to become anyone they can see.
   */
  it('lists a session with the token its revoke keys on, and revoking with it ends the session', async () => {
    const admin = await signInAs(ADMIN);
    await signInAs(MEMBER);

    const listed = await call(`/api/auth/admin/list-user-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie: admin },
      body: JSON.stringify({ userId: memberId }),
    });
    expect(listed.status).toBe(200);
    const { sessions } = (await listed.json()) as { sessions: { id: string; token: string }[] };
    expect(sessions.length).toBeGreaterThan(0);
    const token = sessions[0]!.token;
    expect(token, 'the list stopped carrying the token Revoke keys on').toBeTruthy();

    const revoked = await call('/api/auth/admin/revoke-user-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie: admin },
      body: JSON.stringify({ sessionToken: token }),
    });
    expect(revoked.status).toBe(200);
    expect(db.prepare('SELECT id FROM session WHERE token = ?').all(token)).toEqual([]);
  });

  it('refuses a signed-in non-administrator, including on their own id', async () => {
    const member = await signInAs(MEMBER);
    expect((await adminCall(`/users/${memberId}/sign-in-methods`, member)).status).toBe(403);
    // And with no session at all.
    expect((await adminCall(`/users/${memberId}/sign-in-methods`, '')).status).toBe(401);
  });
});
