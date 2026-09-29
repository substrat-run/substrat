import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { moduleId, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { deniedScheduleMod, scheduleMod } from './modules.js';

const SCHED_MODULE = moduleId.parse('@test/sched');
const DENIED_MODULE = moduleId.parse('@test/sched-denied');
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
    // #1525: the ids pass 1 mints, captured so the skip test below can assert they are
    // UNCHANGED (`toBe`) rather than merely shaped like a ULID — a skip that quietly
    // re-minted would still pass a shape check.
    let pass1Ids: { tick: string; collision: string };

    /**
     * The tests that sweep get longer than vitest's 5 s default. The sweep walks every scope
     * in the control plane, and on adapter-cloudflare that one control plane is shared by
     * every test file in the worker (#1591, #1899), so its cost is the whole suite's, not
     * this one's. Locally that is a fraction of a second; on a CI shard running other suites
     * beside it, it has run past 5 s. Nothing asserted here depends on time. Remove once
     * #1899 gives each harness its own control plane.
     */
    const SWEEP_TIMEOUT_MS = 30_000;
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

      // #1525: minted PER schedule, not once for the whole pass — a `ulid()` hoisted
      // above the runner's loop would satisfy every assertion above and still be wrong.
      const collisionRow = state.find(
        (r) => r.kind === 'schedule' && r.schedule_op === 'freshness:sched.ticked',
      );
      expect(collisionRow?.invocation_id).not.toBe(firedRow!.invocation_id);
      pass1Ids = { tick: firedRow!.invocation_id!, collision: collisionRow!.invocation_id! };
    }, SWEEP_TIMEOUT_MS);

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
      // was rewritten — each `invocation_id` is EXACTLY what pass 1 left, asserted by
      // `toBe` against the ids that test captured rather than by shape: a skip that
      // quietly re-minted (or re-used ONE id for both rows) would still look like a
      // valid ULID here. The freshness row never had one to begin with.
      expect(state).toEqual([
        { kind: 'freshness', schedule_op: 'freshness:sched.ticked', last_status: 'ok', invocation_id: null },
        {
          kind: 'schedule',
          schedule_op: 'freshness:sched.ticked',
          last_status: 'ok',
          invocation_id: pass1Ids.collision,
        },
        {
          kind: 'schedule',
          schedule_op: 'sched/tick',
          last_status: 'ok',
          invocation_id: pass1Ids.tick,
        },
      ]);
    }, SWEEP_TIMEOUT_MS);

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
     * #1525's own ALTER, distinct from #1288's REBUILD above: this store already has
     * `kind` in its key — the shape every scope past #1288 holds today — and is only
     * missing `invocation_id`, because it predates THIS column. Built from a real
     * `exportScope` rather than a hand-spelled dump, so `_substrat_tuples` (the system
     * grant `sched:tick` projects onto) and every other table come back untouched —
     * the one column under test is the only thing rolled back.
     *
     * Proof that the ALTER ran, not asserted separately: `sched/schedule-state`
     * selects `invocation_id` by name, so a store still missing the column would
     * throw `no such column` here rather than read one back.
     *
     * Also a `restoreScope`, and the LAST test in the file that calls `sweep()` — the
     * failed-schedule test after it registers a second module and deliberately runs
     * after every `sweep()`-based assertion above, and the final test below needs to
     * be the true last one (see its own comment). A test inserted between this one and
     * either of those would read this restore's leftovers, not the scope `beforeAll`
     * provisioned.
     */
    it('ALTERs invocation_id into a store that already has kind, and the next fired schedule records it', async () => {
      const dump = await host.admin.exportScope(staff, t, s);
      const rolledBack = {
        ...dump,
        tables: dump.tables.map((table) =>
          table.name === '_substrat_schedule_state'
            ? {
                name: table.name,
                // The exact shape #1288 left behind and #1525 replaced: `kind` already
                // in the key, no `invocation_id` column at all.
                ddl:
                  'CREATE TABLE _substrat_schedule_state (kind TEXT NOT NULL, schedule_op TEXT NOT NULL, ' +
                  'last_run_at TEXT, last_status TEXT, PRIMARY KEY (kind, schedule_op))',
                columns: ['kind', 'schedule_op', 'last_run_at', 'last_status'],
                // Long enough ago to be due the instant this restore lands.
                rows: [['schedule', 'sched/tick', '2020-01-01T00:00:00.000Z', 'ok']],
              }
            : table,
        ),
      };
      await host.restoreScope(staff, t, s, rolledBack);

      const report = await sweep();
      // Two: `sched/tick` (its row survived, ancient and due) and the #1288 collision
      // fixture, whose row this restore dropped entirely — absent reads as never-run,
      // same as any other schedule the code has not seen before.
      expect(report.schedules!.fired).toBe(2);
      expect(errorsOfScope(report.errors, s)).toEqual([]);

      const stub = await host.getScope(reader, t, s);
      const state = (await stub.invoke('sched/schedule-state')) as {
        kind: string;
        schedule_op: string;
        invocation_id: string | null;
      }[];
      const firedRow = state.find((r) => r.kind === 'schedule' && r.schedule_op === 'sched/tick');
      expect(firedRow?.invocation_id).toMatch(ULID_SHAPE);
      // The freshness evaluator's own row is new too (its old one didn't survive the
      // restore either) — still null, since it invoked nothing.
      const freshnessRow = state.find((r) => r.kind === 'freshness');
      expect(freshnessRow?.invocation_id).toBeNull();
    }, SWEEP_TIMEOUT_MS);

    /**
     * The failure twin of "fires a due schedule" above: a FAILED run still records a
     * row, carrying the same id its own denial does. `deniedScheduleMod` is registered
     * HERE, not in `beforeAll`, and only after every `sweep()`-based test above this
     * point has already asserted its exact fired/skipped counts — `runPlatformSweep`
     * enumerates every module the file has registered against every active scope
     * (#1591), so joining it earlier would inflate every one of them. `runDueSchedules`
     * is called directly for the same reason `#1666`'s own suite does: it targets
     * exactly one (module, scope) pair, no sweep involved.
     *
     * `provisionScope` is idempotent and re-projects every registered module's
     * schedule permissions on re-run (`docs` on the method), which is the seam that
     * lets a module already-provisioned scope pick up a module registered after it.
     */
    it('a failed schedule still records a row, with the same id its own denial carries', async () => {
      host.registerModule(deniedScheduleMod);
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });

      const report = await host.runDueSchedules(DENIED_MODULE, t, s);
      expect(report.fired).toBe(0);
      expect(report.failed).toBe(1);

      const stub = await host.getScope(reader, t, s);
      const state = (await stub.invoke('sched/schedule-state')) as {
        kind: string;
        schedule_op: string;
        last_status: string;
        invocation_id: string | null;
      }[];
      const failedRow = state.find((r) => r.kind === 'schedule' && r.schedule_op === 'sched-denied/tick');
      expect(failedRow?.last_status).toBe('failed');
      expect(failedRow?.invocation_id).toMatch(ULID_SHAPE);

      // The row and the denial it caused carry the SAME id — the join the column
      // exists for, proved on the failure path the way the outbox join proved it on
      // the success path above.
      const denials = (await stub.invoke('sched/read-denials')) as {
        operation: string | null;
        invocation_id: string | null;
      }[];
      const denial = denials.find((d) => d.operation === 'sched-denied/tick');
      expect(denial?.invocation_id).toBe(failedRow!.invocation_id);
    });

    /**
     * #1288's backfill, on a dump captured before the column: a restore builds the table
     * from the kernel's DDL (#1883) and derives each row's `kind` from its key, by the
     * rule the wake-time rebuild uses (`SCHEDULE_STATE_KIND_OF_OP`). The rebuild itself,
     * over a live store holding the old table, is each adapter's own test
     * (`schedule-state-kind.test.ts`, `schedule-invocation-column.test.ts`).
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
