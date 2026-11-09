import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { adminMergeAccounts, mergeAccounts } from '../src/account-merge.js';
import { bankidPlaceholderAddress } from '../src/placeholder-address.js';
import type { BankIdTransport } from '../src/bankid.js';
import type { SqlExec } from '../src/introspect.js';

const ORIGIN = 'http://localhost:8800';
const PNR = '198001019876';
const ANNA = 'anna@example.com';
const PASSWORD = 'correct-horse-battery';

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let mail: MockEmailTransport;
let orders = 0;

const sqlExecOf = (database: Database.Database): SqlExec => ({
  exec(query: string, ...bindings: unknown[]) {
    const stmt = database.prepare(query);
    if (!stmt.reader) {
      stmt.run(...(bindings as []));
      return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
    }
    const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
    return { columnNames: [], toArray: () => objects, raw: () => [][Symbol.iterator]() };
  },
});

/** BankID's RP API, answering every order as complete for `PNR`. */
const transport: BankIdTransport = async (url) => {
  if (url.endsWith('/auth')) {
    orders += 1;
    return { status: 200, body: { orderRef: `order-${orders}`, autoStartToken: 'ast-1', qrStartToken: 'qr-token', qrStartSecret: 'qr-secret' } };
  }
  return {
    status: 200,
    body: {
      orderRef: 'x', status: 'complete',
      completionData: {
        user: { personalNumber: PNR, name: 'Anna Andersson', givenName: 'Anna', surname: 'Andersson' },
        device: { ipAddress: '192.0.2.1' }, signature: 's', ocspResponse: 'o',
      },
    },
  };
};

function rebuild(overrides?: { allowSignup?: boolean; autoLinkAccounts?: boolean }): Auth {
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: mail,
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    ...(overrides?.autoLinkAccounts === false ? { autoLinkAccounts: false } : {}),
    bankid: {
      apiUrl: 'https://bankid.test/rp/v6.0',
      transport,
      allowSignup: overrides?.allowSignup ?? true,
      clientIpHeader: 'x-test-client-ip',
      requireEmail: { merge: (p, o) => db.transaction(() => mergeAccounts(sql, p, o, Date.now()))() },
    },
  });
}

