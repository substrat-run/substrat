import type { ConnectorCallsBucket } from './api';

/** One bucket of one provider's series, zero-filled, in the three chart colours. */
export interface ConnectorCallsCell {
  start: string;
  calls: number;
  /** 2xx — the provider answered. */
  green: number;
  /** 4xx — usually us (a revoked grant, a malformed call), not necessarily an alarm. */
  yellow: number;
  /** 5xx, timeouts, and calls that failed before any status arrived. */
  red: number;
}

export interface ConnectorCallsSeries {
  provider: string;
  cells: ConnectorCallsCell[];
  totals: { calls: number; green: number; yellow: number; red: number };
  /** The worst bucket's p95, ms — 0 when no call in the window was timed. */
  peakP95: number;
}

/** The bucket width the read picks for a window — the same rule the server applies. */
export const bucketMinutesFor = (hours: number): number => (hours <= 6 ? 15 : 60);

/**
 * Turn the read's sparse rows into one zero-filled series per provider on a shared grid.
 *
 * The server omits an empty bucket; a chart that drew only what arrived would join two
 * busy hours across a silent one and hide the outage between them. So every provider
 * gets every bucket of the window, ending with the one `now` falls in, and a provider is
 * listed when it has any call at all. Sorted by red count, worst first, so the provider
 * a reader came for is at the top.
 */
export function connectorCallsSeries(
  buckets: ConnectorCallsBucket[],
  hours: number,
  now: number,
): ConnectorCallsSeries[] {
  const width = (buckets[0]?.bucketMinutes ?? bucketMinutesFor(hours)) * 60_000;
  const count = Math.max(1, Math.ceil((hours * 60 * 60_000) / width));
  const last = Math.floor(now / width) * width;
  const grid = Array.from({ length: count }, (_, i) => last - (count - 1 - i) * width);

  const byProvider = new Map<string, Map<number, ConnectorCallsBucket>>();
  for (const b of buckets) {
    const at = Date.parse(b.start);
    if (!Number.isFinite(at)) continue;
    const slot = Math.floor(at / width) * width;
    const m = byProvider.get(b.provider) ?? new Map<number, ConnectorCallsBucket>();
    m.set(slot, b);
    byProvider.set(b.provider, m);
  }

  const series = [...byProvider.entries()].map(([provider, m]) => {
    const totals = { calls: 0, green: 0, yellow: 0, red: 0 };
    let peakP95 = 0;
    const cells = grid.map((slot) => {
      const b = m.get(slot);
      const cell: ConnectorCallsCell = b
        ? {
            start: new Date(slot).toISOString(),
            calls: b.calls,
            green: b.ok,
            yellow: b.class4xx,
            red: Math.max(0, b.calls - b.ok - b.class4xx),
          }
        : { start: new Date(slot).toISOString(), calls: 0, green: 0, yellow: 0, red: 0 };
      totals.calls += cell.calls;
      totals.green += cell.green;
      totals.yellow += cell.yellow;
      totals.red += cell.red;
      if (b && b.durationP95 > peakP95) peakP95 = b.durationP95;
      return cell;
    });
    return { provider, cells, totals, peakP95 };
  });
  return series
    .filter((s) => s.totals.calls > 0)
    .sort((a, b) => b.totals.red - a.totals.red || a.provider.localeCompare(b.provider));
}
