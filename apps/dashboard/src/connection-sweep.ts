import { SWEEP_RUN_RETENTION_DAYS } from '@substrat-run/kernel';

/**
 * Whether a bound connection has actually been used (#1234).
 *
 * The last of the three findings #1234 names. The other two are settled: a declared
 * event type never recorded ships in the findings list, and an unused egress entry is
 * already computed by `/verticals/:slug/egress` and rendered in the console — at script
 * grain, which is the grain the span data has.
 *
 * ## What "never swept" can and cannot mean
 *
 * `_substrat_sweep_runs` is pruned at `SWEEP_RUN_RETENTION_DAYS` — high-frequency
 * telemetry with a storage bound, not a retention promise. So the absence of a run is
 * "not in the last {N} days", never "never". A connection bound two years ago and swept
 * monthly has no row here either, and calling that one unused would send somebody to
 * disconnect a working integration.
 *
 * The view therefore states the window every time, exactly as the refusal counts do
 * (#1453) and as the console's egress panel does ("declared — not seen in this window").
 * The number is read from the kernel rather than written down here, so the copy cannot
 * drift from the pruner.
 *
 * ## What counts as a use, and what the absence of one can prove
 *
 * Three things would let this view call a working connection idle, and each is refused
 * here rather than in the caller:
 *
 * - A `skipped` run is the sweep saying "bound, but no sweeper registered for this
 *   provider" — nothing went through the connection. It is not a use, so it does not
 *   set `lastSweptAt`; a connection whose only rows are skips reads as idle, which is
 *   the true finding.
 * - Prune-on-write is bounded by writes: if sweeping stops, a row older than the window
 *   is still on disk. The cutoff is therefore applied HERE, against a `now` the caller
 *   supplies, rather than trusted to the pruner (and so a test can pin the clock).
 * - Absence is only evidence when the record was actually read. A connection whose
 *   read failed — a plane predating the route, a transport error — is `unknown`: not
 *   idle, no timestamp, and the copy says the record was unavailable.
 */
export const SWEEP_WINDOW_DAYS = SWEEP_RUN_RETENTION_DAYS;

export interface ConnectionSweepRow {
  connectionId: string;
  provider: string;
  /**
   * The connection's human label. A tenant can hold several connections to one provider
   * (the key includes the external account), and `provider` alone cannot tell them apart.
   */
  label: string;
  /** `active` and the rest — a lapsed connection is a different story from an idle one. */
  status: string;
  /** The newest run inside the window that went THROUGH the connection, or null. */
  lastSweptAt: string | null;
  /** Whether that run failed. Null when there is no run to judge. */
  lastOutcomeFailed: boolean | null;
  /**
   * The sweep record for this connection could not be read, so its absence of runs is
   * not a fact about the connection. Never idle, never a timestamp.
   */
  unknown: boolean;
  /**
   * True only when the connection is USABLE, its record was read, and no run inside
   * the window went through it. A lapsed connection with no runs is explained by the
   * lapse, and reporting it as idle as well would be two findings for one fact — and
   * would point at the wrong fix.
   */
  idle: boolean;
}

export interface ConnectionSweepView {
  rows: ConnectionSweepRow[];
  /** The retained window, so the copy can say what "no runs" is bounded by. */
  windowDays: number;
  /** Connections with no retained run, usable ones only — the finding's count. */
  idleCount: number;
}

export interface SweepSighting {
  connectionId: string;
  at: string;
  /** The run's outcome. `skipped` is not a use; anything else that is not `ok` is a failure. */
  outcome: string;
}

/** The instant `windowDays` before `now`, as the ISO text the rows are compared against. */
export function sweepWindowCutoff(now: string, windowDays: number = SWEEP_WINDOW_DAYS): string {
  return new Date(new Date(now).getTime() - windowDays * 86_400_000).toISOString();
}

export function deriveConnectionSweep(input: {
  connections: readonly { connectionId: string; provider: string; label: string; status: string }[];
  /** Sweep runs naming a connection, any order, any age — the window is applied here. */
  sightings: readonly SweepSighting[];
  /** The clock, supplied so the window is explicit and a test can pin it. */
  now: string;
  /** Connections whose sweep record could not be read. Absence proves nothing for these. */
  unread?: ReadonlySet<string>;
}): ConnectionSweepView {
  const { connections, sightings, now } = input;
  const unread = input.unread ?? new Set<string>();
  const cutoff = sweepWindowCutoff(now);

  // Newest USE per connection: a `skipped` run went through nothing, and a row older
  // than the window is a pruner that has not run, not a recent use. Sorting once beats
  // scanning per row, and the comparison is lexical on ISO instants, which is why they
  // are stored as text.
  const newest = new Map<string, SweepSighting>();
  for (const s of sightings) {
    if (s.outcome === 'skipped' || s.at < cutoff) continue;
    const held = newest.get(s.connectionId);
    if (held === undefined || s.at > held.at) newest.set(s.connectionId, s);
  }

  const rows = connections.map<ConnectionSweepRow>((c) => {
    const unknown = unread.has(c.connectionId);
    const hit = unknown ? undefined : newest.get(c.connectionId);
    const usable = c.status === 'active';
    return {
      connectionId: c.connectionId,
      provider: c.provider,
      label: c.label,
      status: c.status,
      lastSweptAt: hit?.at ?? null,
      lastOutcomeFailed: hit === undefined ? null : hit.outcome !== 'ok',
      unknown,
      // A lapsed connection with no runs is explained by the lapse; an unread one by
      // the read.
      idle: usable && !unknown && hit === undefined,
    };
  });

  rows.sort(
    (a, b) =>
      Number(b.idle) - Number(a.idle) ||
      Number(b.lastOutcomeFailed ?? false) - Number(a.lastOutcomeFailed ?? false) ||
      a.provider.localeCompare(b.provider) ||
      a.label.localeCompare(b.label),
  );

  return { rows, windowDays: SWEEP_WINDOW_DAYS, idleCount: rows.filter((r) => r.idle).length };
}
