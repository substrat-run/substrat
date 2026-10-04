import type { EmittedLifecycle, OperationSeriesResult } from '@substrat-run/contracts';

/**
 * Pulse's "Business today" (#1750), as pure arithmetic: which grid one read is asked for,
 * and how its answer becomes rows — each a declared move with today's count, yesterday's,
 * and a series on the card's clock.
 *
 * "Today" is the 24 hours ending at the card's `until`, and "yesterday" the 24 before; the
 * series is the card's own window. ONE read per app covers all three, because its grid is
 * anchored on `until` and steps in the card's own bins (`observabilityBucketMinutes`, the
 * connector rows' too), whole minutes that divide a day: the two 24-hour edges
 * then fall exactly on bucket edges, and a bucket is never split between today and
 * yesterday.
 */
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * One state a lifecycle can be counted into: the entity, the state, and the operations
 * whose every call on that entity is a move into it.
 */
export interface LifecycleMove {
  entityType: string;
  state: string;
  terminal: boolean;
  /**
   * Every counted edge into this state leaves the initial state — what "opened" means. For a
   * non-terminal state this splits the rows: the operations that open (out of the initial
   * state) are one row, and the ones that come back to it from later (a reopen) another,
   * so an opened count never carries reopens. A terminal state is one row however it was
   * reached: closing is closing.
   */
  fromInitial: boolean;
  operations: string[];
}

/**
 * The moves a declared lifecycle lets a GROUP BY count exactly (see `operation-series.ts` in contracts for why).
 *
 * An operation qualifies when every appearance of it in the declaration is an `on` edge
 * into one and the same state, from a different state, and it is in no `allow` list. It
 * opens when every one of its edges leaves the initial state.
 * States no qualifying operation reaches are left out rather than listed at zero: zero
 * would claim a count this read cannot make.
 */
export function lifecycleMovesOf(lifecycles: Record<string, EmittedLifecycle> | undefined): LifecycleMove[] {
  const out: LifecycleMove[] = [];
  for (const [entityType, lc] of Object.entries(lifecycles ?? {})) {
    const target = new Map<string, string | null>();
    const sources = new Map<string, Set<string>>();
    const disqualify = (op: string) => target.set(op, null);
    for (const [from, state] of Object.entries(lc.states)) {
      for (const op of state.allow ?? []) disqualify(op);
      for (const [op, to] of Object.entries(state.on ?? {})) {
        const seen = target.get(op);
        if (seen === null) continue;
        if (to === from || (seen !== undefined && seen !== to)) {
          disqualify(op);
          continue;
        }
        target.set(op, to);
        sources.set(op, (sources.get(op) ?? new Set()).add(from));
      }
    }
    const rows = new Map<string, LifecycleMove>();
    for (const [op, to] of target) {
      if (to === null || to === undefined) continue;
      const terminal = lc.states[to]?.terminal === true;
      const opens = [...(sources.get(op) ?? [])].every((s) => s === lc.initial);
      const key = terminal ? to : `${to}\u001f${opens}`;
      const row = rows.get(key) ?? { entityType, state: to, terminal, fromInitial: true, operations: [] };
      row.fromInitial &&= opens;
      row.operations.push(op);
      rows.set(key, row);
    }
    // By state, the opening row before the one that comes back to the same state.
    const ordered = [...rows.values()].sort((a, b) => a.state.localeCompare(b.state) || Number(b.fromInitial) - Number(a.fromInitial));
    for (const row of ordered) out.push({ ...row, operations: row.operations.sort() });
  }
  return out;
}

/**
 * The read's window: ends at `until` (rounded UP to the whole second the read's anchor needs,
 * which can only add a sliver of the present), and reaches back far enough for both the
 * card's window and the two days compared.
 */
export function businessGrid(
  window: { since: string; until: string },
  bucketMinutes: number,
): { since: string; until: string; bucketMinutes: number } {
  const until = Math.ceil(Date.parse(window.until) / 1000) * 1000;
  const span = until - Date.parse(window.since);
  const step = bucketMinutes * MINUTE;
  const buckets = Math.ceil(Math.max(span, 2 * DAY) / step);
  return { since: new Date(until - buckets * step).toISOString(), until: new Date(until).toISOString(), bucketMinutes };
}

export interface BusinessVolumeRow {
  scopeId: string;
  entityType: string;
  state: string;
  terminal: boolean;
  fromInitial: boolean;
  operations: string[];
  /** Moves in the 24 hours ending at the window's end. */
  today: number;
  /** Moves in the 24 hours before those. */
  yesterday: number;
  /** The card's window, zero-filled on the read's grid. */
  buckets: Array<{ start: string; count: number }>;
}

/**
 * Why an app has no rows. Kept apart, as the process map keeps them, because each is a
 * different next step: nothing is running; the running version declares no lifecycle the
 * read can count exactly; the app's deployed code predates the read and wants a re-push.
 */
export type BusinessUnavailable = 'no-version' | 'no-moves' | 'not-yet-available';

export interface BusinessVolumesAnswer {
  window: { since: string; until: string };
  bucketMinutes: number;
  rows: BusinessVolumeRow[];
  apps: Array<{ scopeId: string; unavailable: BusinessUnavailable | null }>;
}

/** One app's rows: each declared move, with its operations' counts folded together. */
export function businessRows(
  scopeId: string,
  moves: LifecycleMove[],
  read: OperationSeriesResult,
  window: { since: string; until: string },
): BusinessVolumeRow[] {
  const step = read.bucketMinutes * MINUTE;
  const end = Date.parse(read.until);
  const from = Date.parse(window.since);
  return moves.map((m) => {
    const bins = new Map<number, number>();
    for (const sr of read.series) {
      if (sr.entityType !== m.entityType || !m.operations.includes(sr.operation)) continue;
      for (const b of sr.buckets) {
        const at = Date.parse(b.start);
        bins.set(at, (bins.get(at) ?? 0) + b.count);
      }
    }
    let today = 0;
    let yesterday = 0;
    for (const [at, n] of bins) {
      if (at >= end - DAY) today += n;
      else if (at >= end - 2 * DAY) yesterday += n;
    }
    const buckets: Array<{ start: string; count: number }> = [];
    // Every grid bucket that overlaps the card's window, oldest first.
    for (let at = Date.parse(read.since); at < end; at += step) {
      if (at + step > from) buckets.push({ start: new Date(at).toISOString(), count: bins.get(at) ?? 0 });
    }
    return { scopeId, entityType: m.entityType, state: m.state, terminal: m.terminal, fromInitial: m.fromInitial, operations: m.operations, today, yesterday, buckets };
  });
}
