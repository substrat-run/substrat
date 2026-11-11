import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { JSONWebKeySet } from 'jose';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import type { BankIdTransport } from '../src/bankid.js';
import { MACHINE_SCOPES, machineScopesOf } from '../src/settings.js';
import { signInLoggerFor } from '../src/sign-in-log.js';
import { BANKID_SCHEMA, DRY_RUN_HEADER, ensureScimResource, scimApp, scimAudience, scimTokenVerifier } from '../src/scim.js';
import { normalizePersonalNumber } from '../src/personal-number.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * The SCIM server (#2941, `src/scim.ts`): an identity master provisions people ahead of their
 * first sign-in, BankID attached, and nothing it does can take over an account it did not make.
 *
 * Composed the way both runtimes compose it: the plugin's own token endpoint mints the machine
 * token for the SCIM audience, and `scimApp` verifies it against the JWKS the plugin publishes.
 * Better Auth is rebuilt per request, so changing `cfg` between two calls is an operator changing
 * `MACHINE_SCOPES` between two requests. Open sign-up is OFF throughout, for the issuer and for
 * BankID, except to seat the first administrator.
 */

const ORIGIN = 'http://localhost:8877';
const AUDIENCE = scimAudience(ORIGIN);
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const BANKID_API = 'https://bankid.fake/rp/v6.0';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const BULK = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';

/** A valid twelve-digit personal number for a date and a three-digit serial: the check digit computed. */
function pnr(date: string, serial: string): string {
  for (let c = 0; c <= 9; c++) {
    const candidate = `${date}${serial}${c}`;
    if (!('refused' in normalizePersonalNumber(candidate))) return candidate;
  }
  throw new Error('unreachable');
}
const ANNA = pnr('19800101', '238');
const BERTIL = pnr('19750615', '111');

let db: Database.Database;
let sql: SqlExec;
let cfg: Record<string, string | undefined>;
let adminId: string;
let collectFor: string;

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

/** A scripted BankID whose every order completes for the person `collectFor` names. */
const bankidTransport: BankIdTransport = async (url) => {
  if (url === `${BANKID_API}/auth`) {
    return { status: 200, body: { orderRef: 'order-1', autoStartToken: 'ast', qrStartToken: 'qr', qrStartSecret: 'secret' } };
  }
  if (url === `${BANKID_API}/collect`) {
    return {
      status: 200,
      body: { orderRef: 'order-1', status: 'complete', completionData: { user: { personalNumber: collectFor, name: 'Anna Andersson', givenName: 'Anna', surname: 'Andersson' } } },
    };
  }
  return { status: 404, body: undefined };
};

const machineScopes = (): string[] => machineScopesOf(cfg[MACHINE_SCOPES]).scopes;

const authNow = (allowSignup = false): Auth =>
  buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup,
    machineScopes: machineScopes(),
    recordSignIn: signInLoggerFor(sql),
    bankid: { apiUrl: BANKID_API, transport: bankidTransport, allowSignup: false, clientIpHeader: 'x-test-client-ip' },
  });

const call = (path: string, init?: RequestInit): Promise<Response> => authNow().handler(new Request(`${ORIGIN}${path}`, init) as never);

