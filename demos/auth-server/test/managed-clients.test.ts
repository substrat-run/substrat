import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { scopeId, tenantId, type ManagedClientEnsure } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth } from '../src/auth.js';
import type { SqlExec } from '../src/introspect.js';
import type { RegisterClientFn } from '../src/preview-clients.js';
import { PreviewClientRefusal } from '../src/preview-clients.js';
import { syncPlaceRegistrations } from '../src/places.js';
import { syncClientRedirects } from '../src/client-redirects.js';
import { ensureManagedClient, removeManagedClient } from '../src/managed-clients.js';

/**
 * A managed tenant's sign-in client at its manager's team auth-server (#3202, D-72, #3261), on
 * the real Better Auth over better-sqlite3: the registration is the plugin's own
 * `/oauth2/register`, a secret is judged by the plugin's own client authentication (the one the
 * places report runs), and every assertion reads the issuer's own tables.
 */

const ORIGIN = 'http://localhost:8877';
const MANAGER = tenantId.parse(ulid());
const ISSUER_SCOPE = scopeId.parse(ulid());
const ACME = tenantId.parse(ulid());
const ACME_SCOPE = scopeId.parse(ulid());
const BETA = tenantId.parse(ulid());
const BETA_SCOPE = scopeId.parse(ulid());

let db: Database.Database;
let sql: SqlExec;
let register: RegisterClientFn;
let registrations: number;
const transaction = <T>(fn: () => T): T => db.transaction(fn)();

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

const handler = (req: Request): Promise<Response> =>
  buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
  }).handler(req as never);

/**
 * Does the plugin's own client authentication accept this secret? RFC 7662 introspection runs it
 * exactly as `/oauth2/token` does, which is how the places report authenticates a client
 * (`places-http.ts`, kept out of this node project for its worker types).
 */
