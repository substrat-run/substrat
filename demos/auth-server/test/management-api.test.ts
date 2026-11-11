import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { JSONWebKeySet } from 'jose';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { MACHINE_SCOPES, machineScopesOf } from '../src/settings.js';
import { signInLoggerFor } from '../src/sign-in-log.js';
import { mergeAccounts } from '../src/account-merge.js';
import { bankidPlaceholderAddress } from '../src/placeholder-address.js';
import { backfillActivity, readActivity, recordClientToken, recordLogin } from '../src/user-activity.js';
import {
  auth0TokenForm,
  ensureManagementResource,
  managementApiApp,
  managementAudience,
  managementTokenVerifier,
  tokenAuthMethodOf,
} from '../src/management-api.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * The Auth0 Management API subset (#3107, `src/management-api.ts`): a machine client reads the
 * issuer's people the way a client written against Auth0 would, and every place the subset
 * differs from Auth0 answers as it is documented to.
 *
 * The two doors are composed here the way both runtimes compose them: `auth0TokenForm` in front
 * of the plugin's own token endpoint, and `managementApiApp` verifying against the JWKS the
 * plugin publishes. Better Auth is rebuilt per request, so changing `cfg` between two calls is an
 * operator changing `MACHINE_SCOPES` between two requests.
 */

const ORIGIN = 'http://localhost:8877';
const AUDIENCE = managementAudience(ORIGIN);
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const RP_REDIRECT = 'http://localhost:9999/cb';

let db: Database.Database;
let sql: SqlExec;
let cfg: Record<string, string | undefined>;
let adminId: string;

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

const machineScopes = (): string[] => machineScopesOf(cfg[MACHINE_SCOPES]).scopes;

const authNow = (): Auth =>
  buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    machineScopes: machineScopes(),
    recordSignIn: signInLoggerFor(sql),
    recordToken: (userId, clientId) => recordClientToken(sql, userId, clientId),
  });

const call = (path: string, init?: RequestInit): Promise<Response> =>
  authNow().handler(new Request(`${ORIGIN}${path}`, init) as never);

/** Auth0's `POST /oauth/token`, as both runtimes serve it. */
async function auth0Token(body: Record<string, string>): Promise<Response> {
  ensureManagementResource(sql, ORIGIN, machineScopes());
  const translated = await auth0TokenForm(
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    (id) => tokenAuthMethodOf(sql, id),
  );
  if ('error' in translated) return Response.json(translated.error, { status: 400 }) as never;
  return call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(translated.authorization ? { authorization: translated.authorization } : {}),
    },
    body: translated.form.toString(),
  });
}

