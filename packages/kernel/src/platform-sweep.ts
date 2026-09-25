import { drainedEvent, instant } from '@substrat-run/contracts';
import type {
  AccessLogEntry,
  ConnectionId,
  MigrationProgress,
  MigrationStraggler,
  PlatformActorId,
  Scope,
  ScopeId,
  TenantId,
  DrainedEvent,
} from '@substrat-run/contracts';
import type {
  ExportReadInput,
  ExportedBatch,
  ImportBatch,
  ImportResult,
  ImportState,
  ManifestImports,
  WantedEvent,
} from '@substrat-run/contracts';
import type { ExecutorDrainReport, FetchLike, HostAdmin, ScopeHost, SweepRunInput } from './scope-host.js';
import { backoffAt } from './scope-host.js';
import { MIGRATION_FLAG_THRESHOLD, migrationFleet, migrationProgress, scopeMigrationState } from './migration-progress.js';
import { UNDRAINED_SKIPPED_IDS, type UndrainedSkipped } from './outbox-event.js';
import { resolveVerticalInstanceFrom } from './peer.js';

// setTimeout/clearTimeout are web-standard (Node, Workers, browsers) but the
// kernel pulls in no platform lib typings; declared locally, returning an opaque
// handle, the same move `api.ts` makes for `AbortSignal`.
declare const setTimeout: (cb: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/**
 * A connector's reconcile sweep — the unit `runPlatformSweep` calls per live
 * connection of a given provider (`sweepScriveReconciliations` is one).
 *
 * INJECTED, never imported: the driver — and the deployment that runs it —
 * depends on no specific connector. A connector contributes `{ [provider]: its
 * sweeper }` to the registry, and a provider with no entry is simply skipped.
 */
export interface ConnectorSweeper {
  (host: ScopeHost, connectionId: ConnectionId, opts: { fetch: FetchLike }): Promise<unknown>;
}

/**
 * Where drained access-log rows go — Tier 2 (K-24), the durable place a row lives
 * once it has left the directory.
 *
 * INJECTED for the same reason `ConnectorSweeper` is: the kernel names the seam and
 * knows nothing about the target. The control plane binds an R2 implementation
 * (`createR2AccessLogSink`); a self-host may bind a file, an object store, or nothing
 * at all — and nothing at all is a supported answer, it just means the log is never
 * pruned.
 *
 * `ship` MUST be durable before it resolves. Everything downstream — the `drainedAt`
 * stamp, and the prune the stamp licenses — treats a resolved `ship` as proof the
 * evidence survives outside the directory. A sink that buffers and returns early turns
 * a retention policy back into data loss.
 */
export interface AccessLogSink {
  /**
   * Ship one batch and return an opaque reference to where it landed (an object key,
   * a URL — the sweep only records it). The reference is what makes the admin-log row
   * actionable: "these rows left, and here is where they are".
   */
  ship(entries: AccessLogEntry[]): Promise<{ ref: string }>;
}

/**
 * Where a scope's drained domain events go — Tier 2 proper (#1334, master-plan
 * §5.3: "domain events → Pipelines → Iceberg on R2, queried via R2 SQL").
 *
 * The `AccessLogSink` twin, and injected for the same reason: the kernel names the
 * seam and knows nothing about the target. The control plane binds an R2
 * implementation; a self-host may bind a file, an object store, or nothing at all
 * — and nothing at all is supported, it just means the outbox is never drained.
 *
 * `ship` MUST be durable before it resolves, and the stakes are higher here than
 * for the access log: a resolved `ship` is what licenses stamping `drainedAt`, and
 * the whole promise of Tier 2 is EXACT history. A sink that buffers and returns
 * early turns "the lake has everything" into a claim nobody can check.
 *
 * Unlike the access log, a drained event is NOT pruned from the scope afterwards.
 * Pruning the outbox is its own decision — consumers, replay and `readHistory` all
 * read it — so this seam only ever ships and stamps. What the stamp buys today is
 * knowing what has left; what it licenses later is a retention policy that does
 * not exist yet.
 */
export interface EventSink {
  /**
   * Ship one scope's batch and return an opaque reference to where it landed. The
   * scope is passed alongside because a lake partitions by it — the sink decides
   * how, the kernel only reports the reference back.
   */
  ship(scope: { tenantId: TenantId; scopeId: ScopeId }, events: DrainedEvent[]): Promise<{ ref: string }>;
}

/** How many access rows one pass ships, and one pass prunes, by default. */
const ACCESS_LOG_BATCH = 500;

/** How many events one pass drains PER SCOPE by default. */
const EVENT_DRAIN_BATCH = 200;

export interface PlatformSweepOptions {
  /**
   * The durable sweep record (#1232): called once per unit outcome — each
   * connection swept/skipped/failed, each schedule run — with the signals stamp
   * the frame can honestly carry. UNSET ⇒ the pass records nothing, exactly as
   * before the seam existed. Sync fire-and-forget: a recorder that throws must
   * never sink the pass, so callers hand in a closure that swallows its own
   * errors (the ops-failure recorder's shape, worker.ts).
   */
  recordSweepRun?: (entry: SweepRunInput) => void;
  /** The platform actor the enumeration reads run as (`listScopes`/`listConnections`). */
  actor: PlatformActorId;
  /** Sanctioned egress handed to each connector sweeper. */
  fetch: FetchLike;
  /** provider slug → its reconcile sweeper. A connection whose provider is absent is skipped. */
  sweepers: Record<string, ConnectorSweeper>;
  /** Max scope drains / connection sweeps in flight at once. Default 8. */
  concurrency?: number;
  /**
   * Also drain each active scope's due executor deliveries — the retry driver
   * (connections.md §2.1), which has been landed and equally lacks a caller.
   * Default `true`; set `false` to sweep only connectors.
   */
  drainRetries?: boolean;
  /**
   * Also drain each active scope's pending PLATFORM INTENTS (platform-intents.md) — the requests a
   * vertical enqueued via `ctx.requestPlatform`. Injected like `reapScopeFn`: the kernel cannot
   * reach a vertical's scope DO (it lives in the vertical's own deployment), so the control plane
   * supplies a fn that pulls + executes each intent over the vertical's `/internal` surface. UNSET
   * (the default) skips the phase; returns per-scope counts, summed into `platformRequestTotals`.
   */
  drainPlatformRequestsFn?: (
    tenantId: TenantId,
    scopeId: ScopeId,
  ) => Promise<{ drained: number; done: number; failed: number; pending: number }>;
  /**
   * Re-run one scope's provision in the vertical's own deployment (#1172).
   *
   * Injected like `drainPlatformRequestsFn` and for the same reason: the kernel cannot
   * reach a vertical (its scope DO lives in the vertical's deployment), so the control
   * plane supplies the fn that goes over `/internal/reconcile`. UNSET skips the phase.
   *
   * What makes the phase necessary: a vertical's `onProvision` runs ONCE per scope, at
   * install. Anything the vertical mints for itself there — a service principal, a site
   * registration — therefore never reaches an install that predates it. The new code
   * deploys, and the thing it depends on was never created. Comparing the version whose
   * code RUNS on the scope (`runningVersionOf`, #1653) against the one its provision last
   * ran against is how the platform sees that, and this fn is how it fixes it.
   *
   * `expected` is the version the phase will record on success — the one running on the
   * scope. A fn whose deployment for the scope runs a DIFFERENT version (its resolver fell
   * back from the serving script to the bound version's, say) must throw rather than
   * resolve: the receipt would otherwise name a hook that never ran, and the scope would
   * read as repaired while the code it runs was never provisioned for. A throw leaves it
   * unmarked and counted `failed`, which is where it belongs.
   *
   * Resolves `'unsupported'` when the vertical answered that it implements no reconcile
   * (a 501 from `/internal/reconcile`). That is neither a success nor a failure: no
   * receipt is written, since nothing ran, and it is counted apart from `failed` so a
   * vertical that simply lacks the route does not drown the refusals somebody must read.
   */
  reconcileScopeFn?: (tenantId: TenantId, scopeId: ScopeId, expected: string) => Promise<void | 'unsupported'>;
  /**
   * The most scopes the #1172 phase reconciles in ONE pass (#1653). Default
   * {@link PROVISION_RECONCILE_BATCH}.
   *
   * A promote of a LISTED vertical puts every install of it behind at once — each one is
   * another tenant's scope, and a popular vertical has thousands. Reconciling them all in
   * one tick is how a cron becomes an incident, so the phase takes at most this many and
   * the rest wait for the next pass (`deferred`). `0` reconciles nothing: the phase still
   * counts who is behind, which makes it the pause switch.
   */
  provisionReconcileBatch?: number;
  /**
   * Where the #1172 window starts, as a number in [0, 1) — `Math.random` unless given.
   *
   * The behind scopes are ordered by id and the pass takes a contiguous window of
   * `provisionReconcileBatch` from a random starting point, wrapping. A FIXED start would
   * let installs that fail on every pass hold the same slots forever and starve every
   * healthy one behind them; a random start gives each behind scope a chance of
   * batch/behind per pass however many of the others keep failing. Injectable so that
   * property is tested rather than hoped for.
   */
  provisionReconcileRng?: () => number;
  /**
   * Also reap expired snapshots (preview-and-snapshots.md §3/§9): any FORK
   * (`forkedFrom` set) whose `expiresAt` has passed is hard-deleted via
   * `deleteSnapshot`. Default `true` — an expiry is only ever present because the
   * snapshot's creator asked for one, so sweeping it is honoring that request, and
   * `deleteSnapshot` refuses non-forks regardless. Set `false` to skip the phase.
   */
  gcSnapshots?: boolean;
  /**
   * How the GC phase deletes one expired fork. Defaults to `host.deleteSnapshot` —
   * right whenever the host and the scope's storage share a deployment (self-host,
   * a vertical's own sweep). The CONTROL-PLANE cron overrides it with the
   * orchestrated delete (§9): wipe the fork's storage in the vertical deployment
   * that actually holds it, then the in-process delete for directory row + audit.
   */
  deleteSnapshotFn?: (tenantId: TenantId, scopeId: ScopeId) => Promise<void>;
  /**
   * Also reap long-archived scopes (control-plane.md §4.4): any scope in `archived`
   * whose `archivedAt` is older than this many days has its DO storage wiped and moves
   * to `reaped` (Cloudflare never GCs a Durable Object, so nothing else frees it). The
   * directory row survives as a tombstone. UNSET (the default) skips the phase entirely
   * — auto-reap is opt-in, and irreversible, so a deployment must name a retention
   * window before the sweep will ever delete an app's data. A scope with a null
   * `archivedAt` (archived before this column shipped) is never auto-reaped — it has no
   * knowable age — and must be reaped by hand.
   */
  reapArchivedAfterDays?: number;
  /**
   * How the reap phase reaps one archived scope. Defaults to `host.admin.reapScope` —
   * right when host and storage share a deployment (self-host, a vertical's own sweep).
   * The CONTROL-PLANE cron overrides it with the orchestrated reap (§4.4): wipe the
   * scope's storage in the vertical deployment that actually holds it (its DO is
   * CP-less), then the in-process reap for the directory transition + audit.
   */
  reapScopeFn?: (tenantId: TenantId, scopeId: ScopeId) => Promise<void>;
  /**
   * Also drain the staff access log to Tier 2 and prune what it drained (K-24,
   * control-plane.md §4.4). UNSET (the default) skips the phase entirely, exactly like
   * `reapArchivedAfterDays`: a deployment that has named no durable target must not have
   * its evidence deleted on a schedule, and "no sink configured" is a supported posture
   * (the log then grows unbounded — stated, not silent).
   *
   * Bounded per pass by `accessLogBatch`, not run to exhaustion: a sweep tick has a
   * budget, and an unbounded first pass over a year of rows is how a cron becomes an
   * incident. The window closes over several ticks instead of one.
   */
  accessLogSink?: AccessLogSink;
  /**
   * Where each scope's domain events are shipped (#1334). UNSET ⇒ no scope is
   * drained, exactly as before the seam existed — the same "absent is a supported
   * answer" shape `accessLogSink` and `recordSweepRun` already have.
   */
  eventSink?: EventSink;
  /** Events drained per scope per pass. Default 200. */
  eventDrainBatch?: number;
  /**
   * Deliver cross-vertical events (#1705). For every active primary scope whose running code
   * imports from another vertical, resolve that vertical's instance in the SAME tenant, read
   * its outbox after the watermark the consumer holds, and hand the batch to the consumer.
   *
   * UNSET skips the phase, and opting in is deliberate. On the shared control plane this host's
   * own namespace is the module-less placeholder, so the default reach would construct an empty
   * DO per active scope per tick and report a fleet with no edges. The control plane opts in
   * with a reach over `/internal`. A self-host, whose host IS the deployment, opts in with `{}`.
   */
  crossVertical?: CrossVerticalOptions;
  /** Rows shipped (and pruned) per pass. Default 500. */
  accessLogBatch?: number;
  /**
   * Also reap tenants past their grace window (control-plane.md §4.8): any tenant in
   * `deleting` whose `deletingAt` is older than this many days has every scope reaped
   * and its PII/config directory rows cleared, moving it to `reaped` (a tombstone).
   * UNSET (the default) skips the phase entirely — like `reapArchivedAfterDays`, the
   * reap is irreversible, so a deployment must name a retention window before the sweep
   * will ever destroy a tenant's data. A tenant with a null `deletingAt` (flipped before
   * the column shipped) is never auto-reaped and must be reaped by hand.
   */
  reapDeletingAfterDays?: number;
  /**
   * How the reap phase reaps one due tenant. The default composes the existing
   * `reapScopeFn` seam: for each of the tenant's non-reaped scopes it archives (if
   * needed) then reaps via `reapScopeFn`, and finally clears the directory via
   * `host.admin.reapTenant`. Because it rides `reapScopeFn`, the CONTROL-PLANE cron
   * gets the orchestrated per-scope reap (wipe each DO in its vertical deployment) for
   * free just by setting `reapScopeFn` — it need not override this. Supplied only to
   * fully replace the tenant-reap behavior.
   */
  reapTenantFn?: (tenantId: TenantId) => Promise<void>;
  /**
   * Also reconcile migrations (kernel-design §5.3, #49): walk the directory for
   * live scopes behind this host's frontier or failed, wake each with
   * `migrateScope`, back off between retries of a failing scope, and report
   * "release N: X/Y migrated, P pending, F failed". Default `true`; the phase
   * also quietly skips itself on a host that predates `migrateScope`.
   */
  reconcileMigrations?: boolean;
  /**
   * Also run each vertical's DUE recurring schedules (#383): for every module that
   * declares `schedules`, enumerate its live scopes and invoke each due operation
   * under a system actor via `runDueSchedules`. Default `true`; the phase
   * feature-detects `host.registeredSchedules` and quietly yields `schedules: null`
   * on a fake or pre-#383 host, and does nothing when no module declares any.
   */
  runSchedules?: boolean;
  /**
   * Backoff between retries of a FAILED scope, keyed off the directory's
   * consecutive-attempt count: `baseDelayMs * 2^(attempts-1)`, capped at
   * `maxDelayMs`, jittered ±20% (the same curve executor retries use). There is
   * no max-attempts: a broken migration heals only by a patched forward release,
   * so the sweep retries at the capped cadence until one arrives — flagging past
   * `migrationFlagThreshold` is the human signal, not a stop. Defaults: 60s
   * base, 1h cap. Never-attempted stragglers are always due — waking them IS the
   * sweep's job.
   */
  migrationBackoff?: { baseDelayMs?: number; maxDelayMs?: number };
  /** Consecutive failures before a scope is flagged/paged. Default 3. */
  migrationFlagThreshold?: number;
  /**
   * The paging seam (§5.3 "pages past a threshold"): called once per pass with
   * the failed scopes at/over the threshold, only when there are any. The
   * deployment wires it to whatever alerting it has; the same list always rides
   * `report.migrations.stragglers` (`flagged: true`), so ignoring the callback
   * loses nothing but immediacy. A throwing pager is caught — it must never
   * sink the pass it is reporting on.
   */
  onMigrationsFlagged?: (flagged: MigrationStraggler[]) => void;
}

/**
 * What the migration-reconciliation phase did in one pass: the fleet progress
 * AFTER the pass (the §5.3 "release N: X/Y migrated…" numbers, shared shape
 * with the ops-console view), plus the pass's own work.
 */
export interface MigrationSweepReport extends MigrationProgress {
  /** `migrateScope` calls made this pass (stragglers that were due). */
  attempted: number;
  /** Stragglers this pass brought to the frontier. */
  repaired: number;
  /** Failed scopes skipped this pass — their backoff window has not elapsed. */
  deferred: number;
  /** Attempts where this host had nothing pending — the scope's modules run in another deployment. */
  noops: number;
}

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
 * below the transaction (a torn copy of the file, a restore that carried one).
 */
export const SCHEDULE_STATE_REBUILD = `
  DROP TABLE IF EXISTS _substrat_schedule_state_new;
  ${SCHEDULE_STATE_DDL.replace(
    'CREATE TABLE IF NOT EXISTS _substrat_schedule_state',
    'CREATE TABLE _substrat_schedule_state_new',
  )}
  INSERT INTO _substrat_schedule_state_new (kind, schedule_op, last_run_at, last_status)
    SELECT CASE WHEN substr(schedule_op, 1, 10) = 'freshness:' THEN 'freshness' ELSE 'schedule' END,
           schedule_op, last_run_at, last_status
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

/** What the #1172 phase did — see `reconcileScopeFn`. */
export interface ProvisionReconcileReport {
  /**
   * Scopes whose running version differed from the one their provision last ran against
   * this pass. Always `reconciled + failed + unsupported + deferred`.
   */
  behind: number;
  /** Of those, the ones whose reconcile succeeded and were marked. */
  reconciled: number;
  /** Of those, the ones whose reconcile threw. They stay behind and retry next pass. */
  failed: number;
  /**
   * Of those, the ones whose vertical implements no reconcile (a 501). Unmarked like a
   * failure, so they are asked again next pass; counted apart so they cannot pass for one.
   * `scopeIds` is capped at {@link PROVISION_RECONCILE_REPORTED_IDS}; `count` is exact.
   */
  unsupported: { count: number; scopeIds: string[] };
  /** Of those, the ones past this pass's `provisionReconcileBatch`. Next pass's work. */
  deferred: number;
}

/** The #1172 phase's per-pass bound when `provisionReconcileBatch` is unset (#1653). */
export const PROVISION_RECONCILE_BATCH = 50;

/** How many `unsupported` scope ids one report carries — the count stays exact. */
export const PROVISION_RECONCILE_REPORTED_IDS = 50;

/**
 * A scope the platform may treat as the REAL install, rather than a copy of one (#1172,
 * #1653). The directory is the only oracle for this, and it takes BOTH tests, not one.
 *
 * A fork is an archive or a preview of somebody else's data, and re-provisioning one
 * runs the vertical's install-side hook against a copy, minting a second set of whatever
 * it mints — or, since #1656, putting a copy of production on a sweeper that reaps and
 * assigns. But a CLEAN-ROOM preview (#509) is an empty scope with no source to copy, so
 * it carries `kind: 'preview'` and NO `forkedFrom` — the reap sweep keys on `kind` for
 * exactly that reason. Filtering on lineage alone would let those through, which is the
 * one shape of scope where the hook's effects are least wanted.
 */
export function isPrimaryScope(scope: Pick<Scope, 'forkedFrom' | 'kind'>): boolean {
  return !scope.forkedFrom && scope.kind !== 'preview';
}

/** What a vertical's stable serving script runs (#286) — `Vertical.servingRef`/`servingVersionId`. */
export interface ServingPointer {
  ref: string;
  versionId: string;
}

/**
 * The version whose code actually executes for `scope` (#1653) — which is not always the
 * one it is bound to.
 *
 * A scope on its vertical's stable serving script (`servingRef`, #286) runs whatever that
 * script serves, and a promote re-uploads the script in place: the code changes under
 * the scope at that moment, whatever its version pointer says. For a PRIVATE vertical
 * the promote moves the pointer too, so the two agree. For a LISTED one it does not —
 * the pointer is the tenant's, and moves only on their Update — so an install can run
 * version N+1 with its provision state still at N. Measuring against the running version
 * is what lets the reconcile follow the code instead of the pointer.
 *
 * Falls back to the bound version whenever the serving script cannot be named: a scope
 * with no `servingRef` (legacy per-version dispatch, where the bound version's own
 * script IS what runs), a vertical with nothing served in place yet, or a `servingRef`
 * that is not the vertical's current one. The fallback is exactly the pre-#1653 answer,
 * so an unknown never manufactures a reconcile.
 */
export function runningVersionOf(
  scope: Pick<Scope, 'verticalVersionId' | 'servingRef'>,
  serving: ServingPointer | null | undefined,
): string | null {
  if (scope.servingRef && serving && scope.servingRef === serving.ref) return serving.versionId;
  return scope.verticalVersionId;
}

/**
 * Every vertical's serving pointer, for `runningVersionOf` — one `listVerticals` read, and only
 * when some scope is actually on a serving script, since nothing else can differ from its
 * binding. Shared by the provision reconcile (#1653) and the cross-vertical narrowing (#1705).
 */
async function servingPointersFor(
  admin: Pick<HostAdmin, 'listVerticals'>,
  actor: PlatformActorId,
  scopes: readonly Pick<Scope, 'servingRef'>[],
): Promise<Map<string, ServingPointer>> {
  const serving = new Map<string, ServingPointer>();
  if (!scopes.some((s) => s.servingRef)) return serving;
  for (const v of await admin.listVerticals(actor)) {
    if (v.servingRef && v.servingVersionId) serving.set(v.slug, { ref: v.servingRef, versionId: v.servingVersionId });
  }
  return serving;
}

/**
 * This pass's share of the behind scopes: at most `batch`, as a contiguous window over
 * the id order, starting at `rng()` of the way round and wrapping. Deterministic for a
 * given `rng`, which is what makes the fairness claim testable.
 */
function reconcileWindow<T extends { id: string }>(behind: readonly T[], batch: number, rng: () => number): T[] {
  if (behind.length <= batch) return [...behind];
  if (batch <= 0) return [];
  const ordered = [...behind].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = Math.min(ordered.length - 1, Math.max(0, Math.floor(rng() * ordered.length)));
  return Array.from({ length: batch }, (_, i) => ordered[(start + i) % ordered.length]!);
}

export interface PlatformSweepReport {
  /** Active scopes `drainDue` ran on. */
  scopesDrained: number;
  /** Drain outcomes summed across scopes. */
  drainTotals: ExecutorDrainReport;
  /** Connections a sweeper ran for. */
  connectionsSwept: number;
  /** Connections skipped — revoked, or their provider has no registered sweeper. */
  connectionsSkipped: number;
  /** Expired forks reaped by `deleteSnapshot` this pass. */
  snapshotsReaped: number;
  /** Long-archived primary scopes reaped by `reapScope` this pass (§4.4). */
  archivedScopesReaped: number;
  /** Tenants past their grace window reaped this pass (§4.8). */
  tenantsReaped: number;
  /** Platform-intent drain outcomes summed across scopes (platform-intents.md). */
  platformRequestTotals: PlatformRequestDrainTotals;
  /**
   * Scopes whose provision was re-run because the version running on them had moved past
   * the one it last ran against (#1172, #1653), or null when no `reconcileScopeFn` was
   * supplied.
   *
   * Null and `{ reconciled: 0 }` are different facts, as everywhere else in this report:
   * the first is "nobody looked".
   */
  provisionReconcile: ProvisionReconcileReport | null;
  /**
   * The migration-reconciliation phase's report (§5.3, #49), or null when the
   * phase was disabled or the host predates `migrateScope`. Note null vs a
   * report saying "everything migrated" are different facts — the first is
   * "nobody looked", which is exactly the unfalsifiable state the sweep exists
   * to end.
   */
  migrations: MigrationSweepReport | null;
  /**
   * The recurring-schedule phase's report (#383), or null when the phase was
   * disabled or the host predates `registeredSchedules`. Null vs a report of zeros
   * are different facts — null is "nobody ran schedules", zeros is "ran, nothing
   * due" — the same distinction `migrations` draws.
   */
  schedules: ScheduleSweepReport | null;
  /**
   * The access-log drain's report (K-24), or null when no sink was configured. Null vs
   * zeros is the same distinction `migrations` draws: null is "this deployment ships
   * nothing and its log grows by design", zeros is "shipped, nothing was waiting".
   */
  accessLog: AccessLogSweepReport | null;
  /** What the event drain shipped this pass (#1334). Null when no sink is bound. */
  eventDrain: EventDrainReport | null;
  /** Every cross-vertical edge this pass looked at (#1705). Null when the phase is off. */
  crossVertical?: CrossVerticalReport | null;
  /** Per-unit failures; the pass records and steps over each rather than aborting. */
  errors: {
    kind:
      | 'drain'
      | 'sweep'
      | 'gc'
      | 'reap'
      | 'reap-tenant'
      | 'migrate'
      | 'platform-request'
      | 'provision-reconcile'
      | 'schedule'
      | 'freshness'
      | 'access-log'
      // #1334: one scope's event drain failed — its events stay undrained.
      | 'event-drain'
      // #1705: one cross-vertical edge failed in transport. Its watermark did not move, so
      // the next pass reads the same events again. A PAUSED or unresolved edge is not an
      // error: it is a standing condition, reported on the edge and in the sweep-run rows,
      // and the failure digest must not re-send it every tick.
      | 'vertical-events';
    id: string;
    error: string;
  }[];
}

/** One pass of the access-log drain (K-24, control-plane.md §4.4). */
/** What one pass drained, across every scope it reached. */
export interface EventDrainReport {
  /** Scopes that had at least one undrained event and were shipped. */
  scopes: number;
  /** Events handed to the sink and confirmed durable. */
  shipped: number;
  /**
   * Scopes whose batch filled the budget — more remains, and the next tick takes
   * it. Reported rather than looped, so one busy scope cannot starve the pass.
   */
  incomplete: number;
  /**
   * Undrained rows a scope's read stepped over because they would not decode (#1636), plus
   * any event this sweep refused itself because the published `drainedEvent` schema did not
   * accept it (#1641 — what an older vertical, which does not validate, can still send),
   * one entry per scope that had any — ABSENT when no scope did.
   *
   * These rows are never shipped and never stamped: the lake is append-only, so a row
   * built from stand-ins could not be taken back, and the stamp is the only record of
   * what left. So they are missing from the lake for as long as they stay undecodable,
   * and every pass reads them again and reports them again. The event is still in
   * Tier 1, where `readHistory` returns it with a `decodeError`.
   *
   * Not an `errors` entry: nothing about this pass failed, and the failure digest mails
   * every error — a standing condition would be re-sent on every tick.
   */
  skipped?: EventDrainSkipped[];
}

/** One scope's share of `EventDrainReport.skipped`. */
export interface EventDrainSkipped {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** Exact. */
  count: number;
  /** The first of them, oldest first; capped (`UNDRAINED_SKIPPED_IDS`), so `count` may be larger. */
  eventIds: string[];
}

/** What the phase tells `CrossVerticalReach.candidates` (#1705 PR 2). */
export interface CandidatesHint {
  /** Only this producer's edges run on this pass (the router kick). */
  from?: string;
  /**
   * Report a unit the narrowing could not judge, and the scopes it kept as candidates for it.
   * Such a scope answering that it imports nothing is an answer, not a disagreement.
   */
  doubt?(unit: string, reason: string, scopeIds: readonly ScopeId[]): void;
}

/** How the cross-vertical phase reaches the two scopes of an edge (#1705). */
export interface CrossVerticalReach {
  /**
   * The listed scopes whose RUNNING code may import anything, found WITHOUT opening one.
   *
   * This is what keeps the phase off the fleet. It runs on a cron over every active scope,
   * and each per-scope call is a Durable Object wake (plus an `/internal` hop on the hosted
   * path). Asking every scope "do you import?" would be O(fleet) calls per tick even with no
   * edge anywhere. The answer is a code fact: a module declares `consumes: [{ from }]`, and a
   * push carries it in the version's permission registry (`imports`). So it is read where the
   * code is described, never from the scope. A scope this drops is never called.
   *
   * Optional. Absent, the default applies: this host's own registered modules
   * (`ScopeHost.registeredImports`). A host that imports nothing gets no candidates; one that
   * does gets every listed scope, which is right where one host is the deployment for all of
   * them (a self-host). The control plane passes the registry's answer per scope.
   *
   * `hint.from` is set when only one producer's edges are being run (the router kick,
   * `runCrossVerticalFrom`): a scope whose code imports nothing from that vertical may then be
   * dropped too. Ignoring the hint is correct, only dearer: an edge from another producer is
   * never run on such a pass anyway. `hint.doubt` is how a narrowing reports a unit it could not
   * judge and so kept (a version whose manifest the registry cannot read). The phase records a
   * failed `vertical-events` sweep-run row for it.
   */
  candidates?(scopes: readonly Scope[], hint?: CandidatesHint): Promise<readonly Scope[]> | readonly Scope[];
  /** The consumer's running imports and its watermark per producer. */
  importState(tenantId: TenantId, scopeId: ScopeId): Promise<ImportState>;
  /** The producer's release after a watermark, decided by the producer's own code. */
  readExports(tenantId: TenantId, scopeId: ScopeId, input: ExportReadInput): Promise<ExportedBatch>;
  /** Hand a batch to the consumer, which applies it under its watermark's compare-and-set. */
  deliver(tenantId: TenantId, scopeId: ScopeId, batch: ImportBatch): Promise<ImportResult>;
}

export interface CrossVerticalOptions {
  /**
   * How the two sides are reached. Defaults to this host's own verbs: `admin.importState`,
   * `admin.readExportedEvents` and `deliverToPeer`. That is right when one host serves both
   * scopes. Overridden where they live in different deployments: the control plane reaches
   * each over `/internal`, and a two-deployment dev setup routes by scope.
   */
  reach?: CrossVerticalReach;
  /** Events one edge moves per pass, at most. Default 200. */
  budget?: number;
  /**
   * Consumer scopes one pass visits, at most. Default {@link CROSS_VERTICAL_CONSUMERS_PER_PASS}.
   * The rest are `deferred` to the next pass, not dropped: their watermarks hold, and their
   * producers' outboxes keep the backlog. The window starts at a random point and wraps, the
   * provision reconcile's rule (#1653), so consumers that fail on every pass cannot hold the
   * same slots forever. `0` visits none, which makes it the pause switch.
   */
  maxConsumers?: number;
  /** Where the window starts, in [0, 1). `Math.random` unless given, and injectable to test fairness. */
  rng?: () => number;
}

/**
 * How many consumer scopes one pass of the cross-vertical phase visits, by default (#1705).
 *
 * Per visited consumer a pass costs one `importState` call, then per source it imports from,
 * one `readExportedEvents` on the producer and, only when something is new, one `deliverToPeer`.
 * Each call is one Durable Object round trip, plus an `/internal` hop when hosted. So a pass
 * is bounded by `maxConsumers × (1 + 2 × sources)` scope calls, and with no candidates it
 * makes none.
 */
export const CROSS_VERTICAL_CONSUMERS_PER_PASS = 100;

/**
 * One edge's pass (#1705).
 *
 * - `delivered`: a batch was applied (its events delivered, dead-lettered or withheld).
 * - `idle`: nothing new since the watermark.
 * - `paused`: one side refused the other. The producer's principal check or the consumer's
 *   door answered no, so nothing moved and the backlog waits in the producer's outbox.
 * - `unresolved`: the platform could not name both ends. The producer is not installed in
 *   the tenant, or either vertical has more than one primary instance there.
 * - `stale`: the consumer's watermark moved under this pass, and the batch was refused.
 * - `failed`: a transport or host error. Also in `errors`.
 */
export interface CrossVerticalEdge {
  tenantId: TenantId;
  consumer: { scopeId: ScopeId; vertical: string };
  producer: { vertical: string; scopeId: ScopeId | null };
  state: 'delivered' | 'idle' | 'paused' | 'unresolved' | 'stale' | 'failed';
  delivered: number;
  deadLettered: number;
  withheld: number;
  duplicates: number;
  /** The sentence a person reads. Set on every state but `delivered` and `idle`. */
  reason?: string;
  /** Types the consumer imports that the producer does not export (reported, not paused). */
  unexported?: WantedEvent[];
  /** The producer had more than one batch waiting. The next pass takes the rest. */
  more?: boolean;
}

export interface CrossVerticalReport {
  edges: CrossVerticalEdge[];
  delivered: number;
  withheld: number;
  paused: number;
  unresolved: number;
  /** Scopes whose running code may import, per `candidates`: the only ones any pass calls. */
  candidates: number;
  /** Candidates past this pass's `maxConsumers`, left for the next pass. */
  deferred: number;
}

export interface AccessLogSweepReport {
  /** Rows handed to the sink and confirmed durable. */
  shipped: number;
  /** Rows stamped `drainedAt` as a result. Below `shipped` only on a re-run. */
  marked: number;
  /** Drained rows deleted from the directory this pass. */
  pruned: number;
  /** Where the batch landed, as the sink reported it. Null when nothing shipped. */
  ref: string | null;
}

/** Platform-intent drain counts, summed across scopes in one pass. */
export interface PlatformRequestDrainTotals {
  /** Active scopes that had at least one intent drained. */
  scopes: number;
  /** Intents seen across all scopes. */
  drained: number;
  /** Executed successfully. */
  done: number;
  /** Terminally failed (unknown kind, or a handler that gave up). */
  failed: number;
  /** Left pending for a later drain (transient failure). */
  pending: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run `fn` over `items` with at most `limit` in flight. `fn` owns its errors —
 * this never rejects, so one unit's failure cannot abort the pass.
 */
async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  });
  await Promise.all(workers);
}

/**
 * One pass of the platform's scheduled work: drain every active scope's due
 * executor deliveries, then reconcile every live connection against its provider.
 *
 * This is the SCHEDULER'S UNIT OF WORK — a Cloudflare cron, a Durable Object
 * alarm, or a node timer calls it; it holds no timer itself (see
 * `startPlatformSweeper`, and docs/architecture/scheduler.md). Both halves are code
 * that landed but had no caller: `drainDue` (the retry driver) and the
 * connectors' reconcile sweeps.
 *
 * Robust because a scheduled pass must be: bounded concurrency, so one slow
 * provider cannot delay the fleet, and a failure on any one scope or connection
 * is recorded in the report and stepped over — never allowed to sink the pass.
 *
 * Provider-agnostic: connections are discovered via `listConnections` and
 * dispatched to `sweepers[provider]`, so this imports no connector. A connection
 * whose provider has no sweeper, or that is revoked, is skipped (and counted),
 * not an error.
 */
export async function runPlatformSweep(
  host: ScopeHost,
  options: PlatformSweepOptions,
): Promise<PlatformSweepReport> {
  const concurrency = options.concurrency ?? 8;
  const report: PlatformSweepReport = {
    scopesDrained: 0,
    drainTotals: { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 },
    connectionsSwept: 0,
    connectionsSkipped: 0,
    snapshotsReaped: 0,
    archivedScopesReaped: 0,
    tenantsReaped: 0,
    platformRequestTotals: { scopes: 0, drained: 0, done: 0, failed: 0, pending: 0 },
    provisionReconcile: null,
    migrations: null,
    schedules: null,
    accessLog: null,
    eventDrain: null,
    crossVertical: null,
    errors: [],
  };

  // -- migration reconciliation (kernel-design §5.3, #49) ---------------------
  // FIRST, deliberately: `drainDue` wakes scopes (and wake migrates lazily), so
  // running this phase after it would mean every failed scope gets its attempt
  // counted twice per pass — once here, once as a drain error. Feature-detected
  // so a fake or pre-#49 host degrades to `migrations: null`, never a crash.
  //
  // The scopes this phase leaves in a FAILED state are skipped by the drain
  // phase below: they fail closed, so draining them would only re-throw the
  // same migration error as noise and advance the attempt counter a second time.
  const failedThisPass = new Set<string>();
  if (
    options.reconcileMigrations !== false &&
    typeof host.migrateScope === 'function' &&
    typeof host.migrationFrontier === 'function'
  ) {
    const frontier = host.migrationFrontier();
    const flagThreshold = options.migrationFlagThreshold ?? MIGRATION_FLAG_THRESHOLD;
    const retry = {
      maxAttempts: Number.MAX_SAFE_INTEGER, // no give-up: recovery is a patched forward release
      baseDelayMs: options.migrationBackoff?.baseDelayMs ?? 60_000,
      maxDelayMs: options.migrationBackoff?.maxDelayMs ?? 3_600_000,
    };
    const now = new Date().toISOString();
    // `provisioning` included: a scope stuck there because its migration failed
    // is precisely a straggler (the pure adapter's getScope makes the same call).
    const listed = await host.admin.listScopes(options.actor, {
      status: ['active', 'provisioning'],
    });
    const fleet = migrationFleet(listed);

    // Due = behind and never-failed (wake it — that IS the sweep's job), or
    // failed with its backoff window elapsed. A failed scope inside its window
    // is deferred, not forgotten: it stays in the report as `failed`.
    const due: Scope[] = [];
    let deferred = 0;
    for (const s of fleet) {
      const state = scopeMigrationState(s, frontier);
      if (state === 'migrated') continue;
      const failure = s.migrationFailure;
      if (
        failure &&
        backoffAt(failure.attempts, retry, new Date(failure.lastAttemptAt)) > now
      ) {
        deferred += 1;
        continue;
      }
      due.push(s);
    }

    // Attempt each due straggler, then report progress over a SHADOW fleet that
    // reflects this pass's outcomes — computed by the same `migrationProgress`
    // the ops view uses, so the two shapes cannot drift. The shadow is the
    // pass's honest summary; the next pass re-reads the directory for truth.
    const after = new Map<string, Scope>(fleet.map((s) => [s.id, s]));
    let attempted = 0;
    let repaired = 0;
    let noops = 0;
    await mapBounded(due, concurrency, async (s) => {
      attempted += 1;
      try {
        const outcome = await host.migrateScope(s.tenantId, s.id);
        if (outcome.status === 'migrated') {
          repaired += 1;
          after.set(s.id, { ...s, schemaVersion: outcome.schemaVersion, migrationFailure: null });
        } else if (outcome.status === 'failed') {
          after.set(s.id, {
            ...s,
            migrationFailure: {
              version: outcome.failure.version,
              error: outcome.failure.error,
              attempts: (s.migrationFailure?.attempts ?? 0) + 1,
              lastAttemptAt: instant.parse(now),
            },
          });
        } else {
          // noop: this host had nothing pending for the scope — its modules run
          // in another deployment. State untouched, classification unchanged.
          noops += 1;
        }
      } catch (err) {
        // A throw is transport/gating trouble (DO unreachable, K-3 mismatch),
        // not a migration verdict — recorded and stepped over like every unit.
        report.errors.push({ kind: 'migrate', id: s.id, error: message(err) });
      }
    });

    const progress = migrationProgress(frontier, [...after.values()], { flagThreshold });
    report.migrations = { ...progress, attempted, repaired, deferred, noops };
    // From the shadow fleet, not `progress.stragglers` — that list is capped.
    for (const s of after.values()) {
      if (scopeMigrationState(s, frontier) === 'failed') failedThisPass.add(s.id);
    }
    const flagged = progress.stragglers.filter((f) => f.flagged);
    if (flagged.length > 0 && options.onMigrationsFlagged) {
      try {
        options.onMigrationsFlagged(flagged);
      } catch (err) {
        report.errors.push({ kind: 'migrate', id: 'onMigrationsFlagged', error: message(err) });
      }
    }
  }

  if (options.drainRetries !== false) {
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      if (failedThisPass.has(s.id)) return; // fails closed — draining is only noise
      try {
        const r = await host.drainDue(s.tenantId, s.id);
        report.scopesDrained += 1;
        report.drainTotals.attempted += r.attempted;
        report.drainTotals.delivered += r.delivered;
        report.drainTotals.retrying += r.retrying;
        report.drainTotals.deadLettered += r.deadLettered;
      } catch (err) {
        report.errors.push({ kind: 'drain', id: s.id, error: message(err) });
      }
    });
  }

  // Platform-intent drain (platform-intents.md): pull + execute each active scope's pending
  // intents. Injected because the kernel can't reach a vertical's DO (§ the control plane supplies
  // a fn that goes over the vertical's /internal surface). Skips scopes whose migration failed this
  // pass — draining a fail-closed scope is only noise, exactly like the executor drain above.
  if (options.drainPlatformRequestsFn) {
    const drain = options.drainPlatformRequestsFn;
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      if (failedThisPass.has(s.id)) return;
      try {
        const r = await drain(s.tenantId, s.id);
        if (r.drained > 0) report.platformRequestTotals.scopes += 1;
        report.platformRequestTotals.drained += r.drained;
        report.platformRequestTotals.done += r.done;
        report.platformRequestTotals.failed += r.failed;
        report.platformRequestTotals.pending += r.pending;
      } catch (err) {
        report.errors.push({ kind: 'platform-request', id: s.id, error: message(err) });
      }
    });
  }

  // -- provision reconcile (#1172, #1653) -------------------------------------
  // A vertical's `onProvision` runs once per scope, at install. So a scope serving code
  // whose provision hook never ran against it is missing whatever that hook creates —
  // and no other path will ever deliver it. This phase is what makes a push repair its
  // own installs: running version != provisioned version ⇒ reconcile once, then record it.
  //
  // RUNNING, not bound (#1653): a listed vertical's promote re-serves every install in
  // place and moves none of their pointers, so comparing against the pointer never saw
  // those installs at all. See `runningVersionOf`.
  //
  // AFTER the migration phase and skipping what failed there, like every phase that
  // touches a vertical: a fail-closed scope would only re-throw its migration error.
  if (options.reconcileScopeFn) {
    const reconcile = options.reconcileScopeFn;
    const provisionReconcile: ProvisionReconcileReport = {
      behind: 0,
      reconciled: 0,
      failed: 0,
      unsupported: { count: 0, scopeIds: [] },
      deferred: 0,
    };
    const scopes = (await host.admin.listScopes(options.actor, { status: 'active' })).filter(
      (s) => isPrimaryScope(s) && !failedThisPass.has(s.id),
    );
    const serving = await servingPointersFor(host.admin, options.actor, scopes);
    const behind: { id: ScopeId; tenantId: TenantId; target: string }[] = [];
    for (const s of scopes) {
      const running = runningVersionOf(s, s.vertical ? serving.get(s.vertical) : null);
      // No running version ⇒ nothing to compare, and nothing a reconcile could target.
      if (!running) continue;
      // A null receipt is "unknown", NOT "up to date": a scope provisioned before the
      // platform recorded this has no evidence either way, and guessing the optimistic
      // answer leaves exactly the broken installs this phase exists to heal. It costs
      // one reconcile per pre-existing scope, once, and then the receipt is there.
      if (s.provisionedVersionId === running) continue;
      behind.push({ id: s.id, tenantId: s.tenantId, target: running });
    }
    provisionReconcile.behind = behind.length;
    const batch = options.provisionReconcileBatch ?? PROVISION_RECONCILE_BATCH;
    const window = reconcileWindow(behind, batch, options.provisionReconcileRng ?? Math.random);
    provisionReconcile.deferred = behind.length - window.length;
    await mapBounded(window, concurrency, async (s) => {
      try {
        const outcome = await reconcile(s.tenantId, s.id, s.target);
        if (outcome === 'unsupported') {
          // Nothing ran, so there is nothing true to record: left unmarked, like a
          // failure, and asked again next pass. Not an error — the vertical answered
          // exactly, and it is not the kind of refusal a person has to act on per pass.
          provisionReconcile.unsupported.count += 1;
          if (provisionReconcile.unsupported.scopeIds.length < PROVISION_RECONCILE_REPORTED_IDS) {
            provisionReconcile.unsupported.scopeIds.push(s.id);
          }
          return;
        }
        // Marked with the version we RECONCILED against, read before the call — not
        // whatever the scope runs now. A promote that lands mid-pass must not have its
        // new version marked by a reconcile that ran against the old one. The serving
        // pointer is written only after its upload succeeds, so the version read here is
        // one the script was already running when the pass read it.
        await host.admin.markScopeProvisioned(options.actor, s.tenantId, s.id, s.target);
        provisionReconcile.reconciled += 1;
      } catch (err) {
        // Left unmarked on purpose: it stays behind and is retried next pass, which is
        // the whole difference between a backstop and a one-shot. One scope's failure
        // is its own: the rest of the window carries on.
        provisionReconcile.failed += 1;
        report.errors.push({ kind: 'provision-reconcile', id: s.id, error: message(err) });
      }
    });
    report.provisionReconcile = provisionReconcile;
  }

  // -- recurring schedules (#383) ---------------------------------------------
  // For each module that declares `schedules`, enumerate its live scopes and run
  // whatever is due on each, under a system actor. Feature-detected so a fake or
  // pre-#383 host degrades to `schedules: null`, never a crash — the same move the
  // migration phase makes. A scope whose migration failed this pass is skipped: it
  // fails closed, so its operations would only re-throw the migration error as noise.
  if (options.runSchedules !== false && typeof host.registeredSchedules === 'function') {
    const registrations = host.registeredSchedules().filter((r) => r.schedules.length > 0);
    if (registrations.length > 0) {
      const schedules: ScheduleSweepReport = { scopes: 0, fired: 0, skipped: 0, failed: 0 };
      // Primaries only — a fork/snapshot (forkedFrom set) is a preview or test copy;
      // firing its schedules would run real recurring side effects off a throwaway.
      const scopes = (await host.admin.listScopes(options.actor, { status: 'active' })).filter(
        (s) => s.forkedFrom === null,
      );
      await mapBounded(scopes, concurrency, async (s) => {
        if (failedThisPass.has(s.id)) return;
        let touched = false;
        for (const reg of registrations) {
          try {
            const r = await host.runDueSchedules(reg.moduleId, s.tenantId, s.id);
            if (r.fired > 0 || r.failed > 0) touched = true;
            schedules.fired += r.fired;
            schedules.skipped += r.skipped;
            schedules.failed += r.failed;
            for (const e of r.errors) {
              report.errors.push({ kind: 'schedule', id: `${s.id}:${e.operation}`, error: e.error });
            }
            // #1232: the durable per-schedule record — including `skipped`, which is
            // what makes missed-run detection derivable (an absence of even skips
            // means the sweep itself stopped reaching this scope).
            for (const run of r.runs ?? []) {
              options.recordSweepRun?.({
                kind: 'schedule',
                unit: `${s.id}:${run.operation}`,
                outcome: run.outcome,
                tenantId: s.tenantId,
                scopeId: s.id,
                vertical: s.vertical,
                version: s.verticalVersionId,
                operation: run.operation,
                ...(run.outcome === 'failed'
                  ? { error: r.errors.find((e) => e.operation === run.operation)?.error ?? null }
                  : {}),
              });
            }
          } catch (err) {
            // A throw here is transport/gating trouble (DO unreachable, K-3
            // mismatch), not a schedule verdict — recorded and stepped over.
            report.errors.push({ kind: 'schedule', id: `${s.id}:${reg.moduleId}`, error: message(err) });
          }
        }
        if (touched) schedules.scopes += 1;
      });
      report.schedules = schedules;
    }
  }

  // -- freshness expectations (#1232) -----------------------------------------
  // For each module that declares `freshness`, judge each expectation against the
  // scope's own outbox and record what the evaluator decided to report (it gates
  // on verdict change + the hourly heartbeat, so this phase only forwards).
  // Feature-detected like schedules; NOT gated on the system grant — a read of
  // the scope's own outbox needs none, and the grant tuple only exists for
  // modules with permissioned schedules anyway.
  if (
    options.runSchedules !== false &&
    typeof host.registeredFreshness === 'function' &&
    typeof host.checkFreshness === 'function'
  ) {
    const freshRegs = host.registeredFreshness().filter((r) => r.freshness.length > 0);
    if (freshRegs.length > 0) {
      const scopes = (await host.admin.listScopes(options.actor, { status: 'active' })).filter(
        (s) => s.forkedFrom === null,
      );
      await mapBounded(scopes, concurrency, async (s) => {
        if (failedThisPass.has(s.id)) return;
        // ONCE per scope, not once per module: the evaluator aggregates every
        // registered module's expectations (two modules declaring one type share
        // one gating-state key and one dedupe unit — per-module evaluation would
        // have them fighting over both). The moduleId is the entry ticket.
        try {
          const r = await host.checkFreshness!(freshRegs[0]!.moduleId, s.tenantId, s.id);
          for (const check of r.checks) {
            options.recordSweepRun?.({
              kind: 'freshness',
              unit: `${s.id}:${check.eventType}`,
              outcome: check.outcome,
              tenantId: s.tenantId,
              scopeId: s.id,
              vertical: s.vertical,
              version: s.verticalVersionId,
              eventType: check.eventType,
              observedAt: check.observedAt,
            });
          }
        } catch (err) {
          report.errors.push({ kind: 'freshness', id: s.id, error: message(err) });
        }
      });
    }
  }

  if (options.gcSnapshots !== false) {
    // Reap expired previews (§3/§9). Two shapes qualify, both throwaway-by-construction:
    // a FORK (`forkedFrom` set — a snapshot of another scope) and a clean-room PREVIEW
    // (`kind === 'preview'` with no source — a source-less environment, #509 ask (b)).
    // Enumerate every scope regardless of status — a preview is `active` in the directory —
    // and compare ISO instants lexically, the same move the tuple checker's `live()` makes.
    // `deleteSnapshot` re-checks this same predicate, so a mislabeled row fails closed there,
    // never silently deletes.
    const now = new Date().toISOString();
    const scopes = await host.admin.listScopes(options.actor);
    const expired = scopes.filter(
      (s) => (s.forkedFrom !== null || s.kind === 'preview') && s.expiresAt !== null && s.expiresAt <= now,
    );
    const reap =
      options.deleteSnapshotFn ??
      ((tenantId: TenantId, scopeId: ScopeId) =>
        host.deleteSnapshot(options.actor, tenantId, scopeId));
    await mapBounded(expired, concurrency, async (s) => {
      try {
        await reap(s.tenantId, s.id);
        report.snapshotsReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'gc', id: s.id, error: message(err) });
      }
    });
  }

  // -- reap long-archived scopes (control-plane.md §4.4) ----------------------
  // Free the storage of scopes archived longer than the retention window — Cloudflare
  // never garbage-collects a Durable Object, so an archived app's bytes persist forever
  // otherwise. Opt-in: skipped unless a retention window is configured, because the reap
  // is irreversible. A null `archivedAt` (archived before the column shipped) has no
  // knowable age and is left for a manual reap. `reapScope` re-checks the `archived`
  // status below the seam, so a row that changed underneath fails closed there.
  if (options.reapArchivedAfterDays !== undefined && options.reapArchivedAfterDays >= 0) {
    const cutoff = new Date(
      Date.now() - options.reapArchivedAfterDays * 86_400_000,
    ).toISOString();
    const archived = await host.admin.listScopes(options.actor, { status: ['archived'] });
    const due = archived.filter((s) => s.archivedAt !== null && s.archivedAt <= cutoff);
    const reap =
      options.reapScopeFn ??
      // Retention reap is a deliberate policy on already-archived scopes: force past the
      // bound-hostname guard (which exists to stop the INTERACTIVE per-scope mistake).
      ((tenantId: TenantId, scopeId: ScopeId) =>
        host.admin.reapScope(options.actor, tenantId, scopeId, { force: true }));
    await mapBounded(due, concurrency, async (s) => {
      try {
        await reap(s.tenantId, s.id);
        report.archivedScopesReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'reap', id: s.id, error: message(err) });
      }
    });
  }

  // -- reap tenants past their grace window (control-plane.md §4.8) ------------
  // A tenant flipped to `deleting` sits in a reversible grace window; once it is older
  // than the retention window, reclaim it. Runs AFTER the scope reap above so a tenant's
  // scopes are gone before the tenant row becomes a tombstone. Opt-in and irreversible,
  // exactly like the scope reap. The default `reapTenantFn` composes the same
  // `reapScopeFn` seam used above (archive-if-needed → reap each scope), then clears the
  // directory via `reapTenant` — so the control-plane cron's orchestrated per-scope reap
  // applies here for free. `reapTenant` re-checks the `deleting` status below the seam,
  // so a row that changed underneath fails closed there.
  if (options.reapDeletingAfterDays !== undefined && options.reapDeletingAfterDays >= 0) {
    const cutoff = new Date(
      Date.now() - options.reapDeletingAfterDays * 86_400_000,
    ).toISOString();
    const tenants = await host.admin.listTenants(options.actor);
    const due = tenants.filter(
      (t) => t.status === 'deleting' && t.deletingAt !== null && t.deletingAt <= cutoff,
    );
    const reapOneScope =
      options.reapScopeFn ??
      // Tenant teardown releases every name by design: force past the bound-hostname guard.
      ((tenantId: TenantId, scopeId: ScopeId) =>
        host.admin.reapScope(options.actor, tenantId, scopeId, { force: true }));
    const reapTenant =
      options.reapTenantFn ??
      (async (tenantId: TenantId) => {
        // Co-located default: reap every one of the tenant's scopes through the scope
        // seam (archive-if-needed first — reapScope only accepts `archived`), then clear
        // the tenant's directory rows. A scope already `reaped` is skipped.
        const scopes = await host.admin.listScopes(options.actor, { tenantId });
        for (const s of scopes) {
          if (s.status === 'reaped') continue;
          if (s.status !== 'archived') {
            await host.admin.archiveScope(options.actor, tenantId, s.id);
          }
          await reapOneScope(tenantId, s.id);
        }
        await host.admin.reapTenant(options.actor, tenantId);
      });
    await mapBounded(due, concurrency, async (t) => {
      try {
        await reapTenant(t.id);
        report.tenantsReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'reap-tenant', id: t.id, error: message(err) });
      }
    });
  }

  const connections = await host.admin.listConnections(options.actor, {});
  await mapBounded(connections, concurrency, async (c) => {
    // #1232: the connection's durable sweep record. A connection row carries no
    // scope (a connection spans scopes by construction) and no version.
    const record = (outcome: 'ok' | 'failed' | 'skipped', extra?: Partial<SweepRunInput>) =>
      options.recordSweepRun?.({
        kind: 'connector',
        unit: c.id,
        outcome,
        tenantId: c.tenantId,
        vertical: c.vertical,
        operation: `sweep.connector:${c.provider}`,
        connectionId: c.id,
        ...extra,
      });
    if (c.revokedAt !== null) {
      // Terminal — nothing to reconcile through it, and deliberately unrecorded:
      // a revoked connection is not "waiting to be swept", and a skipped row per
      // pass forever would be noise every strip has to filter back out.
      report.connectionsSkipped += 1;
      return;
    }
    const sweeper = options.sweepers[c.provider];
    if (!sweeper) {
      report.connectionsSkipped += 1;
      // Recorded, unlike the revoked case: "bound but no sweeper registered" is a
      // live connection nothing will ever poll — exactly the declared-vs-observed
      // finding the signals views exist to surface.
      record('skipped');
      return;
    }
    const started = Date.now();
    try {
      await sweeper(host, c.id, { fetch: options.fetch });
      report.connectionsSwept += 1;
      record('ok', { elapsedMs: Date.now() - started });
    } catch (err) {
      report.errors.push({ kind: 'sweep', id: c.id, error: message(err) });
      record('failed', { error: message(err), elapsedMs: Date.now() - started });
    }
  });

  // -- cross-vertical event delivery (#1705) ------------------------------------
  // After the provision reconcile, so a peer grant a new version declares is seated before
  // the edge that needs it is read. Before the Tier-2 drain, which only ships each scope's
  // own outbox. An import is never re-emitted into the consumer's outbox, so the two phases
  // never ship the same event twice.
  if (options.crossVertical) {
    report.crossVertical = await sweepCrossVertical(host, options, options.crossVertical, failedThisPass, report);
  }

  // -- drain each scope's domain events to Tier 2 (#1334, master-plan §5.3) ---
  // Before the access-log drain below, which is deliberately last: this phase
  // reads the directory (and so writes access rows), and the log drain ships a
  // pass's own evidence rather than leaving it for the next tick.
  if (options.eventSink) {
    report.eventDrain = { scopes: 0, shipped: 0, incomplete: 0 };
    const sink = options.eventSink;
    // Normalized, not trusted: a fractional or NaN budget reaches the adapters'
    // SQL `LIMIT` and SQLite rejects it — which the per-scope catch below would
    // then report as an event-drain error on every scope, every tick, while
    // draining nothing. Normalizing keeps a misconfiguration from looking like a
    // fleet-wide fault.
    const configured = options.eventDrainBatch ?? EVENT_DRAIN_BATCH;
    const budget =
      Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : EVENT_DRAIN_BATCH;
    const drainable = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(drainable, concurrency, async (s) => {
      try {
        const { shipped, skipped } = await drainScopeEvents(host, options, sink, {
          tenantId: s.tenantId,
          scopeId: s.id,
          budget,
        });
        if (skipped) {
          (report.eventDrain!.skipped ??= []).push({ tenantId: s.tenantId, scopeId: s.id, ...skipped });
        }
        if (shipped === 0) return;
        report.eventDrain!.scopes += 1;
        report.eventDrain!.shipped += shipped;
        // A full batch means the scope has more waiting. Reported, never looped:
        // one busy scope must not starve every other scope in the pass.
        if (shipped === budget) report.eventDrain!.incomplete += 1;
      } catch (err) {
        // One scope's failure never sinks the sweep, and never stamps: a throw
        // anywhere in read→ship→mark leaves its events exactly where they were,
        // to be taken again next tick.
        report.errors.push({ kind: 'event-drain', id: s.id, error: message(err) });
      }
    });
  }

  // -- drain the staff access log to Tier 2, then prune it (K-24, §4.4) --------
  // LAST, deliberately: every phase above reads the directory through the audited
  // seam, so each one writes access rows. Running the drain last means a pass ships
  // its own evidence rather than leaving it for the next tick.
  if (options.accessLogSink) {
    report.accessLog = { shipped: 0, marked: 0, pruned: 0, ref: null };
    try {
      await sweepAccessLog(host, options, options.accessLogSink, report.accessLog);
    } catch (err) {
      // One bad pass never sinks the sweep, and never prunes: a throw anywhere in
      // ship→stamp→prune leaves the rows exactly where they were.
      report.errors.push({ kind: 'access-log', id: 'access-log', error: message(err) });
    }
  }

  return report;
}

/**
 * One pass over every cross-vertical edge (#1705). Bounded like the event drain: one batch per
 * edge per pass, reported rather than looped, so one busy producer cannot starve the rest.
 */
async function sweepCrossVertical(
  host: ScopeHost,
  options: Pick<PlatformSweepOptions, 'actor' | 'recordSweepRun' | 'concurrency'>,
  cv: CrossVerticalOptions,
  failedThisPass: ReadonlySet<string>,
  report: Pick<PlatformSweepReport, 'errors'>,
  /** Run only this producer's outgoing edges (the router kick). Absent: every edge. */
  only?: { tenantId: TenantId; scopeId: ScopeId },
): Promise<CrossVerticalReport> {
  const out: CrossVerticalReport = {
    edges: [],
    delivered: 0,
    withheld: 0,
    paused: 0,
    unresolved: 0,
    candidates: 0,
    deferred: 0,
  };
  const reach: CrossVerticalReach = cv.reach ?? {
    importState: (t, s) => host.admin.importState(options.actor, t, s),
    readExports: (t, s, input) => host.admin.readExportedEvents(options.actor, t, s, input),
    deliver: (t, s, batch) => host.deliverToPeer(t, s, batch),
  };
  // The default narrowing: this host's own code. A host that predates `registeredImports`
  // imports nothing it could name, and is treated as importing nothing.
  const candidatesOf: NonNullable<CrossVerticalReach['candidates']> =
    reach.candidates?.bind(reach) ??
    ((scopes) => ((host.registeredImports?.() ?? []).length > 0 ? scopes : []));
  // Normalized for the eventDrainBatch reason: a fractional or NaN budget would reach a SQL
  // LIMIT, and every edge would fail every tick as though the fleet were broken.
  const configured = cv.budget ?? EVENT_DRAIN_BATCH;
  const budget = Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), 1000) : EVENT_DRAIN_BATCH;
  // Primary scopes only, on both ends (`isPrimaryScope`: no fork, no clean-room preview). A
  // fork is a copy of somebody's data. Delivering into it would feed a copy as though it were
  // the install, and reading from it would publish a copy's history to another vertical. A
  // preview is not the install either.
  //
  // A producer-scoped run reads only that tenant's scopes: both ends of an edge are in one
  // tenant, so nothing outside it can be a consumer of this producer or change how it resolves.
  const scopes = (
    await host.admin.listScopes(options.actor, { status: 'active', ...(only ? { tenantId: only.tenantId } : {}) })
  ).filter((s): s is Scope & { vertical: string } => isPrimaryScope(s) && s.vertical !== null);
  // The kick names a scope, and the edges run are the ones whose producer RESOLVES to it. A
  // fork, a preview, a second install or a scope of another tenant is not a producer, so a
  // kick naming one runs nothing (the sweep would resolve the same way).
  let from: string | null = null;
  if (only) {
    const named = scopes.find((s) => s.id === only.scopeId && s.tenantId === only.tenantId);
    const resolved = named ? resolveVerticalInstanceFrom(scopes, named.tenantId, named.vertical) : null;
    if (!named || resolved?.outcome !== 'resolved' || resolved.instance.scopeId !== named.id) return out;
    from = named.vertical;
  }

  const record = (edge: CrossVerticalEdge): void => {
    out.edges.push(edge);
    out.delivered += edge.delivered;
    out.withheld += edge.withheld;
    if (edge.state === 'paused') out.paused += 1;
    if (edge.state === 'unresolved') out.unresolved += 1;
    if (edge.state === 'failed') {
      report.errors.push({
        kind: 'vertical-events',
        id: `${edge.consumer.scopeId}:${edge.producer.vertical}`,
        error: edge.reason ?? 'failed',
      });
    }
    // Idle writes no row: one green row per edge per tick would bury the ones that matter.
    if (edge.state === 'idle') return;
    // A kick pass (`only`) can run every few seconds for a busy producer. It writes a row only
    // for an edge that moved or paused. A standing failure (an old consumer, an unresolved
    // producer) is the scheduled sweep's to record, once per tick, rather than once per kick:
    // otherwise one broken consumer beside a busy producer files thousands of identical rows.
    if (only && edge.state !== 'delivered' && edge.state !== 'paused') return;
    options.recordSweepRun?.({
      kind: 'vertical-events',
      unit: `${edge.consumer.scopeId}:${edge.producer.vertical}`,
      outcome: edge.state === 'delivered' ? 'ok' : edge.state === 'failed' ? 'failed' : 'skipped',
      tenantId: edge.tenantId,
      scopeId: edge.consumer.scopeId,
      vertical: edge.consumer.vertical,
      operation: `sweep.vertical-events:${edge.producer.vertical}`,
      error:
        edge.state === 'delivered'
          ? edge.withheld + edge.deadLettered > 0
            ? `${edge.delivered} delivered, ${edge.deadLettered} dead-lettered, ${edge.withheld} withheld by the producer`
            : null
          : (edge.reason ?? null),
    });
  };

  // Narrowed BEFORE any scope is called, then capped. The resolution below still needs every
  // primary scope (a producer is any of them), and that is the one directory read above.
  // Contained: the narrowing may read the version registry (the control plane's reach), and a
  // failed read must cost this phase one pass, not sink the phases after it. No scope is called,
  // every watermark holds, and the next pass asks again.
  // Scopes kept only because the narrowing could not judge them: their "imports nothing" is an answer.
  const doubtful = new Set<string>();
  let candidates: readonly Scope[];
  try {
    candidates = await candidatesOf(scopes, {
      ...(from !== null ? { from } : {}),
      doubt: (unit, reason, scopeIds) => {
        for (const id of scopeIds) doubtful.add(id);
        // A kick pass leaves doubt to the sweep: see the filter below and `record`.
        if (only) return;
        options.recordSweepRun?.({
          kind: 'vertical-events',
          unit: `version:${unit}`,
          outcome: 'failed',
          operation: 'sweep.vertical-events:narrowing',
          error:
            `the version registry cannot say whether ${unit} imports anything (${reason}); ` +
            `its scopes are asked directly this pass`,
        });
      },
    });
  } catch (err) {
    report.errors.push({ kind: 'vertical-events', id: 'candidates', error: message(err) });
    return out;
  }
  // A kick pass calls only the consumers the registry KNOWS import from this producer. A scope
  // kept as doubt is asked by the scheduled sweep, once per tick. Asking it on every kick would
  // cost a call, and a row, per flagged response.
  if (only) candidates = candidates.filter((c) => !doubtful.has(c.id));
  out.candidates = candidates.length;
  const configuredCap = cv.maxConsumers ?? CROSS_VERTICAL_CONSUMERS_PER_PASS;
  const cap = Number.isFinite(configuredCap) && configuredCap >= 0 ? Math.floor(configuredCap) : CROSS_VERTICAL_CONSUMERS_PER_PASS;
  const visiting = reconcileWindow(candidates, cap, cv.rng ?? Math.random);
  out.deferred = candidates.length - visiting.length;

  await mapBounded(visiting, options.concurrency ?? 8, async (consumer) => {
    if (failedThisPass.has(consumer.id)) return;
    // The consumer side, failing before any producer is named: an edge to `*`, so it lands in
    // the sweep-run rows under `<scope>:*` beside the per-producer edges, not only in `errors`.
    const consumerFailed = (reason: string): void =>
      record({
        tenantId: consumer.tenantId,
        consumer: { scopeId: consumer.id, vertical: consumer.vertical ?? '' },
        producer: { vertical: '*', scopeId: null },
        state: 'failed',
        delivered: 0,
        deadLettered: 0,
        withheld: 0,
        duplicates: 0,
        reason,
      });
    let state: ImportState;
    try {
      state = await reach.importState(consumer.tenantId, consumer.id);
    } catch (err) {
      consumerFailed(`could not read the consumer's imports: ${message(err)}`);
      return;
    }
    // A candidate is one whose code is known to import (or could not be judged). Its deployment
    // answering that it imports NOTHING means the two disagree: the scope is not running the code
    // the registry describes (a push that did not reach it, or a reconcile still owed). Said, not
    // skipped: skipping would make every edge into this scope disappear without a trace.
    if (state.consumes.length === 0 && reach.candidates && !doubtful.has(consumer.id)) {
      consumerFailed(
        "the version registry says this scope's code imports events, but its deployment answers that it " +
          'imports nothing — it is not running the version the registry names; redeploy or reconcile it',
      );
      return;
    }
    const bySource = new Map<string, WantedEvent[]>();
    for (const c of state.consumes) {
      if (from !== null && c.from !== from) continue;
      const list = bySource.get(c.from) ?? [];
      list.push({ type: c.type, schemaVersion: c.schemaVersion });
      bySource.set(c.from, list);
    }
    // Sequential per consumer: its edges share the consumer's serialization queue anyway,
    // and one consumer with many sources must not hold more than one slot of the pass.
    for (const [from, wants] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      record(await sweepEdge(reach, scopes, consumer, from, wants, state, budget));
    }
  });
  return out;
}

