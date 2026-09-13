import { describe, expect, it } from 'vitest';
import { deriveTrafficChart, type TrafficBucketRow } from '../web/src/lib/traffic-chart.js';

const bucket = (scopeId: string, start: string, requests: number, extra: Partial<TrafficBucketRow> = {}) => ({
  scopeId,
  start,
  bucketMinutes: 60,
  requests,
  errors: 0,
  durationP50: 10,
  durationP95: 20,
  ...extra,
});

const APPS = [
  { scopeId: 'a', label: 'Acme HR' },
  { scopeId: 'b', label: 'Acme Legal' },
];

describe('deriveTrafficChart (#1447)', () => {
  it('gives every app a row on one shared axis, busiest first', () => {
    const v = deriveTrafficChart({
      apps: APPS,
      focus: null,
      buckets: [
        bucket('a', '2026-09-13T00:00:00Z', 5),
        bucket('b', '2026-09-13T00:00:00Z', 50),
        bucket('b', '2026-09-13T01:00:00Z', 10),
      ],
    });
    expect(v.axis).toEqual(['2026-09-13T00:00:00Z', '2026-09-13T01:00:00Z']);
    expect(v.series.map((s) => s.label)).toEqual(['Acme Legal', 'Acme HR']);
    expect(v.requests).toBe(65);
  });

  it('zero-fills a bucket the upstream omitted, rather than leaving a hole', () => {
    // A bucket exists only where something happened, so a missing one IS zero. A gap
    // would draw a line skipping over time that was measured and was quiet.
    const v = deriveTrafficChart({
      apps: APPS,
      focus: null,
      buckets: [
        bucket('a', '2026-09-13T00:00:00Z', 5),
        bucket('b', '2026-09-13T01:00:00Z', 7),
      ],
    });
    const a = v.series.find((s) => s.scopeId === 'a')!;
    expect(a.points.map((p) => p.requests)).toEqual([5, 0]);
    expect(a.points).toHaveLength(v.axis.length);
  });

  it('marks an app with no traffic at all rather than drawing an unexplained flat line', () => {
    const v = deriveTrafficChart({
      apps: APPS,
      focus: null,
      buckets: [bucket('a', '2026-09-13T00:00:00Z', 5)],
    });
    const b = v.series.find((s) => s.scopeId === 'b')!;
    expect(b.silent).toBe(true);
    expect(b.requests).toBe(0);
    // …and the app that DID run is not marked, though its later bucket is also zero.
    expect(v.series.find((s) => s.scopeId === 'a')!.silent).toBe(false);
  });

  it('narrows to one app when the chip names one', () => {
    const v = deriveTrafficChart({
      apps: APPS,
      focus: 'b',
      buckets: [
        bucket('a', '2026-09-13T00:00:00Z', 5),
        bucket('b', '2026-09-13T00:00:00Z', 7),
      ],
    });
    expect(v.series.map((s) => s.scopeId)).toEqual(['b']);
    // The other app's traffic is out of the totals too, not merely out of the lines.
    expect(v.requests).toBe(7);
  });

  it('reports the PEAK P95, never an average of percentiles', () => {
    // Averaging P95s across buckets and apps yields a number that is not a percentile
    // of anything, and reads lower than every bad moment it is meant to describe.
    const v = deriveTrafficChart({
      apps: APPS,
      focus: null,
      buckets: [
        bucket('a', '2026-09-13T00:00:00Z', 5, { durationP95: 20 }),
        bucket('a', '2026-09-13T01:00:00Z', 5, { durationP95: 900 }),
      ],
    });
    expect(v.peakP95).toBe(900);
  });

  it('has no axis for a window nothing ran in, rather than inventing ticks', () => {
    const v = deriveTrafficChart({ apps: APPS, focus: null, buckets: [] });
    expect(v.axis).toEqual([]);
    expect(v.requests).toBe(0);
    expect(v.series.every((s) => s.silent)).toBe(true);
    // Each app still gets a row: "nothing ran" is an answer, and the chip needs them.
    expect(v.series).toHaveLength(2);
  });

  it('ignores a bucket for a scope the team does not list', () => {
    // The read takes a list of scopes, so a row for anything else is not this team's
    // to total — counting it would put another tenant's traffic on the chart.
    const v = deriveTrafficChart({
      apps: APPS,
      focus: null,
      buckets: [bucket('a', '2026-09-13T00:00:00Z', 5), bucket('zzz', '2026-09-13T00:00:00Z', 999)],
    });
    expect(v.requests).toBe(5);
    expect(v.series.map((s) => s.scopeId).sort()).toEqual(['a', 'b']);
  });

  it('carries errors alongside requests on the same axis', () => {
    const v = deriveTrafficChart({
      apps: APPS,
      focus: 'a',
      buckets: [
        bucket('a', '2026-09-13T00:00:00Z', 10, { errors: 2 }),
        bucket('a', '2026-09-13T01:00:00Z', 10, { errors: 0 }),
      ],
    });
    expect(v.errors).toBe(2);
    expect(v.series[0]!.points.map((p) => p.errors)).toEqual([2, 0]);
  });
});
