import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import { clientBranding } from '../src/branding.js';
import { clientSignIn, readSignInPolicy } from '../src/sign-in-policy.js';
import {
  CONSOLE_CLIENT_ID,
  CONSOLE_LOCKED_FIELDS,
  clientIdOrConsole,
  ensureConsoleClient,
  isConsoleClient,
} from '../src/console-client.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * The issuer's own admin console, as a row in its own registry (`src/console-client.ts`).
 *
 * Four promises, and they are the ones a reviewer would want held rather than a tour of the
 * module:
 *
 *  1. **A fresh install and an upgraded one draw the screen they drew before.** The row is
 *     seeded with no theme and no policy, so every read about it answers with the issuer's
 *     plain defaults. This is the whole backwards-compatibility claim, and it is the first
 *     case because it is the one that would be quietly broken by a "sensible" default.
 *  2. **Seeding is idempotent and never clobbers.** It runs on every boot in both runtimes;
 *     an operator's theme has to survive a restart, and a restart must not pile up rows.
 *  3. **The lock-out guard refuses the write, not the read.** A policy naming only providers
 *     this issuer does not offer is refused at save time — the extra check the console gets
 *     and no other client needs, because the person who would read the "nobody can sign in"
 *     screen is the one who can no longer reach the form.
 *  4. **The row cannot be deleted, and the escape hatches work.** Disable falls back to the
 *     plain screen; delete is refused rather than silently re-seeded blank on the next boot.
 *
 * Everything goes through the REAL admin API and the real registry columns, so a renamed
 * column or a changed patch schema reddens here rather than in production.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let api: ReturnType<typeof createAdminApi>;
/** What this issuer is pretending to offer — the dep `createAdminApi` takes, so a case can
 *  move the ground under the console's policy the way deleting a provider would. */
let offered: { id: string; label: string }[];

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

