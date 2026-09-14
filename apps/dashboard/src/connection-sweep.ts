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
 */
export const SWEEP_WINDOW_DAYS = SWEEP_RUN_RETENTION_DAYS;

export interface ConnectionSweepRow {
  connectionId: string;
  provider: string;
  /** `active` and the rest — a lapsed connection is a different story from an idle one. */
  status: string;
  /** The most recent run naming this connection, or null if none is retained. */
  lastSweptAt: string | null;
  /** Whether that most recent run failed. Null when there is no run to judge. */
  lastOutcomeFailed: boolean | null;
  /**
   * True only when the connection is USABLE and has no retained run. A lapsed
   * connection with no runs is explained by the lapse, and reporting it as idle as well
   * would be two findings for one fact — and would point at the wrong fix.
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
  /** The run's outcome; anything other than `ok` reads as a failure here. */
  outcome: string;
}

export function deriveConnectionSweep(input: {
  connections: readonly { connectionId: string; provider: string; status: string }[];
  /** Retained sweep runs naming a connection, any order. */
  sightings: readonly SweepSighting[];
}): ConnectionSweepView {
  const { connections, sightings } = input;

  // Newest per connection. Sorting once beats scanning per row, and the comparison is
  // lexical on ISO instants, which is why they are stored as text.
  const newest = new Map<string, SweepSighting>();
  for (const s of sightings) {
    const held = newest.get(s.connectionId);
    if (held === undefined || s.at > held.at) newest.set(s.connectionId, s);
  }

  const rows = connections.map<ConnectionSweepRow>((c) => {
    const hit = newest.get(c.connectionId);
    const usable = c.status === 'active';
    return {
      connectionId: c.connectionId,
      provider: c.provider,
      status: c.status,
      lastSweptAt: hit?.at ?? null,
      lastOutcomeFailed: hit === undefined ? null : hit.outcome !== 'ok',
      // A lapsed connection with no runs is explained by the lapse.
      idle: usable && hit === undefined,
    };
  });

  rows.sort(
    (a, b) =>
      Number(b.idle) - Number(a.idle) ||
      Number(b.lastOutcomeFailed ?? false) - Number(a.lastOutcomeFailed ?? false) ||
      a.provider.localeCompare(b.provider),
  );

  return { rows, windowDays: SWEEP_WINDOW_DAYS, idleCount: rows.filter((r) => r.idle).length };
}
