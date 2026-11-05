import { expect, it } from 'vitest';
import { usageDays, utcDaysBetween } from '../src/metered-usage-days.js';

const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
const request = (day: string, requests: number, vertical: string | null = 'app', labelTruncated = false) => ({ day, vertical, labelTruncated, requests });
const call = (day: string, tokens: number, reported = true) => ({ day, vertical: 'app', reported, tokens });

it('lists every day of the window across a month end', () => {
  expect(utcDaysBetween('2026-10-30', '2026-11-01')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
});

it('keeps an unread source null on every day', () => {
  const rows = usageDays(days, { requests: null, models: null, storage: null });
  expect(rows[0]).toEqual({ day: days[0], requests: null, requestsByVertical: [], modelCalls: null, tokens: null, tokensByVertical: [], storedBytes: null, storedScopes: 0 });
});

it('tells an uncovered day from a covered day of no traffic, and keeps a long label in the total only', () => {
  const rows = usageDays(days, {
    requests: { rows: [request(days[0]!, 5), request(days[0]!, 2, 'x'.repeat(64), true)], covered: new Set([days[0]!, days[1]!]), clipped: false },
    models: null, storage: null,
  });
  expect(rows.map((row) => row.requests)).toEqual([7, 0, null]);
  expect(rows[0]!.requestsByVertical).toEqual([{ vertical: 'app', value: 5 }]);
});

it('drops the day a capped request read stopped in, and every later day', () => {
  const rows = usageDays(days, {
    requests: { rows: [request(days[0]!, 5), request(days[1]!, 6)], covered: new Set(days), clipped: true },
    models: null, storage: null,
  });
  expect(rows.map((row) => row.requests)).toEqual([5, null, null]);
});

it('drops the day a capped model read stopped in, and every earlier day', () => {
  const rows = usageDays(days, { requests: null, storage: null, models: { rows: [call(days[2]!, 9), call(days[1]!, 4)], truncated: true } });
  expect(rows.map((row) => row.tokens)).toEqual([null, null, 9]);
});

it('does not turn calls that reported no tokens into zero tokens', () => {
  const rows = usageDays(days, { requests: null, storage: null, models: { rows: [call(days[0]!, 0, false), call(days[1]!, 3), call(days[1]!, 0, false)], truncated: false } });
  expect(rows.map((row) => [row.modelCalls, row.tokens])).toEqual([[1, null], [2, 3], [0, 0]]);
});

it('sums a day across scopes and counts how many were sampled', () => {
  const rows = usageDays(days, { requests: null, models: null, storage: { rows: [{ day: days[0]!, bytes: 10 }, { day: days[0]!, bytes: 5 }] } });
  expect(rows.map((row) => [row.storedBytes, row.storedScopes])).toEqual([[15, 2], [null, 0], [null, 0]]);
});
