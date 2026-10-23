import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  isPlatformRequest,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import type { RawScopeSql } from './entity-state-suite.js';
import { SCHED_REQUEST_KIND, schedRequestMod } from './modules.js';
import {
  PURGE_REQUEST_DAYS,
  PURGE_REQUEST_KIND,
  PURGE_REQUEST_MODULE_ID,
  QUIET_PURGE_ROW,
  purgeRequestMod,
} from './schedule-purge-request-module.js';

const SCHED_REQUEST = moduleId.parse('@test/sched-request');
const PURGE_REQUEST = moduleId.parse(PURGE_REQUEST_MODULE_ID);
const DAY = 86_400_000;

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
  /** Runs SQL against a scope's own storage — to age a binned row past its purge horizon. */
  raw: RawScopeSql,
): void {
  describe(`a scheduled pass reports the platform requests it enqueued (#2431): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(schedRequestMod);
      host.registerModule(purgeRequestMod);
      await host.admin.createTenant(staff, { id: t, slug: `sched-request-${t.toLowerCase()}`, name: 'Scheduled requests' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      // Seats the schedules' declared permission on the module's system principal.
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-request-vertical' });
      await host.admin.activateScope(staff, t, s);
      const keys = ['purgereq:write', 'purgereq:trash'].map((k) => permissionKey.parse(k));
      await host.admin.defineRole(staff, t, { key: 'purger', permissions: keys, source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'purger', node: { tenantId: t, scopeId: null } });
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

    describe('a purge horizon (#2440)', () => {
      /** A new primary scope, so the schedule's cadence row starts empty. */
      const freshScope = async (): Promise<ScopeId> => {
        const fresh = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t, scopeId: fresh, vertical: 'sched-request-vertical' });
        await host.admin.activateScope(staff, t, fresh);
        return fresh;
      };
      /** `names.length` rows, binned and aged past the horizon, so one pass purges them all. */
      const dueRows = async (fresh: ScopeId, names: string[]): Promise<void> => {
        const stub = await host.getScope(alice, t, fresh);
        const at = new Date(Date.now() - (PURGE_REQUEST_DAYS + 1) * DAY).toISOString();
        for (const [n, name] of names.entries()) {
          const id = `row-${n}-${ulid()}`;
          await stub.invoke('purgereq/add', { id, name });
          await stub.invoke('purgereq/trash', { rowId: id });
          await raw(t, fresh, `INSERT INTO _substrat_state_moves (entity_type, entity_id) VALUES (?, ?)`, ['preq', id]);
          await raw(t, fresh, `UPDATE purgereq_rows SET _substrat_trashed_at = ? WHERE id = ?`, [at, id]);
          await raw(t, fresh, `DELETE FROM _substrat_state_moves WHERE entity_type = ? AND entity_id = ?`, ['preq', id]);
        }
      };
      const purgeRequests = async (fresh: ScopeId) =>
        (await host.listPlatformRequests(t, fresh)).filter(isPlatformRequest).filter((r) => r.kind === PURGE_REQUEST_KIND);

      it('counts the requests every purge in the pass enqueued', async () => {
        const fresh = await freshScope();
        await dueRows(fresh, ['one', 'two']);
        const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
        expect(report).toMatchObject({ fired: 1, failed: 0, errors: [], platformRequests: 2 });
        // The journal agrees: both purges committed their request.
        expect(await purgeRequests(fresh)).toHaveLength(2);
      });

      it('counts only the purges that enqueued one', async () => {
        const fresh = await freshScope();
        await dueRows(fresh, ['one', QUIET_PURGE_ROW]);
        const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
        expect(report).toMatchObject({ fired: 1, failed: 0, platformRequests: 1 });
        expect(await purgeRequests(fresh)).toHaveLength(1);
      });

      it('twin: a pass whose purges enqueue none reports no count', async () => {
        const fresh = await freshScope();
        await dueRows(fresh, [QUIET_PURGE_ROW, QUIET_PURGE_ROW]);
        const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
        expect(report).toMatchObject({ fired: 1, failed: 0 });
        expect(report.platformRequests).toBeUndefined();
        expect(await purgeRequests(fresh)).toHaveLength(0);
      });
    });
  });
}
