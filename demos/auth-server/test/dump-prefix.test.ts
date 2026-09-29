import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { exportDump } from '../src/dump.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * #1881: `exportDump` filtered `NOT LIKE 'sqlite_%'`, where `_` is a wildcard. Every table
 * the issuer really has is still dumped under the literal-prefix filter, a table merely
 * named like the prefix is now dumped too, and SQLite's own `sqlite_*` stay out.
 */
const sqlExecOf = (db: Database.Database): SqlExec => ({
  exec(query: string, ...bindings: unknown[]) {
    const stmt = db.prepare(query);
    const columnNames = stmt.columns().map((c) => c.name);
    const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
    const raw = stmt.raw(true).all(...(bindings as [])) as unknown[][];
    return { columnNames, toArray: () => objects, raw: () => raw.values() };
  },
});

describe('exportDump reserved prefix (#1881)', () => {
  it('dumps every real table, including one named like sqlite_, and never sqlite_sequence', () => {
    const db = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    const real = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    db.exec('CREATE TABLE sqlitedata (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec('CREATE TABLE autoinc (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
    db.exec("INSERT INTO autoinc (v) VALUES ('a')");
    const names = exportDump(sqlExecOf(db)).map((t) => t.name);
    expect(names).toEqual([...real, 'sqlitedata', 'autoinc'].sort());
    expect(names).not.toContain('sqlite_sequence');
  });
});
