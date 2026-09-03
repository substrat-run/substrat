import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import {
  animatedQr,
  bankIdApiUrl,
  deleteBankIdConfig,
  publicBankIdFrom,
  putBankIdConfig,
  readBankIdConfig,
  toWireBankId,
  type BankIdConfig,
  type BankIdTransport,
} from '../src/bankid.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * BankID sign-in — the QR computation, the stored configuration, and the flow.
 *
 * The QR test pins BankID's OWN documented example, because the HMAC recipe is the part a
 * refactor could silently break while every self-consistent test stayed green: a wrong frame
 * scans as garbage in the real app and nothing here would say so.
 *
 * The flow tests drive the real Better Auth instance over a FAKE transport — the runtime seam
 * is exactly the mTLS call, so everything above it (order bookkeeping, identity mapping,
 * session issuance, the sign-up and ban gates) is provable without BankID's servers. What the
 * fake cannot prove is the certificate handshake itself; that is the test-portal walk in
 * `spec/concept.md`.
 */

const ORIGIN = 'http://localhost:8877';
const API_URL = 'https://bankid.fake/rp/v6.0';
const ORDER_REF = 'order-1111-2222';
const QR_TOKEN = '67df3917-fa0d-44e5-b327-edcc928297f8';
const QR_SECRET = 'd28db9a7-4cde-429e-a983-359be676944c';
const PNR = '198001019876';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };

const PEM_CERT = '-----BEGIN CERTIFICATE-----\nMIIB-test\n-----END CERTIFICATE-----';
const PEM_KEY = '-----BEGIN PRIVATE KEY-----\nMIIE-test\n-----END PRIVATE KEY-----';

const COMPLETE = {
  orderRef: ORDER_REF,
  status: 'complete',
  completionData: {
    user: { personalNumber: PNR, name: 'Anna Andersson', givenName: 'Anna', surname: 'Andersson' },
    device: { ipAddress: '192.0.2.1' },
    signature: 'base64…',
    ocspResponse: 'base64…',
  },
};

/** A scripted BankID: `/auth` always succeeds, `/collect` answers whatever the test set. */
function fakeBankId() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let collect: { status: number; body: unknown } = {
    status: 200,
    body: { orderRef: ORDER_REF, status: 'pending', hintCode: 'outstandingTransaction' },
  };
  const transport: BankIdTransport = async (url, body) => {
    calls.push({ url, body: body as Record<string, unknown> });
    if (url === `${API_URL}/auth`) {
      return {
        status: 200,
        body: { orderRef: ORDER_REF, autoStartToken: 'ast-1', qrStartToken: QR_TOKEN, qrStartSecret: QR_SECRET },
      };
    }
    if (url === `${API_URL}/collect`) return collect;
    if (url === `${API_URL}/cancel`) return { status: 200, body: {} };
    return { status: 404, body: undefined };
  };
  return {
    transport,
    calls,
    setCollect(body: unknown, status = 200) {
      collect = { status, body };
    },
  };
}

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let bankid: ReturnType<typeof fakeBankId>;

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

function rebuild(overrides?: { allowSignup?: boolean; mounted?: boolean; issuerSignup?: boolean }): Auth {
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: overrides?.issuerSignup ?? false,
    ...(overrides?.mounted === false
      ? {}
      : {
          bankid: {
            apiUrl: API_URL,
            transport: bankid.transport,
            allowSignup: overrides?.allowSignup ?? true,
            clientIpHeader: 'x-test-client-ip',
          },
        }),
  });
}

const call = (path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> =>
  auth.handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    }) as never,
  );

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

async function startOrder(): Promise<{ orderRef: string; autoStartUrl: string; qr: string }> {
  const res = await call('/api/auth/bankid/start');
  expect(res.status).toBe(200);
  return (await res.json()) as { orderRef: string; autoStartUrl: string; qr: string };
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  bankid = fakeBankId();
  auth = rebuild();
});

