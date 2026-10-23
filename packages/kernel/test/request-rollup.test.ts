import { describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { runPlatformSweep, type PlatformSweepOptions, type RequestRollupSweepOptions } from '../src/platform-sweep.js';
import {
  REQUEST_ROLLUP_DAYS_PER_PASS,
  REQUEST_ROLLUP_PRUNE_BATCH,
  requestRollupDueDays,
  requestRollupHorizon,
  type RequestDayCount,
  type RequestDayReadInput,
} from '../src/request-rollup.js';
import { BILLING_ROLLUP_RETENTION_MONTHS, utcDayMonthsBefore } from '../src/billing-retention.js';
import type { FetchLike, ScopeHost } from '../src/scope-host.js';

/**
 * The daily request rollup (#2501), with fakes: which days a pass reads, and what it does with a
 * day whose read fails. The directory half (the rows, the prune) is held on both real adapters by
 * the contract suite; this holds the rules, each with its positive twin.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

describe('the days a pass reads', () => {
  const due = (nowIso: string, reads: { day: string; attemptedAt: string; readAt: string | null }[] = [], horizon: string | null = null) =>
    requestRollupDueDays({ nowMs: at(nowIso), reads, lookbackDays: 3, settleMs: HOUR, retryMs: HOUR, horizon });

  it('reads every closed day in the lookback, oldest first, once it has settled', () => {
    // At 00:30 yesterday has ended but not settled: the last day read is the day before.
    expect(due('2026-10-23T00:30:00.000Z')).toEqual(['2026-10-20', '2026-10-21']);
    // Its positive twin: at 01:00 yesterday has settled too.
    expect(due('2026-10-23T01:00:00.000Z')).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  it('never reads a day again once a read succeeded', () => {
    const reads = [{ day: '2026-10-21', attemptedAt: '2026-10-22T02:00:00.000Z', readAt: '2026-10-22T02:00:00.000Z' }];
    expect(due('2026-10-23T12:00:00.000Z', reads)).toEqual(['2026-10-20', '2026-10-22']);
  });

  it('retries a failed day an hour after its last attempt, not before', () => {
    const failed = [{ day: '2026-10-22', attemptedAt: '2026-10-23T11:00:00.000Z', readAt: null }];
    expect(due('2026-10-23T11:59:59.999Z', failed)).toEqual(['2026-10-20', '2026-10-21']);
    expect(due('2026-10-23T12:00:00.000Z', failed)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  it('reads no day before the retention horizon, so a prune and the rollup never take turns', () => {
    expect(due('2026-10-23T12:00:00.000Z', [], '2026-10-21')).toEqual(['2026-10-21', '2026-10-22']);
    expect(due('2026-10-23T12:00:00.000Z', [], '2026-10-01')).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });
});

describe('the billing retention horizon', () => {
  it('keeps everything by default, until a horizon is set', () => {
    expect(BILLING_ROLLUP_RETENTION_MONTHS).toBeNull();
    expect(requestRollupHorizon(at('2026-10-23T12:00:00.000Z'), null)).toBeNull();
  });

  it('counts whole calendar months back, clamping to the shorter month', () => {
    expect(requestRollupHorizon(at('2026-10-23T12:00:00.000Z'), 13)).toBe('2025-09-23');
    expect(utcDayMonthsBefore(at('2026-03-31T00:00:00.000Z'), 1)).toBe('2026-02-28');
    expect(utcDayMonthsBefore(at('2028-03-31T00:00:00.000Z'), 1)).toBe('2028-02-29');
  });

  it('refuses a horizon that is not a whole number of months, at least one', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => requestRollupHorizon(0, bad)).toThrow(/whole number of months/);
    }
    expect(requestRollupHorizon(0, 1)).toBe('1969-12-01');
  });
});

/** One day of the rollup's record, as the in-memory directory below keeps it. */
interface ReadRow {
  day: string;
  attemptedAt: string;
  readAt: string | null;
  rows: number | null;
  error: string | null;
}

/** A directory that keeps the rollup's ledger in memory, as `recordRequestDayRows` would. */
function rollupHost(opts: { rollup?: boolean; failRecord?: boolean } = {}) {
  const reads = new Map<string, ReadRow>();
  const recorded: RequestDayReadInput[] = [];
  const pruned: { limit: number; months: number | null }[] = [];
  const admin: Record<string, unknown> = {
    listScopes: async () => [],
    listConnections: async () => [],
  };
  if (opts.rollup !== false) {
    admin.listRequestRollupDays = async () => [...reads.values()];
    admin.recordRequestDay = async (_a: unknown, input: RequestDayReadInput) => {
      if (opts.failRecord && 'counts' in input) throw new Error('directory unavailable');
      recorded.push(input);
      const prior = reads.get(input.day);
      if ('error' in input) {
        reads.set(input.day, { day: input.day, attemptedAt: input.attemptedAt, readAt: prior?.readAt ?? null, rows: prior?.rows ?? null, error: input.error });
        return { recorded: 0 };
      }
      reads.set(input.day, { day: input.day, attemptedAt: input.attemptedAt, readAt: input.attemptedAt, rows: input.counts.length, error: null });
      return { recorded: input.counts.length };
    };
    admin.pruneRequestDays = async (_a: unknown, limit: number, months: number | null) => {
      pruned.push({ limit, months });
      return 0;
    };
  }
  const host = { admin, drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }) } as unknown as ScopeHost;
  return { host, reads, recorded, pruned };
}

