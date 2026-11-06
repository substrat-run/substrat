export type UsageMetric = 'requests' | 'tokens' | 'stored';

export interface UsageDayShare { vertical: string | null; value: number }
export interface UsageDay {
  day: string;
  requests: number | null;
  requestsByVertical: UsageDayShare[];
  modelCalls: number | null;
  tokens: number | null;
  tokensByVertical: UsageDayShare[];
  storedBytes: number | null;
  storedScopes: number;
}

export interface UsageSeries { key: string; label: string }
/** One bar. `value` null is a day with no reading, drawn as a gap and never as zero. */
export interface UsageBar { day: string; value: number | null; segments: { key: string; value: number }[] }
export interface UsageChartData { series: UsageSeries[]; bars: UsageBar[]; peak: number }

/** How many apps the legend names before the rest fold into Other. */
const NAMED_APPS = 4;
export const ALL_APPS = 'all';
const OTHER = 'other';
const TEAM = 'team';
const keyOf = (vertical: string | null) => vertical ?? 'unresolved';

const totalOf = (day: UsageDay, metric: UsageMetric) => metric === 'requests' ? day.requests : metric === 'tokens' ? day.tokens : day.storedBytes;
const sharesOf = (day: UsageDay, metric: UsageMetric) => metric === 'requests' ? day.requestsByVertical : metric === 'tokens' ? day.tokensByVertical : [];

/** The apps a metric names over the window, busiest first. Stored data has no per-app split. */
export function appsOf(days: readonly UsageDay[], metric: UsageMetric): UsageSeries[] {
  const totals = new Map<string, { label: string; value: number }>();
  for (const day of days) {
    for (const share of sharesOf(day, metric)) {
      const key = keyOf(share.vertical);
      const row = totals.get(key) ?? { label: share.vertical ?? 'Unresolved app', value: 0 };
      row.value += share.value;
      totals.set(key, row);
    }
  }
  return [...totals].sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0])).map(([key, row]) => ({ key, label: row.label }));
}

/**
 * Shape the days for the chart. What a day's shares leave of its total goes to Other: a long
 * label or an app past the cap is in the total and in no share, and a bar must reach its total.
 */
export function usageChart(days: readonly UsageDay[], metric: UsageMetric, app: string): UsageChartData {
  const apps = appsOf(days, metric);
  const narrowed = app !== ALL_APPS && metric !== 'stored';
  const named = narrowed ? apps.filter((row) => row.key === app) : apps.slice(0, NAMED_APPS);
  const namedKeys = new Set(named.map((row) => row.key));
  let hasOther = false;
  const bars = days.map((day): UsageBar => {
    const total = totalOf(day, metric);
    if (total === null) return { day: day.day, value: null, segments: [] };
    if (metric === 'stored') return { day: day.day, value: total, segments: total > 0 ? [{ key: TEAM, value: total }] : [] };
    const segments = sharesOf(day, metric)
      .filter((share) => namedKeys.has(keyOf(share.vertical)))
      .map((share) => ({ key: keyOf(share.vertical), value: share.value }))
      .sort((a, b) => named.findIndex((row) => row.key === a.key) - named.findIndex((row) => row.key === b.key));
    const shown = segments.reduce((sum, segment) => sum + segment.value, 0);
    if (narrowed) return { day: day.day, value: shown, segments };
    if (total > shown) {
      hasOther = true;
      segments.push({ key: OTHER, value: total - shown });
    }
    return { day: day.day, value: total, segments };
  });
  const series = metric === 'stored' ? [{ key: TEAM, label: 'All scopes' }] : hasOther ? [...named, { key: OTHER, label: 'Other' }] : named;
  return { series, bars, peak: bars.reduce((peak, bar) => Math.max(peak, bar.value ?? 0), 0) };
}

/** 1,240,000 → 1.24M. A chart axis and a summary tile, where the exact figure sits one row below. */
export function shortNumber(value: number): string {
  const scaled = (divisor: number, unit: string) => `${Number((value / divisor).toFixed(2))}${unit}`;
  if (value >= 1e9) return scaled(1e9, 'B');
  if (value >= 1e6) return scaled(1e6, 'M');
  if (value >= 1e3) return scaled(1e3, 'k');
  return String(value);
}

/** Decimal units, which is how the storage a scope database is billed in is quoted. */
export function shortBytes(value: number): string {
  const scaled = (divisor: number, unit: string) => `${Number((value / divisor).toFixed(2))} ${unit}`;
  if (value >= 1e9) return scaled(1e9, 'GB');
  if (value >= 1e6) return scaled(1e6, 'MB');
  if (value >= 1e3) return scaled(1e3, 'kB');
  return `${value} bytes`;
}
