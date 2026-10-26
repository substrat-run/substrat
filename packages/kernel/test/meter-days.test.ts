import { describe, expect, it } from 'vitest';
import { instant, platformActorId, type ScopeStatus, type TenantId, type TenantStatus } from '@substrat-run/contracts';
import { runPlatformSweep, type MeterSnapshotSweepOptions, type PlatformSweepOptions } from '../src/platform-sweep.js';
import {
  METER_DAYS_PRUNE_BATCH,
  METER_SNAPSHOT_TIMEOUT_MS,
  meterDayRowsAt,
  recordMeterDayRows,
  type MeterDayTakeInput,
} from '../src/meter-days.js';
import { BILLING_ROLLUP_RETENTION_MONTHS } from '../src/billing-retention.js';
import type { FetchLike } from '../src/connector-transport.js';
import type { ScopeHost } from '../src/scope-host.js';

/**
 * The daily meter snapshot (#2501), with fakes: what a day's rows hold, and what a pass does with a
 * snapshot that fails. The directory half (the rows on both real adapters, the prune, the sweep
 * end to end) is held by the contract suite; this holds the rules, each with its positive twin.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
const T1 = '01J00000000000000000000T01' as TenantId;
const T2 = '01J00000000000000000000T02' as TenantId;
const T3 = '01J00000000000000000000T03' as TenantId;
const AT = instant.parse('2026-10-23T00:04:00.000Z');

const tenant = (tenantId: TenantId, status: TenantStatus = 'active') => ({ tenantId, slug: tenantId.toLowerCase(), status });
const scope = (tenantId: TenantId, status: ScopeStatus, vertical: string | null = 'crm') => ({ tenantId, status, vertical });
const counts = (c: Partial<{ total: number; active: number; suspended: number; provisioning: number; archived: number; reaped: number }>) => ({
  total: 0,
  active: 0,
  suspended: 0,
  provisioning: 0,
  archived: 0,
  reaped: 0,
  ...c,
});

describe("a day's rows", () => {
  it('count scopes by effective status, split by vertical with null first, and the split sums to the total', () => {
    const [row] = meterDayRowsAt(AT, {
      tenants: [tenant(T1)],
      scopes: [
        scope(T1, 'active', 'desk'),
        scope(T1, 'active'),
        scope(T1, 'archived'),
        scope(T1, 'provisioning', null),
        scope(T1, 'reaped', 'desk'),
      ],
      entitlements: [],
    });
    expect(row).toEqual({
      day: '2026-10-23',
      tenantId: T1,
      readAt: AT,
      status: 'active',
      billable: true,
      scopes: counts({ total: 5, active: 2, provisioning: 1, archived: 1, reaped: 1 }),
      verticals: [
        { vertical: null, ...counts({ total: 1, provisioning: 1 }) },
        { vertical: 'crm', ...counts({ total: 2, active: 1, archived: 1 }) },
        { vertical: 'desk', ...counts({ total: 2, active: 1, reaped: 1 }) },
      ],
      entitlements: [],
    });
  });

  it("count a suspended tenant's active scopes as suspended, in its verticals too, and bill nothing", () => {
    const [row] = meterDayRowsAt(AT, { tenants: [tenant(T1, 'suspended')], scopes: [scope(T1, 'active')], entitlements: [] });
    expect(row).toMatchObject({
      billable: false,
      scopes: counts({ total: 1, suspended: 1 }),
      verticals: [{ vertical: 'crm', ...counts({ total: 1, suspended: 1 }) }],
    });
    // Its positive twin: the same scope under an active tenant is active.
    const [twin] = meterDayRowsAt(AT, { tenants: [tenant(T1)], scopes: [scope(T1, 'active')], entitlements: [] });
    expect(twin).toMatchObject({ billable: true, scopes: counts({ total: 1, active: 1 }) });
  });

  it('decide every grant at the instant: lapsed at it, live a millisecond after, perpetual live; ordered by key then plan', () => {
    const [row] = meterDayRowsAt(AT, {
      tenants: [tenant(T1)],
      scopes: [],
      entitlements: [
        { tenantId: T1, entitlementKey: 'b', plan: null, expiresAt: '2026-10-23T00:04:00.001Z' },
        { tenantId: T1, entitlementKey: 'a', plan: 'pro', expiresAt: null },
        { tenantId: T1, entitlementKey: 'a', plan: null, expiresAt: AT },
        { tenantId: T2, entitlementKey: 'a', plan: null, expiresAt: null },
      ],
    });
    expect(row!.entitlements).toEqual([
      { entitlementKey: 'a', plan: null, expiresAt: AT, live: false },
      { entitlementKey: 'a', plan: 'pro', expiresAt: null, live: true },
      { entitlementKey: 'b', plan: null, expiresAt: '2026-10-23T00:04:00.001Z', live: true },
    ]);
  });

  it('hold one row per tenant not reaped, ordered by tenant, and nothing of a reaped one', () => {
    const rows = meterDayRowsAt(AT, {
      tenants: [tenant(T3, 'reaped'), tenant(T2, 'deleting'), tenant(T1)],
      scopes: [scope(T3, 'reaped'), scope(T1, 'active')],
      entitlements: [{ tenantId: T3, entitlementKey: 'a', plan: null, expiresAt: null }],
    });
    expect(rows.map((r) => [r.tenantId, r.status, r.scopes.total])).toEqual([
      [T1, 'active', 1],
      [T2, 'deleting', 0],
    ]);
  });
});

/** A directory as `recordMeterDayRows` sees it: the three tables it reads, and every write it makes. */
function fakeDirectory(rows: { tenants: unknown[]; scopes: unknown[]; entitlements: unknown[]; taken?: string | null }) {
  const writes: string[] = [];
  const sql = (statement: string): unknown[] => {
    const s = statement.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT taken_at')) return rows.taken === undefined ? [] : [{ taken_at: rows.taken }];
    if (s === 'SELECT tenant_id, slug, status FROM tenants') return rows.tenants;
    if (s === 'SELECT tenant_id, status, archived_from_status, vertical FROM scopes') return rows.scopes;
    if (s === 'SELECT tenant_id, entitlement_key, plan, expires_at FROM _substrat_entitlements') return rows.entitlements;
    writes.push(s);
    return [];
  };
  return { sql, writes };
}

