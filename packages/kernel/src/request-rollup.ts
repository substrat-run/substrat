import {
  requestDay,
  requestRollupDay,
  utcDay,
  type RequestDay,
  type RequestRollupDay,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit, boundedRetentionDelete } from './scope-host.js';
import { utcDayMonthsBefore } from './billing-retention.js';

/**
 * The daily request rollup (#2501), as statements both adapters run against their directory:
 * the SQLite host over better-sqlite3, the hosted one inside ControlPlaneDO. Written once so the
 * two cannot keep different histories of the same fleet.
 *
 * The router writes one Analytics Engine datapoint per request it dispatches, and Analytics
 * Engine keeps them three months, sampled under load. This keeps one row per (UTC day, tenant,
 * vertical, scope) holding that day's count, so the history outlives the datapoints. The count
 * is `sum(_sample_interval)` over the day's datapoints, an ESTIMATE: an exact counter at the
 * router comes only when pricing uses requests as a unit (#39).
 *
 * `_substrat_request_day_reads` keeps one row per day the rollup tried: when, whether a read
 * succeeded, and why the last one failed. A day is rolled up once a read succeeds and is never
 * read again. A day without a successful read has no rows to say anything with, so the read row
 * is what tells "no traffic" from "not rolled up yet".
 *
 * `vertical` is `''` when a request resolved to no vertical: a primary key cannot hold a NULL
 * that compares equal to itself. The read maps it back to null.
 *
 * Beside the total, each row keeps the split by status class and the 429s, from the status the
 * router writes on each datapoint. Which of them a price counts is a later decision; once the
 * datapoints age out the split could not be recovered, so it is kept now.
 */
export const REQUEST_ROLLUP_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_request_days (
    day TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    vertical TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    requests INTEGER NOT NULL,
    class2xx INTEGER NOT NULL,
    class3xx INTEGER NOT NULL,
    class4xx INTEGER NOT NULL,
    class5xx INTEGER NOT NULL,
    rate_limited INTEGER NOT NULL,
    sampled INTEGER NOT NULL,
    PRIMARY KEY (day, tenant_id, vertical, scope_id)
  );
  CREATE INDEX IF NOT EXISTS _substrat_request_days_tenant ON _substrat_request_days (tenant_id, day);
  CREATE TABLE IF NOT EXISTS _substrat_request_day_reads (
    day TEXT PRIMARY KEY,
    attempted_at TEXT NOT NULL,
    read_at TEXT,
    row_count INTEGER,
    error TEXT,
    saturated INTEGER NOT NULL DEFAULT 0
  );