/** `GET|… /api/v2{path}`, as both runtimes serve it. */
function management(path: string, token?: string, method = 'GET'): Promise<Response> {
  const auth = authNow();
  const app = managementApiApp({
    sql,
    verify: managementTokenVerifier(
      async () => (await auth.handler(new Request(`${ORIGIN}/api/auth/jwks`) as never)).json() as Promise<JSONWebKeySet>,
      ORIGIN,
    ),
    machineScopes,
  });
  return Promise.resolve(
    app.request(`${ORIGIN}/api/v2${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }),
  );
}

/**
 * A machine client holding `scopes`, registered as the console registers one: for HTTP Basic.
 * Every token request below posts its secret in the body, as Auth0's SDKs do.
 */
async function machineClient(scopes: string[]): Promise<{ clientId: string; clientSecret: string }> {
  const created = await authNow().api.adminCreateOAuthClient({
    headers: await adminHeaders(),
    body: {
      client_name: 'Staff Portal',
      application_type: 'web',
      grant_types: ['client_credentials'],
      token_endpoint_auth_method: 'client_secret_basic',
      client_credentials_scopes: scopes,
    },
  } as never);
  const client = created as unknown as { client_id: string; client_secret: string };
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

async function adminHeaders(): Promise<Headers> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const headers = new Headers();
  for (const c of res.headers.getSetCookie()) headers.append('cookie', c.split(';')[0] ?? '');
  return headers;
}

/** A `read:users` Management API token for a fresh machine client. */
async function managementToken(): Promise<{ token: string; clientId: string }> {
  const { clientId, clientSecret } = await machineClient(['read:users']);
  const res = await auth0Token({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience: AUDIENCE });
  expect(res.status).toBe(200);
  return { token: ((await res.json()) as { access_token: string }).access_token, clientId };
}

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  cfg = { [MACHINE_SCOPES]: 'read:users' };
  const created = await authNow().api.signUpEmail({ body: ADMIN });
  adminId = created.user.id;
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(adminId);
});

describe('an Auth0 client reads the issuer’s people', () => {
  it('finds a person by email and by id, in Auth0’s user shape, with their sign-ins', async () => {
    const { token } = await managementToken();
    const byEmail = await management(`/users-by-email?email=${encodeURIComponent(ADMIN.email)}`, token);
    expect(byEmail.status).toBe(200);
    const [user] = (await byEmail.json()) as Record<string, unknown>[];
    expect(user).toEqual({
      user_id: adminId,
      email: ADMIN.email,
      email_verified: true,
      name: ADMIN.name,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      // A password is Auth0's default database connection.
      identities: [{ connection: 'Username-Password-Authentication', provider: 'auth0', user_id: adminId, isSocial: false }],
      // Sign-up and the machine client's registration session are both sign-ins.
      last_login: expect.stringMatching(/Z$/),
      logins_count: 2,
    });
    const byId = await management(`/users/${encodeURIComponent(adminId)}`, token);
    expect(await byId.json()).toEqual(user);
    const projected = await management(`/users/${encodeURIComponent(adminId)}?fields=user_id,logins_count`, token);
    expect(await projected.json()).toEqual({ user_id: adminId, logins_count: 2 });
    const excluded = await management(`/users/${encodeURIComponent(adminId)}?fields=identities&include_fields=false`, token);
    expect(await excluded.json()).not.toHaveProperty('identities');
  });

  it('names each application that got a token for a person, and never a machine client', async () => {
    const { token, clientId: machineId } = await managementToken();
    // A relying party the person signs in to, through the whole authorization-code round trip.
    const registered = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: 'CRM', application_type: 'native' }),
    });
    const rp = (await registered.json()) as { client_id: string; client_secret: string };
    const cookie = (await adminHeaders()).get('cookie') ?? '';
    const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, 'x');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const query = new URLSearchParams({
      response_type: 'code', client_id: rp.client_id, redirect_uri: RP_REDIRECT, scope: 'openid', state: 's',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const authorize = await call(`/api/auth/oauth2/authorize?${query.toString()}`, { headers: { 'sec-fetch-mode': 'navigate', cookie } });
    const oauthQuery = new URL(`http://x${authorize.headers.get('location') ?? ''}`).search.slice(1);
    const consent = await call('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    });
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get('code') ?? '';
    const exchanged = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`${encodeURIComponent(rp.client_id)}:${encodeURIComponent(rp.client_secret)}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: RP_REDIRECT, code_verifier: verifier }).toString(),
    });
    expect(exchanged.status).toBe(200);

    const res = await management(`/users/${encodeURIComponent(adminId)}/x-client-activity`, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: adminId,
      clients: [{ client_id: rp.client_id, name: 'CRM', last_token_at: expect.stringMatching(/Z$/) }],
    });
    expect(JSON.stringify(await (await management(`/users/${encodeURIComponent(adminId)}/x-client-activity`, token)).json())).not.toContain(machineId);
  });
});

describe('who may call', () => {
  it('refuses a caller with no token, and a token for any other audience', async () => {
    expect(await (await management('/users-by-email?email=a@b.c')).json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Missing authentication',
    });
    // The same client, without the audience: an opaque token for this issuer, not for its API.
    const { clientId, clientSecret } = await machineClient(['read:users']);
    const opaque = await auth0Token({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const res = await management('/users-by-email?email=a@b.c', ((await opaque.json()) as { access_token: string }).access_token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: 'Invalid token' });
  });

  it.each([
    ['the client is disabled', () => db.prepare('UPDATE oauth_client SET disabled = 1').run(), 401, 'Unauthorized'],
    ['the operator takes the scope out of the ceiling', () => (cfg = { [MACHINE_SCOPES]: 'export:read' }), 403, 'Forbidden'],
  ])('ends access the moment %s, not when the token expires', async (_, change, status, error) => {
    const { token } = await managementToken();
    expect((await management(`/users/${adminId}`, token)).status).toBe(200);
    change();
    const res = await management(`/users/${adminId}`, token);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ statusCode: status, error });
  });

  it('mints no Management API token on an issuer whose ceiling never opted in', async () => {
    cfg = { [MACHINE_SCOPES]: 'export:read' };
    const { clientId, clientSecret } = await machineClient(['export:read']);
    const res = await auth0Token({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience: AUDIENCE });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_target' });
  });
});

describe('where the subset stops, it says so', () => {
  it.each([
    ['an unknown query parameter', '/users-by-email?email=a@b.c&q=x', 'GET', 400, 'invalid_query_string'],
    ['a missing email', '/users-by-email', 'GET', 400, 'invalid_query_string'],
    ['a non-boolean include_fields', '/users-by-email?email=a@b.c&include_fields=yes', 'GET', 400, 'invalid_query_string'],
    ['an unknown user', '/users/nobody', 'GET', 404, 'inexistent_user'],
    ['an Auth0 endpoint not served', '/users', 'GET', 501, 'not_implemented'],
    ['a write Auth0 serves', '/users/nobody', 'PATCH', 501, 'not_implemented'],
  ])('answers %s in Auth0’s error shape', async (_, path, method, status, errorCode) => {
    const { token } = await managementToken();
    const res = await management(path, token, method);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ statusCode: status, errorCode });
  });

  it('takes Auth0’s token request as JSON or a form, and refuses an API named twice', async () => {
    const form = await auth0TokenForm(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', audience: AUDIENCE }).toString(),
      }) as never,
      () => undefined,
    );
    expect('form' in form && Object.fromEntries(form.form)).toEqual({ grant_type: 'client_credentials', resource: AUDIENCE });
    const twice = await auth0TokenForm(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', audience: AUDIENCE, resource: AUDIENCE }),
      }) as never,
      () => undefined,
    );
    expect(twice).toEqual({ error: { error: 'invalid_request', error_description: expect.stringMatching(/not both/) } });
  });
});

describe('personal data the issuer holds stays out', () => {
  it('withholds a BankID identity’s personal number and a placeholder address', async () => {
    const { token } = await managementToken();
    const placeholder = bankidPlaceholderAddress();
    db.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)').run('u-bankid', 'Anna', placeholder);
    db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a1', '199001011234', 'bankid', 'u-bankid', 1, 1)").run();
    const res = await management('/users/u-bankid', token);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.identities).toEqual([{ connection: 'bankid', provider: 'bankid', isSocial: false }]);
    expect(body).not.toHaveProperty('email');
    expect(JSON.stringify(body)).not.toContain('199001011234');
    expect(await (await management(`/users-by-email?email=${encodeURIComponent(placeholder)}`, token)).json()).toEqual([]);
  });
});

describe('activity outlives the sign-in log', () => {
  it('carries a merged account’s activity onto the survivor', async () => {
    db.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)').run('u-placeholder', 'Anna', bankidPlaceholderAddress());
    db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a1', '199001011234', 'bankid', 'u-placeholder', 1, 1)").run();
    recordLogin(sql, 'u-placeholder');
    const before = readActivity(sql, adminId);
    const merged = mergeAccounts(sql, 'u-placeholder', adminId, Date.now());
    expect(merged).toEqual({ survivor: expect.any(String) });
    const survivor = 'survivor' in merged ? merged.survivor : '';
    expect(readActivity(sql, survivor).loginsCount).toBe(before.loginsCount + 1);
  });

  it('fills an upgraded install once, from the sign-ins and sessions it already holds', () => {
    db.prepare('DELETE FROM user_activity').run();
    db.prepare("DELETE FROM config WHERE key = 'user_activity_backfilled'").run();
    // The latest of the log and the sessions wins: an older logged sign-in, a newer session.
    db.prepare("UPDATE sign_in_attempt SET at = 1000 WHERE user_id = ?").run(adminId);
    db.prepare('UPDATE session SET created_at = 5000 WHERE user_id = ?').run(adminId);
    expect(backfillActivity(sql)).toBe(true);
    expect(readActivity(sql, adminId)).toEqual({ lastLoginAt: 5000, loginsCount: 1 });
    expect(backfillActivity(sql)).toBe(false);
  });
});
