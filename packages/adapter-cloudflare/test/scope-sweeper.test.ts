import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeId,
  type TenantId,
  SWEEP_RUNS_KIND,
  instant,
  sweepRunsPayload,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { scheduleMod } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from '../src/host.js';
import { armRewind, holdsStub, landRewind } from './pitr-emulation.js';
import { warmDurableObject, warmSwitchHolds } from './do-warmup.js';
import {
  SCOPE_SWEEPER_NAME,
  SWEEPER_ID,
  type ScopeSweepOutcome,
  type ScopeSweepReport,
} from '../src/scope-sweeper-do.js';

/**
 * The CP-LESS trigger path, exercised for real (#461): a workerd Durable Object
 * alarm driving `drainDue`/`runDueSchedules` over a ROSTER — the scopes a
 * hosted vertical learns at `/internal/provision` — with no directory anywhere.
 * The pass's halves have their own tests (the CP-less schedule suite in
 * contract.test.ts; kernel's drain tests); what these tests own is the roster +
 * loop contract:
 *
 *   - `noteScope` registers a scope AND arms the alarm (the loop starts)
 *   - a pass visits every noted scope; due schedules fire, cadence gates re-runs
 *   - the alarm re-arms itself while scopes remain (the loop continues)
 *   - `forgetScope` drops a scope; an EMPTY roster lets the alarm lapse, and
 *     the next `noteScope` restarts the loop
 *
 * The shared loop mechanics (non-overlap, a pass that sinks whole still
 * re-arming) are pinned by platform-sweeper.test.ts — the two DOs use the same
 * `#run` shape on purpose.
 */

interface ScopeSweeperStub {
  noteScope(tenantId: TenantId, scopeId: ScopeId): Promise<{ scopes: number }>;
  forgetScope(scopeId: ScopeId): Promise<{ scopes: number }>;
  ensureArmed(): Promise<{ armed: boolean; alarmAt: number }>;
  sweepNow(): Promise<ScopeSweepOutcome>;
}

const sweeperStub = (): DurableObjectStub & ScopeSweeperStub =>
  env.SCOPE_SWEEPER.get(
    env.SCOPE_SWEEPER.idFromName(SCOPE_SWEEPER_NAME),
  ) as DurableObjectStub & ScopeSweeperStub;

const alarmOf = (stub: DurableObjectStub): Promise<number | null> =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

const asReport = (outcome: ScopeSweepOutcome): ScopeSweepReport => {
  if ('error' in outcome) throw new Error(`pass sank whole: ${outcome.error}`);
  return outcome;
};

// The inter-file reload (see do-warmup.ts) lands on the first call of this file, and every pass
// here now reads the #1819 hold object too. Absorb it on both singletons a pass touches, before
// any test's own assertion can be the thing that meets it. Read-only: the roster stays unarmed.
beforeAll(async () => {
  await warmDurableObject(() => runInDurableObject(sweeperStub(), (_i, state) => state.storage.getAlarm()));
  await warmSwitchHolds(env.LOCAL_SWEEP_SCOPE);
});

