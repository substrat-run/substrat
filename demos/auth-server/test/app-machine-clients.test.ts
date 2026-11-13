import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { scopeId, tenantId, type MachineClientEnsure } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import type { SqlExec } from '../src/introspect.js';
import type { RegisterClientFn } from '../src/preview-clients.js';
import { ensureMachineClient, removeMachineClient } from '../src/app-machine-clients.js';

/**
 * An app's machine client at this issuer (#3134), on the real Better Auth over better-sqlite3:
 * the registration is the plugin's own `/oauth2/register`, the token is the plugin's own
 * `client_credentials` grant, and every assertion reads the issuer's own tables.
 *
 * Better Auth is rebuilt per request, as both runtimes do, so changing `ceiling` between two
 * calls is an operator changing `MACHINE_SCOPES` between two requests.
 */

const ORIGIN = 'http://localhost:8877';
const TENANT = tenantId.parse(ulid());
const ISSUER_SCOPE = scopeId.parse(ulid());
const DESK = scopeId.parse(ulid());
const BOARD = scopeId.parse(ulid());

let db: Database.Database;
let sql: SqlExec;
let ceiling: string[];
let register: RegisterClientFn;
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

const authNow = (): Auth =>
  buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    machineScopes: ceiling,
  });

const call = (path: string, init?: RequestInit): Promise<Response> =>
  authNow().handler(new Request(`${ORIGIN}${path}`, init) as never);

/** A `client_credentials` request, authenticated the RFC 6749 default way (HTTP Basic). */
function token(clientId: string, secret: string, scope?: string): Promise<Response> {
  return call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }).toString(),
  });
}

const grantedScope = async (res: Response): Promise<string | undefined> => ((await res.json()) as { scope?: string }).scope;

const input = (app: string, scopes: string[], over: Partial<MachineClientEnsure> = {}): MachineClientEnsure =>
  ({ tenantId: TENANT, scopeId: ISSUER_SCOPE, appScopeId: app, clientName: 'Desk', scopes, ...over }) as MachineClientEnsure;

const ensure = (app: string, scopes: string[], over: Partial<MachineClientEnsure> = {}, reg: RegisterClientFn = register) =>
  ensureMachineClient(sql, reg, input(app, scopes, over), ceiling, transaction);

const remove = (app: string) =>
  transaction(() => removeMachineClient(sql, { tenantId: TENANT, scopeId: ISSUER_SCOPE, appScopeId: app } as never));

const clientRow = (clientId: string) =>
  db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(clientId) as Record<string, unknown> | undefined;
const clientIds = () => (db.prepare('SELECT client_id FROM oauth_client').all() as { client_id: string }[]).map((r) => r.client_id);
const recorded = () =>
  db.prepare('SELECT app_scope_id, client_id FROM app_machine_client ORDER BY app_scope_id').all() as {
    app_scope_id: string;
    client_id: string;
  }[];

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  ceiling = ['read:users'];
  register = async (body) => {
    const res = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string; client_secret: string };
  };
});

