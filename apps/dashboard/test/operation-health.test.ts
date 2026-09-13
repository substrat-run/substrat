import { describe, expect, it } from 'vitest';
import { deriveOperationHealth } from '../src/operation-health.js';

const base = {
  observed: [] as { operation: string; count: number; lastSeen: string | null }[],
  observedComplete: true,
  denials: [] as { operation: string | null; at: string }[],
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
  });

  it('shows an operation that ONLY ever gets refused', () => {
    // The case a join would lose. A call refused at its first line emits nothing, so
    // the event facet has never heard of it — and it is exactly the operation somebody
    // is failing to call.
    const v = deriveOperationHealth({
      ...base,
      observed: [{ operation: 'billing/close', count: 10, lastSeen: '2026-09-01T00:00:00.000Z' }],
      denials: [
        { operation: 'billing/void', at: '2026-09-05T00:00:00.000Z' },
        { operation: 'billing/void', at: '2026-09-06T00:00:00.000Z' },
      ],
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
      denials: [{ operation: 'billing/close', at: '2026-09-05T00:00:00.000Z' }],
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ events: 10, refusals: 1, refusedOnly: false });
  });

  it('reports the denial window floor, because those rows drain rather than expire', () => {
    // THE honesty flag. `refusals: 0` means "none in what is still held", never "never
    // refused" — the log is a storage bound, not a retention promise, so a view that
    // omitted the floor would be inviting the wrong reading.
    const v = deriveOperationHealth({
      ...base,
      denials: [
        { operation: 'a/b', at: '2026-09-05T00:00:00.000Z' },
        { operation: 'a/b', at: '2026-09-02T00:00:00.000Z' },
      ],
    });
    expect(v.refusalsSince).toBe('2026-09-02T00:00:00.000Z');
  });

  it('has no floor to report when the log holds nothing', () => {
    expect(deriveOperationHealth(base).refusalsSince).toBeNull();
  });

  it('lets a denial with no operation move the floor without inventing a row', () => {
    // It is evidence about the log's extent, and not evidence about any operation.
    const v = deriveOperationHealth({
      ...base,
      denials: [{ operation: null, at: '2026-09-02T00:00:00.000Z' }],
    });
    expect(v.rows).toEqual([]);
    expect(v.refusalsSince).toBe('2026-09-02T00:00:00.000Z');
  });

  it('says UNKNOWN rather than zero for a refused operation when the facet was cut short', () => {
    // Zero means "the facet answered and this was not in it". A truncated facet did not
    // answer, and printing zero would turn a gap into a measurement.
    const v = deriveOperationHealth({
      ...base,
      observed: [],
      observedComplete: false,
      denials: [{ operation: 'billing/void', at: '2026-09-05T00:00:00.000Z' }],
    });
    expect(v.rows[0]!.events).toBeNull();
    expect(v.observedComplete).toBe(false);
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
