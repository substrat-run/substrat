import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { introspectTables, introspectTable, REDACTED, REDACTED_COLUMNS, type SqlExec } from '../src/introspect.js';

/**
 * The §5.4 introspection reads over the issuer's REAL schema (`db/ddl.generated.ts`), driven
 * against better-sqlite3 — the same store `server.ts` runs on. What these pin:
 *
 *   - The table list covers the whole Better Auth schema, with row counts.
 *   - Every secret-bearing column comes back `[redacted]` — password hashes, session
 *     tokens, JWKS private keys, OAuth secrets, and the issuer's own signing secret
 *     must never leave the DO, while ids/emails/timestamps stay readable (the Data
 *     tab exists to debug "why can't this user sign in").
 *   - An unknown table throws — never queried blind.
 */

/** Wrap better-sqlite3 in the DO-cursor-shaped `SqlExec` the helpers consume. */
function sqlExecOf(db: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const columnNames = stmt.columns().map((c) => c.name);
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      const raw = stmt.raw(true).all(...(bindings as [])) as unknown[][];
      return { columnNames, toArray: () => objects, raw: () => raw.values() };
    },
  };
}

let db: Database.Database;
let sql: SqlExec;

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  db.prepare(
    "INSERT INTO user (id, name, email, updated_at) VALUES ('u1', 'Ada', 'ada@acme.test', 0)",
  ).run();
  db.prepare(
    `INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, access_token, updated_at)
     VALUES ('a1', 'local:credential', 'ada@acme.test', 'credential', 'u1', 'scrypt$super-secret-hash', 'tok-123', 0)`,
  ).run();
  db.prepare(
    "INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('s1', 9999999999, 'sess-token-abc', 0, 'u1')",
  ).run();
  db.prepare(
    "INSERT INTO jwks (id, public_key, private_key, created_at) VALUES ('k1', 'pub-pem', 'priv-pem', 0)",
  ).run();
  db.prepare("INSERT INTO config (key, value) VALUES ('auth_secret', 'the-signing-secret')").run();
  db.prepare("INSERT INTO config (key, value) VALUES ('cfg:ADMIN_PASSWORD', 'delivered-secret')").run();
  db.prepare(
    `INSERT INTO identity_provider (provider_id, client_id, client_secret, tenant_id)
     VALUES ('microsoft', 'entra-app-id', 'entra-client-secret', 'contoso')`,
  ).run();
  sql = sqlExecOf(db);
});

describe('introspectTables', () => {
  it('lists the whole Better Auth schema with row counts', () => {
    const tables = introspectTables(sql);
    const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
    expect(byName['user']).toEqual({ name: 'user', rowCount: 1, system: false });
    expect(byName['session']?.rowCount).toBe(1);
    expect(byName['config']?.rowCount).toBe(2);
    // Every table the redaction map names must exist — a renamed column or table would
    // otherwise silently stop redacting. `legacy_*` is exempt: those exist only on a store
    // upgraded from the 1.6 plugin (`db/upgrade.ts`), and `test/upgrade.test.ts` covers them.
    for (const name of Object.keys(REDACTED_COLUMNS)) {
      if (name.startsWith('legacy_')) continue;
      expect(byName[name], `schema drift: redaction map names unknown table '${name}'`).toBeDefined();
    }
  });
});

describe('introspectTable', () => {
  const rowOf = (table: string, id: string) => {
    const page = introspectTable(sql, table, 50, 0);
    const keyCol = page.columns.indexOf(
      table === 'config' ? 'key' : table === 'identity_provider' ? 'provider_id' : 'id',
    );
    const row = page.rows.find((r) => r[keyCol] === id);
    expect(row).toBeDefined();
    return Object.fromEntries(page.columns.map((c, i) => [c, row![i]]));
  };

  it('keeps the debuggable cells readable', () => {
    expect(rowOf('user', 'u1')).toMatchObject({ id: 'u1', email: 'ada@acme.test' });
    expect(rowOf('account', 'a1')).toMatchObject({ user_id: 'u1', provider_id: 'credential' });
  });

  it('redacts every secret-bearing column', () => {
    expect(rowOf('account', 'a1')).toMatchObject({ password: REDACTED, access_token: REDACTED });
    expect(rowOf('session', 's1')['token']).toBe(REDACTED);
    const key = rowOf('jwks', 'k1');
    expect(key['private_key']).toBe(REDACTED);
    expect(key['public_key']).toBe('pub-pem');
    // The issuer's own signing secret and delivered cfg values (which can include
    // ADMIN_PASSWORD) live in config.value — redacted wholesale.
    expect(rowOf('config', 'auth_secret')['value']).toBe(REDACTED);
    expect(rowOf('config', 'cfg:ADMIN_PASSWORD')['value']).toBe(REDACTED);
    // The upstream provider's secret is the one credential here that is stored as GIVEN — it
    // is presented to Microsoft on every token exchange and so cannot be hashed. The client id
    // and directory stay readable: an operator debugging a federated sign-in needs those.
    const provider = rowOf('identity_provider', 'microsoft');
    expect(provider['client_secret']).toBe(REDACTED);
    expect(provider).toMatchObject({ client_id: 'entra-app-id', tenant_id: 'contoso' });
  });

  it('leaves NULL secret cells null, so emptiness stays visible', () => {
    expect(rowOf('account', 'a1')['refresh_token']).toBeNull();
  });

  it('pages and clamps like the platform ScopeDO', () => {
    const page = introspectTable(sql, 'config', 1, 1);
    expect(page.rows).toHaveLength(1);
    expect(page.rowCount).toBe(2);
    expect(introspectTable(sql, 'user', 100_000, 0).limit).toBeLessThanOrEqual(200);
  });

  it('throws on an unknown table — never queried blind', () => {
    expect(() => introspectTable(sql, 'no_such_table', 50, 0)).toThrow(/unknown table/);
    expect(() => introspectTable(sql, 'user"; --', 50, 0)).toThrow(/unknown table/);
  });
});
