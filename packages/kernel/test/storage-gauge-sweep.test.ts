import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { runPlatformSweep, STORAGE_SAMPLE_BATCH, StorageReadUnsupported, type PlatformSweepOptions } from '../src/platform-sweep.js';
import { STORAGE_GAUGE_PRUNE_BATCH, type ScopeStorageAttempt, type ScopeStorageReadingInput } from '../src/storage-gauge.js';
import type { FetchLike, ScopeHost } from '../src/scope-host.js';

/**
 * The storage-gauge phase (#1524), with fakes. What makes it safe to run on every pass is that
 * it never wakes a scope of its own accord: it reads only scopes an earlier phase of the same
 * pass reached, at most `batch` of them, stalest first, and only once a day each. These hold it
 * to each of those, and to the positive twin of each: a scope that qualifies IS read.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
const T = tenantId.parse('01J00000000000000000000T01');
let n = 0;
const sid = () => scopeId.parse('01J' + String(++n).padStart(23, '0'));
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 86_400_000;

function gaugeHost(opts: {
  scopes: ScopeId[];
  /** Scopes in another status than active. */
  statusOf?: Record<string, string>;
  /** What an archived scope was archived from; absent = a legacy row (null). */
  archivedFrom?: Record<string, string>;
  /** When the phase last tried each scope. */
  tried?: Record<string, string>;
  drainDue?: (s: string) => Promise<void>;
  gauge?: boolean;
}) {
  const recorded: ScopeStorageReadingInput[] = [];
  const pruned: number[] = [];
  const admin: Record<string, unknown> = {
    listScopes: async (_a: unknown, filter?: { status?: string | string[] }) => {
      const wanted = filter?.status === undefined ? undefined : [filter.status].flat();
      return opts.scopes
        .map((id) => ({
          id,
          tenantId: T,
          status: opts.statusOf?.[id] ?? 'active',
          archivedFromStatus: opts.archivedFrom?.[id] ?? null,
          vertical: 'todo',
        }))
        .filter((s) => wanted === undefined || wanted.includes(s.status));
    },
    listConnections: async () => [],
  };
  if (opts.gauge !== false) {
    admin.listScopeStorageAttempts = async (): Promise<ScopeStorageAttempt[]> =>
      Object.entries(opts.tried ?? {}).map(([scope, attemptedAt]) => ({
        tenantId: T,
        scopeId: scope as ScopeId,
        attemptedAt,
        error: null,
      }));
    admin.recordScopeStorage = async (_a: unknown, readings: ScopeStorageReadingInput[]) => {
      recorded.push(...readings);
      return { recorded: readings.filter((r) => r.bytes !== null).length };
    };
    admin.pruneScopeStorage = async (_a: unknown, limit: number) => {
      pruned.push(limit);
      return 0;
    };
  }
  const host = {
    admin,
    drainDue: async (_t: string, s: string) => {
      await opts.drainDue?.(s);
      return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
    },
  } as unknown as ScopeHost;
  return { host, recorded, pruned };
}

const sweep = (host: ScopeHost, extra: Partial<PlatformSweepOptions> = {}) =>
  runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, ...extra });

