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
  type ScopeDump,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type JobPassContext, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { expectAnswered, expectSettledUnknown, withEmptyOutcomeError, withRefusedOutcome, type AdminRowFault } from './switch-audit-fault.js';
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
  makeFixture: () => Promise<ScopeHostFixture & AdminRowFault>,
): void {
  describe(`schedule kill switch (#1666): ${adapterName}`, () => {
    let fixture: ScopeHostFixture & AdminRowFault;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const reason = 'incident: runaway tick';

    const newScope = async (tn: TenantId = t): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await provision(s, tn);
      await host.admin.activateScope(staff, tn, s);
      return s;
    };
    // `provisionScope` IS the reconcile on a CP-full host: it seats each schedule's
    // declared `system:` grant (#1659), and a re-run seats again.
    //
    // NO `vertical` (#1674 review): this suite exercises the switch and the status read
    // against the scope's OWN storage on both adapters, never through a hosted
    // deployment's delegation — that seam has its own dedicated fixture (the CF adapter's
    // `#1666`/`#1674` describe blocks, which configure a real `systemSwitchDelegation`). A
    // scope here naming a vertical it never actually has one served by would make
    // `systemGrantsStatus` correctly refuse (#1674 review: a hosted scope with no
    // delegation configured fails loudly rather than silently reading the CF host's own
    // placeholder DO) — the refusal this suite does not intend to exercise.
    const provision = (s: ScopeId, tn: TenantId = t) => host.provisionScope(staff, { tenantId: tn, scopeId: s });
    const off = (s: ScopeId, module = SCHED, tn: TenantId = t) =>
      host.admin.revokeFromSystem(staff, { moduleId: module, node: { tenantId: tn, scopeId: s }, reason });
    const on = (s: ScopeId, module = SCHED, tn: TenantId = t) =>
      host.admin.restoreToSystem(staff, { moduleId: module, node: { tenantId: tn, scopeId: s }, reason: 'resolved' });
    const ticks = async (s: ScopeId): Promise<number> =>
      (await (await host.getScope(reader, t, s)).invoke('sched/count')) as number;
    const grant = (s: ScopeId, key: string, module = SCHED, tn: TenantId = t) =>
      host.admin.grantToSystem(staff, {
        moduleId: module,
        permission: permissionKey.parse(key),
        node: { tenantId: tn, scopeId: s },
        grantedBy: staff,
      });
    const status = (s: ScopeId) => host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s });
    /** The error a call rejects with, or null when it resolved. */
    const refusal = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);
    const setupTenant = async (tn: TenantId, name: string) => {
      await host.admin.createTenant(staff, { id: tn, slug: `kill-${tn.slice(-10).toLowerCase()}`, name });
      await host.admin.grantEntitlement(staff, tn, 'sched');
      await host.admin.grantEntitlement(staff, tn, 'jobs');
    };

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
      await setupTenant(t, 'Kill switch');
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
        const e = await refusal(grant(s, key, module));
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
      expect(errorCodeOf(await refusal(on(s, stranger)))).toBe('not_found');
      // …and the module this scope does run is untouched by the attempt.
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES });
    });

    describe('an outcome row the log cannot take (#2089)', () => {
      const stranger = moduleId.parse('@test/not-held');
      const latestOperation = async (s: ScopeId, action: 'revokeFromSystem' | 'restoreToSystem') =>
        ((await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action, order: 'desc', limit: 1 }))[0]!.after as {
          operationId: string;
        }).operationId;

      it("a refusal whose row is refused still answers its own not_found, logs the operation, and the settle closes it unknown", async () => {
        const s = await newScope();
        const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'refused', () => off(s, stranger));
        // The switch's own error, never the log's: a refusal must not read as retryable.
        expect(settled.status).toBe('rejected');
        expect(errorCodeOf((settled as PromiseRejectedResult).reason)).toBe('not_found');
        expect(unrecorded).toEqual([
          { flow: 'system-switch', operationId: expect.any(String), phase: 'refused', auditError: expect.stringMatching(/test fault/) },
        ]);
        const operationId = unrecorded[0]!.operationId as string;
        expect(await latestOperation(s, 'revokeFromSystem')).toBe(operationId);
        await expectSettledUnknown(host, staff, { tenantId: t, scopeId: s, action: 'revokeFromSystem', operationId }, {
          moduleId: stranger,
          schedules: 'off',
        });
      });

      it('twin: the refusal row lands, nothing is logged, and the settle finds nothing to close', async () => {
        const s = await newScope();
        const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'applied', () => off(s, stranger));
        expect(errorCodeOf((settled as PromiseRejectedResult).reason)).toBe('not_found');
        expect(unrecorded).toEqual([]);
        const operationId = await latestOperation(s, 'revokeFromSystem');
        await expectAnswered(host, staff, { tenantId: t, scopeId: s, action: 'revokeFromSystem', operationId }, 'refused');
      });

      it('a failed directory write keeps its own error when its failed row is refused, and settles unknown', async () => {
        const s = await newScope();
        const liftRecord = await fixture.refuseSwitchRecord(s, 'system');
        try {
          const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'failed', () => off(s));
          expect(settled.status).toBe('rejected');
          expect(String((settled as PromiseRejectedResult).reason)).toMatch(/system switch record was refused/);
          expect(unrecorded).toEqual([
            { flow: 'system-switch', operationId: expect.any(String), phase: 'failed', auditError: expect.stringMatching(/test fault/) },
          ]);
          const operationId = unrecorded[0]!.operationId as string;
          expect(await latestOperation(s, 'revokeFromSystem')).toBe(operationId);
          await expectSettledUnknown(host, staff, { tenantId: t, scopeId: s, action: 'revokeFromSystem', operationId }, {
            moduleId: SCHED,
            schedules: 'off',
          });

          // Twin: the same directory error with a writable failed row has an answered intent.
          const twin = await withRefusedOutcome(fixture, s, 'applied', () => off(s));
          expect(String((twin.settled as PromiseRejectedResult).reason)).toMatch(/system switch record was refused/);
          expect(twin.unrecorded).toEqual([]);
          await expectAnswered(host, staff, {
            tenantId: t, scopeId: s, action: 'revokeFromSystem', operationId: await latestOperation(s, 'revokeFromSystem'),
          }, 'failed');
        } finally {
          await liftRecord();
        }
      });

      it('an empty outcome-write error still warns after the switch moves', async () => {
        const s = await newScope();
        const result = await withEmptyOutcomeError(() => off(s));
        expect(result.auditWarning).toBe('the switch completed, but its outcome could not be written to the admin log: ');
        expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
        await expectSettledUnknown(host, staff, { tenantId: t, scopeId: s, action: 'revokeFromSystem', operationId: result.operationId }, {
          moduleId: SCHED, schedules: 'off',
        });
      });

      it('a switch that moved but whose applied row is refused answers success with auditWarning, and the settle closes it unknown', async () => {
        const s = await newScope();
        const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'applied', () => off(s));
        expect(settled.status).toBe('fulfilled');
        const result = (settled as PromiseFulfilledResult<Awaited<ReturnType<typeof off>>>).value;
        // The switch is where the answer says: off, and the scope runs nothing.
        expect(result).toEqual({
          ...moved('off', true),
          permissions: ['sched:tick'],
          auditWarning: expect.stringMatching(/^the switch completed, but its outcome could not be written to the admin log: .*test fault/),
        });
        expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
        expect(unrecorded).toEqual([
          { flow: 'system-switch', operationId: result.operationId, phase: 'applied', auditError: expect.stringMatching(/test fault/) },
        ]);
        await expectSettledUnknown(host, staff, { tenantId: t, scopeId: s, action: 'revokeFromSystem', operationId: result.operationId }, {
          moduleId: SCHED,
          schedules: 'off',
        });

        // Twin: the restore's applied row lands — no warning, nothing to settle.
        const restored = await on(s);
        expect(restored).not.toHaveProperty('auditWarning');
        await expectAnswered(host, staff, { tenantId: t, scopeId: s, action: 'restoreToSystem', operationId: restored.operationId }, 'applied');
      });
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

    /**
     * The status read (#1674): `systemGrantsStatus`, over the SAME `systemScheduleState`
     * predicate `runDueSchedules` gates on — so a read that drifted onto its own idea of
     * "off" would fail this the moment it disagreed with what the runner actually did.
     */
    it('the status read agrees with the runner through on, off, and on again — and names who, when, why while off', async () => {
      const s = await newScope();
      expect(await status(s)).toEqual([{ moduleId: SCHED, schedules: 'on', switchedOff: null, recorded: null }]);
      expect((await host.runDueSchedules(SCHED, t, s)).switchedOff).toBeUndefined();

      const before = new Date().toISOString();
      await off(s);
      expect(await status(s)).toEqual([
        {
          moduleId: SCHED,
          schedules: 'off',
          switchedOff: { actor: staff, reason, at: expect.any(String) },
          recorded: 'off',
        },
      ]);
      const entries = await status(s);
      expect(entries[0]!.switchedOff!.at >= before).toBe(true);
      expect((await host.runDueSchedules(SCHED, t, s)).switchedOff).toBe(true);

      // A repeat OFF with a fresh reason re-asserts the explanation — the latest attempt
      // is what a status read owes, not the first one.
      await host.admin.revokeFromSystem(staff, {
        moduleId: SCHED,
        node: { tenantId: t, scopeId: s },
        reason: 'still investigating',
      });
      expect((await status(s))[0]!.switchedOff).toMatchObject({ actor: staff, reason: 'still investigating' });

      await on(s);
      expect(await status(s)).toEqual([{ moduleId: SCHED, schedules: 'on', switchedOff: null, recorded: 'on' }]);
      expect((await host.runDueSchedules(SCHED, t, s)).switchedOff).toBeUndefined();
    });

    it('a module with no schedules is absent from the read until it holds something, on or off', async () => {
      const s = await newScope();
      // JOBS declares no schedules, so provisioning seats it nothing — it holds no grant
      // and no marker, and the enumeration (unlike `ungranted`) reports nothing for it.
      expect(await status(s)).toEqual([{ moduleId: SCHED, schedules: 'on', switchedOff: null, recorded: null }]);

      await grant(s, 'jobs:write', JOBS);
      expect(await status(s)).toEqual(
        expect.arrayContaining([{ moduleId: JOBS, schedules: 'on', switchedOff: null, recorded: null }]),
      );

      await off(s, JOBS);
      const entries = await status(s);
      expect(entries.find((e) => e.moduleId === JOBS)).toEqual({
        moduleId: JOBS,
        schedules: 'off',
        switchedOff: { actor: staff, reason, at: expect.any(String) },
        recorded: 'off',
      });
      // The other module is untouched by JOBS's switch.
      expect(entries.find((e) => e.moduleId === SCHED)).toEqual({
        moduleId: SCHED,
        schedules: 'on',
        switchedOff: null,
        recorded: null,
      });
    });

    // -- the directory's record (#1674) --------------------------------------------------

    const records = (s: ScopeId) => host.admin.listSystemSwitches(staff, { tenantId: t, scopeId: s });
    /** The scope's storage, gone: an empty restore re-asserts the bare spine (#321). */
    const wipe = (s: ScopeId) =>
      host.restoreScope(staff, t, s, { tenantId: t, scopeId: s, capturedAt: new Date().toISOString(), tables: [] });
    const reassert = (s: ScopeId) => host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s });

    it('the record follows every move — off, on, off — and agrees with the per-scope read each time', async () => {
      const s = await newScope();
      expect(await records(s)).toEqual([]);

      const first = await off(s);
      expect(await records(s)).toEqual([
        {
          tenantId: t,
          scopeId: s,
          moduleId: SCHED,
          vertical: null,
          position: 'off',
          actor: staff,
          reason,
          operationId: first.operationId,
          at: expect.any(String),
        },
      ]);
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);

      const back = await on(s);
      expect(await records(s)).toEqual([
        expect.objectContaining({ position: 'on', reason: 'resolved', operationId: back.operationId }),
      ]);
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['on', 'on']]);

      const again = await off(s);
      expect(await records(s)).toEqual([
        expect.objectContaining({ position: 'off', reason, operationId: again.operationId }),
      ]);
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
    });

    it('the fleet read lists a switched-off scope, and drops it from `off` once restored', async () => {
      const a = await newScope();
      const b = await newScope();
      await off(a);
      await off(b);
      await on(b);
      const offHere = await host.admin.listSystemSwitches(staff, { tenantId: t, position: 'off' });
      expect(offHere.map((r) => r.scopeId)).toContain(a);
      expect(offHere.map((r) => r.scopeId)).not.toContain(b);
      const onHere = await host.admin.listSystemSwitches(staff, { tenantId: t, position: 'on' });
      expect(onHere.map((r) => r.scopeId)).toContain(b);
    });

    it('a refused switch records nothing — so no reconcile can switch off a module installed later', async () => {
      const s = await newScope();
      const stranger = moduleId.parse('@test/not-held');
      await off(s, stranger).catch(() => undefined);
      await on(s, stranger).catch(() => undefined);
      expect(await records(s)).toEqual([]);
      expect(await reassert(s)).toEqual([]);
    });

    it('a WIPED scope, re-provisioned, stays off: the seat recreates the grants, the record takes them back, ON returns them', async () => {
      const s = await newScope();
      await off(s);
      await wipe(s);
      // The storage no longer knows the switch was pulled; the directory still does.
      expect(await status(s)).toEqual([
        { moduleId: SCHED, schedules: 'ungranted', switchedOff: null, recorded: 'off' },
      ]);

      // The reconcile seats `sched:tick` live again (#1659: a missing tuple is created) —
      // and re-asserts OFF after it, so the schedules stay off.
      await provision(s);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
      const reasserted = await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] });
      expect(reasserted.map((e) => e.after)).toEqual([
        expect.objectContaining({ moduleId: SCHED, changed: true, permissions: ['sched:tick'] }),
      ]);
      // The explanation is still the operator's: the re-assert is its own action.
      expect((await status(s))[0]!.switchedOff).toMatchObject({ actor: staff, reason });

      // What OFF took from the freshly seated scope, ON gives back.
      expect(await on(s)).toEqual({ ...moved('on', true), permissions: ['sched:tick'] });
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });
    });

    it('a restore of a dump from BEFORE the switch lands switched off: the first pass after it runs nothing (#1742)', async () => {
      const s = await newScope();
      const before = await host.admin.exportScope(staff, t, s);
      await off(s);
      await host.restoreScope(staff, t, s, before);
      // The dump carried the grant live and no marker. The restore re-asserted the record in
      // its own unit, so there is no moment at which the scope says on — the very next pass,
      // with no re-assert call in between, runs nothing.
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
      // …and audited once, as the move it was.
      const rows = await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] });
      expect(rows.map((e) => e.after)).toEqual([
        expect.objectContaining({ moduleId: SCHED, changed: true, permissions: ['sched:tick'] }),
      ]);

      // Idempotent: the marker is live, so a later re-assert moves and audits nothing more.
      expect(await reassert(s)).toEqual([{ moduleId: SCHED, held: true, changed: false }]);
      expect(
        await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] }),
      ).toHaveLength(1);
      // What OFF took from the restored grants, ON gives back.
      expect(await on(s)).toEqual({ ...moved('on', true), permissions: ['sched:tick'] });
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });
    });

    /**
     * #1834: the restore puts the switch back for everything that acts through the system door,
     * not only the schedules. This host's rewind (the backup restore; a PITR rewind is the
     * Durable-Object plane's, pinned in the Cloudflare adapter's own #1819/#1834 block) brings the
     * job module's grant back live, and a job run started after it is still refused at the door.
     */
    it("a restore of a dump from BEFORE the switch keeps a job run of the module refused, until it is restored (#1834)", async () => {
      const s = await newScope();
      await grant(s, 'jobs:write', JOBS);
      const before = await host.admin.exportScope(staff, t, s);
      await off(s, JOBS);
      await host.restoreScope(staff, t, s, before);

      const run = await host.startJobRun(t, s, { moduleId: JOBS, job: 'record', instance: 'restored', payload: {} });
      const denied = await host.runDueJobs(t, s);
      expect(denied).toMatchObject({ completed: 0, retrying: 1 });
      const stalled = (await host.jobRuns(t, s)).find((r) => r.id === run.id);
      expect(stalled).toMatchObject({ status: 'running', lastError: expect.stringMatching(/jobs:write/) });
      expect((await (await host.getScope(reader, t, s)).invoke('jobs/items')) as string[]).toEqual([]);
      // The schedules beside it, unchanged: still on.
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });

      // The twin: restored, the same run's next pass records its item and completes.
      await on(s, JOBS);
      expect(await host.runDueJobs(t, s)).toMatchObject({ completed: 1 });
      expect((await (await host.getScope(reader, t, s)).invoke('jobs/items')) as string[]).toEqual(['one']);
    });

    /**
     * #1742 review: the restore's switch runs inside the replay's own transaction, on both
     * adapters. This was proven with a dump whose `_substrat_tuples` DDL carried a CHECK refusing
     * the OFF marker. Since #1883 a restore builds that table from the kernel's DDL, so a dump can
     * no longer make the switch throw: its CHECK never reaches the table, and the restore lands
     * switched off. The rollback itself is proven per adapter, with the fault injected at the
     * switch's own write (`adapter-cloudflare/test/contract.test.ts`,
     * `adapter-sqlite/test/restore-switch-rollback.test.ts`).
     */
    const refusingMarker = (dump: ScopeDump): ScopeDump => ({
      ...dump,
      tables: dump.tables.map((tbl) =>
        tbl.name === '_substrat_tuples'
          ? { ...tbl, ddl: tbl.ddl.replace(/\)\s*$/, ", CHECK (relation <> 'switch:off'))") }
          : tbl,
      ),
    });

    it('a dump whose tuples DDL refuses the OFF marker cannot reach the kernel table: the restore lands off (#1742, #1883)', async () => {
      const s = await newScope();
      const before = refusingMarker(await host.admin.exportScope(staff, t, s));
      expect(before.tables.find((tbl) => tbl.name === '_substrat_tuples')?.ddl).toMatch(/CHECK \(relation <> 'switch:off'\)/);
      await off(s);
      await host.restoreScope(staff, t, s, before);
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      const tuples = (await host.admin.exportScope(staff, t, s)).tables.find((tbl) => tbl.name === '_substrat_tuples');
      expect(tuples?.ddl).not.toMatch(/CHECK/);
    });

    it('twin: the same dump with nothing recorded off restores, and fires', async () => {
      const s = await newScope();
      const before = refusingMarker(await host.admin.exportScope(staff, t, s));
      await off(s);
      await on(s); // recorded `on`: nothing for the restore to switch
      await host.restoreScope(staff, t, s, before);
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });
    });

    it('a restore with nothing recorded off lands on, and fires (#1742, the twin)', async () => {
      const s = await newScope();
      const before = await host.admin.exportScope(staff, t, s);
      await off(s);
      await on(s); // recorded `on`: nothing for the restore to put back
      await host.restoreScope(staff, t, s, before);
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });
    });

    /**
     * #1742 review: the list a deployment applies is read BEFORE the call, so an operator's
     * `restoreToSystem` can land in between. The deployment then switches the module off from
     * a stale list, and the re-assert after it finds the record `on`. Here the deployment's
     * stale move is played by a restore of a dump taken while the module was off (the marker
     * rides it), and its report is handed to the re-assert as the deployment would.
     */
    const staleScope = async () => {
      const s = await newScope();
      await off(s);
      const whileOff = await host.admin.exportScope(staff, t, s);
      await on(s); // the operator's ON: record `on`, scope on
      await host.restoreScope(staff, t, s, whileOff); // the stale list, applied: off again
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      return s;
    };
    const staleRows = async (s: ScopeId) =>
      (await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] })).map((e) => e.after);

    it("a stale list's move is undone: the operator's ON stands, and the revert is audited (#1742 review)", async () => {
      const s = await staleScope();
      const reported = [{ moduleId: SCHED, changed: true, permissions: ['sched:tick'] }];
      expect(await host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s }, { appliedInUnit: reported })).toEqual([]);
      expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: SCHEDULES, failed: 0 });
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['on', 'on']]);
      expect(await staleRows(s)).toEqual([
        expect.objectContaining({ moduleId: SCHED, schedules: 'on', changed: true, staleCarry: true, permissions: ['sched:tick'] }),
      ]);
    });

    it('twin: with no in-unit move reported, a record of `on` still never turns a module on', async () => {
      const s = await staleScope();
      expect(await host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s })).toEqual([]);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      expect(await staleRows(s)).toEqual([]);
    });

    it('twin: a reported move on a module still recorded OFF is kept off, never reverted', async () => {
      const s = await newScope();
      await off(s);
      const reported = [{ moduleId: SCHED, changed: true, permissions: ['sched:tick'] }];
      expect(await host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s }, { appliedInUnit: reported })).toEqual([
        { moduleId: SCHED, held: true, changed: false },
      ]);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
      expect(await staleRows(s)).toEqual([expect.objectContaining({ moduleId: SCHED, schedules: 'off', inUnit: true })]);
    });

    it("the re-assert in a provision or a restore reaches only that scope's own switch (#1742)", async () => {
      const a = await newScope();
      const b = await newScope();
      const beforeA = await host.admin.exportScope(staff, t, a);
      await off(a);
      await wipe(a);
      await provision(a); // seats a's grants and switches them off in the same unit
      await host.restoreScope(staff, t, a, beforeA); // …and again for the restore
      expect(await host.runDueSchedules(SCHED, t, a)).toEqual(switchedOff);
      // b was never switched off, and neither of a's units touched it.
      expect((await status(b)).map((e) => [e.schedules, e.recorded])).toEqual([['on', null]]);
      expect(await host.runDueSchedules(SCHED, t, b)).toMatchObject({ fired: SCHEDULES, failed: 0 });
    });

    it('a REFUSED restore leaves the record off, so the next reconcile still switches the module off (#1674 review)', async () => {
      const s = await newScope();
      await off(s);
      await wipe(s);
      // The wiped scope holds nothing for the module, so the restore is refused…
      const refused = await refusal(on(s));
      expect(errorCodeOf(refused)).toBe('not_found');
      // …and the record it wrote ahead of the move is put back: still off, still the incident.
      expect(await records(s)).toEqual([expect.objectContaining({ position: 'off', reason })]);
      await provision(s);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
    });

    it('a deleted preview and a reaped scope leave the fleet read (#1674 review)', async () => {
      const preview = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: preview, kind: 'preview' });
      await host.admin.activateScope(staff, t, preview);
      await off(preview);
      const reaped = await newScope();
      await off(reaped);
      const listed = async () =>
        (await host.admin.listSystemSwitches(staff, { tenantId: t })).map((r) => r.scopeId);
      expect(await listed()).toEqual(expect.arrayContaining([preview, reaped]));

      await host.deleteSnapshot(staff, t, preview);
      await host.admin.archiveScope(staff, t, reaped);
      await host.admin.reapScope(staff, t, reaped, { force: true });
      expect(await listed()).not.toContain(preview);
      expect(await listed()).not.toContain(reaped);
    });

    it('a record never turns a module ON: a live marker beside a record of `on` stays off', async () => {
      const s = await newScope();
      await off(s);
      const whileOff = await host.admin.exportScope(staff, t, s);
      await on(s);
      await host.restoreScope(staff, t, s, whileOff);
      // The dump brought the marker back; the record says on. The marker wins.
      expect((await status(s)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'on']]);
      expect(await reassert(s)).toEqual([]);
      await provision(s);
      expect(await host.runDueSchedules(SCHED, t, s)).toEqual(switchedOff);
    });

    // #1743: a TENANT-level grant reaches every scope of the tenant, so it is refused while
    // the directory records the module off on any of them. Each case gets its own tenant: a
    // tenant tuple would otherwise reach every other case's scopes in `t`.
    const newTenant = async () => {
      const tenant = tenantId.parse(ulid());
      await setupTenant(tenant, 'Kill switch, tenant-level');
      return {
        tenant,
        scope: () => newScope(tenant),
        off: (s: ScopeId, module = SCHED) => off(s, module, tenant),
        on: (s: ScopeId, module = SCHED) => on(s, module, tenant),
        grant: (key: string, module = SCHED) =>
          host.admin.grantToSystem(staff, {
            moduleId: module,
            permission: permissionKey.parse(key),
            node: { tenantId: tenant, scopeId: null },
            grantedBy: staff,
          }),
      };
    };

    it('a tenant-level grant is refused while ANY scope holds the module off, naming each one (#1743)', async () => {
      const tn = await newTenant();
      const a = await tn.scope();
      const b = await tn.scope();
      await tn.scope(); // a third scope, left on: one scope off is enough to refuse
      await tn.off(a);
      await tn.off(b);

      const e = await refusal(tn.grant('sched:admin'));
      expect(errorCodeOf(e)).toBe('conflict');
      // The scope-level refusal's wording, naming every scope that holds it off.
      expect(String(e)).toMatch(/switched off on scopes .* restore it first/);
      expect(String(e)).toContain(a);
      expect(String(e)).toContain(b);
      expect(String(e)).toMatch(/tenant-level grant reaches every scope/);

      // Restoring one is not enough; the refusal now names only the other.
      await tn.on(a);
      const still = await refusal(tn.grant('sched:admin'));
      expect(errorCodeOf(still)).toBe('conflict');
      expect(String(still)).toMatch(new RegExp(`switched off on scope ${b} `));
      expect(String(still)).not.toContain(a);

      // The twin: every scope restored, the same grant is accepted, and audited.
      await tn.on(b);
      await tn.grant('sched:admin');
      const audit = await host.admin.auditLog(staff, { tenantId: tn.tenant, action: ['grantToSystem'] });
      expect(audit.map((r) => (r.after as { permission: string }).permission)).toEqual(['sched:admin']);
    });

    it('twin: the refusal is keyed on the module and the tenant, never wider (#1743)', async () => {
      const tn = await newTenant();
      const s = await tn.scope();
      await tn.grant('jobs:write', JOBS); // a scope-less grant of another module is untouched…
      await tn.off(s);
      // …and so is one made while SCHED is off: the switch names one module.
      await tn.grant('jobs:admin', JOBS);
      // Another tenant's switch reaches nothing here, and this tenant's reaches nothing there.
      const other = await newTenant();
      await other.grant('sched:admin');
      expect(errorCodeOf(await refusal(tn.grant('sched:admin')))).toBe('conflict');
    });

    it('the race, sequentially: whichever answers first, no tenant-level grant lands after OFF answered (#1743)', async () => {
      // OFF writes the directory record before the scope moves (#1823), and the tenant grant
      // reads that record in the unit that writes the tuple. So a grant issued after OFF answered
      // is refused, and a switch that lands after a grant answered makes the NEXT one refused.
      const tn = await newTenant();
      const s = await tn.scope();
      await tn.grant('sched:admin'); // before the switch: accepted
      await tn.off(s);
      expect(errorCodeOf(await refusal(tn.grant('sched:admin')))).toBe('conflict'); // the re-grant
      expect(errorCodeOf(await refusal(tn.grant('sched:tick')))).toBe('conflict'); // a new one
      // Only the one grant made before the switch was written.
      const audit = await host.admin.auditLog(staff, { tenantId: tn.tenant, action: ['grantToSystem'] });
      expect(audit).toHaveLength(1);
    });

    it('an ARCHIVED scope switched off still holds a tenant-level grant back; a reaped one no longer does (#1743)', async () => {
      const tn = await newTenant();
      const s = await tn.scope();
      await tn.off(s);
      expect(errorCodeOf(await refusal(tn.grant('sched:admin')))).toBe('conflict');
      // Archived is reversible (unarchive brings the scope back, switch and all), and the
      // record is forgotten only on reap, so an archived scope still blocks.
      await host.admin.archiveScope(staff, tn.tenant, s);
      const archived = await refusal(tn.grant('sched:admin'));
      expect(errorCodeOf(archived)).toBe('conflict');
      expect(String(archived)).toContain(s);
      await host.admin.reapScope(staff, tn.tenant, s, { force: true });
      await tn.grant('sched:admin');
    });

    // #1823: a tenant-level system grant that ALREADY exists when a scope is switched off is
    // not tombstoned by OFF (OFF reaches only the scope's own `granted:` tuples), and on the
    // Durable-Object adapter it is also projected into every scope. The evaluator reads the
    // scope's OFF marker before any tuple, so the grant gives the module nothing THERE.
    it('a pre-existing tenant-level grant gives a switched-off module no authority on that scope, and no other (#1823)', async () => {
      const tn = await newTenant();
      const s = await tn.scope();
      const elsewhere = await tn.scope();
      await tn.grant('sched:tick');
      await tn.grant('jobs:write', JOBS);
      // JOBS declares no schedule, so nothing seats it at the scope: a scope-level grant of a
      // permission the job never checks is what gives the scope something of JOBS to switch.
      await grant(s, 'jobs:admin', JOBS, tn.tenant);
      await tn.off(s);
      await tn.off(s, JOBS);
      const tick = async (scope: ScopeId) => (await host.getSystemScope(SCHED, tn.tenant, scope)).invoke('sched/tick');
      const items = async (scope: ScopeId) =>
        (await (await host.getScope(reader, tn.tenant, scope)).invoke('jobs/items')) as string[];

      expect(await host.runDueSchedules(SCHED, tn.tenant, s)).toEqual(switchedOff);
      await expect(tick(s)).rejects.toThrow(/sched:tick/);
      const run = await host.startJobRun(tn.tenant, s, { moduleId: JOBS, job: 'record', instance: 'tenant', payload: {} });
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBe(0);
      expect((await host.jobRuns(tn.tenant, s)).find((r) => r.id === run.id)?.lastError).toMatch(/jobs:write/);
      expect(await items(s)).toEqual([]);

      // The switch names one scope: the same tenant grant still works on the scope left on.
      await tick(elsewhere);

      // A re-projection of the tenant's tuples does not bring it back: a tenant-level write
      // fans the projection out to every scope, and a reconcile re-projects this one.
      await host.admin.grantEntitlement(staff, tn.tenant, 'reproject');
      await provision(s, tn.tenant);
      await expect(tick(s)).rejects.toThrow(/sched:tick/);
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBe(0);
      expect(await host.runDueSchedules(SCHED, tn.tenant, s)).toEqual(switchedOff);

      // The twin: restored, the tenant grant reaches the scope again, and the stalled run completes.
      await tn.on(s);
      await tn.on(s, JOBS);
      await tick(s);
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBe(1);
      expect(await items(s)).toEqual(['one']);
    });

    // #1823, the next case along: a module whose ONLY authority on a scope is a tenant-level
    // grant has nothing in the scope's storage. OFF still holds it (the directory says the
    // tenant grants it), writes the marker, and the evaluator denies the module there.
    it('a module held only by a tenant-level grant can be switched off on one scope, and back on (#1823)', async () => {
      const tn = await newTenant();
      const s = await tn.scope();
      const elsewhere = await tn.scope();
      await tn.grant('jobs:write', JOBS); // JOBS declares no schedule: nothing is seated at either scope
      const items = async (scope: ScopeId) =>
        (await (await host.getScope(reader, tn.tenant, scope)).invoke('jobs/items')) as string[];
      const offJobs = await tn.off(s, JOBS);
      expect(offJobs).toMatchObject({ moduleId: JOBS, schedules: 'off', changed: true, permissions: [] });
      expect(await host.admin.listSystemSwitches(staff, { scopeId: s })).toEqual([
        expect.objectContaining({ moduleId: JOBS, position: 'off' }),
      ]);
      expect((await tn.off(s, JOBS)).changed).toBe(false); // a repeat holds, and moves nothing

      const run = await host.startJobRun(tn.tenant, s, { moduleId: JOBS, job: 'record', instance: 'only-tenant', payload: {} });
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBe(0);
      expect((await host.jobRuns(tn.tenant, s)).find((r) => r.id === run.id)?.lastError).toMatch(/jobs:write/);
      expect(await items(s)).toEqual([]);
      // The scope left on still runs the module on the same tenant grant.
      await host.startJobRun(tn.tenant, elsewhere, { moduleId: JOBS, job: 'record', instance: 'only-tenant', payload: {} });
      expect((await host.runDueJobs(tn.tenant, elsewhere)).completed).toBe(1);

      // Restore is the lever: ON takes the marker back, the tenant grant reaches the scope again.
      expect(await tn.on(s, JOBS)).toMatchObject({ schedules: 'on', changed: true, permissions: [] });
      expect((await tn.on(s, JOBS)).changed).toBe(false); // still held — by the tenant grant
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBe(1);
      expect(await items(s)).toEqual(['one']);
    });

    it('a restore of a dump from before the switch puts a tenant-held module back off (#1823)', async () => {
      const tn = await newTenant();
      const s = await tn.scope();
      await tn.grant('jobs:write', JOBS);
      const before = await host.admin.exportScope(staff, tn.tenant, s); // no marker in it
      await tn.off(s, JOBS);
      await host.restoreScope(staff, tn.tenant, s, before);
      await host.startJobRun(tn.tenant, s, { moduleId: JOBS, job: 'record', instance: 'restored', payload: {} });
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBe(0);
      // The twin: with nothing recorded off, the same restore leaves the module running.
      await tn.on(s, JOBS);
      await host.restoreScope(staff, tn.tenant, s, before);
      await host.startJobRun(tn.tenant, s, { moduleId: JOBS, job: 'record', instance: 'restored-on', payload: {} });
      expect((await host.runDueJobs(tn.tenant, s)).completed).toBeGreaterThan(0);
    });

    it('twin: a module with no grant at the scope AND none for the tenant is still refused as never held (#1823)', async () => {
      const tn = await newTenant();
      const s = await tn.scope();
      expect(errorCodeOf(await refusal(tn.off(s, JOBS)))).toBe('not_found');
      expect(await host.admin.listSystemSwitches(staff, { scopeId: s })).toEqual([]);
      // …and a tenant grant of ANOTHER module does not make this one held.
      await tn.grant('sched:admin');
      expect(errorCodeOf(await refusal(tn.off(s, JOBS)))).toBe('not_found');
    });
  });
}
