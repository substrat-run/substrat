import { describe, it, expect } from 'vitest';
import { queryWindow, readObsQuery, dragWindow } from '../src/lib/observability-query';
import { obsPath } from '../src/lib/router';
import { parseLogColumns, moveColumn, DEFAULT_LOG_COLUMNS } from '../src/lib/log-columns';
const window = { since: '2026-09-01T10:00:00.000Z', until: '2026-09-01T11:00:00.000Z' };
describe('shared observability query', () => {
  it('round trips applied filters including punctuation and the historical interval', () => {
    const q = {
      app: 'a',
      from: window.since,
      to: window.until,
      hours: '72',
      view: 'events',
      type: 'receipt.sent',
      field: 'currency',
      groupBy: 'operation',
      level: 'error',
      search: 'a+b & c',
      invocationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    };
    expect(readObsQuery(obsPath(q).split('?')[1]!)).toEqual(q);
    expect(queryWindow(q)).toEqual(window);
  });
  it('rejects malformed, partial, reversed, oversized and future windows', () => {
    for (const q of [
      { from: window.since },
      { from: 'bad', to: window.until },
      { from: window.until, to: window.since },
      { from: window.since, to: '2026-09-05T10:00:00Z' },
      { hours: '9' },
    ])
      expect(() => queryWindow(q)).toThrow();
    expect(() => queryWindow({ from: window.since, to: window.until }, Date.parse(window.since))).toThrow();
  });
  it('maps reversed/outside gestures, and ignores click-sized movement', () => {
    expect(dragWindow(75, 25, 100, window)).toEqual({
      from: '2026-09-01T10:15:00.000Z',
      to: '2026-09-01T10:45:00.000Z',
    });
    expect(dragWindow(-20, 150, 100, window)).toEqual({ from: window.since, to: window.until });
    expect(dragWindow(25, 27, 100, window)).toBeNull();
  });
});
it('column preferences recover safely and reorder only known columns', () => {
  expect(parseLogColumns('{broken')).toEqual(DEFAULT_LOG_COLUMNS);
  expect(parseLogColumns('["raw","level","level","wallTimeMs"]')).toEqual(['level', 'wallTimeMs']);
  expect(parseLogColumns('[]')).toEqual(DEFAULT_LOG_COLUMNS);
  expect(moveColumn(['level', 'message', 'timestamp'], 'message', -1)).toEqual(['message', 'level', 'timestamp']);
});
