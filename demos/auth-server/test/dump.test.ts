import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../db/ddl.js';
import { exportDump } from '../src/dump.js';
import { REDACTED, type SqlExec } from '../src/introspect.js';

/**
 * The #590 full dump over the issuer's REAL schema (`db/ddl.ts`), driven against
 * better-sqlite3 — the same store `server.ts` runs on. What these pin:
 *
 *   - The dump is FULL FIDELITY: the signing secret, password hashes, session tokens and
 *     JWKS private keys ride along verbatim, never `[redacted]` — a dump exists to
 *     rebuild the issuer elsewhere, and a redacted one restores into an issuer whose
 *     every credential is broken. (The control-plane route in front is the gate.)
 *   - It covers every real table and skips SQLite's own `sqlite_*` internals, whose
 *     DDL is rejected on reload.
 *   - It ROUND-TRIPS: replaying DDL + rows into an empty database re-exports byte-equal,
 *     which is exactly what restore/rebind will do with it.
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
    `INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at)
     VALUES ('a1', 'ada@acme.test', 'credential', 'u1', 'scrypt$super-secret-hash', 0)`,
  ).run();
  db.prepare(
    "INSERT INTO jwks (id, public_key, private_key) VALUES ('k1', 'pub-pem', 'priv-pem')",
  ).run();
  db.prepare("INSERT INTO config (key, value) VALUES ('auth_secret', 'the-signing-secret')").run();
  sql = sqlExecOf(db);
});

const tableOf = (tables: ReturnType<typeof exportDump>, name: string) => {
  const t = tables.find((t) => t.name === name);
  expect(t, `dump is missing table '${name}'`).toBeDefined();
  return t!;
};

const rowOf = (t: ReturnType<typeof exportDump>[number], keyCol: string, key: string) => {
  const i = t.columns.indexOf(keyCol);
  const row = t.rows.find((r) => r[i] === key);
  expect(row).toBeDefined();
  return Object.fromEntries(t.columns.map((c, j) => [c, row![j]]));
};

describe('exportDump', () => {
  it('covers every real table with DDL, and skips sqlite_* internals', () => {
    const tables = exportDump(sql);
    const names = tables.map((t) => t.name);
    for (const expected of ['user', 'account', 'session', 'jwks', 'oauth_application', 'config']) {
      expect(names).toContain(expected);
    }
    expect(names.some((n) => n.startsWith('sqlite_'))).toBe(false);
    for (const t of tables) expect(t.ddl).toMatch(/^CREATE TABLE/i);
  });

  it('keeps every secret VERBATIM — a dump must rebuild the issuer, not brick it', () => {
    const tables = exportDump(sql);
    expect(rowOf(tableOf(tables, 'config'), 'key', 'auth_secret').value).toBe('the-signing-secret');
    expect(rowOf(tableOf(tables, 'account'), 'id', 'a1').password).toBe('scrypt$super-secret-hash');
    expect(rowOf(tableOf(tables, 'jwks'), 'id', 'k1').private_key).toBe('priv-pem');
    const everyCell = tables.flatMap((t) => t.rows.flat());
    expect(everyCell).not.toContain(REDACTED);
  });

  it('round-trips: replaying DDL + rows into an empty DB re-exports byte-equal', () => {
    const tables = exportDump(sql);
    const replayed = new Database(':memory:');
    // Replay the way the platform's importDump does: name order says nothing about
    // foreign keys (`account` sorts before `user`), so the whole replay runs under
    // deferred FK checks in one transaction.
    replayed.exec('BEGIN');
    replayed.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of tables) replayed.exec(t.ddl);
    for (const t of tables) {
      if (t.rows.length === 0) continue;
      const cols = t.columns.map((c) => `"${c}"`).join(', ');
      const placeholders = t.columns.map(() => '?').join(', ');
      const insert = replayed.prepare(`INSERT INTO "${t.name}" (${cols}) VALUES (${placeholders})`);
      for (const row of t.rows) insert.run(...(row as []));
    }
    replayed.exec('COMMIT');
    expect(exportDump(sqlExecOf(replayed))).toEqual(tables);
  });
});
