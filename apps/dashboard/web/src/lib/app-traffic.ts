import type { TenantMetricsRow, TrafficBucket, TrafficSeries } from './api';

/**
 * The pure half of the app page's "Traffic by status" card (#1767): the window a series
 * covers, its status-class totals, the labels, the custom range the two clock inputs
 * describe, and the per-surface rows. Kept out of the component so each rule is testable
 * without a DOM.
 */

export interface TimeWindow {
  since: string;
  until: string;
}

const MINUTE = 60_000;

/** Seconds are the telemetry store's precision, and `queryWindow` refuses an end in the future. */
const floorSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/**
 * The window a series was drawn over: the one it echoes when it was asked for exact
 * bounds, else its first bucket's start to the end of its last — clipped to `now`,
 * because the newest bucket is still filling, and a link carrying an end in the future
 * is one the Logs view refuses.
 */
export function seriesWindow(series: Pick<TrafficSeries, 'window' | 'buckets' | 'bucketMinutes'>, now = Date.now()): TimeWindow | null {
  if (series.window) return series.window;
  const first = series.buckets[0];
  const last = series.buckets[series.buckets.length - 1];
  if (!first || !last) return null;
  const until = Math.min(Date.parse(last.start) + series.bucketMinutes * MINUTE, floorSecond(now));
  return { since: first.start, until: new Date(until).toISOString() };
}

/**
 * The three legend totals. `ok` and `refused` are null — "not measured", drawn as "—" —
 * when the source carried no status-class split: `requests - errors` would count every 4xx
 * as ok, which is exactly the number the split exists to separate.
 */
export function classTotals(buckets: TrafficBucket[]): { ok: number | null; refused: number | null; failed: number } {
  const split = buckets.length > 0 && buckets.every((b) => b.green !== undefined && b.yellow !== undefined);
  return {
    ok: split ? buckets.reduce((n, b) => n + (b.green ?? 0), 0) : null,
    refused: split ? buckets.reduce((n, b) => n + (b.yellow ?? 0), 0) : null,
    failed: buckets.reduce((n, b) => n + b.errors, 0),
  };
}

export const fmtCount = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-US'));

/** `14:05`, UTC — the clock every other time on the Observability pages is written in. */
export const clockOf = (iso: string): string => new Date(iso).toISOString().slice(11, 16);

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayClock = (iso: string) => `${DAY[new Date(iso).getUTCDay()]} ${clockOf(iso)}`;

