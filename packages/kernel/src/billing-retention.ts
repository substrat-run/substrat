/**
 * How long the platform keeps its billing rollups (#2501): the compact per-(tenant, vertical)
 * daily counts a later invoice, or a dispute about one, is answered from. Today that is the daily
 * request rollup (`request-rollup.ts`). The raw captures behind a rollup keep their own, shorter
 * windows, and no existing retention follows this constant: the storage gauge's day rows stay
 * `STORAGE_GAUGE_RETENTION_MONTHS` and model usage stays `MODEL_USAGE_RETENTION_DAYS`.
 *
 * `null` means the rollups are never pruned. That is a placeholder, not a decision: the horizon
 * waits on the maintainer's bookkeeping, and no legal period is written here. Keeping
 * everything is the reversible default, since a pruned row cannot be brought back while a
 * horizon can be set later. The rollups hold counts and bytes only, never personal content.
 */
export const BILLING_ROLLUP_RETENTION_MONTHS: number | null = null;

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