describe('defineScopeSweeperDO (workerd alarm → roster → due schedules, CP-less)', () => {
  const SCHED = moduleId.parse('@test/sched');
  const READ = permissionKey.parse('perm:read');
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const sA = scopeId.parse(ulid());
  const sB = scopeId.parse(ulid());

  // No `controlPlane` — the null-object stand-in, exactly the hosted-vertical
  // shape; the SAME host the DO's `host(env)` closure builds in test/worker.ts.
  const host = () => {
    const h = new CloudflareScopeHost({
      scope: env.LOCAL_SWEEP_SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    h.registerModule(scheduleMod);
    return h;
  };

  const ticksOn = async (s: ScopeId): Promise<number> => {
    const stub = await host().getScope(owner, t, s);
    return (await stub.invoke('sched/count')) as number;
  };

  beforeAll(async () => {
    const h = host();
    for (const s of [sA, sB]) {
      await h.provisionScopeLocal({
        tenantId: t,
        scopeId: s,
        owner,
        roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
        ownerRoleKey: 'office-admin',
      });
    }
  });

  it('accepts an explicit system grant on a CP-less scope', async () => {
    await host().admin.grantToSystem(staff, {
      moduleId: SCHED, permission: READ,
      node: { tenantId: t, scopeId: sA }, grantedBy: staff,
    });
    const stub = await host().getSystemScope(SCHED, t, sA);
    await expect(stub.invoke('sched/count')).resolves.toBe(0);
  });

  it('noteScope registers the scope and arms the loop', async () => {
    const stub = sweeperStub();
    expect(await alarmOf(stub)).toBeNull(); // nothing noted yet — no loop
    expect((await stub.noteScope(t, sA)).scopes).toBe(1);
    expect((await stub.noteScope(t, sB)).scopes).toBe(2);
    expect(await stub.noteScope(t, sB)).toEqual({ scopes: 2 }); // idempotent overwrite
    expect(await alarmOf(stub)).not.toBeNull(); // the first note started the loop
  });

  it('a kick sweeps the roster — the due schedule fires on every noted scope', async () => {
    const report = asReport(await sweeperStub().sweepNow());
    expect(report.errors).toEqual([]);
    expect(report.scopes).toBe(2);
    // Two schedules per scope, two scopes: `sched/tick` plus #1288's collision
    // fixture `freshness:sched.ticked`.
    expect(report.schedules).toEqual({ scopes: 2, fired: 4, skipped: 0, failed: 0 });
    // No consumers on scheduleMod — the drain half ran and found nothing.
    expect(report.drainTotals).toEqual({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 });
    // The ticks really landed in each scope, through the system door.
    expect(await ticksOn(sA)).toBe(1);
    expect(await ticksOn(sB)).toBe(1);
  });

  it('cadence gates the second pass — skipped on both scopes, not re-fired', async () => {
    const report = asReport(await sweeperStub().sweepNow());
    expect(report.schedules).toEqual({ scopes: 0, fired: 0, skipped: 4, failed: 0 });
    expect(await ticksOn(sA)).toBe(1);
  });

  it('each pass leaves ONE batched sweep-runs intent per scope — skips included, version from env (#1232)', async () => {
    // The two passes above (fired, then skipped) each enqueued a batch on each scope:
    // a CP-less pass's only road to _substrat_sweep_runs is its own intent journal.
    const pending = await host().listPlatformRequests(t, sA);
    const sweeps = pending.filter((r) => r.kind === SWEEP_RUNS_KIND);
    expect(sweeps).toHaveLength(2);
    const first = sweepRunsPayload.parse(sweeps[0]!.payload);
    const second = sweepRunsPayload.parse(sweeps[1]!.payload);
    // First pass: the schedule fired, and the freshness evaluator (#1232) saw the
    // event it just emitted — both join ONE batch, each under its own kind. TWO
    // modules declare this event type (scheduleMod 1h/24h, freshnessMod 48h), and
    // exactly ONE freshness entry proves the cross-module aggregation: per-module
    // evaluation would have produced two entries colliding on the dedupe unit.
    expect(first.entries.map((e) => `${e.kind}:${e.outcome}`).sort()).toEqual([
      'freshness:ok',
      'schedule:ok',
      'schedule:ok',
    ]);
    const fresh = first.entries.find((e) => e.kind === 'freshness')!;
    expect(fresh.eventType).toBe('sched.ticked');
    expect(fresh.observedAt).not.toBeNull();
    // Second pass: the schedule's skip is REPORTED (absence of even skips is the
    // missed-run signal); the freshness verdict is UNCHANGED inside its heartbeat,
    // so it deliberately reports nothing — that is the change-gating, observed.
    expect(second.entries.map((e) => `${e.kind}:${e.outcome}`)).toEqual([
      'schedule:skipped',
      'schedule:skipped',
    ]);
    // #1288: one of the two schedule entries is named exactly like the freshness
    // entry's gating key, and they are still two separate units here.
    expect(first.entries.filter((e) => e.kind === 'schedule').map((e) => e.operation).sort()).toEqual([
      'freshness:sched.ticked',
      'sched/tick',
    ]);
    // The version the worker's accessor read from env — the code that actually ran.
    expect(first.version).toBe(env.SUBSTRAT_VERSION_ID);
    expect(sweeps.every((r) => JSON.stringify(r.requestedBy) === JSON.stringify({ system: 'scope-sweeper' }))).toBe(
      true,
    );
  });

  it('drives a due job through the same roster and reports its completion', async () => {
    await host().startJobRun(t, sA, { moduleId: SCHED, job: 'noop' });
    const report = asReport(await sweeperStub().sweepNow());
    expect(report.jobs).toEqual({ attempted: 1, advanced: 0, completed: 1, retrying: 0, failed: 0 });
    expect((await host().jobRuns(t, sA, { job: 'noop' }))[0]?.status).toBe('done');
  });

  it('paces recurring job starts per scope and retries after the interval', async () => {
    const stub = sweeperStub();
    const key = `job-start:${sA}`;
    await stub.noteScope(t, sA);
    asReport(await stub.sweepNow());
    const first = await runInDurableObject(stub, (_instance, state) => state.storage.get<number>(key));
    expect(first).toBeTypeOf('number');
    await stub.sweepNow();
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.get<number>(key))).toBe(first);
    await runInDurableObject(stub, (_instance, state) => state.storage.put(key, 1));
    await stub.sweepNow();
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.get<number>(key)))
      .toBeGreaterThan(first!);
  });

  it('the alarm runs a pass and re-arms itself while scopes remain', async () => {
    const stub = sweeperStub();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(stub)).not.toBeNull(); // the loop continues
  });

  it('forgetScope shrinks the roster; an empty roster lets the alarm lapse', async () => {
    const stub = sweeperStub();
    expect((await stub.forgetScope(sA)).scopes).toBe(1);
    expect((await stub.forgetScope(sB)).scopes).toBe(0);
    // The alarm set by the previous pass fires once more, finds nothing, and
    // does NOT re-arm — a deployment with no scopes costs nothing.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(stub)).toBeNull();
    // …and the next provision restarts the loop.
    expect((await stub.noteScope(t, sA)).scopes).toBe(1);
    expect(await alarmOf(stub)).not.toBeNull();
  });

  it('the SCHED module is the one the roster pass drives', async () => {
    // Pin the module id the suite provisions against — a rename would silently
    // decouple this file from the CP-less schedule suite in contract.test.ts.
    expect(host().registeredSchedules()).toEqual([
      { moduleId: SCHED, schedules: scheduleMod.manifest.schedules },
    ]);
  });
});

