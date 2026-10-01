import { describe, expect, it } from 'vitest';
import { metricLinePath } from '../src/lib/pulse-rows';

describe('Pulse latency trend (#1750)', () => {
  it('uses the shared time spans and breaks at unreadable buckets', () => {
    const spans: Array<[number, number]> = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8]];
    const path = metricLinePath([100, 200, null, 50], spans, 220);
    expect(path).toMatch(/^M48\.0,/);
    expect(path).toContain(' L144.0,');
    expect(path).toContain(' M288.0,');
    expect(metricLinePath([null, null], spans.slice(0, 2), 1)).toBeNull();
  });
});
