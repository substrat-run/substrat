import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { upgradeLegacySchema } from '../db/upgrade.js';
import { introspectTable, REDACTED, type SqlExec } from '../src/introspect.js';

/**
 * Booting the current issuer on a database an older one wrote.
 *
 * `CREATE TABLE IF NOT EXISTS` is this vertical's whole migration story, and it is silently
 * wrong across these moves in three ways — a table that carries a required column nothing
 * writes any more, a table that gained a column, and two table NAMES reused with different
 * columns. All three land at runtime, in a Durable Object, against a store that already has
 * users in it. So the upgrade runs on every boot, and this builds genuine 1.6-shaped and
 * 1.7.0–1.7.2-shaped databases to prove it.
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
  // No `issuer` column — 1.7.0–1.7.2 added it and 1.7.3 took it back out (see `AS_1_7_0`).
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
  // The three 1.6 tables whose NAMES 1.7 keeps. They were missing from this fixture for as
  // long as it existed, which is exactly how `jwks` went un-upgraded: a table the fixture does
  // not build is a table no assertion here can be wrong about.
  `CREATE TABLE session (
    id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, impersonated_by TEXT)`,
  `CREATE TABLE verification (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  // No `alg`, no `crv` — those are the 1.7 `jwt` plugin's.
  `CREATE TABLE jwks (
    id TEXT PRIMARY KEY NOT NULL, public_key TEXT NOT NULL, private_key TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER)`,
];

/**
 * `account` as Better Auth 1.7.0–1.7.2 (and this issuer's earlier DDL) created it: a required
 * `issuer` and a unique `(issuer, account_id)` index. Better Auth 1.7.3 stopped writing the
 * column, so on a store shaped like this every sign-up and account link is a NOT NULL failure.
 */