describe('taking a snapshot', () => {
  const tenants = [{ tenant_id: T1, slug: 't1', status: 'active' }];
  const scopes = [{ tenant_id: T1, status: 'active', archived_from_status: null, vertical: 'crm' }];

  it('writes the day only after every row parsed: a grant that does not parse refuses the whole day', () => {
    const bad = fakeDirectory({ tenants, scopes, entitlements: [{ tenant_id: T1, entitlement_key: 'a', plan: '', expires_at: null }] });
    expect(() => recordMeterDayRows(bad.sql, { at: AT })).toThrow();
    expect(bad.writes).toEqual([]);
    // Its positive twin: the same day well formed is written, rows and record.
    const good = fakeDirectory({ tenants, scopes, entitlements: [{ tenant_id: T1, entitlement_key: 'a', plan: 'pro', expires_at: null }] });
    expect(recordMeterDayRows(good.sql, { at: AT })).toEqual({ day: '2026-10-23', taken: true, tenants: 1 });
    expect(good.writes.map((w) => w.split(' (')[0])).toEqual(['INSERT INTO _substrat_meter_days', 'INSERT INTO _substrat_meter_day_takes']);
  });

  it('leaves a day already taken as it is', () => {
    const dir = fakeDirectory({ tenants, scopes, entitlements: [], taken: '2026-10-23T00:01:00.000Z' });
    expect(recordMeterDayRows(dir.sql, { at: AT })).toEqual({ day: '2026-10-23', taken: false, tenants: 0 });
    expect(dir.writes).toEqual([]);
  });
});