async function adminCookie(): Promise<string> {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    }) as never,
  );
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/** PATCH the console row the way the dashboard's editor does. */
async function patchConsole(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return api.request(`http://localhost/clients/${CONSOLE_CLIENT_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  // The one call both runtimes make right after the DDL.
  ensureConsoleClient(sql);
  offered = [{ id: 'microsoft', label: 'Microsoft' }];
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    signInPolicyFor: (clientId) => readSignInPolicy(sql, clientId),
  });
  const created = await auth.api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
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
    offeredProviders: () => offered,
  });
});

describe('the seeded console row', () => {
  it('changes nothing about the screen it is seeded onto', () => {
    // The backwards-compatibility claim, stated as the two reads the login screen makes.
    expect(clientBranding(sql, CONSOLE_CLIENT_ID)).toEqual({ theme: {} });
    expect(clientSignIn(sql, CONSOLE_CLIENT_ID, offered)).toEqual({
      providers: offered,
      password: true,
      restricted: false,
    });
    expect(readSignInPolicy(sql, CONSOLE_CLIENT_ID)).toBeUndefined();
  });

  it('answers the public read that names no client at all', () => {
    // How the console asks about itself: no `client_id`, resolved server-side. Both runtimes'
    // routes go through this, so the SPA never carries the id.
    expect(clientIdOrConsole(null)).toBe(CONSOLE_CLIENT_ID);
    expect(clientIdOrConsole(undefined)).toBe(CONSOLE_CLIENT_ID);
    expect(clientIdOrConsole('')).toBe(CONSOLE_CLIENT_ID);
    expect(clientIdOrConsole('some-rp')).toBe('some-rp');
  });

  it('is not usable as a relying party — it holds no redirect URI', () => {
    const row = db
      .prepare('SELECT redirect_uris, client_secret FROM oauth_client WHERE client_id = ?')
      .get(CONSOLE_CLIENT_ID) as { redirect_uris: string; client_secret: string | null };
    // An authorize request naming it therefore fails the plugin's own redirect match, which
    // is the fail-closed direction: nothing can be talked into treating this as an RP.
    expect(JSON.parse(row.redirect_uris)).toEqual([]);
    expect(row.client_secret).toBeNull();
  });

  it('is seeded once, and a second boot keeps what an operator put on it', async () => {
    const cookie = await adminCookie();
    expect((await patchConsole(cookie, { metadata: { theme: { title: 'Acme Admin' } } })).status).toBe(200);

    // Two more boots. Neither creates a row, and neither touches the one that is there.
    expect(ensureConsoleClient(sql)).toBe(false);
    expect(ensureConsoleClient(sql)).toBe(false);

    const rows = db.prepare('SELECT client_id FROM oauth_client WHERE client_id = ?').all(CONSOLE_CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(clientBranding(sql, CONSOLE_CLIENT_ID)).toEqual({ theme: { title: 'Acme Admin' } });
  });

  it('is flagged on the wire, so the dashboard can draw it as this issuer rather than an app', async () => {
    const res = await api.request('http://localhost/clients', { headers: { cookie: await adminCookie() } });
    const { clients } = (await res.json()) as { clients: { client_id: string; builtin: boolean }[] };
    const console_ = clients.find((c) => c.client_id === CONSOLE_CLIENT_ID);
    expect(console_?.builtin).toBe(true);
    expect(isConsoleClient(CONSOLE_CLIENT_ID)).toBe(true);
    expect(isConsoleClient('some-rp')).toBe(false);
  });
});

describe('narrowing the console', () => {
  it('accepts a policy that leaves a method this issuer offers', async () => {
    const cookie = await adminCookie();
    const res = await patchConsole(cookie, { metadata: { signIn: { providers: ['microsoft'], password: false } } });
    expect(res.status).toBe(200);
    expect(clientSignIn(sql, CONSOLE_CLIENT_ID, offered)).toEqual({
      providers: [{ id: 'microsoft', label: 'Microsoft' }],
      password: false,
      restricted: true,
    });
  });

  it('refuses a policy naming only a provider this issuer does not offer', async () => {
    const cookie = await adminCookie();
    // Structurally a perfectly good policy — `assertSignInPolicy` accepts it, and for any
    // other client it should. Here it is a console nobody can sign into.
    offered = [];
    const res = await patchConsole(cookie, { metadata: { signIn: { providers: ['microsoft'], password: false } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/at least one sign-in method/i);
    // And nothing was written: the read still answers with the defaults.
    expect(readSignInPolicy(sql, CONSOLE_CLIENT_ID)).toBeUndefined();
  });

  it('lets any OTHER client be narrowed to a provider that is not offered', async () => {
    const cookie = await adminCookie();
    offered = [];
    const created = await api.request('http://localhost/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        client_name: 'Some RP',
        redirect_uris: ['http://localhost:9999/cb'],
        application_type: 'native',
        metadata: { signIn: { providers: ['microsoft'], password: false } },
      }),
    });
    // The guard is the console's alone. Every other client may be written into a state its
    // login screen then explains — that is what `effectiveSignIn`'s dead-end message is for.
    expect(created.status).toBe(201);
  });

  it('still refuses a policy that permits nothing at all, as it does for every client', async () => {
    const cookie = await adminCookie();
    const res = await patchConsole(cookie, { metadata: { signIn: { providers: [], password: false } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/lock every user out/i);
  });

  it('lets a policy be cleared again', async () => {
    const cookie = await adminCookie();
    expect((await patchConsole(cookie, { metadata: { signIn: { providers: ['microsoft'], password: false } } })).status).toBe(200);
    expect((await patchConsole(cookie, { metadata: {} })).status).toBe(200);
    expect(readSignInPolicy(sql, CONSOLE_CLIENT_ID)).toBeUndefined();
  });
});

describe('the row keeps no OAuth surface', () => {
  /**
   * The header's fail-closed claim, held where it can be broken.
   *
   * "It holds no redirect URI" is only true of the row as SEEDED, and the edit route is
   * the one place that could change that. The stakes are not theoretical: this row is
   * `token_endpoint_auth_method: 'none'` with `skip_consent: 1`, so one callback would
   * make it a public client that skips the consent screen — the strongest client this
   * issuer can hold, registered by nobody.
   */
  it('refuses to give the console a callback, and the row is untouched', async () => {
    const cookie = await adminCookie();
    const res = await patchConsole(cookie, { redirect_uris: ['https://evil.test/cb'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a relying party/i);
    const row = db
      .prepare('SELECT redirect_uris FROM oauth_client WHERE client_id = ?')
      .get(CONSOLE_CLIENT_ID) as { redirect_uris: string };
    expect(JSON.parse(row.redirect_uris)).toEqual([]);
  });

  it('refuses every OAuth field, one at a time', async () => {
    const cookie = await adminCookie();
    const value: Record<string, unknown> = {
      redirect_uris: ['https://evil.test/cb'],
      post_logout_redirect_uris: ['https://evil.test/bye'],
      application_type: 'native',
      enable_end_session: true,
      skip_consent: false,
    };
    for (const field of CONSOLE_LOCKED_FIELDS) {
      const res = await patchConsole(cookie, { [field]: value[field] });
      expect(res.status, field).toBe(400);
      expect(((await res.json()) as { error: string }).error, field).toContain(field);
    }
    // And smuggled in beside an edit that IS allowed: the whole patch is refused, so the
    // name does not land while the callback is quietly dropped.
    const mixed = await patchConsole(cookie, { client_name: 'Renamed', redirect_uris: ['https://evil.test/cb'] });
    expect(mixed.status).toBe(400);
    const row = db.prepare('SELECT name FROM oauth_client WHERE client_id = ?').get(CONSOLE_CLIENT_ID) as {
      name: string;
    };
    expect(row.name).not.toBe('Renamed');
  });

  it('still accepts what the row exists for', async () => {
    // The lock is five named fields, not the route: name, icon, theme and policy are the
    // point of the row, and `disabled` is escape hatch 2 and must never be locked.
    const cookie = await adminCookie();
    expect((await patchConsole(cookie, { client_name: 'Acme Admin' })).status).toBe(200);
    expect((await patchConsole(cookie, { metadata: { theme: { title: 'Acme' } } })).status).toBe(200);
    expect((await patchConsole(cookie, { disabled: true })).status).toBe(200);
    expect((await patchConsole(cookie, { disabled: false })).status).toBe(200);
  });

  it('does not lock any OTHER client — the rule is about this row', async () => {
    const cookie = await adminCookie();
    const created = await api.request('http://localhost/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ client_name: 'A real RP', redirect_uris: ['https://rp.test/cb'] }),
    });
    expect(created.status).toBe(201);
    const { client_id } = (await created.json()) as { client_id: string };
    expect(isConsoleClient(client_id)).toBe(false);
    const patched = await api.request(`http://localhost/clients/${client_id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ redirect_uris: ['https://rp.test/second'] }),
    });
    expect(patched.status).toBe(200);
  });

  it('cannot be driven through authorize, with or without the attempted edit', async () => {
    const cookie = await adminCookie();
    await patchConsole(cookie, { redirect_uris: ['https://evil.test/cb'] });
    const authorize = await auth.handler(
      new Request(
        `${ORIGIN}/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: CONSOLE_CLIENT_ID,
          redirect_uri: 'https://evil.test/cb',
          scope: 'openid',
          state: 'st-console',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        })}`,
        { headers: { 'sec-fetch-mode': 'navigate', cookie } },
      ) as never,
    );
    // It dies at the plugin's redirect match, on the ISSUER's own error page — the
    // request never reaches the origin it named. Without the guard above it does: the
    // edit lands, the callback matches, and the issuer redirects to `evil.test` with
    // only the empty `scopes` column left standing between it and a code, on a row that
    // is `token_endpoint_auth_method: 'none'` with `skip_consent: 1`.
    const location = authorize.headers.get('location') ?? '';
    expect(location).toContain('error=invalid_redirect');
    expect(location).not.toContain('evil.test');
    expect(location).not.toContain('code=');
  });
});