/**
 * Run ONE producer's outgoing edges now (#1705 PR 2): the half of the router kick that makes a
 * cross-vertical event arrive in seconds rather than at the next sweep.
 *
 * The same phase, under the same rules, narrowed. It reads the producer's tenant only, runs only
 * edges whose producer RESOLVES to `producer` (so a fork, a preview or a second install runs
 * nothing), asks `candidates` with `{ from }` so a consumer that imports nothing from this
 * vertical is never called, and keeps the per-pass consumer cap. What it moves is exactly what
 * the next sweep would have moved: the watermark's compare-and-set makes the two safe to overlap,
 * and an edge a kick has taken reads as `idle` to the sweep that follows.
 */
export async function runCrossVerticalFrom(
  host: ScopeHost,
  options: Pick<PlatformSweepOptions, 'actor' | 'recordSweepRun' | 'concurrency'> & {
    crossVertical: CrossVerticalOptions;
  },
  producer: { tenantId: TenantId; scopeId: ScopeId },
): Promise<{ crossVertical: CrossVerticalReport; errors: PlatformSweepReport['errors'] }> {
  const report: Pick<PlatformSweepReport, 'errors'> = { errors: [] };
  const crossVertical = await sweepCrossVertical(host, options, options.crossVertical, new Set(), report, producer);
  return { crossVertical, errors: report.errors };
}