export const bucketLabel = (minutes: number): string => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h bars` : `${minutes} min bars`);

/** "Mon 16:00 → Tue 16:00 UTC · 1 h bars". The day is named only when the window crosses midnight. */
export function rangeLabel(window: TimeWindow, bucketMinutes: number): string {
  const crosses = window.since.slice(0, 10) !== new Date(Date.parse(window.until) - 1).toISOString().slice(0, 10);
  const ends = crosses ? `${dayClock(window.since)} → ${dayClock(window.until)}` : `${clockOf(window.since)} → ${clockOf(window.until)}`;
  return `${ends} UTC · ${bucketLabel(bucketMinutes)}`;
}

/** Bucket `i` as the window it covers, clipped to the plotted window — the edge buckets
 *  hold only the traffic inside it, so a link wider than that would promise more. */
export function bucketWindow(bucket: TrafficBucket, bucketMinutes: number, window: TimeWindow): { from: string; to: string } {
  const start = Math.max(Date.parse(bucket.start), Date.parse(window.since));
  const end = Math.min(Date.parse(bucket.start) + bucketMinutes * MINUTE, Date.parse(window.until));
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** The bucket under a horizontal fraction of the plot, or -1 when none is. */
export function bucketAt(buckets: TrafficBucket[], bucketMinutes: number, window: TimeWindow, fraction: number): number {
  const since = Date.parse(window.since);
  const at = since + Math.max(0, Math.min(0.999999, fraction)) * (Date.parse(window.until) - since);
  return buckets.findIndex((b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + bucketMinutes * MINUTE);
}

/** Where a bucket sits on the plot, as CSS percentages of its width. */
export function bucketBox(bucket: TrafficBucket, bucketMinutes: number, window: TimeWindow): { left: string; width: string } {
  const since = Date.parse(window.since);
  const span = Date.parse(window.until) - since;
  const w = bucketWindow(bucket, bucketMinutes, window);
  const l = (Date.parse(w.from) - since) / span;
  const r = (Date.parse(w.to) - since) / span;
  return { left: `${l * 100}%`, width: `${Math.max(0, r - l) * 100}%` };
}

const CLOCK = /^(\d{1,2}):(\d{2})$/;

/**
 * The window two clock inputs describe. Each side is a UTC `HH:MM` or a full ISO instant.
 * A clock resolves to its most recent occurrence: the end to the latest one no later than
 * now, the start to the latest one before the end — so `22:00 → 02:00` is last night, not
 * a backwards range. Returns the reason in words when it cannot be read.
 */
export function resolveClockRange(fromText: string, toText: string, now = Date.now()): { from: string; to: string } | { error: string } {
  const nowMs = floorSecond(now);
  const clockMs = (text: string): number | null => {
    const m = CLOCK.exec(text.trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
    return (h * 60 + min) * MINUTE;
  };
  const DAY_MS = 24 * 60 * MINUTE;
  const iso = (text: string): number | null => {
    const t = Date.parse(text.trim());
    return /^\d{4}-\d\d-\d\dT/.test(text.trim()) && Number.isFinite(t) ? t : null;
  };
  let to = iso(toText);
  if (to === null) {
    const c = clockMs(toText);
    if (c === null) return { error: 'Write the end as HH:MM (UTC) or a full timestamp.' };
    const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
    to = midnight + c <= nowMs ? midnight + c : midnight + c - DAY_MS;
  }
  let from = iso(fromText);
  if (from === null) {
    const c = clockMs(fromText);
    if (c === null) return { error: 'Write the start as HH:MM (UTC) or a full timestamp.' };
    const midnight = Math.floor(to / DAY_MS) * DAY_MS;
    from = midnight + c < to ? midnight + c : midnight + c - DAY_MS;
  }
  to = Math.min(to, nowMs);
  if (from >= to) return { error: 'The start must be before the end.' };
  if (to - from > 72 * 60 * MINUTE) return { error: 'Choose a window of at most 72 hours.' };
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export interface SurfaceRow {
  key: string;
  name: string;
  sub: string | null;
  requests: string;
  errors: string;
  rate: string;
  /** The error rate at or above 1 % — drawn red, beside its number. */
  rateHigh: boolean;
  p50: string;
  p95: string;
  /** p95 above 400 ms — drawn amber, beside its number. */
  p95Slow: boolean;
}

/**
 * One row per surface that answered, busiest first. The name is the surface's declared
 * label when it has one, and the sub-line is the hostname that surface serves — both read
 * from the app's own bindings, never invented. An app that served nothing has no error
 * RATE, so that cell is "—" rather than a confident 0.00 %.
 */
export function surfaceRows(
  rows: TenantMetricsRow[],
  surfaces: Array<{ surface: string | null; label: string | null; hostname: string }>,
): SurfaceRow[] {
  return [...rows]
    .sort((a, b) => b.requests - a.requests)
    .map((r) => {
      const bound = surfaces.find((s) => s.surface !== null && s.surface === r.surface);
      const rate = r.requests === 0 ? null : r.errors / r.requests;
      return {
        key: `${r.scopeId}:${r.surface ?? ''}`,
        name: bound?.label ?? r.surface ?? '—',
        sub: bound ? (bound.label ? `${r.surface} · ${bound.hostname}` : bound.hostname) : null,
        requests: r.requests.toLocaleString('en-US'),
        errors: r.errors.toLocaleString('en-US'),
        rate: rate === null ? '—' : `${(rate * 100).toFixed(2)}%`,
        rateHigh: rate !== null && rate >= 0.01,
        p50: r.requests === 0 ? '—' : `${Math.round(r.durationP50)} ms`,
        p95: r.requests === 0 ? '—' : `${Math.round(r.durationP95)} ms`,
        p95Slow: r.requests > 0 && r.durationP95 > 400,
      };
    });
}
