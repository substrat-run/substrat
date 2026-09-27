import { describe, expect, it } from 'vitest';
import { platformRequestBacklog, sweepRunEntry, sweepRunsPayload } from '../src/index.js';

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

  it('still accepts the schedule entry beside it — the refusal is the kind, not the batch', () => {
    const parsed = sweepRunsPayload.safeParse({ version: null, entries: [{ kind: 'schedule', operation: 'm/tick', outcome: 'ok', at }] });
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
    const totals = { scopes: 2, drained: 5, done: 3, failed: 0, pending: 2, skipped: 0, unreachable: 0 };
    expect(sweepRunEntry.parse({ ...base, kind: 'platform-request', platformRequests: totals }).platformRequests).toEqual(totals);
  });

  it('refuses a negative count — the column is parsed, not trusted', () => {
    const totals = { scopes: 0, drained: 0, done: 0, failed: 0, pending: -1, skipped: 0, unreachable: 0 };
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
