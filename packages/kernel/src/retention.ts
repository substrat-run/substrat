import { substratError } from '@substrat-run/contracts';

/**
 * How long a recorded operational failure is kept (#559). Telemetry, not evidence:
 * unlike the never-swept admin log, the ops-failures table self-prunes on write in
 * every adapter, so it can never grow without bound and needs no cron wiring or
 * operator decision. 90 days comfortably outlives any incident follow-up (a
 * Cloudflare ticket round-trip) while keeping directory storage flat.
 */
export const OPS_FAILURE_RETENTION_DAYS = 90;

/**
 * How long a sweep-run row is kept (#1232). Much shorter than ops failures: this
 * is high-frequency telemetry (a pass every few minutes times every connection
 * and schedule), and its job is the recent-runs strip plus an incident window —
 * 14 days covers both. Pruned on write in every adapter, like ops failures and
 * for the same reason: the table stays bounded even where no scheduled pass runs.
 */
export const SWEEP_RUN_RETENTION_DAYS = 14;

/**
 * The drained batch's dedupe key on the directory's `_substrat_sweep_runs` (#1232), as
 * both adapters build it: `recordSweepRun` is an `INSERT OR IGNORE` against this index,
 * which is what makes a replayed drain write nothing twice.
 *
 * `kind` is in it since #1572, and that is the fix rather than a tidy-up. Every entry of
 * one drained batch shares its `request_id`, and `unit` is built from two namespaces that
 * nothing keeps apart — `<scopeId>:<operation>` for a schedule, `<scopeId>:<eventType>`
 * for a freshness verdict — while `scheduleSpec.operation` is `z.string().min(1)`. A
 * schedule named exactly like an event type its scope expects freshness on collided on
 * `(request_id, unit)`, and the ignore-on-conflict write discarded the second row with no
 * error anywhere. Both rows are signals by their absence (a stopped evaluator, a missed
 * run), so losing one read as the very thing it was meant to rule out. It is #1288's
 * collision, in the record table beside the state table.
 *
 * Shared rather than spelled in each adapter because a directory that predates it
 * re-creates it (`ensureSweepRunsIntentKind`, in both), and `lint:spine-ddl` sees only
 * the created copy. One definition keeps the re-created shape and the created shape the
 * same shape; the gate then holds each adapter's DDL to including it.
 */
export const SWEEP_RUNS_INTENT_INDEX =
  'CREATE UNIQUE INDEX IF NOT EXISTS _substrat_sweep_runs_intent ON _substrat_sweep_runs (request_id, kind, unit);';

/**
 * Whether a directory's `_substrat_sweep_runs_intent` already has `kind` among its
 * columns, read off the index's `sql` in `sqlite_master` — which DO SQLite serves and
 * `PRAGMA` does not, so both adapters detect by one strategy. `false` means the index
 * must be DROPPED and created again: `CREATE … IF NOT EXISTS` matches on the name alone,
 * so on every existing directory the old `(request_id, unit)` index would otherwise
 * stand for good, while a fresh one — and any test that starts from one — gets the new.
 */
export function sweepRunsIntentHasKind(indexSql: string): boolean {
  const columns = /\(([^()]*)\)\s*;?\s*$/.exec(indexSql)?.[1];
  return columns !== undefined && columns.split(',').some((c) => c.trim() === 'kind');
}

/**
 * How long an issue row outlives its last occurrence (#1233). Deliberately longer
 * than the 90-day evidence beneath it: an issue is the compressed memory of a
 * failure class, and "we saw this five months ago" is exactly what a regression
 * needs to be recognizable. Pruned on write like everything else here, and on the
 * scheduled pass (`pruneTelemetry`, #1632), so a quiet directory sheds it on time too.
 */
export const ISSUE_RETENTION_DAYS = 180;

/** What one `pruneTelemetry` call deleted, per table. */
export interface TelemetryPruneReport {
  opsFailures: number;
  issues: number;
  sweepRuns: number;
}

