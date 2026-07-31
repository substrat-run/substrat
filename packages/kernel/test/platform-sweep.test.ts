import { describe, it, expect } from 'vitest';
import { platformActorId, connectionId, scopeId, tenantId } from '@substrat-run/contracts';
import type { MigrationFailure, MigrationStraggler, Scope, Tenant } from '@substrat-run/contracts';
import { runPlatformSweep, startPlatformSweeper } from '../src/platform-sweep.js';
import type { ConnectorSweeper } from '../src/platform-sweep.js';
import type { FetchLike, MigrateScopeOutcome, ScopeHost } from '../src/scope-host.js';

/**
 * The orchestration, with fakes — that the pass enumerates, drains, dispatches by
 * provider, isolates failures, and bounds concurrency. The REAL chain (a sweep
 * that actually completes a signature) is proven end-to-end against the SQLite
 * adapter in the connector package; here we hold the driver itself to its
 * contract without a provider or a database in the way.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('fetch is not used by these fakes'))) as unknown as FetchLike;

// ULID-shaped ids from a counter — digits are all valid Crockford base32, so no
// risk of the I/L/O/U the alphabet excludes. Unique and deterministic.
let idCounter = 0;
const genId = () => '01J' + String(++idCounter).padStart(23, '0');
const sid = () => scopeId.parse(genId());
const cid = () => connectionId.parse(genId());
const T = tenantId.parse(genId());

/** A ScopeHost with only the three methods the driver touches; the rest throws if reached. */
function fakeHost(opts: {
  scopes?: { id: ReturnType<typeof sid>; tenantId: typeof T }[];
  connections?: { id: ReturnType<typeof cid>; provider: string; revokedAt: string | null }[];
  drainDue?: ScopeHost['drainDue'];
}): ScopeHost {
  const admin = {
    listScopes: async () => (opts.scopes ?? []).map((s) => ({ ...s, status: 'active' })),
    listConnections: async () => opts.connections ?? [],
  };
  return {
    admin,
    drainDue:
      opts.drainDue ??
      (async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 })),
  } as unknown as ScopeHost;
}