/**
 * The control plane's `CrossVerticalReach.candidates` (#1705 PR 2): narrow the listed scopes to
 * those whose RUNNING version may import, read from the version registry and never from a scope.
 *
 * Per pass: one `listVerticals` (the serving pointers, only when some scope is on a serving
 * script), and one `readImports` per DISTINCT running version, at most `concurrency` in flight.
 * The control plane's reader is an unaudited directory read behind a cache keyed (slug,
 * version), since a pushed version's manifest never changes. So after the first pass it costs
 * no read at all.
 *
 * Only a version that says it imports nothing is dropped (`none`: no manifest, no registry, no
 * `imports` key). A version the registry cannot answer for (`unreadable`: a manifest that does
 * not parse, a malformed row, a version the registry does not know, a failed read) keeps its
 * scopes as candidates, and the scope's own `importState` decides. Excluding a consumer wrongly
 * loses its edge with no trace. Including one wrongly costs one call. Each such version is
 * reported once per pass through `hint.doubt`, and a failure on one version never stops the
 * others.
 */
export function registryImportCandidates(input: {
  admin: Pick<HostAdmin, 'listVerticals'>;
  actor: PlatformActorId;
  readImports: (verticalSlug: string, versionId: string) => Promise<ManifestImports>;
  /** Registry reads in flight at once. Default 8, the phase's own concurrency. */
  concurrency?: number;
}): NonNullable<CrossVerticalReach['candidates']> {
  return async (scopes, hint) => {
    const serving = await servingPointersFor(input.admin, input.actor, scopes);
    const keyed: { scope: Scope; key: string }[] = [];
    const versions = new Map<string, { slug: string; versionId: string }>();
    for (const s of scopes) {
      if (!s.vertical) continue;
      const running = runningVersionOf(s, serving.get(s.vertical));
      const key = `${s.vertical}@${running ?? '(no version)'}`;
      if (running && !versions.has(key)) versions.set(key, { slug: s.vertical, versionId: running });
      keyed.push({ scope: s, key });
    }
    const facts = new Map<string, ManifestImports>();
    await mapBounded([...versions], input.concurrency ?? 8, async ([key, v]) => {
      try {
        facts.set(key, await input.readImports(v.slug, v.versionId));
      } catch (err) {
        facts.set(key, { kind: 'unreadable', reason: message(err) });
      }
    });
    const doubted = new Map<string, { reason: string; scopeIds: ScopeId[] }>();
    const out: Scope[] = [];
    for (const { scope, key } of keyed) {
      const fact: ManifestImports = facts.get(key) ?? {
        kind: 'unreadable',
        reason: 'the scope names no version the registry could be asked about',
      };
      if (fact.kind === 'none') continue;
      if (fact.kind === 'imports') {
        const from = hint?.from;
        if (from !== undefined ? fact.rows.some((r) => r.from === from) : fact.rows.length > 0) out.push(scope);
        continue;
      }
      out.push(scope);
      const d = doubted.get(key) ?? { reason: fact.reason, scopeIds: [] };
      d.scopeIds.push(scope.id);
      doubted.set(key, d);
    }
    for (const [key, d] of doubted) hint?.doubt?.(key, d.reason, d.scopeIds);
    return out;
  };
}

