import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isPlatformRequest, moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { SCHED_REQUEST_KIND, schedRequestMod } from './modules.js';

const SCHED_REQUEST = moduleId.parse('@test/sched-request');

/**
 * Contract suite for #2431: a scheduled pass REPORTS the platform requests its fires enqueued, so
 * the sweep that ran it can drain the scope in the same pass instead of leaving them a sweep
 * interval. Both adapters must count what an invoke's `onPlatformRequests` counts: what
 * committed, and nothing a rolled-back fire enqueued.
 *
 * `runDueSchedules` is called directly, never a sweep, so registering this module changes no
 * other suite's fired/skipped counts, and the shared directory is safe.
 */
export function schedulePlatformRequestsContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`a scheduled pass reports the platform requests it enqueued (#2431): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(schedRequestMod);
      await host.admin.createTenant(staff, { id: t, slug: `sched-request-${t.toLowerCase()}`, name: 'Scheduled requests' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      // Seats the schedules' declared permission on the module's system principal.
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-request-vertical' });
      await host.admin.activateScope(staff, t, s);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    const queued = async () =>
      (await host.listPlatformRequests(t, s))
        .filter(isPlatformRequest)
        .filter((r) => r.kind === SCHED_REQUEST_KIND)
        .map((r) => (r.payload as { n: number }).n)
        .sort();

    it('counts the requests the fires committed, and none a rolled-back fire enqueued', async () => {
      const report = await host.runDueSchedules(SCHED_REQUEST, t, s);
      expect(report).toMatchObject({ fired: 1, failed: 1, platformRequests: 2 });
      // The journal agrees: the two that committed wait for the drain; the third went with its rollback.
      expect(await queued()).toEqual([1, 2]);
    });

    it('a pass that fires nothing reports no count', async () => {
      // Both schedules are inside their cadence window now.
      const report = await host.runDueSchedules(SCHED_REQUEST, t, s);
      expect(report).toMatchObject({ fired: 0, failed: 0, skipped: 2 });
      expect(report.platformRequests).toBeUndefined();
      expect(await queued()).toEqual([1, 2]);
    });
  });
}