describe('runPlatformSweep', () => {
  it('drains active scopes and sweeps live connections, summing drain totals', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    const conns = [
      { id: cid(), provider: 'scrive', revokedAt: null },
      { id: cid(), provider: 'scrive', revokedAt: null },
    ];
    const drained: string[] = [];
    const swept: string[] = [];
    const host = fakeHost({
      scopes,
      connections: conns,
      drainDue: async (_t, s) => {
        drained.push(s);
        return { attempted: 2, delivered: 1, retrying: 1, deadLettered: 0 };
      },
    });
    const sweeper: ConnectorSweeper = async (_h, id) => {
      swept.push(id);
    };

    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: { scrive: sweeper } });

    expect(drained.sort()).toEqual(scopes.map((s) => s.id).sort());
    expect(swept.sort()).toEqual(conns.map((c) => c.id).sort());
    expect(report.scopesDrained).toBe(2);
    expect(report.connectionsSwept).toBe(2);
    expect(report.drainTotals).toEqual({ attempted: 4, delivered: 2, retrying: 2, deadLettered: 0 });
    expect(report.errors).toEqual([]);
  });

  it('drains platform intents for active scopes when a drain fn is supplied, summing totals', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    const drained: string[] = [];
    const report = await runPlatformSweep(fakeHost({ scopes }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      drainPlatformRequestsFn: async (_t, s) => {
        drained.push(s);
        return { drained: 2, done: 1, failed: 0, pending: 1 };
      },
    });
    expect(drained.sort()).toEqual(scopes.map((s) => s.id).sort());
    expect(report.platformRequestTotals).toEqual({ scopes: 2, drained: 4, done: 2, failed: 0, pending: 2 });
  });

  it('skips the platform-intent phase entirely when no drain fn is supplied', async () => {
    const report = await runPlatformSweep(fakeHost({ scopes: [{ id: sid(), tenantId: T }] }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
    });
    expect(report.platformRequestTotals).toEqual({ scopes: 0, drained: 0, done: 0, failed: 0, pending: 0 });
  });

  it('records a platform-intent drain failure per-scope and steps over it', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    let calls = 0;
    const report = await runPlatformSweep(fakeHost({ scopes }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      drainPlatformRequestsFn: async () => {
        calls++;
        if (calls === 1) throw new Error('vertical down');
        return { drained: 1, done: 1, failed: 0, pending: 0 };
      },
    });
    expect(report.errors.some((e) => e.kind === 'platform-request')).toBe(true);
    expect(report.platformRequestTotals.done).toBe(1); // the other scope still drained
  });

  it('skips revoked connections and providers with no sweeper', async () => {
    const live = cid();
    const conns = [
      { id: live, provider: 'scrive', revokedAt: null },
      { id: cid(), provider: 'scrive', revokedAt: '2026-01-01T00:00:00.000Z' }, // revoked
      { id: cid(), provider: 'fortnox', revokedAt: null }, // no sweeper registered
    ];
    const swept: string[] = [];
    const host = fakeHost({ connections: conns });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async (_h, id) => void swept.push(id) },
    });
    expect(swept).toEqual([live]);
    expect(report.connectionsSwept).toBe(1);
    expect(report.connectionsSkipped).toBe(2);
  });

  it('records a failure on one unit and steps over it — the batch is not sunk', async () => {
    const bad = cid();
    const good = cid();
    const host = fakeHost({
      scopes: [{ id: sid(), tenantId: T }],
      connections: [
        { id: bad, provider: 'scrive', revokedAt: null },
        { id: good, provider: 'scrive', revokedAt: null },
      ],
      drainDue: async () => {
        throw new Error('scope DO unreachable');
      },
    });
    const swept: string[] = [];
    const sweeper: ConnectorSweeper = async (_h, id) => {
      if (id === bad) throw new Error('provider 500');
      swept.push(id);
    };
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: { scrive: sweeper } });

    expect(swept).toEqual([good]); // the good one still ran
    expect(report.connectionsSwept).toBe(1);
    expect(report.errors).toContainEqual({ kind: 'sweep', id: bad, error: 'provider 500' });
    expect(report.errors.some((e) => e.kind === 'drain' && e.error === 'scope DO unreachable')).toBe(true);
  });

  it('bounds concurrency', async () => {
    const conns = Array.from({ length: 20 }, () => ({ id: cid(), provider: 'scrive', revokedAt: null }));
    let inFlight = 0;
    let peak = 0;
    const sweeper: ConnectorSweeper = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    };
    const report = await runPlatformSweep(fakeHost({ connections: conns }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: sweeper },
      concurrency: 4,
      drainRetries: false,
    });
    expect(report.connectionsSwept).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it did run in parallel, not serially
  });

  it('drainRetries: false sweeps only connectors', async () => {
    let drainCalled = false;
    const host = fakeHost({
      scopes: [{ id: sid(), tenantId: T }],
      connections: [{ id: cid(), provider: 'scrive', revokedAt: null }],
      drainDue: async () => {
        drainCalled = true;
        return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
      },
    });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async () => {} },
      drainRetries: false,
    });
    expect(drainCalled).toBe(false);
    expect(report.scopesDrained).toBe(0);
    expect(report.connectionsSwept).toBe(1);
  });
});

