import { describe, expect, it } from 'vitest';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { runPlatformSweep, type PlatformSweepOptions, type RequestRollupSweepOptions } from '../src/platform-sweep.js';
import {
  REQUEST_ROLLUP_DAYS_PER_PASS,
  REQUEST_ROLLUP_MAX_LOOKBACK_DAYS,
  REQUEST_ROLLUP_PRUNE_BATCH,
  RequestRollupSaturated,
  requestRollupDueDays,
  readTenantRequestMeterRows,
  type RequestDayCount,
  type RequestDayReadInput,
} from '../src/request-rollup.js';
import { BILLING_ROLLUP_RETENTION_MONTHS, billingRollupHorizon, utcDayMonthsBefore } from '../src/billing-retention.js';
import type { FetchLike } from '../src/connector-transport.js';
import type { ScopeHost } from '../src/scope-host.js';

/**
 * The daily request rollup (#2501), with fakes: which days a pass reads, and what it does with a
 * day whose read fails. The directory half (the rows, the prune) is held on both real adapters by
 * the contract suite; this holds the rules, each with its positive twin.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
const HOUR = 3_600_000;

it('projects and caps the tenant request meter read at 10,000 rows', () => {
  let statement = '';
  let params: readonly (string | number | null)[] = [];
  const tenant = tenantId.parse('01JZ00000000000000000000SV');
  const rows = readTenantRequestMeterRows((sql, args) => {
    statement = sql;
    params = args;
    return [];
  }, tenant, '2026-09-01', '2026-09-30', 20_000);
  expect(rows).toEqual([]);
  expect(params).toEqual([tenant, '2026-09-01', '2026-09-30', 10_000]);
  expect(statement).toMatch(/substr\(vertical, 1, 64\)/);
  expect(statement).not.toMatch(/SELECT \*/);
});
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

  it('at the lookback cap, the first day read starts within 89 days, the shortest three months, at any hour', () => {
    expect(REQUEST_ROLLUP_MAX_LOOKBACK_DAYS).toBe(88);
    const startsAgo = (nowIso: string, lookbackDays: number) => {
      const first = requestRollupDueDays({ nowMs: at(nowIso), reads: [], lookbackDays, settleMs: HOUR, retryMs: HOUR, horizon: null })[0]!;
      return (at(nowIso) - at(`${first}T00:00:00.000Z`)) / 86_400_000;
    };
    for (const nowIso of ['2026-10-23T00:00:00.000Z', '2026-10-23T20:00:00.000Z', '2026-10-23T23:59:59.999Z']) {
      expect(startsAgo(nowIso, REQUEST_ROLLUP_MAX_LOOKBACK_DAYS)).toBeLessThan(89);
    }
    // Its twin: one day more, and a late pass's first day began more than 89 days back.
    expect(startsAgo('2026-10-23T20:00:00.000Z', REQUEST_ROLLUP_MAX_LOOKBACK_DAYS + 1)).toBeGreaterThan(89);
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
    expect(billingRollupHorizon(at('2026-10-23T12:00:00.000Z'), null)).toBeNull();
  });

  it('counts whole calendar months back, clamping to the shorter month', () => {
    expect(billingRollupHorizon(at('2026-10-23T12:00:00.000Z'), 13)).toBe('2025-09-23');
    expect(utcDayMonthsBefore(at('2026-03-31T00:00:00.000Z'), 1)).toBe('2026-02-28');
    expect(utcDayMonthsBefore(at('2028-03-31T00:00:00.000Z'), 1)).toBe('2028-02-29');
  });

  it('refuses a horizon that is not a whole number of months, at least one', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => billingRollupHorizon(0, bad)).toThrow(/whole number of months/);
    }
    expect(billingRollupHorizon(0, 1)).toBe('1969-12-01');
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
  failingSince: string | null;
  failingCount: number | null;
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
          failingSince: input.saturated ? null : input.failingSince ?? input.attemptedAt,
          failingCount: input.saturated ? null : input.failingCount ?? 1,
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
        failingSince: null,
        failingCount: null,
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
    expect(first.requestRollup).toEqual({
      due: 4,
      deferred: 2,
      read: 2,
      failed: 0,
      repeated: 0,
      streak: null,
      saturated: 0,
      saturatedDays: [],
      recorded: 2,
      pruned: 0,
    });
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
    // The attempt starts a run of one, which is what the pass's log line would show.
    expect(recorded).toEqual([
      { day: '2026-10-22', attemptedAt: NOW, error: expect.stringMatching(/saturated/), failingSince: NOW, failingCount: 1 },
    ]);
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
    // The run is on every pass's report, with its start and its length, though only the first
    // pass mailed it: that is what the pass's log line shows while it lasts.
    expect(passes.map((p) => p.rollup?.streak?.failures)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(passes.every((p) => p.rollup?.streak?.since === at(0))).toBe(true);
    expect(passes[11]!.rollup?.streak?.error).toMatch(/HTTP 403/);
    // Every attempt is still recorded, so the ledger shows the failure throughout. The hour's
    // retry spacing cycles them over four days: the oldest is due again on the fifth pass.
    expect(recorded.filter((r) => 'error' in r)).toHaveLength(12);
    expect(new Set(recorded.map((r) => r.day)).size).toBe(4);

    // A read that succeeds ends the streak, and the batch goes on past it.
    failing = false;
    const recovered = await sweep(host, { read, now: () => at(12) });
    expect(recovered.errors).toEqual([]);
    expect(recovered.requestRollup).toMatchObject({ read: 7, failed: 0, repeated: 0, streak: null });
    // So the same failure afterwards is a new streak, and is reported again.
    failing = true;
    const again = await sweep(host, { read, now: () => at(13) });
    expect(again.errors).toEqual([{ kind: 'request-rollup', id: expect.any(String), error: expect.stringMatching(/HTTP 403/) }]);
    expect(again.requestRollup).toMatchObject({ failed: 1, repeated: 0, streak: { since: at(13), failures: 1 } });
  });

  it('keeps a standing failure on the report between its hourly retries, without an attempt or a digest entry', async () => {
    const { host, recorded } = rollupHost();
    let error: string | null = 'Cloudflare Analytics Engine query failed: HTTP 403 Authentication error';
    let asked = 0;
    const read = async () => {
      asked += 1;
      if (error !== null) throw new Error(error);
      return [count(1)];
    };
    // Once the backfill is done at most one day is due: a pass every fifteen minutes retries it
    // only once an hour, so three passes in four have nothing to read.
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 15 * 60_000).toISOString();
    const pass = async (n: number) => {
      const before = asked;
      const report = await sweep(host, { read, lookbackDays: 1, now: () => at(n) });
      return { asked: asked - before, errors: report.errors, rollup: report.requestRollup! };
    };
    const passes = [];
    for (let n = 0; n < 5; n++) passes.push(await pass(n));
    expect(passes.map((p) => p.asked)).toEqual([1, 0, 0, 0, 1]);
    // The run is on every pass, its start pass zero's, its length the attempts actually made.
    expect(passes.map((p) => p.rollup.streak?.failures ?? null)).toEqual([1, 1, 1, 1, 2]);
    expect(passes.every((p) => p.rollup.streak?.since === at(0) && p.rollup.streak.error === error)).toBe(true);
    // Mailed once, when it began; the passes between retries add no attempt and no digest entry.
    expect(passes.map((p) => p.errors.length)).toEqual([1, 0, 0, 0, 0]);
    expect(passes.map((p) => [p.rollup.failed, p.rollup.repeated])).toEqual([[1, 0], [0, 0], [0, 0], [0, 0], [1, 1]]);
    expect(recorded).toHaveLength(2);

    // A different error at the next retry is a new run, mailed once, and the passes after it carry
    // that run, not the old one.
    error = 'the request rollup read took longer than 30000 ms';
    const between = [];
    for (let n = 5; n < 9; n++) between.push(await pass(n));
    expect(between.map((p) => p.asked)).toEqual([0, 0, 0, 1]);
    expect(between.map((p) => p.errors.length)).toEqual([0, 0, 0, 1]);
    // Until then, the old run as the ledger holds it: its start, and both attempts.
    expect(between.slice(0, 3).map((p) => p.rollup.streak)).toEqual(
      Array(3).fill({ error: 'Cloudflare Analytics Engine query failed: HTTP 403 Authentication error', since: at(0), failures: 2 }),
    );
    expect(between[3]!.rollup.streak).toEqual({ error, since: at(8), failures: 1 });
    const after = await pass(9);
    expect(after.errors).toEqual([]);
    expect(after.rollup.streak).toEqual({ error, since: at(8), failures: 1 });

    // A read that succeeds ends the run: off the report on that pass and on the quiet passes after.
    error = null;
    const recovered = [];
    for (let n = 10; n < 14; n++) recovered.push(await pass(n));
    expect(recovered.map((p) => p.asked)).toEqual([0, 0, 1, 0]);
    expect(recovered.map((p) => p.rollup.streak)).toEqual([
      { error: 'the request rollup read took longer than 30000 ms', since: at(8), failures: 1 },
      { error: 'the request rollup read took longer than 30000 ms', since: at(8), failures: 1 },
      null,
      null,
    ]);
    expect(recovered.every((p) => p.errors.length === 0)).toBe(true);
  });

  it('carries no run onto the report of a pass when no attempt has failed', async () => {
    const { host } = rollupHost();
    const read = async () => [count(1)];
    const first = await sweep(host, { read, lookbackDays: 1, now: () => NOW });
    expect(first.requestRollup).toMatchObject({ read: 1, streak: null });
    const quiet = await sweep(host, { read, lookbackDays: 1, now: () => '2026-10-23T12:15:00.000Z' });
    expect(quiet.requestRollup).toMatchObject({ due: 0, read: 0, failed: 0, streak: null });
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

  it('a read that succeeds inside a pass ends the run, so the same error after it is a new run, and reported', async () => {
    const { host } = rollupHost();
    const asked: string[] = [];
    const read = async (day: string) => {
      asked.push(day);
      // Pass one fails its only day; pass two reads one day, then meets the same error again.
      if (asked.length === 1 || asked.length === 3) throw new Error('HTTP 403');
      return [count(1)];
    };
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 15 * 60_000).toISOString();
    expect((await sweep(host, { read, lookbackDays: 3, now: () => at(0) })).errors).toHaveLength(1);
    const second = await sweep(host, { read, lookbackDays: 3, now: () => at(1) });
    expect(asked).toHaveLength(3);
    expect(second.errors).toEqual([{ kind: 'request-rollup', id: asked[2], error: 'HTTP 403' }]);
    expect(second.requestRollup).toMatchObject({ read: 1, failed: 1, repeated: 0, streak: { since: at(1), failures: 1 } });
  });

  it('a saturated day that is the newest attempt from an earlier pass does not break the run of failures', async () => {
    const { host } = rollupHost();
    const asked: string[] = [];
    const read = async (day: string) => {
      asked.push(day);
      if (asked.length === 2) throw new RequestRollupSaturated('more than 50000 groups');
      throw new Error('HTTP 403');
    };
    const at = (pass: number) => new Date(Date.parse(NOW) + pass * 15 * 60_000).toISOString();
    // Pass one: the 403 starts a run. Pass two reads one day only, which is saturated, so the
    // newest attempt on record is now that saturated day.
    expect((await sweep(host, { read, lookbackDays: 3, now: () => at(0) })).errors).toHaveLength(1);
    expect((await sweep(host, { read, lookbackDays: 3, batch: 1, now: () => at(1) })).requestRollup).toMatchObject({ saturated: 1 });
    // Pass three meets the 403 again: the same run, so it is counted, not mailed again, and its
    // start is still pass one's.
    const third = await sweep(host, { read, lookbackDays: 3, now: () => at(2) });
    expect(asked).toHaveLength(3);
    expect(third.errors).toEqual([]);
    expect(third.requestRollup).toMatchObject({ failed: 1, repeated: 1, streak: { since: at(0), failures: 2 } });
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
