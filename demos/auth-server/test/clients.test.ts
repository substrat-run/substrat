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

/**
 * The relying-party registry behind the dashboard's Applications panel.
 *
 * Almost none of it is ours any more. `oauthProvider` ships create/update/delete/rotate, and
 * `clientPrivileges` in `src/auth.ts` is what makes them administrator-only — so what needs
 * proving is that the GATE holds, that the dashboard's calls match the plugin's shapes, and
 * that the one endpoint still ours (the list) shows what an issuer registry must show:
 * clients another admin registered, and clients that registered themselves with no user at
 * all. The library's own `/oauth2/get-clients` answers "the clients YOU created", which is a
 * different question.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const OTHER_ADMIN = { email: 'other@auth.test', password: 'other-demo-pass', name: 'Other Admin' };
const MEMBER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'Plain Member' };
const RP_REDIRECT = 'http://localhost:9999/cb';

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let api: ReturnType<typeof createAdminApi>;

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

/** The plugin's client endpoints, called exactly as `app/src/api.ts` calls them. */
const pluginCall = (path: string, cookie: string, init?: RequestInit): Promise<Response> =>
  call(`/api/auth${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie, ...init?.headers },
  });

/** Our own admin surface (the list + settings). */
const adminCall = (path: string, cookie: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    api.request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...init?.headers },
    }),
  );

interface WireClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  disabled?: boolean;
  skip_consent?: boolean;
  user_id?: string;
  client_secret_set?: boolean;
  metadata?: Record<string, unknown>;
}

const listClients = async (cookie: string): Promise<WireClient[]> =>
  ((await (await adminCall('/clients', cookie)).json()) as { clients: WireClient[] }).clients;

/**
 * Register through OUR endpoint, which proxies the plugin's `SERVER_ONLY` admin verb — the
 * only way to set `skip_consent`, and the path `app/src/api.ts` takes.
 */
async function register(name: string, cookie: string, extra: Record<string, unknown> = {}) {
  const res = await adminCall('/clients', cookie, {
    method: 'POST',
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [RP_REDIRECT],
      application_type: 'native',
      ...extra,
    }),
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as WireClient & { client_secret?: string };
}

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
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
  for (const who of [ADMIN, OTHER_ADMIN, MEMBER]) {
    const created = await auth.api.signUpEmail({ body: who });
    db.prepare('UPDATE user SET role = ?, email_verified = 1 WHERE id = ?').run(
      who === MEMBER ? 'user' : 'admin',
      created.user.id,
    );
  }
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    auth.api.getSession({ headers: headers as never }).then((s) => {
      const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
    });
  api = createAdminApi({ sql, session, effectiveCfg: () => ({}), auth: () => auth.api as never });
});

describe('the clientPrivileges gate', () => {
  it('lets an administrator manage clients', async () => {
    const client = await register('Managed', await signInAs(ADMIN));
    expect(client.client_id).toBeTruthy();
  });

  it('refuses a signed-in non-admin every management verb', async () => {
    const admin = await signInAs(ADMIN);
    const client = await register('Guarded', admin);
    const member = await signInAs(MEMBER);

    // The admin variants are SERVER_ONLY and unreachable over HTTP at all; what a non-admin
    // could try is our proxy in front of them, and the self-service variant beside them.
    const proxied = await adminCall('/clients', member, {
      method: 'POST',
      body: JSON.stringify({ client_name: 'Sneaky', redirect_uris: [RP_REDIRECT] }),
    });
    expect(proxied.status).toBe(403);

    for (const [path, body] of [
      ['/oauth2/create-client', { client_name: 'Sneaky', redirect_uris: [RP_REDIRECT] }],
      ['/oauth2/client/rotate-secret', { client_id: client.client_id }],
    ] as const) {
      const res = await pluginCall(path, member, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status, `${path} admitted a non-admin`).toBeGreaterThanOrEqual(400);
    }
    const update = await adminCall(`/clients/${client.client_id}`, member, {
      method: 'PATCH',
      body: JSON.stringify({ client_name: 'Renamed' }),
    });
    expect(update.status).toBe(403);
    const removal = await adminCall(`/clients/${client.client_id}`, member, { method: 'DELETE' });
    expect(removal.status).toBe(403);

    // Nothing changed, and the client is still there.
    const still = await listClients(admin);
    expect(still.map((c) => c.client_name)).toContain('Guarded');
  });

  it('refuses an anonymous caller the registry list', async () => {
    expect((await adminCall('/clients', '')).status).toBe(401);
  });

  it('refuses a signed-in non-admin the registry list', async () => {
    expect((await adminCall('/clients', await signInAs(MEMBER))).status).toBe(403);
  });

  it('still lets an app register itself with no session at all (RFC 7591)', async () => {
    // `clientPrivileges` is consulted only when a session is present, which is what keeps
    // dynamic registration open while management stays administrator-only.
    const res = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: 'Self Made', application_type: 'native' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('the registry list', () => {
  it('shows clients this admin did NOT create — including self-registered ones', async () => {
    const admin = await signInAs(ADMIN);
    await register('Mine', admin);
    await register('Someone else’s', await signInAs(OTHER_ADMIN));
    await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: 'Self Made', application_type: 'native' }),
    });

    const listed = await listClients(admin);
    const names = listed.map((c) => c.client_name);
    expect(names).toContain('Mine');
    // The two the library's own `/oauth2/get-clients` would omit — and the exact reason this
    // endpoint exists rather than proxying to it.
    expect(names).toContain('Someone else’s');
    expect(names).toContain('Self Made');

    const mine = (await (await pluginCall('/oauth2/get-clients', admin, { method: 'GET' })).json()) as WireClient[];
    expect(mine.map((c) => c.client_name)).toEqual(['Mine']);

    // A self-registered client has no owner, which is what the panel tags.
    expect(listed.find((c) => c.client_name === 'Self Made')?.user_id).toBeUndefined();
  });

  it('never returns a secret — it could not, since secrets are stored hashed', async () => {
    const admin = await signInAs(ADMIN);
    const created = await register('Secretive', admin);
    expect(created.client_secret).toBeTruthy();

    const listed = (await listClients(admin)).find((c) => c.client_id === created.client_id);
    expect(listed).not.toHaveProperty('client_secret');
    expect(listed?.client_secret_set).toBe(true);
    // What is stored is a hash, not the credential the relying party holds.
    const row = db.prepare('SELECT client_secret FROM oauth_client WHERE client_id = ?').get(created.client_id) as {
      client_secret: string;
    };
    expect(row.client_secret).not.toBe(created.client_secret);
  });

  it('reads redirect URIs and metadata back through the JSON columns', async () => {
    const admin = await signInAs(ADMIN);
    const created = await register('Shaped', admin, {
      redirect_uris: [RP_REDIRECT, 'http://localhost:9999/other'],
      metadata: { theme: 'dark' },
    });
    const listed = (await listClients(admin)).find((c) => c.client_id === created.client_id);
    expect(listed?.redirect_uris).toEqual([RP_REDIRECT, 'http://localhost:9999/other']);
    expect(listed?.metadata).toEqual({ theme: 'dark' });
  });
});

describe('what the dashboard does to a client', () => {
  it('disables it, and the issuer stops answering for it', async () => {
    const admin = await signInAs(ADMIN);
    const client = await register('Switchable', admin);

    const off = await adminCall(`/clients/${client.client_id}`, admin, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: true }),
    });
    expect(off.status).toBeLessThan(300);
    expect((await listClients(admin)).find((c) => c.client_id === client.client_id)?.disabled).toBe(true);

    const authorize = await call(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: RP_REDIRECT,
        scope: 'openid',
        state: 'st-off',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      })}`,
      { headers: { 'sec-fetch-mode': 'navigate', cookie: admin } },
    );
    // Refused at authorize — the toggle is enforcement, not decoration.
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get('location') ?? '').toMatch(/error=/);
  });

  it('rotates the secret through the plugin, which is the only thing that touches one', async () => {
    // Rotation stays the library's: it mints and HASHES the secret with whatever
    // `storeClientSecret` says, and reimplementing that here is exactly the coupling this
    // migration removed. The plugin scopes it to the client's registrant — so this drives it
    // as a self-service registration, which is what the dashboard's Rotate button does when
    // the current administrator owns the client.
    const admin = await signInAs(ADMIN);
    const created = await pluginCall('/oauth2/create-client', admin, {
      method: 'POST',
      body: JSON.stringify({
        client_name: 'Rotating',
        redirect_uris: [RP_REDIRECT],
        application_type: 'native',
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    const client = (await created.json()) as WireClient & { client_secret?: string };
    const before = (
      db.prepare('SELECT client_secret FROM oauth_client WHERE client_id = ?').get(client.client_id) as {
        client_secret: string;
      }
    ).client_secret;

    const rotated = await pluginCall('/oauth2/client/rotate-secret', admin, {
      method: 'POST',
      body: JSON.stringify({ client_id: client.client_id }),
    });
    expect(rotated.status).toBeLessThan(300);
    const next = (await rotated.json()) as { client_secret?: string };
    expect(next.client_secret).toBeTruthy();
    expect(next.client_secret).not.toBe(client.client_secret);

    // The stored value changed too — the rotation reached the database, not just the
    // response — and it is a hash of neither secret as sent.
    const after = (
      db.prepare('SELECT client_secret FROM oauth_client WHERE client_id = ?').get(client.client_id) as {
        client_secret: string;
      }
    ).client_secret;
    expect(after).not.toBe(before);
    expect(after).not.toBe(next.client_secret);
  });

  it('removes it, and its rows go with it', async () => {
    const admin = await signInAs(ADMIN);
    const client = await register('Doomed', admin);
    db.prepare(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
       VALUES ('c1', ?, (SELECT id FROM user WHERE email = ?), '["openid"]', 0, 0)`,
    ).run(client.client_id, ADMIN.email);

    const res = await adminCall(`/clients/${client.client_id}`, admin, { method: 'DELETE' });
    expect(res.status).toBeLessThan(300);
    expect((await listClients(admin)).map((c) => c.client_id)).not.toContain(client.client_id);
    // `oauth_consent.client_id` references the client WITHOUT `ON DELETE CASCADE` — only
    // `oauth_client_resource` has one. So a client with a standing consent could not be
    // deleted at all until the dependents went first, and this row is why that is asserted
    // rather than assumed: the failure was a raw "FOREIGN KEY constraint failed".
    expect(db.prepare('SELECT count(*) AS c FROM oauth_consent').get()).toEqual({ c: 0 });
  });

  it('registers a first-party client that skips the consent screen', async () => {
    const admin = await signInAs(ADMIN);
    const client = await register('Trusted First Party', admin, { skip_consent: true });
    expect((await listClients(admin)).find((c) => c.client_id === client.client_id)?.skip_consent).toBe(true);

    const authorize = await call(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: RP_REDIRECT,
        scope: 'openid',
        state: 'st-skip',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      })}`,
      { headers: { 'sec-fetch-mode': 'navigate', cookie: admin } },
    );
    // Straight to the relying party's callback with a code — no consent screen in between.
    // Under the 1.6 plugin this was reachable ONLY from `trustedClients` in source; it is now
    // a column, which is why the dashboard can offer it.
    expect(authorize.headers.get('location') ?? '').toContain(`${RP_REDIRECT}?code=`);
  });
});
