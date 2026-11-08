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
/** A vertical's registry id (`<owner>/<slug>`) → the name its page shows. */
export type VerticalNames = ReadonlyMap<string, string>;
/** One bar. `value` null is a day with no reading, drawn as a gap and never as zero. */
export interface UsageBar { day: string; value: number | null; segments: { key: string; value: number }[] }
export interface UsageChartData { series: UsageSeries[]; bars: UsageBar[]; peak: number }

/** How many verticals the legend names before the rest fold into Other. */
const NAMED_VERTICALS = 4;
export const ALL_VERTICALS = 'all';
const OTHER = 'other';
const TEAM = 'team';
const keyOf = (vertical: string | null) => vertical ?? 'unresolved';

/**
 * What a usage row names a vertical by. The meters key rows by registry id, whose owner prefix
 * is a workspace id nobody reads; one the catalog no longer lists keeps its bare slug.
 */
export function verticalLabel(names: VerticalNames, vertical: string | null): string {
  if (vertical === null) return 'Unresolved vertical';
  return names.get(vertical) ?? vertical.slice(vertical.lastIndexOf('/') + 1);
}

const totalOf = (day: UsageDay, metric: UsageMetric) => metric === 'requests' ? day.requests : metric === 'tokens' ? day.tokens : day.storedBytes;
const sharesOf = (day: UsageDay, metric: UsageMetric) => metric === 'requests' ? day.requestsByVertical : metric === 'tokens' ? day.tokensByVertical : [];

/** The verticals a metric names over the window, busiest first. Stored data has no per-vertical split. */
export function verticalsOf(days: readonly UsageDay[], metric: UsageMetric, names: VerticalNames): UsageSeries[] {
  const totals = new Map<string, { label: string; value: number }>();
  for (const day of days) {
    for (const share of sharesOf(day, metric)) {
      const key = keyOf(share.vertical);
      const row = totals.get(key) ?? { label: verticalLabel(names, share.vertical), value: 0 };
      row.value += share.value;
      totals.set(key, row);
    }
  }
  return [...totals].sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0])).map(([key, row]) => ({ key, label: row.label }));
}

/**
 * Shape the days for the chart. What a day's shares leave of its total goes to Other: a long
 * label or a vertical past the cap is in the total and in no share, and a bar must reach its total.
 */
export function usageChart(days: readonly UsageDay[], metric: UsageMetric, vertical: string, names: VerticalNames): UsageChartData {
  const verticals = verticalsOf(days, metric, names);
  const narrowed = vertical !== ALL_VERTICALS && metric !== 'stored';
  const named = narrowed ? verticals.filter((row) => row.key === vertical) : verticals.slice(0, NAMED_VERTICALS);
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
