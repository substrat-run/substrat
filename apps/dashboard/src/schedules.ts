import type { DeployManifest, SweepRunEntry } from '@substrat-run/contracts';

/**
 * The schedule-health derivation (#1232) — the pure join between what a version
 * DECLARES (the manifest's schedules, with `everyMinutes`) and what the sweep
 * RECORDED (`_substrat_sweep_runs` rows keyed `<scopeId>:<operation>`). Kept out
 * of the worker route and out of React for the same reason the drain handlers
 * are pure over their inputs: the verdicts below are the whole feature, and a
 * verdict you cannot table-test is a verdict nobody trusts.
 */

/**
 * One sweep window: the platform cron fires every 15 minutes (apps/control-plane
 * wrangler.jsonc), and the CP-less scope sweeper's alarm gap is tighter (2 min) —
 * the dashboard cannot tell which path a scope is on, so it grants the looser
 * bound everywhere.
 */
export const SWEEP_WINDOW_MINUTES = 15;

/**
 * How long the scope may go without ANY sweep row — skips included — before the
 * verdicts stop blaming schedules and start naming the sweeper. Two windows: one
 * window is an ordinary cron gap, two is a stopped loop.
 */
const SWEEPER_SILENT_AFTER_MS = 2 * SWEEP_WINDOW_MINUTES * 60_000;

export interface ScheduleRunView {
  id: string;
  outcome: 'ok' | 'failed' | 'skipped';
  at: string;
  error: string | null;
  elapsedMs: number | null;
}

export interface AppScheduleRow {
  operation: string;
  moduleId: string;
  everyMinutes: number;
  permissions: string[];
  /** The newest FIRING (ok or failed) — a skip is not a run. Null = never fired. */
  lastRun: ScheduleRunView | null;
  /** `lastRun.at + everyMinutes` — the same arithmetic the scheduler itself uses. Null = never fired. */
  nextDueAt: string | null;
  /**
   * The verdict, in the order a reader needs it:
   * - `sweeper-silent` — no sweep row of ANY outcome recently; nothing below is
   *   the schedule's fault, and saying "overdue" would blame the wrong thing.
   * - `never-run` — the sweep reaches the scope, this schedule has never fired
   *   (the scheduler treats no-last-run as immediately due, so this resolves on
   *   the next pass or becomes `overdue` honestly).
   * - `overdue` — past next-due by more than one sweep window. ADDITIVE grace,
   *   deliberately: cadence + one window is derived from the same numbers the
   *   scheduler uses, where a 2× multiplier would tell a daily schedule's owner
   *   a full day late and false-alarm a five-minute one.
   * - `healthy` — inside the bound.
   */
  health: 'healthy' | 'overdue' | 'never-run' | 'sweeper-silent';
  /** Recent firings (ok+failed, never skips), newest first — the strip. */
  runs: ScheduleRunView[];
}

const viewOf = (r: SweepRunEntry): ScheduleRunView => ({
  id: r.id,
  outcome: r.outcome,
  at: r.at,
  error: r.error,
  elapsedMs: r.elapsedMs,
});

/**
 * Derive every declared schedule's verdict. `runsByOperation` carries the ok+failed
 * rows per operation (newest first, as `/sweep-runs` answers); `lastSweepAt` is the
 * newest row of ANY outcome for the scope — the liveness read, and the only place
 * the flood of `skipped` rows earns its storage.
 */
export function deriveScheduleHealth(
  declared: NonNullable<DeployManifest['schedules']>,
  runsByOperation: Map<string, SweepRunEntry[]>,
  lastSweepAt: string | null,
  now: number,
): AppScheduleRow[] {
  const silent = lastSweepAt === null || now - Date.parse(lastSweepAt) > SWEEPER_SILENT_AFTER_MS;
  return declared.map((spec) => {
    const runs = (runsByOperation.get(spec.operation) ?? []).map(viewOf);
    const lastRun = runs[0] ?? null;
    const nextDueMs =
      lastRun === null ? null : Date.parse(lastRun.at) + spec.cadence.everyMinutes * 60_000;
    const health: AppScheduleRow['health'] = silent
      ? 'sweeper-silent'
      : lastRun === null
        ? 'never-run'
        : now > nextDueMs! + SWEEP_WINDOW_MINUTES * 60_000
          ? 'overdue'
          : 'healthy';
    return {
      operation: spec.operation,
      moduleId: spec.moduleId,
      everyMinutes: spec.cadence.everyMinutes,
      permissions: [...spec.permissions],
      lastRun,
      nextDueAt: nextDueMs === null ? null : new Date(nextDueMs).toISOString(),
      health,
      runs,
    };
  });
}