describe('the ways back in', () => {
  it('refuses to delete the row, and says which verb to reach for instead', async () => {
    const cookie = await adminCookie();
    const res = await api.request(`http://localhost/clients/${CONSOLE_CLIENT_ID}`, { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/disable it instead/i);
    expect(db.prepare('SELECT client_id FROM oauth_client WHERE client_id = ?').all(CONSOLE_CLIENT_ID)).toHaveLength(1);
  });

  it('falls back to the plain screen when the row is disabled', async () => {
    const cookie = await adminCookie();
    expect(
      (await patchConsole(cookie, { metadata: { theme: { title: 'Acme Admin' }, signIn: { providers: [], password: true } } })).status,
    ).toBe(200);
    expect(clientBranding(sql, CONSOLE_CLIENT_ID)).toEqual({ theme: { title: 'Acme Admin' } });

    expect((await patchConsole(cookie, { disabled: true })).status).toBe(200);
    // Both reads revert to the issuer's defaults — the Disable button IS an escape hatch.
    expect(clientBranding(sql, CONSOLE_CLIENT_ID)).toEqual({ theme: {} });
    expect(clientSignIn(sql, CONSOLE_CLIENT_ID, offered)).toEqual({
      providers: offered,
      password: true,
      restricted: false,
    });
  });

  it('leaves the plain screen reachable however the row is written', () => {
    // `/login?builtin=0` never reads the row at all — the SPA takes the issuer's live
    // providers and the password form. This is that contract, stated where it can be seen:
    // the read the escape hatch skips is the only thing the console's policy touches.
    expect(clientSignIn(sql, null, offered)).toEqual({
      providers: offered,
      password: true,
      restricted: false,
    });
  });
});
