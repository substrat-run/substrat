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
  publicProvidersFrom,
  readProviders,
  socialProvidersFrom,
  trustedProvidersFrom,
  type ProviderRow,
} from '../src/providers.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * The UPSTREAM provider registry — the dashboard's "Sign-in providers" panel.
 *
 * Two things need proving, and they are different in kind. The REGISTRY is ours: an admin
 * gate, a stored credential that never comes back out, and an edit that does not require
 * re-pasting it. The WIRING is Better Auth's: rows have to become a `socialProviders` config
 * that the library actually mounts, because a row that configures nothing is the failure this
 * whole feature would have — a panel that looks right and a login screen that cannot use it.
 * So the last test drives `/sign-in/social` and reads the authorize URL it hands back.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const MEMBER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'Plain Member' };
const TENANT = '11111111-2222-3333-4444-555555555555';

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

const adminCall = (path: string, cookie: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    api.request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...init?.headers },
    }),
  );

interface WireProvider {
  id: string;
  clientId: string;
  clientSecretSet: boolean;
  tenantId: string | null;
  allowSignup: boolean;
  trustEmail: boolean;
  disabled: boolean;
  callbackPath: string;
}

const listProviders = async (cookie: string): Promise<WireProvider[]> =>
  ((await (await adminCall('/providers', cookie)).json()) as { providers: WireProvider[] }).providers;

const enableMicrosoft = (cookie: string, body: Record<string, unknown> = {}) =>
  adminCall('/providers/microsoft', cookie, {
    method: 'PUT',
    body: JSON.stringify({
      clientId: 'entra-app-id',
      clientSecret: 'entra-secret',
      tenantId: TENANT,
      allowSignup: true,
      trustEmail: false,
      disabled: false,
      ...body,
    }),
  });

/** Build a fresh Better Auth over the CURRENT rows — what both runtimes do per request. */
function rebuild(): Auth {
  const rows = readProviders(sql);
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    socialProviders: socialProvidersFrom(rows),
    trustedProviders: trustedProvidersFrom(rows),
  });
}

