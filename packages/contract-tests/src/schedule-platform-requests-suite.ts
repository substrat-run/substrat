import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MAX_PENDING_PLATFORM_REQUESTS,
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
  GREEDY_PURGE_ROW,
  PURGE_REQUEST_DAYS,
  PURGE_REQUEST_KIND,
  PURGE_REQUEST_MODULE_ID,
  QUIET_PURGE_ROW,
  purgeRequestMod,
} from './schedule-purge-request-module.js';
import {
  FILL_TWO_ROW,
  PURGE_TWO_DAYS,
  PURGE_TWO_KIND,
  PURGE_TWO_MODULE_ID,
  QUIET_TWO_ROW,
  purgeTwoMod,
} from './schedule-purge-two-module.js';

const SCHED_REQUEST = moduleId.parse('@test/sched-request');
const PURGE_REQUEST = moduleId.parse(PURGE_REQUEST_MODULE_ID);
const PURGE_TWO = moduleId.parse(PURGE_TWO_MODULE_ID);
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
  /**
   * Runs SQL against a scope's own storage — to age a binned row past its purge horizon. Optional so
   * the export stays additive: without it the purge-horizon cases are skipped, the rest run.
   */
  raw?: RawScopeSql,
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
      host.registerModule(purgeTwoMod);
      await host.admin.createTenant(staff, { id: t, slug: `sched-request-${t.toLowerCase()}`, name: 'Scheduled requests' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      // Seats the schedules' declared permission on the module's system principal.
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-request-vertical' });
      await host.admin.activateScope(staff, t, s);
      const keys = ['purgereq:write', 'purgereq:trash', 'purgetwo:write', 'purgetwo:trash-a', 'purgetwo:trash-b'].map((k) =>
        permissionKey.parse(k),
      );
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

    // Skipped when the host passes no `raw` SQL door: the rows cannot be aged past the horizon.
    describe.skipIf(raw === undefined)('a purge horizon (#2440)', () => {
      /** A new primary scope, so the schedule's cadence row starts empty. */
      const freshScope = async (): Promise<ScopeId> => {
        const fresh = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t, scopeId: fresh, vertical: 'sched-request-vertical' });
        await host.admin.activateScope(staff, t, fresh);
        return fresh;
      };
      /**
       * `names.length` rows, binned and aged past the horizon, so one pass purges them all. Returns
       * their ids, oldest first: aged by one minute each, so the purge walk takes them in this order.
       */
      const dueRows = async (fresh: ScopeId, names: string[]): Promise<string[]> => {
        const stub = await host.getScope(alice, t, fresh);
        const base = Date.now() - (PURGE_REQUEST_DAYS + 1) * DAY;
        const ids: string[] = [];
        for (const [n, name] of names.entries()) {
          const id = `row-${String(n).padStart(3, '0')}-${ulid()}`;
          const at = new Date(base + n * 60_000).toISOString();
          await stub.invoke('purgereq/add', { id, name });
          await stub.invoke('purgereq/trash', { rowId: id });
          await raw!(t, fresh, `INSERT INTO _substrat_state_moves (entity_type, entity_id) VALUES (?, ?)`, ['preq', id]);
          await raw!(t, fresh, `UPDATE purgereq_rows SET _substrat_trashed_at = ? WHERE id = ?`, [at, id]);
          await raw!(t, fresh, `DELETE FROM _substrat_state_moves WHERE entity_type = ? AND entity_id = ?`, ['preq', id]);
          ids.push(id);
        }
        return ids;
      };
      /** Which of `ids` the purge deleted: re-adding a row that still exists is refused by its primary key. */
      const purged = async (fresh: ScopeId, ids: string[]): Promise<string[]> => {
        const stub = await host.getScope(alice, t, fresh);
        const out: string[] = [];
        for (const id of ids) {
          try {
            await stub.invoke('purgereq/add', { id, name: 'again' });
            out.push(id);
          } catch {
            // still there
          }
        }
        return out;
      };
      /** The row ids the purges requested for, in no particular order. */
      const requestedRows = async (fresh: ScopeId): Promise<string[]> =>
        (await host.listPlatformRequestHistory(t, fresh, { kind: PURGE_REQUEST_KIND, limit: 200 }))
          .filter(isPlatformRequest)
          .map((r) => (r.payload as { rowId: string }).rowId);
      /** The platform's drain, as far as a test needs it: every pending request settles `done`. */
      const drainAll = async (fresh: ScopeId): Promise<void> => {
        for (const r of (await host.listPlatformRequests(t, fresh)).filter(isPlatformRequest)) {
          await host.settlePlatformRequest(t, fresh, r.id, { status: 'done' });
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

      // #2506: a batch (PURGE_BATCH, 50) can hold more due entities than the scope's queue has room
      // for (MAX_PENDING_PLATFORM_REQUESTS, 32). Past the head of the pass, the cap is a "not yet",
      // never a failure of the entity; AT the head it is a failure like any other, so nothing that
      // needs no request, and nothing behind an entity that can never fit, is held up by it.
      describe('a batch larger than the pending cap (#2506)', () => {
        const OVER = MAX_PENDING_PLATFORM_REQUESTS + 8;
        const names = (n: number, name = 'row') => Array.from({ length: n }, () => name);
        const Q = QUIET_PURGE_ROW;

        it('stops at the cap without failing, and the next pass after the drain finishes the lap', async () => {
          const fresh = await freshScope();
          const ids = await dueRows(fresh, names(OVER));
          const first = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          // The pass filled the queue, purged what fit, and reported no failure: the rest is still due.
          expect(first).toMatchObject({ fired: 1, failed: 0, errors: [], platformRequests: MAX_PENDING_PLATFORM_REQUESTS });
          expect(await purgeRequests(fresh)).toHaveLength(MAX_PENDING_PLATFORM_REQUESTS);
          // Oldest first, and exactly the ones that fit: nothing past the cap was purged.
          expect(await purged(fresh, ids)).toEqual(ids.slice(0, MAX_PENDING_PLATFORM_REQUESTS));
          await drainAll(fresh);
          // The schedule stayed due (no cadence wait), and the lap resumes at the first deferred row.
          const second = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(second).toMatchObject({ fired: 1, failed: 0, errors: [], platformRequests: OVER - MAX_PENDING_PLATFORM_REQUESTS });
          expect([...(await requestedRows(fresh))].sort()).toEqual([...ids].sort());
          // The lap closed: every row is gone (the first ones were re-added above; the rest here).
          expect(await purged(fresh, ids.slice(MAX_PENDING_PLATFORM_REQUESTS))).toEqual(ids.slice(MAX_PENDING_PLATFORM_REQUESTS));
        });

        it('a queue that stays full fails the entities it refuses once, and the lap waits its cadence', async () => {
          const fresh = await freshScope();
          const ids = await dueRows(fresh, names(OVER));
          await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          // No drain: the second pass meets a full queue at its very first entity, as a failure.
          const stuck = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(stuck).toMatchObject({ fired: 0, failed: 1 });
          expect(stuck.errors).toHaveLength(OVER - MAX_PENDING_PLATFORM_REQUESTS);
          expect(stuck.errors[0]).toEqual({
            operation: expect.stringContaining('purgereq/purge'),
            error: expect.stringMatching(/too many pending platform requests \(\d+\)/),
          });
          expect(stuck.platformRequests).toBeUndefined();
          expect(await purgeRequests(fresh)).toHaveLength(MAX_PENDING_PLATFORM_REQUESTS);
          // The lap closed: it does not retry on every sweep tick, and nothing past the cap was lost.
          await drainAll(fresh);
          const waiting = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(waiting).toMatchObject({ fired: 0, failed: 0 });
          expect(await purged(fresh, ids.slice(MAX_PENDING_PLATFORM_REQUESTS))).toEqual([]);
        });

        it('twin: purges that enqueue nothing are not held to the cap, however many are due', async () => {
          const fresh = await freshScope();
          const ids = await dueRows(fresh, names(OVER, Q));
          const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(report).toMatchObject({ fired: 1, failed: 0, errors: [] });
          expect(report.platformRequests).toBeUndefined();
          expect(await purged(fresh, ids)).toEqual(ids);
        });

        it('a purge that can never fit does not starve what is behind it', async () => {
          const fresh = await freshScope();
          // Oldest first: a quiet row, one that needs more slots than a scope has, two quiet rows.
          const ids = await dueRows(fresh, [Q, GREEDY_PURGE_ROW, Q, Q]);
          // Pass one is past its head when it meets the greedy row, so it only stops there...
          const first = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(first).toMatchObject({ fired: 1, failed: 0, errors: [] });
          expect(await purged(fresh, [ids[0]!])).toEqual([ids[0]]);
          // ...and pass two, which stays due, has it as the head: a failure like any other, and the walk moves on.
          const second = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(second).toMatchObject({ fired: 0, failed: 1 });
          expect(second.errors).toEqual([
            { operation: expect.stringContaining('purgereq/purge'), error: expect.stringMatching(/too many pending platform requests/) },
          ]);
          expect(await purged(fresh, [ids[2]!, ids[3]!])).toEqual([ids[2], ids[3]]);
          // It never committed a request, and stays in the bin.
          expect(await purgeRequests(fresh)).toHaveLength(0);
          expect(await purged(fresh, [ids[1]!])).toEqual([]);
        });

        it('twin: the same walk with an ordinary row in place of the greedy one purges everything without a failure', async () => {
          const fresh = await freshScope();
          const ids = await dueRows(fresh, [Q, 'row', Q, Q]);
          const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(report).toMatchObject({ fired: 1, failed: 0, errors: [], platformRequests: 1 });
          expect(await purged(fresh, ids)).toEqual(ids);
        });

        it('a queue held full by other traffic refuses the head, and the purges behind it that need no request still commit', async () => {
          const fresh = await freshScope();
          const stub = await host.getScope(alice, t, fresh);
          await stub.invoke('purgereq/enqueue', { count: MAX_PENDING_PLATFORM_REQUESTS });
          // Oldest first: one that needs a request, then three that do not.
          const ids = await dueRows(fresh, ['row', Q, Q, Q]);
          const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(report).toMatchObject({ fired: 0, failed: 1 });
          expect(report.errors).toHaveLength(1);
          // As on a scope with no cap: the three quiet purges are not held up by the head.
          expect(await purged(fresh, ids.slice(1))).toEqual(ids.slice(1));
          expect(await purged(fresh, [ids[0]!])).toEqual([]);
        });

        it('twin: with room in the queue the same head purges too', async () => {
          const fresh = await freshScope();
          const ids = await dueRows(fresh, ['row', Q, Q, Q]);
          const report = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
          expect(report).toMatchObject({ fired: 1, failed: 0, errors: [], platformRequests: 1 });
          expect(await purged(fresh, ids)).toEqual(ids);
        });

        // Two purge horizons of one module run back to back in one call, with no drain between them
        // (the sweeper kicks the drain once, after all of a scope's schedules).
        describe('two horizons in one tick', () => {
          /** Rows of one kind, binned and aged past the horizon, oldest first. */
          const dueTwo = async (fresh: ScopeId, kind: 'a' | 'b', rowNames: string[]): Promise<string[]> => {
            const stub = await host.getScope(alice, t, fresh);
            const base = Date.now() - (PURGE_TWO_DAYS + 1) * DAY;
            const entity = kind === 'a' ? 'pa' : 'pb';
            const table = kind === 'a' ? 'purgetwo_a' : 'purgetwo_b';
            const ids: string[] = [];
            for (const [n, name] of rowNames.entries()) {
              const id = `${kind}-${String(n).padStart(3, '0')}-${ulid()}`;
              const at = new Date(base + n * 60_000).toISOString();
              await stub.invoke(`purgetwo/add-${kind}`, { id, name });
              await stub.invoke(`purgetwo/trash-${kind}`, { rowId: id });
              await raw!(t, fresh, `INSERT INTO _substrat_state_moves (entity_type, entity_id) VALUES (?, ?)`, [entity, id]);
              await raw!(t, fresh, `UPDATE ${table} SET _substrat_trashed_at = ? WHERE id = ?`, [at, id]);
              await raw!(t, fresh, `DELETE FROM _substrat_state_moves WHERE entity_type = ? AND entity_id = ?`, [entity, id]);
              ids.push(id);
            }
            return ids;
          };
          const goneTwo = async (fresh: ScopeId, kind: 'a' | 'b', ids: string[]): Promise<string[]> => {
            const stub = await host.getScope(alice, t, fresh);
            const out: string[] = [];
            for (const id of ids) {
              try {
                await stub.invoke(`purgetwo/add-${kind}`, { id, name: 'again' });
                out.push(id);
              } catch {
                // still there
              }
            }
            return out;
          };
          const requestsTwo = async (fresh: ScopeId) =>
            (await host.listPlatformRequestHistory(t, fresh, { kind: PURGE_TWO_KIND, limit: 200 })).filter(isPlatformRequest);

          // #2517: nothing drains the scope between the two horizons, so the second one's head met a
          // queue the tick's own purges filled. That is "not yet", not a failure: it keeps its place
          // and runs on the next tick, not after its whole cadence.
          it('the second horizon meets the queue the first filled: its head is deferred to the next tick, not failed', async () => {
            const fresh = await freshScope();
            const first = await dueTwo(fresh, 'a', names(OVER));
            // Oldest first: a row that needs a request, then two that do not.
            const second = await dueTwo(fresh, 'b', ['row', QUIET_TWO_ROW, QUIET_TWO_ROW]);
            const report = await host.runDueSchedules(PURGE_TWO, t, fresh);
            // The first horizon filled the queue and stopped there, still due; it did not fail.
            expect(await requestsTwo(fresh)).toHaveLength(MAX_PENDING_PLATFORM_REQUESTS);
            expect(await goneTwo(fresh, 'a', first)).toEqual(first.slice(0, MAX_PENDING_PLATFORM_REQUESTS));
            // The second tried nothing and failed nothing: reported deferred, a skip, never fired.
            // Each request is counted once, and all of them were the purges'.
            // (`fired` counts the module's ordinary fill, which enqueues nothing here, and the first horizon.)
            expect(report).toMatchObject({
              fired: 2,
              skipped: 1,
              failed: 0,
              deferred: 1,
              errors: [],
              platformRequests: MAX_PENDING_PLATFORM_REQUESTS,
              purgeRequests: MAX_PENDING_PLATFORM_REQUESTS,
            });
            expect(report.runs).toEqual([
              { operation: 'purgetwo/fill', outcome: 'ok' },
              { operation: 'purgetwo/purge-a', outcome: 'ok' },
              { operation: 'purgetwo/purge-b', outcome: 'skipped' },
            ]);
            expect(await goneTwo(fresh, 'b', second)).toEqual([]);
            // After the drain the very next tick runs both: no cadence wait for either.
            await drainAll(fresh);
            const next = await host.runDueSchedules(PURGE_TWO, t, fresh);
            expect(next).toMatchObject({ fired: 2, failed: 0, errors: [] });
            expect(next.deferred).toBeUndefined();
            expect(await goneTwo(fresh, 'b', second)).toEqual(second);
            expect(await goneTwo(fresh, 'a', first.slice(MAX_PENDING_PLATFORM_REQUESTS))).toEqual(
              first.slice(MAX_PENDING_PLATFORM_REQUESTS),
            );
          });

          it('a head refused by a queue other traffic filled, with nothing enqueued earlier in the tick, still fails', async () => {
            const fresh = await freshScope();
            const stub = await host.getScope(alice, t, fresh);
            await stub.invoke('purgereq/enqueue', { count: MAX_PENDING_PLATFORM_REQUESTS });
            // The first horizon purges without a request, so it filled nothing.
            await dueTwo(fresh, 'a', [QUIET_TWO_ROW, QUIET_TWO_ROW]);
            const second = await dueTwo(fresh, 'b', ['row', QUIET_TWO_ROW, QUIET_TWO_ROW]);
            const report = await host.runDueSchedules(PURGE_TWO, t, fresh);
            expect(report).toMatchObject({ fired: 2, failed: 1 });
            expect(report.errors).toHaveLength(1);
            // As ever: nothing behind the head is starved.
            expect(await goneTwo(fresh, 'b', second.slice(1))).toEqual(second.slice(1));
            expect(await goneTwo(fresh, 'b', [second[0]!])).toEqual([]);
          });

          it('twin: with room left by the first horizon, the second one purges its head too', async () => {
            const fresh = await freshScope();
            await dueTwo(fresh, 'a', [QUIET_TWO_ROW, 'row']);
            const second = await dueTwo(fresh, 'b', ['row', QUIET_TWO_ROW, QUIET_TWO_ROW]);
            const report = await host.runDueSchedules(PURGE_TWO, t, fresh);
            expect(report).toMatchObject({ fired: 3, failed: 0, errors: [] });
            expect(await goneTwo(fresh, 'b', second)).toEqual(second);
          });

          // #2517: a sweep runs a scope's modules back to back with no drain either, and tells each
          // call what the earlier calls' purges enqueued (`purgeRequests`).
          const acrossModules = async (carry: boolean) => {
            const fresh = await freshScope();
            await dueRows(fresh, names(OVER));
            const earlier = await host.runDueSchedules(PURGE_REQUEST, t, fresh);
            expect(earlier).toMatchObject({ failed: 0, purgeRequests: MAX_PENDING_PLATFORM_REQUESTS });
            const a = await dueTwo(fresh, 'a', ['row', QUIET_TWO_ROW]);
            const b = await dueTwo(fresh, 'b', ['row', QUIET_TWO_ROW]);
            const report = await host.runDueSchedules(
              PURGE_TWO,
              t,
              fresh,
              carry ? { earlierPurgeRequests: earlier.purgeRequests } : undefined,
            );
            return { fresh, a, b, report };
          };

          it('a module after one whose purges filled the queue defers its heads when the sweep says so', async () => {
            const { fresh, a, b, report } = await acrossModules(true);
            // The ordinary fill fires (and enqueues nothing); both horizons are deferred.
            expect(report).toMatchObject({ fired: 1, skipped: 2, failed: 0, deferred: 2, errors: [] });
            expect(report.runs?.map((r) => r.outcome)).toEqual(['ok', 'skipped', 'skipped']);
            expect(await goneTwo(fresh, 'a', a)).toEqual([]);
            expect(await goneTwo(fresh, 'b', b)).toEqual([]);
            // Next tick, after the drain: the purge-request module finishes its lap, and this one runs.
            await drainAll(fresh);
            await host.runDueSchedules(PURGE_REQUEST, t, fresh);
            await drainAll(fresh);
            const next = await host.runDueSchedules(PURGE_TWO, t, fresh);
            expect(next).toMatchObject({ fired: 2, failed: 0, errors: [] });
            expect(await goneTwo(fresh, 'a', a)).toEqual(a);
            expect(await goneTwo(fresh, 'b', b)).toEqual(b);
          });

          it('twin (skew): told nothing — an older sweep — the same heads fail as before and nothing behind them waits', async () => {
            const { fresh, a, b, report } = await acrossModules(false);
            expect(report).toMatchObject({ fired: 1, failed: 2 });
            expect(report.deferred).toBeUndefined();
            expect(await goneTwo(fresh, 'a', a)).toEqual(a.slice(1));
            expect(await goneTwo(fresh, 'b', b)).toEqual(b.slice(1));
          });

          // #2517's bound: only PURGE runs defer a head. An ordinary schedule may enqueue on every
          // tick for ever, so if its requests counted, a head behind it would wait for ever, and so
          // would everything behind the head (#2096).
          it('an ordinary schedule that fills the queue never defers a head: it fails as before, and the purges behind it that need no request commit', async () => {
            const fresh = await freshScope();
            // A live (unbinned) row by this name makes the module's ordinary fill fill the queue.
            const stub = await host.getScope(alice, t, fresh);
            await stub.invoke('purgetwo/add-a', { id: `fill-${ulid()}`, name: FILL_TWO_ROW });
            const b = await dueTwo(fresh, 'b', ['row', QUIET_TWO_ROW, QUIET_TWO_ROW]);
            const report = await host.runDueSchedules(PURGE_TWO, t, fresh);
            // The fill and the empty first horizon fire; the second horizon's head fails.
            expect(report).toMatchObject({ fired: 2, failed: 1, platformRequests: MAX_PENDING_PLATFORM_REQUESTS });
            expect(report.deferred).toBeUndefined();
            expect(report.purgeRequests).toBeUndefined();
            expect(report.errors).toEqual([
              { operation: expect.stringContaining('purgetwo/purge-b'), error: expect.stringMatching(/too many pending platform requests/) },
            ]);
            expect(await goneTwo(fresh, 'b', b)).toEqual(b.slice(1));
          });
        });
      });
    });
  });
}
