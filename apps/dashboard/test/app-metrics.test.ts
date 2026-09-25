import { describe, expect, it } from 'vitest';
import { deriveAppMetrics } from '../src/app-metrics.js';

const row = (scopeId: string, surface: string | null, requests: number, errors: number, durationP95: number) => ({ scopeId, surface, requests, errors, durationP95 });

describe('deriveAppMetrics (#1767)', () => {
  it('gives one row per listed app, zero-filled, with the grouped p95', () => {
    const v = deriveAppMetrics({ rows: [row('a', null, 100, 2, 310)], scopeIds: ['a', 'b'] });
    expect(v).toEqual({ available: true, rows: [{ scopeId: 'a', requests: 100, errors: 2, p95: 310 }, { scopeId: 'b', requests: 0, errors: 0, p95: null }] });
  });

  it('keeps the sums but drops p95 when an older plane answered by surface', () => {
    // A p95 of per-surface p95s is not the app's p95; a blank column is right, a guess is not.
    const v = deriveAppMetrics({ rows: [row('a', 'app', 90, 1, 200), row('a', 'api', 10, 1, 900)], scopeIds: ['a'] });
    expect(v.rows).toEqual([{ scopeId: 'a', requests: 100, errors: 2, p95: null }]);
  });

  it('says unavailable, never zero, when no reader is configured', () => {
    expect(deriveAppMetrics({ rows: null, scopeIds: ['a'] })).toEqual({ available: false, rows: [{ scopeId: 'a', requests: 0, errors: 0, p95: null }] });
  });

  it('drops rows for scopes the team no longer lists', () => {
    expect(deriveAppMetrics({ rows: [row('gone', null, 5, 0, 10)], scopeIds: ['a'] }).rows).toEqual([{ scopeId: 'a', requests: 0, errors: 0, p95: null }]);
  });
});