/**
 * #1819, the issue's own test, through the deployment's real sweeper: switch off, rewind to a
 * bookmark from before the switch, then run the sweeper's pass before any platform reconcile.
 * It used to fire. The rewind is EMULATED (`pitr-emulation.ts`: workerd has no PITR); the
 * DO's own `rewindToBookmark` and the restart it causes are real.
 */
describe('#1819 — the deployment sweep after a rewind to before the switch', { timeout: 20_000 }, () => {
  const SCHED = moduleId.parse('@test/sched');
  const READ = permissionKey.parse('perm:read');
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const host = () => {
    const h = new CloudflareScopeHost({
      scope: env.LOCAL_SWEEP_SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    h.registerModule(scheduleMod);
    return h;
  };
  const ticksOn = async (s: ScopeId): Promise<number> =>
    (await (await host().getScope(owner, t, s)).invoke('sched/count')) as number;

  /** Provision, take the "bookmark", optionally switch off, rewind, and put it on the roster. */
  const rewound = async (switchOff: boolean): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    const atBookmark = await host().exportScopeLocal(s);
    if (switchOff) await host().systemSwitchLocal(s, SCHED, 'off');
    await armRewind(env.LOCAL_SWEEP_SCOPE, s);
    await host().rewindScopeLocal(s, 'bm', { force: true });
    await landRewind(env.LOCAL_SWEEP_SCOPE, s, atBookmark);
    await sweeperStub().noteScope(t, s);
    return s;
  };

  it('the switched-off module fires nothing on the sweep; a module that was on still fires', async () => {
    const wasOff = await rewound(true);
    const wasOn = await rewound(false);
    // The rewound storage has the switch undone: the state the sweep used to fire on.
    expect(await host().systemGrantsStatusLocal(wasOff)).toEqual([{ moduleId: SCHED, schedules: 'on' }]);
    const report = asReport(await sweeperStub().sweepNow());
    expect(report.errors).toEqual([]);
    expect(await ticksOn(wasOff)).toBe(0);
    expect(await ticksOn(wasOn)).toBe(1);
    // …and the next pass still fires nothing on it: no reconcile has run.
    asReport(await sweeperStub().sweepNow());
    expect(await ticksOn(wasOff)).toBe(0);
    await sweeperStub().forgetScope(wasOff);
    await sweeperStub().forgetScope(wasOn);
  });
});

/**
 * #1902: the sweeper checks ids with a pattern rather than the contracts schemas, because the
 * platform bundles this file into the sweeper it supplies to every upload that needs one, and
 * zod would come with the schemas. The pattern is held to the schemas here, so the two cannot
 * part company — and the refusal it gives is still a refusal, with the roster untouched.
 */
describe('#1902 — the sweeper’s id check, without contracts at run time', () => {
  const samples = [ulid(), ulid().toLowerCase(), '', 'not-a-ulid', `${ulid()}0`, ulid().slice(1), 'I'.repeat(26), 'O'.repeat(26), '0'.repeat(26)];

  it('accepts exactly what the tenantId and scopeId schemas accept', () => {
    for (const s of samples) {
      expect(SWEEPER_ID.test(s), s).toBe(tenantId.safeParse(s).success);
      expect(SWEEPER_ID.test(s), s).toBe(scopeId.safeParse(s).success);
    }
  });

  it('refuses a malformed id over RPC and leaves the roster as it was', async () => {
    const before = await runInDurableObject(sweeperStub(), async (_i, state) => (await state.storage.list({ prefix: 'scope:' })).size);
    await expect(sweeperStub().noteScope('nope' as TenantId, scopeId.parse(ulid()))).rejects.toThrow(/tenantId must be a ULID/);
    await expect(sweeperStub().forgetScope('nope' as ScopeId)).rejects.toThrow(/scopeId must be a ULID/);
    const after = await runInDurableObject(sweeperStub(), async (_i, state) => (await state.storage.list({ prefix: 'scope:' })).size);
    expect(after).toBe(before);
  });
});

/**
 * #1713 through the deployment's real sweeper: a roster scope its delivered lifecycle holds is
 * skipped whole — no schedule fires, no job is driven, no delivery attempted, and no cadence row
 * moves — and the first pass after it is live again does the work it deferred, once.
 */
describe('#1713 — the deployment sweep skips a scope its lifecycle holds, then resumes it', () => {
  const READ = permissionKey.parse('perm:read');
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const host = () => {
    const h = new CloudflareScopeHost({
      scope: env.LOCAL_SWEEP_SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    h.registerModule(scheduleMod);
    return h;
  };
  const ticksOn = async (s: ScopeId): Promise<number> =>
    (await (await host().getScope(owner, t, s)).invoke('sched/count')) as number;
  const seat = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    await sweeperStub().noteScope(t, s);
    return s;
  };

  it('held: skipped whole and counted; live twin fires; unsuspended: fires once', async () => {
    const held = await seat();
    const live = await seat();
    await host().setLifecycleLocal(held, { scope: 'suspended', tenant: 'active', at: instant.parse('2026-10-01T00:00:00.000Z'), revision: { epoch: 0, scope: 1, tenant: 1 } });
    const report = asReport(await sweeperStub().sweepNow());
    expect(report.errors).toEqual([]);
    expect(report.held).toBe(1);
    expect(await ticksOn(live)).toBe(1);

    await host().setLifecycleLocal(held, { scope: 'active', tenant: 'active', at: instant.parse('2026-10-01T00:01:00.000Z'), revision: { epoch: 0, scope: 2, tenant: 2 } });
    // Nothing fired while held: the schedule's first run is this pass, and only this one.
    expect(await ticksOn(held)).toBe(0);
    const resumed = asReport(await sweeperStub().sweepNow());
    expect(resumed.held ?? 0).toBe(0);
    expect(await ticksOn(held)).toBe(1);
    await sweeperStub().forgetScope(held);
    await sweeperStub().forgetScope(live);
    // Two full sweeps plus two provisions in workerd: ~4.3 s on CI before #2029, one past 5 s after.
  }, 15_000);

  it('a held tenant is skipped the same way', async () => {
    const s = await seat();
    await host().setLifecycleLocal(s, { scope: 'active', tenant: 'suspended', at: instant.parse('2026-10-01T00:00:00.000Z'), revision: { epoch: 0, scope: 1, tenant: 1 } });
    expect(asReport(await sweeperStub().sweepNow()).held).toBe(1);
    await host().setLifecycleLocal(s, { scope: 'active', tenant: 'active', at: instant.parse('2026-10-01T00:01:00.000Z'), revision: { epoch: 0, scope: 2, tenant: 2 } });
    asReport(await sweeperStub().sweepNow());
    expect(await ticksOn(s)).toBe(1);
    await sweeperStub().forgetScope(s);
  });
});
