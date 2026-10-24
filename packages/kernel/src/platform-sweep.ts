import { drainedEvent, instant, substratError } from '@substrat-run/contracts';
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
  EdgeHealth,
  EdgeHealthReport,
  ExportReadInput,
  ExportedBatch,
  ImportBatch,
  ImportResult,
  ImportState,
  ManifestImports,
  WantedEvent,
} from '@substrat-run/contracts';
import type { ExecutorDrainReport, FetchLike, HostAdmin, ReconcileOutcome, ScopeHost, SweepRunInput, TelemetryPruneReport } from './scope-host.js';
import type { FindingPruneReport } from './findings.js';
import { STORAGE_GAUGE_PRUNE_BATCH, STORED_SCOPE_STATUSES, holdsStore, type ScopeStorageReadingInput } from './storage-gauge.js';
import { BILLING_ROLLUP_RETENTION_MONTHS, billingRollupHorizon, utcDayOf } from './billing-retention.js';
import { METER_DAYS_PRUNE_BATCH, METER_SNAPSHOT_TIMEOUT_MS } from './meter-days.js';
import {
  REQUEST_ROLLUP_DAYS_PER_PASS,
  REQUEST_ROLLUP_LOOKBACK_DAYS,
  REQUEST_ROLLUP_MAX_LOOKBACK_DAYS,
  REQUEST_ROLLUP_PRUNE_BATCH,
  REQUEST_ROLLUP_READ_TIMEOUT_MS,
  REQUEST_ROLLUP_RETRY_MS,
  REQUEST_ROLLUP_SETTLE_MS,
  isRequestRollupSaturated,
  requestRollupDueDays,
  type RequestDayCount,
} from './request-rollup.js';
import { assertRowLimit, backoffAt, fetchLikeOf, TELEMETRY_PRUNE_BATCH } from './scope-host.js';
import { MIGRATION_FLAG_THRESHOLD, migrationFleet, migrationProgress, scopeMigrationState } from './migration-progress.js';
import { UNDRAINED_SKIPPED_IDS, type UndrainedSkipped } from './outbox-event.js';
import { resolveVerticalInstanceFrom, type PeerTenant } from './peer.js';
import type { ScheduleSweepReport } from './schedule-state.js';
import { isPrimaryScope, runningVersionOf, servingPointersFor } from './scope-identity.js';
import { mapBounded, message } from './map-bounded.js';
import { runningImportsOf } from './export-break.js';
import { ORPHAN_SWEEP_DRY_RUN_WINDOW_MS, type OrphanSweepReport } from './attachment-sweep.js';
import { LandingPass, type ConnectionLandingOptionsInput } from './connection-landings.js';

// #2314: the one record of deleted keys when the admin log could not take it.
declare const console: { error(message: string): void };

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
 * The part of a BINDING sweeper's answer the pass reads (#2316) — what the poll connectors' own
 * results (`FortnoxSweepResult`, `PlanimaSweepResult`, `Microsoft365SweepResult`) carry: how many
 * bindings it found, and which scopes failed.
 *
 * Read only for a provider that binds (one with a binder in `connectionLandings`): a dispatch
 * connector's answer can have the same two names and mean something else — Scrive's `found` counts
 * outstanding dispatches, and none outstanding is not "nothing polls this connection". Any other
 * sweeper is recorded `ok` once it resolves, as every sweeper was before.
 */
export interface ConnectorSweepAnswer {
  found: number;
  failed: readonly { scopeId: string; error: string }[];
}

/** {@link ConnectorSweepAnswer} out of whatever a sweeper resolved with, or null when it says neither. */
export function connectorSweepAnswerOf(result: unknown): ConnectorSweepAnswer | null {
  if (typeof result !== 'object' || result === null) return null;
  const { found, failed } = result as { found?: unknown; failed?: unknown };
  if (typeof found !== 'number' || !Array.isArray(failed)) return null;
  return {
    found,
    failed: failed
      .filter((f): f is { scopeId: unknown; error: unknown } => typeof f === 'object' && f !== null)
      .map((f) => ({ scopeId: String(f.scopeId), error: String(f.error) })),
  };
}

/** The text a connection's sweep row carries when a poll found no binding to sweep. */
export const NO_BINDING = 'connection has no binding: nothing was polled for any scope';

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
  /**
   * #2316: grant and bind each live connection from the landings its vertical's running version
   * declares, before it is swept. UNSET skips the step, and a connection is swept on whatever
   * bindings it already has, as before.
   */
  connectionLandings?: ConnectionLandingOptionsInput;
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
    /**
     * #2431: always passed by the sweep. `skip` is the intents an earlier drain of this scope
     * tried in the same pass; a fn leaves them alone — each run is an attempt toward the
     * intent's ceiling — and drains only the rest. Absent on the pass's first drain of a scope.
     */
    opts?: { skip?: readonly string[] },
  ) => Promise<{
    drained: number;
    done: number;
    failed: number;
    pending: number;
    /**
     * #2431: the ids this drain tried, which a second drain in the same pass is told to skip —
     * `[]` when it tried none. Required, so a fn that leaves it out does not compile, rather than
     * having its intents silently tried twice.
     */
    attempted: string[];
    /** No deployment could be reached for this scope, so nothing was drained or counted (#1840). */
    unreachable?: boolean;
    /** Pending intents nothing could run or settle — their stored id is not an id (#1637). */
    unsettleable?: { count: number; ids: (string | null)[] };
  }>;
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
   *
   * #2185: resolves a {@link ReconcileOutcome} when it can say what the reconcile finished, and
   * the receipt records it. `void` records the receipt with its retirements not finished, so the
   * scope stays behind and is reconciled again next pass.
   */
  reconcileScopeFn?: (tenantId: TenantId, scopeId: ScopeId, expected: string) => Promise<void | 'unsupported' | ReconcileOutcome>;
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
  /** Rows of each telemetry table pruned per pass (#1632). Default `TELEMETRY_PRUNE_BATCH`. */
  telemetryBatch?: number;
  /**
   * Sample scope database sizes into the stored storage gauge (#1524). UNSET (the default)
   * skips the phase, as does a host without `recordScopeStorage`/`listScopeStorageAttempts`.
   * Injected for the reason `drainPlatformRequestsFn` is: on the hosted plane a scope's DO
   * lives in its vertical's deployment, and only the control plane can reach it there.
   */
  storageGauge?: StorageGaugeSweepOptions;
  /**
   * Roll up each closed UTC day of the router's request datapoints into the directory (#2501).
   * UNSET (the default) skips the phase, as does a host without `recordRequestDay` and
   * `listRequestRollupDays`. Injected because the datapoints live in Analytics Engine, which only
   * the hosted control plane can query. See {@link RequestRollupSweepOptions}.
   */
  requestRollup?: RequestRollupSweepOptions;
  /**
   * Keep each UTC day's meters 1 and 2, one row per tenant, taken by the day's first pass (#2501).
   * UNSET (the default) skips the phase, as does a host without `recordMeterDay` and
   * `listMeterDayTakes`: the rows are kept for the billing horizon, so a deployment opts in. See
   * {@link MeterSnapshotSweepOptions}.
   */
  meterSnapshot?: MeterSnapshotSweepOptions;
  /**
   * Collect attachment bytes no row names (#2314), a bounded window of scopes per pass. UNSET (the
   * default) skips the phase: the sweep deletes tenant bytes, so a deployment opts in, and opts in
   * to a dry run first. See {@link OrphanAttachmentSweepOptions}.
   */
  orphanAttachments?: OrphanAttachmentSweepOptions;
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
   * With `drainPlatformRequestsFn` set, a scope whose schedules enqueued platform requests
   * is drained once more right after them (#2431).
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
 * #2185: the slots of a #1172 window owed to installs behind on their retirements alone: a quarter,
 * at least one. A window of one slot cannot be split, so it goes to them on a quarter of the passes.
 */
function retirementShareOf(batch: number, rng: () => number): number {
  if (batch >= 2) return Math.max(1, Math.floor(batch / 4));
  return batch === 1 && rng() < 0.25 ? 1 : 0;
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
  /**
   * #2316: what the landing step granted and bound from declarations, summed over connections, or
   * null when no `connectionLandings` was supplied. `failed` counts (connection, scope) pairs.
   */
  connectionLandings: { granted: number; bound: number; failed: number } | null;
  /** Expired forks reaped by `deleteSnapshot` this pass. */
  snapshotsReaped: number;
  /** Long-archived primary scopes reaped by `reapScope` this pass (§4.4). */
  archivedScopesReaped: number;
  /** Tenants past their grace window reaped this pass (§4.8). */
  tenantsReaped: number;
  /** Platform-intent drain outcomes summed across scopes (platform-intents.md). */
  platformRequestTotals: PlatformRequestDrainTotals;
  /**
   * WHERE `platformRequestTotals.unsettleable` stands (#1637): one entry per scope whose queue
   * holds a row nothing can settle — ABSENT when no scope's does. Like `eventDrain.skipped`, a
   * standing condition, so it is reported on every pass and never an `errors` entry.
   */
  platformRequestUnsettleable?: PlatformRequestUnsettleable[];
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
  /**
   * What the telemetry-retention phase deleted (#1632), or null when the host predates
   * `pruneTelemetry`. Null and zeros are different facts, as everywhere in this report.
   */
  telemetry?: TelemetryPruneReport | null;
  /**
   * What the findings retention phase did (#1748), or null when the host predates
   * `pruneFindings`.
   */
  findings?: FindingPruneReport | null;
  /** What the storage-gauge phase sampled and pruned (#1524). Null when the phase is off. */
  storage?: StorageGaugeSweepReport | null;
  /** What the orphan-attachment phase did (#2314). Null when the phase is off. */
  orphanAttachments?: OrphanAttachmentSweepReport | null;
  /** What the request-rollup phase read and pruned (#2501). Null when the phase is off. */
  requestRollup?: RequestRollupSweepReport | null;
  /** What the meter-snapshot phase took and pruned (#2501). Null when the phase is off. */
  meterSnapshot?: MeterSnapshotSweepReport | null;
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
      // #1632: the telemetry-retention prune failed; the rows stay for the next pass.
      | 'telemetry'
      // #1748: the findings retention pass failed; nothing it would have resolved is lost.
      | 'findings'
      // #1334: one scope's event drain failed — its events stay undrained.
      | 'event-drain'
      // #1705: one cross-vertical edge failed in transport. Its watermark did not move, so
      // the next pass reads the same events again. A PAUSED or unresolved edge is not an
      // error: it is a standing condition, reported on the edge and in the sweep-run rows,
      // and the failure digest must not re-send it every tick.
      | 'vertical-events'
      // #1524: one scope's size read failed. Its last stored reading stands.
      | 'storage'
      // #2314: one scope's orphan-attachment pass failed. Nothing it had not condemned is deleted,
      // and a condemned object is finished by a later pass.
      | 'attachment-sweep'
      // #2501: one day's request rollup failed. Nothing of the day is written, and the day is
      // tried again once `RequestRollupSweepOptions.retryMs` has passed.
      | 'request-rollup'
      // #2501: the day's meter snapshot failed. Nothing of it is written, and the next pass of the
      // same day tries again.
      | 'meter-snapshot';
    id: string;
    error: string;
  }[];
}