/**
 * A caller-supplied row bound, checked before it reaches a SQL `LIMIT` (#1632). SQLite reads a
 * negative `LIMIT` as no limit at all, so `-1` turns a bounded batch into an unbounded one; a
 * fractional or non-finite value is refused by SQLite itself, as a failure every later call
 * repeats. Neither is a value anyone means, so it is a configuration error, refused here with the
 * option's name, and never silently normalized into something the caller did not ask for.
 * Returns the value, so a call site can bind it in place.
 */
export function assertRowLimit(name: string, value: number): number {
  if (Number.isInteger(value) && value > 0) return value;
  throw substratError('validation_failed', `${name} must be a positive integer, got ${String(value)}`);
}

/**
 * A caller-supplied row offset, checked before it reaches a SQL `OFFSET` — `assertRowLimit`'s
 * sibling. Zero is a valid offset; a negative, fractional or non-finite one is refused rather
 * than passed to SQLite, which fails the statement on it.
 */
export function assertRowOffset(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 0) return value;
  throw substratError('validation_failed', `${name} must be a non-negative integer, got ${String(value)}`);
}

/** How many rows of EACH telemetry table one `pruneTelemetry` call deletes, by default. */
export const TELEMETRY_PRUNE_BATCH = 500;

/**
 * The three telemetry retentions as statements, for `pruneTelemetry` on both adapters (#1632).
 *
 * Each table already prunes on write, and that bound holds only while something is written:
 * a quiet directory keeps a row past its retention for as long as nothing new arrives in
 * that table. An issue is the case that matters. Erasure skips an issue whose exemplar owner
 * is unknown, on the promise that it ages out within `ISSUE_RETENTION_DAYS`, and on a
 * directory with no new failures nothing ever deleted it. The scheduled pass runs these
 * statements, which makes the stated retention a bound in time rather than in traffic.
 *
 * **Bounded per call, oldest first.** After a long pause or a restore the backlog can be a
 * year of sweep runs, and one unbounded DELETE over it is a pass that fails on the Durable
 * Object every tick. Each statement deletes at most `limit` rows, chosen through the table's
 * own retention index (`… WHERE rowid IN (SELECT rowid … ORDER BY <ts> LIMIT ?)`), so the
 * backlog drains over passes. `RETURNING` makes the count what was actually deleted on both
 * adapters, rather than a rows-written figure that would also count index writes.
 */
export function telemetryRetentionStatements(
  nowMs: number,
  limit: number,
): { table: keyof TelemetryPruneReport; sql: string; params: [string, number] }[] {
  const horizon = (days: number) => new Date(nowMs - days * 86_400_000).toISOString();
  const bounded = boundedRetentionDelete;
  return [
    {
      table: 'opsFailures',
      sql: bounded('_substrat_ops_failures', 'at'),
      params: [horizon(OPS_FAILURE_RETENTION_DAYS), limit],
    },
    {
      table: 'issues',
      sql: bounded('_substrat_issues', 'last_seen'),
      params: [horizon(ISSUE_RETENTION_DAYS), limit],
    },
    {
      table: 'sweepRuns',
      sql: bounded('_substrat_sweep_runs', 'at'),
      params: [horizon(SWEEP_RUN_RETENTION_DAYS), limit],
    },
  ];
}

/**
 * One bounded retention DELETE: at most `LIMIT ?` rows whose `column` is before `?`, oldest
 * first through the column's own index, `RETURNING 1` so the count is what was deleted. Takes
 * `(horizon, limit)`. The statement `telemetryRetentionStatements` and `pruneFindings` share.
 */
export function boundedRetentionDelete(table: string, column: string): string {
  return (
    `DELETE FROM ${table} WHERE rowid IN ` +
    `(SELECT rowid FROM ${table} WHERE ${column} < ? ORDER BY ${column} LIMIT ?) RETURNING 1`
  );
}
