import { describe, expect, it } from 'vitest';
import type { ConnectorCallsBucket } from '../src/lib/api';
import { bucketSpans, metricLinePath, pulseConnectorRows } from '../src/lib/pulse-rows';

const bucket = (start: string, calls: number, errors: number, durationP95: number): ConnectorCallsBucket => ({
  provider: 'mail', start, bucketMinutes: 15, calls, errors, durationP95,
  ok: calls - errors, class4xx: 0, class5xx: errors, timeouts: 0, failed: 0, durationP50: durationP95 / 2,
});

describe('Pulse connector rows (#1750)', () => {
  const window = { from: '2026-09-22T10:00:00Z', to: '2026-09-22T11:00:00Z' };

  it('fills missing bins on the app clock without inventing latency', () => {
    const rows = pulseConnectorRows([
      bucket('2026-09-22T10:00:00Z', 5, 1, 90),
      bucket('2026-09-22T10:30:00Z', 2, 0, 40),
    ], window, 15);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'mail', calls: 7, errors: 1, latestP95: 40 });
    expect(rows[0]!.buckets.map((b) => [b.calls, b.durationP95])).toEqual([[5, 90], [0, null], [2, 40], [0, null]]);
    const spans = bucketSpans(rows[0]!.buckets, 15, window);
    expect(metricLinePath(rows[0]!.buckets.map((b) => b.durationP95), spans, 100)).toContain(' M240.0,');
  });

  it('adds duplicate counts but drops an unmergeable percentile', () => {
    const rows = pulseConnectorRows([
      bucket('2026-09-22T10:00:00Z', 5, 1, 90),
      bucket('2026-09-22T10:00:00Z', 2, 0, 40),
    ], window, 15);
    expect(rows[0]).toMatchObject({ calls: 7, errors: 1, latestP95: null });
    expect(rows[0]!.buckets[0]).toMatchObject({ calls: 7, durationP95: null });
  });

  it('treats the reader zero sentinel as no latency observation', () => {
    const rows = pulseConnectorRows([
      bucket('2026-09-22T10:00:00Z', 2, 0, 45),
      bucket('2026-09-22T10:15:00Z', 3, 0, 0),
    ], window, 15);
    expect(rows[0]).toMatchObject({ calls: 5, latestP95: 45 });
    expect(rows[0]!.buckets.map((b) => b.durationP95)).toEqual([45, null, null, null]);
  });
});
