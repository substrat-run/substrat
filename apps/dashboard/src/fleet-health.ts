import type { OpsFailureEntry, SweepRunEntry } from '@substrat-run/contracts';
import type { ListRead, TenantNarrowedControlPlane } from './authority.js';

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
  /**
   * Whether the running version declares anything the sweeper writes a per-scope
   * row for — a schedule or a freshness expectation (connector sweeps carry no
   * scope, by contract). `false` is an answer in itself: nothing will ever sweep
   * this app, so its silence is by design and not a finding. `null` (or absent)
   * means the declaration could not be resolved, and the verdict falls back to
   * reading the sweep record alone.
   */
  sweepable?: boolean | null;
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
 *
 * `sweepsConfirmed` is the repair for a truncated sweep read: the scopes a narrowed
 * follow-up read (`followUpUnsweptApps`) reached the end of the window for. An app
 * in it is answered as if the broad read had been complete.
 */
export interface FleetCoverage {
  failures: boolean;
  sweeps: boolean;
  sweepsConfirmed?: ReadonlySet<string>;
}

/**
 * Roll per-scope signals into one verdict per app.
 *
 * `silent` and `ok` are deliberately different answers. A scope that declares
 * something to sweep and has no sweep rows at all is not healthy — nothing has
 * checked it — and calling that `ok` is the precise failure this whole initiative
 * exists to prevent: silence rendered as success. An app that declares NOTHING to
 * sweep is the other case: the sweeper is right to never write a row for it, so
 * its silence is by design and reads `ok` — a "needs attention" row nobody can act
 * on teaches the reader to skip the panel. `unknown` is for an app the reads could
 * not cover; the web side renders it as a footnote about the read, not as a row
 * about the app.
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
      if (app.sweepable === false) {
        // Nothing declared, so nothing sweeps it — by design, not by omission. The
        // sweep window's completeness is irrelevant: there is no row to have missed.
        return { ...id, state: 'ok', reason: 'Declares nothing to sweep — no schedules or freshness expectations, so there is nothing to check.', ...blank };
      }
      if (!coverage.sweeps && !coverage.sweepsConfirmed?.has(app.scopeId)) {
        // Absent from a truncated sweep read, which cannot tell "never swept" from
        // "swept, older than the rows fetched" — and `silent` is too loud a claim.
        return { ...id, state: 'unknown', reason: 'More sweeps are recorded than this read covers — whether anything is checking this app could not be confirmed.', ...blank };
      }
      // Not healthy — unchecked. The distinction the whole design turns on. When
      // the declaration is known, say so: the reader's next move is to find out why
      // the sweep is not reaching a scope that has work for it.
      const reason = app.sweepable
        ? 'Declares schedules or freshness expectations, and no sweep has reached this app in the window — nothing is checking it.'
        : 'No sweep has reached this app in the window — nothing is checking it.';
      return { ...id, state: 'silent', reason, ...blank };
    }
    return { ...id, state: 'ok', reason: 'Swept, with nothing failing or overdue.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt };
  });

  return rows.sort(
    (a, b) => RANK[a.state] - RANK[b.state] || b.failures - a.failures || a.scopeId.localeCompare(b.scopeId),
  );
}

/**
 * Narrowed follow-ups a truncated sweep read may spend before the rest stay
 * `unknown`. Bounded by the number of apps the broad read missed, never by the
 * size of the record — and only on the truncated path, so the rollup's "N apps
 * must not mean 2N reads" rule holds on every fleet whose record fits the cap.
 */
export const FLEET_SWEEP_FOLLOWUP_MAX = 25;

/**
 * Repair a truncated sweep read one app at a time.
 *
 * The broad read is the one that truncates first on a busy fleet — every pass of
 * every unit lands in it, and one app's 5-minute schedule alone fills a 24-hour
 * window past a page cap — which is exactly when an app absent from it has no
 * verdict. A read narrowed to that ONE scope reaches the end of its window with
 * a single row, and turns `unknown` into the `silent`/`ok` the reader came for.
 *
 * Apps the broad read reached, and apps that declare nothing to sweep, need no
 * follow-up: the first already have their newest row, the second are answered by
 * the declaration. A follow-up that fails leaves its app unconfirmed, so the
 * verdict stays `unknown` rather than becoming a guess.
 */