async function authenticates(clientId: string, secret: string): Promise<boolean> {
  const res = await handler(
    new Request(`${ORIGIN}/api/auth/oauth2/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'probe', client_id: clientId, client_secret: secret }).toString(),
    }) as never,
  );
  return res.status === 200;
}

const input = (app: string, appTenant: string, hostname: string): ManagedClientEnsure =>
  ({ tenantId: MANAGER, scopeId: ISSUER_SCOPE, appTenantId: appTenant, appScopeId: app, hostname, clientName: 'Acme AB' }) as ManagedClientEnsure;

const ensure = (app = ACME_SCOPE, appTenant = ACME, hostname = 'acme-shop.global.substrat.test') =>
  ensureManagedClient(sql, register, input(app, appTenant, hostname), transaction);
const remove = (app = ACME_SCOPE, appTenant = ACME) =>
  transaction(() => removeManagedClient(sql, { tenantId: MANAGER, scopeId: ISSUER_SCOPE, appTenantId: appTenant, appScopeId: app } as never, Date.now()));

const clientIds = () => (db.prepare('SELECT client_id FROM oauth_client ORDER BY client_id').all() as { client_id: string }[]).map((r) => r.client_id);
const clientRow = (clientId: string) =>
  db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(clientId) as Record<string, string> | undefined;
const recorded = () => db.prepare('SELECT app_scope_id, app_tenant_id, client_id FROM managed_client ORDER BY app_scope_id').all();
const places = () => db.prepare('SELECT app_scope_id, tenant_id FROM place_app ORDER BY app_scope_id').all();
const members = () => db.prepare('SELECT sub, app_scope_id FROM place_member ORDER BY sub, app_scope_id').all();
const redirectRecords = () => db.prepare('SELECT app_scope_id FROM platform_client_redirects ORDER BY app_scope_id').all();

/** What the drain delivers after an ensure: the place under the managed tenant's own key, and the redirects. */
function deliverPlace(app: string, appTenant: string, clientId: string, hostname: string): void {
  transaction(() => {
    syncPlaceRegistrations(sql, { tenantId: appTenant, registrations: [{ appScopeId: scopeId.parse(app), clientId, hostname, name: 'Acme AB' }] }, Date.now());
    syncClientRedirects(sql, { appScopeId: app, target: { clientId, hostnames: [hostname] } }, Date.now());
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  registrations = 0;
  register = async (body) => {
    registrations++;
    const res = await handler(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string; client_secret: string };
  };
});

describe("a managed tenant's sign-in client (#3261)", () => {
  it('registers one sign-in client with the URIs its hostname derives, and a retry reuses it with a new secret', async () => {
    const first = await ensure();
    expect(first).toEqual({ clientId: expect.any(String), clientSecret: expect.any(String), registered: true });
    expect(clientRow(first.clientId)).toMatchObject({
      name: 'Acme AB',
      redirect_uris: JSON.stringify(['https://acme-shop.global.substrat.test/api/auth/callback']),
      post_logout_redirect_uris: JSON.stringify(['https://acme-shop.global.substrat.test/', 'https://acme-shop.global.substrat.test/api/auth/logged-out']),
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(recorded()).toEqual([{ app_scope_id: ACME_SCOPE, app_tenant_id: ACME, client_id: first.clientId }]);
    expect(await authenticates(first.clientId, first.clientSecret)).toBe(true);

    // The retry of a pass that registered and stopped before its place: the same client, a new
    // secret, and nothing left over from the retry's own registration.
    const retried = await ensure();
    expect(retried).toEqual({ clientId: first.clientId, clientSecret: expect.any(String), registered: false });
    expect(retried.clientSecret).not.toBe(first.clientSecret);
    expect(registrations).toBe(2);
    expect(clientIds()).toEqual([first.clientId]);
    expect(recorded()).toEqual([{ app_scope_id: ACME_SCOPE, app_tenant_id: ACME, client_id: first.clientId }]);
    expect(await authenticates(first.clientId, retried.clientSecret)).toBe(true);
    expect(await authenticates(first.clientId, first.clientSecret)).toBe(false);
  });

  it("removes the ended tenant's client, place, members and redirect record, and nothing of another tenant's", async () => {
    const acme = await ensure();
    const beta = await ensure(BETA_SCOPE, BETA, 'beta-shop.global.substrat.test');
    deliverPlace(ACME_SCOPE, ACME, acme.clientId, 'acme-shop.global.substrat.test');
    deliverPlace(BETA_SCOPE, BETA, beta.clientId, 'beta-shop.global.substrat.test');
    // Ann belongs to both businesses, Ben to Beta only.
    for (const [sub, app] of [['ann', ACME_SCOPE], ['ann', BETA_SCOPE], ['ben', BETA_SCOPE]] as const) {
      db.prepare('INSERT INTO place_member (sub, app_scope_id) VALUES (?, ?)').run(sub, app);
    }

    expect(remove()).toEqual({ removed: acme.clientId, unlisted: true });
    expect(clientIds()).toEqual([beta.clientId]);
    expect(recorded()).toEqual([{ app_scope_id: BETA_SCOPE, app_tenant_id: BETA, client_id: beta.clientId }]);
    expect(places()).toEqual([{ app_scope_id: BETA_SCOPE, tenant_id: BETA }]);
    expect(members()).toEqual([{ sub: 'ann', app_scope_id: BETA_SCOPE }, { sub: 'ben', app_scope_id: BETA_SCOPE }]);
    expect(redirectRecords()).toEqual([{ app_scope_id: BETA_SCOPE }]);
    expect(await authenticates(beta.clientId, beta.clientSecret)).toBe(true);

    // Idempotent: the retry of a removal that landed changes nothing.
    expect(remove()).toEqual({ removed: null, unlisted: false });
    expect(clientIds()).toEqual([beta.clientId]);
  });

  it('unlists an app registered before this protocol, and leaves the client it never recorded', async () => {
    // A client the drain registered by open registration (#3249), so nothing here records it.
    const legacy = await register({
      client_name: 'Acme AB',
      redirect_uris: ['https://acme-shop.global.substrat.test/api/auth/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    deliverPlace(ACME_SCOPE, ACME, legacy.client_id, 'acme-shop.global.substrat.test');
    db.prepare('INSERT INTO place_member (sub, app_scope_id) VALUES (?, ?)').run('ann', ACME_SCOPE);

    expect(remove()).toEqual({ removed: null, unlisted: true });
    expect(places()).toEqual([]);
    expect(members()).toEqual([]);
    expect(redirectRecords()).toEqual([]);
    expect(clientIds()).toEqual([legacy.client_id]);
  });

  it('refuses a call pairing a recorded scope with another tenant, and touches nothing', async () => {
    const acme = await ensure();
    deliverPlace(ACME_SCOPE, ACME, acme.clientId, 'acme-shop.global.substrat.test');

    expect(() => remove(ACME_SCOPE, BETA)).toThrow(PreviewClientRefusal);
    await expect(ensure(ACME_SCOPE, BETA)).rejects.toThrow(PreviewClientRefusal);
    // The refused ensure's own registration is gone; the recorded client, its place and its record stay.
    expect(clientIds()).toEqual([acme.clientId]);
    expect(places()).toEqual([{ app_scope_id: ACME_SCOPE, tenant_id: ACME }]);
    expect(redirectRecords()).toEqual([{ app_scope_id: ACME_SCOPE }]);
    expect(await authenticates(acme.clientId, acme.clientSecret)).toBe(true);
  });
});