async function sweepEdge(
  reach: CrossVerticalReach,
  scopes: readonly Scope[],
  consumer: Scope,
  from: string,
  wants: WantedEvent[],
  state: ImportState,
  budget: number,
): Promise<CrossVerticalEdge> {
  const vertical = consumer.vertical!;
  const edge = (
    rest: Partial<CrossVerticalEdge> & Pick<CrossVerticalEdge, 'state'>,
  ): CrossVerticalEdge => ({
    tenantId: consumer.tenantId,
    consumer: { scopeId: consumer.id, vertical },
    producer: { vertical: from, scopeId: null },
    delivered: 0,
    deadLettered: 0,
    withheld: 0,
    duplicates: 0,
    ...rest,
  });
  if (from === vertical) {
    return edge({ state: 'unresolved', reason: `'${vertical}' imports from itself — an import names ANOTHER vertical` });
  }
  // Both ends must be the tenant's one primary instance of their vertical, by #1706's one rule
  // (`resolveVerticalInstanceFrom`: same tenant, active, primary; two are `ambiguous`, refused
  // rather than guessed). The producer is who is read. The consumer is who the producer's grant
  // names, and a grant naming a slug cannot tell two installs of it apart.
  const self = resolveVerticalInstanceFrom(scopes, consumer.tenantId, vertical);
  if (self.outcome !== 'resolved' || self.instance.scopeId !== consumer.id) {
    return edge({
      state: 'unresolved',
      reason: `this tenant has more than one primary instance of '${vertical}', so the producer cannot tell which one its grant names`,
    });
  }
  const producer = resolveVerticalInstanceFrom(scopes, consumer.tenantId, from);
  if (producer.outcome !== 'resolved') {
    return edge({
      state: 'unresolved',
      reason:
        producer.outcome === 'not-installed'
          ? `'${from}' is not installed in this tenant`
          : `this tenant has more than one primary instance of '${from}' — delivery waits until one is chosen`,
    });
  }
  const source = { vertical: from, scopeId: producer.instance.scopeId };
  const at = { producer: source };
  const after = state.cursors.find((c) => c.source === source.scopeId)?.cursor ?? null;
  try {
    const batch = await reach.readExports(producer.instance.tenantId, source.scopeId, {
      consumer: vertical as ExportReadInput['consumer'],
      after,
      wants,
      limit: budget,
    });
    const unexported = batch.unexported.length ? { unexported: batch.unexported } : {};
    if (batch.paused) {
      return edge({
        ...at,
        ...unexported,
        state: 'paused',
        reason:
          `paused: producer '${from}' does not grant vertical:${vertical} ${batch.paused.missing.join(', ')} — ` +
          `nothing was read; the backlog waits in its outbox`,
      });
    }
    if (batch.next === null || (batch.events.length === 0 && batch.withheld.length === 0)) {
      return edge({ ...at, ...unexported, state: 'idle' });
    }
    const result = await reach.deliver(consumer.tenantId, consumer.id, {
      source,
      after,
      next: batch.next,
      events: batch.events,
      withheld: batch.withheld,
    });
    if (result.paused) {
      return edge({
        ...at,
        ...unexported,
        state: 'paused',
        reason: `paused: consumer '${vertical}' refused '${from}' — ${result.paused.reason}; the backlog waits in the producer's outbox`,
      });
    }
    if (result.stale) {
      return edge({ ...at, state: 'stale', reason: 'the consumer\'s watermark moved under this pass; the next pass reads from where it is' });
    }
    return edge({
      ...at,
      ...unexported,
      state: 'delivered',
      delivered: result.delivered,
      deadLettered: result.deadLettered,
      withheld: result.withheld,
      duplicates: result.duplicates,
      ...(batch.more ? { more: true } : {}),
    });
  } catch (err) {
    return edge({ ...at, state: 'failed', reason: message(err) });
  }
}

