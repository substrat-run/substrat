import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, DEMO_CLIENT, seedDemoClient, type Auth } from '../src/auth.js';

/**
 * End-to-end scenario for the standalone OIDC provider, exercised in-process over an
 * in-memory SQLite (the same `buildAuth` config the worker DO and the Node dev server run).
 * It proves the three requirements: OIDC discovery/JWKS with asymmetric signing, password
 * reset through the email adapter, and admin user-management behind the `admin` role.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };

let auth: Auth;
let mock: MockEmailTransport;
let sqlite: Database.Database;

/** Call the Better Auth HTTP handler with an absolute URL under the base path. (The cast
 *  steps past the node/undici vs Better-Auth `Request` lib mismatch; the shape is identical.) */
function call(path: string, init?: RequestInit): Promise<Response> {
  return auth.handler(new Request(`${ORIGIN}${path}`, init) as never);
}

beforeAll(async () => {
  mock = new MockEmailTransport();
  sqlite = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) sqlite.exec(stmt);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(sqlite, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: mock,
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    // Seeding this suite's admin goes through `signUpEmail`, which is the bootstrap path —
    // the issuer itself defaults to sign-up closed (see `test/signup.test.ts`).
    allowSignup: true,
  });
  // Bootstrap the first admin, the way setup does.
  const created = await auth.api.signUpEmail({ body: ADMIN });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
});

describe('OIDC provider surface', () => {
  it('publishes discovery with asymmetric signing and the standard endpoints', async () => {
    // The ROOT path — where `oauthProvider` serves it, and where an RP configured with
    // `OIDC_ISSUER = {origin}` looks. The 1.6 plugin served it under `/api/auth/…` and
    // `routes.ts` aliased the root onto it; the alias is gone with the plugin.
    const res = await call('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_endpoint).toContain('/oauth2/authorize');
    expect(meta.token_endpoint).toContain('/oauth2/token');
    expect(meta.jwks_uri).toContain('/jwks');
    // Asymmetric signing advertised, never a shared-secret HS256 — the property that makes
    // the issuer verifiable by any relying party from the public JWKS alone.
    const algs = meta.id_token_signing_alg_values_supported as string[];
    expect(algs.some((a) => a === 'EdDSA' || a === 'RS256')).toBe(true);
    expect(algs).not.toContain('HS256');
  });

  it('serves a non-empty JWKS', async () => {
    const res = await call('/api/auth/jwks');
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as { keys: Array<{ kty: string }> };
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0]?.kty).toBeTruthy();
  });
});

describe('password reset through the email adapter', () => {
  it('sends a reset email carrying a reset link', async () => {
    const before = mock.sent.length;
    const res = await call('/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, redirectTo: '/reset-password' }),
    });
    expect(res.ok).toBe(true);
    expect(mock.sent.length).toBe(before + 1);
    const msg = mock.last;
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.to[0]?.email).toBe(ADMIN.email);
    expect(msg.subject).toMatch(/reset/i);
    expect(msg.text).toMatch(/https?:\/\/\S+/);
    expect(msg.html).toMatch(/https?:\/\//);
  });
});

describe('admin user management behind the admin role', () => {
  let adminCookie = '';

  it('signs the admin in and returns a session', async () => {
    const res = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(res.ok).toBe(true);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    adminCookie = (setCookie ?? '').split(';')[0] ?? '';
    expect(adminCookie).toBeTruthy();
  });

  it('creates, lists, and bans a user as the admin', async () => {
    const create = await call('/api/auth/admin/create-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email: 'member@auth.test', password: 'member-demo-pass', name: 'Member', role: 'user' }),
    });
    expect(create.ok).toBe(true);
    const created = (await create.json()) as { user: { id: string } };

    const list = await call('/api/auth/admin/list-users?limit=50', {
      method: 'GET',
      headers: { cookie: adminCookie },
    });
    expect(list.ok).toBe(true);
    const { users } = (await list.json()) as { users: Array<{ email: string }> };
    expect(users.map((u) => u.email)).toContain('member@auth.test');

    const ban = await call('/api/auth/admin/ban-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ userId: created.user.id }),
    });
    expect(ban.ok).toBe(true);
  });

  it('refuses admin actions without an admin session', async () => {
    const res = await call('/api/auth/admin/list-users?limit=50', { method: 'GET' });
    expect(res.ok).toBe(false);
    expect([401, 403]).toContain(res.status);
  });
});

describe('the demo relying party is registered', () => {
  it('is seeded as a real client row, with credentials the plugin minted', async () => {
    // It used to be a `trustedClients` entry in source, carrying a published secret that
    // every deployment resolved. `oauthProvider` has no such option — a client is a row —
    // and secrets are hashed at rest, so the only knowable secret is the one handed back
    // here, once.
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    const headers = new Headers();
    for (const cookie of signIn.headers.getSetCookie()) headers.append('cookie', cookie.split(';')[0] ?? '');

    const demo = await seedDemoClient(auth, headers);
    expect(demo.clientId).toBeTruthy();
    expect(demo.clientSecret).toBeTruthy();

    const row = sqlite
      .prepare('SELECT name, redirect_uris, skip_consent, client_secret FROM oauth_client WHERE client_id = ?')
      .get(demo.clientId) as { name: string; redirect_uris: string; skip_consent: number; client_secret: string };
    expect(row.name).toBe(DEMO_CLIENT.name);
    expect(JSON.parse(row.redirect_uris)).toEqual([...DEMO_CLIENT.redirectUris]);
    expect(Boolean(row.skip_consent)).toBe(true);
    // Stored hashed: what is in the row is not what the relying party sends.
    expect(row.client_secret).not.toBe(demo.clientSecret);
  });
});