describe('the animated QR code', () => {
  it("matches BankID's documented example, frame by frame", async () => {
    // The worked example from the RP integration guide — the one external truth available
    // without a certificate. If this fails, real BankID apps scan garbage.
    expect(await animatedQr(QR_TOKEN, QR_SECRET, 0)).toBe(
      `bankid.${QR_TOKEN}.0.dc69358e712458a66a7525beef148ae8526b1c71610eff2c16cdffb4cdac9bf8`,
    );
    // Later frames change: the time is the HMAC input, which is what makes the code die
    // with the order instead of being a static picture.
    const [one, two] = await Promise.all([animatedQr(QR_TOKEN, QR_SECRET, 1), animatedQr(QR_TOKEN, QR_SECRET, 2)]);
    expect(one).not.toBe(two);
    expect(one).toMatch(new RegExp(`^bankid\\.${QR_TOKEN}\\.1\\.[0-9a-f]{64}$`));
  });
});

describe('the stored configuration', () => {
  const input = { environment: 'test' as const, clientCert: PEM_CERT, clientKey: PEM_KEY, allowSignup: true, disabled: false };

  it('round-trips, and an edit without PEMs keeps the stored ones', () => {
    putBankIdConfig(sql, input);
    expect(readBankIdConfig(sql)).toMatchObject({ environment: 'test', clientCert: PEM_CERT, clientKey: PEM_KEY });

    putBankIdConfig(sql, { environment: 'production', allowSignup: false, disabled: true }, readBankIdConfig(sql));
    expect(readBankIdConfig(sql)).toMatchObject({
      environment: 'production',
      clientCert: PEM_CERT,
      clientKey: PEM_KEY,
      allowSignup: false,
      disabled: true,
    });

    deleteBankIdConfig(sql);
    expect(readBankIdConfig(sql)).toBeUndefined();
  });

  it('refuses a first save without both PEMs', () => {
    expect(() => putBankIdConfig(sql, { environment: 'test', clientCert: PEM_CERT, allowSignup: true, disabled: false })).toThrow();
  });

  it('never puts key material on the wire', () => {
    const cfg = putBankIdConfig(sql, input);
    const wire = JSON.stringify(toWireBankId(cfg));
    expect(wire).not.toContain('BEGIN');
    expect(toWireBankId(cfg)).toMatchObject({ environment: 'test', certSet: true, caSet: false });
  });

  it('offers the login button only when configured, enabled AND the runtime can present the cert', () => {
    expect(publicBankIdFrom(undefined, true)).toBeUndefined();
    const cfg = putBankIdConfig(sql, input);
    expect(publicBankIdFrom(cfg, true)).toEqual({ id: 'bankid', label: 'BankID' });
    // A worker with no mTLS binding must not draw a button that starts an unfinishable flow.
    expect(publicBankIdFrom(cfg, false)).toBeUndefined();
    expect(publicBankIdFrom({ ...cfg, disabled: true }, true)).toBeUndefined();
  });

  it('addresses the right API per environment', () => {
    expect(bankIdApiUrl('test')).toBe('https://appapi2.test.bankid.com/rp/v6.0');
    expect(bankIdApiUrl('production')).toBe('https://appapi2.bankid.com/rp/v6.0');
  });
});

