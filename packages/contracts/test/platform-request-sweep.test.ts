import { describe, expect, it } from 'vitest';
import { platformRequestBacklog, sweepRunEntry, sweepRunKind, sweepRunsPayload } from '../src/index.js';

/**
 * #1840 — the platform-intent drain's fleet-wide sweep row. Its `pending` is what the
 * console reads as "how many are waiting", so the one thing a scope must never do is
 * write it: a batch drained from ONE scope claiming the `platform-request` kind would be
 * that scope writing the fleet's number.
 */
describe('sweep runs: the fleet drain row is the platform\'s, never a scope batch\'s (#1840)', () => {
  const at = '2026-09-27T00:00:00.000Z';

  it('refuses a scope-drained platform-request entry', () => {
    const parsed = sweepRunsPayload.safeParse({ version: null, entries: [{ kind: 'platform-request', outcome: 'ok', at }] });
    expect(parsed.success).toBe(false);
  });

  it('a schedule-only batch still parses — the refusal is the kind, not the road', () => {
    const parsed = sweepRunsPayload.safeParse({ version: null, entries: [{ kind: 'schedule', operation: 'm/tick', outcome: 'ok', at }] });
    expect(parsed.success).toBe(true);
  });

  it('a mixed batch carrying one platform-request entry is refused whole — nothing in it lands', () => {
    const parsed = sweepRunsPayload.safeParse({
      version: null,
      entries: [
        { kind: 'platform-request', outcome: 'ok', at },
        { kind: 'schedule', operation: 'm/tick', outcome: 'ok', at },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * #1851 — the refusal is an ALLOWLIST (schedule, freshness), not a list of the three kinds
 * known at the time: every other member of sweepRunKind is refused, including one added to
 * the enum after this test was written, so a sixth kind is refused by default rather than
 * silently accepted from a scope batch.
 */
describe('sweep runs payload: only schedule and freshness entries are accepted (#1851)', () => {
  const at = '2026-09-27T00:00:00.000Z';

  const entryFor = (kind: string) => {
    if (kind === 'schedule') return { kind, operation: 'm/tick', outcome: 'ok', at };
    if (kind === 'freshness') return { kind, eventType: 'm/event', outcome: 'ok', at };
    return { kind, outcome: 'ok', at };
  };

  for (const kind of sweepRunKind.options) {
    if (kind === 'schedule' || kind === 'freshness') continue;

    it(`refuses a scope-drained ${kind} entry`, () => {
      const parsed = sweepRunsPayload.safeParse({ version: null, entries: [entryFor(kind)] });
      expect(parsed.success).toBe(false);
    });
  }

  it('refuses a mixed batch of one refused kind alongside an otherwise-valid entry — the whole batch is refused', () => {
    const refused = sweepRunKind.options.find((kind) => kind !== 'schedule' && kind !== 'freshness')!;
    const parsed = sweepRunsPayload.safeParse({
      version: null,
      entries: [entryFor(refused), entryFor('freshness')],
    });
    expect(parsed.success).toBe(false);
  });

  it('a schedule-only batch parses', () => {
    const parsed = sweepRunsPayload.safeParse({ version: null, entries: [entryFor('schedule')] });
    expect(parsed.success).toBe(true);
  });

  it('a freshness-only batch parses', () => {
    const parsed = sweepRunsPayload.safeParse({ version: null, entries: [entryFor('freshness')] });
    expect(parsed.success).toBe(true);
  });
});

describe('sweepRunEntry.platformRequests (#1840)', () => {
  const base = {
    id: '01K00000000000000000000000',
    unit: 'fleet',
    outcome: 'ok',
    tenantId: null,
    scopeId: null,
    vertical: null,
    version: null,
    operation: null,
    eventType: null,
    observedAt: null,
    connectionId: null,
    error: null,
    elapsedMs: null,
    at: '2026-09-27T00:00:00.000Z',
  };

  it('carries the totals on a platform-request row', () => {
    const totals = { scopes: 2, drained: 5, done: 3, failed: 0, pending: 2, skipped: 0, unreachable: 0, unsettleable: 1 };
    expect(sweepRunEntry.parse({ ...base, kind: 'platform-request', platformRequests: totals }).platformRequests).toEqual(totals);
  });

  it('refuses a negative count — the column is parsed, not trusted', () => {
    const totals = { scopes: 0, drained: 0, done: 0, failed: 0, pending: -1, skipped: 0, unreachable: 0, unsettleable: 0 };
    expect(sweepRunEntry.safeParse({ ...base, kind: 'platform-request', platformRequests: totals }).success).toBe(false);
  });

  it('reads totals stored before skipped/unreachable existed as zeros', () => {
    const old = { scopes: 1, drained: 2, done: 1, failed: 0, pending: 1 };
    expect(sweepRunEntry.parse({ ...base, kind: 'platform-request', platformRequests: old }).platformRequests).toEqual({
      ...old,
      skipped: 0,
      unreachable: 0,
      unsettleable: 0,
    });
  });

  it('reads totals stored before unsettleable existed (#1637) as zero, the rest as stored', () => {
    const old = { scopes: 1, drained: 2, done: 1, failed: 0, pending: 1, skipped: 1, unreachable: 2 };
    expect(sweepRunEntry.parse({ ...base, kind: 'platform-request', platformRequests: old }).platformRequests).toEqual({
      ...old,
      unsettleable: 0,
    });
  });

  it('refuses a negative unsettleable count too', () => {
    const totals = { scopes: 0, drained: 0, done: 0, failed: 0, pending: 0, skipped: 0, unreachable: 0, unsettleable: -1 };
    expect(sweepRunEntry.safeParse({ ...base, kind: 'platform-request', platformRequests: totals }).success).toBe(false);
  });

  it('still parses a row written before the column existed', () => {
    expect(sweepRunEntry.parse({ ...base, kind: 'connector' }).platformRequests).toBeUndefined();
  });
});

describe('platformRequestBacklog.pending (#1840)', () => {
  const base = { total: 0, capped: false, since: '2026-09-20T00:00:00.000Z', windowDays: 7 };

  it('null is a legal answer — no pass on record', () => {
    expect(platformRequestBacklog.parse({ ...base, pending: null }).pending).toBeNull();
  });

  it('a count always carries its as-of', () => {
    expect(platformRequestBacklog.safeParse({ ...base, pending: { count: 0, floor: false } }).success).toBe(false);
    expect(platformRequestBacklog.safeParse({ ...base, pending: { count: 0, asOf: base.since, floor: false } }).success).toBe(true);
  });
});