export async function followUpUnsweptApps(input: {
  apps: FleetApp[];
  /** Scopes the broad read (plus the failed-sweep read) already has rows for. */
  seen: ReadonlySet<string>;
  read: (scopeId: string) => Promise<Pick<ListRead<SweepRunEntry>, 'entries' | 'failed'>>;
  max?: number;
}): Promise<{ sweeps: SweepRunEntry[]; confirmed: Set<string> }> {
  const max = input.max ?? FLEET_SWEEP_FOLLOWUP_MAX;
  const missing = input.apps
    .filter((a) => !input.seen.has(a.scopeId) && a.sweepable !== false)
    .slice(0, max);
  const reads = await Promise.all(
    missing.map(async (a) => ({ scopeId: a.scopeId, read: await input.read(a.scopeId) })),
  );
  const sweeps: SweepRunEntry[] = [];
  const confirmed = new Set<string>();
  for (const { scopeId, read } of reads) {
    if (read.failed) continue;
    confirmed.add(scopeId);
    sweeps.push(...read.entries);
  }
  return { sweeps, confirmed };
}

/**
 * Whether each app's RUNNING version declares anything the sweeper writes a
 * per-scope row for — the `FleetApp.sweepable` fact.
 *
 * Resolved the way the per-app schedules view resolves the running version (an
 * unpinned scope runs the prod head), but in reads that scale with the number of
 * DISTINCT verticals and versions rather than apps: one scope list and one channel
 * list per vertical, one declaration read per version. The operator this rollup is
 * for runs one vertical for thirty clients, so that is three or four reads, not
 * ninety.
 *
 * `null` for an app whose running version could not be named. A declaration read
 * that comes back empty is taken as "declares neither", exactly as the schedules
 * view takes it — the read cannot tell a pre-field push from a vertical with no
 * schedules, and both write no per-scope rows.
 */
export async function resolveSweepable(
  cp: Pick<TenantNarrowedControlPlane, 'listScopes' | 'listChannels' | 'versionSchedules'>,
  apps: FleetApp[],
): Promise<Map<string, boolean | null>> {
  const slugs = [...new Set(apps.map((a) => a.vertical))];
  const perSlug = new Map(
    await Promise.all(
      slugs.map(async (slug) => {
        const [scopes, channels] = await Promise.all([
          cp.listScopes(slug).catch(() => null),
          cp.listChannels(slug).catch(() => null),
        ]);
        const bound = new Map((scopes ?? []).map((s) => [s.id as string, s.verticalVersionId]));
        const prod = channels?.find((ch) => ch.channel === 'prod')?.versionId ?? null;
        return [slug, { bound, prod, resolved: scopes !== null && channels !== null }] as const;
      }),
    ),
  );

  // The running version per app: its own binding, else the vertical's prod head.
  const running = new Map<string, string | null>();
  for (const app of apps) {
    const v = perSlug.get(app.vertical);
    running.set(app.scopeId, v && v.resolved ? (v.bound.get(app.scopeId) ?? v.prod) : null);
  }

  const versions = [...new Set([...running.values()].filter((v): v is string => v !== null))];
  const declares = new Map(
    await Promise.all(
      versions.map(async (versionId) => {
        const slug = apps.find((a) => running.get(a.scopeId) === versionId)!.vertical;
        const d = await cp.versionSchedules(slug, versionId);
        return [versionId, (d.schedules?.length ?? 0) > 0 || (d.freshness?.length ?? 0) > 0] as const;
      }),
    ),
  );

  return new Map(
    apps.map((a) => {
      const versionId = running.get(a.scopeId) ?? null;
      return [a.scopeId, versionId === null ? null : (declares.get(versionId) ?? null)];
    }),
  );
}