const call = (path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> =>
  auth.handler(new Request(`${ORIGIN}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body ?? {}),
  }) as never);

const cookieOf = (res: Response): string =>
  res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '').filter((p) => !p.endsWith('=')).join('; ');

async function completeOrder(): Promise<Response> {
  const { orderRef } = (await (await call('/bankid/start')).json()) as { orderRef: string };
  return call('/bankid/collect', { orderRef });
}

async function emailStep(): Promise<{ token: string; canSkip: boolean; raw: string }> {
  const res = await completeOrder();
  const raw = await res.text();
  const body = JSON.parse(raw) as { status: string; token: string; canSkip: boolean };
  expect(body.status).toBe('email_required');
  return { ...body, raw };
}

const lastCode = (): string => /\b(\d{6})\b/.exec(mail.sent.at(-1)!.subject)![1]!;

async function prove(token: string, email = ANNA): Promise<Response> {
  expect((await call('/bankid/email/send', { token, email })).status).toBe(200);
  return call('/bankid/email/verify', { token, code: lastCode() });
}

const sessionOf = (res: Response) => auth.api.getSession({ headers: new Headers({ cookie: cookieOf(res) }) as never });
const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const bankidOwner = (): string | undefined =>
  (db.prepare("SELECT user_id FROM account WHERE provider_id = 'bankid' AND account_id = ?").get(PNR) as { user_id: string } | undefined)?.user_id;

/** A person who signed up with an address and a password, verified. */
async function emailAccount(email = ANNA): Promise<string> {
  const { user } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Anna' } });
  db.prepare('UPDATE user SET email_verified = 1 WHERE id = ?').run(user.id);
  return user.id;
}

/** A person from before the step existed: BankID, and a placeholder. */
function placeholderAccount(): string {
  db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('placeholder-user', 'Anna Andersson', ?, 0, 1, 1)").run(bankidPlaceholderAddress());
  db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('bankid-row', ?, 'bankid', 'placeholder-user', 1, 1)").run(PNR);
  return 'placeholder-user';
}

function bindInApp(sub: string, app: string): void {
  db.prepare("INSERT OR IGNORE INTO place_app (app_scope_id, tenant_id, client_id, hostname, name, updated_at) VALUES (?, 'tenant', ?, 'x.test', ?, 1)").run(app, app, app);
  db.prepare('INSERT INTO place_member (sub, app_scope_id) VALUES (?, ?)').run(sub, app);
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  mail = new MockEmailTransport();
  auth = rebuild();
});

describe('a first BankID sign-in', () => {
  it('creates nothing until an address is proven, and keeps the personal number out of the browser', async () => {
    const step = await emailStep();
    expect(step.canSkip).toBe(false);
    expect(step.raw).not.toContain(PNR);
    expect(count('user')).toBe(0);

    const done = await prove(step.token);
    expect(done.status).toBe(200);
    const session = await sessionOf(done);
    expect(session?.user).toMatchObject({ email: ANNA, emailVerified: true, name: 'Anna Andersson' });
    expect((session?.session as unknown as { signInProvider: string }).signInProvider).toBe('bankid');
    expect(bankidOwner()).toBe(session?.user.id);

    expect((await completeOrder()).status).toBe(200);
    expect(count('user')).toBe(1);
  });

  it('joins the account already holding the address, with no second user', async () => {
    const id = await emailAccount();
    const done = await prove((await emailStep()).token);
    expect((await sessionOf(done))?.user.id).toBe(id);
    expect(bankidOwner()).toBe(id);
    expect(count('user')).toBe(1);
  });

  it.each([
    ['another BankID holds the account', () => db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) SELECT 'other', '190001019999', 'bankid', id, 1, 1 FROM user").run()],
    ['the account is an administrator', () => db.prepare("UPDATE user SET role = 'admin'").run()],
    ['the account has an SMS factor', () => db.prepare("UPDATE user SET phone_number = '+46700000000'").run()],
    ['the account never verified its address', () => db.prepare('UPDATE user SET email_verified = 0').run()],
    ['the account is banned', () => db.prepare('UPDATE user SET banned = 1').run()],
    ['ACCOUNT_LINKING is block', () => { auth = rebuild({ autoLinkAccounts: false }); }],
  ])('refuses to join when %s, and the person can prove another address', async (_name, arrange) => {
    await emailAccount();
    arrange();
    const { token } = await emailStep();
    expect((await prove(token)).status).toBe(409);
    expect(bankidOwner()).toBeUndefined();

    const other = await prove(token, 'anna.private@example.com');
    expect((await sessionOf(other))?.user.email).toBe('anna.private@example.com');
  });

  it('creates no account from a free address when account creation is off', async () => {
    auth = rebuild({ allowSignup: false });
    expect((await prove((await emailStep()).token)).status).toBe(403);
    expect(count('user')).toBe(0);
  });

  it('answers the send alike for a taken address and a free one', async () => {
    await emailAccount();
    const { token } = await emailStep();
    const taken = await call('/bankid/email/send', { token, email: ANNA });
    const free = await call('/bankid/email/send', { token, email: 'nobody@example.com' });
    expect([taken.status, await taken.text()]).toEqual([free.status, await free.text()]);
  });

  it('holds the send cooldown, the attempt budget, and a single use', async () => {
    const { token } = await emailStep();
    expect((await call('/bankid/email/send', { token, email: ANNA })).status).toBe(200);
    expect((await call('/bankid/email/send', { token, email: ANNA })).status).toBe(429);

    const wrong = lastCode() === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) expect((await call('/bankid/email/verify', { token, code: wrong })).status).toBe(400);
    expect((await call('/bankid/email/verify', { token, code: lastCode() })).status).toBe(429);
    expect(count('user')).toBe(0);

    const next = await emailStep();
    db.prepare("DELETE FROM verification WHERE identifier LIKE 'bankid-email-send:%'").run();
    expect((await prove(next.token)).status).toBe(200);
    expect((await call('/bankid/email/verify', { token: next.token, code: lastCode() })).status).toBe(400);
  });

  it('refuses a forged pending authorize at the last step, so the resume hooks cover it', async () => {
    const { token } = await emailStep();
    await call('/bankid/email/send', { token, email: ANNA });
    expect((await call('/bankid/email/verify', { token, code: lastCode(), oauth_query: 'client_id=x&sig=forged' })).status).toBe(400);
    expect(count('user')).toBe(0);
  });
});

describe('an account with a placeholder address', () => {
  it('takes a free address and keeps its sub', async () => {
    const id = placeholderAccount();
    const step = await emailStep();
    expect(step.canSkip).toBe(true);
    const session = await sessionOf(await prove(step.token));
    expect(session?.user).toMatchObject({ id, email: ANNA, emailVerified: true });
  });

  it('may put it off three times, and a new person never', async () => {
    const newcomer = await emailStep();
    expect((await call('/bankid/email/skip', { token: newcomer.token })).status).toBe(403);

    const id = placeholderAccount();
    for (let i = 0; i < 3; i++) {
      const { token, canSkip } = await emailStep();
      expect(canSkip).toBe(true);
      expect((await sessionOf(await call('/bankid/email/skip', { token })))?.user.id).toBe(id);
    }
    const { token, canSkip } = await emailStep();
    expect(canSkip).toBe(false);
    expect((await call('/bankid/email/skip', { token })).status).toBe(403);
  });

  it('merges into the account holding the address when the placeholder is bound nowhere', async () => {
    const placeholder = placeholderAccount();
    const id = await emailAccount();
    const { token } = await emailStep();
    const session = await sessionOf(await prove(token));

    expect(session?.user.id).toBe(id);
    expect(bankidOwner()).toBe(id);
    expect(db.prepare('SELECT id FROM user WHERE id = ?').get(placeholder)).toBeUndefined();
    expect((await auth.api.signInEmail({ body: { email: ANNA, password: PASSWORD }, asResponse: true })).status).toBe(200);
  });

  it('keeps the bound sub when only the placeholder is bound, and it takes the address and password', async () => {
    const placeholder = placeholderAccount();
    bindInApp(placeholder, 'ticket0');
    const retired = await emailAccount();
    await auth.api.signInEmail({ body: { email: ANNA, password: PASSWORD } });
    const session = await sessionOf(await prove((await emailStep()).token));

    expect(session?.user).toMatchObject({ id: placeholder, email: ANNA, emailVerified: true });
    expect(db.prepare('SELECT count(*) AS n FROM session WHERE user_id = ?').get(retired)).toEqual({ n: 0 });
    const signIn = await auth.api.signInEmail({ body: { email: ANNA, password: PASSWORD }, asResponse: true });
    expect((await sessionOf(signIn))?.user.id).toBe(placeholder);
  });

  it('refuses when both are bound, names the apps, and changes nothing', async () => {
    const placeholder = placeholderAccount();
    const id = await emailAccount();
    bindInApp(placeholder, 'ticket0');
    bindInApp(id, 'meridian');
    const res = await prove((await emailStep()).token);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/meridian, ticket0/);
    expect(bankidOwner()).toBe(placeholder);
    expect(count('user')).toBe(2);
  });

  it('never makes a retired admin of the survivor', async () => {
    const placeholder = placeholderAccount();
    bindInApp(placeholder, 'ticket0');
    const id = await emailAccount();
    db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(id);
    expect(mergeAccounts(sql, placeholder, id, 1)).toHaveProperty('refused');
    expect(count('user')).toBe(2);
  });
});

describe('connecting BankID from inside an account', () => {
  async function connect(cookie: string): Promise<Response> {
    const { orderRef } = (await (await call('/bankid/start', { link: true }, { cookie })).json()) as { orderRef: string };
    return call('/bankid/collect', { orderRef }, { cookie });
  }

  it('merges a placeholder holding it, even into an account an emailed code may not join', async () => {
    const placeholder = placeholderAccount();
    const id = await emailAccount();
    db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(id);
    const cookie = cookieOf(await auth.api.signInEmail({ body: { email: ANNA, password: PASSWORD }, asResponse: true }));
    const done = await connect(cookie);
    expect(done.status).toBe(200);
    expect(bankidOwner()).toBe(id);
    expect(db.prepare('SELECT id FROM user WHERE id = ?').get(placeholder)).toBeUndefined();
  });

  it('still refuses a BankID on an account with a real address', async () => {
    await emailAccount('first@example.com');
    db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) SELECT 'b', ?, 'bankid', id, 1, 1 FROM user").run(PNR);
    await emailAccount();
    const cookie = cookieOf(await auth.api.signInEmail({ body: { email: ANNA, password: PASSWORD }, asResponse: true }));
    expect((await connect(cookie)).status).toBe(409);
  });
});

describe('an administrator merging two accounts', () => {
  it('moves the BankID onto the account the operator keeps, which keeps its address and password', async () => {
    const placeholder = placeholderAccount();
    const id = await emailAccount();
    expect(adminMergeAccounts(sql, id, placeholder, 1)).toEqual({ survivor: id });
    expect(bankidOwner()).toBe(id);
    expect(count('user')).toBe(1);
    const signIn = await auth.api.signInEmail({ body: { email: ANNA, password: PASSWORD }, asResponse: true });
    expect((await sessionOf(signIn))?.user.id).toBe(id);
  });

  it('gives a kept placeholder the real address, verified only if it was', async () => {
    const placeholder = placeholderAccount();
    const id = await emailAccount();
    db.prepare('UPDATE user SET email_verified = 0 WHERE id = ?').run(id);
    adminMergeAccounts(sql, placeholder, id, 1);
    expect(db.prepare('SELECT email, email_verified FROM user WHERE id = ?').get(placeholder)).toEqual({ email: ANNA, email_verified: 0 });
  });

  it.each([
    ['the merged account is bound in an app', (_keep: string, gone: string) => bindInApp(gone, 'ticket0'), /ticket0/],
    ['the merged account is an admin', (_keep: string, gone: string) => void db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(gone), /administrator/],
    ['both have a password', async (keep: string) => {
      db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('pw2', ?, 'credential', ?, 'x', 1, 1)").run(keep, keep);
    }, /a password/],
    ['both have a BankID', async (_keep: string, gone: string) => {
      db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('b2', '199001011234', 'bankid', ?, 1, 1)").run(gone);
    }, /a BankID/],
  ])('refuses when %s, and changes nothing', async (_name, arrange, message) => {
    const keep = placeholderAccount();
    const gone = await emailAccount();
    await arrange(keep, gone);
    const before = count('account');
    expect(adminMergeAccounts(sql, keep, gone, 1)).toEqual({ refused: expect.stringMatching(message) });
    expect(count('user')).toBe(2);
    expect(count('account')).toBe(before);
  });
});