const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  provider_id: 'microsoft',
  client_id: 'entra-app-id',
  client_secret: 'entra-secret',
  tenant_id: TENANT,
  allow_signup: 1,
  trust_email: 0,
  disabled: 0,
  updated_at: 1,
  ...over,
});

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  auth = rebuild();
  for (const who of [ADMIN, MEMBER]) {
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

describe('the providers admin surface', () => {
  it('serves the catalogue with what is configured against it', async () => {
    const cookie = await signInAs(ADMIN);
    const body = (await (await adminCall('/providers', cookie)).json()) as {
      catalogue: { id: string }[];
      providers: WireProvider[];
    };
    expect(body.catalogue.map((entry) => entry.id)).toContain('microsoft');
    expect(body.providers).toEqual([]);
  });

  it('is administrator-only, like every other verb on this surface', async () => {
    const member = await signInAs(MEMBER);
    expect((await enableMicrosoft(member)).status).toBe(403);
    expect((await adminCall('/providers', member)).status).toBe(403);
    // No session at all: refused before the role is even considered.
    expect((await adminCall('/providers', '')).status).toBe(401);
  });

  it('enables a provider and never hands the secret back', async () => {
    const cookie = await signInAs(ADMIN);
    expect((await enableMicrosoft(cookie)).status).toBe(201);

    const [provider] = await listProviders(cookie);
    expect(provider).toMatchObject({
      id: 'microsoft',
      clientId: 'entra-app-id',
      clientSecretSet: true,
      tenantId: TENANT,
      callbackPath: '/api/auth/callback/microsoft',
    });
    // The credential is in the row and nowhere in the response — the panel is told only that
    // one exists, exactly as it is for a relying party's secret.
    expect(JSON.stringify(provider)).not.toContain('entra-secret');
    expect(readProviders(sql)[0]?.client_secret).toBe('entra-secret');
  });

  it('keeps the stored secret when an edit omits it', async () => {
    const cookie = await signInAs(ADMIN);
    await enableMicrosoft(cookie);
    // The panel sends no `clientSecret` when the field is untouched: flipping a toggle must
    // not require re-pasting a credential the operator may no longer have.
    const edited = await adminCall('/providers/microsoft', cookie, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'entra-app-id', tenantId: TENANT, allowSignup: false, trustEmail: true, disabled: false }),
    });
    expect(edited.status).toBe(200);
    expect(readProviders(sql)[0]).toMatchObject({ client_secret: 'entra-secret', trust_email: 1, allow_signup: 0 });
  });

  it('refuses a first save with no secret, and an empty one on any save', async () => {
    const cookie = await signInAs(ADMIN);
    const bare = await adminCall('/providers/microsoft', cookie, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'entra-app-id', allowSignup: true, trustEmail: false, disabled: false }),
    });
    expect(bare.status).toBe(400);
    expect(readProviders(sql)).toEqual([]);

    await enableMicrosoft(cookie);
    // An empty string is a form field nobody typed in, not an instruction to clear the
    // credential — the schema rejects it rather than writing a provider that cannot sign in.
    const cleared = await enableMicrosoft(cookie, { clientSecret: '' });
    expect(cleared.status).toBe(400);
    expect(readProviders(sql)[0]?.client_secret).toBe('entra-secret');
  });

  it('refuses a provider that is not in the catalogue', async () => {
    const cookie = await signInAs(ADMIN);
    const res = await adminCall('/providers/definitely-not-a-provider', cookie, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'x', clientSecret: 'y', allowSignup: true, trustEmail: false, disabled: false }),
    });
    expect(res.status).toBe(400);
  });

  it('removes a provider, and says so when there is nothing to remove', async () => {
    const cookie = await signInAs(ADMIN);
    await enableMicrosoft(cookie);
    expect((await adminCall('/providers/microsoft', cookie, { method: 'DELETE' })).status).toBe(200);
    expect(readProviders(sql)).toEqual([]);
    expect((await adminCall('/providers/microsoft', cookie, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('rows becoming Better Auth config', () => {
  it('carries the directory through and inverts the sign-up decision', () => {
    expect(socialProvidersFrom([row()])).toEqual({
      microsoft: {
        clientId: 'entra-app-id',
        clientSecret: 'entra-secret',
        tenantId: TENANT,
        // `allow_signup` on ⇒ Better Auth's `disableSignUp` off. The inversion is the bug
        // this asserts against: getting it backwards silently admits everyone, or nobody.
        disableSignUp: false,
      },
    });
    expect(socialProvidersFrom([row({ allow_signup: 0 })])?.microsoft?.disableSignUp).toBe(true);
    // No directory ⇒ no `tenantId` key at all, which is Better Auth's multi-tenant `common`.
    expect(socialProvidersFrom([row({ tenant_id: null })])?.microsoft).not.toHaveProperty('tenantId');
  });

  it('leaves out a disabled row, an unknown provider, and offers nothing when empty', () => {
    expect(socialProvidersFrom([row({ disabled: 1 })])).toBeUndefined();
    expect(socialProvidersFrom([row({ provider_id: 'myspace' })])).toBeUndefined();
    // Undefined rather than an empty object: an issuer with no upstream must not advertise one.
    expect(socialProvidersFrom([])).toBeUndefined();
    expect(publicProvidersFrom([row({ disabled: 1 })])).toEqual([]);
  });

  it('trusts a provider for account linking only when asked', () => {
    expect(trustedProvidersFrom([row()])).toEqual([]);
    expect(trustedProvidersFrom([row({ trust_email: 1 })])).toEqual(['microsoft']);
    expect(trustedProvidersFrom([row({ trust_email: 1, disabled: 1 })])).toEqual([]);
  });

  it('tells the signed-out login screen the id and label, and nothing else', () => {
    expect(publicProvidersFrom([row()])).toEqual([{ id: 'microsoft', label: 'Microsoft' }]);
  });
});

describe('the login screen', () => {
  it('cannot start a social sign-in until a provider is configured', async () => {
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('sends the browser to the configured directory once one is', async () => {
    const cookie = await signInAs(ADMIN);
    await enableMicrosoft(cookie);
    // The rebuild is the point: both runtimes construct Better Auth per request, which is what
    // makes a provider added in the dashboard answer on the very next one.
    auth = rebuild();

    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.hostname).toBe('login.microsoftonline.com');
    // The stored directory, not `common` — the whole reason the panel asks for it.
    expect(authorize.pathname).toContain(TENANT);
    expect(authorize.searchParams.get('client_id')).toBe('entra-app-id');
    // The redirect URI the panel tells the operator to register, built by the library itself.
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/microsoft`);
  });
});