/**
 * How the storage-gauge phase samples (#1524). Every number here is a bound on DO requests.
 *
 * It samples every scope that holds a store (`STORED_SCOPE_STATUSES`), from two sources:
 * - an ACTIVE scope only when an earlier phase of the same pass already reached it: the
 *   platform-intent drain when `drainPlatformRequestsFn` is set (on the hosted plane it is the
 *   phase that wakes the vertical's DO), the executor drain otherwise. An active scope nothing
 *   reached is not read, so the gauge adds no wake to the serving fleet: a read is one more
 *   request to a DO that is already awake.
 * - a NON-SERVING scope (suspended, archiving, archived) always. Nothing else wakes it, and it
 *   still holds its storage until reap, so it belongs on the bill. This is the one wake the
 *   gauge adds: at most once a day per such scope, inside the same batch.
 * A provisioning scope has no store yet and is never read, and neither is one archived
 * straight from provisioning (`holdsStore`).
 */
export interface StorageGaugeSweepOptions {
  /**
   * One scope's database size, in bytes. A throw counts that scope `failed`: its last sample
   * stands, the failure is recorded as its attempt, and it is tried again once `maxAgeMs` has
   * passed rather than on every pass. `null` says this scope has no database this reader can
   * measure (on the hosted plane, a scope bound to no vertical, which the drain counted without
   * waking anything): it is `skipped`, never an error, and asked again a day later.
   */
  read: (scope: Scope) => Promise<number | null>;
  /** The most scopes read in one pass, stalest first. Default `STORAGE_SAMPLE_BATCH`. `0` pauses sampling. */
  batch?: number;
  /** A scope is due once its latest attempt is at least this old. Default one day. */
  maxAgeMs?: number;
  /** Samples past retention deleted per pass. Default `STORAGE_GAUGE_PRUNE_BATCH`. */
  pruneBatch?: number;
  /**
   * Scope stores read in the same pass as the database, and only for a scope that pass
   * already decided was due (#2212). Absent means this deployment does not sample stores.
   * `null` declines, the way `read` does. A throw records the database sample and
   * leaves that day's store rows as they are: the attempt carries the error. A deployment
   * that cannot read stores (`StorageReadUnsupported`) is neither: its attempt carries no
   * error, so the gauge does not count the scope as failing, and it stays out of the digest.
   * A read past `storeReadTimeoutMs` is an ordinary failure.
   */
  readStores?: (scope: Scope) => Promise<{ binding: string; bytes: number }[] | null>;
  /**
   * How long one scope's store read may take, in ms (#2212). Past it the read counts as failed
   * and the database sample is kept: one hung store must not hold the pass past its invocation
   * limit and lose every sample the batch read. Default `STORE_READ_TIMEOUT_MS`.
   */
  storeReadTimeoutMs?: number;
  /** The instant the pass judges age against. Default the wall clock. */
  now?: () => string;
}

/**
 * What a storage reader throws when the scope's deployment cannot read a size at all (#1524):
 * a vertical built before `/internal/database-size`. That is a standing condition until the
 * vertical is redeployed, like a paused cross-vertical edge, so the phase records it as the
 * scope's attempt error (the meter still counts the scope `failing`, with this reason) and
 * keeps it OUT of `report.errors`, which the failure digest mails every pass. Recognised by its
 * `unsupported` flag rather than `instanceof`, so a copy of the kernel bundled elsewhere still
 * matches.
 */
export class StorageReadUnsupported extends Error {
  readonly unsupported = true as const;
}

const isUnsupported = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { unsupported?: unknown }).unsupported === true;

/** `work`, or a rejection once `ms` have passed. The work is not cancelled; the pass stops waiting. */
async function withinDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The storage-gauge phase's per-pass bound when `batch` is unset. */
export const STORAGE_SAMPLE_BATCH = 100;
/** How old a reading may get before the phase reads the scope again, by default. */
export const STORAGE_SAMPLE_MAX_AGE_MS = 86_400_000;

/** How long one scope's store read may take before it counts as failed, by default (#2212). */
export const STORE_READ_TIMEOUT_MS = 15_000;

/** What the storage-gauge phase did in one pass (#1524). */
export interface StorageGaugeSweepReport {
  /** Active scopes an earlier phase reached this pass: the only active ones the phase may read. */
  reached: number;
  /** Non-serving scopes that hold a store (suspended, archiving, archived): read without a drain. */
  resting: number;
  /** Reached scopes never tried, or last tried at least `maxAgeMs` ago. */
  due: number;
  /** Due scopes left for a later pass because the batch was full. */
  deferred: number;
  /**
   * Scopes tried, by how their attempt was recorded: without an error, with one, or declined
   * (`null`). `read + failed + skipped` is the scopes tried. A store read that fails counts in
   * `failed` even though the scope's database sample is recorded with it (#2212).
   */
  read: number;
  failed: number;
  skipped: number;
  /**
   * Reads the deployment cannot make (`StorageReadUnsupported`): a standing condition, kept out
   * of `errors`. A database read that is unsupported is also in `failed`. A store read that is
   * unsupported is not a failure and not a size of 0 (#2212): its scope counts in `read`, and its
   * attempt carries no error, so the gauge does not show the scope as failing.
   */
  unsupported: number;
  /** Sample rows the directory wrote (a reading for a scope reaped meanwhile writes none). */
  recorded: number;
  /** Samples past retention deleted. */
  pruned: number;
}

/**
 * How the request-rollup phase reads (#2501). Every number here is a bound on Analytics Engine
 * queries: one per day read.
 *
 * A day is due once it ended at least `settleMs` ago, lies within `lookbackDays`, has no
 * successful read, and was never tried or last tried at least `retryMs` ago. The oldest due day
 * goes first, since it is the next one Analytics Engine ages out. A read that succeeds replaces
 * the day's rows; one that fails writes nothing of the day, records the error as its attempt, and
 * ends the pass's reads, so a standing failure costs one query a pass, not a batch.
 */
export interface RequestRollupSweepOptions {
  /**
   * One UTC day's request counts per (tenant, vertical, scope), every count an estimate. A throw
   * fails the day: nothing of it is written, and a read that could only answer part of the day
   * (a saturated query) must throw rather than return the part.
   */
  read: (day: string) => Promise<readonly RequestDayCount[]>;
  /** The most days read in one pass. Default `REQUEST_ROLLUP_DAYS_PER_PASS`. `0` pauses reading; the prune still runs. */
  batch?: number;
  /** How many days back a day may be read: 1 to `REQUEST_ROLLUP_MAX_LOOKBACK_DAYS`. Default `REQUEST_ROLLUP_LOOKBACK_DAYS`. */
  lookbackDays?: number;
  /** How long after its end a day may be read, at least 0. Default `REQUEST_ROLLUP_SETTLE_MS`. */
  settleMs?: number;
  /** How long a failed day waits before it is tried again, at least 0. Default `REQUEST_ROLLUP_RETRY_MS`. */
  retryMs?: number;
  /**
   * How long one day's read may take, in ms. Past it the day counts as failed, like any other
   * failed read, and is retried later: a stalled Analytics Engine answer must not hold the pass
   * past its invocation limit. Default `REQUEST_ROLLUP_READ_TIMEOUT_MS`.
   */
  readTimeoutMs?: number;
  /** How many months of day rows are kept; null keeps them all. Default `BILLING_ROLLUP_RETENTION_MONTHS`. */
  retentionMonths?: number | null;
  /** Day rows past retention deleted per pass. Default `REQUEST_ROLLUP_PRUNE_BATCH`. */
  pruneBatch?: number;
  /** The instant the pass judges days against. Default the wall clock. */
  now?: () => string;
}

/**
 * A run of identical failures of a billing phase (#2501): the error, when the run began, and how
 * many attempts it holds. A run reaches the failure digest once, when it begins; this is how a
 * standing failure stays visible after that.
 */
export interface FailingRun {
  error: string;
  since: string;
  failures: number;
}

/** What the request-rollup phase did in one pass (#2501). */
export interface RequestRollupSweepReport {
  /** Days due this pass. */
  due: number;
  /** Due days left for a later pass because the batch was full. */
  deferred: number;
  /** Days read and recorded, and days whose read or record failed. A failure ends the pass's reads, so `failed` is 0 or 1. */
  read: number;
  failed: number;
  /**
   * Failures that repeated the previous attempt's error: a standing failure, in `errors` only on
   * the pass its streak began. Cleared by the next read that succeeds.
   */
  repeated: number;
  /**
   * The run of identical failures that stands at the end of this pass: its error, when the run
   * began, and how many attempts it holds. On a pass that retried the failing day, that attempt is
   * counted in. On a pass that read nothing (the day waits `retryMs`, so most passes do), it is the
   * run as the ledger's newest attempt left it, with no new attempt counted and no new digest entry.
   * Null once a read succeeds, and when no attempt has failed. So a standing failure stays visible
   * on every pass it lasts, after its one digest.
   */
  streak: FailingRun | null;
  /** Days found saturated (`RequestRollupSaturated`): recorded as such, not read again, and not a reason to stop. */
  saturated: number;
  /** Which days those were. */
  saturatedDays: string[];
  /** Rows the read days wrote. */
  recorded: number;
  /** Day rows past retention deleted. */
  pruned: number;
}

/**
 * How the meter-snapshot phase takes a day (#2501). It reads only the directory, in one
 * transaction (`HostAdmin.recordMeterDay`), so opting in with `{}` is enough.
 *
 * A pass takes the snapshot of the UTC day it runs in, unless the day already has one, so the
 * first pass of the day is the one whose reading stands. An attempt that fails writes nothing of
 * the day, records the failure, and the next pass of the same day tries again: there is no outside
 * budget to spare, and the earlier in the day the snapshot is, the closer it is to the day's start.
 * A day no pass managed to take keeps its failed record and no rows; a later day cannot take it.
 */
export interface MeterSnapshotSweepOptions {
  /**
   * How long the snapshot may take, in ms. Past it the attempt counts as failed. It decides what the
   * pass reports, not when the directory finishes: on the hosted directory the failure record waits
   * behind the snapshot's transaction in the same Durable Object, so the pass is held until that
   * ends. A snapshot that commits late still stands, is reported as failed once, and the next pass
   * finds the day taken. Default `METER_SNAPSHOT_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** How many months of snapshot rows are kept; null keeps them all. Default `BILLING_ROLLUP_RETENTION_MONTHS`. */
  retentionMonths?: number | null;
  /** Snapshot rows past retention deleted per pass. Default `METER_DAYS_PRUNE_BATCH`. */
  pruneBatch?: number;
  /** The instant the pass snapshots at. Default the wall clock. */
  now?: () => string;
}

