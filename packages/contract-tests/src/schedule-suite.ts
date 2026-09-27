import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { moduleId, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { scheduleMod } from './modules.js';

const SCHED_MODULE = moduleId.parse('@test/sched');
// Crockford base32, 26 chars — the shape a minted `ulid()` always has (#1525).
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Never called: the sweep runs no connector sweepers here. A throwing stub proves it.
const noFetch = (() => {
  throw new Error('fetch should not be called by the schedule phase');
}) as unknown as FetchLike;

/**
 * The sweep's errors that belong to one scope (#1591).
 *
 * `runPlatformSweep` enumerates every active scope in the directory it is handed, and
 * the Cloudflare contract file hands every suite the SAME control plane
 * (`isolatedStorage: false`), so `report.errors` is the whole file's accumulated
 * state, not the schedule phase's. A scope is named two ways: `<scope>` on the
 * phases that fail per scope, and `<scope>:<operation | module>` on the schedule
 * phase, hence the two arms — matching only the second would drop this scope's own
 * `freshness` error.
 */
export function errorsOfScope<E extends { id: string }>(errors: readonly E[], scope: string): E[] {
  return errors.filter((e) => e.id === scope || e.id.startsWith(`${scope}:`));
}

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
      // Two: `sched/tick`, and #1288's collision fixture `freshness:sched.ticked`.
      expect(report.schedules!.fired).toBe(2);
      // Only THIS scope's errors: the sweep also walks every other suite's scopes in
      // a shared control plane (#1591). The foreign ones are printed, not dropped
      // silently — if one is a real defect, a red CI log names it.
      const foreign = report.errors.filter((e) => !errorsOfScope([e], s).length);
      if (foreign.length > 0) {
        console.warn(`schedule contract: ignoring ${foreign.length} error(s) from other scopes:`, foreign);
      }
      expect(errorsOfScope(report.errors, s)).toEqual([]);

      // The operation ran exactly once, and its emitted event reads as the module,
      // never a person — the attribution the whole issue is about.
      const stub = await host.getScope(reader, t, s);
      expect(await stub.invoke('sched/count')).toBe(1);
      const outbox = (await stub.invoke('sched/read-outbox')) as {
        type: string;
        actor: string;
        invocation_id: string | null;
      }[];
      const tick = outbox.find((r) => r.type === 'sched.ticked');
      expect(tick).toBeDefined();
      expect(JSON.parse(tick!.actor)).toEqual({ system: '@test/sched' });
      // #1231: a schedule fires THROUGH invoke, so its emit is stamped with the
      // schedule's own operation — the honest answer to "what ran".
      expect((tick as { operation?: string | null }).operation).toBe('sched/tick');

      // #1525: the runner mints ONE id for the call and carries it two places — the
      // event this invoke emitted, and the schedule-state row recording the run — so
      // a reader can join them. A freshness verdict invokes nothing and stays null.
      expect(tick!.invocation_id).toMatch(ULID_SHAPE);
      const state = (await stub.invoke('sched/schedule-state')) as {
        kind: string;
        schedule_op: string;
        invocation_id: string | null;
      }[];
      const firedRow = state.find((r) => r.kind === 'schedule' && r.schedule_op === 'sched/tick');
      expect(firedRow?.invocation_id).toBe(tick!.invocation_id);
      const freshnessRow = state.find((r) => r.kind === 'freshness');
      expect(freshnessRow?.invocation_id).toBeNull();
    });

    it('skips a schedule still inside its cadence window', async () => {
      const report = await sweep();
      expect(report.schedules!.fired).toBe(0);
      expect(report.schedules!.skipped).toBe(2);
      // Still one tick — the second pass did not re-run it.
      const stub = await host.getScope(reader, t, s);
      expect(await stub.invoke('sched/count')).toBe(1);
      const state = (await stub.invoke('sched/schedule-state')) as {
        kind: string;
        schedule_op: string;
        last_status: string;
        invocation_id: string | null;
      }[];
      // THREE rows, and the middle two are the whole of #1288: a freshness row and a
      // schedule row whose keys are byte-identical, coexisting because `kind` leads
      // the primary key. Before it there were two rows here, not three — the module's
      // `freshness:sched.ticked` schedule and the evaluator's expectation on
      // `sched.ticked` wrote over each other under one key, and the survivor was
      // whichever phase of the pass ran last.
      //
      // #1525: this pass SKIPPED every row (still inside cadence), so none of them
      // was rewritten — each `invocation_id` is exactly what pass 1 left. The
      // freshness row never had one to begin with; the two schedule rows fired last
      // pass and still carry the id that run minted.
      expect(state).toEqual([
        { kind: 'freshness', schedule_op: 'freshness:sched.ticked', last_status: 'ok', invocation_id: null },
        {
          kind: 'schedule',
          schedule_op: 'freshness:sched.ticked',
          last_status: 'ok',
          invocation_id: expect.stringMatching(ULID_SHAPE),
        },
        {
          kind: 'schedule',
          schedule_op: 'sched/tick',
          last_status: 'ok',
          invocation_id: expect.stringMatching(ULID_SHAPE),
        },
      ]);
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

    /**
     * #1288's migration, on the one legacy shape a test can actually produce: a
     * restore replays the dump's own DDL verbatim, so a dump captured before the
     * column puts the pre-#1288 table back into a live store — exactly what a scope
     * created before this release wakes up holding. Both adapters then run their
     * spine pass over it (`ensureSpineColumns` / `applySpineColumnAdditions`).
     *
     * LAST in this file deliberately: a restore replaces the scope's storage, so
     * anything after it would be reading a different scope than it provisioned.
     */
    it('backfills kind from the freshness: prefix when a pre-#1288 table is restored', async () => {
      await host.restoreScope(staff, t, s, {
        tenantId: t,
        scopeId: s,
        capturedAt: '2026-09-01T00:00:00.000Z',
        tables: [
          {
            name: '_substrat_schedule_state',
            // The pre-#1288 shape, spelled out rather than referenced: the point of
            // the test is that code meeting THIS table migrates it, so it must not
            // move when the current DDL does.
            ddl:
              'CREATE TABLE _substrat_schedule_state (schedule_op TEXT PRIMARY KEY, ' +
              'last_run_at TEXT, last_status TEXT)',
            columns: ['schedule_op', 'last_run_at', 'last_status'],
            rows: [
              ['freshness:sched.ticked', '2026-09-01T00:00:00.000Z', 'failed'],
              ['sched/tick', '2026-09-01T00:00:00.000Z', 'ok'],
            ],
          },
        ],
      });

      const stub = await host.getScope(reader, t, s);
      const state = (await stub.invoke('sched/schedule-state')) as {
        kind: string;
        schedule_op: string;
        last_status: string;
        invocation_id: string | null;
      }[];
      // Every row survived, every key verbatim, and each landed under the kind its key
      // implied — which is how the two families were told apart before the column,
      // so deriving from it is the one backfill that preserves what was recorded.
      // The statuses differ on purpose: a backfill that dropped rows and let the
      // sweep re-create them would read as 'ok' on both.
      //
      // #1525: both rows predate `invocation_id` itself, not just `kind` — the dumped
      // DDL above has neither column. `null` is the honest answer the rebuild's INSERT
      // leaves behind for a column no source row ever had, same as `kind`'s own gap.
      expect(state).toEqual([
        { kind: 'freshness', schedule_op: 'freshness:sched.ticked', last_status: 'failed', invocation_id: null },
        { kind: 'schedule', schedule_op: 'sched/tick', last_status: 'ok', invocation_id: null },
      ]);
    });
  });
}
