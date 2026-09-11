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

/** The app a verdict is about, named the way its owner names it. */
export interface FleetApp {
  scopeId: string;
  name: string;
  /** The vertical's slug — the web side turns it into a label. */
  vertical: string;
}

export interface AppHealthRow {
  scopeId: string;
  /**
   * The app's own name and vertical travel WITH the verdict (#1238 review).
   * A row identified only by a scope id makes the operator this view is for —
   * one firm, thirty clients — open every row to find out whose app is broken,
   * which is the drill-down the rollup exists to make unnecessary.
   */
  name: string;
  vertical: string;
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
 * What the reads behind a rollup actually covered.
 *
 * A bounded read of a tenant-wide record is a WINDOW, and which verdicts it can
 * support depends on which window was complete — so coverage is per question
 * rather than one flag. `failures` covers "is anything broken" (the ops-failure
 * record plus the failed-sweep record); `sweeps` covers "has anything checked this
 * app at all". A truncated read of one must not cost the answer the other carries.
 */
export interface FleetCoverage {
  failures: boolean;
  sweeps: boolean;
}

/**
 * Roll per-scope signals into one verdict per app.
 *
 * `silent` and `ok` are deliberately different answers. A scope with no sweep rows
 * at all is not healthy — nothing has checked it — and calling that `ok` is the
 * precise failure this whole initiative exists to prevent: silence rendered as
 * success. `unknown` is for an app the reads could not cover.
 *
 * A FOUND failure is a fact and outranks any gap in the reads: an incomplete read
 * can hide a failure, never invent one. What incompleteness costs is the right to
 * conclude from an absence — so an app with nothing against it reads `unknown`
 * rather than `ok` when the failure window was truncated, and `unknown` rather than
 * `silent` when the sweep window was.
 */
export function deriveFleetHealth(input: {
  apps: FleetApp[];
  failures: OpsFailureEntry[];
  sweeps: SweepRunEntry[];
  /** False when a read failed — every app reads `unknown` rather than a cheerful `ok`. */
  available?: boolean;
  /** Which questions the reads reached the end of. Defaults to both. */
  coverage?: FleetCoverage;
}): AppHealthRow[] {
  const { apps, failures, sweeps } = input;
  const available = input.available ?? true;
  const coverage = input.coverage ?? { failures: true, sweeps: true };

  const rows = apps.map((app): AppHealthRow => {
    const id = { scopeId: app.scopeId, name: app.name, vertical: app.vertical };
    const blank = { failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null };
    if (!available) {
      return { ...id, state: 'unknown', reason: 'Health signals are unavailable.', ...blank };
    }
    const mine = sweeps.filter((s) => s.scopeId === app.scopeId);
    const failed = failures.filter((f) => f.scopeId === app.scopeId).length;
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
      return { ...id, state: 'failing', reason: `${parts.join(' and ')} recorded.`, failures: failed, sweepFailures, stale, lastSweepAt };
    }
    if (stale > 0) {
      return { ...id, state: 'stale', reason: `${stale} freshness expectation${stale === 1 ? '' : 's'} overdue — an event that should have arrived has not.`, failures: 0, sweepFailures: 0, stale, lastSweepAt };
    }
    if (!coverage.failures) {
      // Nothing against this app INSIDE a window that did not reach the end of the
      // record. "Nothing found" is not "nothing there", and saying `ok` here is the
      // one answer that cannot be walked back.
      return { ...id, state: 'unknown', reason: 'More failures are recorded than this read covers — this app’s standing could not be confirmed.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt };
    }
    if (lastSweepAt === null) {
      if (!coverage.sweeps) {
        // Absent from a truncated sweep read, which cannot tell "never swept" from
        // "swept, older than the rows fetched" — and `silent` is too loud a claim.
        return { ...id, state: 'unknown', reason: 'More sweeps are recorded than this read covers — whether anything is checking this app could not be confirmed.', ...blank };
      }
      // Not healthy — unchecked. The distinction the whole design turns on.
      return { ...id, state: 'silent', reason: 'No sweep has reached this app in the window — nothing is checking it.', ...blank };
    }
    return { ...id, state: 'ok', reason: 'Swept, with nothing failing or overdue.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt };
  });

  return rows.sort(
    (a, b) => RANK[a.state] - RANK[b.state] || b.failures - a.failures || a.scopeId.localeCompare(b.scopeId),
  );
}
