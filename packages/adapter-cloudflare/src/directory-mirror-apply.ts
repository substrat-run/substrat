/**
 * The objects' half of the directory's dual-write (K-68 step 3b, `directory-mirror.ts`): apply a
 * batch of changes the directory sent, each at most once and never backwards.
 *
 * - `directory_mirror_rows` holds, per (table, key), the version last applied and whether it was a
 *   delete. A change at that version or an older one is `stale` and skipped. A delete keeps its row
 *   as a TOMBSTONE, so an older copy of the row (a send still in flight, or 3c's backfill page read
 *   before the delete) cannot bring it back. Such a copy is seconds old, because every flush batch
 *   and backfill page takes its version when it reads, and a parked older change of the key is
 *   dropped when the delete applies. So a tombstone is kept `MIRROR_TOMBSTONE_MS` (a day) and then
 *   pruned, a bounded number per batch: without that, K-70's window prune of a log would leave a
 *   tombstone per pruned row, and the object would grow with tenants times time after all.
 * - `directory_mirror_parked` holds a change the object's own schema refused, almost always a
 *   foreign key whose parent row the object does not hold yet: a write to a tenant that existed
 *   before the switch was turned on, whose `tenants` row only 3c's backfill brings. A parked change
 *   is tried again after any later batch that applied something (the parent may have arrived), and
 *   is dropped once a newer change of its key applies. It is never lost and never silent: 3d's
 *   comparison lists it, and `mirrorStatus` counts it.
 *
 * Each change is its own transaction, so one refused change never rolls back another, and a batch
 * cut short by an eviction is resent whole and skips what it had already applied.
 */
import type { MirrorApplyResult, MirrorBatch, MirrorChange, MirrorValue } from './directory-mirror.js';
import { mirrorKeyColumns } from './directory-mirror.js';

export const MIRROR_TARGET_DDL = [
  `CREATE TABLE IF NOT EXISTS directory_mirror_rows (
     tbl      TEXT NOT NULL,
     row_key  TEXT NOT NULL,
     version  INTEGER NOT NULL,
     deleted  INTEGER NOT NULL,
     at       TEXT NOT NULL,
     PRIMARY KEY (tbl, row_key)
   ) WITHOUT ROWID`,
  // Tombstones only, so a live row's write pays no index row; the prune reads it, never the table.
  `CREATE INDEX IF NOT EXISTS directory_mirror_rows_tombstones ON directory_mirror_rows (at) WHERE deleted = 1`,
  `CREATE TABLE IF NOT EXISTS directory_mirror_parked (
     tbl       TEXT NOT NULL,
     row_key   TEXT NOT NULL,
     version   INTEGER NOT NULL,
     change    TEXT NOT NULL,
     error     TEXT NOT NULL,
     parked_at TEXT NOT NULL,
     PRIMARY KEY (tbl, row_key)
   ) WITHOUT ROWID`,
];

/** How long a tombstone is kept, and how many one batch prunes. */
export const MIRROR_TOMBSTONE_MS = 24 * 60 * 60 * 1000;
export const MIRROR_TOMBSTONE_PRUNE = 100;

/** Parked changes one batch tries again, oldest version first. */
export const MIRROR_PARKED_RETRY = 50;

/** DO SQLite's bound-parameter limit per statement. */
const MAX_PARAMS = 100;

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export interface MirrorTarget {
  sql: SqlStorage;
  transaction: <T>(fn: () => T) => T;
  /** The tables placed in this object; a change for any other is refused (parked). */
  tables: ReadonlySet<string>;
  now: () => number;
}

export interface MirrorTargetStatus {
  rows: number;
  tombstones: number;
  parked: number;
  version: number | null;
  /** The oldest parked changes, for 3d's report and staff. */
  parkedSample: { table: string; key: string; version: number; error: string }[];
}

type Outcome = { kind: 'applied' | 'stale'; rowsWritten: number } | { kind: 'parked'; rowsWritten: number; error: string };

const keyCache = new WeakMap<SqlStorage, Map<string, string[]>>();
function keysOf(sql: SqlStorage, table: string): string[] {
  let byTable = keyCache.get(sql);
  if (!byTable) keyCache.set(sql, (byTable = new Map()));
  let keys = byTable.get(table);
  if (!keys) byTable.set(table, (keys = mirrorKeyColumns(sql, table)));
  return keys;
}

