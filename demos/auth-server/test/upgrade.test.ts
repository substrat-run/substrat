import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { upgradeLegacySchema } from '../db/upgrade.js';
import { introspectTable, REDACTED, type SqlExec } from '../src/introspect.js';

/**
 * Booting the 1.7 issuer on a database the 1.6 one wrote.
 *
 * `CREATE TABLE IF NOT EXISTS` is this vertical's whole migration story, and it is silently
 * wrong across this move in two ways — a table that gained a required column, and two table
 * NAMES reused with different columns. Both failures land at runtime, in a Durable Object,
 * against a store that already has users in it. So the upgrade runs on every boot, and this
 * builds a genuine 1.6-shaped database to prove it.
 *
 * The fixture below is the OLD schema, verbatim from `db/ddl.ts` as it stood before the
 * migration. It is deliberately a frozen copy rather than an import: the point is to model a
 * store written by code that no longer exists.
 */

/** The pre-1.7 tables this upgrade has to cope with, exactly as the 1.6 issuer created them. */
const LEGACY_DDL = [
  `CREATE TABLE user (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    role TEXT, banned INTEGER DEFAULT 0, ban_reason TEXT, ban_expires INTEGER)`,
  // No `issuer` column — that is 1.7's addition.
  `CREATE TABLE account (
    id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT, refresh_token TEXT, id_token TEXT,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE oauth_application (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, icon TEXT, metadata TEXT,
    client_id TEXT NOT NULL UNIQUE, client_secret TEXT, redirect_urls TEXT NOT NULL, type TEXT NOT NULL,
    disabled INTEGER DEFAULT 0, user_id TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  // Same NAME as a 1.7 table, different columns — the silent one.
  `CREATE TABLE oauth_access_token (
    id TEXT PRIMARY KEY NOT NULL, access_token TEXT UNIQUE, refresh_token TEXT UNIQUE,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, client_id TEXT,
    user_id TEXT, scopes TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE oauth_consent (
    id TEXT PRIMARY KEY NOT NULL, client_id TEXT, user_id TEXT, scopes TEXT, consent_given INTEGER,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

let db: Database.Database;
let sql: SqlExec;

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

const columnsOf = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((r) => r.name);

const tableExists = (table: string): boolean =>
  db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined &&
  (db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(table) as { c: number }).c > 0;

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of LEGACY_DDL) db.exec(stmt);
  db.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'ada@acme.test')").run();
  db.prepare(
    "INSERT INTO account (id, account_id, provider_id, user_id, password) VALUES ('a1', 'ada@acme.test', 'credential', 'u1', 'scrypt$hash')",
  ).run();
  db.prepare(
    `INSERT INTO oauth_application (id, name, client_id, client_secret, redirect_urls, type)
     VALUES ('app1', 'Old RP', 'old-client', 'old-secret', 'https://old.example/cb', 'web')`,
  ).run();
  db.prepare(
    "INSERT INTO oauth_access_token (id, access_token, refresh_token, client_id, user_id, scopes) VALUES ('t1', 'at-1', 'rt-1', 'old-client', 'u1', 'openid')",
  ).run();
  db.prepare(
    "INSERT INTO oauth_consent (id, client_id, user_id, scopes, consent_given) VALUES ('c1', 'old-client', 'u1', 'openid', 1)",
  ).run();
  sql = sqlExecOf(db);
});

