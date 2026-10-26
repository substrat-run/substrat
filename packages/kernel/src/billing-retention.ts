import { utcDay } from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit, boundedRetentionDelete } from './retention.js';

/**
 * How long the platform keeps its billing rollups (#2501): the compact per-(tenant, vertical)
 * daily counts a later invoice, or a dispute about one, is answered from. Today that is the daily
 * request rollup (`request-rollup.ts`) and the daily meter snapshot (`meter-days.ts`). The raw
 * captures behind a rollup keep their own, shorter windows, and no existing retention follows
 * this constant: the storage gauge's day rows stay `STORAGE_GAUGE_RETENTION_MONTHS` and model
 * usage stays `MODEL_USAGE_RETENTION_DAYS`.
 *
 * `null` means the rollups are never pruned. That is a placeholder, not a decision: the horizon
 * waits on the maintainer's bookkeeping, and no legal period is written here. Keeping
 * everything is the reversible default, since a pruned row cannot be brought back while a
 * horizon can be set later. The rollups hold counts and bytes only, never personal content.
 */
export const BILLING_ROLLUP_RETENTION_MONTHS: number | null = null;

/**
 * The first day a billing retention of `months` keeps, or null when `months` is null (kept for
 * good). A horizon is a whole number of months, at least one. Every billing rollup prunes by it.
 */
export function billingRollupHorizon(nowMs: number, months: number | null): string | null {
  if (months === null) return null;
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`a billing retention must be a whole number of months, at least one, or null, got ${String(months)}`);
  }
  return utcDayMonthsBefore(nowMs, months);
}

/**
 * The UTC day `months` calendar months before `nowMs`. The day of the month is clamped to the
 * target month's last day, so the 31st counts back to the 28th, 29th or 30th rather than rolling
 * forward into the month after.
 */
export function utcDayMonthsBefore(nowMs: number, months: number): string {
  const now = new Date(nowMs);
  const month = now.getUTCMonth() - months;
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(now.getUTCFullYear(), month, Math.min(now.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

/** The UTC day an instant falls on. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `day`, refused unless it is a UTC day that exists (`YYYY-MM-DD`). */
export function assertUtcDay(name: string, day: string): string {
  if (!utcDay.safeParse(day).success) throw new Error(`${name} must be a UTC day (YYYY-MM-DD), got ${JSON.stringify(day)}`);
  return day;
}

/** Push an inclusive window of UTC days onto a `WHERE` list and its parameters, each day checked first. */
export function pushDayWindow(filter: { since?: string; until?: string }, where: string[], params: (string | number)[]): void {
  if (filter.since !== undefined) {
    where.push('day >= ?');
    params.push(assertUtcDay('since', filter.since));
  }
  if (filter.until !== undefined) {
    where.push('day <= ?');
    params.push(assertUtcDay('until', filter.until));
  }
}

/**
 * Delete at most `limit` rows of a billing rollup's `rows` table older than a retention of
 * `months`, oldest first, then the `records` of the days that are gone. `months` null deletes
 * nothing. A record goes only once its day holds no row, so a day still being pruned stays marked
 * done and is not rolled up again in between. Returns how many rows went.
 */
export function pruneBillingDays(
  sql: RedactionSql,
  tables: { rows: string; records: string },
  nowMs: number,
  limit: number,
  months: number | null,
): number {
  const capped = assertRowLimit('limit', limit);
  const horizon = billingRollupHorizon(nowMs, months);
  if (horizon === null) return 0;
  const pruned = sql(boundedRetentionDelete(tables.rows, 'day'), [horizon, capped]).length;
  sql(
    `DELETE FROM ${tables.records}
      WHERE day < ? AND NOT EXISTS (SELECT 1 FROM ${tables.rows} d WHERE d.day = ${tables.records}.day)`,
    [horizon],
  );
  return pruned;
}
