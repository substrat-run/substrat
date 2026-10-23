import { describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { runPlatformSweep, type PlatformSweepOptions, type RequestRollupSweepOptions } from '../src/platform-sweep.js';
import {
  REQUEST_ROLLUP_DAYS_PER_PASS,
  REQUEST_ROLLUP_MAX_LOOKBACK_DAYS,
  REQUEST_ROLLUP_PRUNE_BATCH,
  RequestRollupSaturated,
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
  const due = (
    nowIso: string,
    reads: { day: string; attemptedAt: string; readAt: string | null; saturated?: boolean }[] = [],
    horizon: string | null = null,
  ) =>
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

  it('never reads a saturated day again, however long ago it was tried', () => {
    const saturated = [{ day: '2026-10-21', attemptedAt: '2026-10-22T02:00:00.000Z', readAt: null, saturated: true }];
    expect(due('2026-10-23T12:00:00.000Z', saturated)).toEqual(['2026-10-20', '2026-10-22']);
    // Its twin: the same attempt, failed but not saturated, is due again.
    expect(due('2026-10-23T12:00:00.000Z', [{ ...saturated[0]!, saturated: false }])).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
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
  saturated: boolean;
}

/** A directory that keeps the rollup's ledger in memory, as `recordRequestDayRows` would. */
function rollupHost(opts: { rollup?: boolean; failRecord?: boolean; order?: string[] } = {}) {
  const reads = new Map<string, ReadRow>();
  const recorded: RequestDayReadInput[] = [];
  const pruned: { limit: number; months: number | null }[] = [];
  const admin: Record<string, unknown> = {
    listScopes: async () => [],
    listConnections: async () => [],
    // Other phases of the same pass, so a test can see what ran before and after the rollup.
    pruneTelemetry: async () => {
      opts.order?.push('telemetry');
      return { opsFailures: 0, issues: 0, sweepRuns: 0 };
    },
    accessLog: async () => {
      opts.order?.push('access-log');
      return [];
    },
    pruneAccessLog: async () => 0,
  };
  if (opts.rollup !== false) {
    admin.listRequestRollupDays = async () => [...reads.values()];
    admin.recordRequestDay = async (_a: unknown, input: RequestDayReadInput) => {
      if (opts.failRecord && 'counts' in input) throw new Error('directory unavailable');
      recorded.push(input);
      const prior = reads.get(input.day);
      if ('error' in input) {
        reads.set(input.day, {
          day: input.day,
          attemptedAt: input.attemptedAt,
          readAt: prior?.readAt ?? null,
          rows: prior?.rows ?? null,
          error: input.error,
          saturated: input.saturated === true,
        });
        return { recorded: 0 };
      }
      reads.set(input.day, {
        day: input.day,
        attemptedAt: input.attemptedAt,
        readAt: input.attemptedAt,
        rows: input.counts.length,
        error: null,
        saturated: false,
      });
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
  class2xx: requests,
  class3xx: 0,
  class4xx: 0,
  class5xx: 0,
  rateLimited: 0,
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
    expect(first.requestRollup).toEqual({ due: 4, deferred: 2, read: 2, failed: 0, repeated: 0, saturated: 0, recorded: 2, pruned: 0 });
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

  it('ends the pass at the first failed read, and reports a standing failure once per streak', async () => {
    const { host, recorded } = rollupHost();
    let failing = true;
    const asked: string[] = [];
    const read = async (day: string) => {
      asked.push(day);
      if (failing) throw new Error('Cloudflare Analytics Engine query failed: HTTP 403 Authentication error');
      return [count(1)];
    };
    // A pass every fifteen minutes, with the defaults, against a credential that cannot read.
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 15 * 60_000).toISOString();
    const passes = [];
    for (let pass = 0; pass < 12; pass++) {
      const before = asked.length;
      const report = await sweep(host, { read, now: () => at(pass) });
      passes.push({ asked: asked.length - before, errors: report.errors.length, rollup: report.requestRollup });
    }
    // One query a pass, never a batch of seven.
    expect(passes.map((p) => p.asked)).toEqual(Array(12).fill(1));
    // In the digest once, when the streak began; counted, not mailed, on the eleven passes after.
    expect(passes.map((p) => p.errors)).toEqual([1, ...Array(11).fill(0)]);
    expect(passes.slice(1).every((p) => p.rollup?.failed === 1 && p.rollup.repeated === 1)).toBe(true);
    // Every attempt is still recorded, so the ledger shows the failure throughout. The hour's
    // retry spacing cycles them over four days: the oldest is due again on the fifth pass.
    expect(recorded.filter((r) => 'error' in r)).toHaveLength(12);
    expect(new Set(recorded.map((r) => r.day)).size).toBe(4);

    // A read that succeeds ends the streak, and the batch goes on past it.
    failing = false;
    const recovered = await sweep(host, { read, now: () => at(12) });
    expect(recovered.errors).toEqual([]);
    expect(recovered.requestRollup).toMatchObject({ read: 7, failed: 0, repeated: 0 });
    // So the same failure afterwards is a new streak, and is reported again.
    failing = true;
    const again = await sweep(host, { read, now: () => at(13) });
    expect(again.errors).toEqual([{ kind: 'request-rollup', id: expect.any(String), error: expect.stringMatching(/HTTP 403/) }]);
    expect(again.requestRollup).toMatchObject({ failed: 1, repeated: 0 });
  });

  it('records a saturated day as such and goes on: it never freezes the days after it, and is not read again', async () => {
    const { host, reads } = rollupHost();
    const asked: string[] = [];
    const read = async (day: string) => {
      asked.push(day);
      if (day === '2026-10-20' || day === '2026-10-21') throw new RequestRollupSaturated(`more than 50000 groups for ${day}`);
      return [count(1)];
    };
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 2 * 3_600_000).toISOString();

    const first = await sweep(host, { read, lookbackDays: 4, now: () => at(0) });
    // Both saturated days are passed over, and the days around them are rolled up.
    expect(asked).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    expect(first.requestRollup).toMatchObject({ read: 2, failed: 0, saturated: 2 });
    // Visible: on each day's record, and in the digest once, as one entry for the pass.
    expect(reads.get('2026-10-20')).toMatchObject({ readAt: null, saturated: true, error: expect.stringMatching(/more than 50000/) });
    expect(first.errors).toEqual([
      {
        kind: 'request-rollup',
        id: 'saturated',
        error: '2 day(s) hold more groups than one read answers and are kept unread: 2026-10-20, 2026-10-21',
      },
    ]);

    // Two hours on, long past the retry: the saturated days are not asked again, the new day is.
    const next = await sweep(host, { read, lookbackDays: 4, now: () => at(12) });
    expect(asked.slice(4)).toEqual(['2026-10-23']);
    expect(next.errors).toEqual([]);
  });

  it('does not count a saturated day as the streak of an ordinary failure', async () => {
    const { host } = rollupHost();
    const read = async (day: string) => {
      if (day === '2026-10-21') throw new RequestRollupSaturated('more than 50000 groups');
      throw new Error('HTTP 403');
    };
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 15 * 60_000).toISOString();
    // Pass one: the 403 starts a streak and is reported.
    expect((await sweep(host, { read, lookbackDays: 3, now: () => at(0) })).errors).toHaveLength(1);
    // Pass two finds the saturated day before the 403 again: the saturation is reported, and the
    // 403 is still the same streak, so it is not.
    const second = await sweep(host, { read, lookbackDays: 3, now: () => at(1) });
    expect(second.errors.map((e) => e.id)).toEqual(['saturated']);
    expect(second.requestRollup).toMatchObject({ saturated: 1, failed: 1, repeated: 1 });
  });

  it('reports a different failure as a new streak', async () => {
    const { host } = rollupHost();
    let error = 'HTTP 403';
    const read = async () => {
      throw new Error(error);
    };
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 15 * 60_000).toISOString();
    expect((await sweep(host, { read, now: () => at(0) })).errors).toHaveLength(1);
    expect((await sweep(host, { read, now: () => at(1) })).errors).toHaveLength(0);
    error = 'the request rollup read took longer than 30000 ms';
    expect((await sweep(host, { read, now: () => at(2) })).errors).toEqual([
      { kind: 'request-rollup', id: expect.any(String), error },
    ]);
  });

  it('runs after the scheduled work and before the access-log drain, and a read that never settles fails its day without holding the pass', async () => {
    const order: string[] = [];
    const { host, reads, pruned } = rollupHost({ order });
    const report = await sweep(
      host,
      {
        read: () => {
          order.push('read');
          return new Promise<never>(() => {});
        },
        lookbackDays: 1,
        readTimeoutMs: 20,
        now: () => NOW,
      },
      { accessLogSink: { ship: async () => ({ ref: 'r' }) } },
    );
    // The scheduled work ran first, so a stalled read cannot starve it; the drain runs after the
    // bounded read, so it still runs, and ships this pass's own access rows.
    expect(order).toEqual(['telemetry', 'read', 'access-log']);
    expect(report.telemetry).toEqual({ opsFailures: 0, issues: 0, sweepRuns: 0 });
    expect(report.accessLog).toEqual({ shipped: 0, marked: 0, pruned: 0, ref: null });
    // The stalled read is an ordinary failed day: recorded, retried later, and the phase's own
    // prune still ran after it.
    expect(report.requestRollup).toMatchObject({ read: 0, failed: 1 });
    expect(reads.get('2026-10-22')).toMatchObject({ readAt: null, error: 'the request rollup read took longer than 20 ms' });
    expect(pruned).toHaveLength(1);
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
    // A lookback past what Analytics Engine keeps would record aged-out days as days without
    // traffic; a negative settle would read and freeze the open day.
    for (const lookbackDays of [0, -1, 2.5, REQUEST_ROLLUP_MAX_LOOKBACK_DAYS + 1, Number.NaN]) {
      await expect(sweep(host, { read, lookbackDays })).rejects.toThrow(/requestRollup\.lookbackDays/);
    }
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(sweep(host, { read, settleMs: ms })).rejects.toThrow(/requestRollup\.settleMs/);
      await expect(sweep(host, { read, retryMs: ms })).rejects.toThrow(/requestRollup\.retryMs/);
    }
    for (const readTimeoutMs of [0, -5, Number.NaN]) {
      await expect(sweep(host, { read, readTimeoutMs })).rejects.toThrow(/requestRollup\.readTimeoutMs/);
    }
    // Their positive twins: the edges that are allowed run.
    await expect(
      sweep(host, { read, lookbackDays: REQUEST_ROLLUP_MAX_LOOKBACK_DAYS, settleMs: 0, retryMs: 0, readTimeoutMs: 1, batch: 0 }),
    ).resolves.toMatchObject({ errors: [] });
    await expect(sweep(host, { read, lookbackDays: 1, batch: 0 })).resolves.toMatchObject({ errors: [] });
  });
});
