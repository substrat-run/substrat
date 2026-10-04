import type { LifecycleMove, OperationSeriesResult } from '@substrat-run/contracts';

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
  const counts = new Map<string, Map<number, number>>();
  for (const s of read.series) {
    const key = `${s.entityType}\u001f${s.operation}`;
    const bins = counts.get(key) ?? new Map<number, number>();
    for (const b of s.buckets) bins.set(Date.parse(b.start), (bins.get(Date.parse(b.start)) ?? 0) + b.count);
    counts.set(key, bins);
  }
  return moves.map((m) => {
    const bins = new Map<number, number>();
    for (const op of m.operations) {
      for (const [at, n] of counts.get(`${m.entityType}\u001f${op}`) ?? []) bins.set(at, (bins.get(at) ?? 0) + n);
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