/** A directory that keeps the snapshot's record in memory, as `recordMeterDayRows` would. */
function snapshotHost(
  opts: { snapshot?: boolean; take?: (at: string) => Promise<number>; failList?: boolean; staleList?: boolean; order?: string[] } = {},
) {
  // A day's record as the directory's columns hold it: plain strings, as the fake is handed them.
  const takes = new Map<
    string,
    { day: string; attemptedAt: string; takenAt: string | null; tenants: number | null; error: string | null; failingSince: string | null; failingCount: number | null }
  >();
  const recorded: MeterDayTakeInput[] = [];
  /** Every call that asked the directory to take a snapshot, whatever it answered. */
  const asked: string[] = [];
  const pruned: { limit: number; months: number | null }[] = [];
  const admin: Record<string, unknown> = {
    listScopes: async () => [],
    listConnections: async () => [],
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
  if (opts.snapshot !== false) {
    admin.listMeterDayTakes = async (_a: unknown, filter: { since?: string; until?: string } = {}) => {
      if (opts.failList) throw new Error('directory unavailable');
      // Read before another pass took the day: the directory's own check is then the one that answers.
      if (opts.staleList) return [];
      return [...takes.values()].filter((t) => (!filter.since || t.day >= filter.since) && (!filter.until || t.day <= filter.until));
    };
    admin.recordMeterDay = async (_a: unknown, input: MeterDayTakeInput) => {
      const day = input.at.slice(0, 10);
      const prior = takes.get(day);
      if ('error' in input) {
        recorded.push(input);
        if (!prior?.takenAt) {
          takes.set(day, {
            day,
            attemptedAt: input.at,
            takenAt: null,
            tenants: null,
            error: input.error,
            failingSince: input.failingSince ?? input.at,
            failingCount: input.failingCount ?? 1,
          });
        }
        return { day, taken: false, tenants: 0 };
      }
      opts.order?.push('snapshot');
      asked.push(input.at);
      if (prior?.takenAt) return { day, taken: false, tenants: 0 };
      const n = await (opts.take ?? (async () => 2))(input.at);
      recorded.push(input);
      takes.set(day, { day, attemptedAt: input.at, takenAt: input.at, tenants: n, error: null, failingSince: null, failingCount: null });
      return { day, taken: true, tenants: n };
    };
    admin.pruneMeterDays = async (_a: unknown, limit: number, months: number | null) => {
      pruned.push({ limit, months });
      return 0;
    };
  }
  const host = { admin, drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }) } as unknown as ScopeHost;
  return { host, takes, recorded, pruned, asked };
}

const sweep = (host: ScopeHost, meterSnapshot: MeterSnapshotSweepOptions, extra: Partial<PlatformSweepOptions> = {}) =>
  runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false, meterSnapshot, ...extra });

/** A pass every fifteen minutes from `start`. */
const passAt = (start: string, n: number) => new Date(Date.parse(start) + n * 15 * 60_000).toISOString();

