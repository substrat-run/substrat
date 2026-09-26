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
    //
    // NO `vertical` (#1674 review): this suite exercises the switch and the status read
    // against the scope's OWN storage on both adapters, never through a hosted
    // deployment's delegation — that seam has its own dedicated fixture (the CF adapter's
    // `#1666`/`#1674` describe blocks, which configure a real `systemSwitchDelegation`). A
    // scope here naming a vertical it never actually has one served by would make
    // `systemGrantsStatus` correctly refuse (#1674 review: a hosted scope with no
    // delegation configured fails loudly rather than silently reading the CF host's own
    // placeholder DO) — the refusal this suite does not intend to exercise.
    const provision = (s: ScopeId) => host.provisionScope(staff, { tenantId: t, scopeId: s });
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
    const status = (s: ScopeId) => host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s });

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
      const refused = await on(s).then(() => null, (e: unknown) => e);
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
  });
}