/**
 * One read→ship→stamp cycle over ONE scope's outbox (#1334). Returns how many
 * events shipped, so the caller can tell a full batch (more waiting) from a
 * partial one (caught up).
 *
 * The order is the safety property, exactly as it is for the access log, and the
 * reason the two verbs are separate:
 *
 *   1. read the oldest undrained events (bounded — a tick has a budget);
 *   2. ship them, and let the sink confirm durability before returning;
 *   3. only then stamp `drainedAt`.
 *
 * Reversing 2 and 3 would let one failed upload mark events as shipped that never
 * left — and unlike the access log, nothing downstream would ever notice, because
 * the stamp is the only record of what the lake is supposed to hold. A repeat is
 * the acceptable failure here; a silent hole is not.
 *
 * Nothing is pruned. The outbox is still read by consumers, replay and
 * `readHistory`; what the stamp buys today is knowing what has left.
 *
 * What the read stepped over (#1636) comes back beside the count, for the report —
 * and ONLY for the report: those rows were never in `events`, so nothing here can
 * ship or stamp them. A host too old to say leaves it undefined.
 *
 * **And every event is parsed here, by the published `drainedEvent`, before the sink sees
 * it** (#1641). This is the last point before an append-only lake, and it is the control
 * plane's: a hosted scope's events arrive over HTTP from the vertical's own deployment,
 * decoded by whatever adapter version that vertical was pushed with. A vertical older
 * than #1636 decodes the envelope and copies its lifted columns unvalidated, so without
 * this parse a corrupt one would still ship — the invariant would hold only for verticals
 * new enough to hold it themselves. An event that fails is treated exactly as the read's
 * own skips are: not shipped, not stamped, and folded into `skipped`.
 */
