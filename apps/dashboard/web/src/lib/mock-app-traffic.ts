import type { AppOverlays, TenantMetricsRow, TrafficSeries } from './api';
import { MOCK_APP_OVERLAYS } from './mock';

/**
 * Dev-preview fixtures for the app page's "Traffic by status" card (#1767). Unlike the
 * fixed `MOCK_APP_TRAFFIC` in `mock.ts`, this answers ANY window, at the width the plane
 * would answer it in (15-minute buckets up to six hours, hourly beyond), so zooming in the
 * preview re-buckets the way the real read does.
 *
 * One synthetic series per absolute minute, anchored to when the module loaded, so a
 * zoomed read and the day it was cut from agree about every minute they share. The 5xx
 * burst sits under `MOCK_APP_OVERLAYS`' two recorded failures (3.4 h and 3.2 h ago).
 */
const T0 = Date.now();
const MINUTE = 60_000;

const hash = (m: number, salt: number) => {
  const x = Math.sin((m + salt) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

function perMinute(m: number): { ok: number; c4: number; c5: number } {
  const hour = ((m / 60) % 24 + 24) % 24;
  // Busy in the UTC working day, quiet at night — the shape a real desk has.
  const load = Math.max(0.2, Math.exp(-((hour - 12.5) ** 2) / 16));
  const ok = Math.round(9.6 * load * (0.85 + hash(m, 7) * 0.3));
  const c4 = hash(m, 5007) < 0.035 * load + 0.004 ? 1 : 0;
  const ago = (T0 - m * MINUTE) / 3_600_000;
  const burst = ago >= 3.1 && ago <= 3.5;
  const c5 = burst ? (hash(m, 3) < 0.6 ? 2 : 1) : hash(m, 11) < 0.003 ? 1 : 0;
  return { ok, c4, c5 };
}

export function mockAppTraffic(window?: { since: string; until: string }): TrafficSeries {
  const until = window ? Date.parse(window.until) : Math.floor(T0 / 1000) * 1000;
  const since = window ? Date.parse(window.since) : until - 24 * 3_600_000;
  const bucketMinutes = until - since <= 6 * 3_600_000 ? 15 : 60;
  const width = bucketMinutes * MINUTE;
  const buckets = [];
  for (let start = Math.floor(since / width) * width; start < until; start += width) {
    let ok = 0, c4 = 0, c5 = 0;
    // Only the minutes inside the window count, as the real read's edge buckets do.
    for (let t = Math.max(start, Math.ceil(since / MINUTE) * MINUTE); t < Math.min(start + width, until); t += MINUTE) {
      const v = perMinute(Math.floor(t / MINUTE));
      ok += v.ok;
      c4 += v.c4;
      c5 += v.c5;
    }
    buckets.push({ start: new Date(start).toISOString(), requests: ok + c4 + c5, errors: c5, green: ok, yellow: c4 });
  }
  const markers = [
    { at: new Date(T0 - 18 * 3_600_000).toISOString(), kind: 'went-live' as const, version: '0.0.12', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR03' },
    { at: new Date(T0 - 2.6 * 3_600_000).toISOString(), kind: 'pushed' as const, version: '0.0.13', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR04' },
  ].filter((m) => Date.parse(m.at) >= since && Date.parse(m.at) < until);
  return {
    ...(window ? { window } : {}),
    buckets,
    markers,
    bucketMinutes,
    available: true,
  };
}

/** The same window split by surface, so the table under the chart adds up to the chart. */
export function mockSurfaceMetrics(series: TrafficSeries): TenantMetricsRow[] {
  const requests = series.buckets.reduce((n, b) => n + b.requests, 0);
  const errors = series.buckets.reduce((n, b) => n + b.errors, 0);
  const appShare = Math.round(requests * 0.78);
  const appErrors = Math.round(errors * 0.85);
  return [
    { scopeId: 'mock', vertical: 'protocol', surface: 'app', requests: appShare, errors: appErrors, durationP50: 84, durationP95: 290 },
    { scopeId: 'mock', vertical: 'protocol', surface: 'api', requests: requests - appShare, errors: errors - appErrors, durationP50: 31, durationP95: 460 },
  ];
}

/** `MOCK_APP_OVERLAYS` narrowed to a window, as the overlays route narrows its answer —
 *  a marker outside the window would otherwise be pinned to the plot's edge. */
export function mockAppOverlays(series: TrafficSeries): AppOverlays {
  const since = Date.parse(series.window?.since ?? series.buckets[0]?.start ?? '');
  const until = series.window ? Date.parse(series.window.until) : Infinity;
  const inside = (iso: string) => Date.parse(iso) >= since && Date.parse(iso) < until;
  return {
    ...MOCK_APP_OVERLAYS,
    markers: MOCK_APP_OVERLAYS.markers.filter((m) => inside(m.at)),
    spans: MOCK_APP_OVERLAYS.spans.filter((s) => Date.parse(s.to) > since && Date.parse(s.from) < until),
  };
}
