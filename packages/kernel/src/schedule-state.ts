/**
 * Which family a `_substrat_schedule_state` row belongs to (#1288) — the two of
 * `sweepRunKind`'s three names that a SCOPE can hold gating state for. (`connector`
 * is the third and is deliberately absent: a connection is swept host-wide and its
 * state lives nowhere in a scope.)
 */
export type ScheduleStateKind = 'schedule' | 'freshness';

/**
 * The platform sweep's per-scope gating state (#383), as both adapters build it.
 *
 * Shared rather than spelled twice because `lint:spine-ddl` can compare the copies
 * only where they are DDL a `KERNEL_DDL` executes — and this table is also rebuilt
 * by `SCHEDULE_STATE_REBUILD` below, on a store that predates the key. One
 * definition is what keeps the rebuilt shape and the created shape the same shape;
 * the gate then holds each adapter to including it.
 */
export const SCHEDULE_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_schedule_state (
    -- #1288: WHICH of the two families this row belongs to, named with the same two
    -- words _substrat_sweep_runs already records its entries under:
    --   * 'schedule'  -- keyed by the operation (module/verb). last_run_at and
    --     last_status are when that operation RAN here and how it ended.
    --   * 'freshness' -- keyed freshness:<eventType> (#1232). last_run_at and
    --     last_status are when the evaluator last RECORDED a verdict for that event
    --     type and what it was. Nothing ran; the row gates what the sweep records.
    kind TEXT NOT NULL,
    schedule_op TEXT NOT NULL,
    last_run_at TEXT,
    last_status TEXT,
    -- #1525: the invocation this row's last run happened in, or null. Null is a fact
    -- here, not a gap: a 'freshness' row never invokes anything (the evaluator only
    -- records a verdict), a 'schedule' row a pass SKIPPED carries no fresh call to
    -- attribute and keeps whatever it already held, and a row written before this
    -- column existed predates the possibility. Only a due schedule's own invoke
    -- mints one and writes it here, in the same call that stamps it onto whatever
    -- the operation emits — see runDueSchedules in each adapter.
    invocation_id TEXT,
    -- #2096: a purge horizon's lap in progress (entity-trash.ts, PurgeLap) -- where its
    -- next pass resumes in the bin, and how many purges failed earlier in the lap. Only a
    -- 'schedule' row of a purge schedule holds one, and only mid-lap: NULL is the start
    -- of a lap, which is also the honest reading of every row written before the column.
    purge_cursor TEXT,
    -- The key LEADS with kind, and that is the point of #1288 rather than a tidy-up.
    -- Until it did, the two families were told apart by the spelling of one column:
    -- a freshness key could never LOOK like an operation (an event type has passed
    -- contracts' eventType regex -- lowercase ns.verb, no colon, no slash), but the
    -- other direction was convention only, because scheduleSpec.operation is
    -- z.string().min(1). A module declaring a schedule literally named
    -- "freshness:orders.placed" shared the evaluator's row and nothing refused it:
    -- each write clobbered the other's verdict, and the sweep read back whichever
    -- ran last. With kind in the key those are two rows that cannot meet.
    PRIMARY KEY (kind, schedule_op)
  );
`;

/**
 * The `kind` a pre-#1288 row belongs to, derived from its `schedule_op` — the backfill's one
 * rule, shared by `SCHEDULE_STATE_REBUILD` below and by a restore of a dump taken before the
 * column (`spineRowsInsert`, #1883), so the two cannot file the same row differently.
 */
export const SCHEDULE_STATE_KIND_OF_OP =
  "CASE WHEN substr(schedule_op, 1, 10) = 'freshness:' THEN 'freshness' ELSE 'schedule' END";

/**
 * `_substrat_schedule_state`, rebuilt with its #1288 key on a store created before
 * it. Create-copy-drop-rename, because `kind` joins the PRIMARY KEY and SQLite
 * cannot widen a key in place — the same shape the directory's `ensureIdentityKey`
 * uses, and detected the same way (from `sqlite_master.sql`, which DO SQLite serves
 * and `PRAGMA` does not, so both adapters migrate by one strategy).
 *
 * The new table is `SCHEDULE_STATE_DDL` under a temporary name, so the rebuilt shape
 * cannot drift from the created one.
 *
 * The backfill derives `kind` from the `freshness:` prefix because that prefix IS how
 * the two families were told apart until now: every row the evaluator ever wrote
 * carries it, and no operation name in existence does. `substr(...) = 'freshness:'`
 * rather than `LIKE`, which is case-insensitive over ASCII in SQLite and would file a
 * schedule named `FRESHNESS:x` under the evaluator.
 *
 * Keys are copied VERBATIM, prefix included. What changes is which rows can coexist,
 * not what any row says — so a deployment rolled back to code that looks a freshness
 * key up under its old name still finds it.
 *
 * **Run these inside the adapter's transaction API**, which is what both callers do —
 * `db.transaction` on the pure side, `ctx.storage.transactionSync` on the DO side.
 * Un-wrapped, a stop between the CREATE and the DROP leaves the scratch table behind
 * and the NEXT wake dies on `table _substrat_schedule_state_new already exists`, which
 * is a scope that cannot open; a stop between the DROP and the RENAME is worse and
 * quieter, because the next wake's `CREATE TABLE IF NOT EXISTS` puts an EMPTY table
 * of the new shape in place, the detection below then reads it as already migrated,
 * and every copied row stays orphaned in the scratch table. Atomically, neither state
 * is reachable — which is why there is no recovery path here to go with them.
 *
 * The leading `DROP TABLE IF EXISTS` is belt to that braces, not the fix: it costs one
 * statement and makes the rebuild idempotent against a scratch table left by anything
 * below the transaction (a torn copy of the file). A restore cannot carry one in: since
 * #1883 it refuses a spine table the kernel does not build.
 *
 * A restore never reaches this rebuild either: it builds the table from the current DDL and
 * derives `kind` for a legacy dump's rows with `SCHEDULE_STATE_KIND_OF_OP`. This runs only
 * for a store that already holds the old table when it wakes.
 */
export const SCHEDULE_STATE_REBUILD = `
  DROP TABLE IF EXISTS _substrat_schedule_state_new;
  ${SCHEDULE_STATE_DDL.replace(
    'CREATE TABLE IF NOT EXISTS _substrat_schedule_state',
    'CREATE TABLE _substrat_schedule_state_new',
  )}
  -- #1525: invocation_id is not in this column list, deliberately — this rebuild runs
  -- only on a pre-#1288 table, which predates invocation_id too, so there is nothing
  -- to copy. The new table's default (NULL) is the honest answer for every such row.
  INSERT INTO _substrat_schedule_state_new (kind, schedule_op, last_run_at, last_status)
    SELECT ${SCHEDULE_STATE_KIND_OF_OP}, schedule_op, last_run_at, last_status
      FROM _substrat_schedule_state;
  DROP TABLE _substrat_schedule_state;
  ALTER TABLE _substrat_schedule_state_new RENAME TO _substrat_schedule_state;
`;

/**
 * Whether a store's `_substrat_schedule_state` already carries the #1288 key, read
 * off the `sql` column of `sqlite_master`. `false` means the rebuild is due.
 */
export function scheduleStateHasKind(tableSql: string): boolean {
  return tableSql.includes('PRIMARY KEY (kind, schedule_op)');
}

/**
 * What the recurring-schedule phase did in one pass (#383), summed across every
 * module's live scopes. `null` on `PlatformSweepReport` means the phase was
 * disabled or the host predates it — distinct from a report of all zeros, which is
 * "ran, nothing was due."
 */
export interface ScheduleSweepReport {
  /** Scopes `runDueSchedules` ran on (had ≥1 declared schedule). */
  scopes: number;
  /** Due schedules whose operation ran successfully. */
  fired: number;
  /** Schedules skipped this pass — still inside their cadence window. */
  skipped: number;
  /** Due schedules whose operation failed — recorded, stepped over. */
  failed: number;
}