async function drainScopeEvents(
  host: ScopeHost,
  options: PlatformSweepOptions,
  sink: EventSink,
  input: { tenantId: TenantId; scopeId: ScopeId; budget: number },
): Promise<{ shipped: number; skipped?: UndrainedSkipped }> {
  const read = await host.admin.readUndrainedEvents(
    options.actor,
    input.tenantId,
    input.scopeId,
    input.budget,
  );
  // A plain array to the sink, of the published schema's own output: nothing typed as a
  // DrainedEvent reaches the lake unless the schema accepted it here.
  const events: DrainedEvent[] = [];
  const refused: string[] = [];
  for (const event of read) {
    const parsed = drainedEvent.safeParse(event);
    if (parsed.success) events.push(parsed.data);
    else refused.push(String((event as { id?: unknown } | null)?.id));
  }
  const skipped = skippedOf(read.skipped, refused);
  if (events.length === 0) return { shipped: 0, skipped };
  await sink.ship({ tenantId: input.tenantId, scopeId: input.scopeId }, events);
  await host.admin.markEventsDrained(
    options.actor,
    input.tenantId,
    input.scopeId,
    events.map((e) => e.id),
  );
  return { shipped: events.length, skipped };
}

/**
 * The read's own skip, plus the events this side refused (#1641): one count, exact, and the
 * ids capped as the read caps them. Undefined when there was neither — a clean pass reports
 * nothing rather than a zero.
 */
