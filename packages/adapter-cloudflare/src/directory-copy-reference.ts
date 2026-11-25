/**
 * The directory tables a daily copy can carry by reference (#3325, D-78's interim until the
 * per-tenant export of the tenant-scale RFC's step 3).
 *
 * The copy's first page used to copy every directory table into a snapshot inside the directory
 * (#2868), so that pages read in later turns all read one instant. That wrote one row per directory
 * row every day, whatever had changed: 44 % of the directory's rows written, and twice its bytes
 * while a copy ran. Most of it was these five tables.
 *
 * A table here is read live instead, up to the largest rowid it held when the copy began (its
 * horizon). That is the same instant the snapshot gives, as long as nothing changes a row under the
 * horizon, so each table states what can, and the copy holds it to that:
 *
 * - `append-only`: rows are added and never rewritten. A row may be removed (a version's migrations
 *   when its vertical is deleted or the version is split again), and that is caught: a copy whose
 *   table holds fewer rows under the horizon at the end of its read than at the start is refused,
 *   and the next pass takes a new one. No writer may UPDATE, REPLACE or upsert one; the adapter's
 *   suite scans every source for it (`directory-copy-by-reference.test.ts`).
 * - `log`: rows are added, and leave or change only in ways a restore does not need undone. Each
 *   entry says which, and where a row that left still is.
 *
 * Every row a by-reference read carries was in the table at the copy's instant; a row inserted
 * later sits above the horizon and is not read. A deploy that alters or rebuilds one of these
 * tables between two pages changes its DDL, and the copy is refused rather than read across it.
 *
 * Today none of these tables is in the lake: only the scopes' outbox stream is. Drained access-log
 * rows are in R2 (`access-log/` beside the copies). So nothing is left out of a copy here; it is
 * only no longer written twice. The tenant-scale RFC's step 2 ships these logs to the lake; a table
 * it starts pruning stays `log`, and the admin log, if it is pruned, moves from `append-only` to
 * `log` in the same change (the source scan refuses the DELETE until it does).
 */

export type DirectoryReferenceKind = 'append-only' | 'log';

export interface DirectoryReferenceTable {
  kind: DirectoryReferenceKind;
  /** What may change under the horizon while a copy is read, and why the copy is still right. */
  why: string;
}

export const DIRECTORY_COPY_BY_REFERENCE: Readonly<Record<string, DirectoryReferenceTable>> = {
  _substrat_admin_log: {
    kind: 'append-only',
    why: 'The compliance witness of every change: inserted by recordAdmin, never updated or deleted.',
  },
  vertical_version_migrations: {
    kind: 'append-only',
    why:
      "A version's migration rows, written once when it is stored or split. They are deleted only with " +
      'their vertical, or replaced when a version is split again; either during a copy refuses it.',
  },
  _substrat_access_log: {
    kind: 'log',
    why:
      'Staff reads (K-24). A row is stamped drained only after its batch is in R2 (`access-log/`), and ' +
      'only a drained row is deleted, so a row the copy misses is in R2, and a stamp it carries is true.',
  },
  _substrat_ops_failures: {
    kind: 'log',
    why:
      'Failures, kept 90 days: a row leaves only by that retention, and its text changes only by ' +
      "subject erasure, which a copy is right to carry (the snapshot carried the unerased text instead).",
  },
  _substrat_sweep_runs: {
    kind: 'log',
    why:
      'One row per unit outcome, kept 14 days: inserted (OR IGNORE, never replaced), removed only by ' +
      'that retention, and its error text changed only by subject erasure.',
  },
};

/** A column name as an SQL identifier. The names are the directory's own, read from its schema. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The `verify` comparison of one table's snapshot (`copy`, its rows keyed by the source rowid,
 * cells in neutral columns `c0…`) against the live table: one row of `snapshotRows`, `missing`,
 * `changed` and `d<i>` (rows whose column `i` differs). A join on rowid, so the live table is read by
 * lookup and nothing is sorted into a temporary table.
 */
export function referenceCompareSql(copy: string, table: string, columns: readonly string[]): string {
  const differs = columns.map((col, i) => `c.c${i} IS NOT t.${quoteIdent(col)}`);
  const perColumn = differs.map((d, i) => `coalesce(SUM(t.rowid IS NOT NULL AND ${d}), 0) AS d${i}`);
  return (
    `SELECT count(*) AS snapshotRows, coalesce(SUM(t.rowid IS NULL), 0) AS missing, ` +
    `coalesce(SUM(t.rowid IS NOT NULL AND (${differs.join(' OR ') || '0'})), 0) AS changed` +
    (perColumn.length ? `, ${perColumn.join(', ')}` : '') +
    ` FROM ${quoteIdent(copy)} c LEFT JOIN ${quoteIdent(table)} t ON t.rowid = c.rowid`
  );
}

/** Live rows at or under the horizon (`?`) that the snapshot `copy` does not hold. */
export const referenceExtraSql = (copy: string, table: string): string =>
  `SELECT count(*) AS n FROM ${quoteIdent(table)} t WHERE t.rowid <= ? ` +
  `AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(copy)} c WHERE c.rowid = t.rowid)`;
