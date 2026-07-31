import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { moduleId, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { scheduleMod } from './modules.js';

const SCHED_MODULE = moduleId.parse('@test/sched');
// Never called: the sweep runs no connector sweepers here. A throwing stub proves it.
const noFetch = (() => {
  throw new Error('fetch should not be called by the schedule phase');
}) as unknown as FetchLike;

/**
 * Contract suite for vertical-declared recurring schedules (#383). Both adapters
 * must: fire a due schedule under a system actor, gate re-runs by cadence, and let
 * `ctx.check` (not a bypass) decide what the schedule may do.
 */
export function scheduleContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`schedule contract (#383): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const sweep = () =>
      runPlatformSweep(host, {
        actor: staff,
        fetch: noFetch,
        sweepers: {},
        // Isolate the schedule phase — every other phase off.
        drainRetries: false,
        gcSnapshots: false,
        reconcileMigrations: false,
      });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(scheduleMod);
      await host.admin.createTenant(staff, { id: t, slug: 'sched', name: 'Sched' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      // provisionScope projects the schedule's declared permission to the system
      // principal — no explicit grant needed here; that IS the seam under test.
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
      await host.admin.activateScope(staff, t, s);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('fires a due schedule and attributes it to the system actor', async () => {
      const report = await sweep();
      expect(report.schedules).not.toBeNull();
      expect(report.schedules!.fired).toBe(1);
      expect(report.errors).toEqual([]);

      // The operation ran exactly once, and its emitted event reads as the module,
      // never a person — the attribution the whole issue is about.
      const stub = await host.getScope(reader, t, s);
      expect(await stub.invoke('sched/count')).toBe(1);
      const outbox = (await stub.invoke('sched/read-outbox')) as { type: string; actor: string }[];
      const tick = outbox.find((r) => r.type === 'sched.ticked');
      expect(tick).toBeDefined();
      expect(JSON.parse(tick!.actor)).toEqual({ system: '@test/sched' });
    });

    it('skips a schedule still inside its cadence window', async () => {
      const report = await sweep();
      expect(report.schedules!.fired).toBe(0);
      expect(report.schedules!.skipped).toBe(1);
      // Still one tick — the second pass did not re-run it.
      const stub = await host.getScope(reader, t, s);
      expect(await stub.invoke('sched/count')).toBe(1);
      const state = (await stub.invoke('sched/schedule-state')) as {
        schedule_op: string;
        last_status: string;
      }[];
      expect(state).toEqual([{ schedule_op: 'sched/tick', last_status: 'ok' }]);
    });

    it('lets ctx.check gate what the schedule may do — an ungranted op is denied', async () => {
      // The system principal holds `sched:tick` (scheduled) but NOT `sched:admin`
      // (declared, never scheduled). Invoked through the system door, an op that
      // checks the ungranted permission is refused — proving the door resolves real
      // grants, not an override bypass.
      const sys = await host.getSystemScope(SCHED_MODULE, t, s);
      await expect(sys.invoke('sched/needs-admin')).rejects.toThrow();
    });

    it('refuses a system scope for an unregistered module', async () => {
      await expect(
        host.getSystemScope(moduleId.parse('@test/not-registered'), t, s),
      ).rejects.toThrow(/not registered/);
    });
  });
}