const postJson = (path: string, body: unknown): Promise<Response> =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** `{method} /scim/v2{path}`, as both runtimes serve it. */
async function scim(path: string, token: string | undefined, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const auth = authNow();
  const app = scimApp({
    sql,
    verify: scimTokenVerifier(async () => (await auth.handler(new Request(`${ORIGIN}/api/auth/jwks`) as never)).json() as Promise<JSONWebKeySet>, ORIGIN),
    machineScopes,
    issuer: ORIGIN,
    transaction: (fn) => db.transaction(fn)(),
  });
  return app.request(`${ORIGIN}/scim/v2${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/scim+json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function adminHeaders(): Promise<Headers> {
  const res = await postJson('/api/auth/sign-in/email', ADMIN);
  const headers = new Headers();
  for (const c of res.headers.getSetCookie()) headers.append('cookie', c.split(';')[0] ?? '');
  return headers;
}

async function machineClient(scopes: string[]): Promise<{ clientId: string; clientSecret: string }> {
  const created = (await authNow().api.adminCreateOAuthClient({
    headers: await adminHeaders(),
    body: {
      client_name: 'Staff Portal',
      application_type: 'web',
      grant_types: ['client_credentials'],
      token_endpoint_auth_method: 'client_secret_basic',
      client_credentials_scopes: scopes,
    },
  } as never)) as unknown as { client_id: string; client_secret: string };
  return { clientId: created.client_id, clientSecret: created.client_secret };
}

function tokenRequest(clientId: string, clientSecret: string): Promise<Response> {
  ensureScimResource(sql, ORIGIN, machineScopes());
  return call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', resource: AUDIENCE }).toString(),
  });
}

/** A provisioning token for a fresh machine client holding `users:provision`. */
async function provisioner(): Promise<{ token: string; clientId: string }> {
  const { clientId, clientSecret } = await machineClient(['users:provision']);
  const res = await tokenRequest(clientId, clientSecret);
  expect(res.status).toBe(200);
  return { token: ((await res.json()) as { access_token: string }).access_token, clientId };
}

/** A BankID sign-in by `personalNumber`, all the way to a session; the session's `sub`. */
async function bankidSignIn(personalNumber: string): Promise<string | undefined> {
  collectFor = personalNumber;
  const started = (await (await postJson('/api/auth/bankid/start', {})).json()) as { orderRef: string };
  const complete = await postJson('/api/auth/bankid/collect', { orderRef: started.orderRef });
  const cookie = complete.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const session = await authNow().api.getSession({ headers: new Headers({ cookie }) as never });
  return session?.user.id;
}

const member = (userName: string, extra: Record<string, unknown> = {}) => ({ schemas: [USER, BANKID_SCHEMA], userName, ...extra });
const counts = () =>
  Object.fromEntries(['user', 'scim_user', 'account', 'session'].map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]));

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  cfg = { [MACHINE_SCOPES]: 'users:provision' };
  // The first administrator is the one account created with sign-up open.
  adminId = (await authNow(true).api.signUpEmail({ body: ADMIN })).user.id;
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(adminId);
});

describe('provisioning a BankID member ahead of their first sign-in', () => {
  it('creates the account with the BankID attached, and the first BankID sign-in lands on its sub with sign-up closed', async () => {
    const { token } = await provisioner();
    const res = await scim('/Users', token, {
      method: 'POST',
      // A board member with no address: named by the master's own id, never their number.
      body: member('member-42', { externalId: 'p-42', name: { givenName: 'Anna', familyName: 'Andersson' }, [BANKID_SCHEMA]: { personalNumber: ANNA } }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/scim+json');
    const text = await res.text();
    expect(text).not.toContain(ANNA);
    const created = JSON.parse(text) as Record<string, unknown>;
    expect(created).toEqual({
      schemas: [USER, BANKID_SCHEMA],
      id: expect.any(String),
      externalId: 'p-42',
      userName: 'member-42',
      name: { formatted: 'Anna Andersson', givenName: 'Anna', familyName: 'Andersson' },
      displayName: 'Anna Andersson',
      active: true,
      [BANKID_SCHEMA]: { linked: true },
      meta: { resourceType: 'User', created: expect.any(String), lastModified: expect.any(String), location: `${AUDIENCE}/Users/${created.id as string}` },
    });
    expect(res.headers.get('location')).toBe(`${AUDIENCE}/Users/${created.id as string}`);

    expect(await bankidSignIn(ANNA)).toBe(created.id);
    // Found again by every lookup a master makes before it creates.
    for (const filter of ['userName eq "MEMBER-42"', 'externalId eq "p-42"']) {
      const found = (await (await scim(`/Users?filter=${encodeURIComponent(filter)}`, token)).json()) as { totalResults: number; Resources: { id: string }[] };
      expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: created.id }] });
    }
  });

  it('stores a claimed address unverified, and finds the person by it', async () => {
    const { token } = await provisioner();
    const created = (await (await scim('/Users', token, {
      method: 'POST',
      body: member('bertil@example.se', { emails: [{ value: 'Bertil@Example.se', type: 'work', primary: true }], [BANKID_SCHEMA]: { personalNumber: BERTIL } }),
    })).json()) as { id: string; emails: unknown };
    expect(created.emails).toEqual([{ value: 'bertil@example.se', type: 'work', primary: true }]);
    expect(db.prepare('SELECT email_verified FROM user WHERE id = ?').get(created.id)).toEqual({ email_verified: 0 });
    const found = (await (await scim(`/Users?filter=${encodeURIComponent('emails.value eq "bertil@example.se"')}`, token)).json()) as { Resources: { id: string }[] };
    expect(found.Resources.map((r) => r.id)).toEqual([created.id]);
  });
});

describe('conflicts are reported, never resolved', () => {
  it('refuses an address or a personal number another account holds, with 409 uniqueness and no writes', async () => {
    const { token } = await provisioner();
    // Someone already signed in with this BankID on their own account.
    db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a1', ?, 'bankid', ?, 1, 1)").run(ANNA, adminId);
    const before = counts();
    const takenEmail = await scim('/Users', token, { method: 'POST', body: member('x', { emails: [{ value: ADMIN.email }] }) });
    const takenNumber = await scim('/Users', token, { method: 'POST', body: member('y', { [BANKID_SCHEMA]: { personalNumber: ANNA } }) });
    // The administrator signed up, so SCIM names them by their address; no address is sent here.
    const takenName = await scim('/Users', token, { method: 'POST', body: member(ADMIN.email.toUpperCase(), { [BANKID_SCHEMA]: { personalNumber: BERTIL } }) });
    for (const [res, detail] of [
      [takenName, 'userName is already in use'],
      [takenEmail, 'That email address belongs to another account'],
      [takenNumber, 'That personal number belongs to another account'],
    ] as const) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '409', scimType: 'uniqueness', detail });
    }
    expect(counts()).toEqual(before);
    expect(db.prepare("SELECT user_id FROM account WHERE provider_id = 'bankid'").all()).toEqual([{ user_id: adminId }]);
  });

  it('never writes to an account it did not provision: one that signed up, or another client’s', async () => {
    const { token } = await provisioner();
    const other = await provisioner();
    const theirs = (await (await scim('/Users', other.token, { method: 'POST', body: member('theirs', { emails: [{ value: 'theirs@example.se' }] }) })).json()) as { id: string };
    const takeover = { schemas: [PATCH], Operations: [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'attacker@example.se' }] };
    for (const id of [adminId, theirs.id]) {
      expect((await scim(`/Users/${id}`, token, { method: 'PATCH', body: takeover })).status).toBe(403);
      expect((await scim(`/Users/${id}`, token, { method: 'DELETE' })).status).toBe(403);
      // Reads are open: the master can see whom it collides with.
      expect((await scim(`/Users/${id}`, token)).status).toBe(200);
    }
    expect(db.prepare("SELECT count(*) AS n FROM user WHERE email = 'attacker@example.se'").get()).toEqual({ n: 0 });
  });

  it('refuses a personal number as a userName, and a malformed one, without echoing it', async () => {
    const { token } = await provisioner();
    const asName = await scim('/Users', token, { method: 'POST', body: member(ANNA, { [BANKID_SCHEMA]: { personalNumber: ANNA } }) });
    const badCheck = await scim('/Users', token, { method: 'POST', body: member('z', { [BANKID_SCHEMA]: { personalNumber: `${ANNA.slice(0, 11)}${(Number(ANNA[11]) + 1) % 10}` } }) });
    for (const res of [asName, badCheck]) {
      expect(res.status).toBe(400);
      expect(await res.text()).not.toMatch(/\d{10}/);
    }
  });
});

describe('Bulk and dry run', () => {
  const operations = [
    { method: 'POST', bulkId: 'anna', path: '/Users', data: member('anna@example.se', { emails: [{ value: 'anna@example.se' }], [BANKID_SCHEMA]: { personalNumber: ANNA } }) },
    // The same address as the operation above: a conflict only this request's own writes cause.
    { method: 'POST', bulkId: 'dup', path: '/Users', data: member('anna-again', { emails: [{ value: 'anna@example.se' }] }) },
    { method: 'PATCH', path: '/Users/bulkId:anna', data: { schemas: [PATCH], Operations: [{ op: 'replace', path: 'displayName', value: 'Anna A.' }] } },
    { method: 'POST', bulkId: 'bad', path: '/Users', data: member('bertil', { [BANKID_SCHEMA]: { personalNumber: '19750615-0000' } }) },
  ];
  const statuses = (body: { Operations: { status: string }[] }) => body.Operations.map((o) => o.status);

  it('reports each operation on its own, a conflict inside the batch included', async () => {
    const { token } = await provisioner();
    const res = await scim('/Bulk', token, { method: 'POST', body: { schemas: [BULK], Operations: operations } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Operations: { status: string; bulkId?: string; location?: string; response?: Record<string, unknown> }[] };
    expect(statuses(body)).toEqual(['201', '409', '200', '400']);
    expect(body.Operations[1]!.response).toMatchObject({ scimType: 'uniqueness' });
    const anna = body.Operations[0]!.response as { id: string };
    expect(body.Operations[0]!.location).toBe(`${AUDIENCE}/Users/${anna.id}`);
    expect(body.Operations[2]!.response).toMatchObject({ id: anna.id, displayName: 'Anna A.' });
    expect(db.prepare("SELECT count(*) AS n FROM scim_user").get()).toEqual({ n: 1 });
  });

  it('stops after failOnErrors errors', async () => {
    const { token } = await provisioner();
    const body = (await (await scim('/Bulk', token, { method: 'POST', body: { schemas: [BULK], failOnErrors: 1, Operations: operations } })).json()) as {
      Operations: { status: string }[];
    };
    expect(statuses(body)).toEqual(['201', '409']);
  });

  it('answers a dry run exactly as the real run would, with no id, and writes nothing', async () => {
    const { token } = await provisioner();
    const before = counts();
    const dry = await scim('/Bulk?dryRun=true', token, { method: 'POST', body: { schemas: [BULK], Operations: operations } });
    expect(dry.headers.get(DRY_RUN_HEADER)).toBe('true');
    const body = (await dry.json()) as { Operations: { status: string; location?: string; response?: Record<string, unknown> }[] };
    expect(statuses(body)).toEqual(['201', '409', '200', '400']);
    expect(body.Operations[0]).not.toHaveProperty('location');
    expect(body.Operations[0]!.response).not.toHaveProperty('id');
    const single = await scim('/Users?dryRun=true', token, { method: 'POST', body: member('solo', { emails: [{ value: 'solo@example.se' }] }) });
    expect(single.status).toBe(201);
    expect(await single.json()).not.toHaveProperty('id');
    expect(counts()).toEqual(before);
  });
});

describe('deactivation', () => {
  it('blocks the account and ends its sessions; active lifts only a ban SCIM set', async () => {
    const { token } = await provisioner();
    const { id } = (await (await scim('/Users', token, { method: 'POST', body: member('m', { [BANKID_SCHEMA]: { personalNumber: ANNA } }) })).json()) as { id: string };
    expect(await bankidSignIn(ANNA)).toBe(id);
    const set = (active: unknown) => scim(`/Users/${id}`, token, { method: 'PATCH', body: { schemas: [PATCH], Operations: [{ op: 'Replace', value: { active } }] } });
    // Entra ID's spelling: a capitalised op and a string boolean.
    expect(await (await set('False')).json()).toMatchObject({ active: false });
    expect(db.prepare('SELECT count(*) AS n FROM session WHERE user_id = ?').get(id)).toEqual({ n: 0 });
    expect(await bankidSignIn(ANNA)).toBeUndefined();
    expect(await (await set(true)).json()).toMatchObject({ active: true });
    expect(await bankidSignIn(ANNA)).toBe(id);

    db.prepare("UPDATE user SET banned = 1, ban_reason = 'fraud' WHERE id = ?").run(id);
    expect(await (await set(true)).json()).toMatchObject({ status: '400', scimType: 'mutability' });
  });
});

describe('who may provision', () => {
  it('needs the scope in the ceiling AND on the client, re-checked on every request', async () => {
    const early = await machineClient(['users:provision']);
    // No ceiling entry: the audience is not even registered, so no token is minted for it.
    cfg = {};
    expect((await tokenRequest(early.clientId, early.clientSecret)).status).toBe(400);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_resource').get()).toEqual({ n: 0 });

    cfg = { [MACHINE_SCOPES]: 'users:provision read:users' };
    const reader = await machineClient(['read:users']);
    // The plugin mints a token for the audience to any machine client; holding the scope is SCIM's check.
    const readerToken = (await (await tokenRequest(reader.clientId, reader.clientSecret)).json()) as { access_token: string };
    expect((await scim('/Users', readerToken.access_token)).status).toBe(403);

    const { token, clientId } = await provisioner();
    expect((await scim('/ServiceProviderConfig', token)).status).toBe(200);
    cfg = { [MACHINE_SCOPES]: 'read:users' };
    expect((await scim('/ServiceProviderConfig', token)).status).toBe(403);
    cfg = { [MACHINE_SCOPES]: 'users:provision' };
    db.prepare('UPDATE oauth_client SET disabled = 1 WHERE client_id = ?').run(clientId);
    const disabled = await scim('/ServiceProviderConfig', token);
    expect(disabled.status).toBe(401);
    expect(disabled.headers.get('www-authenticate')).toBe('Bearer');
    expect((await scim('/ServiceProviderConfig', undefined)).status).toBe(401);
  });
});

describe('the personal number never leaves', () => {
  it('is in no response, log line or sign-in log row, and the schema declares it write-only', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a))).join(' '))),
    );
    try {
      const { token } = await provisioner();
      const responses: string[] = [];
      const created = await scim('/Users', token, { method: 'POST', body: member('m', { [BANKID_SCHEMA]: { personalNumber: ANNA } }) });
      const { id } = JSON.parse(await created.clone().text()) as { id: string };
      for (const res of [
        created,
        await scim(`/Users/${id}`, token),
        await scim('/Users', token),
        await scim('/Users', token, { method: 'POST', body: member('n', { [BANKID_SCHEMA]: { personalNumber: ANNA } }) }),
        await scim(`/Users/${id}`, token, { method: 'PATCH', body: { schemas: [PATCH], Operations: [{ op: 'add', path: `${BANKID_SCHEMA}:personalNumber`, value: BERTIL }] } }),
        await scim('/Bulk?dryRun=true', token, { method: 'POST', body: { schemas: [BULK], Operations: [{ method: 'POST', bulkId: 'b', path: '/Users', data: member('o', { [BANKID_SCHEMA]: { personalNumber: ANNA } }) }] } }),
      ]) {
        responses.push(await res.text());
      }
      await bankidSignIn(ANNA);
      const signInLog = JSON.stringify(db.prepare('SELECT * FROM sign_in_attempt').all());
      for (const text of [...responses, ...lines, signInLog]) {
        expect(text).not.toContain(ANNA);
        expect(text).not.toContain(BERTIL);
      }

      const schemaDoc = (await (await scim(`/Schemas/${BANKID_SCHEMA}`, token)).json()) as { attributes: Record<string, unknown>[] };
      expect(schemaDoc.attributes.find((a) => a.name === 'personalNumber')).toMatchObject({ mutability: 'writeOnly', returned: 'never' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('the protocol surface', () => {
  it('refuses a filter, a query parameter or an endpoint it does not serve, in SCIM’s error shape', async () => {
    const { token } = await provisioner();
    expect(await (await scim(`/Users?filter=${encodeURIComponent('userName sw "a"')}`, token)).json()).toMatchObject({ status: '400', scimType: 'invalidFilter' });
    expect(await (await scim('/Users?sortBy=userName', token)).json()).toMatchObject({ status: '400', scimType: 'invalidSyntax' });
    expect((await scim(`/Users/${adminId}`, token, { method: 'PUT', body: member('x') })).status).toBe(501);
    expect((await scim('/Groups', token)).status).toBe(501);
    const config = (await (await scim('/ServiceProviderConfig', token)).json()) as Record<string, unknown>;
    expect(config).toMatchObject({ patch: { supported: true }, bulk: { supported: true, maxOperations: 1000 }, filter: { supported: true }, etag: { supported: false } });
    // An unprovisioned person is named by their address; `attributes` narrows what comes back.
    expect(await (await scim(`/Users/${adminId}?attributes=userName`, token)).json()).toEqual({ schemas: [USER], id: adminId, userName: ADMIN.email });
  });
});
