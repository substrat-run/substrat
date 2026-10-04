import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { JOB_RUN_DDL } from '../src/job-run.js';
import { clearCopyMarker, COPY_ORIGIN_DDL, emittedHere, IS_COPY_SQL, markCopyOrigin, settleCopiedWork } from '../src/scope-copy.js';
import type { SwitchSql } from '../src/system-switch.js';

/**
 * #2009: `_substrat_copy_origin` holds two facts that are set and corrected apart — the
 * copied-events mark (`events_through`, which `emittedHere()` reads) and the copy classification
 * (`is_copy`, which a CP-less host reads for primacy). Run against real SQLite, over the shared
 * DDL and over the table as a kernel before #2009 built it, because the NULL a legacy row holds
 * is what the classification's read has to mean.
 */
const NOW = '2026-10-04T00:00:00.000Z';
const SOURCE = '01JZ0000000000000000SCP001';
const DEST = '01JZ0000000000000000SCP002';
const COPIED = '01JZ00000000000000000EVT01';

/** The table as every kernel before #2009 built it: the same row, with no classification. */
const LEGACY_DDL = `
  CREATE TABLE _substrat_copy_origin (
    id INTEGER PRIMARY KEY,
    source_scope_id TEXT,
    events_through TEXT NOT NULL,
    copied_at TEXT NOT NULL
  );
`;
/** What `settleCopiedWork` settles besides the origin row: present, empty. The kernel exports the
 *  job-run table's DDL; the other three are the columns the settle reads and writes. */
const WORK_DDL = `
  CREATE TABLE _substrat_outbox (id TEXT PRIMARY KEY);
  CREATE TABLE _substrat_platform_requests (status TEXT, last_error TEXT, last_failure TEXT, settled_at TEXT);
  CREATE TABLE _substrat_deliveries (next_attempt_at TEXT, error TEXT, delivered_at TEXT);
  ${JOB_RUN_DDL}
`;

const store = (ddl: string): { db: DatabaseSync; sql: SwitchSql } => {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  db.exec(WORK_DDL);
  const sql: SwitchSql = {
    all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
    run: (q, ...p) => {
      db.prepare(q).run(...p);
    },
  };
  return { db, sql };
};
const origin = (sql: SwitchSql) => sql.all('SELECT source_scope_id, events_through, is_copy FROM _substrat_copy_origin');
const isCopy = (sql: SwitchSql) => sql.all(IS_COPY_SQL).length > 0;
/** The outbox ids `emittedHere()` lets through to dispatch. */
const dispatchable = (sql: SwitchSql) => sql.all(`SELECT id FROM _substrat_outbox WHERE ${emittedHere()} ORDER BY id`).map((r) => r.id);
/** A store holding one event, loaded into DEST from SOURCE: the mark set, nothing classified. */
const loaded = (): SwitchSql => {
  const { sql } = store(COPY_ORIGIN_DDL);
  sql.run('INSERT INTO _substrat_outbox (id) VALUES (?)', COPIED);
  settleCopiedWork(sql, DEST, SOURCE, NOW);
  return sql;
};

describe('the copy-origin row holds two facts (#2009)', () => {
  it('a load into another scope id moves the events mark and classifies nothing', () => {
    const sql = loaded();
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: 0 }]);
    expect(isCopy(sql)).toBe(false);
    expect(dispatchable(sql)).toEqual([]);
  });

  it("…and resets a classification the dump brought: that one described the scope it came from", () => {
    const { sql } = store(COPY_ORIGIN_DDL);
    sql.run('INSERT INTO _substrat_outbox (id) VALUES (?)', COPIED);
    sql.run(`INSERT INTO _substrat_copy_origin VALUES (1, ?, ?, ?, 1)`, SOURCE, COPIED, NOW);
    settleCopiedWork(sql, DEST, SOURCE, NOW);
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: 0 }]);
  });

  it('twin: a return into the same scope id touches neither fact', () => {
    const { sql } = store(COPY_ORIGIN_DDL);
    sql.run(`INSERT INTO _substrat_copy_origin VALUES (1, ?, ?, ?, 1)`, SOURCE, COPIED, NOW);
    settleCopiedWork(sql, DEST, DEST, NOW);
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: 1 }]);
  });

  it('marking sets the classification and keeps the events mark and the source', () => {
    const sql = loaded();
    expect(markCopyOrigin(sql, NOW)).toBe(true);
    expect(markCopyOrigin(sql, NOW)).toBe(false);
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: 1 }]);
    expect(isCopy(sql)).toBe(true);
  });

  it('marking a scope with no row writes one whose events mark passes every event', () => {
    const { sql } = store(COPY_ORIGIN_DDL);
    sql.run('INSERT INTO _substrat_outbox (id) VALUES (?)', COPIED);
    expect(markCopyOrigin(sql, NOW)).toBe(true);
    expect(origin(sql)).toEqual([{ source_scope_id: null, events_through: '', is_copy: 1 }]);
    expect(dispatchable(sql)).toEqual([COPIED]);
  });

  it('clearing sets the classification only: the copied events stay held', () => {
    const sql = loaded();
    markCopyOrigin(sql, NOW);
    expect(clearCopyMarker(sql)).toBe('cleared');
    expect(clearCopyMarker(sql)).toBe('absent');
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: 0 }]);
    expect(isCopy(sql)).toBe(false);
    expect(dispatchable(sql)).toEqual([]);
  });

  it('clearing a store with no row is absent, and writes nothing', () => {
    const { sql } = store(COPY_ORIGIN_DDL);
    expect(clearCopyMarker(sql)).toBe('absent');
    expect(origin(sql)).toEqual([]);
  });
});

describe('a store built before #2009 (#2009 migration)', () => {
  /** A legacy store holding the row a pre-#2009 cross-scope load wrote, then the additive ALTER. */
  const migrated = () => {
    const s = store(LEGACY_DDL);
    s.sql.run('INSERT INTO _substrat_outbox (id) VALUES (?)', COPIED);
    s.sql.run('INSERT INTO _substrat_copy_origin VALUES (1, ?, ?, ?)', SOURCE, COPIED, NOW);
    // The statement both adapters' additive passes run (DO: as written; pure: `ensureColumn`).
    s.db.exec('ALTER TABLE _substrat_copy_origin ADD COLUMN is_copy INTEGER');
    return s;
  };

  it('its row meant both facts, and still does: a copy, with its events held', () => {
    const { sql } = migrated();
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: null }]);
    expect(isCopy(sql)).toBe(true);
    expect(dispatchable(sql)).toEqual([]);
    expect(markCopyOrigin(sql, NOW)).toBe(false);
    expect(origin(sql)[0]?.is_copy).toBeNull();
  });

  it("staff's correction now reaches it: cleared, with the copied events still held", () => {
    const { sql } = migrated();
    expect(clearCopyMarker(sql)).toBe('cleared');
    expect(origin(sql)).toEqual([{ source_scope_id: SOURCE, events_through: COPIED, is_copy: 0 }]);
    expect(isCopy(sql)).toBe(false);
    expect(dispatchable(sql)).toEqual([]);
  });

  it('twin: a store that never had a row stays an install after the ALTER', () => {
    const { sql, db } = store(LEGACY_DDL);
    db.exec('ALTER TABLE _substrat_copy_origin ADD COLUMN is_copy INTEGER');
    expect(isCopy(sql)).toBe(false);
  });
});