const sweep = (host: ScopeHost, rollup: RequestRollupSweepOptions, extra: Partial<PlatformSweepOptions> = {}) =>
  runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false, requestRollup: rollup, ...extra });

const count = (requests: number): RequestDayCount => ({
  tenantId: '01J00000000000000000000T01',
  vertical: 'todo',
  scopeId: '01J00000000000000000000S01',
  requests,
  sampled: false,
});

describe('the request-rollup phase', () => {
  const NOW = '2026-10-23T12:00:00.000Z';

  it('reads the oldest due days first, at most the batch, and the rest on the next pass', async () => {
    const { host, reads } = rollupHost();
    const asked: string[] = [];
    const read = async (day: string) => {
      asked.push(day);
      return [count(asked.length)];
    };
    const options = { read, batch: 2, lookbackDays: 4, now: () => NOW };

    const first = await sweep(host, options);
    expect(asked).toEqual(['2026-10-19', '2026-10-20']);
    expect(first.requestRollup).toEqual({ due: 4, deferred: 2, read: 2, failed: 0, recorded: 2, pruned: 0 });
    expect(first.errors).toEqual([]);

    const second = await sweep(host, options);
    expect(asked).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    expect(second.requestRollup).toMatchObject({ due: 2, deferred: 0, read: 2 });

    // Every day in the window is rolled up: nothing is read twice.
    const third = await sweep(host, options);
    expect(asked).toHaveLength(4);
    expect(third.requestRollup).toMatchObject({ due: 0, read: 0 });
    expect([...reads.values()].every((r) => r.readAt !== null)).toBe(true);
  });

  it('records a failed day as its attempt and writes nothing of it, then retries it an hour later', async () => {
    const { host, reads, recorded } = rollupHost();
    let saturated = true;
    const read = async () => {
      // A saturated query cannot answer the whole day, so the reader refuses it rather than
      // handing back the part it got.
      if (saturated) throw new Error('Cloudflare Analytics Engine request rollup saturated at 50000 rows');
      return [count(7)];
    };
    const options = (now: string) => ({ read, lookbackDays: 1, now: () => now });

    const failed = await sweep(host, options(NOW));
    expect(failed.requestRollup).toMatchObject({ due: 1, read: 0, failed: 1, recorded: 0 });
    expect(failed.errors).toEqual([{ kind: 'request-rollup', id: '2026-10-22', error: expect.stringMatching(/saturated/) }]);
    expect(recorded).toEqual([{ day: '2026-10-22', attemptedAt: NOW, error: expect.stringMatching(/saturated/) }]);
    expect(reads.get('2026-10-22')).toMatchObject({ readAt: null, error: expect.stringMatching(/saturated/) });

    // Within the hour the day is not tried again, so a standing failure is not every pass's error.
    saturated = false;
    const soon = await sweep(host, options('2026-10-23T12:59:59.000Z'));
    expect(soon.requestRollup).toMatchObject({ due: 0, read: 0, failed: 0 });
    expect(soon.errors).toEqual([]);

    // Its positive twin: an hour on, the day is read and recorded.
    const later = await sweep(host, options('2026-10-23T13:00:00.000Z'));
    expect(later.requestRollup).toMatchObject({ due: 1, read: 1, failed: 0, recorded: 1 });
    expect(reads.get('2026-10-22')).toMatchObject({ readAt: '2026-10-23T13:00:00.000Z', error: null });
  });

  it('counts a day whose counts the directory refused as failed, and records the refusal', async () => {
    const { host, reads } = rollupHost({ failRecord: true });
    const report = await sweep(host, { read: async () => [count(1)], lookbackDays: 1, now: () => NOW });
    expect(report.requestRollup).toMatchObject({ read: 0, failed: 1, recorded: 0 });
    expect(report.errors).toEqual([{ kind: 'request-rollup', id: '2026-10-22', error: 'directory unavailable' }]);
    expect(reads.get('2026-10-22')).toMatchObject({ readAt: null, error: 'directory unavailable' });
  });

  it('prunes with the billing retention by default, and with an explicit one when given', async () => {
    const { host, pruned } = rollupHost();
    await sweep(host, { read: async () => [], lookbackDays: 1, now: () => NOW });
    expect(pruned).toEqual([{ limit: REQUEST_ROLLUP_PRUNE_BATCH, months: BILLING_ROLLUP_RETENTION_MONTHS }]);
    await sweep(host, { read: async () => [], lookbackDays: 1, retentionMonths: 24, pruneBatch: 10, now: () => NOW });
    expect(pruned[1]).toEqual({ limit: 10, months: 24 });
  });

  it('pauses reading at batch 0 and still prunes', async () => {
    const { host, pruned } = rollupHost();
    const asked: string[] = [];
    const report = await sweep(host, { read: async (d) => (asked.push(d), []), batch: 0, now: () => NOW });
    expect(asked).toEqual([]);
    expect(report.requestRollup).toMatchObject({ due: 0, read: 0 });
    expect(pruned).toHaveLength(1);
  });

  it('defaults to a week of days per pass', async () => {
    const { host } = rollupHost();
    const report = await sweep(host, { read: async () => [], now: () => NOW });
    expect(report.requestRollup).toMatchObject({ read: REQUEST_ROLLUP_DAYS_PER_PASS });
  });

  it('is skipped when the phase is not configured, or the host predates the rollup', async () => {
    expect((await sweep(rollupHost().host, undefined as never)).requestRollup).toBeNull();
    const asked: string[] = [];
    const old = await sweep(rollupHost({ rollup: false }).host, { read: async (d) => (asked.push(d), []), now: () => NOW });
    expect(old.requestRollup).toBeNull();
    expect(asked).toEqual([]);
  });

  it('refuses a misconfigured pass before any phase runs', async () => {
    const { host } = rollupHost();
    const read = async () => [];
    await expect(sweep(host, { read, batch: -1 })).rejects.toThrow(/requestRollup\.batch/);
    await expect(sweep(host, { read, pruneBatch: 0 })).rejects.toThrow(/requestRollup\.pruneBatch/);
    await expect(sweep(host, { read, retentionMonths: 0 })).rejects.toThrow(/requestRollup\.retentionMonths/);
    await expect(sweep(host, { read, retentionMonths: null, batch: 0 })).resolves.toMatchObject({ errors: [] });
  });
});
