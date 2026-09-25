import { describe, expect, it } from 'vitest';
import { mockEventFacets } from '../src/lib/mock-events';

// The preview must answer the question the controls ask, or it shows a narrowed type's
// bars over unrelated operations and current events under a historical cursor.
const now = Date.parse('2026-09-20T12:00:00.000Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe('mockEventFacets', () => {
  it('a type narrowed and grouped by operation keeps only the operations that emit it', () => {
    const r = mockEventFacets({ groupBy: 'operation', type: 'invoice.sent' }, now);
    expect(r.buckets.map((b) => b.value)).toEqual(['acme-billing/send-invoice']);
    expect(r.buckets[0]!.count).toBe(612);
  });

  it('a type grouped by type is that one bucket, and an unknown type is none', () => {
    expect(mockEventFacets({ groupBy: 'type', type: 'deal.closed' }, now).buckets.map((b) => b.value)).toEqual(['deal.closed']);
    expect(mockEventFacets({ groupBy: 'operation', type: 'no.such-type' }, now)).toMatchObject({ buckets: [], total: 0 });
  });

  it('a window that ends before a bucket was last seen shows no later lastSeen than its end', () => {
    const until = ago(24 * 60);
    const r = mockEventFacets({ groupBy: 'type', since: ago(25 * 60), until }, now);
    expect(r.buckets.length).toBeGreaterThan(0);
    for (const b of r.buckets) expect(b.lastSeen! <= until).toBe(true);
    // An hour of a week is a fraction of the whole, never the unwindowed count.
    expect(r.total).toBeLessThan(mockEventFacets({ groupBy: 'type' }, now).total / 50);
  });

  it('a window outside the fixture is empty, and one before a bucket last fired drops it', () => {
    expect(mockEventFacets({ groupBy: 'type', since: ago(30 * 24 * 60), until: ago(29 * 24 * 60) }, now)).toMatchObject({ buckets: [], total: 0, erased: 0 });
    // deal.closed last fired 312 minutes ago; a window over the last hour has none of it.
    const recent = mockEventFacets({ groupBy: 'type', since: ago(60), until: ago(0) }, now);
    expect(recent.buckets.map((b) => b.value)).not.toContain('deal.closed');
  });
});