describe('upgrading a 1.6 store', () => {
  it('adds account.issuer and backfills it, so existing passwords keep working', () => {
    const upgrade = upgradeLegacySchema(sql);

    expect(upgrade.added).toContain('account.issuer');
    expect(columnsOf('account')).toContain('issuer');
    // The value Better Auth writes for a provider with no issuer of its own. Wrong here and
    // every existing password sign-in fails to find its account.
    expect((db.prepare("SELECT issuer FROM account WHERE id = 'a1'").get() as { issuer: string }).issuer).toBe(
      'local:credential',
    );
    // And the credential itself is untouched. This is user data, not OAuth state.
    expect((db.prepare("SELECT password FROM account WHERE id = 'a1'").get() as { password: string }).password).toBe(
      'scrypt$hash',
    );
  });

  it('moves the reused table names aside so the new DDL creates the new shape', () => {
    const upgrade = upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    expect(upgrade.renamed).toEqual([
      'legacy_oauth_application',
      'legacy_oauth_access_token',
      'legacy_oauth_consent',
    ]);
    // The new shape, not the old one hiding behind `IF NOT EXISTS`. `token` is the 1.7 column;
    // `access_token` was 1.6's, and finding it here would mean the plugin is about to query
    // columns that do not exist.
    expect(columnsOf('oauth_access_token')).toContain('token');
    expect(columnsOf('oauth_access_token')).not.toContain('access_token');
    expect(columnsOf('oauth_client')).toContain('redirect_uris');
    // Clean break: the old registry is not carried into the new tables.
    expect((db.prepare('SELECT count(*) AS c FROM oauth_client').get() as { c: number }).c).toBe(0);
  });

  it('keeps the old rows readable rather than dropping them', () => {
    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    // Renamed, not dropped: an operator re-registering relying parties can still see which
    // ones existed. An unattended DROP on a live issuer is not something a boot should do.
    expect(tableExists('legacy_oauth_application')).toBe(true);
    const row = db.prepare("SELECT name, client_id FROM legacy_oauth_application WHERE id = 'app1'").get() as {
      name: string;
      client_id: string;
    };
    expect(row).toEqual({ name: 'Old RP', client_id: 'old-client' });
  });

  it('redacts the legacy tables in the Data tab — 1.6 secrets were NOT hashed', () => {
    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    const page = introspectTable(sql, 'legacy_oauth_application', 10, 0);
    const secret = page.rows[0]?.[page.columns.indexOf('client_secret')];
    expect(secret).toBe(REDACTED);
    const tokens = introspectTable(sql, 'legacy_oauth_access_token', 10, 0);
    expect(tokens.rows[0]?.[tokens.columns.indexOf('access_token')]).toBe(REDACTED);
  });

  it('is idempotent — a second boot changes nothing', () => {
    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    const second = upgradeLegacySchema(sql);
    expect(second).toEqual({ renamed: [], added: [] });
    // Notably it does NOT rename the freshly created tables: they are matched by a column
    // only the old shape has, not by existence.
    expect(columnsOf('oauth_access_token')).toContain('token');
    expect(tableExists('legacy_legacy_oauth_access_token')).toBe(false);
  });

  it('does nothing at all to a fresh store', () => {
    const fresh = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) fresh.exec(stmt);
    expect(upgradeLegacySchema(sqlExecOf(fresh))).toEqual({ renamed: [], added: [] });
  });

  it('adds issuer and label to a pre-generic identity_provider, keeping its rows', () => {
    // A store from the #1213 era: the table exists in its original shape, with Microsoft
    // configured. `IF NOT EXISTS` would leave it columnless and every provider read would
    // fail at runtime — this is the account.issuer story on a different table.
    const store = new Database(':memory:');
    store.exec(`CREATE TABLE identity_provider (
      provider_id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      tenant_id TEXT,
      allow_signup INTEGER NOT NULL DEFAULT 0,
      trust_email INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 1)`);
    store
      .prepare('INSERT INTO identity_provider (provider_id, client_id, client_secret) VALUES (?, ?, ?)')
      .run('microsoft', 'entra-app-id', 'entra-secret');

    const upgrade = upgradeLegacySchema(sqlExecOf(store));
    for (const stmt of SCHEMA_STATEMENTS) store.exec(stmt);

    expect(upgrade.added).toEqual(
      expect.arrayContaining(['identity_provider.issuer', 'identity_provider.label', 'identity_provider.endpoints']),
    );
    const row = store
      .prepare('SELECT client_secret, issuer, label, endpoints FROM identity_provider WHERE provider_id = ?')
      .get('microsoft') as { client_secret: string; issuer: string | null; label: string | null; endpoints: string | null };
    // NULL is the backfill: every pre-existing row IS a catalogue row, and NULL is what marks one.
    expect(row).toEqual({ client_secret: 'entra-secret', issuer: null, label: null, endpoints: null });
    // Idempotent, like the rest of the upgrade.
    expect(upgradeLegacySchema(sqlExecOf(store))).toEqual({ renamed: [], added: [] });
  });

  it('finishes an interrupted identity_provider upgrade — each column is guarded on its own', () => {
    // A boot that stopped between the ALTERs: `issuer` landed, `label` and `endpoints` did
    // not. Nothing wraps the upgrade in a transaction on the Node runtime, so a guard on
    // `issuer` alone would skip the whole block and leave the table half-shaped for good.
    const store = new Database(':memory:');
    store.exec(`CREATE TABLE identity_provider (
      provider_id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      tenant_id TEXT,
      issuer TEXT,
      allow_signup INTEGER NOT NULL DEFAULT 0,
      trust_email INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 1)`);

    const upgrade = upgradeLegacySchema(sqlExecOf(store));
    expect(upgrade.added).toEqual(['identity_provider.label', 'identity_provider.endpoints']);
    const columns = (store.prepare('PRAGMA table_info("identity_provider")').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(columns).toEqual(expect.arrayContaining(['issuer', 'label', 'endpoints']));
  });

  it('finishes an interrupted account upgrade — the issuer backfill reruns until no row is null', () => {
    // The crash window on the other table: the ALTER landed, the fill did not. The fill is
    // idempotent (`WHERE issuer IS NULL`, and the adapter always writes the column), so it
    // runs on every boot rather than only beside its ALTER.
    db.exec('ALTER TABLE account ADD COLUMN issuer TEXT');
    const upgrade = upgradeLegacySchema(sql);
    expect(upgrade.added).not.toContain('account.issuer');
    expect((db.prepare("SELECT issuer FROM account WHERE id = 'a1'").get() as { issuer: string }).issuer).toBe(
      'local:credential',
    );
  });
});