describe('runPlatformSweep — migration reconciliation (§5.3, #49)', () => {
  /** A directory row with just the fields the phase reads, ULID-shaped ids. */
  function row(over: Partial<Scope>): Scope {
    const id = scopeId.parse(genId());
    return {
      id,
      tenantId: T,
      slug: `s-${id.toLowerCase()}`,
      status: 'active',
      vertical: null,
      schemaVersion: '0',
      migrationFailure: null,
      forkedFrom: null,
      ...over,
    } as Scope;
  }

  const failed = (attempts: number, lastAttemptAt: string): MigrationFailure =>
    ({ version: '@v/m@0002-broken', error: 'boom', attempts, lastAttemptAt }) as MigrationFailure;

  const LONG_AGO = '2020-01-01T00:00:00.000Z';

  /** A host with the migration affordances; drain/connection surfaces are inert unless given. */
  function migHost(opts: {
    frontier: number;
    scopes: Scope[];
    migrateScope?: (t: string, s: string) => Promise<MigrateScopeOutcome>;
    drainDue?: (t: string, s: string) => Promise<{ attempted: number; delivered: number; retrying: number; deadLettered: number }>;
  }): ScopeHost {
    return {
      admin: {
        listScopes: async () => opts.scopes,
        listConnections: async () => [],
      },
      migrationFrontier: () => ({ total: opts.frontier }),
      migrateScope: opts.migrateScope ?? (async () => ({ status: 'noop' }) as const),
      drainDue:
        opts.drainDue ??
        (async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 })),
    } as unknown as ScopeHost;
  }

  const run = (host: ScopeHost, extra: object = {}) =>
    runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      migrationBackoff: { baseDelayMs: 0 }, // deterministic: every failed scope is due
      ...extra,
    });

  it('walks the directory and wakes exactly the stragglers, reporting §5.3 numbers', async () => {
    const current = [row({ schemaVersion: '3' }), row({ schemaVersion: '4' })];
    const pending = row({ schemaVersion: '1' }); // behind, never failed — never woken
    const broken = row({ schemaVersion: '2', migrationFailure: failed(1, LONG_AGO) });
    const attempted: string[] = [];
    const host = migHost({
      frontier: 3,
      scopes: [...current, pending, broken],
      migrateScope: async (_t, s) => {
        attempted.push(s);
        if (s === broken.id) return { status: 'failed', failure: { version: '@v/m@0002-broken', error: 'still boom' } };
        return { status: 'migrated', schemaVersion: '3' };
      },
    });

    const report = await run(host);

    expect(attempted.sort()).toEqual([pending.id, broken.id].sort()); // up-to-date scopes untouched
    expect(report.migrations).toMatchObject({
      release: '3',
      total: 4,
      migrated: 3, // 2 already there + the repaired straggler
      pending: 0,
      failed: 1,
      complete: false,
      attempted: 2,
      repaired: 1,
      deferred: 0,
      noops: 0,
    });
    expect(report.migrations?.summary).toBe('release 3: 3/4 migrated, 0 pending, 1 failed');
    expect(report.errors).toEqual([]);
  });

  it('failure is per-scope: one refusing scope neither sinks the pass nor blocks the rest', async () => {
    const unreachable = row({ schemaVersion: '0' });
    const fine = row({ schemaVersion: '0' });
    const host = migHost({
      frontier: 1,
      scopes: [unreachable, fine],
      migrateScope: async (_t, s) => {
        if (s === unreachable.id) throw new Error('scope DO unreachable');
        return { status: 'migrated', schemaVersion: '1' };
      },
    });
    const report = await run(host);
    expect(report.errors).toContainEqual({
      kind: 'migrate',
      id: unreachable.id,
      error: 'scope DO unreachable',
    });
    expect(report.migrations?.repaired).toBe(1);
    // The scope that threw keeps its directory classification — pending, not failed.
    expect(report.migrations?.pending).toBe(1);
  });

  it('a scope this pass left failed is skipped by the drain phase — it fails closed anyway', async () => {
    const broken = row({ schemaVersion: '0', migrationFailure: failed(1, LONG_AGO) });
    const healthy = row({ schemaVersion: '1' });
    const drained: string[] = [];
    const host = migHost({
      frontier: 1,
      scopes: [broken, healthy],
      migrateScope: async () => ({
        status: 'failed',
        failure: { version: '@v/m@0002-broken', error: 'boom' },
      }),
      drainDue: async (_t, s) => {
        drained.push(s);
        return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
      },
    });
    await run(host);
    expect(drained).toEqual([healthy.id]);
  });

  it('backs off: a freshly-failed scope is deferred until its window elapses', async () => {
    const justFailed = row({
      schemaVersion: '0',
      migrationFailure: failed(1, new Date().toISOString()),
    });
    let calls = 0;
    const host = migHost({
      frontier: 1,
      scopes: [justFailed],
      migrateScope: async () => {
        calls += 1;
        return { status: 'migrated', schemaVersion: '1' };
      },
    });
    const report = await run(host, { migrationBackoff: { baseDelayMs: 60_000 } });
    expect(calls).toBe(0);
    expect(report.migrations).toMatchObject({ attempted: 0, deferred: 1, failed: 1 });
    // The same scope with its window long past IS retried.
    const again = await run(
      migHost({
        frontier: 1,
        scopes: [row({ schemaVersion: '0', migrationFailure: failed(1, LONG_AGO) })],
        migrateScope: async () => {
          return { status: 'migrated', schemaVersion: '1' };
        },
      }),
      { migrationBackoff: { baseDelayMs: 60_000 } },
    );
    expect(again.migrations).toMatchObject({ attempted: 1, repaired: 1, deferred: 0 });
  });

  it('flags past the threshold and pages through onMigrationsFlagged', async () => {
    // Two prior failures; this pass's third crosses the default threshold (3).
    const chronic = row({ schemaVersion: '0', migrationFailure: failed(2, LONG_AGO) });
    const fresh = row({ schemaVersion: '0' }); // fails for the first time — not flagged
    const paged: MigrationStraggler[][] = [];
    const host = migHost({
      frontier: 1,
      scopes: [chronic, fresh],
      migrateScope: async () => ({
        status: 'failed',
        failure: { version: '@v/m@0002-broken', error: 'boom' },
      }),
    });
    const report = await run(host, { onMigrationsFlagged: (f: MigrationStraggler[]) => void paged.push(f) });
    expect(paged).toHaveLength(1);
    expect(paged[0]!.map((s) => s.scopeId)).toEqual([chronic.id]);
    const flaggedRow = report.migrations?.stragglers.find((s) => s.scopeId === chronic.id);
    expect(flaggedRow).toMatchObject({ state: 'failed', flagged: true });
    expect(flaggedRow?.failure?.attempts).toBe(3);
    expect(report.migrations?.stragglers.find((s) => s.scopeId === fresh.id)?.flagged).toBe(false);
  });

  it('a throwing pager is recorded, never sinks the pass', async () => {
    const chronic = row({ schemaVersion: '0', migrationFailure: failed(5, LONG_AGO) });
    const host = migHost({
      frontier: 1,
      scopes: [chronic],
      migrateScope: async () => ({
        status: 'failed',
        failure: { version: '@v/m@0002-broken', error: 'boom' },
      }),
    });
    const report = await run(host, {
      onMigrationsFlagged: () => {
        throw new Error('pager down');
      },
    });
    expect(report.migrations?.failed).toBe(1);
    expect(report.errors).toContainEqual({
      kind: 'migrate',
      id: 'onMigrationsFlagged',
      error: 'pager down',
    });
  });

  it('a noop outcome leaves the classification alone — a foreign host repairs nothing', async () => {
    // The control plane sweeping a fleet whose modules run in vertical
    // deployments: everything is "behind" its OWN frontier, nothing is this
    // host's to migrate, and above all nothing gets cleared.
    const foreign = row({ schemaVersion: '0', migrationFailure: failed(1, LONG_AGO) });
    const host = migHost({ frontier: 1, scopes: [foreign] }); // default migrateScope → noop
    const report = await run(host);
    expect(report.migrations).toMatchObject({ attempted: 1, noops: 1, repaired: 0, failed: 1 });
  });

  it('forks and non-live scopes are not fleet: never woken, never counted', async () => {
    const primary = row({ schemaVersion: '2' });
    const fork = row({ schemaVersion: '0', forkedFrom: primary.id });
    const suspended = row({ schemaVersion: '0', status: 'suspended' });
    const attempted: string[] = [];
    const host = migHost({
      frontier: 2,
      scopes: [primary, fork, suspended],
      migrateScope: async (_t, s) => {
        attempted.push(s);
        return { status: 'migrated', schemaVersion: '2' };
      },
    });
    const report = await run(host);
    expect(attempted).toEqual([]);
    expect(report.migrations).toMatchObject({ total: 1, migrated: 1, complete: true });
    expect(report.migrations?.summary).toBe('release 2: 1/1 migrated, 0 pending, 0 failed');
  });

  it('reconcileMigrations: false and a pre-#49 host both yield migrations: null', async () => {
    const off = await run(migHost({ frontier: 1, scopes: [row({})] }), {
      reconcileMigrations: false,
    });
    expect(off.migrations).toBeNull();
    // The original fake host has no migrateScope — the phase steps aside.
    const legacy = await runPlatformSweep(fakeHost({}), { actor: ACTOR, fetch: FETCH, sweepers: {} });
    expect(legacy.migrations).toBeNull();
  });
});

