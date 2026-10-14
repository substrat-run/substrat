import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
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
import type { ImportResult } from '../src/user-import-wire.js';
import { parseImportFile, unverifiedNotice } from '../app/src/user-import-file.js';

/**
 * Moving people here from another issuer (`src/user-import.ts`).
 *
 * The test that matters is the first one: a person imported with their old issuer's bcrypt
 * hash signs in with the password they already had, and the session that comes back carries
 * the id they were imported under — the `sub` every relying party already knows them by.
 * Everything else is the re-runnable merge and the collisions an import must report rather
 * than resolve.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const MEMBER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'Plain Member' };

let db: Database.Database;
let auth: Auth;
let api: ReturnType<typeof createAdminApi>;
let adminCookie: string;
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

const signIn = (email: string, password: string): Promise<Response> =>
  call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

const importAs = (cookie: string, body: unknown): Promise<Response> =>
  Promise.resolve(
    api.request('http://localhost/users/import', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

async function imported(body: unknown): Promise<ImportResult> {
  const res = await importAs(adminCookie, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ImportResult;
}

const passwordOf = (userId: string): string | null =>
  (
    db.prepare(`SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential'`).get(userId) as
      | { password: string | null }
      | undefined
  )?.password ?? null;

const accountsOf = (userId: string): { provider_id: string; account_id: string }[] =>
  db
    .prepare('SELECT provider_id, account_id FROM account WHERE user_id = ? ORDER BY provider_id')
    .all(userId) as { provider_id: string; account_id: string }[];

const userCount = (): number => (db.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n;

/** Cost 4 — the cheapest bcrypt allows, so the suite stays fast; the scheme is what is under test. */
const bcryptOf = (password: string): string => bcrypt.hashSync(password, 4);

const LEGACY_ID = 'auth2|6512f0c0a1b2c3d4e5f60718';

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  const sql = sqlExecOf(db);
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
    offeredProviders: () => publicProvidersFrom(readProviders(sql)),
    transaction: (fn) => db.transaction(fn)(),
  });
  adminCookie = cookieOf(await signIn(ADMIN.email, ADMIN.password));
});

describe('an imported person signs in with the password they already had', () => {
  it('keeps their old id as the session subject, and refuses a wrong password', async () => {
    const result = await imported({
      users: [{ id: LEGACY_ID, email: 'Ada@Example.test', name: 'Ada', emailVerified: true, passwordHash: bcryptOf('old-password-1') }],
    });
    expect(result.results).toEqual([
      { id: LEGACY_ID, outcome: 'created', password: true, accounts: [], skippedAccounts: [], emailVerified: null },
    ]);

    expect((await signIn('ada@example.test', 'not-it-at-all')).status).toBe(401);

    const ok = await signIn('ada@example.test', 'old-password-1');
    expect(ok.status).toBe(200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieOf(ok) }) as never });
    expect(session?.user.id).toBe(LEGACY_ID);
    expect(session?.user.email).toBe('ada@example.test');
    expect(session?.user.emailVerified).toBe(true);
  });

  it('writes scrypt, not bcrypt, the moment they set a new password', async () => {
    await imported({ users: [{ id: LEGACY_ID, email: 'ada@example.test', passwordHash: bcryptOf('old-password-1') }] });
    const cookie = cookieOf(await signIn('ada@example.test', 'old-password-1'));
    const changed = await call('/api/auth/change-password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ currentPassword: 'old-password-1', newPassword: 'new-password-2' }),
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(passwordOf(LEGACY_ID)).not.toMatch(/^\$2/);
    expect((await signIn('ada@example.test', 'new-password-2')).status).toBe(200);
    expect((await signIn('ada@example.test', 'old-password-1')).status).toBe(401);
  });

  it('leaves passwords set here on scrypt — the members created by sign-up still sign in', async () => {
    expect(passwordOf(memberId)).not.toMatch(/^\$2/);
    expect((await signIn(MEMBER.email, MEMBER.password)).status).toBe(200);
  });
});