describe('the meter-snapshot phase', () => {
  it('takes the day on its first pass, not on the later passes of the day, and the next day again', async () => {
    const { host, takes } = snapshotHost();
    const first = await sweep(host, { now: () => '2026-10-23T00:04:00.000Z' });
    expect(first.meterSnapshot).toEqual({ day: '2026-10-23', taken: true, tenants: 2, failed: 0, repeated: 0, streak: null, pruned: 0 });
    expect(first.errors).toEqual([]);
    const later = await sweep(host, { now: () => '2026-10-23T00:19:00.000Z' });
    expect(later.meterSnapshot).toMatchObject({ taken: false, tenants: 0, failed: 0, streak: null });
    expect(takes.get('2026-10-23')).toMatchObject({ takenAt: '2026-10-23T00:04:00.000Z' });
    const next = await sweep(host, { now: () => '2026-10-24T00:04:00.000Z' });
    expect(next.meterSnapshot).toMatchObject({ day: '2026-10-24', taken: true });
  });

  it('asks nothing on a later pass of a day already taken, so a failing directory cannot report a snapshot that stands as failed', async () => {
    let failing = false;
    const { host, asked } = snapshotHost({
      take: async () => {
        if (failing) throw new Error('directory busy');
        return 1;
      },
    });
    expect((await sweep(host, { now: () => '2026-10-23T00:04:00.000Z' })).meterSnapshot).toMatchObject({ taken: true });
    failing = true;
    const later = await sweep(host, { now: () => '2026-10-23T00:19:00.000Z' });
    expect(asked).toEqual(['2026-10-23T00:04:00.000Z']);
    expect(later.errors).toEqual([]);
    expect(later.meterSnapshot).toMatchObject({ taken: false, failed: 0, streak: null });
    // Its twin: the next day is asked, and its failure is reported.
    const next = await sweep(host, { now: () => '2026-10-24T00:04:00.000Z' });
    expect(asked).toHaveLength(2);
    expect(next.errors).toEqual([{ kind: 'meter-snapshot', id: '2026-10-24', error: 'directory busy' }]);
  });

  it('reports nothing taken when the directory answers that another pass took the day first', async () => {
    const { host, asked } = snapshotHost({ staleList: true });
    expect((await sweep(host, { now: () => '2026-10-23T00:04:00.000Z' })).meterSnapshot).toMatchObject({ taken: true, tenants: 2 });
    const raced = await sweep(host, { now: () => '2026-10-23T00:05:00.000Z' });
    expect(asked).toHaveLength(2);
    expect(raced.meterSnapshot).toMatchObject({ taken: false, tenants: 0, failed: 0 });
    expect(raced.errors).toEqual([]);
  });

  it('records a failed attempt, writes nothing of the day, and the next pass of the day tries again', async () => {
    let failing = true;
    const { host, takes, recorded } = snapshotHost({
      take: async () => {
        if (failing) throw new Error('directory busy');
        return 3;
      },
    });
    const failed = await sweep(host, { now: () => '2026-10-23T00:04:00.000Z' });
    expect(failed.meterSnapshot).toMatchObject({ taken: false, failed: 1, repeated: 0 });
    expect(failed.errors).toEqual([{ kind: 'meter-snapshot', id: '2026-10-23', error: 'directory busy' }]);
    expect(recorded).toEqual([{ at: '2026-10-23T00:04:00.000Z', error: 'directory busy', failingSince: '2026-10-23T00:04:00.000Z', failingCount: 1 }]);
    expect(takes.get('2026-10-23')).toMatchObject({ takenAt: null, error: 'directory busy' });
    failing = false;
    const retried = await sweep(host, { now: () => '2026-10-23T00:19:00.000Z' });
    expect(retried.meterSnapshot).toMatchObject({ taken: true, tenants: 3, failed: 0, streak: null });
    expect(retried.errors).toEqual([]);
  });

  it('reports a standing failure once per run, carries the run on every pass and across midnight, and a snapshot ends it', async () => {
    let error: string | null = 'directory busy';
    const { host } = snapshotHost({
      take: async () => {
        if (error !== null) throw new Error(error);
        return 1;
      },
    });
    const start = '2026-10-23T23:15:00.000Z';
    const passes = [];
    // Six passes, the last three past midnight: one run, mailed once.
    for (let n = 0; n < 6; n++) passes.push(await sweep(host, { now: () => passAt(start, n) }));
    expect(passes.map((p) => p.errors.length)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(passes.map((p) => [p.meterSnapshot!.failed, p.meterSnapshot!.repeated])).toEqual([[1, 0], ...Array(5).fill([1, 1])]);
    expect(passes.map((p) => p.meterSnapshot!.streak?.failures)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(passes.every((p) => p.meterSnapshot!.streak?.since === start)).toBe(true);
    expect(passes.map((p) => p.meterSnapshot!.day)).toEqual(['2026-10-23', '2026-10-23', '2026-10-23', '2026-10-24', '2026-10-24', '2026-10-24']);

    // A different error is a new run, mailed once.
    error = 'the meter snapshot took longer than 30000 ms';
    const changed = await sweep(host, { now: () => passAt(start, 6) });
    expect(changed.errors).toEqual([{ kind: 'meter-snapshot', id: '2026-10-24', error }]);
    expect(changed.meterSnapshot!.streak).toEqual({ error, since: passAt(start, 6), failures: 1 });

    // A snapshot ends the run; the same failure the next day is a new one, and mailed.
    error = null;
    const taken = await sweep(host, { now: () => passAt(start, 7) });
    expect(taken.meterSnapshot).toMatchObject({ taken: true, failed: 0, streak: null });
    error = 'the meter snapshot took longer than 30000 ms';
    const nextDay = await sweep(host, { now: () => '2026-10-25T00:04:00.000Z' });
    expect(nextDay.errors).toHaveLength(1);
    expect(nextDay.meterSnapshot!.streak).toEqual({ error, since: '2026-10-25T00:04:00.000Z', failures: 1 });
  });

  it('reads the run from yesterday and today only: a run whose last attempt was two days back is a new one', async () => {
    const { host } = snapshotHost({ take: async () => Promise.reject(new Error('directory busy')) });
    expect((await sweep(host, { now: () => '2026-10-20T00:04:00.000Z' })).errors).toHaveLength(1);
    // Its twin, a day later: the same run.
    const nextDay = await sweep(host, { now: () => '2026-10-21T00:04:00.000Z' });
    expect(nextDay.errors).toHaveLength(0);
    expect(nextDay.meterSnapshot!.streak).toMatchObject({ since: '2026-10-20T00:04:00.000Z', failures: 2 });
    // No pass for a whole day: the run's last attempt is not in the two days read.
    const gap = await sweep(host, { now: () => '2026-10-23T00:04:00.000Z' });
    expect(gap.errors).toHaveLength(1);
    expect(gap.meterSnapshot!.streak).toMatchObject({ since: '2026-10-23T00:04:00.000Z', failures: 1 });
  });

  it('runs after the scheduled work and before the access-log drain; a snapshot that never settles fails at its deadline without holding the pass', async () => {
    const order: string[] = [];
    let calls = 0;
    const { host, takes, pruned } = snapshotHost({ order, take: () => new Promise<never>(() => {}) });
    const report = await sweep(
      host,
      {
        timeoutMs: 20,
        // The clock moves past midnight while the pass waits; the failure is still the attempt's day.
        now: () => (calls++ === 0 ? '2026-10-23T23:59:59.990Z' : '2026-10-24T00:00:00.010Z'),
      },
      { accessLogSink: { ship: async () => ({ ref: 'r' }) } },
    );
    expect(order).toEqual(['telemetry', 'snapshot', 'access-log']);
    expect(report.accessLog).toEqual({ shipped: 0, marked: 0, pruned: 0, ref: null });
    expect(report.meterSnapshot).toMatchObject({ day: '2026-10-23', taken: false, failed: 1 });
    expect(takes.get('2026-10-23')).toMatchObject({
      attemptedAt: '2026-10-23T23:59:59.990Z',
      error: 'the meter snapshot took longer than 20 ms',
    });
    expect(takes.has('2026-10-24')).toBe(false);
    expect(pruned).toHaveLength(1);
  });

  it('runs before the request rollup, so a slow Analytics Engine answer cannot push the reading later', async () => {
    const order: string[] = [];
    const { host } = snapshotHost({ order });
    const admin = host.admin as unknown as Record<string, unknown>;
    admin.listRequestRollupDays = async () => [];
    admin.recordRequestDay = async () => ({ recorded: 0 });
    await sweep(host, { now: () => AT }, {
      requestRollup: { read: async () => (order.push('rollup'), []), lookbackDays: 1, now: () => '2026-10-23T12:00:00.000Z' },
    });
    expect(order).toEqual(['telemetry', 'snapshot', 'rollup']);
  });

  it('reports a directory that cannot be read, and the pass goes on', async () => {
    const { host } = snapshotHost({ failList: true });
    const report = await sweep(host, { now: () => AT });
    expect(report.errors).toEqual([{ kind: 'meter-snapshot', id: 'directory', error: 'directory unavailable' }]);
    expect(report.meterSnapshot).toMatchObject({ taken: false, failed: 0 });
  });

  it('prunes with the billing retention by default, and with an explicit one when given', async () => {
    const { host, pruned } = snapshotHost();
    await sweep(host, { now: () => AT });
    expect(pruned).toEqual([{ limit: METER_DAYS_PRUNE_BATCH, months: BILLING_ROLLUP_RETENTION_MONTHS }]);
    await sweep(host, { now: () => AT, retentionMonths: 24, pruneBatch: 10 });
    expect(pruned[1]).toEqual({ limit: 10, months: 24 });
  });

  it('waits thirty seconds for a snapshot by default', () => {
    expect(METER_SNAPSHOT_TIMEOUT_MS).toBe(30_000);
  });

  it('is skipped when the phase is not configured, or the host predates the snapshot', async () => {
    expect((await sweep(snapshotHost().host, undefined as never)).meterSnapshot).toBeNull();
    const old = snapshotHost({ snapshot: false });
    expect((await sweep(old.host, { now: () => AT })).meterSnapshot).toBeNull();
  });

  it('refuses a misconfigured pass before any phase runs', async () => {
    const { host, recorded } = snapshotHost();
    await expect(sweep(host, { pruneBatch: 0 })).rejects.toThrow(/meterSnapshot\.pruneBatch/);
    await expect(sweep(host, { retentionMonths: 0 })).rejects.toThrow(/meterSnapshot\.retentionMonths/);
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(sweep(host, { timeoutMs })).rejects.toThrow(/meterSnapshot\.timeoutMs/);
    }
    expect(recorded).toEqual([]);
    // Their positive twins: the edges that are allowed run.
    await expect(sweep(host, { now: () => AT, pruneBatch: 1, retentionMonths: 1, timeoutMs: 1_000 })).resolves.toMatchObject({ errors: [] });
    await expect(sweep(host, { now: () => AT, retentionMonths: null })).resolves.toMatchObject({ errors: [] });
  });
});