describe('startPlatformSweeper', () => {
  /** A hand-driven clock: startPlatformSweeper reschedules via these, so a test owns the cadence. */
  function fakeClock() {
    let seq = 0;
    const pending = new Map<number, () => void>();
    return {
      setTimer: (cb: () => void) => {
        const id = ++seq;
        pending.set(id, cb);
        return id;
      },
      clearTimer: (h: unknown) => pending.delete(h as number),
      /** Fire the one scheduled callback and let its async body fully settle. */
      async fire() {
        const [id, cb] = [...pending.entries()][0]!;
        pending.delete(id);
        cb();
        // A real macrotask boundary drains the pass's entire microtask chain
        // (all awaits resolve via microtasks) before returning.
        await new Promise((r) => setTimeout(r, 0));
      },
      count: () => pending.size,
    };
  }

  it('runs a pass per tick, reschedules only after it settles, and stops cleanly', async () => {
    const clock = fakeClock();
    const host = fakeHost({ connections: [{ id: cid(), provider: 'scrive', revokedAt: null }] });
    const passes: number[] = [];
    const handle = startPlatformSweeper(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async () => {} },
      intervalMs: 1000,
      onPass: (o) => passes.push('error' in o ? -1 : o.connectionsSwept),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // One timer is armed, nothing has run yet.
    expect(clock.count()).toBe(1);
    expect(passes).toEqual([]);

    await clock.fire(); // first pass
    expect(passes).toEqual([1]);
    expect(clock.count()).toBe(1); // rescheduled exactly one, no overlap

    await clock.fire(); // second pass
    expect(passes).toEqual([1, 1]);

    handle.stop();
    expect(clock.count()).toBe(0); // pending timer cancelled
  });

  it('a throwing pass is reported, not fatal, and the loop keeps going', async () => {
    const clock = fakeClock();
    // Make the enumeration itself throw — that is NOT caught inside a pass, so it
    // rejects `runPlatformSweep` and exercises the sweeper's own catch.
    const host = fakeHost({});
    (host.admin as unknown as { listScopes: () => Promise<never> }).listScopes = () => {
      throw new Error('directory unreachable');
    };
    const outcomes: (string | number)[] = [];
    startPlatformSweeper(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      intervalMs: 1000,
      onPass: (o) => outcomes.push('error' in o ? o.error : o.connectionsSwept),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.fire();
    expect(outcomes).toEqual(['directory unreachable']); // reported, not thrown
    expect(clock.count()).toBe(1); // rescheduled despite the failure
  });
});

describe('runPlatformSweep — reap long-archived scopes (§4.4)', () => {
  /** A directory row carrying the two fields the reap phase reads: status + archivedAt. */
  const archivedRow = (archivedAt: string | null): Scope =>
    ({
      id: scopeId.parse(genId()),
      tenantId: T,
      slug: 's',
      status: 'archived',
      vertical: null,
      schemaVersion: '0',
      migrationFailure: null,
      forkedFrom: null,
      archivedAt,
    }) as Scope;

  /** A host exposing listScopes + admin.reapScope; the reaped ids are captured. */
  function reapHost(scopes: Scope[], reaped: string[]): ScopeHost {
    return {
      admin: {
        listScopes: async () => scopes,
        listConnections: async () => [],
        reapScope: async (_a: unknown, _t: unknown, s: string) => {
          reaped.push(s);
        },
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
  }

  const OLD = '2020-01-01T00:00:00.000Z';
  const base = { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false } as const;

  it('is opt-in: no retention window ⇒ the phase never runs', async () => {
    const reaped: string[] = [];
    const report = await runPlatformSweep(reapHost([archivedRow(OLD)], reaped), { ...base });
    expect(reaped).toEqual([]);
    expect(report.archivedScopesReaped).toBe(0);
  });

  it('reaps scopes archived past the window, skips recent ones and null archivedAt', async () => {
    const old = archivedRow(OLD);
    const recent = archivedRow(new Date().toISOString());
    const unknownAge = archivedRow(null); // archived before the column shipped — never auto-reaped
    const reaped: string[] = [];
    const report = await runPlatformSweep(reapHost([old, recent, unknownAge], reaped), {
      ...base,
      reapArchivedAfterDays: 30,
    });
    expect(reaped).toEqual([old.id]);
    expect(report.archivedScopesReaped).toBe(1);
  });

  it('a per-scope reap failure is recorded and stepped over, never fatal', async () => {
    const a = archivedRow(OLD);
    const b = archivedRow(OLD);
    const reaped: string[] = [];
    const host = reapHost([a, b], reaped);
    (host.admin as unknown as { reapScope: unknown }).reapScope = async (
      _actor: unknown,
      _t: unknown,
      s: string,
    ) => {
      if (s === a.id) throw new Error('DO unreachable');
      reaped.push(s);
    };
    const report = await runPlatformSweep(host, { ...base, reapArchivedAfterDays: 0 });
    expect(reaped).toEqual([b.id]); // b still reaped despite a failing
    expect(report.archivedScopesReaped).toBe(1);
    expect(report.errors).toEqual([{ kind: 'reap', id: a.id, error: 'DO unreachable' }]);
  });

  it('reapScopeFn overrides the default (the control-plane orchestrated reap)', async () => {
    const old = archivedRow(OLD);
    const viaFn: string[] = [];
    const report = await runPlatformSweep(reapHost([old], []), {
      ...base,
      reapArchivedAfterDays: 30,
      reapScopeFn: async (_t, s) => {
        viaFn.push(s);
      },
    });
    expect(viaFn).toEqual([old.id]);
    expect(report.archivedScopesReaped).toBe(1);
  });
});

describe('runPlatformSweep — reap deleting tenants (§4.8)', () => {
  const OLD = '2020-01-01T00:00:00.000Z';
  const base = { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false } as const;

  const tenantRow = (id: string, deletingAt: string | null, status = 'deleting'): Tenant =>
    ({ id, slug: 's', name: 'n', status, createdAt: OLD, deletingAt }) as Tenant;

  /**
   * A host exposing the reads/writes the tenant-reap phase and its default reaper touch:
   * listTenants, listScopes (by tenant), archiveScope, reapScope, reapTenant. Calls are
   * captured so the test can assert the archive-then-reap-then-reapTenant orchestration.
   */
  function reapHost(
    tenants: Tenant[],
    scopesByTenant: Record<string, Scope[]>,
    calls: string[],
  ): ScopeHost {
    return {
      admin: {
        listTenants: async () => tenants,
        listScopes: async (_a: unknown, filter?: { tenantId?: string }) =>
          filter?.tenantId ? (scopesByTenant[filter.tenantId] ?? []) : [],
        listConnections: async () => [],
        archiveScope: async (_a: unknown, _t: unknown, s: string) => {
          calls.push(`archive:${s}`);
        },
        reapScope: async (_a: unknown, _t: unknown, s: string) => {
          calls.push(`reapScope:${s}`);
        },
        reapTenant: async (_a: unknown, t: string) => {
          calls.push(`reapTenant:${t}`);
        },
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
  }

  const scopeRow = (id: string, tid: string, status: string): Scope =>
    ({
      id,
      tenantId: tid,
      slug: 's',
      status,
      vertical: null,
      schemaVersion: '0',
      migrationFailure: null,
      forkedFrom: null,
      archivedAt: null,
    }) as Scope;

  it('is opt-in: no retention window ⇒ the phase never runs', async () => {
    const calls: string[] = [];
    const report = await runPlatformSweep(reapHost([tenantRow(T, OLD)], {}, calls), { ...base });
    expect(calls).toEqual([]);
    expect(report.tenantsReaped).toBe(0);
  });

  it('reaps deleting tenants past the window; skips recent, null-age, and non-deleting', async () => {
    const due = tenantRow(genId(), OLD);
    const recent = tenantRow(genId(), new Date().toISOString());
    const unknownAge = tenantRow(genId(), null); // deleting before the column shipped
    const active = tenantRow(genId(), null, 'active');
    const calls: string[] = [];
    const report = await runPlatformSweep(
      reapHost([due, recent, unknownAge, active], { [due.id]: [] }, calls),
      { ...base, reapDeletingAfterDays: 30 },
    );
    expect(calls).toEqual([`reapTenant:${due.id}`]);
    expect(report.tenantsReaped).toBe(1);
  });

  it('the default reaper archives-then-reaps each scope, then clears the directory', async () => {
    const due = tenantRow(genId(), OLD);
    const s1 = scopeRow(sid(), due.id, 'active'); // needs archiving first
    const s2 = scopeRow(sid(), due.id, 'archived'); // reap directly
    const s3 = scopeRow(sid(), due.id, 'reaped'); // already done — skipped
    const calls: string[] = [];
    const report = await runPlatformSweep(
      reapHost([due], { [due.id]: [s1, s2, s3] }, calls),
      { ...base, reapDeletingAfterDays: 0 },
    );
    expect(calls).toEqual([
      `archive:${s1.id}`,
      `reapScope:${s1.id}`,
      `reapScope:${s2.id}`, // already archived — no archive call
      `reapTenant:${due.id}`, // directory cleared only after every scope is reaped
    ]);
    expect(report.tenantsReaped).toBe(1);
  });

  it('the default reaper routes per-scope reaps through reapScopeFn (CP orchestration)', async () => {
    const due = tenantRow(genId(), OLD);
    const s1 = scopeRow(sid(), due.id, 'archived');
    const calls: string[] = [];
    const viaFn: string[] = [];
    await runPlatformSweep(reapHost([due], { [due.id]: [s1] }, calls), {
      ...base,
      reapDeletingAfterDays: 0,
      reapScopeFn: async (_t, s) => {
        viaFn.push(s);
      },
    });
    expect(viaFn).toEqual([s1.id]); // the vertical-orchestrated wipe, not host.admin.reapScope
    expect(calls).toEqual([`reapTenant:${due.id}`]); // reapScope did NOT go through the host
  });

  it('reapTenantFn fully overrides the default tenant reaper', async () => {
    const due = tenantRow(genId(), OLD);
    const viaFn: string[] = [];
    const report = await runPlatformSweep(reapHost([due], { [due.id]: [] }, []), {
      ...base,
      reapDeletingAfterDays: 30,
      reapTenantFn: async (t) => {
        viaFn.push(t);
      },
    });
    expect(viaFn).toEqual([due.id]);
    expect(report.tenantsReaped).toBe(1);
  });

  it('a per-tenant reap failure is recorded under reap-tenant and stepped over', async () => {
    const a = tenantRow(genId(), OLD);
    const b = tenantRow(genId(), OLD);
    const done: string[] = [];
    const report = await runPlatformSweep(reapHost([a, b], { [a.id]: [], [b.id]: [] }, []), {
      ...base,
      reapDeletingAfterDays: 0,
      reapTenantFn: async (t) => {
        if (t === a.id) throw new Error('directory offline');
        done.push(t);
      },
    });
    expect(done).toEqual([b.id]); // b still reaped despite a failing
    expect(report.tenantsReaped).toBe(1);
    expect(report.errors).toEqual([{ kind: 'reap-tenant', id: a.id, error: 'directory offline' }]);
  });
});