function skippedOf(read: UndrainedSkipped | undefined, refused: string[]): UndrainedSkipped | undefined {
  const count = (read?.count ?? 0) + refused.length;
  if (count === 0) return undefined;
  return { count, eventIds: [...(read?.eventIds ?? []), ...refused].slice(0, UNDRAINED_SKIPPED_IDS) };
}

/**
 * One ship→stamp→prune cycle over the access log. Split out because the ORDER is the
 * whole safety property and deserves to be readable in one screen:
 *
 *   1. read the oldest undrained rows (bounded — a tick has a budget);
 *   2. ship them, and let the sink confirm durability before returning;
 *   3. only then stamp `drainedAt`, which is what licenses deletion;
 *   4. prune drained rows.
 *
 * Reversing 2 and 3 would let one failed upload delete evidence permanently. Step 4
 * prunes independently of what this pass shipped — rows stamped by an earlier tick
 * whose prune was interrupted are exactly as eligible, so the cycle self-heals.
 *
 * The log never reaches empty, and should not: the read in step 1 is itself a staff
 * read and records one row (K-24 — reading the record of who looked is a read). That
 * row drains on the next tick. A permanently-one-row-behind log is the honest shape of
 * an audit trail that audits its own draining.
 */
async function sweepAccessLog(
  host: ScopeHost,
  options: PlatformSweepOptions,
  sink: AccessLogSink,
  out: AccessLogSweepReport,
): Promise<void> {
  const batch = options.accessLogBatch ?? ACCESS_LOG_BATCH;
  const pending = await host.admin.accessLog(options.actor, {
    drained: false,
    order: 'asc', // oldest first — the window closes from the back
    limit: batch,
  });
  if (pending.length > 0) {
    const { ref } = await sink.ship(pending);
    out.shipped = pending.length;
    out.ref = ref;
    // The batch's last id IS the watermark: ULID order is chronological and the log is
    // append-only, so rows written during the shipment sort strictly after it and are
    // left for the next tick rather than being stamped unshipped.
    const upToId = pending[pending.length - 1]!.id;
    out.marked = await host.admin.markAccessLogDrained(
      options.actor,
      upToId,
      instant.parse(new Date().toISOString()),
    );
  }
  out.pruned = await host.admin.pruneAccessLog(options.actor, batch);
}

