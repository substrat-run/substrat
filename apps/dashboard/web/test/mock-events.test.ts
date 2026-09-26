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

  it('a payload grouping counts one population whatever the field, like the kernel (#1762)', () => {
    const sum = (r: ReturnType<typeof mockEventFacets>) =>
      r.buckets.reduce((n, b) => n + b.count, 0) + r.erased + r.withheldPersonal;
    const channel = mockEventFacets({ field: 'channel' }, now);
    const email = mockEventFacets({ field: 'email' }, now);
    for (const r of [channel, email]) expect(sum(r)).toBe(r.total);
    // The field does not choose the population: same total, same erased, same withheld.
    expect([email.total, email.erased, email.withheldPersonal]).toEqual([channel.total, channel.erased, channel.withheldPersonal]);
    expect(email.withheldPersonal).toBeGreaterThan(0);
    expect(email.erased).toBeGreaterThan(0);
    // The `none` events do not carry `email`, so they are the null bucket — not nothing.
    expect(email.buckets).toHaveLength(1);
    expect(email.buckets[0]!.value).toBeNull();
    expect(email.buckets[0]!.count).toBe(channel.buckets.reduce((n, b) => n + b.count, 0));
    // The PII-class dimension counts the same events the payload grouping split.
    const byClass = Object.fromEntries(mockEventFacets({ groupBy: 'piiClass' }, now).buckets.map((b) => [b.value, b.count]));
    expect(Object.keys(byClass).sort()).toEqual(['direct', 'none', 'pseudonymous']);
    expect(byClass.none).toBe(email.buckets[0]!.count);
    expect(byClass.direct! + byClass.pseudonymous!).toBe(email.erased + email.withheldPersonal);
    // An envelope grouping withholds nothing.
    expect(mockEventFacets({ groupBy: 'type' }, now).withheldPersonal).toBe(0);
  });

  it('reaches "every event withheld" only through a population with no none event in it (#1762)', () => {
    // A reply carries its body, so the fixture classes every reply as direct personal data.
    const replies = mockEventFacets({ field: 'channel', type: 'ticket.replied' }, now);
    expect(replies.buckets).toEqual([]);
    expect(replies.total).toBeGreaterThan(0);
    expect(replies.erased + replies.withheldPersonal).toBe(replies.total);
  });
});