describe('the admin surface', () => {
  let api: ReturnType<typeof createAdminApi>;
  let adminCookie: string;

  beforeEach(async () => {
    // The fixture administrator is created through sign-up, so this instance needs it open —
    // the issuer-wide toggle, not BankID's.
    auth = rebuild({ issuerSignup: true });
    const created = await auth.api.signUpEmail({ body: ADMIN });
    db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
    const signIn = await auth.api.signInEmail({ body: ADMIN, asResponse: true });
    adminCookie = cookieOf(signIn);
    const session = (headers: Headers): Promise<SessionSubject | null> =>
      auth.api.getSession({ headers: headers as never }).then((s) => {
        const u = s?.user as { id: string; role?: string } | undefined;
        return u ? { sub: u.id, email: null, name: null, role: u.role ?? null } : null;
      });
    api = createAdminApi({ sql, session, effectiveCfg: () => ({}), auth: () => auth.api as never });
  });

  const adminCall = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      api.request(`http://localhost${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', cookie: adminCookie, ...init?.headers },
      }),
    );

  it('enables BankID, edits without re-pasting PEMs, and removes it', async () => {
    expect(((await (await adminCall('/bankid')).json()) as { bankid: unknown }).bankid).toBeNull();

    const enabled = await adminCall('/bankid', {
      method: 'PUT',
      body: JSON.stringify({ environment: 'test', clientCert: PEM_CERT, clientKey: PEM_KEY, allowSignup: true, disabled: false }),
    });
    expect(enabled.status).toBe(201);
    expect(JSON.stringify(await enabled.json())).not.toContain('BEGIN');

    const edited = await adminCall('/bankid', {
      method: 'PUT',
      body: JSON.stringify({ environment: 'production', allowSignup: false, disabled: false }),
    });
    expect(edited.status).toBe(200);
    expect(readBankIdConfig(sql)).toMatchObject({ environment: 'production', clientCert: PEM_CERT });

    expect((await adminCall('/bankid', { method: 'DELETE' })).status).toBe(200);
    expect(readBankIdConfig(sql)).toBeUndefined();
    expect((await adminCall('/bankid', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a first save without PEMs, and refuses anonymously', async () => {
    const bare = await adminCall('/bankid', {
      method: 'PUT',
      body: JSON.stringify({ environment: 'test', allowSignup: true, disabled: false }),
    });
    expect(bare.status).toBe(400);
    const anon = await api.request('http://localhost/bankid');
    expect(anon.status).toBe(401);
  });

  it('refuses half a credential — a new cert with the old key would fail only at the next handshake', async () => {
    await adminCall('/bankid', {
      method: 'PUT',
      body: JSON.stringify({ environment: 'test', clientCert: PEM_CERT, clientKey: PEM_KEY, allowSignup: true, disabled: false }),
    });
    for (const half of [{ clientCert: '-----BEGIN CERTIFICATE-----\nnew\n-----END CERTIFICATE-----' }, { clientKey: '-----BEGIN PRIVATE KEY-----\nnew\n-----END PRIVATE KEY-----' }]) {
      const res = await adminCall('/bankid', {
        method: 'PUT',
        body: JSON.stringify({ environment: 'test', allowSignup: true, disabled: false, ...half }),
      });
      expect(res.status).toBe(400);
    }
    // The stored pair is untouched by either refusal.
    expect(readBankIdConfig(sql)).toMatchObject({ clientCert: PEM_CERT, clientKey: PEM_KEY });
  });
});

describe('the sign-in flow', () => {
  it('starts an order, forwarding only the IP the runtime vouches for', async () => {
    // `x-forwarded-for` arrives too and must be IGNORED: a caller who can choose the
    // address this issuer reports to BankID is polluting their fraud signal at will.
    const started = await call('/api/auth/bankid/start', {}, {
      'x-test-client-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.99',
    });
    expect(started.status).toBe(200);
    const body = (await started.json()) as { orderRef: string; autoStartUrl: string; qr: string };
    expect(body.orderRef).toBe(ORDER_REF);
    expect(body.autoStartUrl).toBe('bankid:///?autostarttoken=ast-1&redirect=null');
    expect(body.qr).toBe(await animatedQr(QR_TOKEN, QR_SECRET, 0));
    expect(bankid.calls[0]).toEqual({ url: `${API_URL}/auth`, body: { endUserIp: '203.0.113.7' } });
  });

  it('serves fresh QR frames for a live order, and refuses an unknown one', async () => {
    const { orderRef } = await startOrder();
    const res = await call('/api/auth/bankid/qr', { orderRef });
    expect(res.status).toBe(200);
    const { qr } = (await res.json()) as { qr: string };
    // The frame is time-dependent, so recompute for the second it names rather than pin one.
    const seconds = Number(qr.split('.')[2]);
    expect(qr).toBe(await animatedQr(QR_TOKEN, QR_SECRET, seconds));

    expect((await call('/api/auth/bankid/qr', { orderRef: 'not-ours' })).status).toBe(404);
  });

  it('refuses to poll an order it never started — this issuer is not a BankID proxy', async () => {
    const res = await call('/api/auth/bankid/collect', { orderRef: 'someone-elses-order' });
    expect(res.status).toBe(404);
    expect(bankid.calls).toEqual([]);
  });

  it('reports a pending order with its hint, then signs the verified person in on completion', async () => {
    const { orderRef } = await startOrder();

    const pending = await call('/api/auth/bankid/collect', { orderRef });
    expect(await pending.json()).toEqual({ status: 'pending', hintCode: 'outstandingTransaction' });

    bankid.setCollect(COMPLETE);
    const complete = await call('/api/auth/bankid/collect', { orderRef });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ status: 'complete', hintCode: null });

    // The response IS the sign-in: its cookie resolves to a session for the verified person.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieOf(complete) }) as never });
    expect(session?.user.name).toBe('Anna Andersson');

    // The identity key is the personal number, under the bankid provider — sign in twice,
    // land in the same account.
    const account = db
      .prepare('SELECT issuer, account_id, user_id FROM account WHERE provider_id = ?')
      .get('bankid') as { issuer: string; account_id: string; user_id: string };
    expect(account).toMatchObject({ issuer: 'local:bankid', account_id: PNR });
    expect(session?.user.id).toBe(account.user_id);

    // The order is spent: no more frames, no more polls.
    expect((await call('/api/auth/bankid/qr', { orderRef })).status).toBe(404);
  });

  it('lands a returning personal number in the same account, not a second one', async () => {
    bankid.setCollect(COMPLETE);
    const first = await call('/api/auth/bankid/collect', { orderRef: (await startOrder()).orderRef });
    expect(first.status).toBe(200);
    const second = await call('/api/auth/bankid/collect', { orderRef: (await startOrder()).orderRef });
    expect(second.status).toBe(200);
    expect((db.prepare("SELECT count(*) AS n FROM account WHERE provider_id = 'bankid'").get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n).toBe(1);
  });

  it('refuses an unknown personal number when account creation is off', async () => {
    auth = rebuild({ allowSignup: false });
    const { orderRef } = await startOrder();
    bankid.setCollect(COMPLETE);
    const res = await call('/api/auth/bankid/collect', { orderRef });
    expect(res.status).toBe(403);
    expect((db.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n).toBe(0);
  });

  it('refuses a banned user despite a completed order — the ban is on the session, not the password', async () => {
    bankid.setCollect(COMPLETE);
    expect((await call('/api/auth/bankid/collect', { orderRef: (await startOrder()).orderRef })).status).toBe(200);
    db.prepare('UPDATE user SET banned = 1').run();
    const res = await call('/api/auth/bankid/collect', { orderRef: (await startOrder()).orderRef });
    expect(res.status).toBe(403);
  });

  it('relays a failed order with its hint and forgets it', async () => {
    const { orderRef } = await startOrder();
    bankid.setCollect({ orderRef: ORDER_REF, status: 'failed', hintCode: 'expiredTransaction' });
    expect(await (await call('/api/auth/bankid/collect', { orderRef })).json()).toEqual({
      status: 'failed',
      hintCode: 'expiredTransaction',
    });
    expect((await call('/api/auth/bankid/qr', { orderRef })).status).toBe(404);
  });

  it('cancels an abandoned order at BankID and locally', async () => {
    const { orderRef } = await startOrder();
    expect((await call('/api/auth/bankid/cancel', { orderRef })).status).toBe(200);
    expect(bankid.calls.map((c) => c.url)).toContain(`${API_URL}/cancel`);
    expect((await call('/api/auth/bankid/qr', { orderRef })).status).toBe(404);
  });

  it("hands a BankID refusal on with its error code, not a stack trace", async () => {
    const { orderRef } = await startOrder();
    bankid.setCollect({ errorCode: 'invalidParameters', details: 'orderRef mismatch' }, 400);
    const res = await call('/api/auth/bankid/collect', { orderRef });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('invalidParameters');
  });

  it("engages oauthProvider's resume hooks: a forged pending authorize is refused before BankID is called", async () => {
    // The before-hook verifies `oauth_query`'s signature on ANY endpoint body that carries
    // one — this proves BankID's collect is inside that contract (the resume path), without
    // driving a whole OIDC round-trip here.
    const { orderRef } = await startOrder();
    const calls = bankid.calls.length;
    const res = await call('/api/auth/bankid/collect', { orderRef, oauth_query: 'client_id=x&sig=forged' });
    expect(res.status).toBe(400);
    expect(bankid.calls.length).toBe(calls);
  });

  it('does not exist on an issuer with no BankID mounted', async () => {
    auth = rebuild({ mounted: false });
    expect((await call('/api/auth/bankid/start')).status).toBe(404);
  });
});