/** A reader that counts who it was asked about. */
function reader(answer: (s: ScopeId) => number | null | Error = () => 4096) {
  const asked: string[] = [];
  return {
    asked,
    read: async (s: { id: ScopeId }) => {
      asked.push(s.id);
      const a = answer(s.id);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const drained = { drained: 0, done: 0, failed: 0, pending: 0 };

describe('runPlatformSweep · storage gauge (#1524)', () => {
  it('reads only the scopes the platform-intent drain reached this pass', async () => {
    const [reached, unreachable, threw] = [sid(), sid(), sid()];
    const { host, recorded } = gaugeHost({ scopes: [reached, unreachable, threw] });
    const r = reader();
    const report = await sweep(host, {
      drainRetries: false,
      drainPlatformRequestsFn: async (_t, s) => {
        if (s === threw) throw new Error('vertical down');
        return s === unreachable ? { ...drained, unreachable: true } : drained;
      },
      storageGauge: { read: r.read },
    });
    expect(r.asked).toEqual([reached]);
    expect(recorded.map((x) => [x.scopeId, x.bytes])).toEqual([[reached, 4096]]);
    expect(report.storage).toMatchObject({ reached: 1, due: 1, read: 1, failed: 0, recorded: 1 });
  });

  it('with no platform drain, reads what the executor drain reached, and nothing when neither ran', async () => {
    const [ok, failed] = [sid(), sid()];
    const a = gaugeHost({ scopes: [ok, failed] });
    const failing = gaugeHost({
      scopes: [ok, failed],
      drainDue: async (s) => {
        if (s === failed) throw new Error('DO unreachable');
      },
    });
    const r = reader();
    await sweep(failing.host, { storageGauge: { read: r.read } });
    expect(r.asked).toEqual([ok]);

    // Neither drain runs: no scope was woken, so the phase reads nothing at all.
    const idle = reader();
    const report = await sweep(a.host, { drainRetries: false, storageGauge: { read: idle.read } });
    expect(idle.asked).toEqual([]);
    expect(report.storage).toMatchObject({ reached: 0, read: 0 });
  });

  it('reads at most the batch per pass, never-tried first, then the longest since a try, and skips a recent one', async () => {
    const scopes = Array.from({ length: STORAGE_SAMPLE_BATCH + 150 }, sid);
    const fresh = scopes[0]!;
    const oldest = scopes[1]!;
    const older = scopes[2]!;
    // Every scope was tried: most two days ago, two longer ago still, one recently.
    const tried: Record<string, string> = Object.fromEntries(scopes.map((s) => [s, ago(2 * DAY)]));
    tried[fresh] = ago(DAY / 2);
    tried[oldest] = ago(30 * DAY);
    tried[older] = ago(10 * DAY);
    const neverRead = sid();
    const { host, recorded } = gaugeHost({ scopes: [...scopes, neverRead], tried });
    const r = reader();
    const report = await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });

    expect(r.asked).toHaveLength(STORAGE_SAMPLE_BATCH);
    expect(r.asked).not.toContain(fresh);
    // Order of reads is concurrency's; what was CHOSEN is the stalest set.
    expect(r.asked).toEqual(expect.arrayContaining([neverRead, oldest, older]));
    expect(recorded).toHaveLength(STORAGE_SAMPLE_BATCH);
    expect(report.storage).toMatchObject({
      reached: scopes.length + 1,
      due: scopes.length, // every one but the fresh, plus the never-read
      deferred: scopes.length - STORAGE_SAMPLE_BATCH,
      read: STORAGE_SAMPLE_BATCH,
    });
  });

  it('a scope tried maxAge ago is due again; one tried a moment later is not', async () => {
    const [due, notYet] = [sid(), sid()];
    const { host } = gaugeHost({ scopes: [due, notYet], tried: { [due]: ago(DAY + 1000), [notYet]: ago(DAY - 60_000) } });
    const r = reader();
    await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });
    expect(r.asked).toEqual([due]);
  });

  it('a batch of 0 pauses sampling but still prunes; a malformed batch refuses the pass', async () => {
    const { host, pruned } = gaugeHost({ scopes: [sid()] });
    const r = reader();
    const report = await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read, batch: 0 } });
    expect(r.asked).toEqual([]);
    expect(pruned).toEqual([STORAGE_GAUGE_PRUNE_BATCH]);
    expect(report.storage).toMatchObject({ read: 0, pruned: 0 });

    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(sweep(host, { storageGauge: { read: r.read, batch: bad } })).rejects.toThrow(/storageGauge\.batch/);
    }
    await expect(sweep(host, { storageGauge: { read: r.read, pruneBatch: 0 } })).rejects.toThrow(/pruneBatch/);
  });

  it('records a failed read and a declined one as attempts with no size; only the failure is an error', async () => {
    const [ok, broken, none] = [sid(), sid(), sid()];
    const { host, recorded } = gaugeHost({ scopes: [ok, broken, none] });
    const r = reader((s) => (s === broken ? new Error('boom') : s === none ? null : 10));
    const report = await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });
    const by = new Map(recorded.map((x) => [x.scopeId, x]));
    expect(by.get(ok)).toMatchObject({ bytes: 10 });
    expect(by.get(broken)).toMatchObject({ bytes: null, error: 'boom' });
    expect(by.get(none)).toMatchObject({ bytes: null });
    expect(by.get(none)).not.toHaveProperty('error');
    expect(report.storage).toMatchObject({ read: 1, failed: 1, skipped: 1, recorded: 1 });
    expect(report.errors).toEqual([{ kind: 'storage', id: broken, error: 'boom' }]);
  });

  it("records a deployment that cannot read a size as the scope's error, but keeps that standing condition out of the digest", async () => {
    const [old, broken] = [sid(), sid()];
    const { host, recorded } = gaugeHost({ scopes: [old, broken] });
    const r = reader((s) => (s === old ? new StorageReadUnsupported('cannot read a database size (501); redeploy it') : new Error('boom')));
    const report = await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });
    // Both are recorded as failing attempts, so /meters names them…
    expect(recorded.find((x) => x.scopeId === old)).toMatchObject({ bytes: null, error: expect.stringMatching(/501/) });
    expect(recorded.find((x) => x.scopeId === broken)).toMatchObject({ bytes: null, error: 'boom' });
    // …but only the ordinary failure reaches `errors`, which the failure digest mails.
    expect(report.errors).toEqual([{ kind: 'storage', id: broken, error: 'boom' }]);
    expect(report.storage).toMatchObject({ failed: 2, unsupported: 1 });
  });

  it('does not retry a scope that failed recently: it waits a day, behind nothing', async () => {
    // A batch-full of scopes that failed an hour ago, and one never tried. Without the attempt
    // record the failures would stay due and take every slot on every pass.
    const failing = Array.from({ length: STORAGE_SAMPLE_BATCH }, sid);
    const fresh = sid();
    const { host } = gaugeHost({
      scopes: [...failing, fresh],
      tried: Object.fromEntries(failing.map((s) => [s, ago(3_600_000)])),
    });
    const r = reader();
    const report = await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });
    expect(r.asked).toEqual([fresh]);
    expect(report.storage).toMatchObject({ due: 1, read: 1 });
  });

  it('a size that is not a non-negative integer is a failed read, not a stored one', async () => {
    const [neg, frac] = [sid(), sid()];
    const { host, recorded } = gaugeHost({ scopes: [neg, frac] });
    const r = reader((s) => (s === neg ? -1 : 1.5));
    const report = await sweep(host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });
    expect(recorded.map((x) => x.bytes)).toEqual([null, null]);
    expect(report.storage).toMatchObject({ failed: 2, recorded: 0 });
  });

  it('also reads every non-serving scope that holds a store, which no drain reaches, and never a provisioning one', async () => {
    const [active, suspended, archiving, archived, provisioning, reaped] = [sid(), sid(), sid(), sid(), sid(), sid()];
    const { host, recorded } = gaugeHost({
      scopes: [active, suspended, archiving, archived, provisioning, reaped],
      statusOf: {
        [suspended]: 'suspended',
        [archiving]: 'archiving',
        [archived]: 'archived',
        [provisioning]: 'provisioning',
        [reaped]: 'reaped',
      },
    });
    const r = reader();
    // The drains walk active scopes only; here the platform drain reaches none of them.
    const report = await sweep(host, {
      drainRetries: false,
      drainPlatformRequestsFn: async () => ({ ...drained, unreachable: true }),
      storageGauge: { read: r.read },
    });
    expect([...r.asked].sort()).toEqual([suspended, archiving, archived].sort());
    expect(recorded.map((x) => x.scopeId).sort()).toEqual([suspended, archiving, archived].sort());
    expect(report.storage).toMatchObject({ reached: 0, resting: 3, due: 3, read: 3 });
  });

  it('never reads a scope archived straight from provisioning; archived from active, or a legacy row, still is', async () => {
    const [neverStored, wasActive, legacy] = [sid(), sid(), sid()];
    const { host } = gaugeHost({
      scopes: [neverStored, wasActive, legacy],
      statusOf: { [neverStored]: 'archived', [wasActive]: 'archived', [legacy]: 'archived' },
      archivedFrom: { [neverStored]: 'provisioning', [wasActive]: 'active' }, // legacy: null
    });
    const r = reader();
    const report = await sweep(host, { drainRetries: false, storageGauge: { read: r.read } });
    expect([...r.asked].sort()).toEqual([wasActive, legacy].sort());
    expect(report.storage).toMatchObject({ resting: 2, read: 2 });
  });

  it('reads a non-serving scope once a day, like any other, so its sample never goes stale', async () => {
    const [archived, yesterday] = [sid(), sid()];
    const { host } = gaugeHost({
      scopes: [archived, yesterday],
      statusOf: { [archived]: 'archived', [yesterday]: 'archived' },
      tried: { [archived]: ago(3 * DAY), [yesterday]: ago(DAY / 2) },
    });
    const r = reader();
    await sweep(host, { drainRetries: false, storageGauge: { read: r.read } });
    expect(r.asked).toEqual([archived]);
  });

  it('is off when the option is unset, or the host keeps no gauge', async () => {
    const a = gaugeHost({ scopes: [sid()] });
    expect((await sweep(a.host, { drainPlatformRequestsFn: async () => drained })).storage).toBeNull();

    const b = gaugeHost({ scopes: [sid()], gauge: false });
    const r = reader();
    const report = await sweep(b.host, { drainPlatformRequestsFn: async () => drained, storageGauge: { read: r.read } });
    expect(report.storage).toBeNull();
    expect(r.asked).toEqual([]);
  });
});
