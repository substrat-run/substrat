import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import {
  TABLE_OWNERS_DDL,
  assertMigrationLeavesLedgerAlone,
  assertTablesOwned,
  recordOwnershipSteps,
  runMigrationStatements,
  type ScopedSql,
  type SqlValue,
} from '../src/index.js';

/**
 * #2068 — table ownership as the migrations actually made it, on a real SQLite. The adapters
 * run every authored migration through `runMigrationStatements` + `recordOwnershipSteps`; the
 * contract suite proves that wiring on both. This pins the rule itself: what each statement's
 * diff records, what the journal replay may attribute, and what the guard refuses.
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
  const texts = new Map<string, string>();
  /** Apply one migration the way an adapter does: guard, statement by statement, record, journal. */
  const migrate = (moduleId: string, version: string, text: string) => {
    assertMigrationLeavesLedgerAlone(text, `migration ${moduleId}@${version}`);
    const steps = runMigrationStatements(sql, text, (st) => db.exec(st));
    recordOwnershipSteps(sql, moduleId, steps, 'now');
    db.prepare('INSERT INTO _substrat_migrations VALUES (?, ?, ?)').run(moduleId, version, 'now');
    texts.set(`${moduleId}@${version}`, text);
  };
  const owners = () =>
    Object.fromEntries(
      (db.prepare('SELECT table_name, module_id FROM _substrat_table_owners').all() as { table_name: string; module_id: string }[]).map(
        (r) => [r.table_name, r.module_id],
      ),
    );
  /** As a scope migrated before the ledger existed: the rows gone, the journal and tables kept. */
  const forget = () => db.exec('DELETE FROM _substrat_table_owners');
  const sqlOf = (m: string, v: string) => texts.get(`${m}@${v}`);
  const refusedFor = (moduleId: string, tables: string[], textOf = sqlOf) => {
    try {
      assertTablesOwned(sql, moduleId, tables, textOf, 'now');
      return undefined;
    } catch (e) {
      return errorCodeOf(e);
    }
  };
  return { db, sql, migrate, owners, forget, sqlOf, refusedFor };
};

describe('the ownership record, statement by statement (#2068)', () => {
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

  it('follows a rename and then a reuse of the old name, in one migration — the owners do not invert', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE notes (id TEXT)');
    // b moves a's table aside and makes a new one under the old name. Diffing the whole
    // migration would see `notes` present both sides and a new `archive` — and give b a's table.
    s.migrate('b', '1', 'ALTER TABLE notes RENAME TO archive; CREATE TABLE notes (id TEXT)');
    expect(s.owners()).toEqual({ archive: 'a', notes: 'b' });
  });

  it('drops and recreates a table in one migration: the recreating module owns the new one', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE t (id TEXT)');
    s.migrate('b', '1', 'DROP TABLE t; CREATE TABLE t (id TEXT, more TEXT)');
    expect(s.owners()).toEqual({ t: 'b' });
  });

  it('follows a virtual table and its shadow tables through create, rename and drop', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE VIRTUAL TABLE docs USING fts5(body)');
    expect(s.owners()).toMatchObject({ docs: 'a', docs_data: 'a', docs_config: 'a' });
    s.migrate('a', '2', 'ALTER TABLE docs RENAME TO papers');
    expect(Object.keys(s.owners()).sort()).toEqual(
      ['papers', 'papers_config', 'papers_content', 'papers_data', 'papers_docsize', 'papers_idx'],
    );
    s.migrate('a', '3', 'DROP TABLE papers');
    expect(s.owners()).toEqual({});
  });

  it('ignores views, TEMP tables and the spine', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE t (id TEXT); CREATE VIEW v AS SELECT id FROM t; CREATE TEMP TABLE tmp (x TEXT)');
    expect(s.owners()).toEqual({ t: 'a' });
  });

  it('refuses a migration that names the ledger — in any statement, read or write — before it runs', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE victim (id TEXT)');
    for (const forge of [
      "INSERT INTO _substrat_table_owners VALUES ('victim', 'b', 'migration', 'now')",
      "CREATE TABLE b_own (id TEXT); UPDATE \"_Substrat_Table_Owners\" SET module_id = 'b'",
      'DELETE FROM main._substrat_table_owners',
      'CREATE TABLE copy AS SELECT * FROM _substrat_table_owners',
    ]) {
      expect(() => s.migrate('b', forge.slice(0, 8), forge)).toThrow(/names _substrat_table_owners/);
    }
    expect(s.owners()).toEqual({ victim: 'a' });
  });
});

describe('the journal backfill (#2068)', () => {
  it('attributes a plainly created table to its creator, and never to a later IF NOT EXISTS', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE shared (id TEXT)');
    s.migrate('b', '1', 'CREATE TABLE IF NOT EXISTS shared (id TEXT)');
    s.forget();
    expect(s.refusedFor('b', ['shared'])).toBe('precondition_failed');
    expect(s.refusedFor('a', ['shared'])).toBeUndefined();
    expect(s.owners()).toEqual({ shared: 'a' });
  });

  it("leaves a table UNOWNED when its creator's text is unavailable — never hands it to a later IF NOT EXISTS", () => {
    const s = scope();
    s.migrate('gone', '1', 'CREATE TABLE shared (id TEXT)');
    s.migrate('b', '1', 'CREATE TABLE IF NOT EXISTS shared (id TEXT)');
    s.forget();
    // `gone` is no longer registered: its migration text is not available to the replay.
    const textOf = (m: string, v: string) => (m === 'gone' ? undefined : s.sqlOf(m, v));
    expect(s.refusedFor('b', ['shared'], textOf)).toBe('precondition_failed');
    expect(s.owners()).toEqual({});
  });

  it('treats IF NOT EXISTS as proving nothing, even as the first CREATE in the journal', () => {
    const s = scope();
    s.db.exec('CREATE TABLE made_at_runtime (id TEXT)'); // runtime DDL, in no journal
    s.migrate('b', '1', 'CREATE TABLE IF NOT EXISTS made_at_runtime (id TEXT)');
    s.forget();
    expect(s.refusedFor('b', ['made_at_runtime'])).toBe('precondition_failed');
  });

  it('a plain CREATE after an unavailable entry still proves its own creation', () => {
    const s = scope();
    s.migrate('gone', '1', 'CREATE TABLE theirs (id TEXT)');
    s.migrate('b', '1', 'CREATE TABLE mine (id TEXT)');
    s.forget();
    const textOf = (m: string, v: string) => (m === 'gone' ? undefined : s.sqlOf(m, v));
    expect(s.refusedFor('b', ['mine'], textOf)).toBeUndefined();
    expect(s.refusedFor('b', ['theirs'], textOf)).toBe('precondition_failed');
  });

  it('replays statements in order within an entry: drop then recreate, rename then reuse', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE t (id TEXT); CREATE TABLE notes (id TEXT)');
    s.migrate('b', '1', 'DROP TABLE t; CREATE TABLE t (id TEXT); ALTER TABLE notes RENAME TO archive; CREATE TABLE notes (id TEXT)');
    s.forget();
    expect(s.refusedFor('b', ['t', 'notes'])).toBeUndefined();
    expect(s.refusedFor('a', ['archive'])).toBeUndefined();
    expect(s.owners()).toEqual({ t: 'b', notes: 'b', archive: 'a' });
  });

  it('never overrides a recorded owner', () => {
    const s = scope();
    s.migrate('a', '1', 'CREATE TABLE t (id TEXT)');
    expect(s.refusedFor('b', ['t'])).toBe('precondition_failed');
    expect(s.owners()).toEqual({ t: 'a' });
  });
});
