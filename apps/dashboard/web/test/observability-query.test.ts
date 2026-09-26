import { describe, it, expect } from 'vitest';
import { queryWindow, readObsQuery, dragWindow } from '../src/lib/observability-query';
import { obsPath } from '../src/lib/router';
import { sectionQuery } from '../src/lib/obs-sections';
import { logChips, parseBarText, shortId, windowLabel, without } from '../src/lib/logs-chips';
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
describe('Logs query bar chips (#1767)', () => {
  const inv = '01J2Q8Z3V9K4W7X2M5N6P71041';
  it("draws only the open mode's filters, and removing one clears exactly its keys", () => {
    const q = { app: 'a', view: 'logs', level: 'error', search: 'boom', invocationId: inv, type: 't.x', groupBy: 'operation' };
    expect(logChips(q, 'logs').map((c) => [c.key, c.value])).toEqual([
      ['level', 'error'],
      ['message', 'boom'],
      ['invocation', shortId(inv)],
    ]);
    expect(logChips(q, 'events').map((c) => [c.key, c.value])).toEqual([
      ['type', 't.x'],
      ['group by', 'operation'],
    ]);
    // A payload grouping is one chip, and removing it clears the field with the grouping.
    const field = logChips({ groupBy: 'type', field: 'currency' }, 'events');
    expect(field).toEqual([{ key: 'group by', value: 'payload.currency', clears: ['groupBy', 'field'] }]);
    expect(without({ ...q, field: 'currency' }, field[0]!.clears)).not.toHaveProperty('field');
    expect(without(q, ['level'])).toEqual({ app: 'a', view: 'logs', search: 'boom', invocationId: inv, type: 't.x', groupBy: 'operation' });
  });
  it('reads typed text as a message search, or as the filter a key names — refusing a malformed one', () => {
    expect(parseBarText('  timeout  ', 'logs')).toEqual({ add: { search: 'timeout' } });
    expect(parseBarText('level:ERROR', 'logs')).toEqual({ add: { level: 'error' } });
    expect(parseBarText(`invocation: ${inv}`, 'logs')).toEqual({ add: { invocationId: inv } });
    expect(parseBarText('invocation:abc', 'logs')).toEqual({ error: expect.stringContaining('ULID') });
    expect(parseBarText('level:loud', 'logs')).toEqual({ error: expect.stringContaining('error, warn') });
    expect(parseBarText('receipt.sent', 'events')).toEqual({ add: { type: 'receipt.sent' } });
    expect(parseBarText('', 'logs')).toBeNull();
    expect(parseBarText('x'.repeat(201), 'logs')).toEqual({ error: expect.any(String) });
  });
  it('refuses a key the other mode owns, rather than writing a filter that shows no chip', () => {
    expect(parseBarText('type:receipt.sent', 'logs')).toEqual({ error: 'type: filters apply in Events.' });
    expect(parseBarText('level:error', 'events')).toEqual({ error: 'level: filters apply in Lines.' });
    expect(parseBarText(`invocation:${inv}`, 'events')).toEqual({ error: 'invocation: filters apply in Lines.' });
    expect(parseBarText('type:receipt.sent', 'events')).toEqual({ add: { type: 'receipt.sent' } });
  });
  it('refuses an empty filter key, rather than searching for "level:" as a message', () => {
    expect(parseBarText('level:', 'logs')).toEqual({ error: 'level: needs a value after the colon.' });
    expect(parseBarText('invocation:   ', 'logs')).toEqual({ error: 'invocation: needs a value after the colon.' });
    expect(parseBarText('type:', 'events')).toEqual({ error: 'type: needs a value after the colon.' });
  });
  it('dates a custom window, so a cross-day one cannot read as 10:00–10:00', () => {
    expect(windowLabel('2026-09-01T10:00:00.000Z', '2026-09-02T10:00:00.000Z')).toBe('2026-09-01 10:00 – 2026-09-02 10:00 UTC');
    expect(windowLabel('2026-09-01T10:00:00.000Z', '2026-09-01T11:30:00.000Z')).toBe('2026-09-01 10:00–11:30 UTC');
  });
});

describe('switching Observability child (#1767)', () => {
  it('keeps a relative preset, so a 1h view does not reset to 24h', () => {
    expect(sectionQuery('?app=a&view=traffic&hours=1&level=error', 'logs')).toEqual({ app: 'a', view: 'logs', hours: '1' });
  });
  it('keeps an explicit window over the preset beside it', () => {
    expect(sectionQuery(`?view=logs&hours=72&from=${window.since}&to=${window.until}`, 'pulse')).toEqual({ view: 'traffic', from: window.since, to: window.until });
  });
  it('leaves the view off for the bare Observability breadcrumb', () => {
    expect(sectionQuery('?app=a&view=events&hours=72')).toEqual({ app: 'a', hours: '72' });
  });
});