/** A running sweeper; `stop()` prevents the next pass and cancels the pending timer. */
export interface PlatformSweeperHandle {
  stop(): void;
}

export interface StartPlatformSweeperOptions extends PlatformSweepOptions {
  /**
   * Milliseconds between the END of one pass and the START of the next — a gap,
   * not a fixed rate. Rescheduling only after a pass settles means two passes can
   * never overlap, even when a pass runs longer than the interval.
   */
  intervalMs: number;
  /** Observe each pass — for logging or a health metric. Never throws into the loop. */
  onPass?: (outcome: PlatformSweepReport | { error: string }) => void;
  /** Injected for tests; default to the runtime's timer. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Drive `runPlatformSweep` on a self-rescheduling timer — the node/long-lived
 * runtime's trigger. (A Cloudflare deployment uses `scheduled()`/an alarm instead
 * and calls `runPlatformSweep` directly; both share the one unit of work.)
 *
 * Non-overlapping by construction: the next pass is scheduled only once the
 * current one settles, so a slow pass delays the next rather than stacking on it.
 */
export function startPlatformSweeper(
  host: ScopeHost,
  options: StartPlatformSweeperOptions,
): PlatformSweeperHandle {
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  let stopped = false;
  let handle: unknown;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      options.onPass?.(await runPlatformSweep(host, options));
    } catch (err) {
      options.onPass?.({ error: message(err) });
    }
    if (!stopped) handle = setTimer(() => void tick(), options.intervalMs);
  };

  handle = setTimer(() => void tick(), options.intervalMs);
  return {
    stop() {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
    },
  };
}