/** What the meter-snapshot phase did in one pass (#2501). */
export interface MeterSnapshotSweepReport {
  /** The UTC day this pass snapshots, or null when the pass's instant was not one. */
  day: string | null;
  /** Whether this pass took the day's snapshot. False on every later pass of the day. */
  taken: boolean;
  /** The tenant rows this pass's snapshot wrote. */
  tenants: number;
  /** Whether this pass's attempt failed (0 or 1), and whether that failure repeated the attempt before it. */
  failed: number;
  repeated: number;
  /**
   * The run of identical failures that stands at the end of this pass: its error, when it began,
   * and how many attempts it holds. Every pass of a day not yet taken makes an attempt, so a
   * standing failure is on the report of every pass it lasts, though it reaches the digest only on
   * the pass its run began. Null once a snapshot is taken, and when no attempt has failed.
   */
  streak: FailingRun | null;
  /** Snapshot rows past retention deleted. */
  pruned: number;
}

/**
 * One scope's orphan-attachment pass as the platform's reach answers it (#2314):
 * - `swept`: the deployment that serves the scope ran the pass, and this is its report;
 * - `refused`: the scope is not one the pass may judge now (a copy, not active, an unsettled copy
 *   in another script, no deployment serves it). A standing condition, counted, never an error;
 * - `unsupported`: the deployment serving the scope was built before the pass existed. Standing
 *   until it is redeployed, counted, never an error.
 * - `unlicensed`: a destructive pass the scope refused because its own storage holds no dry run in
 *   force (#2350): a restore or a carry dropped it, it aged out, or the deployment never recorded
 *   one. The phase runs the dry run in the same visit.
 * A throw is a failure, and lands in `errors`.
 */
export type OrphanAttachmentOutcome =
  | { swept: OrphanSweepReport }
  | { refused: string }
  | { unsupported: string }
  | { unlicensed: string };

/**
 * How the orphan-attachment phase runs (#2314).
 *
 * It takes a window of at most `batch` active primary scopes per pass, starting at `rng()` of the
 * way round the id order and wrapping (the provision reconcile's rule, #1653), so a scope that
 * fails on every pass cannot hold a slot for good and every scope is reached over enough passes.
 *
 * `mode: 'delete'` is not enough on its own to delete a scope's bytes. A scope is swept for real
 * only when the admin log holds a DRY-RUN row for it (`sweepOrphanAttachments`, `dryRun: true`)
 * from within `dryRunWindowMs`, and such a row is written only by a dry run that found orphans.
 * Any other scope gets a dry run instead, which writes that row when it finds anything. So every
 * delete follows a recorded report of what the scope's orphans were, in that window.
 *
 * The scope's own storage holds the same rule (#2350), so it holds whoever asks for a pass: a
 * deployment that has it refuses a destructive pass without a dry-run licence of its own, and
 * deletes only ids that dry run listed. Such a refusal (`unlicensed`) gets a dry run in the same
 * visit, counted as `awaitingDryRun`. The admin-log row stays the operator's record, and the
 * licence for a deployment pushed before the scope held one.
 */
export interface OrphanAttachmentSweepOptions {
  /** `'dry-run'` reports and changes nothing; `'delete'` condemns and deletes, per the rule above. */
  mode: 'dry-run' | 'delete';
  /** One scope's pass, reached wherever the scope is served. */
  sweepScopeFn: (tenantId: TenantId, scopeId: ScopeId, opts: { dryRun: boolean }) => Promise<OrphanAttachmentOutcome>;
  /** The most scopes one pass visits. Default {@link ORPHAN_ATTACHMENT_SWEEP_BATCH}. `0` pauses the phase. */
  batch?: number;
  /** Where the window starts, in [0, 1). `Math.random` unless given, and injectable to test reach. */
  rng?: () => number;
  /** How recent a scope's dry-run row must be for a delete. Default {@link ORPHAN_SWEEP_DRY_RUN_WINDOW_MS}. */
  dryRunWindowMs?: number;
  /** The instant the dry-run window is judged against. Default the wall clock. */
  now?: () => string;
}

/** The orphan-attachment phase's per-pass bound when `batch` is unset (#2314). */
export const ORPHAN_ATTACHMENT_SWEEP_BATCH = 25;

/**
 * How recent a scope's dry-run row must be before a pass deletes its bytes, by default (#2314). The
 * scope's own licence (#2350) is in force for the same window.
 */
export { ORPHAN_SWEEP_DRY_RUN_WINDOW_MS };

/** How many scope ids each standing-condition count of the report carries; the count stays exact. */
const ORPHAN_ATTACHMENT_REPORTED_IDS = 50;

