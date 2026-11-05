import { expect, it } from 'vitest';
import { ALL_APPS, shortBytes, shortNumber, usageChart, type UsageDay } from '../src/lib/usage-days';

const day = (date: string, requests: number | null, shares: [string | null, number][] = [], storedBytes: number | null = null): UsageDay => ({
  day: date, requests, requestsByVertical: shares.map(([vertical, value]) => ({ vertical, value })),
  modelCalls: 0, tokens: 0, tokensByVertical: [], storedBytes, storedScopes: storedBytes === null ? 0 : 1,
});

it('stacks busiest first, and gives what the shares leave of the total to Other', () => {
  const chart = usageChart([day('2026-10-01', 10, [['small', 1], ['big', 6]])], 'requests', ALL_APPS);
  expect(chart.series.map((row) => row.label)).toEqual(['big', 'small', 'Other']);
  expect(chart.bars[0]!.segments).toEqual([{ key: 'big', value: 6 }, { key: 'small', value: 1 }, { key: 'other', value: 3 }]);
  expect(chart.peak).toBe(10);
});

it('folds apps past the fourth into Other', () => {
  const shares: [string, number][] = [['a', 5], ['b', 4], ['c', 3], ['d', 2], ['e', 1]];
  const chart = usageChart([day('2026-10-01', 15, shares)], 'requests', ALL_APPS);
  expect(chart.series.map((row) => row.key)).toEqual(['a', 'b', 'c', 'd', 'other']);
  expect(chart.bars[0]!.segments.at(-1)).toEqual({ key: 'other', value: 1 });
});

it('narrows to one app, keeping an unknown day unknown and a day without that app at zero', () => {
  const chart = usageChart([day('2026-10-01', 9, [['a', 5], ['b', 4]]), day('2026-10-02', null), day('2026-10-03', 4, [['b', 4]])], 'requests', 'a');
  expect(chart.bars.map((bar) => bar.value)).toEqual([5, null, 0]);
  expect(chart.series.map((row) => row.key)).toEqual(['a']);
});

it('draws stored data as one team series whatever app is picked', () => {
  const chart = usageChart([day('2026-10-01', 9, [['a', 9]], 2048)], 'stored', 'a');
  expect(chart.series).toEqual([{ key: 'team', label: 'All scopes' }]);
  expect(chart.bars[0]!.value).toBe(2048);
});

it('shortens figures', () => {
  expect([shortNumber(950), shortNumber(1_240_000), shortNumber(2_000_000_000)]).toEqual(['950', '1.24M', '2B']);
  expect([shortBytes(512), shortBytes(3_400_000_000)]).toEqual(['512 bytes', '3.4 GB']);
});
