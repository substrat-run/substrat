import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, type JobPassContext, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { jobsMod, scheduleMod } from './modules.js';

const SCHED = moduleId.parse('@test/sched');
const JOBS = moduleId.parse('@test/jobs');
/** Both of `scheduleMod`'s schedules — `sched/tick` and #1288's `freshness:sched.ticked`. */
const SCHEDULES = 2;

/**
 * The schedule kill switch (#1666), against both adapters — `revokeFromSystem` turns one
 * module's scheduled work off on one scope, `restoreToSystem` turns it back on, and the
 * gate both adapters run is the kernel's `systemScheduleState`.
 *
 * Every scope here is NEW and its schedules have never run, so each one is due the moment
 * it exists. That is what makes a `skipped` evidence of the switch rather than of a
 * cadence window, and what lets the restore half assert a fire on the very next pass.
 *
 * `runDueSchedules` is called directly rather than through `runPlatformSweep`: the sweep
 * enumerates every active scope in the directory, and on the Cloudflare mount that is
 * every suite's scope in one shared control plane (#1591).
 */
export function systemSwitchContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`schedule kill switch (#1666): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const reason = 'incident: runaway tick';

    const newScope = async (): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await provision(s);
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    // `provisionScope` IS the reconcile on a CP-full host: it seats each schedule's
    // declared `system:` grant (#1659), and a re-run seats again.
    const provision = (s: ScopeId) => host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    const off = (s: ScopeId, module = SCHED) =>
      host.admin.revokeFromSystem(staff, { moduleId: module, node: { tenantId: t, scopeId: s }, reason });
    const on = (s: ScopeId, module = SCHED) =>
      host.admin.restoreToSystem(staff, { moduleId: module, node: { tenantId: t, scopeId: s }, reason: 'resolved' });
    const ticks = async (s: ScopeId): Promise<number> =>
      (await (await host.getScope(reader, t, s)).invoke('sched/count')) as number;
    const grant = (s: ScopeId, key: string, module = SCHED) =>
      host.admin.grantToSystem(staff, {
        moduleId: module,
        permission: permissionKey.parse(key),
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });

    /** What a switch call answers, less its permissions — the operation id is per call. */
    const moved = (schedules: 'on' | 'off', changed: boolean) => ({
      operationId: expect.any(String),
      moduleId: SCHED,
      schedules,
      changed,
    });

    /** The switched-off report: nothing ran, every schedule skipped, and it says why. */
    const switchedOff = {
      fired: 0,
      skipped: SCHEDULES,
      failed: 0,
      errors: [],
      switchedOff: true,
      runs: [
        { operation: 'sched/tick', outcome: 'skipped' },
        { operation: 'freshness:sched.ticked', outcome: 'skipped' },
      ],
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(scheduleMod);
      host.registerModule(jobsMod);
      host.registerJob(
        JOBS,
        'record',
        async (pass: JobPassContext) => {
          const scope = await pass.scope();
          await pass.step('one', () => scope.invoke('jobs/record', { item: 'one' }));
          return { done: true };
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      );
      await host.admin.createTenant(staff, { id: t, slug: `kill-${t.slice(-10).toLowerCase()}`, name: 'Kill switch' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await host.admin.grantEntitlement(staff, t, 'jobs');
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('a switched-off module fires nothing, reports skipped (never failed), and survives a reconcile', async () => {
      const s = await newScope();
      const result = await off(s);
      expect(result).toEqual({ ...moved('off', true), permissions: ['sched:tick'] });

      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      expect(await ticks(s)).toBe(0);

      // The reconcile #1659 made safe: it seats, so it leaves the tombstone — and the
      // marker is not a grant, so it has nothing to seat there either.
      await provision(s);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      expect(await ticks(s)).toBe(0);

      // Restore is the lever. The cadence clock was never touched, so the schedules are
      // due on the very next pass — not an hour after the switch was pulled.
      expect(await on(s)).toEqual({ ...moved('on', true), permissions: ['sched:tick'] });
      const report = await host.runDueSchedules(SCHED, t, s);
      expect(report).toMatchObject({ fired: SCHEDULES, skipped: 0, failed: 0, errors: [] });
      expect(report.switchedOff).toBeUndefined();
      expect(await ticks(s)).toBe(1);
    });

    it('OFF holds: a regrant is refused, a reconcile seats nothing, and an invoke and a job with the authority are denied', async () => {
      const s = await newScope();
      await grant(s, 'jobs:write', JOBS);
      await off(s);
      await off(s, JOBS);
      const refusedGrant = async (key: string, module = SCHED) => {
        const e = await grant(s, key, module).then(() => null, (err: unknown) => err);
        expect(errorCodeOf(e)).toBe('conflict');
        expect(String(e)).toMatch(/switched off .* restore it first/);
      };

      // A grant is not the lever: a stray `grantToSystem` is REFUSED while the switch is
      // off — the revoked permission, a permission the scope never held, and the job
      // module's — rather than handing the system authority back to anything but the
      // schedules. (#1659's re-grant guarantee still holds while the switch is on.)
      await refusedGrant('sched:tick');
      await refusedGrant('sched:admin');
      await refusedGrant('jobs:write', JOBS);

      // A reconcile seats nothing for a switched-off module (its seat checks the marker).
      await provision(s);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);

      // Nothing acting with the module's system authority gets through: a direct invoke
      // through the system door, and a resumable job run.
      await expect((await host.getSystemScope(SCHED, t, s)).invoke('sched/tick')).rejects.toThrow(/sched:tick/);
      const run = await host.startJobRun(t, s, { moduleId: JOBS, job: 'record', instance: 'hold', payload: {} });
      expect((await host.runDueJobs(t, s)).completed).toBe(0);
      expect((await host.jobRuns(t, s)).find((r) => r.id === run.id)?.lastError).toMatch(/jobs:write/);
      expect(await ticks(s)).toBe(0);

      // The twin: restored, everything works again — the grant is accepted, the invoke
      // and the job succeed, and the schedules fire.
      await on(s);
      await on(s, JOBS);
      await grant(s, 'sched:admin');
      await (await host.getSystemScope(SCHED, t, s)).invoke('sched/tick');
      expect(await ticks(s)).toBe(1);
      expect((await host.runDueJobs(t, s)).completed).toBe(1);
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });
      expect(await ticks(s)).toBe(2);
    });

    it('is idempotent both ways, and EVERY attempt is audited — intent first, then outcome — a repeat included', async () => {
      const s = await newScope();
      const calls = [
        await on(s), // a no-op: already on
        await off(s),
        await off(s), // a repeat — the retry after an audit-then-crash looks exactly like this
        await on(s),
      ];
      expect(calls.map((r) => [r.schedules, r.changed])).toEqual([
        ['on', false],
        ['off', true],
        ['off', false],
        ['on', true],
      ]);

      const log = await host.admin.auditLog(staff, {
        tenantId: t,
        scopeId: s,
        action: ['revokeFromSystem', 'restoreToSystem'],
      });
      const rows = log.map((e) => ({ action: e.action, actor: e.actor, ...(e.after as Record<string, unknown>) }));
      // Two rows per call, paired by the operation id the call answered with.
      expect(rows).toEqual(
        calls.flatMap((r, i) => {
          const action = r.schedules === 'off' ? 'revokeFromSystem' : 'restoreToSystem';
          const common = { action, actor: staff, operationId: r.operationId, moduleId: SCHED, schedules: r.schedules };
          return [
            { ...common, phase: 'intent', reason: r.schedules === 'off' ? reason : 'resolved' },
            { ...common, phase: 'applied', changed: r.changed, permissions: i === 1 || i === 3 ? ['sched:tick'] : [] },
          ];
        }),
      );
    });

    it('refuses a module the scope never held — and writes nothing, so nothing is left switched off', async () => {
      const s = await newScope();
      const stranger = moduleId.parse('@test/not-held');
      const refused = await off(s, stranger).then(
        () => null,
        (e: unknown) => e,
      );
      expect(errorCodeOf(refused)).toBe('not_found');
      expect(String(refused)).toMatch(/holds no system grant for module '@test\/not-held'/);
      // Had the refusal written a marker, the scope would now "hold" the module and the
      // restore would answer. It refuses the same way, so nothing was written.
      expect(errorCodeOf(await on(s, stranger).then(() => null, (e: unknown) => e))).toBe('not_found');
      // …and the module this scope does run is untouched by the attempt.
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES });
    });

    it('refuses a scope of another tenant as unknown', async () => {
      const s = await newScope();
      const refused = await host.admin
        .revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: tenantId.parse(ulid()), scopeId: s }, reason })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(errorCodeOf(refused)).toBe('not_found');
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES });
    });

    it('refuses a switch with no reason', async () => {
      const s = await newScope();
      await expect(
        host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: '  ' }),
      ).rejects.toThrow();
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES });
    });

    it("a job run acting with the module's authority is denied while the switch is off, and proceeds once restored", async () => {
      const s = await newScope();
      await grant(s, 'jobs:write', JOBS);
      await off(s, JOBS);

      const run = await host.startJobRun(t, s, { moduleId: JOBS, job: 'record', instance: 'x', payload: {} });
      const denied = await host.runDueJobs(t, s);
      expect(denied.completed).toBe(0);
      const stalled = (await host.jobRuns(t, s)).find((r) => r.id === run.id);
      expect(stalled?.status).not.toBe('completed');
      expect(stalled?.lastError).toMatch(/jobs:write/);
      expect((await (await host.getScope(reader, t, s)).invoke('jobs/items')) as string[]).toEqual([]);

      // The twin: restored, the same run's next pass records its item and completes.
      await on(s, JOBS);
      const resumed = await host.runDueJobs(t, s);
      expect(resumed.completed).toBe(1);
      expect((await (await host.getScope(reader, t, s)).invoke('jobs/items')) as string[]).toEqual(['one']);
    });
  });
}