/** Write one change (row or delete) into its table. Throws what the schema refuses. */
function write(sql: SqlStorage, change: MirrorChange): number {
  const keys = keysOf(sql, change.table);
  const keyValues = JSON.parse(change.key) as MirrorValue[];
  if (keyValues.length !== keys.length) throw new Error(`a key of ${keys.length} column(s) expected, got ${change.key}`);
  const table = quoteIdent(change.table);
  const where = keys.map((k) => (k === 'rowid' ? 'rowid = ?' : `${quoteIdent(k)} IS ?`)).join(' AND ');
  if (change.row === null) return sql.exec(`DELETE FROM ${table} WHERE ${where}`, ...keyValues).rowsWritten;
  const columns = Object.keys(change.row);
  if (columns.length + keyValues.length > MAX_PARAMS) {
    throw new Error(`${change.table} has ${columns.length} columns, over the ${MAX_PARAMS} parameters one statement may bind`);
  }
  const values = columns.map((c) => change.row![c]!);
  const exists = sql.exec(`SELECT 1 FROM ${table} WHERE ${where}`, ...keyValues).toArray().length > 0;
  if (exists) {
    const set = columns.filter((c) => c !== 'rowid');
    if (set.length === 0) return 0;
    return sql.exec(`UPDATE ${table} SET ${set.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${where}`, ...set.map((c) => change.row![c]!), ...keyValues).rowsWritten;
  }
  return sql.exec(`INSERT INTO ${table} (${columns.map((c) => (c === 'rowid' ? 'rowid' : quoteIdent(c))).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values).rowsWritten;
}

function heldVersion(sql: SqlStorage, change: MirrorChange): number | null {
  const held = sql.exec('SELECT version FROM directory_mirror_rows WHERE tbl = ? AND row_key = ?', change.table, change.key).toArray()[0] as { version: number } | undefined;
  return held ? Number(held.version) : null;
}

/** One change, at `version`, in its own transaction; refused writes are parked in another. */
function applyOne(target: MirrorTarget, change: MirrorChange, version: number): Outcome {
  const { sql } = target;
  try {
    return target.transaction((): Outcome => {
      const held = heldVersion(sql, change);
      if (held !== null && held >= version) {
        // A parked change a newer one has overtaken is settled too.
        const dropped = sql.exec('DELETE FROM directory_mirror_parked WHERE tbl = ? AND row_key = ? AND version <= ?', change.table, change.key, held).rowsWritten;
        return { kind: 'stale', rowsWritten: dropped };
      }
      if (!target.tables.has(change.table)) throw new Error(`${change.table} is not placed in this object`);
      let rowsWritten = write(sql, change);
      rowsWritten += sql.exec(
        `INSERT INTO directory_mirror_rows (tbl, row_key, version, deleted, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tbl, row_key) DO UPDATE SET version = excluded.version, deleted = excluded.deleted, at = excluded.at`,
        change.table, change.key, version, change.row === null ? 1 : 0, new Date(target.now()).toISOString(),
      ).rowsWritten;
      rowsWritten += sql.exec('DELETE FROM directory_mirror_parked WHERE tbl = ? AND row_key = ? AND version <= ?', change.table, change.key, version).rowsWritten;
      return { kind: 'applied', rowsWritten };
    });
  } catch (err) {
    const error = String((err as Error)?.message ?? err).slice(0, 500);
    const rowsWritten = target.transaction(() =>
      sql.exec(
        `INSERT INTO directory_mirror_parked (tbl, row_key, version, change, error, parked_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (tbl, row_key) DO UPDATE SET version = excluded.version, change = excluded.change, error = excluded.error, parked_at = excluded.parked_at
           WHERE excluded.version >= directory_mirror_parked.version`,
        change.table, change.key, version, JSON.stringify(change), error, new Date(target.now()).toISOString(),
      ).rowsWritten,
    );
    return { kind: 'parked', rowsWritten, error };
  }
}

/** Apply a batch in order, then retry parked changes if anything applied. */
export function applyMirrorBatch(target: MirrorTarget, batch: MirrorBatch): MirrorApplyResult {
  if (!Number.isSafeInteger(batch.version) || batch.version < 1) throw new Error(`directory mirror: not a version: ${batch.version}`);
  const out: MirrorApplyResult = { applied: 0, stale: 0, parked: 0, healed: 0, rowsWritten: 0 };
  const parkedNow = new Set<string>();
  for (const change of batch.changes) {
    const r = applyOne(target, change, batch.version);
    out.rowsWritten += r.rowsWritten;
    out[r.kind] += 1;
    if (r.kind === 'parked') parkedNow.add(`${change.table}\u0000${change.key}`);
  }
  if (out.applied > 0) {
    const before = new Date(target.now() - MIRROR_TOMBSTONE_MS).toISOString();
    out.rowsWritten += target.transaction(() =>
      target.sql.exec(
        `DELETE FROM directory_mirror_rows WHERE (tbl, row_key) IN (
           SELECT tbl, row_key FROM directory_mirror_rows WHERE deleted = 1 AND at < ? ORDER BY at LIMIT ?)`,
        before, MIRROR_TOMBSTONE_PRUNE,
      ).rowsWritten,
    );
    const parked = target.sql
      .exec('SELECT tbl, row_key, version, change FROM directory_mirror_parked ORDER BY version, tbl, row_key LIMIT ?', MIRROR_PARKED_RETRY)
      .toArray() as { tbl: string; row_key: string; version: number; change: string }[];
    for (const p of parked) {
      if (parkedNow.has(`${p.tbl}\u0000${p.row_key}`)) continue;
      const r = applyOne(target, JSON.parse(p.change) as MirrorChange, Number(p.version));
      out.rowsWritten += r.rowsWritten;
      if (r.kind === 'applied') out.healed += 1;
    }
  }
  return out;
}

export function mirrorTargetStatus(sql: SqlStorage): MirrorTargetStatus {
  const rows = sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(deleted), 0) AS d, MAX(version) AS v FROM directory_mirror_rows').one() as { n: number; d: number; v: number | null };
  const parked = Number((sql.exec('SELECT COUNT(*) AS n FROM directory_mirror_parked').one() as { n: number }).n);
  const sample = sql
    .exec('SELECT tbl, row_key, version, error FROM directory_mirror_parked ORDER BY version LIMIT 20')
    .toArray() as { tbl: string; row_key: string; version: number; error: string }[];
  return {
    rows: Number(rows.n) - Number(rows.d),
    tombstones: Number(rows.d),
    parked,
    version: rows.v === null ? null : Number(rows.v),
    parkedSample: sample.map((p) => ({ table: p.tbl, key: p.row_key, version: Number(p.version), error: p.error })),
  };
}
