import { describe, expect, it } from 'vitest';
import { deriveOperationHealth, type DenialRead, type RefusalBucket } from '../src/operation-health.js';

const emptyLog: DenialRead = { buckets: [], held: 0, windowOldestAt: null };

/** A log whose bucket list accounts for every row it holds — the complete case. */
function log(buckets: RefusalBucket[], windowOldestAt = '2026-09-01T00:00:00.000Z'): DenialRead {
  return {
    buckets,
    held: buckets.reduce((n, b) => n + b.count, 0),
    windowOldestAt: buckets.length ? windowOldestAt : null,
  };
}

const base = {
  observed: [] as { operation: string; count: number; lastSeen: string | null }[],
  observedComplete: true,
  denials: emptyLog as DenialRead | null,
};

describe('deriveOperationHealth (#1234)', () => {
  it('carries what each operation emitted, and when it last did', () => {
    const v = deriveOperationHealth({
      ...base,
      observed: [
        { operation: 'billing/close', count: 412, lastSeen: '2026-09-01T00:00:00.000Z' },
        { operation: 'billing/open', count: 3, lastSeen: '2026-09-10T00:00:00.000Z' },
      ],
    });
    expect(v.rows.map((r) => r.operation)).toEqual(['billing/close', 'billing/open']);
    expect(v.rows[0]!.events).toBe(412);
    expect(v.rows[0]!.lastSeen).toBe('2026-09-01T00:00:00.000Z');
    expect(v.rows.every((r) => r.refusals === 0)).toBe(true);
    expect(v.refusals).toEqual({ complete: true, held: 0, counted: 0, since: null });
  });

  it('shows an operation that ONLY ever gets refused', () => {
    // The case a join would lose. A call refused at its first line emits nothing, so
    // the event facet has never heard of it — and it is exactly the operation somebody
    // is failing to call.
    const v = deriveOperationHealth({
      ...base,
      observed: [{ operation: 'billing/close', count: 10, lastSeen: '2026-09-01T00:00:00.000Z' }],
      denials: log([{ operation: 'billing/void', count: 2 }]),
    });
    const void_ = v.rows.find((r) => r.operation === 'billing/void')!;
    expect(void_.refusals).toBe(2);
    expect(void_.events).toBe(0);
    expect(void_.refusedOnly).toBe(true);
    // …and it sorts above the busy one, because refusals are the thing to look at.
    expect(v.rows[0]!.operation).toBe('billing/void');
  });

  it('counts refusals against an operation that also emits', () => {
    const v = deriveOperationHealth({
      ...base,
      observed: [{ operation: 'billing/close', count: 10, lastSeen: '2026-09-01T00:00:00.000Z' }],
      denials: log([{ operation: 'billing/close', count: 1 }]),
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ events: 10, refusals: 1, refusedOnly: false });
  });

  it('takes the count from the bucket, not from anything it could count itself (#1456)', () => {
    // The bucket IS the aggregate: every row of its operation, however many the log
    // holds. Nothing here re-counts, so a count can never be a floor of a page.
    const v = deriveOperationHealth({
      ...base,
      denials: log([{ operation: 'a/b', count: 4_312 }]),
    });
    expect(v.rows[0]!.refusals).toBe(4_312);
    expect(v.refusals).toMatchObject({ complete: true, held: 4_312, counted: 4_312 });
  });

  it("reports the LOG's floor, not the buckets', because those rows drain rather than expire", () => {
    // THE honesty flag. `refusals: 0` means "none in what is still held", never "never
    // refused" — the log is a storage bound, not a retention promise, so a view that
    // omitted the floor would be inviting the wrong reading. And the floor is what the
    // log says it holds, filter-free, not the first occurrence in any bucket.
    const v = deriveOperationHealth({
      ...base,
      denials: {
        buckets: [{ operation: 'a/b', count: 2 }],
        held: 2,
        windowOldestAt: '2026-08-20T00:00:00.000Z',
      },
    });
    expect(v.refusals?.since).toBe('2026-08-20T00:00:00.000Z');
  });

  it('has no floor to report when the log holds nothing', () => {
    expect(deriveOperationHealth(base).refusals?.since).toBeNull();
  });

  it('lets a null-operation bucket count toward the window without inventing a row', () => {
    // It is evidence about the log's extent, and not evidence about any operation.
    const v = deriveOperationHealth({
      ...base,
      denials: log([{ operation: null, count: 1 }], '2026-09-02T00:00:00.000Z'),
    });
    expect(v.rows).toEqual([]);
    expect(v.refusals).toMatchObject({ complete: true, held: 1, counted: 1, since: '2026-09-02T00:00:00.000Z' });
  });

  it('says UNKNOWN rather than zero for a refused operation when the facet was cut short', () => {
    // Zero means "the facet answered and this was not in it". A truncated facet did not
    // answer, and printing zero would turn a gap into a measurement — nor can the row
    // claim "nothing emitted", which is the same gap read the other way.
    const v = deriveOperationHealth({
      ...base,
      observed: [],
      observedComplete: false,
      denials: log([{ operation: 'billing/void', count: 1 }]),
    });
    expect(v.rows[0]!.events).toBeNull();
    expect(v.rows[0]!.refusedOnly).toBe(false);
    expect(v.observedComplete).toBe(false);
  });

  it('marks a capped bucket list as incomplete, while the counts it does carry stay exact', () => {
    // The log holds rows no bucket accounts for: the list was cut at its cap, so the
    // QUIETEST operations are missing entirely (buckets are busiest first). The one
    // shown is still every row of its operation — a cap withholds operations, not rows.
    const v = deriveOperationHealth({
      ...base,
      denials: {
        buckets: [{ operation: 'billing/void', count: 850 }],
        held: 900,
        windowOldestAt: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(v.refusals).toEqual({ complete: false, held: 900, counted: 850, since: '2026-08-01T00:00:00.000Z' });
    expect(v.rows[0]!.refusals).toBe(850);
  });

  it('keeps an unread log distinct from an empty one', () => {
    // A retrieval failure must not render as a clean bill: every row carries null for
    // refusals rather than zero, and the view carries no window to vouch for.
    const v = deriveOperationHealth({
      ...base,
      observed: [{ operation: 'billing/close', count: 10, lastSeen: '2026-09-01T00:00:00.000Z' }],
      denials: null,
    });
    expect(v.refusals).toBeNull();
    expect(v.rows[0]!.refusals).toBeNull();
    expect(v.rows[0]!.refusedOnly).toBe(false);
  });

  it('keeps a null recency out of the counts', () => {
    // The facet can report a bucket it cannot date; that is not a reason to drop the
    // operation, only a reason not to claim when it last ran.
    const v = deriveOperationHealth({
      ...base,
      observed: [{ operation: 'a/b', count: 5, lastSeen: null }],
    });
    expect(v.rows[0]).toMatchObject({ events: 5, lastSeen: null, refusals: 0 });
  });
});
