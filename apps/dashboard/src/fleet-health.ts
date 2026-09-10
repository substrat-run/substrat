import type { OpsFailureEntry, SweepRunEntry } from '@substrat-run/contracts';

/**
 * One app's health, as a rollup of the signals tiers 1–2 already record (#1238).
 *
 * Nothing here is newly observed: failures come from the ops-failure record
 * (#559/#1233), sweep and freshness verdicts from the sweep record (#1232). The
 * value is the ranking — "is this group healthy" answered before any drill-down,
 * worst first, which is the one question a multi-client operator opens the page
 * to ask and today has no page for.
 */
export type AppHealthState = 'failing' | 'stale' | 'silent' | 'ok' | 'unknown';

export interface AppHealthRow {
  scopeId: string;
  state: AppHealthState;
  /** One sentence a reader can act on, or the honest absence of one. */
  reason: string;
  /** Failures recorded against this scope inside the window. */
  failures: number;
  /** Sweep units that reported `failed` inside the window. */
  sweepFailures: number;
  /** Freshness expectations currently reading stale. */
  stale: number;
  /** The newest sweep of any kind — null when the sweeper has not reached this scope. */
  lastSweepAt: string | null;
}

/** Worst first: the ordering IS the feature. */
const RANK: Record<AppHealthState, number> = { failing: 0, stale: 1, silent: 2, unknown: 3, ok: 4 };

/**
 * Roll per-scope signals into one verdict per app.
 *
 * `silent` and `ok` are deliberately different answers. A scope with no sweep rows
 * at all is not healthy — nothing has checked it — and calling that `ok` is the
 * precise failure this whole initiative exists to prevent: silence rendered as
 * success. `unknown` is for an app the reads could not cover at all.
 */
export function deriveFleetHealth(input: {
  scopeIds: string[];
  failures: OpsFailureEntry[];
  sweeps: SweepRunEntry[];
  /** False when a read failed — every app reads `unknown` rather than a cheerful `ok`. */
  available?: boolean;
}): AppHealthRow[] {
  const { scopeIds, failures, sweeps } = input;
  const available = input.available ?? true;

  const rows = scopeIds.map((scopeId): AppHealthRow => {
    if (!available) {
      return { scopeId, state: 'unknown', reason: 'Health signals are unavailable.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null };
    }
    const mine = sweeps.filter((s) => s.scopeId === scopeId);
    const failed = failures.filter((f) => f.scopeId === scopeId).length;
    // A FRESHNESS row with outcome 'failed' is not a broken sweep — it is a working
    // sweep reporting an absence, which is the `stale` verdict below. Counting it
    // here too would let "an event is overdue" masquerade as "the machinery broke",
    // and since `failing` outranks `stale` the more specific answer would be lost.
    const sweepFailures = mine.filter((s) => s.outcome === 'failed' && s.kind !== 'freshness').length;
    // A freshness row that failed IS the staleness verdict — the evaluator already
    // judged it (#1232), so this counts verdicts rather than re-deriving them.
    const stale = mine.filter((s) => s.kind === 'freshness' && s.outcome === 'failed').length;
    // Rows arrive newest-first; `at` is the pass time.
    const lastSweepAt = mine.length > 0 ? mine.reduce((a, b) => (a.at >= b.at ? a : b)).at : null;

    if (failed > 0 || sweepFailures > 0) {
      const parts = [
        failed > 0 ? `${failed} failure${failed === 1 ? '' : 's'}` : '',
        sweepFailures > 0 ? `${sweepFailures} failed sweep${sweepFailures === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      return { scopeId, state: 'failing', reason: `${parts.join(' and ')} recorded.`, failures: failed, sweepFailures, stale, lastSweepAt };
    }
    if (stale > 0) {
      return { scopeId, state: 'stale', reason: `${stale} freshness expectation${stale === 1 ? '' : 's'} overdue — an event that should have arrived has not.`, failures: 0, sweepFailures: 0, stale, lastSweepAt };
    }
    if (lastSweepAt === null) {
      // Not healthy — unchecked. The distinction the whole design turns on.
      return { scopeId, state: 'silent', reason: 'No sweep has reached this app in the window — nothing is checking it.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null };
    }
    return { scopeId, state: 'ok', reason: 'Swept, with nothing failing or overdue.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt };
  });

  return rows.sort(
    (a, b) => RANK[a.state] - RANK[b.state] || b.failures - a.failures || a.scopeId.localeCompare(b.scopeId),
  );
}