const AS_1_7_0 = [
  'DROP TABLE account',
  `CREATE TABLE account (
    id TEXT PRIMARY KEY NOT NULL, issuer TEXT NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT, refresh_token TEXT, id_token TEXT,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX account_user_id_idx ON account (user_id)',
  'CREATE UNIQUE INDEX account_issuer_account_id_idx ON account (issuer, account_id)',
];

/** Turn the seeded 1.6 store into one that ran 1.7.0–1.7.2, keeping the two people in it. */
function asRanBy172(database: Database.Database): void {
  for (const stmt of AS_1_7_0) database.exec(stmt);
  database
    .prepare(
      "INSERT INTO account (id, issuer, account_id, provider_id, user_id, password) VALUES ('a1', 'local:credential', 'ada@acme.test', 'credential', 'u1', 'scrypt$hash')",
    )
    .run();
  database
    .prepare(
      "INSERT INTO account (id, issuer, account_id, provider_id, user_id, id_token) VALUES ('a2', 'https://accounts.google.com', 'google-sub-1', 'google', 'u1', 'idt')",
    )
    .run();
}

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
  db.prepare("INSERT INTO jwks (id, public_key, private_key) VALUES ('kid-1', '{\"kty\":\"OKP\"}', 'encrypted')").run();
  sql = sqlExecOf(db);
});

describe('upgrading a 1.6 store', () => {
  it('does not add account.issuer — 1.7.3 stopped writing it, so a column nothing fills would be a trap', () => {
    const upgrade = upgradeLegacySchema(sql);

    expect(upgrade.added).not.toContain('account.issuer');
    expect(upgrade.dropped).toEqual([]);
    expect(columnsOf('account')).not.toContain('issuer');
    // The credential itself is untouched. This is user data, not OAuth state.
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
    expect(second).toEqual({ renamed: [], added: [], dropped: [] });
    // Notably it does NOT rename the freshly created tables: they are matched by a column
    // only the old shape has, not by existence.
    expect(columnsOf('oauth_access_token')).toContain('token');
    expect(tableExists('legacy_legacy_oauth_access_token')).toBe(false);
  });

  it('does nothing at all to a fresh store', () => {
    const fresh = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) fresh.exec(stmt);
    expect(upgradeLegacySchema(sqlExecOf(fresh))).toEqual({ renamed: [], added: [], dropped: [] });
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
    expect(upgradeLegacySchema(sqlExecOf(store))).toEqual({ renamed: [], added: [], dropped: [] });
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

  it('adds jwks.alg and jwks.crv, and leaves the existing signing key alone', () => {
    const upgrade = upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    expect(upgrade.added).toEqual(expect.arrayContaining(['jwks.alg', 'jwks.crv']));
    // NULL, not a guess: the `jwt` plugin reads a null `alg` as its configured default, which
    // is what a key minted before the column existed actually is. And the same `kid` — a
    // relying party that cached this key must still be able to verify with it.
    expect(db.prepare("SELECT id, private_key, alg, crv FROM jwks WHERE id = 'kid-1'").get()).toEqual({
      id: 'kid-1',
      private_key: 'encrypted',
      alg: null,
      crv: null,
    });
  });

  it('finishes an interrupted jwks upgrade — each column is guarded on its own', () => {
    db.exec('ALTER TABLE jwks ADD COLUMN alg TEXT');
    expect(upgradeLegacySchema(sql).added).toEqual(expect.arrayContaining(['jwks.crv']));
    expect(columnsOf('jwks')).toEqual(expect.arrayContaining(['alg', 'crv']));
  });

  it('leaves no surviving table short of a column the current schema declares', () => {
    // The general form of every case above, and the one that does not need anybody to
    // remember. A column added to the DDL with no entry in `db/upgrade.ts` is invisible on a
    // fresh store and wrong on every existing one — and on a Durable Object not even loudly:
    // a quoted name that matches no column is read there as a string literal, so `jwks.alg`
    // came back as the text "alg" and surfaced as a JOSE error three layers up.
    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    const fresh = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) fresh.exec(stmt);
    const tables = (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    const missing = tables.flatMap((table) => {
      const have = new Set(columnsOf(table));
      return (fresh.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
        .filter((c) => !have.has(c.name))
        .map((c) => `${table}.${c.name}`);
    });
    expect(missing).toEqual([]);
  });

  it('leaves no surviving column the current schema does not declare and cannot be left empty', () => {
    // The other direction of the test above, and the one that would have caught this whole
    // class: a column the schema no longer has, that is NOT NULL with no default, is a store
    // where the adapter's insert fails — which is `account.issuer` after Better Auth 1.7.3.
    asRanBy172(db);
    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    const fresh = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) fresh.exec(stmt);
    const tables = (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    const stranded = tables.flatMap((table) => {
      const declared = new Set((fresh.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
      return (
        db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; notnull: number; dflt_value: unknown }[]
      )
        .filter((c) => !declared.has(c.name) && c.notnull === 1 && c.dflt_value === null)
        .map((c) => `${table}.${c.name}`);
    });
    expect(stranded).toEqual([]);
  });
});

describe('upgrading a store that ran Better Auth 1.7.0–1.7.2', () => {
  beforeEach(() => asRanBy172(db));

  it('drops account.issuer and its index, keeping every row and credential', () => {
    const upgrade = upgradeLegacySchema(sql);

    expect(upgrade.dropped).toEqual(['account.issuer']);
    expect(columnsOf('account')).not.toContain('issuer');
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'account_issuer_account_id_idx'").all() as unknown[])
        .length,
    ).toBe(0);
    // People keep their ways in. Nothing about a row but the dropped column changed.
    expect(
      db.prepare('SELECT id, provider_id, account_id, password, id_token FROM account ORDER BY id').all(),
    ).toEqual([
      { id: 'a1', provider_id: 'credential', account_id: 'ada@acme.test', password: 'scrypt$hash', id_token: null },
      { id: 'a2', provider_id: 'google', account_id: 'google-sub-1', password: null, id_token: 'idt' },
    ]);
  });

  it('refuses to drop the column while two rows differ only by issuer, and changes nothing', () => {
    // A provider id pointed at a second upstream: under the old `(issuer, account_id)` key these
    // are two accounts, under 1.7.3's `(provider_id, account_id)` they are one key with two
    // rows, and `issuer` is the only thing that tells them apart. Dropping it would make that
    // permanent, so the upgrade must stop with the table exactly as it found it.
    db.prepare(
      "INSERT INTO account (id, issuer, account_id, provider_id, user_id) VALUES ('a3', 'https://old-upstream.test', 'shared-sub', 'acme', 'u1')",
    ).run();
    db.prepare(
      "INSERT INTO account (id, issuer, account_id, provider_id, user_id) VALUES ('a4', 'https://new-upstream.test', 'shared-sub', 'acme', 'u1')",
    ).run();
    const before = db.prepare('SELECT * FROM account ORDER BY id').all();

    expect(() => upgradeLegacySchema(sql)).toThrow(/cannot drop account\.issuer.*acme × 1/s);

    expect(columnsOf('account')).toContain('issuer');
    expect(db.prepare('SELECT * FROM account ORDER BY id').all()).toEqual(before);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'account_issuer_account_id_idx'").all() as unknown[])
        .length,
    ).toBe(1);
    // Still refuses on the next boot, until an operator resolves it — never a silent drop.
    expect(() => upgradeLegacySchema(sql)).toThrow(/cannot drop account\.issuer/);
  });

  it('names providers and counts in that refusal, never an account id', () => {
    // A BankID `account_id` is a personal number, and this message goes to a log.
    for (const [id, issuer] of [['b1', 'x'], ['b2', 'y']] as const) {
      db.prepare('INSERT INTO account (id, issuer, account_id, provider_id, user_id) VALUES (?, ?, ?, ?, ?)').run(
        id,
        issuer,
        '199001011234',
        'bankid',
        'u1',
      );
    }
    let message = '';
    try {
      upgradeLegacySchema(sql);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('bankid × 1');
    expect(message).not.toContain('199001011234');
  });

  it('does not mistake the same account id at two providers for a collision', () => {
    // The pair is `(provider_id, account_id)`: one person holding the same id at two providers
    // is the ordinary case, and the one the guide warns a compound key must still allow.
    db.prepare("INSERT INTO account (id, issuer, account_id, provider_id, user_id) VALUES ('c1', 'https://a.test', 'same-id', 'acme', 'u1')").run();
    db.prepare("INSERT INTO account (id, issuer, account_id, provider_id, user_id) VALUES ('c2', 'https://b.test', 'same-id', 'other', 'u1')").run();
    expect(upgradeLegacySchema(sql).dropped).toEqual(['account.issuer']);
  });

  it('takes a write that names no issuer — the sign-up that failed before the drop', () => {
    // What Better Auth 1.7.3+ does for a new sign-up: a row with no `issuer`. On the store as
    // 1.7.0–1.7.2 left it this is a NOT NULL failure, for password sign-ups included.
    expect(() =>
      db
        .prepare("INSERT INTO account (id, account_id, provider_id, user_id) VALUES ('a3', 'x', 'bankid', 'u1')")
        .run(),
    ).toThrow(/NOT NULL constraint failed: account\.issuer/);

    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    db.prepare("INSERT INTO account (id, account_id, provider_id, user_id) VALUES ('a3', 'x', 'bankid', 'u1')").run();
    expect((db.prepare("SELECT count(*) AS c FROM account").get() as { c: number }).c).toBe(3);
  });

  it('is idempotent, and does not bring the column back on the next boot', () => {
    upgradeLegacySchema(sql);
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    expect(upgradeLegacySchema(sql)).toEqual({ renamed: [], added: [], dropped: [] });
    expect(columnsOf('account')).not.toContain('issuer');
  });

  it('finishes an interrupted drop — the index went, the column did not', () => {
    // Nothing wraps these statements in a transaction on the Node runtime, so a boot can stop
    // between them. Guarded per statement: the column drop must not depend on the index still
    // being there to find.
    db.exec('DROP INDEX account_issuer_account_id_idx');
    const upgrade = upgradeLegacySchema(sql);
    expect(upgrade.dropped).toEqual(['account.issuer']);
    expect(columnsOf('account')).not.toContain('issuer');
  });
});
