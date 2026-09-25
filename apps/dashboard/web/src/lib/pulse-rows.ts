import type { AppHealthRow, AppMetricsView, AppRow, ReleaseMarker, TeamTrafficSeries, TrafficBucket } from './api';
import { fleetRows, type FleetRow } from './fleet-rows';

/**
 * Pulse's one-clock card (#1767), as pure derivations: the Apps rows, the sparkline paths
 * every row draws in the same 480×32 box, and where the deploy strip puts its pills.
 *
 * The card's grid is the prototype's, and every section of it (Apps, Schedules and
 * freshness) shares it, so the sparkline column is the same stretch of time on every row.
 */
export const PULSE_GRID = '200px 96px 96px 96px minmax(0,1fr) 140px';
/** Where the sparkline column starts and ends inside the card: 16px padding + 200 + 3×96, and 140 + 16px padding. */
export const AXIS_LEFT = 16 + 200 + 96 * 3;
export const AXIS_RIGHT = 140 + 16;

const W = 480;
const H = 32;

/**
 * Where each bucket sits on the column, as a fraction of the window: its start and its
 * end. Placed by TIME rather than spread evenly by index, so a sparkline point, a run
 * tick and a deploy line at the same instant land on the same pixel — the whole claim of
 * one clock. A bucket the window cuts into is clipped to it.
 */
export function bucketSpans(buckets: TrafficBucket[], bucketMinutes: number, window: { from: string; to: string }): Array<[number, number]> {
  const a = Date.parse(window.from);
  const span = Date.parse(window.to) - a;
  const clip = (x: number) => Math.max(0, Math.min(1, x));
  return buckets.map((b) => {
    const s = Date.parse(b.start);
    return [clip((s - a) / span), clip((s + bucketMinutes * 60_000 - a) / span)];
  });
}

/** One sparkline, as the design draws it: a line through each bucket's middle and the area under it. */
export function sparkPaths(values: number[], spans: Array<[number, number]>, max: number): { line: string; area: string } | null {
  if (values.length === 0) return null;
  const top = max > 0 ? max : 1;
  const y = (v: number) => (H - 2 - (v / top) * (H - 5)).toFixed(1);
  // One bucket is still a level, not a point: it is drawn across its own span.
  const pts =
    values.length === 1
      ? [`${(spans[0]![0] * W).toFixed(1)},${y(values[0]!)}`, `${(spans[0]![1] * W).toFixed(1)},${y(values[0]!)}`]
      : values.map((v, i) => `${(((spans[i]![0] + spans[i]![1]) / 2) * W).toFixed(1)},${y(v)}`);
  const line = `M${pts.join(' L')}`;
  const x0 = pts[0]!.split(',')[0];
  const x1 = pts[pts.length - 1]!.split(',')[0];
  return { line, area: `${line} L${x1},${H} L${x0},${H} Z` };
}

/** Error bars stacked at the bottom of the row — only where a bucket had errors. */
export function errorBarsPath(errors: number[], spans: Array<[number, number]>, max: number): string {
  const top = max > 0 ? max : 1;
  return errors
    .map((v, i) => {
      if (v <= 0) return '';
      const [a, b] = spans[i]!;
      const w = Math.max(1, (b - a) * W - 1.5);
      const bh = Math.max(2, (v / top) * (H - 4));
      return `M${(a * W).toFixed(1)},${H} h${w.toFixed(1)} v-${bh.toFixed(1)} h-${w.toFixed(1)} Z`;
    })
    .join(' ');
}

export interface PulseAppRow extends FleetRow {
  /** This app's buckets on the card's clock, or null when the series has no line for it. */
  buckets: TrafficBucket[] | null;
  /** Why p95 reads "—" on this row when it would otherwise be measured; else null. */
  p95Why: string | null;
}

/**
 * The Apps section: the fleet table's rows (verdict, traffic, p95 — one derivation, so the
 * two pages cannot disagree) with each app's own buckets beside them.
 *
 * Under a custom window the numbers come from the SAME series the sparkline draws, because
 * the per-app read only answers a range preset: a row captioned "10:05–10:15" beside a
 * day's requests would be two windows on one line. p95 has no per-bucket form to sum, so
 * it reads "—" there and says why.
 */
export function pulseAppRows(input: {
  apps: AppRow[];
  health: AppHealthRow[] | null;
  metrics: AppMetricsView | null;
  series: TeamTrafficSeries | null;
  custom: boolean;
}): PulseAppRow[] {
  const lines = new Map((input.series?.available ? input.series.series : []).map((s) => [s.scopeId, s.buckets]));
  return fleetRows(input).map((r) => {
    const buckets = lines.get(r.scopeId) ?? null;
    if (!input.custom) return { ...r, buckets, p95Why: null };
    const sum = (k: 'requests' | 'errors') => (buckets ? buckets.reduce((n, b) => n + b[k], 0) : null);
    return {
      ...r,
      buckets,
      requests: sum('requests'),
      errors: sum('errors'),
      p95: null,
      unread: buckets ? null : 'Traffic over this window could not be read for this app.',
      p95Why: 'p95 is read over the 1h, 24h or 3d range, not a custom window.',
    };
  });
}

/** A deploy pill on the strip: where it sits, which of the two rows, and which way it hangs. */
export interface DeployPill {
  marker: ReleaseMarker;
  x: number;
  row: 0 | 1;
  /** Past 85% the pill hangs left of its line, so the newest release stays inside the card. */
  anchorLeft: boolean;
}

/**
 * The release markers inside the window, placed on the strip. Consecutive pills alternate
 * rows — the design's answer to two releases an hour apart, whose labels would otherwise
 * sit on top of each other.
 */
export function deployPills(markers: ReleaseMarker[], window: { from: string; to: string }): DeployPill[] {
  const a = Date.parse(window.from);
  const span = Date.parse(window.to) - a;
  if (!(span > 0)) return [];
  return markers
    .map((m) => ({ marker: m, x: (Date.parse(m.at) - a) / span }))
    .filter((p) => p.x >= 0 && p.x <= 1)
    .sort((p, q) => p.x - q.x)
    .map((p, i) => ({ ...p, row: (i % 2) as 0 | 1, anchorLeft: p.x > 0.85 }));
}

/** An instant's place on the window, or null outside it. */
export function xOf(at: string, window: { from: string; to: string }): number | null {
  const a = Date.parse(window.from);
  const span = Date.parse(window.to) - a;
  const x = (Date.parse(at) - a) / span;
  return span > 0 && x >= 0 && x <= 1 ? x : null;
}

/** The subline under the heading: "Thu 25 Sep · 16:00 UTC", the instant the window ends. */
export function pulseStamp(until: string): { day: string; time: string } {
  const d = new Date(until);
  const iso = d.toISOString();
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { day: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, time: iso.slice(11, 16) };
}