describe('upstream identities come along', () => {
  it('stores each as an account row on the imported person', async () => {
    const result = await imported({
      users: [{ id: LEGACY_ID, email: 'ada@example.test', accounts: [{ providerId: 'github', accountId: '1234567' }] }],
    });
    expect(result.results[0]).toMatchObject({ outcome: 'created', password: false, accounts: ['github'] });
    expect(accountsOf(LEGACY_ID)).toEqual([{ provider_id: 'github', account_id: '1234567' }]);
  });

  it('skips one already linked to somebody else, and says to whom', async () => {
    db.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES ('a1', '1234567', 'github', ?, 0)`,
    ).run(memberId);
    const result = await imported({
      users: [{ id: LEGACY_ID, email: 'ada@example.test', accounts: [{ providerId: 'github', accountId: '1234567' }] }],
    });
    expect(result.results[0]).toMatchObject({
      outcome: 'created',
      accounts: [],
      skippedAccounts: [{ providerId: 'github', accountId: '1234567', linkedTo: memberId }],
    });
    expect(accountsOf(LEGACY_ID)).toEqual([]);
  });
});

describe('re-running is safe', () => {
  it('a second identical run changes nothing', async () => {
    const batch = {
      users: [
        {
          id: LEGACY_ID,
          email: 'ada@example.test',
          passwordHash: bcryptOf('old-password-1'),
          accounts: [{ providerId: 'github', accountId: '1234567' }],
        },
      ],
    };
    await imported(batch);
    const again = await imported(batch);
    expect(again.results).toEqual([{ id: LEGACY_ID, outcome: 'unchanged', skippedAccounts: [] }]);
    expect(accountsOf(LEGACY_ID)).toHaveLength(2);
  });

  it('never overwrites a password the person already has here', async () => {
    const result = await imported({ users: [{ id: memberId, email: MEMBER.email, passwordHash: bcryptOf('stale-hash-1') }] });
    expect(result.results[0]).toEqual({ id: memberId, outcome: 'unchanged', skippedAccounts: [] });
    expect((await signIn(MEMBER.email, MEMBER.password)).status).toBe(200);
    expect((await signIn(MEMBER.email, 'stale-hash-1')).status).toBe(401);
  });

  it('fills a credential row that has no hash rather than adding a second one', async () => {
    db.prepare(`UPDATE account SET password = NULL WHERE user_id = ? AND provider_id = 'credential'`).run(memberId);
    const result = await imported({ users: [{ id: memberId, email: MEMBER.email, passwordHash: bcryptOf('restored-pass-1') }] });
    expect(result.results[0]).toMatchObject({ outcome: 'merged', password: true });
    expect(accountsOf(memberId).filter((a) => a.provider_id === 'credential')).toHaveLength(1);
    expect((await signIn(MEMBER.email, 'restored-pass-1')).status).toBe(200);
  });
});

describe('collisions are reported, never resolved', () => {
  it('an address already held under another id is a conflict, and nothing is written', async () => {
    const before = userCount();
    const result = await imported({ users: [{ id: LEGACY_ID, email: MEMBER.email.toUpperCase(), passwordHash: bcryptOf('x-password-1') }] });
    expect(result.results).toEqual([{ id: LEGACY_ID, outcome: 'conflict', reason: 'email-taken', existingId: memberId }]);
    expect(userCount()).toBe(before);
    expect((await signIn(MEMBER.email, MEMBER.password)).status).toBe(200);
  });

  it('an id already here with a different address is a conflict too', async () => {
    const result = await imported({ users: [{ id: memberId, email: 'someone-else@example.test' }] });
    expect(result.results).toEqual([{ id: memberId, outcome: 'conflict', reason: 'email-differs', existingEmail: MEMBER.email }]);
  });
});

describe('dryRun', () => {
  it('answers exactly what the real run does, and writes nothing', async () => {
    const batch = {
      users: [
        { id: LEGACY_ID, email: 'ada@example.test', passwordHash: bcryptOf('old-password-1'), accounts: [{ providerId: 'github', accountId: '1' }] },
        // The same person twice and a second claim on the same GitHub id: a dry run has to see
        // its own planned writes, or it would report two creations the real run never makes.
        { id: LEGACY_ID, email: 'ada@example.test' },
        { id: 'auth2|other', email: 'grace@example.test', accounts: [{ providerId: 'github', accountId: '1' }] },
        { id: 'auth2|third', email: MEMBER.email },
      ],
    };
    const before = userCount();
    const dry = await imported({ ...batch, dryRun: true });
    expect(userCount()).toBe(before);
    expect(db.prepare('SELECT count(*) AS n FROM account WHERE provider_id = ?').get('github')).toEqual({ n: 0 });

    const real = await imported(batch);
    expect(dry.dryRun).toBe(true);
    expect(real.dryRun).toBe(false);
    expect(dry.results).toEqual(real.results);
    expect(real.counts).toEqual({ created: 2, merged: 0, unchanged: 1, conflict: 1 });
  });
});

describe('an address that arrives unverified is counted, and still stored unverified (#1359)', () => {
  const verifiedOf = (id: string): number | undefined =>
    (db.prepare('SELECT email_verified AS v FROM user WHERE id = ?').get(id) as { v: number } | undefined)?.v;

  const mixed = {
    users: [
      { id: 'auth2|yes', email: 'yes@example.test', emailVerified: true },
      { id: 'auth2|no', email: 'no@example.test', emailVerified: false },
      { id: 'auth2|silent', email: 'silent@example.test' },
    ],
  };

  it('a dry run counts no flag apart from false, and the real run reports the same', async () => {
    const dry = await imported({ ...mixed, dryRun: true });
    expect(dry.unverified).toEqual({ unasserted: 1, unverified: 1 });
    expect(dry.results.map((r) => (r.outcome === 'created' ? r.emailVerified : 'not created'))).toEqual([true, false, null]);

    const real = await imported(mixed);
    expect(real.unverified).toEqual(dry.unverified);
    expect(real.results).toEqual(dry.results);
  });

  it('stores exactly what it stored before: true is verified, false and no flag are not', async () => {
    await imported(mixed);
    expect([verifiedOf('auth2|yes'), verifiedOf('auth2|no'), verifiedOf('auth2|silent')]).toEqual([1, 0, 0]);
  });

  it('a file where everyone is verified counts nobody', async () => {
    const all = await imported({ users: [mixed.users[0]!, { id: 'auth2|also', email: 'also@example.test', emailVerified: true }] });
    expect(all.counts.created).toBe(2);
    expect(all.unverified).toEqual({ unasserted: 0, unverified: 0 });
  });

  it('never counts a person merged onto a row already here, whose own flag is kept', async () => {
    await imported({ users: [mixed.users[0]!] });
    // The second run carries no flag, but the person is already here — verified — and stays so.
    const again = await imported({ users: [{ id: 'auth2|yes', email: 'yes@example.test', passwordHash: bcryptOf('pw-123456') }] });
    expect(again.counts).toMatchObject({ created: 0, merged: 1 });
    expect(again.unverified).toEqual({ unasserted: 0, unverified: 0 });
    expect(verifiedOf('auth2|yes')).toBe(1);
  });

  it('an export with no email_verified column arrives as people with no flag, every one counted', async () => {
    const { users } = parseImportFile('export.csv', 'user_id,email\nauth2|a,a@example.test\nauth2|b,b@example.test');
    const dry = await imported({ users, dryRun: true });
    expect(dry.unverified).toEqual({ unasserted: 2, unverified: 0 });
    expect(unverifiedNotice(dry)[0]).toMatch(/^2 of the 2 new people have no email_verified in the file/);
  });
});

describe('the gate and the shape', () => {
  it('refuses anybody but an administrator', async () => {
    const memberCookie = cookieOf(await signIn(MEMBER.email, MEMBER.password));
    const res = await importAs(memberCookie, { users: [{ id: LEGACY_ID, email: 'ada@example.test' }] });
    expect(res.status).toBe(403);
    expect(userCount()).toBe(2);
  });

  it('refuses a hash it could never verify, naming the field', async () => {
    const res = await importAs(adminCookie, { users: [{ id: LEGACY_ID, email: 'ada@example.test', passwordHash: 'sha256$abc' }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/users\.0\.passwordHash/);
    expect(userCount()).toBe(2);
  });

  it('refuses a credential smuggled in as an upstream account', async () => {
    const res = await importAs(adminCookie, {
      users: [{ id: LEGACY_ID, email: 'ada@example.test', accounts: [{ providerId: 'credential', accountId: LEGACY_ID }] }],
    });
    expect(res.status).toBe(400);
  });
});

describe('a real batch commits whole or not at all', () => {
  it('a row that throws past the checks takes the rows before it with it', async () => {
    // Something no pre-check can see: the database itself refusing the third person.
    db.exec(`CREATE TRIGGER refuse_third BEFORE INSERT ON user WHEN NEW.email = 'third@example.test'
             BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
    const before = userCount();
    const res = await importAs(adminCookie, {
      users: [
        { id: 'auth2|one', email: 'one@example.test', passwordHash: bcryptOf('one-password-1') },
        { id: 'auth2|two', email: 'two@example.test', accounts: [{ providerId: 'github', accountId: '2' }] },
        { id: 'auth2|three', email: 'third@example.test' },
      ],
    });
    expect(res.status).not.toBe(200);
    expect(userCount()).toBe(before);
    expect(db.prepare(`SELECT count(*) AS n FROM account WHERE user_id IN ('auth2|one', 'auth2|two')`).get()).toEqual({ n: 0 });
  });
});

describe('batch limits', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `auth2|${i}`, email: `p${i}@example.test` }));

  it('checks a whole file in one dry run, so a duplicate 540 rows apart is seen', async () => {
    const users = many(600);
    users[550] = { id: 'auth2|10', email: 'p10@example.test' };
    const dry = await imported({ users, dryRun: true });
    expect(dry.results[550]).toEqual({ id: 'auth2|10', outcome: 'unchanged', skippedAccounts: [] });
    expect(dry.counts).toEqual({ created: 599, merged: 0, unchanged: 1, conflict: 0 });
  });

  it('refuses a real run over the write batch size', async () => {
    const res = await importAs(adminCookie, { users: many(501) });
    expect(res.status).toBe(400);
    expect(userCount()).toBe(2);
  });
});

it('refuses a bcrypt cost the issuer could not afford to verify', async () => {
  const cost13 = `$2b$13$${bcrypt.hashSync('x-password-1', 4).slice('$2b$04$'.length)}`;
  const res = await importAs(adminCookie, { users: [{ id: LEGACY_ID, email: 'ada@example.test', passwordHash: cost13 }] });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(/cost 4–12/);
  expect(userCount()).toBe(2);
});