/** What the orphan-attachment phase did in one pass (#2314). */
export interface OrphanAttachmentSweepReport {
  mode: 'dry-run' | 'delete';
  /** Active primary scopes the phase could visit. Always `visited + deferred`. */
  eligible: number;
  /** Of those, the ones in this pass's window. */
  visited: number;
  /** Of those, the ones past this pass's `batch`. */
  deferred: number;
  /** Passes run, by kind: a dry run, and a real one. */
  dryRuns: number;
  deletes: number;
  /**
   * Delete-mode scopes given a dry run because the log held no recent dry-run row for them, or
   * because the scope's own storage held no dry-run licence (#2350).
   */
  awaitingDryRun: number;
  /** Passes whose deployment holds no attachment store for the tenant (`bucket: 'none'`). */
  noStore: { count: number; scopeIds: string[] };
  /** Passes the restore fence held. */
  fenced: number;
  /**
   * Destructive passes that deleted objects but could not take them out of the scope's dry-run
   * licence (#2350). The deletes stand and the admin-log row names them; never an error.
   */
  consumeFailed: number;
  /** Orphans found, and objects deleted, summed over the passes. */
  orphans: number;
  deleted: number;
  /** Scopes the pass may not judge now. Standing, never an error. */
  refused: { count: number; scopeIds: string[] };
  /** Scopes whose deployment predates the pass. Standing, never an error. */
  unsupported: { count: number; scopeIds: string[] };
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
  /**
   * Report scopes the narrowing KNOWS import (their running code declares it). A candidate
   * reported here that answers "imports nothing" disagrees with the registry, and is a failed
   * edge. A candidate not reported (a superset `candidates`, which the contract allows, or a
   * doubtful one) answering "nothing" has simply answered.
   */
  known?(scopeIds: readonly ScopeId[]): void;
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

/** One scope's share of `PlatformSweepReport.platformRequestUnsettleable` (#1637). */
export interface PlatformRequestUnsettleable {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** Exact. */
  count: number;
  /** The stored ids, as text (`null` for SQL NULL); capped by the drain, so `count` may be larger. */
  ids: (string | null)[];
}

/**
 * Platform-intent drain counts, summed across scopes in one pass. A scope the pass drains twice,
 * once more after its schedules enqueued requests (#2431), adds what each drain did, while
 * `pending` and `unsettleable` are its later drain's: they describe the queue the pass leaves. A
 * later drain that reached no deployment, or threw, leaves the earlier one's figures standing,
 * and is counted in `unreachable`, or recorded in `errors`, as a first drain would be.
 */
export interface PlatformRequestDrainTotals {
  /** Active scopes that had at least one intent drained. */
  scopes: number;
  /** Intents seen across all scopes. One a scope's first drain left pending is seen again by its second. */
  drained: number;
  /** Executed successfully. */
  done: number;
  /** Terminally failed (unknown kind, or a handler that gave up). */
  failed: number;
  /** Left pending for a later drain (transient failure). */
  pending: number;
  /**
   * Active scopes the phase stepped over because their migration failed this pass (#1840).
   * Their queues are not in the counts above.
   */
  skipped: number;
  /**
   * Active scopes whose drain reported it could reach no deployment for them (#1840) — the
   * drain fn returned `unreachable: true`. Their queues are not in the counts above either. A
   * scope whose second drain (#2431) reached none counts here too: its figures above are its
   * first drain's, without what its schedules enqueued after it.
   */
  unreachable: number;
  /**
   * Pending intents a drain could neither run nor settle, because the stored id of a row whose
   * identity did not decode is not an id (#1637). They stay pending, so every pass counts them
   * again until the row is repaired. Not in `drained`.
   */
  unsettleable: number;
}

/** What `drainPlatformRequestsFn` reports for one scope. */
export type PlatformRequestDrain = Awaited<ReturnType<NonNullable<PlatformSweepOptions['drainPlatformRequestsFn']>>>;

/**
 * Fold one scope's platform-intent drain into the pass's totals — the one place a drain's answer
 * is read, unreachable included.
 *
 * `earlier` is the same scope's drain from earlier in the pass, when the schedule phase drains it
 * again (#2431). That second drain skipped every intent the first one tried, so its counts are
 * new intents only and add to the first's; only `unsettleable`, which every listing reports
 * whole, gives way to the later answer. A second drain that reached no deployment changes no
 * count — the first drain reached the scope and is already counted — and lands in `errors`,
 * since what the schedules just enqueued is then missing from the totals.
 */
function tallyPlatformDrain(report: PlatformSweepReport, s: Scope, r: PlatformRequestDrain, earlier?: PlatformRequestDrain): void {
  const totals = report.platformRequestTotals;
  if (r.unreachable && earlier) {
    report.errors.push({
      kind: 'platform-request',
      id: s.id,
      error: 'the second drain of this pass reached no deployment; what the schedules enqueued waits for the next pass',
    });
    return;
  }
  if (r.unreachable) totals.unreachable += 1;
  if (r.drained > 0 && !earlier?.drained) totals.scopes += 1;
  totals.drained += r.drained;
  totals.done += r.done;
  totals.failed += r.failed;
  totals.pending += r.pending;
  totals.unsettleable += (r.unsettleable?.count ?? 0) - (earlier?.unsettleable?.count ?? 0);
  if (!earlier) {
    if (r.unsettleable) {
      (report.platformRequestUnsettleable ??= []).push({ tenantId: s.tenantId, scopeId: s.id, ...r.unsettleable });
    }
    return;
  }
  const listed = (report.platformRequestUnsettleable ?? []).filter((u) => u.scopeId !== s.id);
  if (r.unsettleable) listed.push({ tenantId: s.tenantId, scopeId: s.id, ...r.unsettleable });
  if (listed.length > 0) report.platformRequestUnsettleable = listed;
  else delete report.platformRequestUnsettleable;
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
/**
 * The batch options that reach a SQL `LIMIT` unnormalized (#1632), checked before any phase runs
 * — so a misconfigured pass is refused whole, rather than one phase deleting without a bound.
 * `eventDrainBatch` and the cross-vertical budget are not here: their phases normalize an
 * invalid value to the default by design, and say why where they do it.
 */
function assertSweepBatches(options: PlatformSweepOptions): void {
  if (options.telemetryBatch !== undefined) assertRowLimit('telemetryBatch', options.telemetryBatch);
  if (options.accessLogBatch !== undefined) assertRowLimit('accessLogBatch', options.accessLogBatch);
  const gauge = options.storageGauge;
  if (gauge?.pruneBatch !== undefined) assertRowLimit('storageGauge.pruneBatch', gauge.pruneBatch);
  // `0` is a pause, so the sample batch is a non-negative integer rather than a row limit.
  if (gauge?.batch !== undefined && !(Number.isInteger(gauge.batch) && gauge.batch >= 0)) {
    throw substratError('validation_failed', `storageGauge.batch must be a non-negative integer, got ${String(gauge.batch)}`);
  }
  const rollup = options.requestRollup;
  if (rollup?.pruneBatch !== undefined) assertRowLimit('requestRollup.pruneBatch', rollup.pruneBatch);
  if (rollup?.batch !== undefined && !(Number.isInteger(rollup.batch) && rollup.batch >= 0)) {
    throw substratError('validation_failed', `requestRollup.batch must be a non-negative integer, got ${String(rollup.batch)}`);
  }
  if (rollup?.retentionMonths !== undefined) assertBillingRetention('requestRollup.retentionMonths', rollup.retentionMonths);
  // Each of these corrupts the kept history silently rather than failing: a lookback past what
  // Analytics Engine keeps records aged-out days as days without traffic, and a negative settle
  // reads the open day and freezes it. So they are refused here, before anything is read.
  const lookback = rollup?.lookbackDays;
  if (lookback !== undefined && !(Number.isInteger(lookback) && lookback >= 1 && lookback <= REQUEST_ROLLUP_MAX_LOOKBACK_DAYS)) {
    throw substratError(
      'validation_failed',
      `requestRollup.lookbackDays must be a whole number of days from 1 to ${REQUEST_ROLLUP_MAX_LOOKBACK_DAYS}, got ${String(lookback)}`,
    );
  }
  for (const name of ['settleMs', 'retryMs'] as const) {
    const ms = rollup?.[name];
    if (ms !== undefined && !(Number.isFinite(ms) && ms >= 0)) {
      throw substratError('validation_failed', `requestRollup.${name} must be a non-negative number of ms, got ${String(ms)}`);
    }
  }
  if (rollup?.readTimeoutMs !== undefined) assertPositiveMs('requestRollup.readTimeoutMs', rollup.readTimeoutMs);
  const snapshot = options.meterSnapshot;
  if (snapshot?.pruneBatch !== undefined) assertRowLimit('meterSnapshot.pruneBatch', snapshot.pruneBatch);
  if (snapshot?.retentionMonths !== undefined) assertBillingRetention('meterSnapshot.retentionMonths', snapshot.retentionMonths);
  if (snapshot?.timeoutMs !== undefined) assertPositiveMs('meterSnapshot.timeoutMs', snapshot.timeoutMs);
  const orphans = options.orphanAttachments;
  if (orphans?.batch !== undefined && !(Number.isInteger(orphans.batch) && orphans.batch >= 0)) {
    throw substratError('validation_failed', `orphanAttachments.batch must be a non-negative integer, got ${String(orphans.batch)}`);
  }
  if (orphans && orphans.mode !== 'dry-run' && orphans.mode !== 'delete') {
    throw substratError('validation_failed', `orphanAttachments.mode must be 'dry-run' or 'delete', got ${String(orphans.mode)}`);
  }
}

/** A billing retention option, refused unless `billingRollupHorizon` takes it. */
function assertBillingRetention(name: string, months: number | null): void {
  try {
    billingRollupHorizon(0, months);
  } catch (err) {
    throw substratError('validation_failed', `${name}: ${message(err)}`);
  }
}

/** A deadline option, refused unless it is a positive, finite number of ms. */
function assertPositiveMs(name: string, ms: number): void {
  if (!(Number.isFinite(ms) && ms > 0)) {
    throw substratError('validation_failed', `${name} must be a positive number of ms, got ${String(ms)}`);
  }
}

export async function runPlatformSweep(
  host: ScopeHost,
  options: PlatformSweepOptions,
): Promise<PlatformSweepReport> {
  assertSweepBatches(options);
  const concurrency = options.concurrency ?? 8;
  const report: PlatformSweepReport = {
    scopesDrained: 0,
    drainTotals: { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 },
    connectionsSwept: 0,
    connectionLandings: options.connectionLandings ? { granted: 0, bound: 0, failed: 0 } : null,
    connectionsSkipped: 0,
    snapshotsReaped: 0,
    archivedScopesReaped: 0,
    tenantsReaped: 0,
    platformRequestTotals: { scopes: 0, drained: 0, done: 0, failed: 0, pending: 0, skipped: 0, unreachable: 0, unsettleable: 0 },
    provisionReconcile: null,
    migrations: null,
    schedules: null,
    accessLog: null,
    eventDrain: null,
    crossVertical: null,
    telemetry: null,
    findings: null,
    storage: null,
    orphanAttachments: null,
    requestRollup: null,
    meterSnapshot: null,
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

  // #1524: the scopes this pass woke, which are the only ones the storage-gauge phase may
  // read. On the hosted plane the executor drain runs on the control plane's own host, whose
  // namespace is a placeholder, so the platform-intent drain is what reaches the vertical's DO
  // and is the phase that counts whenever it is configured.
  const reachedThisPass = new Map<string, Scope>();
  const viaPlatformDrain = Boolean(options.drainPlatformRequestsFn);

  if (options.drainRetries !== false) {
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      if (failedThisPass.has(s.id)) return; // fails closed — draining is only noise
      try {
        const r = await host.drainDue(s.tenantId, s.id);
        if (!viaPlatformDrain) reachedThisPass.set(s.id, s);
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
  // #2431: each scope this phase reached, with what its drain said, for the schedule phase's
  // second drain of a scope whose schedules enqueued requests.
  const drainedThisPass = new Map<string, PlatformRequestDrain>();
  const drain = options.drainPlatformRequestsFn;
  if (drain) {
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      if (failedThisPass.has(s.id)) {
        report.platformRequestTotals.skipped += 1;
        return;
      }
      try {
        const r = await drain(s.tenantId, s.id, {});
        if (!r.unreachable) {
          reachedThisPass.set(s.id, s);
          drainedThisPass.set(s.id, r);
        }
        tallyPlatformDrain(report, s, r);
      } catch (err) {
        report.errors.push({ kind: 'platform-request', id: s.id, error: message(err) });
      }
    });
  }

  // -- the stored storage gauge (#1524) ----------------------------------------
  // Straight after the drains, while the DOs they woke are still awake. Only reached scopes
  // are read (see `StorageGaugeSweepOptions`), stalest first, at most `batch` of them.
  if (
    options.storageGauge &&
    typeof host.admin.recordScopeStorage === 'function' &&
    typeof host.admin.listScopeStorageAttempts === 'function'
  ) {
    report.storage = await sweepStorageGauge(host.admin, options, options.storageGauge, reachedThisPass, report);
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
    const behind: { id: ScopeId; tenantId: TenantId; target: string; receiptBehind: boolean }[] = [];
    for (const s of scopes) {
      const running = runningVersionOf(s, s.vertical ? serving.get(s.vertical) : null);
      // No running version ⇒ nothing to compare, and nothing a reconcile could target.
      if (!running) continue;
      // A null receipt is "unknown", NOT "up to date": a scope provisioned before the
      // platform recorded this has no evidence either way, and guessing the optimistic
      // answer leaves exactly the broken installs this phase exists to heal. It costs
      // one reconcile per pre-existing scope, once, and then the receipt is there.
      // #2185: and a receipt whose reconcile did not finish the version's retirements is behind
      // too, so a retirement left open is run again, as the kernel's reconcile expects. A row from
      // before the column reads null here, so every existing install is reconciled once more.
      // #2184: likewise one that did not report which binding shapes links have bound in it.
      if (s.provisionedVersionId === running && s.retirementsFinishedVersionId === running && s.boundShapes?.versionId === running) continue;
      behind.push({ id: s.id, tenantId: s.tenantId, target: running, receiptBehind: s.provisionedVersionId !== running });
    }
    provisionReconcile.behind = behind.length;
    const batch = options.provisionReconcileBatch ?? PROVISION_RECONCILE_BATCH;
    // #2185: two classes share the window, and neither may starve the other. Installs whose receipt
    // is behind what they run take most of it; installs behind on their retirements alone are owed a
    // quarter (`retirementShareOf`). Either class can hold installs that never leave it: a reconcile
    // that answers 'unsupported' or keeps throwing writes no receipt, and a vertical built on packages
    // that cannot report never finishes a retirement. A fixed share bounds what those cost the other
    // class, and a slot one class does not need goes to the other. Within a class the window starts
    // at random, so no install in it is skipped for good either.
    const rng = options.provisionReconcileRng ?? Math.random;
    const receiptBehind = behind.filter((b) => b.receiptBehind);
    const retirementsOnly = behind.filter((b) => !b.receiptBehind);
    const owed = Math.min(retirementsOnly.length, retirementShareOf(batch, rng));
    const first = reconcileWindow(receiptBehind, batch - owed, rng);
    const window = [...first, ...reconcileWindow(retirementsOnly, batch - first.length, rng)];
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
        await host.admin.markScopeProvisioned(options.actor, s.tenantId, s.id, s.target, typeof outcome === 'object' ? outcome : undefined);
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
      // Primaries only (`isPrimaryScope`, #2005) — a fork, a snapshot or a preview of either
      // kind is a copy or a throwaway; firing its schedules would run real recurring side
      // effects off it. Lineage alone (`forkedFrom === null`) let a clean-room preview through.
      const scopes = (await host.admin.listScopes(options.actor, { status: 'active' })).filter(isPrimaryScope);
      await mapBounded(scopes, concurrency, async (s) => {
        if (failedThisPass.has(s.id)) return;
        let touched = false;
        let platformRequests = 0;
        for (const reg of registrations) {
          try {
            const r = await host.runDueSchedules(reg.moduleId, s.tenantId, s.id);
            if (r.fired > 0 || r.failed > 0) touched = true;
            schedules.fired += r.fired;
            schedules.skipped += r.skipped;
            schedules.failed += r.failed;
            platformRequests += r.platformRequests ?? 0;
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
        if (platformRequests === 0) return;
        schedules.platformRequests = (schedules.platformRequests ?? 0) + platformRequests;
        // #2431: the schedules enqueued platform requests, so drain the scope again now rather
        // than leave them a sweep interval. After the schedules, not instead of the drain above:
        // that one gives them the scope's whole headroom under the pending cap. Once, firing
        // nothing, so it cannot loop, and only on a scope the drain phase reached; any other waits
        // for the next pass. It skips every intent the first drain tried, so no intent spends two
        // attempts toward its ceiling in one pass and none is counted twice. What it reports, an
        // unreachable answer included, is read by `tallyPlatformDrain`; a throw lands in `errors`.
        const earlier = drainedThisPass.get(s.id);
        if (!earlier) return;
        try {
          const again = await drain!(s.tenantId, s.id, { skip: earlier.attempted });
          tallyPlatformDrain(report, s, again, earlier);
        } catch (err) {
          report.errors.push({ kind: 'platform-request', id: s.id, error: message(err) });
        }
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
      // The same primaries the schedule phase fires on (#2005).
      const scopes = (await host.admin.listScopes(options.actor, { status: 'active' })).filter(isPrimaryScope);
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

  // -- orphan attachment bytes (#2314) ------------------------------------------
  // After the migration phase and skipping what failed there, like every phase that reaches a
  // vertical. Opt-in, and its own window per pass: it lists a bucket prefix and wakes a scope.
  if (options.orphanAttachments) {
    const scopes = (await host.admin.listScopes(options.actor, { status: 'active' })).filter(
      (s) => isPrimaryScope(s) && !failedThisPass.has(s.id),
    );
    report.orphanAttachments = await sweepOrphanAttachmentWindow(host, options, options.orphanAttachments, scopes, report);
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
  const landings = options.connectionLandings ? new LandingPass(host, options.actor, options.connectionLandings, concurrency) : null;
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
    // #2316: what the running versions declare, granted and bound before the poll reads bindings.
    // Never sinks the sweep: its failures join the poll's on the connection's row.
    const landed = landings ? await landings.apply(c).catch((err) => ({ granted: [], bound: [], failed: [{ scopeId: '*', error: message(err) }] })) : null;
    if (landed && report.connectionLandings) {
      report.connectionLandings.granted += landed.granted.length;
      report.connectionLandings.bound += landed.bound.length;
      report.connectionLandings.failed += landed.failed.length;
    }
    try {
      // #2498: a sized stream body the connector sends reaches the injected fetch converted.
      const result = await sweeper(host, c.id, { fetch: fetchLikeOf(options.fetch) });
      const answer = options.connectionLandings?.binders[c.provider] ? connectorSweepAnswerOf(result) : null;
      report.connectionsSwept += 1;
      // #2316: a resolved sweep is not a landed one. A scope the connector could not land in, or a
      // landing the platform could not seat, fails the row and names the scope; a poll that found
      // nothing to poll is `skipped`, which a console reads as "nothing polls this connection".
      const failed = [...(landed?.failed ?? []), ...(answer?.failed ?? [])];
      if (failed.length > 0) {
        const error = failed.map((f) => `scope ${f.scopeId}: ${f.error}`).join('; ');
        for (const f of failed) report.errors.push({ kind: 'sweep', id: c.id, error: `scope ${f.scopeId}: ${f.error}` });
        record('failed', { error, elapsedMs: Date.now() - started });
      } else if (answer && answer.found === 0) {
        record('skipped', { error: NO_BINDING, elapsedMs: Date.now() - started });
      } else {
        record('ok', { elapsedMs: Date.now() - started });
      }
    } catch (err) {
      // The landing step's failures, if any, belong on the same row as the poll's throw.
      const landing = (landed?.failed ?? []).map((f) => `scope ${f.scopeId}: ${f.error}`);
      for (const l of landing) report.errors.push({ kind: 'sweep', id: c.id, error: l });
      report.errors.push({ kind: 'sweep', id: c.id, error: message(err) });
      record('failed', { error: [...landing, message(err)].join('; '), elapsedMs: Date.now() - started });
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

  // -- telemetry retention (#1632) -------------------------------------------
  // Ops failures, issues and sweep runs prune on write, which bounds them only while
  // something is written. This bounds them in time — a batch per table per pass, so a
  // backlog drains over ticks. Feature-detected, like every phase.
  if (typeof host.admin.pruneTelemetry === 'function') {
    try {
      report.telemetry = await host.admin.pruneTelemetry(
        options.actor,
        options.telemetryBatch ?? TELEMETRY_PRUNE_BATCH,
      );
    } catch (err) {
      report.errors.push({ kind: 'telemetry', id: 'telemetry', error: message(err) });
    }
  }

  // -- findings retention (#1748) --------------------------------------------
  // Its own phase, not telemetry's: it resolves quiet open findings as stale and audits each,
  // which is a lifecycle change rather than a prune. Same batch, feature-detected.
  if (typeof host.admin.pruneFindings === 'function') {
    try {
      report.findings = await host.admin.pruneFindings(options.actor, options.telemetryBatch ?? TELEMETRY_PRUNE_BATCH);
    } catch (err) {
      report.errors.push({ kind: 'findings', id: 'findings', error: message(err) });
    }
  }

  // -- the daily meter snapshot (#2501) -----------------------------------------
  // After all the scheduled work, so the day's reading is the directory as this pass leaves it,
  // reaps included, and just before the request rollup: the snapshot is one directory transaction,
  // and a slow Analytics Engine answer must not push its reading later in the day. Its one read of
  // the day records is shipped by the access-log drain below, in the same pass.
  if (
    options.meterSnapshot &&
    typeof host.admin.recordMeterDay === 'function' &&
    typeof host.admin.listMeterDayTakes === 'function'
  ) {
    report.meterSnapshot = await sweepMeterSnapshot(host.admin, options.actor, options.meterSnapshot, report);
  }

  // -- the daily request rollup (#2501) ----------------------------------------
  // After all the scheduled work, deliberately: it waits on Analytics Engine, an outside service,
  // and nothing in the pass depends on it, so a slow answer must not hold back the work that has
  // to happen every pass. Each read is bounded (`RequestRollupSweepOptions.readTimeoutMs`), so the
  // most it can delay is the access-log drain below, which then ships this phase's own reads too.
  if (
    options.requestRollup &&
    typeof host.admin.recordRequestDay === 'function' &&
    typeof host.admin.listRequestRollupDays === 'function'
  ) {
    report.requestRollup = await sweepRequestRollup(host.admin, options.actor, options.requestRollup, report);
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
    const resolved = named ? resolveVerticalInstanceFrom(scopes, exactIn(named.tenantId), named.vertical) : null;
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
  // Scopes the narrowing KNOWS import: their "imports nothing" contradicts the registry.
  const knownImporters = new Set<string>();
  let candidates: readonly Scope[];
  try {
    candidates = await candidatesOf(scopes, {
      ...(from !== null ? { from } : {}),
      known: (scopeIds) => {
        for (const id of scopeIds) knownImporters.add(id);
      },
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
    // A scope the narrowing KNOWS imports (`hint.known`) whose deployment answers that it imports
    // NOTHING: the two disagree, and the scope is not running the code the registry describes (a
    // push that did not reach it, or a reconcile still owed). Said, not skipped: skipping would
    // make every edge into this scope disappear without a trace. Any other candidate (a superset
    // narrowing, which the contract allows, or a doubtful scope) answering "nothing" has answered.
    if (state.consumes.length === 0 && knownImporters.has(consumer.id)) {
      consumerFailed(
        "the version registry says this scope's code imports events, but its deployment answers that it " +
          'imports nothing — it is not running the version the registry names; redeploy or reconcile it',
      );
      return;
    }
    const bySource = wantsBySource(state.consumes, (f) => from === null || f === from);
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
    const running = await runningImportsOf(input.admin, input.actor, scopes, input.readImports, input.concurrency ?? 8);
    const doubted = new Map<string, { reason: string; scopeIds: ScopeId[] }>();
    const known: ScopeId[] = [];
    const out: Scope[] = [];
    for (const { scope, key, fact: read } of running) {
      const fact: ManifestImports = read ?? {
        kind: 'unreadable',
        reason: 'the scope names no version the registry could be asked about',
      };
      if (fact.kind === 'none') continue;
      if (fact.kind === 'imports') {
        const from = hint?.from;
        if (from !== undefined ? fact.rows.some((r) => r.from === from) : fact.rows.length > 0) {
          out.push(scope);
          known.push(scope.id);
        }
        continue;
      }
      out.push(scope);
      const d = doubted.get(key) ?? { reason: fact.reason, scopeIds: [] };
      d.scopeIds.push(scope.id);
      doubted.set(key, d);
    }
    for (const [key, d] of doubted) hint?.doubt?.(key, d.reason, d.scopeIds);
    if (known.length > 0) hint?.known?.(known);
    return out;
  };
}

/** A tenant read with names matched exactly — the edges' rule (see `edgeEnds`). */
const exactIn = (id: TenantId): PeerTenant => ({ id, slug: null });

/**
 * The two ends of the edge from `from` into `consumer`, by #1706's one rule
 * (`resolveVerticalInstanceFrom`: same tenant, active, primary; two are `ambiguous`, refused rather
 * than guessed). The producer is who is read. The consumer is who the producer's grant names, and a
 * grant naming a slug cannot tell two installs of it apart. Shared by the sweep and the health read,
 * so the view cannot disagree with the next pass about where an edge points, or why it points
 * nowhere.
 *
 * Names match EXACTLY here (`exactIn`), unlike a peer call's target (#2252), and deliberately:
 * the tenant-pinned spelling is not read as the bare one for an edge's producer or consumer.
 * Whether it should be is its own decision, since it moves which edges deliver.
 */
function edgeEnds(
  scopes: readonly Scope[],
  consumer: Scope,
  from: string,
): { source: { vertical: string; scopeId: ScopeId } } | { reason: string } {
  const vertical = consumer.vertical!;
  if (from === vertical) return { reason: `'${vertical}' imports from itself — an import names ANOTHER vertical` };
  const self = resolveVerticalInstanceFrom(scopes, exactIn(consumer.tenantId), vertical);
  if (self.outcome !== 'resolved' || self.instance.scopeId !== consumer.id) {
    return {
      reason: `this tenant has more than one primary instance of '${vertical}', so the producer cannot tell which one its grant names`,
    };
  }
  const producer = resolveVerticalInstanceFrom(scopes, exactIn(consumer.tenantId), from);
  if (producer.outcome !== 'resolved') {
    return {
      reason:
        producer.outcome === 'not-installed'
          ? `'${from}' is not installed in this tenant`
          : `this tenant has more than one primary instance of '${from}' — delivery waits until one is chosen`,
    };
  }
  return { source: { vertical: from, scopeId: producer.instance.scopeId } };
}

/** A consumer's declared imports, grouped by the vertical they come from. */
function wantsBySource(consumes: ImportState['consumes'], only: (from: string) => boolean = () => true): Map<string, WantedEvent[]> {
  const bySource = new Map<string, WantedEvent[]>();
  for (const c of consumes) {
    if (!only(c.from)) continue;
    const list = bySource.get(c.from) ?? [];
    list.push({ type: c.type, schemaVersion: c.schemaVersion });
    bySource.set(c.from, list);
  }
  return bySource;
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
  const ends = edgeEnds(scopes, consumer, from);
  if ('reason' in ends) return edge({ state: 'unresolved', reason: ends.reason });
  const { source } = ends;
  const at = { producer: source };
  const after = state.cursors.find((c) => c.source === source.scopeId)?.cursor ?? null;
  try {
    const batch = await reach.readExports(consumer.tenantId, source.scopeId, {
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

// -- edge health (#1705 PR 3) ---------------------------------------------------------------


/** Where a consumer's door stands for each peer, as `admin.peerGrantsStatus` answers it. */
type DoorRead = (
  tenantId: TenantId,
  scopeId: ScopeId,
) => Promise<readonly { vertical: string; calls: string; switchedOff?: { reason: string } | null }[]>;

/**
 * Where every cross-vertical edge of one tenant stands, read LIVE (#1705 PR 3): the view behind
 * the console's and the dashboard's edge health.
 *
 * It is the sweep's own walk with the delivery taken out. It uses the same reach, the same
 * narrowing (`candidates`, which keeps it off scopes that import nothing), and the same resolution
 * of both ends (`edgeEnds`). So it cannot disagree with the next pass about which edges exist or
 * where they point. Per edge it makes one probe read of the producer after the watermark,
 * `limit: 1`, which tells behind from caught up and dates the oldest waiting event. That read is the
 * producer's own `readExportedEvents`, gated and audited as on a pass, and nothing it returns is
 * delivered or kept. The consumer's door is read from its peer switch (`peerGrantsStatus`), because
 * a consumer refusing the producer is visible only at delivery otherwise. The tenant's recent
 * `vertical-events` sweep-run rows add the last pass that delivered and the last that did not.
 *
 * `focus` narrows it to one scope's edges, the ones into it and out of it: a per-app view asks
 * nothing about the rest of the tenant. Out of it means consumers the narrowing names for the
 * focus's vertical (`hint.from`), so the registry, not a scope, decides who is asked.
 *
 * Cost per view: one directory read, the narrowing, then per importing scope one `importState`
 * and one door read, per edge one probe read and one or two sweep-run reads. It is bounded by the
 * tenant, never the fleet.
 *
 * Who the reads are audited as: the directory, door and history reads as `actor`, the viewer the
 * caller names. The reach's reads (`importState`, the probe) are audited as whatever actor the
 * reach was built with. On the control plane that is the sweep's own actor, since it is the
 * sweep's reach, so those rows read as the platform's, not the viewer's.
 *
 * `unavailable` is its own state: a side that could not be asked gets no health, and no
 * surface may show it as healthy.
 */
export async function crossVerticalHealth(
  host: ScopeHost,
  options: {
    actor: PlatformActorId;
    tenantId: TenantId;
    crossVertical?: CrossVerticalOptions;
    /** Only this scope's edges: into it, and out of it. */
    focus?: ScopeId;
    /**
     * Where the consumer's door stands for each peer. Default: `admin.peerGrantsStatus`, which on
     * the shared control plane reaches the consumer's deployment through its peer-switch
     * delegation and adds who switched a peer off, and why. A host that serves the scope itself
     * without that delegation may pass its own far end (`peerGrantsStatusLocal`) instead.
     */
    door?: DoorRead;
    /** Epoch ms. Injectable so a test pins the lag. */
    now?: () => number;
    concurrency?: number;
  },
): Promise<EdgeHealthReport> {
  const { actor, tenantId } = options;
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? 8;
  const report: EdgeHealthReport = {
    tenantId,
    checkedAt: new Date(now()).toISOString() as EdgeHealthReport['checkedAt'],
    edges: [],
    unavailable: null,
    history: { available: true, reason: null },
  };
  const cv = options.crossVertical ?? {};
  // No reach, on a host whose apps live in their own deployments (the shared control plane without
  // DISPATCH): this host's own verbs cannot see a single hosted scope, and its registered modules
  // import nothing, so the default would report "no edges". That is an answer it cannot give.
  if (!cv.reach && host.servesScopesElsewhere?.()) {
    report.unavailable =
      "edge health cannot reach the deployments that serve this tenant's apps: no cross-vertical reach is " +
      'configured on this control plane (DISPATCH / PLATFORM_SECRET)';
    return report;
  }
  const reach: CrossVerticalReach = cv.reach ?? {
    importState: (t, s) => host.admin.importState(actor, t, s),
    readExports: (t, s, input) => host.admin.readExportedEvents(actor, t, s, input),
    deliver: () => Promise.reject(new Error('edge health never delivers')),
  };
  const candidatesOf: NonNullable<CrossVerticalReach['candidates']> =
    reach.candidates?.bind(reach) ??
    ((scopes) => ((host.registeredImports?.() ?? []).length > 0 ? scopes : []));
  const doorOf: DoorRead =
    options.door ?? ((t, s) => host.admin.peerGrantsStatus(actor, { tenantId: t, scopeId: s }));
  const knownImporters = new Set<string>();
  const known = (ids: readonly ScopeId[]) => {
    for (const id of ids) knownImporters.add(id);
  };

  const listed = await (async () => {
      const scopes = (await host.admin.listScopes(actor, { status: 'active', tenantId })).filter(
        (s): s is Scope & { vertical: string } => isPrimaryScope(s) && s.vertical !== null,
      );
      if (options.focus === undefined) return { scopes, candidates: await candidatesOf(scopes, { known }) };
      const focus = scopes.find((s) => s.id === options.focus);
      if (!focus) return { scopes, candidates: [] as readonly Scope[] };
      const [into, outOf] = await Promise.all([
        candidatesOf([focus], { known }),
        candidatesOf(scopes, { from: focus.vertical, known }),
      ]);
      return { scopes, focus, candidates: [...into, ...outOf.filter((c) => c.id !== focus.id)] };
    })().then(
      (v) => ({ ok: true as const, ...v }),
      (err: unknown) => ({ ok: false as const, error: message(err) }),
    );
  if (!listed.ok) {
    report.unavailable = `could not list this tenant's apps that import events: ${listed.error}`;
    return report;
  }
  const { scopes, candidates } = listed;
  const focusScope = 'focus' in listed ? listed.focus : undefined;
  const focusVertical = focusScope?.vertical;

  // Which sweep-run unit each edge's history is filed under: `<consumer>:<producer vertical>`,
  // or `<consumer>:*` for a consumer that could not be asked (whatever the view tags it with).
  const unitOf = new Map<EdgeHealth, string>();

  await mapBounded(candidates, concurrency, async (consumer) => {
    const vertical = consumer.vertical ?? '';
    const edge = (from: string, rest: Partial<EdgeHealth> & Pick<EdgeHealth, 'state'>): EdgeHealth => ({
      tenantId,
      consumer: { scopeId: consumer.id, vertical },
      producer: { vertical: from, scopeId: null },
      reason: null,
      watermark: null,
      oldestPending: null,
      lagMs: null,
      unexported: [],
      lastDelivered: null,
      lastProblem: null,
      ...rest,
    });
    const filed = (e: EdgeHealth, unitFrom: string): EdgeHealth => {
      unitOf.set(e, `${consumer.id}:${unitFrom}`);
      return e;
    };
    // Into the focus, every source. Into anyone else, only the focus's own vertical.
    const wanted = (from: string) => focusVertical === undefined || consumer.id === options.focus || from === focusVertical;
    // The consumer's imports and its door, together: the door read is wasted only on a consumer
    // that turns out to import nothing, which the narrowing has already made rare.
    const [stateRead, doorRead] = await Promise.all([
      reach.importState(tenantId, consumer.id).then(
        (state) => ({ ok: true as const, state }),
        (err: unknown) => ({ ok: false as const, error: message(err) }),
      ),
      doorOf(tenantId, consumer.id).then(
        (entries) => ({ ok: true as const, entries }),
        (err: unknown) => ({ ok: false as const, error: message(err) }),
      ),
    ]);
    // A consumer that could not be asked names no producer ('*'). Seen from a focused PRODUCER,
    // though, it is one of that producer's consumers (the narrowing named it for the focus's
    // vertical), so it is tagged with the focus: a view of the producer must show the failure
    // rather than filter out an edge whose other end is unknown.
    const unasked = (reason: string): EdgeHealth =>
      filed(
        focusScope && consumer.id !== focusScope.id
          ? edge(focusScope.vertical, { state: 'unavailable', reason, producer: { vertical: focusScope.vertical, scopeId: focusScope.id } })
          : edge('*', { state: 'unavailable', reason }),
        '*',
      );
    if (!stateRead.ok) {
      report.edges.push(unasked(`could not ask this app what it imports: ${stateRead.error}`));
      return;
    }
    const state = stateRead.state;
    if (state.consumes.length === 0) {
      if (knownImporters.has(consumer.id)) {
        report.edges.push(
          unasked(
            "the version registry says this app's code imports events, but its deployment answers that it " +
              'imports nothing — it is not running the version the registry names; redeploy or reconcile it',
          ),
        );
      }
      return;
    }
    // Unreadable is not "open": the edge keeps its probe's state, and the reason says so.
    const door = doorRead.ok
      ? new Map(doorRead.entries.map((e) => [e.vertical, { calls: e.calls, reason: e.switchedOff?.reason ?? null }]))
      : null;
    const sources = [...wantsBySource(state.consumes, wanted)];
    await mapBounded(sources, concurrency, async ([from, wants]) => {
      report.edges.push(filed(await edgeHealthOf(from, wants), from));
    });

    async function edgeHealthOf(from: string, wants: WantedEvent[]): Promise<EdgeHealth> {
      const ends = edgeEnds(scopes, consumer, from);
      if ('reason' in ends) return edge(from, { state: 'unresolved', reason: ends.reason });
      const { source } = ends;
      const cursor = state.cursors.find((c) => c.source === source.scopeId) ?? null;
      const at = {
        producer: source,
        watermark: cursor?.cursor ? { cursor: cursor.cursor, updatedAt: cursor.updatedAt } : null,
      };
      let probe: ExportedBatch;
      try {
        probe = await reach.readExports(tenantId, source.scopeId, {
          consumer: vertical as ExportReadInput['consumer'],
          after: cursor?.cursor ?? null,
          wants,
          limit: 1,
        });
      } catch (err) {
        return edge(from, { ...at, state: 'unavailable', reason: `could not ask '${from}' what is waiting: ${message(err)}` });
      }
      const unexported = probe.unexported;
      if (probe.paused) {
        return edge(from, {
          ...at,
          unexported,
          state: 'paused',
          reason: `'${from}' does not grant vertical:${vertical} ${probe.paused.missing.join(', ')} — nothing moves; the backlog waits in its outbox`,
        });
      }
      const first = [...probe.events, ...probe.withheld].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      const oldestPending = first ? { id: first.id, occurredAt: first.occurredAt } : null;
      const occurred = first ? Date.parse(first.occurredAt) : NaN;
      const lagMs = first && Number.isFinite(occurred) ? Math.max(0, Math.floor(now() - occurred)) : null;
      const pending = { ...at, unexported, oldestPending, lagMs };
      const gate = door?.get(from);
      if (gate && gate.calls !== 'on') {
        return edge(from, {
          ...pending,
          state: 'paused',
          reason:
            gate.calls === 'off'
              ? `this app has '${from}' switched off${gate.reason ? ` (${gate.reason})` : ''} — nothing is delivered; the backlog waits in the producer's outbox`
              : `this app holds no grant for '${from}' — its door refuses the delivery; the backlog waits in the producer's outbox`,
        });
      }
      // Caught up means nothing is waiting, which an unread door cannot change, so its reason is
      // null as the contract says. Behind with an unread door says so: whether the next pass
      // delivers depends on it.
      if (!first) return edge(from, { ...pending, state: 'caught-up', reason: null });
      const doorNote = doorRead.ok ? '' : ` (whether this app admits '${from}' could not be read: ${doorRead.error})`;
      return edge(from, {
        ...pending,
        state: 'behind',
        reason: `events are waiting past the watermark; the next pass takes them${doorNote}`,
      });
    }
  });
  // The history, read per edge: the last pass that delivered, and the last that did not when it is
  // newer. Per edge rather than one window over the tenant, so a noisy edge's rows cannot push a
  // quiet edge's last delivery out of the read. One read when the newest row is a delivery, two
  // otherwise. A failed read costs the history, never the live state.
  await mapBounded(report.edges, concurrency, async (e) => {
    const unit = unitOf.get(e);
    if (unit === undefined) return;
    try {
      const runs = (filter: { outcome?: 'ok' }) =>
        host.admin.listSweepRuns(actor, { kind: 'vertical-events', tenantId, unit, limit: 1, ...filter });
      const [latest] = await runs({});
      if (!latest) return;
      if (latest.outcome === 'ok') {
        e.lastDelivered = { at: latest.at };
        return;
      }
      const [ok] = await runs({ outcome: 'ok' });
      e.lastDelivered = ok ? { at: ok.at } : null;
      e.lastProblem = { at: latest.at, outcome: latest.outcome as 'failed' | 'skipped', error: latest.error ?? null };
    } catch (err) {
      report.history = { available: false, reason: `the sweep history could not be read: ${message(err)}` };
    }
  });
  report.edges.sort(
    (a, b) =>
      a.consumer.vertical.localeCompare(b.consumer.vertical) ||
      a.consumer.scopeId.localeCompare(b.consumer.scopeId) ||
      a.producer.vertical.localeCompare(b.producer.vertical),
  );
  return report;
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
  // At start, not on the first tick: a sweeper configured with a bad batch would otherwise
  // report the same refusal every interval and never run a pass.
  assertSweepBatches(options);
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

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * One pass of the storage-gauge phase (#1524): try the due share of the active scopes this
 * pass already reached and of the non-serving scopes that hold a store, record every attempt
 * in one directory call, then prune past retention. A failed read is an error entry; its
 * scope keeps its last sample and waits a day like any other.
 */

async function sweepStorageGauge(
  admin: HostAdmin,
  options: PlatformSweepOptions,
  gauge: StorageGaugeSweepOptions,
  reachedThisPass: ReadonlyMap<string, Scope>,
  report: PlatformSweepReport,
): Promise<StorageGaugeSweepReport> {
  const out: StorageGaugeSweepReport = {
    reached: reachedThisPass.size,
    resting: 0,
    due: 0,
    deferred: 0,
    read: 0,
    failed: 0,
    skipped: 0,
    unsupported: 0,
    recorded: 0,
    pruned: 0,
  };
  const batch = gauge.batch ?? STORAGE_SAMPLE_BATCH;
  const maxAgeMs = gauge.maxAgeMs ?? STORAGE_SAMPLE_MAX_AGE_MS;
  const now = gauge.now ?? (() => new Date().toISOString());
  try {
    if (batch > 0) {
      // Not one archived before it ever held data (`holdsStore`): reading it would create the
      // spine it never had, and bill it.
      const resting = (
        await admin.listScopes(options.actor, { status: STORED_SCOPE_STATUSES.filter((s) => s !== 'active') })
      ).filter(holdsStore);
      out.resting = resting.length;
      const candidates = [...reachedThisPass.values(), ...resting.filter((s) => !reachedThisPass.has(s.id))];
      const tried = new Map(
        (await admin.listScopeStorageAttempts!(options.actor)).map((a) => [a.scopeId as string, a.attemptedAt]),
      );
      const staleBefore = new Date(Date.parse(now()) - maxAgeMs).toISOString();
      // Never-tried scopes first (by id), then the longest since their last attempt.
      const due = candidates
        .filter((s) => {
          const at = tried.get(s.id);
          return at === undefined || at <= staleBefore;
        })
        .sort((a, b) => cmp(tried.get(a.id) ?? '', tried.get(b.id) ?? '') || cmp(a.id, b.id));
      const take = due.slice(0, batch);
      out.due = due.length;
      out.deferred = due.length - take.length;
      const attempts: ScopeStorageReadingInput[] = [];
      await mapBounded(take, options.concurrency ?? 8, async (s) => {
        const attempt = { tenantId: s.tenantId, scopeId: s.id, readAt: now() };
        try {
          const bytes = await gauge.read(s);
          if (bytes === null) {
            // Declined, not failed — but still an attempt, so it waits a day like any other
            // rather than taking a slot ahead of every readable scope on every pass.
            out.skipped += 1;
            attempts.push({ ...attempt, bytes: null });
            return;
          }
          if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`not a size: ${String(bytes)}`);
          // The store read is its own attempt. A failure here must not throw away the
          // database size just read, and must not replace the day's store rows.
          let stores: { binding: string; bytes: number }[] | null | undefined;
          if (gauge.readStores) {
            try {
              stores = await withinDeadline(
                gauge.readStores(s),
                gauge.storeReadTimeoutMs ?? STORE_READ_TIMEOUT_MS,
                `scope store read of ${s.id}`,
              );
            } catch (err) {
              if (isUnsupported(err)) {
                // Not a failure, and not a size: the database sample stands, the store rows stay.
                out.read += 1;
                out.unsupported += 1;
                attempts.push({ ...attempt, bytes });
                return;
              }
              out.failed += 1;
              attempts.push({ ...attempt, bytes, error: message(err) });
              report.errors.push({ kind: 'storage', id: s.id, error: message(err) });
              return;
            }
          }
          if (stores === null) {
            attempts.push({ ...attempt, bytes });
          } else {
            attempts.push({ ...attempt, bytes, ...(stores ? { stores } : {}) });
          }
          out.read += 1;
        } catch (err) {
          out.failed += 1;
          attempts.push({ ...attempt, bytes: null, error: message(err) });
          if (isUnsupported(err)) out.unsupported += 1;
          else report.errors.push({ kind: 'storage', id: s.id, error: message(err) });
        }
      });
      if (attempts.length > 0) out.recorded = (await admin.recordScopeStorage!(options.actor, attempts)).recorded;
    }
    if (typeof admin.pruneScopeStorage === 'function') {
      out.pruned = await admin.pruneScopeStorage(options.actor, gauge.pruneBatch ?? STORAGE_GAUGE_PRUNE_BATCH);
    }
  } catch (err) {
    // A directory read or write failed: this pass's attempts are lost, never half-kept, and
    // the next pass finds the same scopes due.
    report.errors.push({ kind: 'storage', id: 'directory', error: message(err) });
  }
  return out;
}

/** The newest attempt on record, as the run it leaves: `error` is null when it succeeded or none was made. */
interface PreviousAttempt {
  error: string | null;
  since: string | null;
  failures: number;
}

const NO_ATTEMPT: PreviousAttempt = { error: null, since: null, failures: 0 };

/** The newest of a ledger's attempts (#2501), and the run of identical failures it belongs to when it failed. */
function previousAttempt(
  attempts: readonly { attemptedAt: string; error: string | null; failingSince: string | null; failingCount: number | null }[],
): PreviousAttempt {
  let newest: (typeof attempts)[number] | undefined;
  for (const a of attempts) if (newest === undefined || a.attemptedAt > newest.attemptedAt) newest = a;
  return newest ? { error: newest.error, since: newest.failingSince ?? newest.attemptedAt, failures: newest.failingCount ?? 1 } : NO_ATTEMPT;
}

/**
 * A failure's run (#2501): the previous attempt's run carried on when this failure repeats its error,
 * a new run begun `at` otherwise. A repeated failure is a standing one, which reached the failure
 * digest when its run began; the run keeps its start and length on the ledger and in the report,
 * where the pass's log line shows them.
 */
function extendRun(previous: PreviousAttempt, error: string, at: string): { run: FailingRun; repeated: boolean } {
  const repeated = error === previous.error;
  return {
    repeated,
    run: { error, since: repeated && previous.since ? previous.since : at, failures: repeated ? previous.failures + 1 : 1 },
  };
}

/**
 * One pass of the request-rollup phase (#2501): read the oldest due days one at a time, record
 * each day's counts or its failure, then prune past retention. A failed day writes nothing of the
 * day, waits `retryMs` like any other attempt, and ends the pass's reads: the days after it stay
 * due. A failure that repeats the previous attempt's is a standing one (a credential, a dataset
 * name, an outage), reported when its streak began and not again until a read succeeds.
 */
async function sweepRequestRollup(
  admin: HostAdmin,
  actor: PlatformActorId,
  rollup: RequestRollupSweepOptions,
  report: PlatformSweepReport,
): Promise<RequestRollupSweepReport> {
  const out: RequestRollupSweepReport = {
    due: 0,
    deferred: 0,
    read: 0,
    failed: 0,
    repeated: 0,
    streak: null,
    saturated: 0,
    saturatedDays: [],
    recorded: 0,
    pruned: 0,
  };
  const batch = rollup.batch ?? REQUEST_ROLLUP_DAYS_PER_PASS;
  const months = rollup.retentionMonths === undefined ? BILLING_ROLLUP_RETENTION_MONTHS : rollup.retentionMonths;
  const now = rollup.now ?? (() => new Date().toISOString());
  try {
    const nowMs = Date.parse(now());
    if (batch > 0) {
      const reads = await admin.listRequestRollupDays!(actor);
      // A saturated day is a state of that day, not a failure of the read, so it belongs to no run.
      let previous = previousAttempt(reads.filter((r) => !r.saturated));
      const due = requestRollupDueDays({
        nowMs,
        reads,
        lookbackDays: rollup.lookbackDays ?? REQUEST_ROLLUP_LOOKBACK_DAYS,
        settleMs: rollup.settleMs ?? REQUEST_ROLLUP_SETTLE_MS,
        retryMs: rollup.retryMs ?? REQUEST_ROLLUP_RETRY_MS,
        horizon: billingRollupHorizon(nowMs, months),
      });
      const take = due.slice(0, batch);
      out.due = due.length;
      out.deferred = due.length - take.length;
      // One day at a time: each is one Analytics Engine query, and the account's query budget
      // is shared with every observability read.
      const saturated: string[] = [];
      for (const day of take) {
        try {
          const counts = await withinDeadline(
            rollup.read(day),
            rollup.readTimeoutMs ?? REQUEST_ROLLUP_READ_TIMEOUT_MS,
            'the request rollup read',
          );
          out.recorded += (await admin.recordRequestDay!(actor, { day, attemptedAt: now(), counts })).recorded;
          out.read += 1;
          // A read that succeeds ends any run, so a failure later in this pass starts a new one.
          previous = NO_ATTEMPT;
        } catch (err) {
          const error = message(err);
          const attemptedAt = now();
          if (isRequestRollupSaturated(err)) {
            // A standing state of this day, not a failed read: kept visible on the day's record,
            // never read again, and no reason to stop, so the days after it are still rolled up.
            out.saturated += 1;
            saturated.push(day);
            await admin.recordRequestDay!(actor, { day, attemptedAt, error, saturated: true }).catch(() => undefined);
            continue;
          }
          out.failed += 1;
          const { run, repeated } = extendRun(previous, error, attemptedAt);
          out.streak = run;
          if (repeated) out.repeated += 1;
          else report.errors.push({ kind: 'request-rollup', id: day, error });
          // The failure is the day's attempt, so the day waits `retryMs` rather than taking a slot
          // on every pass. If even this write fails, the day is simply due again next pass.
          await admin
            .recordRequestDay!(actor, { day, attemptedAt, error, failingSince: run.since, failingCount: run.failures })
            .catch(() => undefined);
          // The next day would most likely fail the same way, and each read is a fleet-wide query
          // against the account's shared budget: one failure ends the pass's reads.
          break;
        }
      }
      // No read failed this pass and none succeeded (a success resets `previous`): a run the ledger
      // holds still stands, though this pass had nothing due to retry. It is reported as it is,
      // with no attempt added and nothing pushed to the digest, which mailed it when it began.
      if (out.streak === null && previous.error !== null && previous.since !== null) {
        out.streak = { error: previous.error, since: previous.since, failures: previous.failures };
      }
      // Each saturated day reaches the digest once, on the pass that found it: it is not read again.
      out.saturatedDays = saturated;
      if (saturated.length > 0) {
        report.errors.push({
          kind: 'request-rollup',
          id: 'saturated',
          error: `${saturated.length} day(s) hold more groups than one read answers and are kept unread: ${saturated.join(', ')}`,
        });
      }
    }
    if (typeof admin.pruneRequestDays === 'function') {
      out.pruned = await admin.pruneRequestDays(actor, rollup.pruneBatch ?? REQUEST_ROLLUP_PRUNE_BATCH, months);
    }
  } catch (err) {
    // A directory read or the prune failed: whatever days were recorded stay recorded, and the
    // next pass finds the rest due.
    report.errors.push({ kind: 'request-rollup', id: 'directory', error: message(err) });
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * One pass of the meter-snapshot phase (#2501): take the snapshot of the UTC day the pass runs in,
 * unless the day already has one, then prune past retention. A failed attempt writes nothing of the
 * day and is recorded, and the next pass of the day tries again. A failure that repeats the attempt
 * before it, across days too, is a standing one: reported when its run began, and not again until
 * a snapshot is taken.
 */
async function sweepMeterSnapshot(
  admin: HostAdmin,
  actor: PlatformActorId,
  snapshot: MeterSnapshotSweepOptions,
  report: PlatformSweepReport,
): Promise<MeterSnapshotSweepReport> {
  const out: MeterSnapshotSweepReport = { day: null, taken: false, tenants: 0, failed: 0, repeated: 0, streak: null, pruned: 0 };
  const months = snapshot.retentionMonths === undefined ? BILLING_ROLLUP_RETENTION_MONTHS : snapshot.retentionMonths;
  const now = snapshot.now ?? (() => new Date().toISOString());
  try {
    const at = new Date(now()).toISOString();
    const day = at.slice(0, 10);
    out.day = day;
    // The attempt before this pass is today's, or yesterday's when today has none: one a day at the
    // least while the phase runs, so two days hold it.
    const takes = await admin.listMeterDayTakes!(actor, { since: utcDayOf(Date.parse(at) - DAY_MS), until: day });
    // A day already taken is not tried again, so a later pass of the day can never report a failure
    // about a snapshot that stands. The directory checks again inside its own transaction, which is
    // what settles two passes racing for the same day.
    if (!takes.some((t) => t.day === day && t.takenAt !== null)) {
      try {
        const taken = await withinDeadline(
          admin.recordMeterDay!(actor, { at }),
          snapshot.timeoutMs ?? METER_SNAPSHOT_TIMEOUT_MS,
          'the meter snapshot',
        );
        out.taken = taken.taken;
        out.tenants = taken.tenants;
      } catch (err) {
        const error = message(err);
        out.failed = 1;
        const { run, repeated } = extendRun(previousAttempt(takes), error, at);
        out.streak = run;
        if (repeated) out.repeated = 1;
        else report.errors.push({ kind: 'meter-snapshot', id: day, error });
        // The attempt's own instant, so its record lands on its day even when the deadline ran past
        // midnight. If even this write fails, the next pass simply tries again.
        await admin
          .recordMeterDay!(actor, { at, error, failingSince: run.since, failingCount: run.failures })
          .catch(() => undefined);
      }
    }
    if (typeof admin.pruneMeterDays === 'function') {
      out.pruned = await admin.pruneMeterDays(actor, snapshot.pruneBatch ?? METER_DAYS_PRUNE_BATCH, months);
    }
  } catch (err) {
    // A directory read or the prune failed: a snapshot already taken stays taken, and the next pass
    // tries the day again if it was not.
    report.errors.push({ kind: 'meter-snapshot', id: 'directory', error: message(err) });
  }
  return out;
}

const pushCapped = (bucket: { count: number; scopeIds: string[] }, id: string): void => {
  bucket.count += 1;
  if (bucket.scopeIds.length < ORPHAN_ATTACHMENT_REPORTED_IDS) bucket.scopeIds.push(id);
};

/**
 * Whether the admin log holds a dry-run row for the scope from within the window: the licence for
 * a destructive pass (`OrphanAttachmentSweepOptions`). A delete row in the same window is not one.
 *
 * One read per visited scope, in delete mode only, and on a host that records directory reads it is
 * one more access-log row each (K-24): at the default batch and a 15-minute cron, 2,400 a day. The
 * control plane's reach already reads the scope, its tenant, and its serving pointer or its bound
 * version per visit, which is three such rows, so this adds a quarter. It stays an audited
 * read on purpose: a quiet read of the admin log would be the one platform read K-24 does not see.
 * One read per pass for the whole window is not cheaper, since a row carries up to the pass's limit
 * of keys and the window holds a week of them.
 */
async function hasRecentDryRun(
  host: ScopeHost,
  actor: PlatformActorId,
  scope: Scope,
  since: string,
): Promise<boolean> {
  const rows = await host.admin.auditLog(actor, {
    tenantId: scope.tenantId,
    scopeId: scope.id,
    action: 'sweepOrphanAttachments',
    since,
    order: 'desc',
    limit: 100,
  });
  return rows.some((r) => (r.after as { dryRun?: unknown } | null)?.dryRun === true);
}

/** The orphan-attachment phase (#2314): one window of scopes, each swept where it is served. */
async function sweepOrphanAttachmentWindow(
  host: ScopeHost,
  options: PlatformSweepOptions,
  phase: OrphanAttachmentSweepOptions,
  scopes: readonly Scope[],
  report: PlatformSweepReport,
): Promise<OrphanAttachmentSweepReport> {
  const batch = phase.batch ?? ORPHAN_ATTACHMENT_SWEEP_BATCH;
  const out: OrphanAttachmentSweepReport = {
    mode: phase.mode,
    eligible: scopes.length,
    visited: 0,
    deferred: 0,
    dryRuns: 0,
    deletes: 0,
    awaitingDryRun: 0,
    noStore: { count: 0, scopeIds: [] },
    fenced: 0,
    consumeFailed: 0,
    orphans: 0,
    deleted: 0,
    refused: { count: 0, scopeIds: [] },
    unsupported: { count: 0, scopeIds: [] },
  };
  const window = reconcileWindow(scopes, batch, phase.rng ?? Math.random);
  out.visited = window.length;
  out.deferred = scopes.length - window.length;
  const nowMs = Date.parse(phase.now?.() ?? new Date().toISOString());
  const since = new Date(nowMs - (phase.dryRunWindowMs ?? ORPHAN_SWEEP_DRY_RUN_WINDOW_MS)).toISOString();
  await mapBounded(window, options.concurrency ?? 8, async (s) => {
    try {
      let dryRun = true;
      if (phase.mode === 'delete') {
        dryRun = !(await hasRecentDryRun(host, options.actor, s, since));
        if (dryRun) out.awaitingDryRun += 1;
      }
      let outcome = await phase.sweepScopeFn(s.tenantId, s.id, { dryRun });
      // The scope's own licence is missing or spent (#2350): its next pass is the dry run, now.
      if ('unlicensed' in outcome && !dryRun) {
        out.awaitingDryRun += 1;
        outcome = await phase.sweepScopeFn(s.tenantId, s.id, { dryRun: true });
      }
      if ('refused' in outcome || 'unlicensed' in outcome) return pushCapped(out.refused, s.id);
      if ('unsupported' in outcome) return pushCapped(out.unsupported, s.id);
      const r = outcome.swept;
      // The deployment's word on what it did, never the mode asked for: a deployment that ignored
      // the flag is reported as what it was.
      if (r.dryRun) out.dryRuns += 1;
      else out.deletes += 1;
      if (r.bucket === 'none') pushCapped(out.noStore, s.id);
      if (r.fencedUntil !== undefined) out.fenced += 1;
      if (r.consumeFailed) out.consumeFailed += 1;
      out.orphans += r.orphans;
      out.deleted += r.deleted;
      if (r.orphans > 0 || r.deleted > 0) {
        const entry = {
          tenantId: s.tenantId,
          scopeId: s.id,
          dryRun: r.dryRun,
          listed: r.listed,
          candidates: r.candidates,
          orphans: r.orphans,
          deleted: r.deleted,
          keys: r.keys,
          ...(r.fencedUntil !== undefined ? { fencedUntil: r.fencedUntil } : {}),
        };
        try {
          await host.admin.recordOrphanSweep(options.actor, entry);
        } catch (err) {
          // The bytes are already gone when a real pass deleted any: this line is then the only
          // record of which ones, so it carries the whole entry, keys and all, before the error.
          if (r.deleted > 0) {
            console.error(`orphan-attachment sweep: deleted ${r.deleted} object(s) but the admin-log row was not written: ${JSON.stringify(entry)}`);
          }
          throw new Error(
            `the admin-log row was not written (${message(err)})` +
              (r.deleted > 0 ? `; ${r.deleted} object(s) were deleted, and the log line names them` : ''),
          );
        }
      }
    } catch (err) {
      report.errors.push({ kind: 'attachment-sweep', id: s.id, error: message(err) });
    }
  });
  return out;
}
