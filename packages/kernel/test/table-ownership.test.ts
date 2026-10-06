import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import {
  TABLE_OWNERS_DDL,
  assertTablesOwned,
  moduleTableNames,
  recordMigrationOwnership,
  type ScopedSql,
  type SqlValue,
} from '../src/index.js';

/**
 * #2068 — table ownership as the migrations actually made it, on a real SQLite. The adapters
 * call `recordMigrationOwnership` around every migration they apply; the contract suite proves
 * that wiring on both. This pins the rule itself: what a diff records, and what the journal
 * backfill attributes.
 */
const scope = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`${TABLE_OWNERS_DDL}
    CREATE TABLE _substrat_migrations (module_id TEXT NOT NULL, version TEXT NOT NULL, applied_at TEXT NOT NULL,
      PRIMARY KEY (module_id, version));`);
  const sql: ScopedSql = {
    query: <T>(q: string, p: readonly SqlValue[] = []) => db.prepare(q).all(...(p as never[])) as T[],
    exec: (q: string, p: readonly SqlValue[] = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
  };
  const migrations = new Map<string, string>();
  /** Apply one migration the way an adapter does: diff, run, record, journal. */
  const migrate = (moduleId: string, version: string, text: string) => {
    const before = moduleTableNames(sql);
    db.exec(text);
    recordMigrationOwnership(sql, moduleId, text, before, 'now');
    db.prepare('INSERT INTO _substrat_migrations VALUES (?, ?, ?)').run(moduleId, version, 'now');
    migrations.set(`${moduleId}@${version}`, text);
  };
  const owners = () =>
    Object.fromEntries(
      (db.prepare('SELECT table_name, module_id FROM _substrat_table_owners').all() as { table_name: string; module_id: string }[]).map(
        (r) => [r.table_name, r.module_id],
      ),
    );
  const sqlOf = (m: string, v: string) => migrations.get(`${m}@${v}`);
  return { db, sql, migrate, owners, sqlOf };
};

describe('recordMigrationOwnership (#2068)', () => {
  it("records what a migration created — and nothing for IF NOT EXISTS on another module's table", () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE shared (id TEXT)');
    s.migrate('b', '1', 'CREATE TABLE IF NOT EXISTS shared (id TEXT); CREATE TABLE b_own (id TEXT)');
    expect(s.owners()).toEqual({ shared: 'a', b_own: 'b' });
  });

  it('keeps the owner through a rename, and forgets a dropped table', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE old_name (id TEXT); CREATE TABLE doomed (id TEXT)');
    s.migrate('a', '2', 'ALTER TABLE old_name RENAME TO new_name; DROP TABLE doomed');
    expect(s.owners()).toEqual({ new_name: 'a' });
  });

  it('ignores views, TEMP tables and the spine', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE t (id TEXT); CREATE VIEW v AS SELECT id FROM t; CREATE TEMP TABLE tmp (x TEXT)');
    expect(s.owners()).toEqual({ t: 'a' });
  });
});

describe('the journal backfill (#2068)', () => {
  it('attributes an unrecorded table to the FIRST module in journal order that creates it', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE shared (id TEXT)');
    s.migrate('b', '1', 'CREATE TABLE IF NOT EXISTS shared (id TEXT)');
    s.db.exec('DELETE FROM _substrat_table_owners');
    // b's IF NOT EXISTS came second and created nothing: the backfill does not hand it the table.
    const err = (() => {
      try {
        assertTablesOwned(s.sql, 'b', ['shared'], s.sqlOf, 'now');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(errorCodeOf(err)).toBe('precondition_failed');
    expect(s.owners()).toEqual({ shared: 'a' });
    expect(() => assertTablesOwned(s.sql, 'a', ['shared'], s.sqlOf, 'now')).not.toThrow();
  });

  it('leaves a table no journalled migration created unowned, and the erasure refused', () => {
    const s = scope();
    s.db.exec('CREATE TABLE runtime_made (id TEXT)');
    expect(() => assertTablesOwned(s.sql, 'a', ['runtime_made'], s.sqlOf, 'now')).toThrow(/does not record/);
    expect(s.owners()).toEqual({});
  });

  it('never overrides a recorded owner', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE t (id TEXT)');
    expect(() => assertTablesOwned(s.sql, 'b', ['t'], s.sqlOf, 'now')).toThrow(/does not record/);
    expect(s.owners()).toEqual({ t: 'a' });
  });
});
