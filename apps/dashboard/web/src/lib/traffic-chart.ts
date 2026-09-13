/**
 * The team-level traffic chart (#1447 step 3) — one time axis for the whole team, at
 * TENANT grain.
 *
 * The grain is the point. `serviceMetricsSeries` buckets per deployed script, and one
 * vertical's script serves every team that installed it — so a builder reading their
 * own app's page got fleet-wide numbers to an instance question. `tenantMetricsSeries`
 * (#1451) carries the scope dimension, and this shapes it into lines.
 *
 * ## Two absences that are not the same, and neither is an empty chart
 *
 * **No buckets for an app** means no traffic in the window. The upstream returns a
 * bucket only where something happened, so absence is a measurement, and it is drawn
 * as zero rather than as a gap — a line that jumped the gap would imply continuity
 * across time nobody measured.
 *
 * **No answer at all** is different: a control plane without a bucketed tenant-grain
 * reader answers 501, and a caller that swallowed that into `[]` would draw a
 * confident flat zero over an app that might be perfectly busy. That distinction lives
 * at the call site — this function is only ever handed buckets that were really read —
 * but it is written down here because the flat-zero-for-unreadable bug has been shipped
 * on this surface before.
 */
export interface TrafficBucketRow {
  scopeId: string;
  /** ISO instant the bucket starts at. */
  start: string;
  bucketMinutes: number;
  requests: number;
  errors: number;
  durationP50: number;
  durationP95: number;
}

export interface TrafficPoint {
  start: string;
  requests: number;
  errors: number;
  durationP50: number;
  durationP95: number;
}

export interface TrafficSeriesRow {
  scopeId: string;
  label: string;
  points: TrafficPoint[];
  requests: number;
  errors: number;
  /**
   * True when this app returned no buckets at all — no traffic in the window, which is
   * a fact worth saying rather than a flat line the reader has to interpret.
   */
  silent: boolean;
}

export interface TrafficChartView {
  /** One row per app in scope, busiest first; a single row when one app is chosen. */
  series: TrafficSeriesRow[];
  /** Every bucket start in the window, ascending — the shared x-axis, gap-free. */
  axis: string[];
  requests: number;
  errors: number;
  /** The worst P95 seen in any bucket, which is the number an operator actually asks for. */
  peakP95: number;
  bucketMinutes: number;
}

export function deriveTrafficChart(input: {
  buckets: readonly TrafficBucketRow[];
  /** The apps the chip can name — every one gets a row, traffic or not. */
  apps: readonly { scopeId: string; label: string }[];
  /** Null = all apps. */
  focus: string | null;
  /** The window asked for — the axis is drawn from it, not from whichever buckets came back. */
  hours: number;
  /** The window's end — the caller's clock, so the axis ends where the read did. */
  now: Date;
}): TrafficChartView {
  const { buckets, apps, focus, hours, now } = input;
  const inScope = focus === null ? apps : apps.filter((a) => a.scopeId === focus);
  const wanted = new Set(inScope.map((a) => a.scopeId));
  const rows = buckets.filter((b) => wanted.has(b.scopeId));

  // The axis is the WINDOW, not the buckets that happened to come back. The upstream
  // emits a bucket only where something ran, and an interval every app was quiet in
  // has no row for any of them — built from rows, the axis would drop it, and the bars
  // either side would sit adjacent by index with the outage between them compressed to
  // nothing. So the grid is laid out from the requested hours and the bucket width,
  // and every slot in it is a point. The width comes from the rows when there are any
  // and from the plane's own rule (15-minute buckets up to six hours, hourly beyond)
  // when there are none, so an all-quiet window still has its full run of zeros.
  const bucketMinutes = rows[0]?.bucketMinutes ?? (hours <= 6 ? 15 : 60);
  const widthMs = bucketMinutes * 60_000;
  const end = Math.floor(now.getTime() / widthMs) * widthMs;
  const start = end - hours * 3_600_000;
  const axis: string[] = [];
  for (let t = start; t <= end; t += widthMs) axis.push(new Date(t).toISOString());

  // Snapped to that grid on the way in: the plane's bucket boundary and ours must agree,
  // or a row lands between two columns and is lost.
  const slotOf = (iso: string): string | null => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const slot = Math.floor(t / widthMs) * widthMs;
    return slot < start || slot > end ? null : new Date(slot).toISOString();
  };

  const series = inScope.map((app) => {
    const mine = new Map<string, TrafficBucketRow>();
    for (const b of rows) {
      if (b.scopeId !== app.scopeId) continue;
      const slot = slotOf(b.start);
      if (slot !== null) mine.set(slot, b);
    }
    // Zero-filled across the shared axis: the upstream omits a bucket where nothing
    // happened, so a missing one IS zero, and leaving a hole would draw a line that
    // skips over measured quiet.
    const points = axis.map<TrafficPoint>((start) => {
      const b = mine.get(start);
      return {
        start,
        requests: b?.requests ?? 0,
        errors: b?.errors ?? 0,
        durationP50: b?.durationP50 ?? 0,
        durationP95: b?.durationP95 ?? 0,
      };
    });
    return {
      scopeId: app.scopeId,
      label: app.label,
      points,
      requests: points.reduce((n, p) => n + p.requests, 0),
      errors: points.reduce((n, p) => n + p.errors, 0),
      silent: mine.size === 0,
    };
  });

  series.sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));

  return {
    series,
    axis,
    requests: series.reduce((n, s) => n + s.requests, 0),
    errors: series.reduce((n, s) => n + s.errors, 0),
    // The PEAK, not an average of percentiles: averaging P95s across buckets and apps
    // produces a number that is not a percentile of anything.
    peakP95: rows.reduce((n, b) => Math.max(n, b.durationP95), 0),
    bucketMinutes,
  };
}
