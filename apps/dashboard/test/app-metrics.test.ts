import { describe, expect, it } from 'vitest';
import { deriveAppMetrics } from '../src/app-metrics.js';

const row = (scopeId: string, surface: string | null, requests: number, errors: number, durationP95: number) => ({ scopeId, surface, requests, errors, durationP95 });
const CAP = 200;

describe('deriveAppMetrics (#1767)', () => {
  it('gives one row per listed app, zero-filled, with the grouped p95', () => {
    const v = deriveAppMetrics({ rows: [row('a', null, 100, 2, 310)], scopeIds: ['a', 'b'], cap: CAP });
    expect(v).toEqual({ available: true, cap: null, rows: [{ scopeId: 'a', requests: 100, errors: 2, p95: 310 }, { scopeId: 'b', requests: 0, errors: 0, p95: null }] });
  });

  it('keeps the sums but drops p95 when an older plane answered by surface', () => {
    // A p95 of per-surface p95s is not the app's p95; a blank column is right, a guess is not.
    const v = deriveAppMetrics({ rows: [row('a', 'app', 90, 1, 200), row('a', 'api', 10, 1, 900)], scopeIds: ['a'], cap: CAP });
    expect(v.rows).toEqual([{ scopeId: 'a', requests: 100, errors: 2, p95: null }]);
  });

  it('says unavailable, never zero, when no reader is configured', () => {
    expect(deriveAppMetrics({ rows: null, scopeIds: ['a'], cap: CAP })).toEqual({ available: false, cap: null, rows: [{ scopeId: 'a', requests: 0, errors: 0, p95: null }] });
  });

  it('drops rows for scopes the team no longer lists', () => {
    expect(deriveAppMetrics({ rows: [row('gone', null, 5, 0, 10)], scopeIds: ['a'], cap: CAP }).rows).toEqual([{ scopeId: 'a', requests: 0, errors: 0, p95: null }]);
  });

  /**
   * The read stops at the busiest `cap` scopes. An app missing from a FULL answer was
   * never read — it may be busy — so it must not be drawn as a quiet one.
   */
  describe('the row cap', () => {
    const answer = (n: number) => Array.from({ length: n }, (_, i) => row(`s${i}`, null, 1000 - i, 0, 50));
    const scopeIds = (n: number) => [...Array.from({ length: n }, (_, i) => `s${i}`), 'past-the-cap'];

    it('reads an app missing from a full answer as unread, not zero', () => {
      const v = deriveAppMetrics({ rows: answer(CAP), scopeIds: scopeIds(CAP), cap: CAP });
      expect(v.cap).toBe(CAP);
      expect(v.rows.find((r) => r.scopeId === 'past-the-cap')).toEqual({ scopeId: 'past-the-cap', requests: null, errors: null, p95: null });
      // An app the full answer DID carry is still read in full.
      expect(v.rows.find((r) => r.scopeId === 's0')).toEqual({ scopeId: 's0', requests: 1000, errors: 0, p95: 50 });
    });

    it('reads an app missing from a short answer as zero — it genuinely had no traffic', () => {
      const v = deriveAppMetrics({ rows: answer(CAP - 1), scopeIds: scopeIds(CAP - 1), cap: CAP });
      expect(v.cap).toBeNull();
      expect(v.rows.find((r) => r.scopeId === 'past-the-cap')).toEqual({ scopeId: 'past-the-cap', requests: 0, errors: 0, p95: null });
    });

    it('trusts no sum in a full per-surface answer — it may have cut a quiet surface off a listed app', () => {
      const rows = [row('a', 'app', 500, 1, 90), ...Array.from({ length: CAP - 1 }, (_, i) => row(`s${i}`, 'app', 400, 0, 10))];
      const v = deriveAppMetrics({ rows, scopeIds: ['a'], cap: CAP });
      expect(v.rows).toEqual([{ scopeId: 'a', requests: null, errors: null, p95: null }]);
    });
  });

  it('shows no p95 when one scope answers two grouped rows — a rebind splits it, and p95s do not combine', () => {
    // A scope rebound to another vertical mid-window, from a plane that grouped by vertical too.
    const v = deriveAppMetrics({ rows: [row('a', null, 60, 1, 120), row('a', null, 40, 0, 900)], scopeIds: ['a'], cap: CAP });
    expect(v.rows).toEqual([{ scopeId: 'a', requests: 100, errors: 1, p95: null }]);
  });
});