`;

/**
 * What a reader throws when a day holds more (tenant, vertical, scope) groups than one query may
 * answer: the answer would be part of the day, so it is refused. A saturated day is a standing
 * state rather than a failure. It is recorded as such (`saturated` on the day's record), is not
 * read again, and does not end the pass's reads, so the days after it are still rolled up.
 * Recognised by its `saturated` flag rather than `instanceof`, so a copy of the kernel bundled
 * elsewhere still matches.
 */
export class RequestRollupSaturated extends Error {
  readonly saturated = true as const;
}

/** Whether `err` is a `RequestRollupSaturated`. */
export const isRequestRollupSaturated = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { saturated?: unknown }).saturated === true;

/**
 * How many days back the rollup reaches: inside Analytics Engine's three months, with a margin,
 * so the oldest day read is never one the store has started to age out.
 */
export const REQUEST_ROLLUP_LOOKBACK_DAYS = 85;

/** How long after a day ends it may be read, so the datapoints written at its last instant have landed. */
export const REQUEST_ROLLUP_SETTLE_MS = 3_600_000;

/** How long a day whose read failed waits before it is tried again. */
export const REQUEST_ROLLUP_RETRY_MS = 3_600_000;

/**
 * How long one day's read may take before it counts as failed. A fleet-wide query over a day
 * answers in seconds; this is the bound that keeps a stalled one from holding the pass.
 */
export const REQUEST_ROLLUP_READ_TIMEOUT_MS = 30_000;

/** The most days one pass reads, one Analytics Engine query each. A first pass backfills over several. */
export const REQUEST_ROLLUP_DAYS_PER_PASS = 7;

/** How many rows one `pruneRequestDays` call deletes, by default. */
export const REQUEST_ROLLUP_PRUNE_BATCH = 500;

/** The most rows one `listRequestDays` call returns, and its default. */
export const REQUEST_ROLLUP_LIMIT_MAX = 10_000;
export const REQUEST_ROLLUP_LIMIT_DEFAULT = 1_000;

const DAY_MS = 86_400_000;

/** One (tenant, vertical, scope) count of one day, as the reader hands it to the rollup. */
export interface RequestDayCount {
  tenantId: string;
  /** Null when the requests resolved to no vertical. */
  vertical: string | null;
  scopeId: string;
  /** Every request routed, whatever its answer. */
  requests: number;
  /** By status class, and the 429s (a part of `class4xx`). See `requestDay`. */
  class2xx: number;
  class3xx: number;
  class4xx: number;
  class5xx: number;
  rateLimited: number;
  /** Whether Analytics Engine reweighted any of the datapoints behind `requests`. */
  sampled: boolean;
}

/**
 * One attempt to roll up a day: what was read, or why the read failed. Exactly one of the two.
 * `saturated` marks a failure as the day holding more groups than a read may answer.
 */
export type RequestDayReadInput =
  | { day: string; attemptedAt: string; counts: readonly RequestDayCount[] }
  | { day: string; attemptedAt: string; error: string; saturated?: boolean };

/** Filter for `listRequestDays`: inclusive UTC days, at most `limit` rows, ordered by (day, tenant, vertical, scope). */
export interface RequestDayFilter {
  tenantId?: TenantId;
  vertical?: string;
  scopeId?: ScopeId;
  since?: string;
  until?: string;
  limit?: number;
}

/** Filter for `listRequestRollupDays`: inclusive UTC days. */
export interface RequestRollupDayFilter {
  since?: string;
  until?: string;
}

/** The UTC day an instant falls on. */
function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function assertDay(name: string, day: string): string {
  if (!utcDay.safeParse(day).success) throw new Error(`${name} must be a UTC day (YYYY-MM-DD), got ${JSON.stringify(day)}`);
  return day;
}

/**
 * Record one attempt. A successful read replaces the day's rows with what it counted, in the
 * caller's transaction, and marks the day read. A failed one records only the attempt and its
 * error: the day's rows and its last successful read stay as they were.
 *
 * Every count is parsed before anything is written, so a malformed one (a tenant id that is not
 * an id, a negative count) refuses the whole day rather than writing part of it. Returns how many
 * rows were written.
 */
export function recordRequestDayRows(sql: RedactionSql, input: RequestDayReadInput): number {
  const day = assertDay('day', input.day);
  const attemptedAt = new Date(input.attemptedAt).toISOString();
  if ('error' in input) {
    sql(
      `INSERT INTO _substrat_request_day_reads (day, attempted_at, read_at, row_count, error, saturated)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         attempted_at = excluded.attempted_at, error = excluded.error, saturated = excluded.saturated`,
      [day, attemptedAt, input.error || 'the read failed', input.saturated ? 1 : 0],
    );
    return 0;
  }
  const rows = input.counts.map((c) =>
    requestDay.parse({
      day,
      tenantId: c.tenantId,
      vertical: c.vertical === '' ? null : c.vertical,
      scopeId: c.scopeId,
      requests: c.requests,
      class2xx: c.class2xx,
      class3xx: c.class3xx,
      class4xx: c.class4xx,
      class5xx: c.class5xx,
      rateLimited: c.rateLimited,
      sampled: c.sampled,
      estimated: true,
    }),
  );
  sql('DELETE FROM _substrat_request_days WHERE day = ?', [day]);
  for (const r of rows) {
    // Two counts for one key are one key's count: summed, never one dropped.
    sql(
      `INSERT INTO _substrat_request_days
         (day, tenant_id, vertical, scope_id, requests, class2xx, class3xx, class4xx, class5xx, rate_limited, sampled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, tenant_id, vertical, scope_id) DO UPDATE SET
         requests = _substrat_request_days.requests + excluded.requests,
         class2xx = _substrat_request_days.class2xx + excluded.class2xx,
         class3xx = _substrat_request_days.class3xx + excluded.class3xx,
         class4xx = _substrat_request_days.class4xx + excluded.class4xx,
         class5xx = _substrat_request_days.class5xx + excluded.class5xx,
         rate_limited = _substrat_request_days.rate_limited + excluded.rate_limited,
         sampled = MAX(_substrat_request_days.sampled, excluded.sampled)`,
      [
        day,
        r.tenantId,
        r.vertical ?? '',
        r.scopeId,
        r.requests,
        r.class2xx,
        r.class3xx,
        r.class4xx,
        r.class5xx,
        r.rateLimited,
        r.sampled ? 1 : 0,
      ],
    );
  }
  const written = (sql('SELECT COUNT(*) AS n FROM _substrat_request_days WHERE day = ?', [day]) as { n: number }[])[0]?.n ?? 0;
  sql(
    `INSERT INTO _substrat_request_day_reads (day, attempted_at, read_at, row_count, error, saturated)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT (day) DO UPDATE SET
       attempted_at = excluded.attempted_at, read_at = excluded.read_at, row_count = excluded.row_count,
       error = NULL, saturated = 0`,
    [day, attemptedAt, attemptedAt, written],
  );
  return written;
}

interface RequestDayRow {
  day: string;
  tenant_id: string;
  vertical: string;
  scope_id: string;
  requests: number;
  class2xx: number;
  class3xx: number;
  class4xx: number;
  class5xx: number;
  rate_limited: number;
  sampled: number;
}

/** Read stored day counts — see `RequestDayFilter`. Every row is parsed on the way out. */
export function listRequestDayRows(sql: RedactionSql, filter: RequestDayFilter = {}): RequestDay[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tenantId !== undefined) {
    where.push('tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.vertical !== undefined) {
    where.push('vertical = ?');
    params.push(filter.vertical);
  }
  if (filter.scopeId !== undefined) {
    where.push('scope_id = ?');
    params.push(filter.scopeId);
  }
  if (filter.since !== undefined) {
    where.push('day >= ?');
    params.push(assertDay('since', filter.since));
  }
  if (filter.until !== undefined) {
    where.push('day <= ?');
    params.push(assertDay('until', filter.until));
  }
  const limit = Math.min(assertRowLimit('limit', filter.limit ?? REQUEST_ROLLUP_LIMIT_DEFAULT), REQUEST_ROLLUP_LIMIT_MAX);
  params.push(limit);
  const rows = sql(
    `SELECT day, tenant_id, vertical, scope_id, requests, class2xx, class3xx, class4xx, class5xx, rate_limited, sampled
       FROM _substrat_request_days
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day, tenant_id, vertical, scope_id LIMIT ?`,
    params,
  ) as RequestDayRow[];
  return rows.map((r) =>
    requestDay.parse({
      day: r.day,
      tenantId: r.tenant_id,
      vertical: r.vertical === '' ? null : r.vertical,
      scopeId: r.scope_id,
      requests: r.requests,
      class2xx: r.class2xx,
      class3xx: r.class3xx,
      class4xx: r.class4xx,
      class5xx: r.class5xx,
      rateLimited: r.rate_limited,
      sampled: r.sampled === 1,
      estimated: true,
    }),
  );
}

/** The rollup's record of each day it tried, in day order — see `RequestRollupDayFilter`. */
export function listRequestRollupDayRows(sql: RedactionSql, filter: RequestRollupDayFilter = {}): RequestRollupDay[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.since !== undefined) {
    where.push('day >= ?');
    params.push(assertDay('since', filter.since));
  }
  if (filter.until !== undefined) {
    where.push('day <= ?');
    params.push(assertDay('until', filter.until));
  }
  const rows = sql(
    `SELECT day, attempted_at, read_at, row_count, error, saturated FROM _substrat_request_day_reads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day`,
    params,
  ) as {
    day: string;
    attempted_at: string;
    read_at: string | null;
    row_count: number | null;
    error: string | null;
    saturated: number;
  }[];
  return rows.map((r) =>
    requestRollupDay.parse({
      day: r.day,
      attemptedAt: r.attempted_at,
      readAt: r.read_at,
      rows: r.row_count,
      error: r.error,
      saturated: r.saturated === 1,
    }),
  );
}

/**
 * The first day a retention of `months` keeps, or null when `months` is null (kept for good).
 * A horizon is a whole number of months, at least one.
 */
export function requestRollupHorizon(nowMs: number, months: number | null): string | null {
  if (months === null) return null;
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`a billing retention must be a whole number of months, at least one, or null, got ${String(months)}`);
  }
  return utcDayMonthsBefore(nowMs, months);
}

/**
 * Delete at most `limit` day rows older than a retention of `months`, oldest first, then the
 * read rows of the days that are gone. `months` null deletes nothing. Returns how many day rows went.
 */
export function pruneRequestDayRows(sql: RedactionSql, nowMs: number, limit: number, months: number | null): number {
  const capped = assertRowLimit('limit', limit);
  const horizon = requestRollupHorizon(nowMs, months);
  if (horizon === null) return 0;
  const pruned = sql(boundedRetentionDelete('_substrat_request_days', 'day'), [horizon, capped]).length;
  // A read row goes only once its day holds no row, so a day still being pruned stays marked read
  // and is not rolled up again in between.
  sql(
    `DELETE FROM _substrat_request_day_reads
      WHERE day < ? AND NOT EXISTS (SELECT 1 FROM _substrat_request_days d WHERE d.day = _substrat_request_day_reads.day)`,
    [horizon],
  );
  return pruned;
}

/**
 * The days the rollup should read now, oldest first: every day from `lookbackDays` ago to the
 * last day that ended at least `settleMs` ago, without a successful read, not saturated, and either
 * never tried or last tried at least `retryMs` ago. A day before `horizon` (the retention's first kept day)
 * is not read, so a prune and a rollup never take turns on the same day. Oldest first, because the
 * oldest day is the next one Analytics Engine ages out.
 */
export function requestRollupDueDays(input: {
  nowMs: number;
  reads: readonly { day: string; attemptedAt: string; readAt: string | null; saturated?: boolean }[];
  lookbackDays: number;
  settleMs: number;
  retryMs: number;
  horizon: string | null;
}): string[] {
  const byDay = new Map(input.reads.map((r) => [r.day, r]));
  const retryBefore = new Date(input.nowMs - input.retryMs).toISOString();
  const last = utcDayOf(input.nowMs - input.settleMs - DAY_MS);
  let first = utcDayOf(input.nowMs - input.lookbackDays * DAY_MS);
  if (input.horizon !== null && input.horizon > first) first = input.horizon;
  const due: string[] = [];
  for (let ms = Date.parse(`${first}T00:00:00Z`); utcDayOf(ms) <= last; ms += DAY_MS) {
    const day = utcDayOf(ms);
    const read = byDay.get(day);
    if (read?.readAt) continue;
    // Saturated is a standing state: the day's group count will not shrink, so reading it again
    // would spend a query on the same refusal.
    if (read?.saturated) continue;
    if (read && read.attemptedAt > retryBefore) continue;
    due.push(day);
  }
  return due;
}