describe("an app's machine client (#3134)", () => {
  it('registers a machine client holding the declared scopes the ceiling allows, and names the rest', async () => {
    const first = await ensure(DESK, ['read:users', 'users:provision']);
    expect(first).toEqual({
      clientId: expect.any(String),
      clientSecret: expect.any(String),
      scopes: ['read:users'],
      withheld: ['users:provision'],
    });
    // The row the console writes for a machine application: one grant, no redirect, no sign-in scope.
    expect(clientRow(first.clientId)).toMatchObject({
      name: 'Desk',
      grant_types: '["client_credentials"]',
      response_types: '[]',
      redirect_uris: '[]',
      scopes: '[]',
      client_credentials_scopes: '["read:users"]',
      token_endpoint_auth_method: 'client_secret_basic',
      disabled: 0,
    });
    expect(recorded()).toEqual([{ app_scope_id: DESK, client_id: first.clientId }]);

    const issued = await token(first.clientId, first.clientSecret!);
    expect(issued.status).toBe(200);
    expect(await grantedScope(issued)).toBe('read:users');
    expect((await token(first.clientId, first.clientSecret!, 'users:provision')).status).toBe(400);

    // The operator widens the ceiling: the next ensure grants what was withheld, with no new secret.
    ceiling = ['read:users', 'users:provision'];
    const second = await ensure(DESK, ['read:users', 'users:provision'], { clientName: 'Desk (renamed)' });
    expect(second).toEqual({ clientId: first.clientId, scopes: ['read:users', 'users:provision'], withheld: [] });
    expect(clientRow(first.clientId)).toMatchObject({ name: 'Desk (renamed)' });
    expect(await grantedScope(await token(first.clientId, first.clientSecret!))).toBe('read:users users:provision');
    expect(clientIds()).toEqual([first.clientId]);
  });

  it('a rotation keeps the client id: the new secret gets a token and the old one does not', async () => {
    const first = await ensure(DESK, ['read:users']);
    const rotated = await ensure(DESK, ['read:users'], { rotate: true });
    expect(rotated.clientId).toBe(first.clientId);
    expect(rotated.clientSecret).toEqual(expect.any(String));
    expect(rotated.clientSecret).not.toBe(first.clientSecret);

    expect((await token(first.clientId, rotated.clientSecret!)).status).toBe(200);
    expect((await token(first.clientId, first.clientSecret!)).status).toBe(401);
    // The registration the new secret came from is gone.
    expect(clientIds()).toEqual([first.clientId]);
  });

  it("leaves `disabled` to the operator, and sets an operator's scope edit back to what is declared", async () => {
    const first = await ensure(DESK, ['read:users']);
    db.prepare(`UPDATE oauth_client SET disabled = 1, client_credentials_scopes = '[]' WHERE client_id = ?`).run(first.clientId);

    await ensure(DESK, ['read:users']);
    expect(clientRow(first.clientId)).toMatchObject({ disabled: 1, client_credentials_scopes: '["read:users"]' });
    expect((await token(first.clientId, first.clientSecret!)).status).not.toBe(200);
  });

  it('reaches only the client recorded for the app: not another app’s, not one registered by anybody else', async () => {
    const stranger = (await register({ client_name: 'Somebody', redirect_uris: ['https://example.test/cb'] })).client_id;
    const desk = await ensure(DESK, ['read:users']);
    const before = clientRow(desk.clientId);

    const board = await ensure(BOARD, ['read:users'], { clientName: 'Board' });
    expect(board.clientId).not.toBe(desk.clientId);
    expect(clientRow(desk.clientId)).toEqual(before);

    expect(remove(BOARD)).toEqual({ removed: board.clientId });
    expect(remove(BOARD)).toEqual({ removed: null });
    expect(clientIds().sort()).toEqual([stranger, desk.clientId].sort());
    expect(recorded()).toEqual([{ app_scope_id: DESK, client_id: desk.clientId }]);
    expect((await token(board.clientId, board.clientSecret!)).status).toBe(401);
  });

  it('a registration whose record cannot be written leaves no client behind', async () => {
    db.exec(`CREATE TRIGGER refuse_record BEFORE INSERT ON app_machine_client BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    await expect(ensure(DESK, ['read:users'])).rejects.toThrow(/refused/);
    expect(clientIds()).toEqual([]);
  });

  it('two ensures at once leave one client, and only the one that registered it answers the secret', async () => {
    let inner: Awaited<ReturnType<typeof ensure>> | undefined;
    // The other ensure lands while this one is awaiting its registration.
    const racing: RegisterClientFn = async (body) => {
      inner ??= await ensure(DESK, ['read:users']);
      return register(body);
    };
    const outer = await ensure(DESK, ['read:users'], {}, racing);
    expect(outer).toEqual({ clientId: inner!.clientId, scopes: ['read:users'], withheld: [] });
    expect(clientIds()).toEqual([inner!.clientId]);
  });

  it('registers anew when the recorded client is gone, whether or not the runtime cascaded the record', async () => {
    const first = await ensure(DESK, ['read:users']);
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM oauth_client WHERE client_id = ?').run(first.clientId);

    const second = await ensure(DESK, ['read:users']);
    expect(second.clientId).not.toBe(first.clientId);
    expect(second.clientSecret).toEqual(expect.any(String));
    expect(recorded()).toEqual([{ app_scope_id: DESK, client_id: second.clientId }]);
  });
});
