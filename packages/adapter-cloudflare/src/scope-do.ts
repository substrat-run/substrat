import type { EntityGrantShape } from '@substrat-run/contracts';
import { REWIND_REFUSED } from './rewind-refusal.js';
import { SYSTEM_DOOR_MOVED, type SystemDoorMoved } from './system-door.js';
import { DurableObject } from 'cloudflare:workers';
import {
  ATTACHMENT_ADDED,
  ATTACHMENT_REMOVED,
  attachmentRecord,
  type AttachmentRecord,
  domainEvent,
  domainEventInput,
  eventId,
  instant,
  objectRef,
  entityObjectRef,
  assertModuleEmittableType,
  assertKernelAuthoredType,
  toWireFailure,
  type WireFailure,
  grantRefFromProof,
  principalId,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
  platformRequestInput,
  platformRequestId,
  MAX_PENDING_PLATFORM_REQUESTS,
  MAX_PENDING_SWEEP_RUNS,
  SWEEP_RUNS_KIND,
  type DomainEvent,
  type DomainEventInput,
  type PlatformRequestInput,
  type PlatformRequestId,
  type PlatformRequest,
  type PlatformRequestFilter,
  type Coverage,
  type EntitlementView,
  type EntityRef,
  type EventAuthorization,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type ScopeDumpTable,
  type ScopeQueryResult,
  type ScopeTable,
  type DenialFilter,
  type DenialSummary,
  type PermissionDenial,
  type RefusalFilter,
  type RefusalRecord,
  type ScopeTablePage,
  type TenantId,
  SCOPE_TABLE_PAGE_MAX,
  SCOPE_QUERY_ROW_MAX,
  listLimitOf,
  pageOf,
  countedPageOf,
  requestFingerprint,
  substratError,
  errorCodeOf,
  assertReplayableDump,
  REDRAIN_BATCH,
} from '@substrat-run/contracts';
import {
  ulid,
  LIVE_CLOSE,
  LIVE_SOCKETS_PER_PRINCIPAL,
  DO_SQL_LIMITS,
  unknownRoleError,
  createUlid,
  type UlidMint,
  assertAllowed,
  ConnectionSealingKeyUnavailableError,
  noSealingKeyMessage,
  sealTo,
  assertReadOnlyQuery,
  entitlementDenial,
  platformRequestHistoryQuery,
  platformRequestOf,
  type PlatformRequestRawRow,
  PLATFORM_REQUEST_COLUMNS,
  PLATFORM_REQUEST_REDACTION_SQL,
  platformRequestRedactionParams,
  platformRequestRedactionQuery,
  intentPayloadCarriesSubject,
  redactSubjectJobRuns,
  redactSubjectScopeText,
  assertRowLimit,
  assertRowOffset,
  JOB_RUN_PATCH_SQL,
  JOB_RUN_CLAIM_SQL,
  JOB_RUN_RENEW_SQL,
  JOB_RUN_BEGIN_SQL,
  JOB_RUN_MISS_SQL,
  JOB_RUN_MISS_SETTLE_SQL,
  admissionMissOutcome,
  JOB_LEASE_EXPIRED_NOTE,
  JOB_STEP_RECORD_SQL,
  DELIVERY_ERROR_REDACTION_SQL,
  REDACTED_DELIVERY_NOTE,
  type PlatformRequestRedactionCandidate,
  type SubjectRedactionCounts,
  seatScopeTuple,
  delegatedGrantSql,
  delegatedRevokeSql,
  grantEntityShapeIn,
  topUpEntityGrantShapes,
  applyScopeRoleChange,
  changeScopeRole,
  revokeScopeRoles,
  scopeRoleHolders,
  type RoleBound,
  type ScopeRoleHolder,
  effectiveRoleGrantQuery,
  switchRecordedOff,
  switchSystemSchedules,
  peerGrantsStatus,
  systemGrantsStatus,
  systemScheduleState,
  systemSwitchedOff,
  type SwitchOutcome,
  type SwitchSql,
  type SwitchedOff,
  type PeerGrantsRow,
  type SystemGrantsEntry,
  type SystemScheduleState,
  denialListQuery,
  refusalListQuery,
  mapRefusalRow,
  type RefusalDbRow,
  denialSummaryQuery,
  denialTotalsQuery,
  DENIAL_WINDOW_QUERY,
  mapDenialRow,
  mapDenialSummaryBuckets,
  type DenialRow,
  type DenialWindowRow,
  PermissionDenied,
  assertImpersonationWrites,
  assertModuleEnqueueableKind,
  impersonationStampOf,
  type ConsumerHandler,
  type GuardPredicate,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PermissionChecker,
  type SqlMigration,
  createAtomic,
  type RunSub,
  NotSearchable,
  isSearchIndexTable,
  searchIndexPlans,
  NotListable,
  listIndexPlans,
  moduleMigrations,
  MIGRATION_DIGEST_FENCE_DDL,
  MIGRATION_DIGEST_MARK_LEGACY,
  assertJournalDumpCoherent,
  assertMigrationSql,
  migrationDivergence,
  migrationFailedError,
  migrationSteps,
  planMigrations,
  type MigrationStep,
  listQuery,
  cursorOf,
  type ListIndexPlan,
  type PageParams,
  searchLimit,
  searchMatchExpression,
  searchQuery,
  type SearchHit,
  type SearchIndexPlan,
  type SearchOptions,
  ATTACHMENT_TEXT_DDL,
  attachmentRecordOfRow,
  enqueueAttachmentText,
  reconcileAttachmentText,
  queueAttachmentTextBackfill,
  startAttachmentTextBackfill,
  type AttachmentTextBackfillBatch,
  recordAttachmentText,
  searchAttachments,
  type AttachmentRowShape,
  type ExtractionOutcome,
  IDEMPOTENCY_DDL,
  REFUSALS_TABLE_DDL,
  REFUSALS_INDEX,
  refusalInsert,
  refusalOf,
  markGuardRefusal,
  REFUSALS_REBUILD,
  refusalsAdmitGuards,
  assertIdempotencyKey,
  assertPermissionKey,
  idempotencyLookupQuery,
  idempotencyPruneStatement,
  idempotencyRecordStatement,
  idempotencyOptedOutMessage,
  replayFor,
  type IdempotencyRow,
  entityVersionQuery,
  entityVersionOf,
  assertIfMatch,
  type InvokeOptions,
  OUTBOX_ENTITY_INDEX,
  SCHEDULE_STATE_DDL,
  SCHEDULE_STATE_REBUILD,
  scheduleStateHasKind,
  VERTICAL_EVENTS_DDL,
  EXPORT_HOPS_SQL,
  emptyImportResult,
  IMPORT_CURSORS_SQL,
  IMPORT_CURSOR_OF_SQL,
  OUTBOX_MARK_SQL,
  exportedSinceQuery,
  emittedSinceQuery,
  emittedReportOf,
  EMITTED_REPORT_CAP,
  type EmittedReport,
  IMPORT_CURSOR_ADVANCE_SQL,
  IMPORT_RECORD_SQL,
  moveImportCursor,
  CrossVerticalRegistry,
  exportReadPlan,
  exportReadQuery,
  planExportBatch,
  withheldNote,
  type ExportRow,
  JOB_RUN_DDL,
  JOB_RUN_DUE_AT,
  jobRunListLimit,
  SYSTEM_DOOR_WAIT,
  type EntityVersion,
  type EntityVersionRow,
  type JobRunFilter,
  type JobRunPatch,
  type JobRunClaim,
  type JobRunRow,
  type JobDueKey,
  type JobStepRow,
  type LiveChange,
  type LiveNudge,
  ancestorsWithin,
  type ScheduleStateKind,
} from '@substrat-run/kernel';
import type {
  PeerCoverage,
  PeerSpec,
  VerticalCaller,
  BecomeCapabilityInput,
  CapabilityExchange,
  CapabilityId,
  CapabilityFilter,
  CapabilityPage,
  CapabilityRecord,
  CheckSubject,
  ExportedBatch,
  ExportReadInput,
  ImportBatch,
  ImportedEvent,
  ImportResult,
  ImportState,
  ImportCursorMoveAt,
  ImportCursorMoved,
  ImpersonationSession,
  Instant,
  MintedCapability,
  ModuleId,
  PlatformActorId,
} from '@substrat-run/contracts';
import {
  isUpgradeRequest,
  readSubscription,
  LIVE_DECIDE_ATTEMPTS,
  LIVE_FANOUT_LIMIT,
  LIVE_MODE_HEADER,
  LIVE_PRINCIPAL_HEADER,
  LIVE_SCOPE_HEADER,
  LIVE_SUBSCRIBE_PATH,
  LIVE_TENANT_HEADER,
  LIVE_WITHIN_HEADER,
  LIVE_EXPIRES_HEADER,
  decodeLiveWithin,
  liveInstant,
  type LiveRefusal,
  type LiveSubscription,
  type LiveWithin,
} from './live-reads.js';
import { replyOf, type DoReply } from './do-reply.js';
import { OperationQueue } from './serialization.js';
import { doScopedSql, doBuiltColumnsOf, doRedactionSql, doSpineSql } from './sql.js';
import {
  actorOf,
  admitPeer,
  collectPeers,
  switchPeer,
  peerSubjectRef,
  subjectGrantState,
  type RecordedOffCarry,
  type PeerDeclarations,
  assertNoSecret,
  CAPABILITY_DDL,
  COPY_ORIGIN_DDL,
  ENTITY_STATE_MOVES_DDL,
  SWITCH_FENCES_DDL,
  CAPABILITY_EXCHANGE_OPERATION,
  capabilityAttachmentWriteRefused,
  createCapabilityVerbs,
  createEntityEdgeVerbs,
  createEntityStateVerbs,
  createTrashedReads,
  searchStateWhere,
  uncheckedView,
  addStatePlans,
  statefulTablesOf,
  afterMigration,
  afterRuntimeDdl,
  derivesAnything,
  repairDerivedObjects,
  StateColumnLost,
  type DerivedPlans,
  type EntityStatePlan,
  exchangeCapability,
  guardSecrets,
  mintBecomeCapability,
  redactSecrets,
  redactSecretText,
  moduleLog,
  asyncInvocationId,
  asyncLinePass,
  type AsyncLinePass,
  resolveCapabilitySession,
  revokeCapabilityAsPlatform,
  readCapabilityPage,
  domainEventOf,
  facetEvents,
  readDeadLetters,
  readLifecycleFlow,
  readOperationSeries,
  readHistory,
  readInvocation,
  readUndrainedOutbox,
  walkEventCause,
  walkEventEffects,
  type UndrainedRead,
  type ConsumerDelivery,
} from '@substrat-run/kernel';
import type {
  DrainedEvent,
  EventFacetInput,
  EventFacetResult,
  HistoryEntry,
  EventId,
  CauseChain,
  EffectsTree,
  InvocationEvents,
  DeadLetter,
  LifecycleFlowInput,
  LifecycleFlowResult,
  OperationSeriesInput,
  OperationSeriesResult,
  Page,
  LifecycleDelivery,
  ScopeLifecycle,
  StoredScopeLifecycle,
} from '@substrat-run/contracts';
import { createDoTupleChecker, createLocalControlPlaneReader, scopeTupleReader, type ControlPlaneReader } from './checker.js';
import { CARRIED_AWAY_KEY, COPY_MARK_CLEARED_KEY, KEPT_COPY_REFUSAL, KEPT_DIVERGENT_KEY, LOAD_STAMP_KEY, STORE_LOCAL_META_KEYS, WRITE_REVISION_KEY, carriedAwayDump, isCopyMarkInsert, isWriteStatement, type CarriedAway, type KeptCopy, type LoadMarker, assertSpineTablesBuilt, capabilitiesForLoad, clearCopyMarker, dumpRowsInsert, isSpineTable, markCopyOrigin, repointScopeGrants, settleCopiedWork, emittedHere, IS_COPY_SQL, isCopyLoad, isLifecycleWrite, readLifecycle, settleLifecycleAfterLoad, writeLifecycle, spineColumnAdditions, type RepointSource } from '@substrat-run/kernel';

/**
 * `defineScopeDO` — one Durable Object per scope, the CF analogue of a single
 * `SqliteScopeHost` scope runtime (D-14). It closes over a CODE-TIME module set
 * (a DO cannot receive handler closures over RPC), builds the kernel spine in
 * its own SQLite, and runs each operation inside `ctx.storage.transaction` — the
 * async transaction API that commits on success and rolls back on a throw even
 * across an `await` (verified in workerd), the direct analogue of the pure
 * adapter's `BEGIN IMMEDIATE … COMMIT/ROLLBACK`.
 *
 * The coordinator (`CloudflareScopeHost`) owns the directory, the entitlement
 * gate, and audit; the DO owns per-scope execution: migrations, guards,
 * handlers, emits, the outbox→consumer dispatch loop, entity links, and local
 * permission evaluation (scope tuples here, tenant tuples via ControlPlaneDO).
 */

export interface ScopeDoEnv {
  /**
   * The shared directory DO — the source of tenant-level tuples + roles for a
   * scope whose `permission_source` is still 'control-plane'. Optional: a scope
   * that has been projected (or a CP-less vertical, docs/architecture/scope-local-
   * permissions.md) evaluates permissions locally and needs no binding.
   */
  CONTROL_PLANE?: DurableObjectNamespace;
  /**
   * The version REGISTRY id of the vertical version this script serves (#1242) —
   * injected at deploy as a `plain_text` binding, refreshed by every in-place serve,
   * and stamped into the outbox `version` column at emit (the signals dimension,
   * #1231). Optional: a script deployed before the binding existed, or a test
   * worker, stamps NULL.
   */
  SUBSTRAT_VERSION_ID?: string;
}

interface RegisteredModule {
  id: string;
  migrations: SqlMigration[];
  /** `migrations` with their digests, and which are held to them (#2066). */
  steps: Promise<readonly MigrationStep[]>;
  consumers: { eventType: string; handler: ConsumerHandler }[];
}

/** A scope's migration journal: `module@version` → the SQL digest it recorded (#2066). */
function readAppliedMigrations(sql: SqlStorage): Map<string, string | null> {
  const rows = sql.exec('SELECT module_id, version, sql_digest FROM _substrat_migrations').toArray() as unknown as {
    module_id: string;
    version: string;
    sql_digest: string | null;
  }[];
  return new Map(rows.map((r) => [`${r.module_id}@${r.version}`, r.sql_digest]));
}

interface DeclaredGuard {
  predicate: string;
  config: Record<string, unknown>;
  declaredBy: string;
}

/** One `connection:<id>` grant tuple as the read-back reads it (#726) — either store. */
interface ConnectionGrantTupleRow {
  subject: string;
  relation: string;
  expires_at: string | null;
}

interface OutboxRow {
  id: string;
  type: string;
  schema_version: number;
  occurred_at: string;
  tenant_id: string;
  scope_id: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  pii_class: string;
  subject_id: string | null;
  authorization: string | null;
  /** K-42: the staff actor + session, when the event was raised under one. NULL is
   *  the ordinary case, and a row written before impersonation existed. */
  impersonation: string | null;
  /** #1231: the emitting operation. NULL = consumer emit, or predates the column. */
  operation: string | null;
  /** #1242: the version REGISTRY id the script ran at emit. NULL = deployed without
   *  the binding, or the row predates the column. Never decoded into the envelope —
   *  a fact about the process, not event data for module code. */
  version: string | null;
  /** #1237: the event this one reacted to. NULL = nothing was being delivered when
   *  it was emitted, or the row predates the column. */
  caused_by: string | null;
  /** #1237: the invocation this event was emitted during. NULL = none was carried. */
  invocation_id: string | null;
  payload: string | null;
}

/**
 * The key marking a scope DO whose storage was destroyed (`destroyStorage`).
 * Written after `deleteAll()` so it survives the wipe, and never cleared: `reaped`
 * is terminal, so this is the DO's own permanent answer to "am I dead", available
 * without asking the directory.
 */
const REAPED_MARKER = '_substrat_reaped';

/**
 * The `_substrat_meta` key of the tenant a scope was provisioned for (#1738): written by the first
 * projection, never re-pointed, and what every door's pair check holds a request to (#2016).
 */
const PROVISIONED_FOR_KEY = 'provisioned_for';

/** #2016: the refusal of a write that would re-point a scope's tenant, in one wording. */
const tenantReceiptRefusal = (held: string, asked: string): string =>
  `refused: this scope was provisioned for tenant ${held}, not ${asked}`;

/** #2016: the spine tables whose rows say a scope holds state (`ScopeDO.holdsData`). */
const HOLDS_DATA_TABLES = ['_substrat_migrations', '_substrat_tuples', '_substrat_outbox', '_substrat_schedule_state'] as const;

/** #2016: how a tenant reads against a scope's record (`ScopeDO.tenantVerdict`). */
export type TenantVerdict = 'recorded' | 'inferred' | 'foreign' | 'unknown';

/** #2016: why `tenantId` is foreign to a scope (`held`, the receipt `tenantVerdict` read), in one wording. */
const foreignTenant = (held: string | null, tenantId: string): string =>
  held !== null
    ? tenantReceiptRefusal(held, tenantId)
    : `refused: this scope holds role rows for another tenant and none for ${tenantId}`;

/** #2016: the load refusals `tenantReceiptRefusal` raised, told apart by identity, not by text. */
const tenantRefusals = new WeakSet<Error>();

/**
 * The scope spine, as this adapter builds it — one of two hand-written copies (#969).
 *
 * The other is `KERNEL_DDL` in `adapter-sqlite/src/index.ts`, and the two must describe
 * the same schema: this side is production, that side is dev, CI, self-host and escrow.
 * So a new `_substrat_*` table both hosts need, or a new column on a table they both
 * build, is added HERE and THERE — and for a store created before it, to both
 * column-addition lists as well (`applySpineColumnAdditions` below, `ensureSpineColumns`
 * on the pure side).
 *
 * `pnpm lint:spine-ddl` (`tools/spine-ddl-drift.mjs`) is what refuses a divergence: it
 * executes each side's DDL plus those later ALTERs and compares the schemas a query would
 * actually meet — columns, indexes (including the ones a UNIQUE creates) and foreign keys.
 * Two things it does NOT judge. A table present on one side only is a note, not a failure,
 * because the adapters legitimately partition the spine differently. And triggers and CHECK
 * constraints are not compared at all; the spine has none today, so adding one here means
 * adding it there with nothing to catch you. Keeping the copies and gating them, rather
 * than moving the DDL into the kernel, is the recorded answer to #969;
 * `docs/architecture/kernel-design.md` §8 says why.
 */
const KERNEL_DDL = `
  -- The ';' in this comment is a deliberate tripwire; the DDL must go through
  -- splitSqlStatements, and a naive split(';') fails every scope at construction.
  CREATE TABLE IF NOT EXISTS _substrat_outbox (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    pii_class TEXT NOT NULL,
    subject_id TEXT,
    payload TEXT,
    -- K-34: the checks the emitting operation passed (JSON [{permission, grant?}]).
    -- NULL on rows written before the field existed -- honestly unrecorded, not empty.
    authorization TEXT,
    -- K-42: the staff actor + session an impersonated operation ran under (JSON
    -- session/by). NULL is the ordinary case -- nobody was impersonating -- and the
    -- actor column above stays the principal the permission model answered about.
    impersonation TEXT,
    -- #1231: the invoke() string this event was emitted from. NULL is two facts the
    -- spine cannot tell apart afterwards: a consumer emit (no operation ran), and a
    -- row written before the column.
    operation TEXT,
    -- #1242: the version REGISTRY id of the vertical version the script served when
    -- this event was emitted (the signals version dimension, #1231). NULL = the
    -- script was deployed without the binding, or the row predates the column.
    version TEXT,
    -- #1237: the event this one was emitted in REACTION to — set whenever an emit
    -- happens while this scope is delivering an event to a module consumer. The
    -- spine already recorded what authority an operation held and what invocation
    -- it ran under; neither is cause, and a consumer emit has no operation at all,
    -- so a backwards walk used to stop dead at the first consumer hop. NULL =
    -- nothing was being delivered (an operation emitted it directly), or the row
    -- predates the column.
    caused_by TEXT,
    -- #1237: the INVOCATION this event belongs to, minted by the transport and carried
    -- on InvokeOptions. The spine could say what caused an event and which operation
    -- emitted it, and still not say which two events came from the same call — the
    -- runtime's request id is stamped by the log platform at ingestion, so no vertical
    -- code can read it. NULL = the transport minted none, or the row predates the column.
    invocation_id TEXT,
    drained_at TEXT
  );
  -- #1232: the freshness evaluator's read - MAX(occurred_at) per type, every pass,
  -- over a table that is never pruned. Unindexed, that is a full history scan.
  CREATE INDEX IF NOT EXISTS _substrat_outbox_type_at ON _substrat_outbox (type, occurred_at);
  -- #1334: the drain's read - WHERE drained_at IS NULL ORDER BY id. No existing index
  -- starts with drained_at, so without this one SQLite walks the PRIMARY KEY from the
  -- oldest event forward, stepping over every row a previous pass already shipped. A
  -- drain RETAINS what it marks, so that prefix only grows: the cost of finding the next
  -- batch would rise with the scope's lifetime event count rather than with how far
  -- behind the drain is. Leading with drained_at makes the undrained rows a seekable
  -- range, and the trailing id gives the ORDER BY for free. IF NOT EXISTS in the spine
  -- DDL, which every wake re-runs, so existing scopes get it too.
  CREATE INDEX IF NOT EXISTS _substrat_outbox_drained ON _substrat_outbox (drained_at, id);
  -- platform-intents.md: durable intents a vertical enqueues (ctx.requestPlatform) for the platform
  -- to drain and execute with HostAdmin authority -- the sandbox-clean way a vertical asks for a
  -- privileged action. Written by the kernel (spine), settled by the platform drain.
  CREATE TABLE IF NOT EXISTS _substrat_platform_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    -- K-42: the staff actor + session, when the intent was raised under one.
    impersonation TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    -- #841: WHO refused, as JSON {origin, code, permission}. last_error says WHAT
    -- happened and always did; this says whether it was the provider's answer or our
    -- own refusal before egress -- the distinction the dashboard was guessing wrong.
    -- NULL = never classified (a row settled before this column, or one that never
    -- failed), which is not the same fact as an origin of 'unknown'.
    last_failure TEXT,
    result TEXT,
    requested_at TEXT NOT NULL,
    settled_at TEXT
  );
  -- K-35: refused permission checks. A denial rolls its operation back, so it is
  -- recorded here OUTSIDE that transaction, on the deny path -- the one event where an
  -- actor's intent and the permission model visibly disagree, witnessed by no other log.
  -- Drains rather than expires (K-24's split): drained_at marks a shipped row.
  CREATE TABLE IF NOT EXISTS _substrat_denials (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    permission TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT,
    operation TEXT,
    -- K-42: WHICH of the two actors was refused is exactly what this log is for.
    impersonation TEXT,
    -- #1525: the INVOCATION this refusal happened during, the same id #1237 stamps on
    -- every event of a call. A denial joins to nothing but actor and time otherwise --
    -- the operation column names what was attempted, never WHICH attempt -- so "what
    -- else did this request do" cannot reach a refusal, which is the one thing an
    -- incident asks about first. NULL = the transport carried no id (a seed, a test,
    -- an internal call, an attachment RPC), or the row predates the column.
    invocation_id TEXT,
    at TEXT NOT NULL,
    drained_at TEXT
  );
  -- #383 / #1232 / #1288: the platform sweep's per-scope gating state, holding two
  -- families of row that the kind COLUMN -- not the spelling of a key -- tells
  -- apart. Spine (kernel-written), never a module migration. Shared with the pure
  -- adapter from @substrat-run/kernel, so the shape a rebuild produces and the shape
  -- a fresh store gets cannot part company; the column comments are in there.
  ${SCHEDULE_STATE_DDL}
  -- #1577: the resumable-run driver's record and the step ledger of the pass it
  -- currently has in flight. Spine (kernel-written), never a module migration.
  -- Shared with the pure adapter from @substrat-run/kernel so the shape production
  -- builds and the shape a self-host builds cannot part company; the column
  -- comments, and the reason coalescing is NOT a unique index, are in there.
  ${JOB_RUN_DDL}
  -- #1705: cross-vertical delivery. The consumer's journal of what it received (envelope
  -- only) and its watermark per producer, plus the producer-side (type, id) outbox index the
  -- export read seeks on. Shared with the pure adapter from @substrat-run/kernel.
  ${VERTICAL_EVENTS_DDL}
  CREATE TABLE IF NOT EXISTS _substrat_migrations (
    module_id TEXT NOT NULL,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    duration_ms INTEGER,
    rows_changed INTEGER,
    -- #2066: SHA-256 of the SQL that ran (kernel migrationDigest). NULL on a row written
    -- before the column: unrecorded, accepted, never backfilled.
    sql_digest TEXT,
    PRIMARY KEY (module_id, version)
  );
  -- #2066: no new journal row without its digest (the kernel's comment says why).
  ${MIGRATION_DIGEST_FENCE_DDL}
  -- #286: the PITR bookmark taken immediately BEFORE a migration pass runs on a
  -- scope that already holds data -- the precise rewind point a backout restores
  -- to. Rows live in the same storage they describe, so a rewind erases the rows
  -- taken after its target, which is exactly right. "pending" names what was about
  -- to apply (module@version list, JSON) for the deployments UI.
  CREATE TABLE IF NOT EXISTS _substrat_migration_bookmarks (
    bookmark TEXT PRIMARY KEY,
    taken_at TEXT NOT NULL,
    pending TEXT NOT NULL
  );
  ${SWITCH_FENCES_DDL}
  CREATE TABLE IF NOT EXISTS _substrat_tuples (
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    -- K-21: revocation tombstones rather than deletes -- the row stays, the walk
    -- skips it, and it remains readable as evidence.
    revoked_at TEXT,
    PRIMARY KEY (subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    -- Terminal row: when it was delivered (or dead-lettered). Retrying row: when
    -- it was last ATTEMPTED. The column predates retry state (#100) and is NOT
    -- NULL, so it carries both readings rather than forcing a rebuild.
    delivered_at TEXT NOT NULL,
    error TEXT,
    -- Retry state, executors only (#100). Consumers leave the defaults.
    --   next_attempt_at IS NOT NULL  -> pending, due at that time
    --   next_attempt_at IS NULL      -> terminal: error IS NULL delivered, else dead
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    -- #1525: the invocation THIS ATTEMPT ran in, the same id #1237 stamps on every
    -- event of a call. Not the emitting event's -- that one is already on the outbox
    -- and a delivery joins to it through event_id. What that join cannot say is
    -- which call attempted the DELIVERY, and for an executor the two differ by
    -- design: attempt one runs in the emitting call's post-commit tail, every retry
    -- afterwards in a drain that is a different call or none. Moves with the row on
    -- an upsert, like delivered_at, error and attempts -- it describes the
    -- latest attempt, not the first. NULL = that attempt carried no call (a
    -- scheduled drain, an alarm, a seed, an attachment RPC), or the row predates
    -- the column.
    invocation_id TEXT,
    PRIMARY KEY (event_id, consumer_module)
  );
  -- Scope-local permissions (docs/architecture/scope-local-permissions.md): the
  -- tenant-level tuples + role definitions PROJECTED into this scope, so the
  -- checker evaluates permissions from local storage instead of reading the shared
  -- control-plane DO per request. Empty until a scope is projected (Phase 2) — until
  -- then permission_source stays 'control-plane' and the RPC path is used.
  CREATE TABLE IF NOT EXISTS _substrat_tenant_tuples (
    tenant_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    -- K-21 tombstone, mirroring _substrat_tuples: the row stays, the walk skips it.
    revoked_at TEXT,
    PRIMARY KEY (tenant_id, subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_roles (
    tenant_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    permissions TEXT NOT NULL,
    source TEXT NOT NULL,
    -- A removed role tombstones rather than deletes — a tombstoned role reads as
    -- absent (grants nothing) but stays as evidence.
    revoked_at TEXT,
    PRIMARY KEY (tenant_id, role_key)
  );
  -- Small scope-local key/value store. Today: 'permission_source' ∈
  -- {'control-plane','local'} — which reader the checker uses (default 'control-plane').
  CREATE TABLE IF NOT EXISTS _substrat_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- The tenant's entitlements PROJECTED into this scope (#304), so a hosted vertical
  -- reads plan/quota/expiry at request time from local storage instead of a forbidden
  -- control-plane binding — the same projection-on-write model as roles/tuples above,
  -- settling kernel open-question 5 (cache = the projection, invalidated by the fan-out).
  -- No audit columns (granted_at/granted_by stay control-plane-side) and no tombstone:
  -- applyProjection full-replaces, so a revoked grant is simply absent from the next
  -- snapshot. Empty until projected — a console-managed scope reads over RPC instead.
  CREATE TABLE IF NOT EXISTS _substrat_entitlements (
    tenant_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    expires_at TEXT,
    quota INTEGER,
    plan TEXT,
    PRIMARY KEY (tenant_id, entitlement_key)
  );
  -- The tenant's identity links PROJECTED into this scope (#406), so a CP-less
  -- vertical's auth adapter resolves (provider, externalId) → principal from local
  -- storage at request time instead of a static map compiled into the bundle — the
  -- same projection-on-write model as entitlements above. Keyed like the directory's
  -- _substrat_identities (K-22: tenant-scoped, never global). No audit columns
  -- (created_at and the link/unlink trail stay control-plane-side) and no tombstone:
  -- applyProjection full-replaces, so an unlinked identity is simply absent from the
  -- next snapshot — absence resolves to nothing, which is the fail-closed direction.
  CREATE TABLE IF NOT EXISTS _substrat_identity_links (
    tenant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    scope_id TEXT,
    PRIMARY KEY (tenant_id, provider, external_id)
  );

  -- Each live connection's PUBLIC sealing key, PROJECTED into this scope (#687), so
  -- module code can seal a value TO a connector before emitting it — the one channel
  -- a CP-less vertical has for handing a connector something the spine must not hold
  -- in the clear. Same projection-on-write model as entitlements and identity links
  -- above, and the same full-replace: a revoked connection's key is simply absent
  -- from the next snapshot, and absence makes sealToConnection refuse, which is the
  -- fail-closed direction.
  --
  -- **Only ever the public half.** Projecting a secret key into a scope is exactly the
  -- failure kernel-design §13.1 names — a key restored by the same dump that restores
  -- its ciphertext reverses every erasure the restore rolled past. The private half
  -- stays in the directory; this row lets the scope WRITE to a connector, never read.
  CREATE TABLE IF NOT EXISTS _substrat_connection_keys (
    tenant_id     TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    provider      TEXT NOT NULL,
    key_id        TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    PRIMARY KEY (tenant_id, connection_id)
  );

  -- Attachment metadata facts (#473): one row per object in the per-tenant blob store,
  -- keyed to the owning entity a module manifest declared as an attachmentTarget. Lives
  -- INSIDE the scope database on purpose — scope pull / restore / PITR carry the rows
  -- like any other scope fact; sha256 is the integrity witness for the bytes outside.
  CREATE TABLE IF NOT EXISTS _substrat_attachments (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    visibility TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _substrat_attachments_entity
    ON _substrat_attachments (entity_type, entity_id);
  -- #1575: attachment text and its FTS5 index, shared from @substrat-run/kernel. After
  -- _substrat_attachments, whose delete trigger it adds.
  ${ATTACHMENT_TEXT_DDL}
  -- #901: an entity's version is the ULID of the last event about it, so
  -- MAX(id) per (entity_type, entity_id) is the read. The id column sits last so
  -- SQLite walks to the end of the matched range instead of aggregating over it.
  ${OUTBOX_ENTITY_INDEX}
  -- #116: the request-dedupe table, kernel-owned so no vertical migrates for it.
  ${IDEMPOTENCY_DDL}
  -- #1745: refused transitions, recorded after the rollback like a denial. Kernel-owned.
  ${REFUSALS_TABLE_DDL}
  ${REFUSALS_INDEX}
  -- #1672: capabilities — authority carried by a secret (a link share), and the sessions
  -- an exchange trades that secret for. Shared with the pure adapter from
  -- @substrat-run/kernel so the two cannot part company; the column comments are there.
  ${CAPABILITY_DDL}
  -- #1686: where a copied scope's data came from, and the event id its own events start above.
  -- Shared with the other adapter from @substrat-run/kernel; the column comments are there.
  ${COPY_ORIGIN_DDL}
  -- #119: the kernel's authorization for one archive/trash move, read by the derived update
  -- trigger. Shared with the other adapter from @substrat-run/kernel; the comments are there.
  ${ENTITY_STATE_MOVES_DDL}
`;

/**
 * Workers RPC carries a plain `Error`'s MESSAGE faithfully and nothing else. A custom
 * subclass (e.g. Zod's `ZodError`, whose `message` is a getter over its issues) arrives
 * on the coordinator side as just its class name, so re-wrap any non-plain error as a
 * plain `Error` before it crosses — the message (which for a ZodError includes the
 * failing path/detail) survives, and contract matchers assert on it.
 *
 * **`name` is NOT a second channel, and this was measured, not assumed** (#113 phase 2,
 * `test/error-taxonomy.test.ts`). Setting `name` on the rewrapped error does not deliver
 * a `name` on the far side: workerd folds it into the message as `"<name>: <message>"`
 * and resets `name` to `'Error'`. So carrying the error taxonomy's code this way would
 * rewrite every error message on the Cloudflare path — `permission denied: perm:use`
 * becomes `PermissionDenied: permission denied: perm:use` — for every log line, every
 * vertical's `onError`, and every UI string.
 *
 * The consequence, stated so it is not re-derived: across THIS boundary a throw carries
 * its message and nothing more. Structure has to travel as a VALUE, which is the
 * discriminated `{ ok, error }` envelope the error-model RFC names as §3's successor.
 * In-process — the SQLite adapter, a handler in the same isolate — the real class
 * arrives and `errorCodeOf` reads it directly.
 */
/**
 * #1864: the kernel's own events (attachments, capability exchanges) written through the
 * context an operation runs in, WITHOUT `ctx.emit`'s refusal of kernel-authored types. Keyed
 * by the context object and never exported, so module code — which can reach `ctx` but not
 * this map — cannot write one. Registered as each context is built.
 */
const kernelEmitters = new WeakMap<OperationContext, (event: DomainEventInput) => void>();

function kernelEmit(ctx: OperationContext, event: DomainEventInput): void {
  const write = kernelEmitters.get(ctx);
  if (!write) throw new Error('kernelEmit: not an operation context this host built');
  write(event);
}

/**
 * The scope DO's write revision (#1722): the one SQL handle this object writes through, and the
 * one way it opens a transaction, so a writer or a transaction added later cannot slip past it.
 * A carry's conditional restore compares the revision, so every change to the store has to move
 * it: an UPDATE in place (a drain receipt, a redrain) as surely as an emitted event (Codex #2008
 * r2). `suspended` is the wake's idempotent DDL, a load's drop-and-replay and a migration's own
 * statements, which advance it themselves.
 *
 * **Atomic with the write (Codex #2008 r4).** The bump runs synchronously, right BEFORE the first
 * write that needs it, on the same connection: inside a `transactionSync` or `transaction` it
 * commits or rolls back with that transaction's writes, and outside one it joins the same
 * coalesced batch. A bump that fails throws before the write runs, so no write lands under the old
 * revision. Nothing is deferred to a later commit.
 *
 * **Once per run, not per statement** (a bump per statement cost 28.7–32.4% on a write-heavy
 * operation, `write-revision-cost.test.ts`). After a bump, later writes skip it while they are
 * covered by it: until the run ends (a microtask clears the flag at its first await or its end)
 * and until a transaction boundary. Entering a transaction clears it, so each committing
 * transaction holds a bump of its own; leaving one clears it too, so after a rollback (which took
 * the bump with it) or a commit the next write bumps again. Clearing more often only over-counts,
 * and over-counting only refuses a restore that could have landed.
 */
class WriteRevision {
  /** Whether the current run, in the current transaction scope, already holds a bump. */
  private covered = false;
  /** Inside `bookkeeping`: the one path whose writes advance no revision. */
  private keeping = false;
  /** A statement's text is almost always a constant, so its answer is remembered (bounded). */
  private readonly writes = new Map<string, boolean>();
  /**
   * Every write statement run through this handle since the object woke, in memory (#938, Codex
   * #2077 r4) — counted per STATEMENT, bookkeeping and suspended ones included, where the durable
   * revision above is bumped once per run. A live fan-out pass decides who may hear a frame across
   * awaits; it reads this immediately before deciding and again immediately before sending, with
   * no await between that second read and the send, and decides again when it moved. Per statement
   * because a decision taken between a transaction's first write (its bump) and a later one (the
   * revoke itself) must not read as current. Over-counting (a rolled-back write, a write no check
   * reads) only costs a pass a re-check.
   */
  private written = 0;
  readonly sql: SqlStorage;

  constructor(
    private readonly raw: SqlStorage,
    private readonly storage: DurableObjectStorage,
    private readonly suspended: () => boolean,
    /** Why this store takes no write at all right now, or null (a `carried_away` copy, #1722). */
    private readonly refusal: () => string | null,
  ) {
    const exec = (query: string, ...bindings: unknown[]) => {
      const write = this.isWrite(query);
      if (write) this.written++;
      if (this.keeping && write) {
        // Bookkeeping takes the copy-marker insert and the lifecycle delivery (#1713) and nothing
        // else: any other write here would be one the revision never saw, which is the hole this
        // class exists to close.
        if (!isCopyMarkInsert(query) && !isLifecycleWrite(query)) {
          throw substratError('internal', `the bookkeeping path takes only the copy-marker insert and the lifecycle delivery (#1722, #1713), not: ${query.slice(0, 80)}`);
        }
        return raw.exec(query, ...bindings);
      }
      if (write && !this.suspended()) {
        const refused = this.refusal();
        if (refused) throw substratError('conflict', refused);
        if (!this.covered) this.bump();
      }
      return raw.exec(query, ...bindings);
    };
    this.sql = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'exec') return exec;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /**
   * Store bookkeeping that is not the scope's data: marking the store a copy (#2005, Codex #2008
   * r10). That only ever restricts what the store may run and changes no data, so it advances no
   * write revision: a backfill that marks a carry's source between its export and its wipe must
   * not read as a write the carry did not copy (that would keep the copy for nothing). Enforced,
   * not trusted: any write in here but the marker insert (`isCopyMarkInsert`) or the lifecycle
   * delivery (`isLifecycleWrite`, #1713) throws. Clearing a
   * marker is NOT bookkeeping (r11): it loosens the store, so it is a write a carry fences on.
   */
  bookkeeping<T>(run: () => T): T {
    const was = this.keeping;
    this.keeping = true;
    try {
      return run();
    } finally {
      this.keeping = was;
    }
  }

  /** `storage.transactionSync`, at a transaction boundary. */
  transactionSync<T>(run: () => T): T {
    this.covered = false;
    try {
      return this.storage.transactionSync(run);
    } finally {
      this.covered = false;
    }
  }

  /** `storage.transaction`, at a transaction boundary. */
  async transaction<T>(run: () => Promise<T>): Promise<T> {
    this.covered = false;
    try {
      return await this.storage.transaction(run);
    } finally {
      this.covered = false;
    }
  }

  private bump(): void {
    // No catch: a bump that cannot be written fails the write it was for.
    this.raw.exec(
      `INSERT INTO _substrat_meta (key, value) VALUES (?, '1')
       ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
      WRITE_REVISION_KEY,
    );
    this.covered = true;
    queueMicrotask(() => {
      this.covered = false;
    });
  }

  /** How many write statements this handle has run (see `written`). */
  get statementsWritten(): number {
    return this.written;
  }

  private isWrite(query: string): boolean {
    let known = this.writes.get(query);
    if (known === undefined) {
      known = isWriteStatement(query);
      if (this.writes.size >= 512) this.writes.clear();
      this.writes.set(query, known);
    }
    return known;
  }
}

/** What a write into a wiped copy answers (#1722): the scope's data lives in another script now. */
const CARRIED_AWAY_WRITE_REFUSAL =
  'this copy of the scope was carried to another script and wiped (#1722); it takes no writes — ' +
  'a request that reaches it was routed before the move';

function toRpcError(err: unknown): Error {
  if (err instanceof Error) {
    return err.constructor === Error ? err : new Error(err.message);
  }
  return new Error(String(err));
}

/** The check subject for an attachment gate (#476): the connection when the connector door
 *  set one, else the principal — mirrors the invoke path's subject selection. */
/**
 * The entity a guarded operation's precondition is about (#129).
 *
 * `idFrom` is compile-checked to name an input field and the host has already
 * parsed that input, so the field exists with its declared type. What remains
 * possible is a field the schema lets the caller OMIT — and a precondition with no
 * row to read is not a weaker check but an absent one, indistinguishable from one
 * that passed. Refused rather than skipped.
 *
 * A module-level function rather than a method, so the pure adapter and this one
 * are demonstrably answering with the same rule.
 */
function concurrencyRefOf(
  operation: string,
  guarded: { entity: string; idFrom: string },
  parsed: unknown,
): EntityRef {
  const id = (parsed as Record<string, unknown> | undefined)?.[guarded.idFrom];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `${operation} declares concurrency over '${guarded.entity}' keyed by ` +
        `'${guarded.idFrom}', but the parsed input carries no such id — there is no ` +
        'row whose version could be compared',
    );
  }
  return { entityType: guarded.entity, entityId: id };
}

/**
 * What a capability attachment verb (#1686) answers: its value, or its failure as DATA —
 * `invoke`'s envelope discipline, since a throw across the RPC keeps only its message.
 */
export type CapabilityAttachmentReply<T> = DoReply<T>;

function attachSubject(principal: PrincipalId, connectionId?: string): CheckSubject {
  return connectionId ? { kind: 'connection', id: connectionId } : { kind: 'principal', id: principal };
}

/** The platform spine (`_substrat_*`) and SQLite internals — the UI groups these apart. */
function isSystemTable(name: string): boolean {
  return name.startsWith('_substrat') || name.startsWith('sqlite_');
}

/** SQLite cell → a JSON-safe value: bigints stringify, blobs (ArrayBuffer) read as null. */
function cellToJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) return null;
  return v;
}

/**
 * Split a SQL blob (a migration, the kernel/directory DDL) into its statements,
 * honouring SQL syntax.
 *
 * The DO's `SqlStorage.exec` runs one statement per call, so a multi-statement
 * blob is split on `;`. A naive `sql.split(';')` breaks the moment a `;` appears inside a
 * `--`/`/* *​/` comment or a string literal — it truncates the statement and the DO
 * reports "incomplete input". The SQLite adapter never hit this because
 * better-sqlite3's `exec` takes the whole blob; this is what made a migration that
 * passed on SQLite fail only on Durable Objects (the divergence this fix closes).
 *
 * So this is a small SQL-aware scanner: it skips line and block comments, copies
 * string literals through verbatim (including the `''` escape), and splits only on
 * a top-level `;`. Comments are dropped from the emitted statements — which also
 * means a trailing comment can never become a comment-only "statement" that
 * `exec` rejects. Blank fragments are skipped.
 *
 * **A trigger body is not top level.** `CREATE TRIGGER … BEGIN …; …; END;` carries
 * semicolons that belong to the trigger, and splitting on them produces four
 * fragments that are each a syntax error — the same "incomplete input" this
 * function exists to prevent, from the other direction. So inside a `CREATE
 * TRIGGER` the scanner keeps accumulating until a `;` that follows `END`. Found by
 * #827's derived search index, which is the first thing in the repo to emit a
 * trigger: it passed on better-sqlite3 (whose `exec` takes the whole blob) and
 * failed every scope on the DO host.
 */
const IS_CREATE_TRIGGER = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const ENDS_WITH_END = /\bEND\s*$/i;

/**
 * The kernel's two-method SQL handle (`SwitchSql`) over a Durable Object's storage — what the
 * shared switch rules (#1666) and the directory's switch record (#1674) run through. One
 * wrapper for both DOs, as the pure adapter has one `switchSqlOf`.
 */
export function switchSqlOver(sql: SqlStorage): SwitchSql {
  return {
    all: (q, ...params) => sql.exec(q, ...params).toArray() as Record<string, unknown>[],
    run: (q, ...params) => {
      sql.exec(q, ...params);
    },
  };
}

export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i += 1; // line comment → end of line
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2; // block comment → past the closing */
      continue;
    }
    if (c === "'") {
      cur += c;
      i += 1;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += sql[i + 1]; // '' is an escaped quote, still inside the string
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === ';') {
      // Inside a trigger body, a `;` ends an inner statement, not the CREATE.
      // `END` is matched as a bare word at the end of what has accumulated —
      // a string literal ending in END reads as `…END'`, so the quote keeps it
      // from matching, and the string scanner above has already copied it whole.
      if (IS_CREATE_TRIGGER.test(cur) && !ENDS_WITH_END.test(cur)) {
        cur += c;
        i += 1;
        continue;
      }
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * #1834: the pin missed. Thrown only by `assertSystemDoor`, and module-private, so no operation can
 * throw one: the two RPCs a door call reaches turn it into the `SystemDoorMoved` ANSWER, by class
 * identity, and an operation's own error, whatever its text, stays a failure.
 */
class SystemDoorMovedError extends Error {}

/** #1834: the brand only `assertSystemDoor` sets, so nothing else can make a `SystemDoorPass`. */
const SYSTEM_DOOR_PASSED: unique symbol = Symbol('system door passed');

/** Close a live socket whose session has ended (#938). */
function closeSessionEnded(ws: WebSocket): void {
  try {
    ws.close(LIVE_CLOSE.revoked, 'the session that opened this subscription has ended');
  } catch {
    // Already gone.
  }
}

/** #1834: proof that this call passed the system door's check, naming the module it acts as. */
interface SystemDoorPass {
  readonly moduleId: string;
  readonly [SYSTEM_DOOR_PASSED]: true;
}

export function defineScopeDO(
  modules: ModuleRegistration[],
  bareOps: Record<string, OperationHandler<never, unknown>>,
): new (ctx: DurableObjectState, env: ScopeDoEnv) => DurableObject {
  return class ScopeDO extends DurableObject<ScopeDoEnv> {
    private readonly sql: SqlStorage;
    private readonly queue = new OperationQueue();
    private readonly operations = new Map<string, OperationHandler<never, unknown>>();
    /**
     * #893: name → the declared input schema, parsed before guards and handler.
     * Port of the pure adapter's map; `defineOperation` bindings with no
     * declaration behind them stay unparsed, as they stay ungated.
     */
    private readonly operationInput = new Map<string, { parse(value: unknown): unknown }>();
    /** #129: name → the entity whose version an `If-Match` is compared against. */
    private readonly operationConcurrency = new Map<string, { entity: string; idFrom: string }>();
    /** #116: the operations that declared `idempotency: false` — refusals, not participants. */
    private readonly operationIdempotencyOptOut = new Set<string>();
    private readonly modules = new Map<string, RegisteredModule>();
    /** #1705: what this deployment exports to other verticals and imports from them. */
    private readonly crossVertical = new CrossVerticalRegistry();
    /**
     * #1706: every registered module's `peers`, as declared. The door's admission reads the
     * union (`collectPeers`), built once on first use: registration finishes in the
     * constructor, before any call can reach the door.
     */
    private readonly peerSources: { peers?: readonly PeerSpec[] }[] = [];
    private peerUnion: PeerDeclarations | undefined;
    private get peers(): PeerDeclarations {
      return (this.peerUnion ??= collectPeers(this.peerSources));
    }
    private readonly guards = new Map<string, DeclaredGuard[]>();
    private readonly predicates = new Map<string, { module: string; handler: GuardPredicate }>();
    private readonly withdrawn = new Map<string, string>();
    private readonly relations = new Map<string, Set<string>>();
    /** entityType → its derived FTS5 index (#827). One entity type, one index. */
    private readonly searchPlans = new Map<string, SearchIndexPlan>();
    /** #811: the paged lists modules declare, by entity type. Same one-owner rule. */
    private readonly listPlans = new Map<string, ListIndexPlan>();
    /** #119: entity type → its archive/trash plan, from every registered module. */
    private readonly statePlans = new Map<string, EntityStatePlan>();
    /** entityType → the declared attachment gate (#473): read key + write key (default: read). */
    private readonly attachmentTargets = new Map<string, { read: PermissionKey; write: PermissionKey }>();
    /**
     * entityType → the declared live-read gate (#938): the key a subscriber must hold
     * ON THAT ENTITY before a change to it is announced. Absent = announced to nobody;
     * `fanOutLive` treats a miss as silence, never as "unguarded".
     */
    private readonly liveTargets = new Map<string, PermissionKey>();
    private readonly checker: PermissionChecker;
    private readonly systemPrincipal: PrincipalId = principalId.parse(ulid());
    /**
     * The mint for event ids (#956) — its own monotonic floor, so the id's timestamp
     * is the operation's instant rather than whatever an unrelated wall-clock `ulid()`
     * in this isolate last stamped. The DO reads the wall clock today, so the two
     * agree; the seam is here for when it does not (the issue's other half).
     *
     * One DO is one scope, so this is already the per-scope mint #1335 asks for. What
     * it is NOT, on its own, is durable: a DO is evicted and revived constantly, and
     * NTP steps the wall clock backwards by small real amounts. The constructor
     * raises the floor to the outbox's own maximum, so a revived DO cannot mint
     * underneath rows it already stored.
     */
    private readonly mintEventId: UlidMint = createUlid();
    /** `module@version` → the SQL digest its journal row recorded, null for a row from before #2066. */
    private applied = new Map<string, string | null>();
    private migrationPromise?: Promise<boolean>;
    /** Latch: the applied count is reported to the directory once per DO instance. */
    private schemaVersionReported = false;
    /** The migration that failed on this instance, read back by `migrationFailure`. */
    private lastFailure: { version: string; error: string } | null = null;
    /** Passes of `applyPendingMigrations` that had work to do — see `migrationAttemptsOnInstance`. */
    private migrationRuns = 0;
    /**
     * TEST-ONLY (#1860): no production code reads this. An exact `'ping'` is answered
     * by `setWebSocketAutoResponse` without reaching `webSocketMessage` at all, and
     * this count is how a test proves that from outside the object — read through
     * `runInDurableObject` — rather than assuming the runtime's documented behaviour.
     */
    private webSocketMessagesHandled = 0;
    /**
     * #1722: while true, a write does not advance the write revision. True through the wake's
     * own idempotent DDL (which every wake re-runs, and which changes nothing) and through a
     * load's drop-and-replay, which sets the revision itself once the store is rebuilt.
     */
    private revisionSuspended = true;
    /**
     * #1722 (Codex #2008 r7): whether this store is a copy a carry wiped (it holds the
     * `carried_away` tombstone). Such a store takes no write: a stale request still routed here
     * after the wipe would land a write that belongs to no live copy. A load, a rollback's
     * restore, ends it. Read on every wake and after every load.
     */
    private carriedAwayCopy = false;
    /** #1722: the write revision, and the one way this object opens a transaction. */
    private readonly revision: WriteRevision;

    constructor(ctx: DurableObjectState, env: ScopeDoEnv) {
      super(ctx, env);
      // #1860: the client's 45s keep-alive (demos/ticket0/app/src/feed.ts) answered at
      // the runtime level, before this object wakes for it. Without this, every idle
      // subscriber's ping still reaches `webSocketMessage` and pins the DO in memory —
      // exactly the hibernation cost `acceptWebSocket` (below) exists to avoid.
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
      // #1722: the ONE handle this object writes through and the one way it opens a transaction,
      // so every write advances the write revision a carry's restore is fenced on, inside the
      // transaction that commits it. Nothing else here may take the raw handle or open a
      // transaction on `ctx.storage` itself (`carried-copy.test.ts` in the kernel holds that).
      this.revision = new WriteRevision(
        ctx.storage.sql,
        ctx.storage,
        () => this.revisionSuspended,
        () => (this.carriedAwayCopy ? CARRIED_AWAY_WRITE_REFUSAL : null),
      );
      this.sql = this.revision.sql;
      for (const stmt of splitSqlStatements(KERNEL_DDL)) {
        this.sql.exec(stmt);
      }
      this.applySpineColumnAdditions();
      this.revisionSuspended = false;
      this.carriedAwayCopy = this.metaValue(CARRIED_AWAY_KEY) !== null;

      for (const registration of modules) this.registerModule(registration);
      for (const [name, handler] of Object.entries(bareOps)) this.defineOperation(name, handler);

      // Which migrations have already run (a warm DO wakes with rows here).
      this.applied = readAppliedMigrations(this.sql);

      // #1335: and where this DO's event ids have to resume from. A revived DO would
      // otherwise start its floor at the wall clock, and a clock that has stepped back
      // — an NTP correction is small but real — mints underneath rows already stored,
      // which `ORDER BY id` hands to nobody. Read here for the reason the migrations
      // above are: this is the code every wake runs, and `MAX(id)` on the primary key
      // is an index seek. An empty outbox leaves the floor where it was.
      const highest = (
        this.sql.exec('SELECT MAX(id) AS id FROM _substrat_outbox').toArray() as unknown as {
          id: string | null;
        }[]
      )[0]?.id;
      if (highest) this.mintEventId.seedFrom(highest);

      const controlPlane = this.controlPlaneReader();
      this.checker = createDoTupleChecker({ scopeSql: this.sql, controlPlane });
    }

    // -- module registration (port of SqliteScopeHost.registerModule) ---------

    private registerModule(registration: ModuleRegistration): void {
      const manifest = registration.manifest;
      if (manifest.peers?.length) this.peerSources.push({ peers: manifest.peers });
      // #827: the FTS indexes `searchables` declares, appended after the module's
      // own migrations so the content table exists when the trigger references it.
      // Same derivation as the pure adapter — both call the kernel, neither owns
      // an opinion about the DDL.
      for (const plan of searchIndexPlans(manifest.id, manifest.searchables)) {
        const existing = this.searchPlans.get(plan.entityType);
        if (existing) {
          throw new Error(
            `search: '${plan.entityType}' is declared searchable by both '${existing.moduleId}' and ` +
              `'${plan.moduleId}' — one entity type, one index; rename one`,
          );
        }
        this.searchPlans.set(plan.entityType, plan);
      }
      // #119: the archive/trash plans, refusing a second owner of one entity type.
      addStatePlans(this.statePlans, manifest.id, manifest.entityStates, manifest.permissions);
      // #811: the list indexes `lists` declares, same placement and same reason.
      for (const plan of listIndexPlans(manifest.id, manifest.lists, manifest.entityStates)) {
        const existing = this.listPlans.get(plan.entityType);
        if (existing) {
          throw new Error(
            `list: '${plan.entityType}' declares a paged list in both '${existing.moduleId}' and ` +
              `'${plan.moduleId}' — one entity type, one walk; rename one`,
          );
        }
        this.listPlans.set(plan.entityType, plan);
      }
      // #1705: the same registry, the same refusals, as the coordinator and the pure host.
      this.crossVertical.register(manifest, registration.imports);
      this.modules.set(manifest.id, {
        id: manifest.id,
        // The order the kernel writes once (#1677): authored, then search, then list indexes.
        migrations: moduleMigrations(registration),
        steps: migrationSteps(registration),
        consumers: Object.entries(registration.consumers ?? {}).map(([eventType, handler]) => ({
          eventType,
          handler,
        })),
      });
      for (const [name, handler] of Object.entries(registration.predicates ?? {})) {
        this.predicates.set(name, { module: manifest.id, handler });
      }
      for (const guard of manifest.guards ?? []) {
        const forOperation = this.guards.get(guard.before) ?? [];
        forOperation.push({ predicate: guard.predicate, config: guard.config, declaredBy: manifest.id });
        this.guards.set(guard.before, forOperation);
      }
      for (const rel of manifest.entityRelations ?? []) {
        const parents = this.relations.get(rel.entityType) ?? new Set<string>();
        parents.add(rel.parentType);
        this.relations.set(rel.entityType, parents);
      }
      // Attachment targets (#473): entityType → the gate the attachment surface enforces.
      // Re-declaring with the same gate is idempotent; a different gate is refused —
      // ambiguous authority must not depend on registration order (mirror of the pure
      // adapter, which validates the same way).
      for (const target of manifest.attachmentTargets) {
        const gate = {
          read: target.readPermission,
          write: target.writePermission ?? target.readPermission,
        };
        const existing = this.attachmentTargets.get(target.entityType);
        if (existing && (existing.read !== gate.read || existing.write !== gate.write)) {
          throw new Error(
            `conflicting attachmentTargets for '${target.entityType}': ` +
              `(${existing.read}/${existing.write}) vs (${gate.read}/${gate.write})`,
          );
        }
        this.attachmentTargets.set(target.entityType, gate);
      }
      // Live-read targets (#938): entityType → the read key a subscriber must pass ON
      // THAT ENTITY before a change to it is announced. Validated exactly like the
      // attachment gate above, and for a sharper reason: two modules disagreeing about
      // which key guards an entity type would make "who may watch this" depend on
      // registration order, and the losing declaration would be the one that was meant
      // to be stricter. An entity type nobody declares is announced to nobody.
      for (const target of manifest.liveTargets ?? []) {
        const existing = this.liveTargets.get(target.entityType);
        if (existing && existing !== target.readPermission) {
          throw new Error(
            `conflicting liveTargets for '${target.entityType}': ` +
              `(${existing}) vs (${target.readPermission})`,
          );
        }
        this.liveTargets.set(target.entityType, target.readPermission);
      }
      for (const name of manifest.withdraws ?? []) {
        this.withdrawn.set(name, manifest.id);
        this.operations.delete(name);
      }
      // #893: a schema declared for an operation this module does not bind
      // enforces nothing while reading as coverage — refused, as in the pure adapter.
      const declaredInputs = registration.operationInputs ?? {};
      const ownOps = new Set(Object.keys(registration.operations ?? {}));
      const unbound = Object.keys(declaredInputs).filter((name) => !ownOps.has(name));
      if (unbound.length > 0) {
        throw new Error(
          `${manifest.id} declares operationInputs for unbound operation(s): ` +
            `${unbound.sort().join(', ')} — a schema on nothing reads as a parse that is not there`,
        );
      }
      // Same rule for a declared precondition, and it matters more: a
      // `concurrency` on an unbound name is a guarantee nothing enforces.
      const declaredConcurrency = registration.operationConcurrency ?? {};
      const unguarded = Object.keys(declaredConcurrency).filter((name) => !ownOps.has(name));
      if (unguarded.length > 0) {
        throw new Error(
          `${manifest.id} declares operationConcurrency for unbound operation(s): ` +
            `${unguarded.sort().join(', ')} — a precondition on nothing reads as a guard that is not there`,
        );
      }
      // #116: same rule again for an opt-out — one on an unbound name reads as a
      // deliberate exclusion of an operation that is not there.
      const declaredOptOuts = registration.operationIdempotencyOptOuts ?? [];
      const unboundOptOuts = declaredOptOuts.filter((name) => !ownOps.has(name));
      if (unboundOptOuts.length > 0) {
        throw new Error(
          `${manifest.id} declares idempotency: false for unbound operation(s): ` +
            `${[...unboundOptOuts].sort().join(', ')} — an opt-out on nothing reads as an ` +
            'exclusion someone decided, of an operation that does not exist',
        );
      }
      for (const [name, handler] of Object.entries(registration.operations ?? {})) {
        this.defineOperation(name, handler);
        // The schema follows the HANDLER, not the name: a withdrawn operation
        // never binds, and has nothing to parse for.
        const schema = declaredInputs[name];
        if (schema && this.operations.has(name)) this.operationInput.set(name, schema);
        const guarded = declaredConcurrency[name];
        if (guarded && this.operations.has(name)) this.operationConcurrency.set(name, guarded);
        if (declaredOptOuts.includes(name) && this.operations.has(name)) {
          this.operationIdempotencyOptOut.add(name);
        }
      }
    }

    private defineOperation(name: string, handler: OperationHandler<never, unknown>): void {
      if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
      this.operations.set(name, handler);
    }

    // -- RPC surface ----------------------------------------------------------

    /**
     * Trigger lazy migration (the coordinator calls this at provision time).
     * Returns the applied-migration count if this call applied any, else null —
     * the coordinator projects the count into the directory's `schema_version`
     * and skips the write when nothing changed.
     *
     * `ensureMigrations` memoises its promise, so every later call on a warm DO
     * resolves to the SAME `true` without applying anything — until something
     * clears the memo (`retryMigrations`, `importDump`), which is a fresh pass and
     * may apply. Reporting on each of the cached ones would bill a control-plane
     * RPC per stub mint to store a number that has not moved — hence the
     * once-per-instance latch.
     */
    async migrate(): Promise<number | null> {
      const applied = await this.ensureMigrations();
      if (!applied || this.schemaVersionReported) return null;
      this.schemaVersionReported = true;
      return this.applied.size;
    }

    /**
     * A FRESH migration attempt — the reconciliation sweep's retry affordance
     * (kernel-design §5.3, #49).
     *
     * `ensureMigrations` memoises its promise, and a REJECTED promise stays
     * assigned: every later `migrate()` on a warm instance returns the same
     * cached rejection without re-attempting (deliberate on the success path —
     * see `migrate` — but it means a sweep that "wakes" a failed scope through
     * the ordinary door retries nothing). This clears the latch and re-runs
     * `applyPendingMigrations`: already-journaled versions are skipped by the
     * `applied` set and the in-transaction re-check, so a concurrent or repeated
     * retry can never double-apply — the worst case is a redundant no-op pass.
     *
     * Same return contract as `migrate()`: the applied count when this call
     * applied any, else null; a still-failing migration rejects (and refreshes
     * `lastFailure` for the coordinator's read).
     */
    async retryMigrations(): Promise<number | null> {
      this.migrationPromise = undefined;
      this.lastFailure = null;
      // The reported latch is NOT reset: a successful retry returns the fresh
      // count below, and the coordinator records it on this same call.
      const applied = await this.ensureMigrations();
      return applied ? this.applied.size : null;
    }

    /**
     * How many times THIS instance has actually executed a migration pass —
     * the observable that distinguishes a fresh attempt from the memoised
     * rejection. The directory's `attempts` counter cannot: the coordinator
     * increments it whenever `migrate()` rejects, cached or not. Test/diagnostic
     * surface; the sweep itself never reads it.
     */
    migrationAttemptsOnInstance(): number {
      return this.migrationRuns;
    }

    /**
     * The last failed migration attempt on this instance, with the count that did
     * land before it. The coordinator reads this on `migrate()`'s rejection path to
     * record what failed (#32) — an extra RPC only when a scope is already broken.
     *
     * Instance state, not storage: `ensureMigrations` memoises its promise, so a
     * failed instance keeps returning the same rejection and this stays in step
     * with it. A restarted DO re-attempts and repopulates.
     */
    migrationFailure(): { version: string; error: string; applied: number } | null {
      return this.lastFailure ? { ...this.lastFailure, applied: this.applied.size } : null;
    }

    /**
     * This scope's database size in bytes (#1524): `SqlStorage.databaseSize`, which Cloudflare
     * bills on. Its one caller is an on-demand storage reading, never a sweep, because reaching
     * it wakes this DO.
     */
    databaseSize(): number {
      return this.sql.databaseSize;
    }

    /**
     * The PITR bookmarks this scope recorded before migration passes (#286),
     * newest first — what a backout UI offers as rewind points. Rows taken after
     * a rewind's target no longer exist post-rewind, by construction (they live
     * in the storage the rewind restores).
     */
    /**
     * When each migration ran (#1236), newest first. `applied_at` has been
     * written since this table shipped and selected by nobody — the frontier
     * readers want `(module_id, version)` only — so "when did this scope's
     * schema change" had no answer. A pre-column row reads null, a fact.
     */
    appliedMigrations(limit = 100): {
      moduleId: string;
      version: string;
      appliedAt: string | null;
      durationMs: number | null;
      rowsChanged: number | null;
    }[] {
      return this.sql
        .exec(
          `SELECT module_id, version, applied_at, duration_ms, rows_changed FROM _substrat_migrations
            ORDER BY applied_at DESC, module_id, version LIMIT ?`,
          limit,
        )
        .toArray()
        .map((r) => ({
          moduleId: r.module_id as string,
          version: r.version as string,
          appliedAt: (r.applied_at as string | null) ?? null,
          durationMs: (r.duration_ms as number | null) ?? null,
          rowsChanged: (r.rows_changed as number | null) ?? null,
        }));
    }

    /**
     * The events not yet shipped to Tier 2 (#1334), oldest first — and what the read
     * stepped over (#1636). `ORDER BY id` is chronological (ULID) and stable, so a drain
     * resumes where it stopped.
     *
     * The kernel's read, shared with the pure adapter: a row that will not decode is
     * neither returned nor stamped, and the rows behind it still come back. An object
     * rather than an array because it crosses the RPC — a property on an array would not.
     */
    undrainedEventsRead(limit: number): UndrainedRead {
      return readUndrainedOutbox(
        (offset, count) =>
          this.sql
            .exec(
              `SELECT * FROM _substrat_outbox WHERE drained_at IS NULL AND ${emittedHere()} ORDER BY id LIMIT ? OFFSET ?`,
              count,
              offset,
            )
            .toArray() as unknown as OutboxRow[],
        limit,
      );
    }

    /**
     * The same read as a bare array, for a coordinator deployed before
     * `undrainedEventsRead` (#1636) — kept so that pairing still drains, and still steps
     * over a bad row rather than stalling on it. It just cannot say that it did.
     */
    undrainedEvents(limit: number): DrainedEvent[] {
      return this.undrainedEventsRead(limit).events;
    }

    /**
     * Stamp `drained_at` on shipped events (#1334). Idempotent — a re-mark is a no-op,
     * and the returned count is how that becomes observable: the coordinator writes its
     * `drainEvents` admin receipt only when this is nonzero, so a retried pass records
     * no egress it did not actually perform.
     */
    /**
     * #1705: the producer's release to `input.consumer`, decided by THIS deployment's own
     * declarations. The pure adapter's `readExports`, row for row. The plan and the decision
     * are the kernel's, so the two hosts cannot release different rows from the same outbox.
     *
     * On the queue, so no operation is mid-transaction while the outbox is read. An event
     * must not reach another vertical before the transaction that wrote it has committed.
     */
    async exportedEventsRead(
      input: ExportReadInput,
      tenantId: TenantId,
      scopeId: ScopeId,
      /**
       * #2029: the consumer is a peer, so the read is gated by its door. `instance` pins it to the
       * gate's read, as every door call is; `held` says the rewind hold keeps the consumer off, and
       * then it holds nothing here: every key is missing, the answer a switched-off consumer gets.
       */
      door?: { instance: string } | { held: true },
    ): Promise<ExportedBatch | SystemDoorMoved> {
      const held = door !== undefined && 'held' in door;
      if (!held && this.peerDoorMoved(input.consumer, door?.instance)) return SYSTEM_DOOR_MOVED;
      await this.ensureMigrations();
      const plan = exportReadPlan(this.crossVertical.exports(), input.wants);
      const quiet: ExportedBatch = {
        events: [],
        withheld: [],
        unexported: plan.unexported,
        paused: null,
        next: input.after,
        more: false,
      };
      if (plan.types.length === 0) return quiet;
      const missing = held
          ? (plan.keys as PermissionKey[])
          : (await this.peerCoverage(tenantId, scopeId, input.consumer, plan.keys as PermissionKey[]))
              .filter((c) => !c.held)
              .map((c) => c.permission);
      if (missing.length > 0) return { ...quiet, paused: { missing } };
      return await this.queue.enqueue(() => {
        const q = exportReadQuery(plan.types, input.after, input.limit);
        const rows = this.sql.exec(q.sql, ...q.params).toArray() as unknown as ExportRow[];
        const batch = planExportBatch({
          rows,
          wanted: plan.wanted,
          after: input.after,
          limit: input.limit,
          hopsBefore: (row) =>
            row.caused_by
              ? (((this.sql.exec(EXPORT_HOPS_SQL, row.caused_by).toArray()[0] as { hops: number } | undefined)?.hops) ?? 0)
              : 0,
        });
        return { ...batch, unexported: plan.unexported, paused: null };
      });
    }

    /** #1705: what this deployment imports, and this scope's watermark per producer. */
    async importStateRead(): Promise<ImportState> {
      await this.ensureMigrations();
      const consumes = this.crossVertical.consumes();
      if (consumes.length === 0) return { consumes: [], cursors: [] };
      const cursors = this.sql
        .exec(IMPORT_CURSORS_SQL)
        .toArray()
        .map((r) => ({
          source: r.source_scope_id as string,
          vertical: r.source_vertical as string,
          cursor: r.cursor as string,
          updatedAt: r.updated_at as string,
        }));
      return { consumes, cursors } as ImportState;
    }

    /**
     * #1705 PR 2 / #1738: does this DO hold a scope PROVISIONED here for `tenantId`?
     *
     * A CP-less deployment has no directory to ask whether it serves a scope. What it does
     * have is what provisioning wrote. A scope this deployment never provisioned has none of
     * it: its DO is empty, and a cross-vertical verb answering from it is a wrong answer rather
     * than a failure: a watermark of "never read", or a delivery journaled into a scope that is
     * not the install.
     *
     * The answer is the `provisioned_for` RECEIPT `applyProjection` writes (#1738): the tenant
     * this scope was provisioned for, stated rather than inferred. A receipt decides alone, so
     * a scope holding a receipt for ANOTHER tenant is refused whatever role rows sit in it (K-3's
     * pair check), and a stray role row can no longer make a scope serve a tenant it was never
     * provisioned for.
     *
     * A scope with NO receipt was provisioned before it existed (a load never brings the dump's:
     * it describes the scope the dump came from, and the store keeps its own, #2016). Only then
     * is the old inference used: `provisionScopeLocal` projected role definitions under the
     * tenant, so a `_substrat_roles` row for it says the same thing. The next projection
     * (reconcile, or the restore's repair) or lifecycle delivery writes the receipt, after which
     * the inference is never consulted again.
     *
     * Read without migrating, so asking about a foreign scope leaves its DO as empty as it found it.
     */
    async servesTenant(tenantId: TenantId): Promise<boolean> {
      const { verdict } = this.tenantVerdict(tenantId);
      return verdict === 'recorded' || verdict === 'inferred';
    }

    /**
     * #2016: what one door into this scope needs from its storage on a CP-less host, in ONE call —
     * how `tenantId` reads against the scope (`tenantVerdict`), and the lifecycle the platform
     * delivered (#1713). The coordinator refuses a foreign pair before any guard, handler or store
     * lookup runs, and reports an `unknown` one it lets through. Read without migrating, like
     * `servesTenant`.
     */
    admission(tenantId: TenantId): { verdict: TenantVerdict; lifecycle: StoredScopeLifecycle | null } {
      return { verdict: this.tenantVerdict(tenantId).verdict, lifecycle: readLifecycle(this.switchSql()) };
    }

    /**
     * #1738 / #2016: this scope's tenant against `tenantId` — the one reading behind the served-here
     * gate, every door's pair check and the lifecycle delivery's back-fill.
     *
     *  - `recorded`: the `provisioned_for` receipt names `tenantId`.
     *  - `foreign`: the receipt names another tenant, or — on a scope provisioned before receipts
     *    existed — the scope holds role rows and none of them is `tenantId`'s.
     *  - `inferred`: no receipt, and a role row for `tenantId` (what `provisionScopeLocal` projected
     *    before the receipt existed).
     *  - `unknown`: no receipt and no role rows — never provisioned here, or loaded from a world
     *    that keeps its roles elsewhere and not yet repaired. Nothing to hold the pair against.
     *
     * `held` is the receipt read, so a refusal can name it. Read without migrating, so asking about
     * a foreign scope leaves its DO as empty as it found it.
     */
    private tenantVerdict(tenantId: string): { verdict: TenantVerdict; held: string | null } {
      const held = this.provisionedFor();
      if (held !== null) return { verdict: held === tenantId ? 'recorded' : 'foreign', held };
      if (!this.hasTable('_substrat_roles')) return { verdict: 'unknown', held };
      if (this.sql.exec('SELECT 1 FROM _substrat_roles WHERE tenant_id = ? LIMIT 1', tenantId).toArray().length > 0) {
        return { verdict: 'inferred', held };
      }
      const anyRole = this.sql.exec('SELECT 1 FROM _substrat_roles LIMIT 1').toArray().length > 0;
      return { verdict: anyRole ? 'foreign' : 'unknown', held };
    }

    /**
     * #2016: whether a scope with no receipt and no role rows holds state — rather than being a DO
     * nothing ever provisioned or loaded here. Only such a scope takes its tenant from a lifecycle
     * delivery: recording one in an empty DO would make `servesTenant` answer for a scope this
     * deployment does not hold.
     *
     * Every provision since #1738 writes the receipt itself (that IS the durable provision marker),
     * so this only ever judges a scope from before it, or a load from an older platform. A module
     * with no SQL migrations still leaves spine state, so any of it counts, not migrations alone:
     * applied migrations, scope tuples (its grants, `system:` ones included), events, schedule state.
     */
    private holdsData(): boolean {
      return HOLDS_DATA_TABLES.some(
        (table) => this.hasTable(table) && this.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length > 0,
      );
    }

    /** #1738: the tenant this scope's `provisioned_for` receipt names, or null; read without migrating. */
    private provisionedFor(): string | null {
      return this.hasTable('_substrat_meta') ? this.metaValue(PROVISIONED_FOR_KEY) : null;
    }

    private hasTable(name: string): boolean {
      return this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).toArray().length > 0;
    }

    /** #1705 PR 2: the outbox's insertion mark (`OUTBOX_MARK_SQL`). */
    private outboxMark(): number {
      return Number((this.sql.exec(OUTBOX_MARK_SQL).toArray()[0] as { mark: number } | undefined)?.mark ?? 0);
    }

    /** #1705 PR 2: exported-type rows added above `mark`. */
    private exportedSince(types: readonly string[], mark: number): number {
      const q = exportedSinceQuery(types, mark);
      return Number((this.sql.exec(q.sql, ...q.params).toArray()[0] as { n: number } | undefined)?.n ?? 0);
    }

    /**
     * #1705: apply a batch another vertical exported. The pure adapter's `deliverToPeer`
     * body, on this scope's queue: the compare-and-set on the watermark, a dead letter per
     * importing module for each withheld event, one storage transaction per (event, module)
     * with its journal row, the watermark moved last, then the post-commit tail.
     *
     * The coordinator parses the batch before it gets here and runs the executors after.
     * Executors live on the coordinator here, as they do after an invoke.
     */
    async importApply(
      batch: ImportBatch,
      tenantId: TenantId,
      scopeId: ScopeId,
      /** #2029: the instance the peer door's gate read for the producer; on another, nothing applies. */
      doorInstance?: string,
    ): Promise<ImportResult | SystemDoorMoved> {
      const source = batch.source;
      if (this.peerDoorMoved(source.vertical, doorInstance)) return SYSTEM_DOOR_MOVED;
      await this.ensureMigrations();
      return await this.queue.enqueue(async () => {
        const liveSince = this.liveHighWaterMark();
        const result: ImportResult = emptyImportResult(batch);
        // #1706's door, for a delivery (`operation: null`), inside the queued body: the producer
        // is a declared peer with its switch on, or nothing runs and the edge pauses.
        let peerSubject: CheckSubject;
        try {
          peerSubject = admitPeer(this.switchSql(), this.peers, { vertical: source.vertical, scope: source.scopeId }, null);
        } catch (err) {
          return { ...result, paused: { reason: err instanceof Error ? err.message : String(err) } };
        }
        const current =
          ((this.sql.exec(IMPORT_CURSOR_OF_SQL, source.scopeId).toArray()[0] as { cursor: string } | undefined)
            ?.cursor ?? null);
        if (current !== batch.after) return { ...result, cursor: current as ImportResult['cursor'], stale: true };

        const at = new Date().toISOString();
        const journaled = (id: string, moduleId: string): boolean =>
          this.sql
            .exec('SELECT 1 FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?', id, moduleId)
            .toArray().length > 0;
        const deadLetter = (id: string, moduleId: string, when: string, error: string): void => {
          this.sql.exec(
            `INSERT OR IGNORE INTO _substrat_deliveries
               (event_id, consumer_module, delivered_at, error, invocation_id)
             VALUES (?, ?, ?, ?, NULL)`,
            id,
            moduleId,
            when,
            error,
          );
        };

        // #1901: one line per (event, importing module), as for the scope's own consumers.
        // The handler runs as the producer's peer, so that is who the line says it ran as.
        const lines = asyncLinePass();
        const unitOf = (moduleId: string, eventId: string, eventType: string) => ({
          kind: 'consumer' as const,
          tenantId,
          scopeId,
          invocationId: asyncInvocationId(null),
          operation: moduleId,
          eventType,
          eventId,
          attempt: 1,
          startedAt: Date.now(),
          principalKind: peerSubject.kind,
          versionId: this.env.SUBSTRAT_VERSION_ID ?? null,
        });

        for (const w of batch.withheld) {
          this.sql.exec(IMPORT_RECORD_SQL, w.id, source.scopeId, source.vertical, w.type, w.schemaVersion,
            w.occurredAt, w.entity.entityType, w.entity.entityId, 0, w.reason, at);
          for (const moduleId of this.crossVertical.modulesImporting(source.vertical, w.type)) {
            deadLetter(w.id, moduleId, at, withheldNote(w.reason, source.vertical));
            lines.write({ ...unitOf(moduleId, w.id, w.type), outcome: 'dead-lettered' });
          }
          result.withheld += 1;
        }

        for (const e of batch.events) {
          this.sql.exec(IMPORT_RECORD_SQL, e.id, source.scopeId, source.vertical, e.type, e.schemaVersion,
            e.occurredAt, e.entity.entityType, e.entity.entityId, e.hops, null, at);
          let ran = false;
          for (const imp of this.crossVertical.handlersFor(source.vertical, e.type)) {
            if (journaled(e.id, imp.moduleId)) continue;
            ran = true;
            if (imp.schemaVersion !== e.schemaVersion) {
              deadLetter(e.id, imp.moduleId, at, withheldNote('version', source.vertical));
              lines.write({ ...unitOf(imp.moduleId, e.id, e.type), outcome: 'dead-lettered' });
              result.deadLettered += 1;
              continue;
            }
            const { hops: _hops, ...fact } = e;
            const event: ImportedEvent = structuredClone({ ...fact, source });
            const unit = unitOf(imp.moduleId, e.id, e.type);
            try {
              await this.revision.transaction(async () => {
                // As the producer's principal: real checks against the grants this vertical's
                // `peers` gave it; its emits carry `{ vertical, scope }` and what they passed.
                // What it emits was emitted BECAUSE of the producer's event (#1237).
                await imp.handler(
                  this.importContext(tenantId, scopeId, peerSubject, { causedBy: e.id, invocationId: unit.invocationId }),
                  event,
                );
                this.sql.exec(
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, invocation_id)
                   VALUES (?, ?, ?, NULL)`,
                  e.id,
                  imp.moduleId,
                  new Date().toISOString(),
                );
              });
              result.delivered += 1;
              lines.write({ ...unit, outcome: 'delivered' });
            } catch (err) {
              // Dead-letter (v0), outside the rolled-back transaction.
              deadLetter(e.id, imp.moduleId, new Date().toISOString(), String(err));
              result.deadLettered += 1;
              lines.write({ ...unit, outcome: 'dead-lettered', error: err });
            }
          }
          if (!ran) result.duplicates += 1;
        }

        this.sql.exec(IMPORT_CURSOR_ADVANCE_SQL, source.scopeId, source.vertical, batch.next, at);
        result.cursor = batch.next;
        lines.end();
        await this.settleCommitted(tenantId, scopeId, liveSince, null);
        return result;
      });
    }

    /**
     * #1705: the context an import handler runs in: the peer door's subject, as the invoke path
     * passes it (#1706). `principal` is a placeholder that the subject never reads, and there is
     * no operation, so the emitted rows' `operation` is NULL, as it is for any consumer.
     */
    /** A module consumer's context: the system override, and the delivery it runs for (#2055). */
    private consumerContext(tenantId: TenantId, scopeId: ScopeId, moduleId: string, delivery: ConsumerDelivery): OperationContext {
      return this.operationContext(
        this.systemPrincipal,
        tenantId,
        scopeId,
        { system: moduleId },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        delivery,
      );
    }

    private importContext(
      tenantId: TenantId,
      scopeId: ScopeId,
      peerSubject: CheckSubject,
      delivery: ConsumerDelivery,
    ): OperationContext {
      return this.operationContext(
        principalId.parse(ulid()),
        tenantId,
        scopeId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        peerSubject,
        delivery,
      );
    }

    async markEventsDrained(eventIds: readonly string[], at: string): Promise<number> {
      if (eventIds.length === 0) return 0;
      return await this.queue.enqueue(() => {
        // Counted BEFORE the stamps, not from the cursors after them. `rowsWritten`
        // is what workerd physically wrote, INDEX entries included, so stamping two
        // rows reports four once `_substrat_outbox_drained` exists — a receipt built
        // on it would claim twice the egress it performed, and would drift again
        // with any future index. The queue has this scope to itself, so a count
        // taken here is the count the loop below goes on to change.
        //
        // The ids travel as ONE JSON array (#1776): a DO binds at most 100 parameters, and a
        // drain batch is 200 by default, so one `?` per id failed every default drain. `IN` over
        // a subquery is a set test, as the list was, so a repeated id is still counted once.
        const drained = (
          this.sql
            .exec(
              `SELECT COUNT(*) AS c FROM _substrat_outbox
                WHERE drained_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
              JSON.stringify(eventIds),
            )
            .toArray()[0] as { c: number }
        ).c;
        for (const id of eventIds) {
          // Only an UNDRAINED row is stamped, so a replayed batch cannot move an
          // earlier drain's timestamp forward and misreport when it shipped.
          this.sql.exec(
            `UPDATE _substrat_outbox SET drained_at = ? WHERE id = ? AND drained_at IS NULL`,
            at,
            id,
          );
        }
        return drained;
      });
    }

    /**
     * Reopen rows stamped strictly before `drainedBefore`, so the drain ships them again
     * (#1334). The kernel contract says why the instant is required; this is the mechanism.
     *
     * Counted BEFORE the update, on `markEventsDrained`'s reasoning: `rowsWritten` includes
     * index entries, and `_substrat_outbox_drained` leads with `drained_at`, so clearing N
     * rows reports more than N writes. The queue has this scope to itself, so the count
     * taken here is the count the update goes on to change.
     *
     * BOUNDED at `REDRAIN_BATCH`, and the caller loops until this returns 0. The outbox is
     * never pruned, so "every stamped row before an instant" grows with the scope's whole
     * lifetime — and this runs inside ONE Durable Object request, against a fixed budget.
     * Unbounded, a big enough scope would exceed it, and exceed it again on every retry, so
     * the one scope that most needs reopening could never make progress. Oldest first, so a
     * partial run leaves a prefix of the window rather than holes scattered through it.
     */
    async redrainEvents(drainedBefore: string): Promise<number> {
      return await this.queue.enqueue(() => {
        // The batch is chosen by ONE subquery, written once, that both statements read. It
        // used to be chosen as a list of ids bound back one `?` each, which a DO refuses past
        // 100 parameters (#1776) while the batch is 5000. The two statements run in the same
        // synchronous turn, so nothing writes between them, and `ORDER BY id` over the primary
        // key makes the LIMIT pick the same rows twice: the count is the rows the update clears.
        const batch = `SELECT id FROM _substrat_outbox
                        WHERE drained_at IS NOT NULL AND drained_at < ?
                        ORDER BY id LIMIT ?`;
        const reopened = (
          this.sql.exec(`SELECT COUNT(*) AS c FROM (${batch})`, drainedBefore, REDRAIN_BATCH).toArray()[0] as {
            c: number;
          }
        ).c;
        if (reopened === 0) return 0;
        this.sql.exec(
          `UPDATE _substrat_outbox SET drained_at = NULL WHERE id IN (${batch})`,
          drainedBefore,
          REDRAIN_BATCH,
        );
        return reopened;
      });
    }

    /**
     * How many rows `redrainEvents` WOULD reopen for the same instant (#1545), reopening
     * none of them. A separate verb rather than a flag on the one above, deliberately: the
     * two answers are indistinguishable once they are numbers, so the caller that asks for
     * a count must not be able to reach the reopen by losing an argument on the way.
     *
     * UNBOUNDED where the reopen is batched. The batch exists because an UPDATE over the
     * whole window rewrites every row and its index entries inside ONE Durable Object
     * request, against a fixed budget. An aggregate materialises no rows, so that budget is
     * not the binding constraint — and a partial count would be worse than useless: the
     * number is the whole point, and "5000, or possibly more" answers nothing.
     */
    async redrainCount(drainedBefore: string): Promise<number> {
      return (
        this.sql
          .exec(
            `SELECT COUNT(*) AS c FROM _substrat_outbox
              WHERE drained_at IS NOT NULL AND drained_at < ?`,
            drainedBefore,
          )
          .toArray()[0] as { c: number }
      ).c;
    }

    /**
     * Facet this scope's own outbox (#1239) — `facetEvents`, which is the
     * sanctioned read: an erased payload yields the same NULL a missing field
     * does, and only the helper keeps them apart.
     */
    facetEvents(input: EventFacetInput): EventFacetResult {
      return facetEvents({ sql: doScopedSql(this.sql) }, input);
    }

    /**
     * One record's event history (#1235) — `readHistory` over this scope's own
     * outbox, which is the sanctioned read and the only one that decodes the
     * envelope's nullable facts correctly (an erased payload, an unrecorded
     * authorization chain, nobody impersonating). A hand-rolled SELECT here would
     * read each of those as missing data, which is the whole reason the helper
     * exists.
     */
    entityHistory(input: {
      entityType: string;
      entityId: string;
      limit?: number;
      cursor?: string;
    }): Page<HistoryEntry> {
      return readHistory(
        { sql: doScopedSql(this.sql) },
        { entityType: input.entityType, entityId: input.entityId },
        { limit: input.limit, cursor: input.cursor },
      );
    }

    /**
     * #1237: walk one event's causal chain backwards, inside the DO where the outbox
     * lives. The kernel helper owns every judgement — most of all that a null cause
     * WITH an operation is the beginning of the chain while a null cause without one
     * is the trail running out.
     */
    eventCause(input: { eventId: EventId; maxDepth?: number }): CauseChain {
      return walkEventCause({ sql: doScopedSql(this.sql) }, input.eventId, input.maxDepth);
    }

    /** #1237 forward: what one event set off, inside the DO where the outbox lives. */
    eventEffects(input: { eventId: EventId; maxNodes?: number }): EffectsTree {
      return walkEventEffects({ sql: doScopedSql(this.sql) }, input.eventId, input.maxNodes);
    }

    /** #1237: everything one call emitted, inside the DO where the outbox lives. */
    invocationEvents(input: { invocationId: string; limit?: number }): InvocationEvents {
      return readInvocation({ sql: doScopedSql(this.sql) }, input.invocationId, input.limit);
    }

    /** #1525: every delivery in this scope that gave up, inside the DO where both tables live. */
    deadLetters(input: { limit?: number; cursor?: string }): Page<DeadLetter> {
      return readDeadLetters({ sql: doScopedSql(this.sql) }, { limit: input.limit, cursor: input.cursor });
    }

    /** #1744: one entity's lifecycle replayed over this scope's outbox, where it lives. */
    lifecycleFlow(input: LifecycleFlowInput): LifecycleFlowResult {
      return readLifecycleFlow({ sql: doScopedSql(this.sql) }, input);
    }

    /** #1750: business volumes per bucket, counted over this scope's outbox. */
    operationSeries(input: OperationSeriesInput): OperationSeriesResult {
      return readOperationSeries({ sql: doScopedSql(this.sql) }, input);
    }

    migrationBookmarks(limit = 20): { bookmark: string; takenAt: string; pending: string[] }[] {
      return this.sql
        .exec(
          `SELECT bookmark, taken_at, pending FROM _substrat_migration_bookmarks
            ORDER BY taken_at DESC LIMIT ?`,
          limit,
        )
        .toArray()
        .map((r) => ({
          bookmark: r.bookmark as string,
          takenAt: r.taken_at as string,
          pending: JSON.parse((r.pending as string) ?? '[]') as string[],
        }));
    }

    /**
     * Rewind this scope's ENTIRE storage — schema and data — to a bookmark (#286's
     * backout). The honest caveat travels in the refusals: PITR restores everything,
     * so every write since the bookmark is discarded. Without `force` the bookmark
     * must be one this scope recorded before a migration and younger than 24h — the
     * first-hours backout window where "nothing happened since" is plausible; later
     * regret belongs to #278's considered restore path. `force` admits any bookmark
     * Cloudflare still holds (30 days), for a staff `getBookmarkForTime` flow.
     *
     * The restore completes on restart: the DO aborts shortly after answering, and
     * the next request finds the storage as it was at the bookmark.
     */
    async rewindToBookmark(
      bookmark: string,
      opts?: { force?: boolean },
    ): Promise<{ rewindingTo: string; instance: string }> {
      const storage = this.ctx.storage as unknown as {
        onNextSessionRestoreBookmark?: (b: string) => Promise<string>;
      };
      if (typeof storage.onNextSessionRestoreBookmark !== 'function') {
        throw new Error(`${REWIND_REFUSED}point-in-time rewind is not available on this host (PITR is production-plane only)`);
      }
      const row = this.sql
        .exec('SELECT taken_at FROM _substrat_migration_bookmarks WHERE bookmark = ?', bookmark)
        .toArray()[0] as { taken_at: string } | undefined;
      if (!opts?.force) {
        if (!row) {
          throw new Error(
            `${REWIND_REFUSED}unknown bookmark — not one this scope recorded before a migration ` +
              '(force admits any bookmark Cloudflare holds)',
          );
        }
        const ageMs = Date.now() - Date.parse(row.taken_at);
        if (ageMs > 24 * 60 * 60 * 1000) {
          throw new Error(
            `${REWIND_REFUSED}bookmark is ${Math.round(ageMs / 3_600_000)}h old — rewinding discards EVERY write since; ` +
              `use the backup restore path (#278), or force if the loss is intended`,
          );
        }
      }
      // #1819: arming from BEFORE the call, so a probe that lands while it is in flight answers
      // armed. Left set if the call throws: that is not a refusal, and it may have armed.
      this.rewindArming = true;
      const confirmed = await storage.onNextSessionRestoreBookmark(bookmark);
      // #1819: from here, everything this instance writes is discarded at the restart.
      this.rewindArmed = true;
      // Answer first, then restart to complete the restore — an immediate abort
      // would take the RPC response down with it.
      setTimeout(() => this.ctx.abort(), 100);
      // #1819: which instance is doomed, so the host can tell a switch move made here from one
      // made on the restored storage after the restart.
      return { rewindingTo: confirmed ?? bookmark, instance: this.instanceId };
    }

    /**
     * The scope's live `connection:<id>` grant tuples (#726 gap 1) — the read half of
     * the delivery `applyProjection` and `writeTuple` make.
     *
     * Read from the same rows the checker walks, so the answer is what would actually be
     * enforced HERE rather than what the directory believes was delivered. Tombstoned
     * (K-21) and expired tuples are excluded: neither is enforced, and reporting either
     * would make this read worse than none.
     */
    async listConnectionGrants(now: string): Promise<ConnectionGrantTupleRow[]> {
      return this.queue.enqueue(() => {
        // BOTH stores, because a scope check consults both: rule 2 inheritance makes a
        // tenant-level grant enforceable here exactly as a scope-level one is, and the
        // projected `_substrat_tenant_tuples` is where this DO holds them. A read-back
        // that disagreed with enforcement would be worse than none. GLOB, not LIKE (#1869):
        // case-sensitive, as the checker's match is.
        const rows = [
          ...(this.sql
            .exec(
              `SELECT subject, relation, expires_at FROM _substrat_tuples
               WHERE subject GLOB 'connection:*' AND relation GLOB 'granted:*'
                 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
              now,
            )
            .toArray() as unknown as ConnectionGrantTupleRow[]),
          ...(this.sql
            .exec(
              `SELECT subject, relation, expires_at FROM _substrat_tenant_tuples
               WHERE subject GLOB 'connection:*' AND relation GLOB 'granted:*'
                 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
              now,
            )
            .toArray() as unknown as ConnectionGrantTupleRow[]),
        ];
        return rows.sort(
          (a, b) => a.subject.localeCompare(b.subject) || a.relation.localeCompare(b.relation),
        );
      });
    }

    /**
     * Admin scope-tuple write (role assignment / grant scoped to this scope) — the
     * EXPLICIT grant. `INSERT OR REPLACE`, so it clears a tombstone: a re-grant grants.
     * Provisioning does not come through here; it seats with `seatTuple` (#1659).
     */
    async writeTuple(
      subject: string,
      relation: string,
      object: string,
      expiresAt: string | null,
    ): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?)`,
          subject,
          relation,
          object,
          expiresAt,
        );
      });
    }

    /**
     * Provisioning's scope-tuple write (#1659): create the row if it is missing, follow the
     * platform's expiry if it is live, and leave it alone if it was revoked — so a re-run
     * provision cannot undo an operator's revoke — and seat nothing at all for a module
     * whose schedule kill switch is off (#1666). `seatScopeTuple` is the statement, shared
     * with `applyProjection`'s `scopeTuples` and with the pure adapter.
     */
    async seatTuple(
      subject: string,
      relation: string,
      object: string,
      expiresAt: string | null,
    ): Promise<void> {
      await this.queue.enqueue(() => {
        const seat = seatScopeTuple(subject, relation, object, expiresAt);
        this.sql.exec(seat.sql, ...seat.params);
      });
    }

    /**
     * Provisioning's seat of many tuples as ONE unit, then the directory's recorded-off
     * modules switched off in it (#1742) — the CP-full mirror of what `applyProjection` does
     * for a CP-less provision. One tuple per `seatTuple` call left a window between the seat
     * and the re-assert in which a sweep could run the grants just seated.
     */
    async seatTuples(
      tuples: { subject: string; relation: string; object: string; expires_at: string | null }[],
      switchOff?: RecordedOffCarry & { scopeId: string; at: string },
    ): Promise<SwitchedOff[]> {
      return this.queue.enqueue(() =>
        this.revision.transactionSync(() => {
          for (const t of tuples) {
            const seat = seatScopeTuple(t.subject, t.relation, t.object, t.expires_at);
            this.sql.exec(seat.sql, ...seat.params);
          }
          return switchOff ? switchRecordedOff(this.switchSql(), switchOff) : [];
        }),
      );
    }

    /** A declared entity-grant shape's grant to one person on one entity (#2071), as ONE unit. */
    async grantEntityShape(principal: PrincipalId, entity: EntityRef, permissions: readonly string[]): Promise<void> {
      await this.queue.enqueue(() =>
        this.revision.transactionSync(() => grantEntityShapeIn(this.switchSql(), principal, entity, permissions)),
      );
    }

    /**
     * One bounded pass of a declared shape's reconcile (#2071), with its events, in ONE
     * transaction: how many it topped up, and whether the scope is done.
     */
    async topUpEntityGrantShapes(
      tenantId: string,
      scopeId: string,
      shapes: readonly EntityGrantShape[],
      limit: number,
    ): Promise<{ toppedUp: number; done: boolean }> {
      return this.queue.enqueue(() =>
        this.revision.transactionSync(() =>
          topUpEntityGrantShapes(this.switchSql(), {
            tenantId,
            scopeId,
            shapes,
            now: new Date().toISOString(),
            limit,
            mintEventId: (ms) => this.mintEventId(ms),
            version: this.env.SUBSTRAT_VERSION_ID ?? null,
          }),
        ),
      );
    }

    /**
     * The dispatch capability's admission (#726 remedy B): this delivery may read the
     * attachments of the entity its own spine row names, and no others.
     *
     * Refuses an unknown event id rather than falling through to a permission check —
     * "we could not resolve the delivery" must never widen into "so check the grant
     * instead", which is how a narrowing becomes a no-op.
     */
    private admitByDelivery(eventId: string, record: AttachmentRecord): void {
      const row = this.sql
        .exec(
          'SELECT entity_type, entity_id FROM _substrat_outbox WHERE id = ?',
          eventId,
        )
        .toArray()[0] as { entity_type: string; entity_id: string } | undefined;
      if (!row) {
        throw new PermissionDenied(
          `attachment ${record.id}: delivery ${eventId} is not an event of this scope, so ` +
            `it carries no authority to read anything here`,
        );
      }
      if (row.entity_type !== record.entity.entityType || row.entity_id !== record.entity.entityId) {
        throw new PermissionDenied(
          `attachment ${record.id} belongs to ${record.entity.entityType}/${record.entity.entityId}, ` +
            `and this delivery is for ${row.entity_type}/${row.entity_id} — a connector may read ` +
            `the attachments of the entity its event names, and no others`,
        );
      }
    }

    /** Does `subject` hold a role this scope can expand (#1665)? The #1659 lockout predicate
     *  narrowed to one holder: a live role tuple, scope or tenant level, for a current role. */
    async hasEffectiveRoleGrantFor(tenantId: string, subject: string): Promise<boolean> {
      const q = effectiveRoleGrantQuery(tenantId, new Date().toISOString(), subject);
      const row = this.sql.exec(q.sql, ...q.params).toArray()[0] as { effective: number } | undefined;
      return row?.effective === 1;
    }

    /** Tombstone a scope tuple (K-21) — the row stays, the walk skips it. Returns
     *  whether anything changed so a repeat revoke is a silent no-op. */
    async revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean> {
      return this.queue.enqueue(() => {
        const before = this.sql
          .exec(
            `SELECT 1 FROM _substrat_tuples
             WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
            subject,
            relation,
            object,
          )
          .toArray();
        if (before.length === 0) return false;
        this.sql.exec(
          `UPDATE _substrat_tuples SET revoked_at = ?
           WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
          at,
          subject,
          relation,
          object,
        );
        return true;
      });
    }

    async invoke(
      operation: string,
      input: unknown,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      /**
       * Set when the caller is a CONNECTION rather than a person (#97). The
       * coordinator has already checked that the connection is live and matches
       * this scope's tenant and vertical; the DO uses it for the permission
       * subject and the event actor, so those two can never disagree.
       */
      connectionId?: string,
      /**
       * The SKU the operation's module requires (#304), passed by the coordinator from its
       * `operationEntitlement` map. Enforced HERE only for a scope-local (hosted) scope,
       * where the control plane is unreachable by the sandbox contract and the projected
       * entitlements are the source of truth. A console-managed scope is gated on the
       * coordinator against the shared CP, so this is left undefined / a no-op there.
       * Also undefined for a module's own declared schedule through the system door
       * (#1654): the coordinator resolves the key with the kernel's `requiredEntitlementFor`,
       * which exempts exactly that invoke, so the DO enforces whatever it is handed.
       */
      requiredEntitlement?: string,
      /**
       * Set when the caller is a MODULE acting on a timer (#383) — the scheduler's
       * subject. Like `connectionId` it is not a person: the DO uses it for the
       * permission subject (`system:<moduleId>` grants) and the event actor
       * (`{ system: <moduleId> }`), and `ctx.check` resolves it normally — no
       * override bypass. Mutually exclusive with `connectionId`.
       */
      systemModuleId?: string,
      /**
       * #113 phase 3: return failures as a VALUE instead of throwing them.
       *
       * Opt-in, and that is what makes it safe to deploy. A coordinator running new
       * code sets it; a ScopeDO instance still running OLD code simply ignores an extra
       * argument and throws exactly as it always did, which the coordinator still
       * handles. The reverse skew — old coordinator, new DO — cannot silently swallow
       * an error either, because without this flag the DO throws. No flag day, and no
       * window where a failure reads as a success.
       */
      failureEnvelope?: boolean,
      /**
       * #129: request preconditions, evaluated inside the operation's transaction.
       *
       * Unlike every other argument added to this RPC, silently ignoring this one
       * would fail OPEN — the write commits with nothing compared. The reply
       * therefore carries `concurrency.ifMatchChecked`, and a coordinator that
       * sent an `If-Match` and does not see it refuses the success. An old DO
       * cannot set the acknowledgement, which is exactly how the skew is caught.
       */
      invokeOptions?: InvokeOptions,
      /**
       * K-42: the session this call runs under, resolved by the coordinator from
       * the directory (which this DO cannot read) and passed WHOLE rather than as
       * an id. The coordinator has already checked it is live, unexpired and for
       * this scope; the DO uses it for the two-actor stamp and for the read-only
       * bound, and nothing here can be reached without it having been minted.
       */
      impersonation?: ImpersonationSession,
      /**
       * #1672: the HASH of a capability session token — the coordinator hashed the token
       * and the plaintext never crosses. Resolved to its capability INSIDE the queued body,
       * on every call, so a revoke between two calls refuses the second. `principal` is
       * then a random placeholder that holds nothing, and the reply carries
       * `capability.honoured`: an old DO that ignored this argument would run the call as
       * that placeholder, and the coordinator refuses a success without the acknowledgement.
       */
      capabilitySession?: string,
      /**
       * #1706: set when the caller is ANOTHER VERTICAL of the same tenant — the platform's
       * word for who is calling, carried through the coordinator. Admitted INSIDE the queued
       * body on every call (`admitPeer`: declared, switched on, operation allowlisted).
       * `principal` is then a random placeholder that holds nothing, and the reply carries
       * `vertical.honoured`: an old DO that ignored this argument would run the call as that
       * placeholder, and the coordinator refuses a success without the acknowledgement.
       */
      verticalCaller?: VerticalCaller,
      /**
       * #1834: set on a system-door call — the instance whose state read the door's gate
       * consulted the rewind hold against. On any other instance nothing runs and the answer is
       * `systemDoorMoved` instead, because a PITR restore always restarts this object, so another
       * instance may be rewound storage the gate never saw. The reply carries `systemDoor.honoured`.
       */
      systemDoorInstance?: string,
    ): Promise<{
      result: unknown;
      platformRequests: number;
      failure?: WireFailure;
      concurrency?: { version: string | null; ifMatchChecked: boolean };
      /** K-42: set iff this DO understood `impersonation`. See `invokeOrThrow`. */
      impersonation?: { honoured: boolean };
      /** #1672: set iff this DO understood `capabilitySession`. */
      capability?: { honoured: boolean };
      /** #1706: set iff this DO understood `verticalCaller`. */
      vertical?: { honoured: boolean };
      /** #1834: set iff this DO understood `systemDoorInstance`. */
      systemDoor?: { honoured: boolean };
      /** #1834: the pin missed, so nothing ran — set only by `assertSystemDoor`, never by a failure. */
      systemDoorMoved?: true;
      /** #1705 PR 2: exported-type rows this commit added. Absent means none. */
      exported?: number;
      /**
       * #1746: the events this call itself emitted, when the caller asked (`onEmitted`).
       * Absent from an older DO, which the coordinator reads as "not recorded".
       */
      emitted?: EmittedReport;
    }> {
      if (!failureEnvelope) {
        // Legacy path, byte-for-byte what it was: rewrapped so a non-plain error (a
        // ZodError, whose `message` is a getter) still arrives with its message.
        try {
          return await this.invokeOrThrow(
            operation,
            input,
            principal,
            tenantId,
            scopeId,
            connectionId,
            requiredEntitlement,
            systemModuleId,
            invokeOptions,
            impersonation,
            capabilitySession,
            verticalCaller,
            systemDoorInstance,
          );
        } catch (err) {
          if (err instanceof SystemDoorMovedError) return { result: undefined, platformRequests: 0, ...SYSTEM_DOOR_MOVED };
          throw toRpcError(err);
        }
      }
      try {
        return await this.invokeOrThrow(
          operation,
          input,
          principal,
          tenantId,
          scopeId,
          connectionId,
          requiredEntitlement,
          systemModuleId,
          invokeOptions,
          impersonation,
          capabilitySession,
          verticalCaller,
          systemDoorInstance,
        );
      } catch (err) {
        // #1834: the pin missed — an answer, never a failure an operation could have produced.
        if (err instanceof SystemDoorMovedError) return { result: undefined, platformRequests: 0, ...SYSTEM_DOOR_MOVED };
        // The ONE place the error keeps its structure: flattened here, rebuilt by the
        // coordinator. `toRpcError` is not applied — that exists to make a throw
        // survivable, and this is not a throw.
        return { result: undefined, platformRequests: 0, failure: toWireFailure(err) };
      }
    }

    /** The operation path itself. Throws; `invoke` decides how that reaches the caller. */
    async invokeOrThrow(
      operation: string,
      input: unknown,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
      requiredEntitlement?: string,
      systemModuleId?: string,
      invokeOptions?: InvokeOptions,
      /** K-42: the session, resolved coordinator-side. See `invoke` above. */
      impersonation?: ImpersonationSession,
      /** #1672: a capability session's hash. See `invoke` above. */
      capabilitySession?: string,
      /** #1706: the calling vertical, as the platform named it. See `invoke` above. */
      verticalCaller?: VerticalCaller,
      /** #1834: the instance the system door's gate read. See `invoke` above. */
      systemDoorInstance?: string,
    ): Promise<{
      result: unknown;
      platformRequests: number;
      concurrency?: { version: string | null; ifMatchChecked: boolean };
      idempotency?: { keyHonoured: boolean; replayed: boolean };
      /**
       * K-42: the acknowledgement the coordinator's skew check reads, on the same
       * reasoning as `concurrency.ifMatchChecked` and with a sharper failure. Every
       * other argument added to this RPC has been safe for an old DO to ignore;
       * this one is not. A DO that dropped it would run the operation as the
       * impersonated principal with NO stamp on anything it wrote and NO read-only
       * bound — a support session that looks recorded and is not, which is the one
       * outcome this whole feature exists to prevent.
       */
      impersonation?: { honoured: boolean };
      /** #1672: the acknowledgement for `capabilitySession`, on `impersonation`'s reasoning. */
      capability?: { honoured: boolean };
      /** #1706: the acknowledgement for `verticalCaller`, on the same reasoning. */
      vertical?: { honoured: boolean };
      /** #1834: the acknowledgement for `systemDoorInstance`, on the same reasoning. */
      systemDoor?: { honoured: boolean };
      /** #1705 PR 2: exported-type rows this commit added. Absent means none. */
      exported?: number;
      /**
       * #1746: the events this call itself emitted, when the caller asked (`onEmitted`).
       * Absent from an older DO, which the coordinator reads as "not recorded".
       */
      emitted?: EmittedReport;
    }> {
      await this.ensureMigrations();
      const handler = this.operations.get(operation);
      // `not_found`, not a bare throw (#113): every vertical hand-matched this message
      // to reach a 404, because the platform's own refusals were as untyped as anything
      // else. Naming the code once here is what lets those patterns go.
      if (!handler) throw substratError('not_found', `unknown operation: ${operation}`);
      // #304 entitlement gate, scope-local path: fail closed on the projected view exactly as
      // the coordinator fails closed against the CP. Only active once entitlements have been
      // projected (the `entitlements_enforced` marker) — before that the scope trusts upstream,
      // exactly as it did pre-#304, so a not-yet-back-filled scope is never wrongly denied.
      if (requiredEntitlement && this.permissionSource() === 'local' && this.entitlementsEnforced()) {
        const held = this.sql
          .exec(
            `SELECT 1 FROM _substrat_entitlements
             WHERE tenant_id = ? AND entitlement_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
            tenantId,
            requiredEntitlement,
            new Date().toISOString(),
          )
          .toArray()[0];
        if (!held) {
          // The whole projected set, so the denial names required AND held (#691).
          // Only read on the failure path — the hot path stays the single lookup above.
          const now = new Date().toISOString();
          const all = this.sql
            .exec(
              `SELECT entitlement_key, expires_at FROM _substrat_entitlements
               WHERE tenant_id = ? ORDER BY entitlement_key`,
              tenantId,
            )
            .toArray() as { entitlement_key: string; expires_at: string | null }[];
          throw substratError(
            'not_found',
            entitlementDenial(
              operation,
              requiredEntitlement,
              all.map((r) => ({
                key: r.entitlement_key,
                expired: r.expires_at !== null && r.expires_at <= now,
              })),
            ),
          );
        }
      }
      // #893: parse, don't trust — at the scope door, from the operation's own
      // declaration. Outside the queue and outside the transaction: a malformed
      // call takes no turn and opens nothing. Guards read the parsed input too,
      // so a K-17 pre-condition sees what the handler will.
      const declaredInput = this.operationInput.get(operation);
      const parsed = declaredInput ? declaredInput.parse(input) : input;
      // #129. Refused rather than ignored, for the reason the coordinator refuses an
      // unacknowledged one: a caller sending `If-Match` believes its write is
      // conditional, and a 200 that compared nothing leaves that belief in place.
      const guarded = this.operationConcurrency.get(operation);
      if (invokeOptions?.ifMatch !== undefined && !guarded) {
        throw new Error(
          `${operation} was called with If-Match but declares no \`concurrency\` — ` +
            'nothing would have been compared. Declare it, or drop the header',
        );
      }
      const guardedRef = guarded ? concurrencyRefOf(operation, guarded, parsed) : undefined;
      // #116. Refused rather than ignored, for the reason two paragraphs up: an
      // operation that opted out never records its response, so a caller who sent
      // a key and got a 200 believes a retry is safe when it would execute again.
      const idempotencyKey = invokeOptions?.idempotencyKey;
      if (idempotencyKey !== undefined) {
        if (this.operationIdempotencyOptOut.has(operation)) {
          throw new Error(idempotencyOptedOutMessage(operation));
        }
        assertIdempotencyKey(idempotencyKey);
      }
      // The subject a key is scoped to — the same three-way read `recordDenial`
      // makes below, hoisted because both need it. A key belongs to whoever sent
      // it: two principals choosing `1` must not reach each other's response.
      let idempotencySubjectRef: CheckSubject = systemModuleId
        ? { kind: 'system', id: systemModuleId as ModuleId }
        : connectionId
          ? { kind: 'connection', id: connectionId }
          : { kind: 'principal', id: principal };
      // Fingerprinted from the PARSED input (defaults applied), before the queue:
      // a pure hash of what the caller sent has no business inside a transaction.
      const fingerprint =
        idempotencyKey === undefined ? undefined : await requestFingerprint(operation, parsed);
      // `return await`, not a bare return: the work is QUEUED, and `try { return p }`
      // runs its `finally` when the RETURN executes rather than when `p` settles — so
      // the invocation id was cleared before the queued body had emitted anything.
      return await this.queue.enqueue(async () => {
        // #1237: the invocation this call belongs to, for the duration of it.
        //
        // Set INSIDE the queued body, which is the only region where one call holds the
        // DO to itself. The input gate reopens around every await, and there are two
        // before this point (`ensureMigrations`, `requestFingerprint`) — so assigning at
        // the top of the RPC let a second call overwrite the field while the first was
        // suspended, and the first would then emit under the second's id and clear it on
        // the way out. `OperationQueue` is what makes this a plain field rather than a
        // stack: the bodies do not interleave, so set-and-clear here brackets exactly
        // one call. Same placement as the SQLite adapter's actor task, for this reason.
        this.invocationId = invokeOptions?.invocationId ?? null;
        try {
        // #1834: before anything opens. This instance is the storage the call meets, for the
        // whole call: a restore restarts the object, so it cannot move under a running body.
        const systemDoor = this.assertSystemDoor(systemModuleId, systemDoorInstance);
        // #1672: the capability session, resolved on EVERY call and here — inside the queued
        // body, the one region where this call holds the DO to itself — so nothing can
        // revoke between this read and the transaction. Refuses a stale session, a revoked
        // or expired capability and an operation off its allowlist before anything opens;
        // none of those is a K-35 denial (no key was checked).
        let capabilityId: CapabilityId | undefined;
        if (capabilitySession !== undefined) {
          capabilityId = resolveCapabilitySession(
            doSpineSql(this.sql),
            capabilitySession,
            instant.parse(new Date().toISOString()),
            operation,
          );
          idempotencySubjectRef = { kind: 'capability', id: capabilityId };
        }
        // #1706: the peer door's admission, on the capability door's terms — every call,
        // here, before anything opens. An undeclared peer, a switched-off one and an
        // operation off its allowlist are refused `forbidden`; none is a K-35 denial.
        let peerSubject: CheckSubject | undefined;
        if (verticalCaller !== undefined) {
          // #2029: pinned to the instance the peer door's gate read against the rewind hold.
          this.assertPeerDoor(verticalCaller.vertical, systemDoorInstance);
          peerSubject = admitPeer(this.switchSql(), this.peers, verticalCaller, operation);
          idempotencySubjectRef = peerSubject;
        }
        // #1672: the secrets this call mints — withheld from its idempotency recording, and
        // what the tripwire on its writes looks for.
        const minted: string[] = [];
        /**
         * #938: the outbox's high-water mark BEFORE this call wrote anything, so the
         * post-commit fan-out can name exactly the events this call (and the consumers
         * it set off) added. Read here — inside the queued body, before the
         * transaction — because that is the region where this call holds the DO to
         * itself, the same reason `invocationId` is set here.
         *
         * A socket that connects between here and the fan-out is served whatever this
         * call committed, and one that connects while `null` was decided hears nothing
         * about it. Both are harmless and neither is worth a lock: a frame is an
         * invalidation, so hearing about a change from just before you subscribed costs
         * one redundant re-read, and missing one costs a wait for the client's poll —
         * which is the floor this whole surface sits on.
         */
        const liveSince = this.liveHighWaterMark();
        // #1705 PR 2: the outbox's insertion mark, so the envelope can say whether this
        // invoke (or a consumer in its tail) committed an exported type. Only in a deployment
        // that exports something, and never for a read-only session, which commits nothing.
        const exportTypes = impersonation?.mode === 'read-only' ? [] : this.crossVertical.exportTypes();
        const exportMark = exportTypes.length > 0 ? this.outboxMark() : null;
        // #1746: the same mark, when the caller asked what this call emitted. The callback
        // itself never runs here — its presence is the request, and the report travels
        // back in the envelope for the coordinator to deliver.
        const emittedMark =
          invokeOptions?.onEmitted !== undefined && impersonation?.mode !== 'read-only'
            ? (exportMark ?? this.outboxMark())
            : null;
        let result: unknown;
        let committedVersion: string | null = null;
        // #116: set when this invocation was answered from a recording rather
        // than run. Read after the transaction, where it decides both the
        // envelope's acknowledgement and whether there is anything to dispatch.
        let replayed = false;
        // #458: how many platform intents THIS invoke enqueued. Counted inside the
        // transaction, reported only after commit — a rolled-back intent is no signal.
        // The envelope return (below) is the DO↔coordinator wire for it; both sides
        // live in this package and deploy as one script, so the shape never skews.
        const signals = { platformRequests: 0 };
        /**
         * K-42: how a read-only session is made to BE read-only.
         *
         * Thrown on success, so the transaction never commits — the same
         * mechanism `queryScope`'s console uses, for the same reason: the DO's
         * `exec` exposes no read-only flag, so refusing to commit is the only
         * enforcement that survives a handler writing rows with plain SQL.
         * `ctx.emit` and the other effecting verbs refuse outright as well; that
         * is the half a support engineer sees, this is the half that holds.
         */
        const rollback = new Error('read-only impersonation rollback');
        // The async transaction is the K-4 boundary: guards + handler + emits
        // commit together, or a throw (from either) rolls domain writes AND
        // emitted events back as one — verified across `await` in workerd.
        try {
          await this.revision.transaction(async () => {
            const ctx = this.operationContext(
              principal,
              tenantId,
              scopeId,
              undefined,
              connectionId,
              systemDoor,
              signals,
              impersonation,
              operation,
              capabilityId,
              minted,
              undefined,
              peerSubject,
            );
            // #116: a retry is answered from the recording, and nothing else runs
            // — not the guards, not the handler, not the permission check inside
            // it. Keyed by SUBJECT, so a caller only ever reaches its own
            // responses; `idempotency.ts` states what that does not promise.
            if (idempotencyKey !== undefined && fingerprint !== undefined) {
              const lookup = idempotencyLookupQuery(idempotencySubjectRef, idempotencyKey);
              const prior = this.sql.exec(lookup.sql, ...lookup.params).toArray()[0] as
                | IdempotencyRow
                | undefined;
              if (prior) {
                const replay = replayFor(idempotencyKey, fingerprint, prior);
                result = replay.result;
                // Only a guarded operation may report a tag (#129).
                if (guardedRef) committedVersion = replay.entityVersion;
                replayed = true;
                return;
              }
            }
            // #129: snapshot the version BEFORE the handler, compare AFTER it.
            // Before, because the handler's own `emit` moves it; after, because the
            // permission check lives inside the handler and must answer first — a
            // precondition evaluated ahead of it turns the operation into a version
            // oracle for a principal who may not read the entity at all. The full
            // reasoning is on the pure adapter, which does the identical thing.
            const seen =
              guardedRef && invokeOptions?.ifMatch !== undefined
                ? this.versionAt(guardedRef)
                : undefined;
            await this.runGuards(operation, ctx, parsed);
            result = await (handler as OperationHandler<unknown, unknown>)(ctx, parsed);
            if (guardedRef && invokeOptions?.ifMatch !== undefined) {
              assertIfMatch(guardedRef, invokeOptions.ifMatch, seen ?? null);
            }
            // The tag describes the row as THIS write left it, so it is read after
            // the handler and still inside the transaction.
            if (guardedRef) committedVersion = this.versionAt(guardedRef);
            // #116: recorded INSIDE the transaction, which is what makes a failed
            // request retried rather than replayed — it rolls back with the writes
            // it describes. The prune rides along, on the only path that adds a row.
            if (idempotencyKey !== undefined && fingerprint !== undefined) {
              const at = new Date().toISOString();
              const record = idempotencyRecordStatement(
                idempotencySubjectRef,
                idempotencyKey,
                operation,
                fingerprint,
                // #1672: a replay of a mint returns the placeholder, never the secret.
                redactSecrets(result, minted),
                committedVersion,
                at,
              );
              this.sql.exec(record.sql, ...record.params);
              const prune = idempotencyPruneStatement(at);
              this.sql.exec(prune.sql, ...prune.params);
            }
            if (impersonation?.mode === 'read-only') throw rollback;
          });
        } catch (err) {
          // The read-only unwind, not a failure: `result` was assigned before the
          // throw and is the answer, while every row the handler wrote is gone.
          //
          // The acknowledgements ride along unchanged, because they are about
          // whether this DO UNDERSTOOD the arguments, not about what committed —
          // and a coordinator that sent `If-Match` to a read-only session must not
          // be told the host is too old to have evaluated it. The version reported
          // is the rolled-back one, which is the honest answer: nothing moved.
          if (err === rollback) {
            return {
              result,
              platformRequests: 0,
              impersonation: { honoured: true },
              ...(capabilitySession !== undefined ? { capability: { honoured: true } } : {}),
              ...(verticalCaller !== undefined ? { vertical: { honoured: true } } : {}),
              ...(systemDoorInstance !== undefined ? { systemDoor: { honoured: true } } : {}),
              ...(idempotencyKey !== undefined
                ? { idempotency: { keyHonoured: true, replayed } }
                : {}),
              ...(guardedRef
                ? {
                    concurrency: {
                      version: committedVersion,
                      ifMatchChecked: invokeOptions?.ifMatch !== undefined,
                    },
                  }
                : {}),
            };
          }
          // K-35: the transaction has rolled back; record a refused check now, as its own
          // write (outside that transaction), so the denial survives the rollback.
          if (err instanceof PermissionDenied) {
            this.recordDenial(
              // The subject the call acted as — the capability's, once resolved above.
              idempotencySubjectRef,
              tenantId,
              operation,
              err,
              // Inside the queued body, which is the one region where this call holds
              // the DO to itself — so the field is this call's own (#1237).
              this.invocationId,
              impersonation,
            );
          }
          // #1745: a refused transition, recorded the same way — the rollback took the
          // attempt with it, and nothing else would remember it.
          this.recordRefusal(idempotencySubjectRef, tenantId, scopeId, operation, err, this.invocationId, impersonation);
          // The ORIGINAL error, deliberately: `invoke` flattens it for the envelope
          // (which keeps its code and extensions) or rewraps it for the legacy throw
          // path. Collapsing it here would lose the structure before either can look.
          throw err;
        }
        // Post-commit: drain the outbox to consumers, each delivery its own txn.
        // Skipped on a replay: nothing was written, so there is nothing this
        // invocation added to drain. Anything the ORIGINAL left undrained is the
        // outbox's own retry backstop, which is what that backstop is for.
        // Drain to consumers, then announce what landed (#938). Skipped whole on a
        // replay: nothing was written, so there is nothing this invocation added to
        // drain or to announce. Anything the ORIGINAL left undrained is the outbox's
        // own retry backstop, which is what that backstop is for.
        // #1525: still inside the queued body that set it, so these deliveries are this
        // call's own work — the same tail its consumers' emits are stamped in.
        // #1746: read BEFORE `settleCommitted` drains the consumers, so the rows above the
        // mark are this operation's own emits. A replay committed nothing.
        let emitted: EmittedReport | undefined;
        if (emittedMark !== null && !replayed) {
          const q = emittedSinceQuery(emittedMark, EMITTED_REPORT_CAP);
          emitted = emittedReportOf(this.sql.exec(q.sql, ...q.params).toArray());
        }
        if (!replayed) await this.settleCommitted(tenantId, scopeId, liveSince, this.invocationId);
        // After the tail, so an exported type a consumer emitted in it counts too.
        const exported = exportMark !== null && !replayed ? this.exportedSince(exportTypes, exportMark) : 0;
        return {
          result,
          platformRequests: signals.platformRequests,
          // #1705 PR 2: the coordinator fires `onExportedEvents` from this. Omitted at 0, so
          // the envelope of a deployment that exports nothing is byte-for-byte what it was.
          ...(exported > 0 ? { exported } : {}),
          ...(emitted ? { emitted } : {}),
          ...(impersonation ? { impersonation: { honoured: true } } : {}),
          // #1672: the acknowledgement the coordinator's skew check reads — see `invoke`.
          ...(capabilitySession !== undefined ? { capability: { honoured: true } } : {}),
          // #1706: the same, for the peer door.
          ...(verticalCaller !== undefined ? { vertical: { honoured: true } } : {}),
          // #1834: the same, for the system door's instance pin.
          ...(systemDoorInstance !== undefined ? { systemDoor: { honoured: true } } : {}),
          // The acknowledgement the coordinator's skew check reads (#116), on the
          // same reasoning as `ifMatchChecked` below and with a sharper failure: a
          // DO too old to know about keys would EXECUTE THE OPERATION AGAIN and
          // return 200, which is the duplicate the header was sent to prevent.
          ...(idempotencyKey !== undefined
            ? { idempotency: { keyHonoured: true, replayed } }
            : {}),
          // The acknowledgement the coordinator's skew check reads. Present only
          // for a guarded operation, so an unguarded one costs nothing.
          ...(guardedRef
            ? {
                concurrency: {
                  version: committedVersion,
                  ifMatchChecked: invokeOptions?.ifMatch !== undefined,
                },
              }
            : {}),
        };
        } finally {
          // Cleared on BOTH paths. The DO outlives the request, so a value left set here
          // is read by whatever runs next — an alarm-driven drain, a consumer retry —
          // and stamps its events with a call they had nothing to do with. A wrong
          // recorded fact, which is worse than the honest NULL this column uses.
          this.invocationId = null;
        }
      });
    }

    // -- live reads (#938): the subscription half of the change feed ------------
    // The ONLY part of this DO addressed as a fetch target rather than over RPC, and
    // only because a WebSocket cannot cross RPC — a socket is not serializable, so the
    // one way to hand one back is a `Response` carrying a `webSocket`. Everything the
    // coordinator asserts on the way in is named in `live-reads.ts`, shared with
    // `host.ts` so the two ends cannot drift.

    /**
     * Accept a subscription to this scope's changes.
     *
     * The coordinator has already decided that this connection can carry a push at all
     * (the O2O check) and WHO is asking. What is decided here is nothing about
     * authority: a subscription is not an authorization, and accepting one grants the
     * subscriber no read it did not already have. Every frame is checked on its way
     * out, individually, against the tuple state at that moment — so a grant revoked
     * while the socket is open stops the frames it used to allow, which a
     * subscription-time check would not.
     *
     * **This adds no authority to a holder of the stub, and the question is worth
     * answering rather than leaving to be asked.** Being a public method, anything with
     * the `SCOPE` binding can call it and assert whatever principal it likes in the
     * headers. That is already true of `invoke`, which takes the principal as an
     * argument and acts on it: a stub is the key to the scope, which is precisely why
     * the router is not given one. The trust boundary is who holds the binding, not
     * what this method checks — and what it does NOT do is let a stub-holder read
     * anything the asserted principal could not, because the filter downstream re-checks
     * that principal against every frame.
     */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== LIVE_SUBSCRIBE_PATH) {
        // The DO has exactly one fetch surface. Anything else reaching here is a
        // coordinator bug, and a 404 says so without guessing at an intent.
        return new Response('this scope has no such surface', { status: 404 });
      }
      if (!isUpgradeRequest(request)) {
        return new Response('live reads are a WebSocket surface', {
          status: 426,
          headers: { [LIVE_MODE_HEADER]: 'not-an-upgrade' satisfies LiveRefusal },
        });
      }
      const principal = request.headers.get(LIVE_PRINCIPAL_HEADER);
      const tenantId = request.headers.get(LIVE_TENANT_HEADER);
      const scopeId = request.headers.get(LIVE_SCOPE_HEADER);
      if (!principal || !tenantId || !scopeId) {
        // Fail closed and loudly. An unnamed subscriber is one whose permissions
        // cannot be evaluated, and the only safe thing to do with a channel we cannot
        // filter is to refuse to open it. 500, not 400: the caller is the coordinator
        // in this same package, so a missing assertion is OUR bug, not the client's.
        return new Response('live reads require an asserted principal, tenant and scope', {
          status: 500,
        });
      }
      // A narrowing the coordinator sent but this end cannot read is refused, never
      // dropped: dropping it would open the whole scope's feed — to a vouched
      // subscriber, one the principal's check was never going to filter (#1853).
      const withinHeader = request.headers.get(LIVE_WITHIN_HEADER);
      const within = withinHeader === null ? undefined : decodeLiveWithin(withinHeader);
      if (withinHeader !== null && !within) {
        return new Response('live reads: unreadable within narrowing', { status: 500 });
      }
      // The same for an expiry: dropping it would keep the socket open past its session.
      const expiresHeader = request.headers.get(LIVE_EXPIRES_HEADER);
      const expiresAt = expiresHeader === null ? undefined : liveInstant(expiresHeader);
      if (expiresHeader !== null && !expiresAt) {
        return new Response('live reads: unreadable expiry', { status: 500 });
      }
      // A subscriber arriving before the scope's migrations have run would be told
      // about events against a schema it cannot read back through. Same gate every
      // other entry point takes, for the same reason.
      await this.ensureMigrations();
      // `.parse`, not a cast: these three arrived as header strings, and the branded
      // ids are what every check downstream is keyed on. A malformed one would
      // otherwise be carried all the way to a `ctx.check` that quietly matches nothing —
      // which reads as "this subscriber may see nothing" and is indistinguishable from
      // a correct denial. Refused here instead, where it is still one subscriber's
      // problem. Throwing is right: the coordinator built this request.
      const subscriber = {
        principal: principalId.parse(principal),
        tenantId: tenantIdOf.parse(tenantId),
        scopeId: scopeIdOf.parse(scopeId),
      };
      // A checked root (#938) is gated here as well as on every pass: a subscriber who may
      // not watch it gets no socket at all, so its client meets a refusal rather than a
      // feed that would close on the first thing it had to say. A session already over is
      // refused the same way.
      const expired = expiresAt !== undefined && expiresAt <= new Date().toISOString();
      if (
        expired ||
        (within?.checked !== undefined && !(await this.mayWatchRoot(() => this.liveContext(subscriber), within)))
      ) {
        return new Response('live reads: the subscriber may not watch this root', {
          status: 403,
          headers: { [LIVE_MODE_HEADER]: 'forbidden' satisfies LiveRefusal },
        });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      /**
       * At most `LIVE_SOCKETS_PER_PRINCIPAL` sockets per principal on this scope (#938):
       * each is work on every post-commit pass. The extra one is accepted and closed at
       * once with `4429`, rather than refused with a status, because a browser never sees
       * a failed handshake's status — only a close code, which the client reads as "poll
       * and stop asking". Not hibernated, so it never joins the roster the fan-out walks.
       *
       * Counted over the sockets still live: one whose session has ended is closed here
       * first, so sockets that expired on an idle scope never hold a fresh session out.
       */
      const held = this.reapExpiredLive().filter((s) => s.principal === subscriber.principal).length;
      if (held >= LIVE_SOCKETS_PER_PRINCIPAL) {
        server.accept();
        server.close(LIVE_CLOSE.tooMany, 'too many live subscriptions for this principal; poll instead');
        return new Response(null, { status: 101, webSocket: client });
      }
      // HIBERNATABLE, not `server.accept()`. A scope with a watcher open would
      // otherwise be pinned in memory for as long as somebody has a tab open, which is
      // the cost model inverted: a support desk being WATCHED is the normal state.
      // Hibernation also fixes the worse half — an in-memory roster does not survive
      // eviction, so the socket would stay open and silently stop receiving, which is
      // indistinguishable from a quiet scope.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        ...subscriber,
        since: new Date().toISOString(),
        ...(within ? { within } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      } satisfies LiveSubscription);
      if (expiresAt) await this.armLiveExpiry();
      return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Close every live socket whose session has ended (`1008`), and return the
     * subscriptions still open (#938). Reads only the sockets' own attachments, never the
     * database, so it is as cheap on a scope nobody writes to as on a busy one.
     */
    private reapExpiredLive(now = new Date().toISOString()): LiveSubscription[] {
      const live: LiveSubscription[] = [];
      for (const ws of this.ctx.getWebSockets()) {
        let s: LiveSubscription | null = null;
        try {
          s = readSubscription(ws.deserializeAttachment());
        } catch {
          s = null;
        }
        if (!s) continue;
        if (s.expiresAt !== undefined && s.expiresAt <= now) {
          closeSessionEnded(ws);
          continue;
        }
        live.push(s);
      }
      return live;
    }

    /**
     * Arm the scope's alarm for the earliest session end among its live sockets (#938), so
     * an expired socket is closed on a scope nobody writes to — the fan-out closes them
     * too, but only on a pass, and an idle scope has none.
     *
     * Only ever moved EARLIER: an alarm already set before that instant is kept, and the
     * handler re-arms for whatever is next. Re-arming on a close is not needed: an alarm
     * that finds the socket already gone simply arms for the next one, or for nothing.
     *
     * The live reaper is this DO's only alarm use. A second one must share `alarm()` and
     * this "earliest wins" rule, not call `setAlarm` on its own. The alarm makes workerd
     * keep a `_cf_METADATA` table in the scope's SQLite; every table walk here skips
     * `_cf_*` for that reason (`exportDump`, `importDump`, `introspectTables`).
     */
    private async armLiveExpiry(): Promise<void> {
      let earliest: string | undefined;
      for (const s of this.reapExpiredLive()) {
        if (s.expiresAt !== undefined && (earliest === undefined || s.expiresAt < earliest)) earliest = s.expiresAt;
      }
      if (earliest === undefined) return;
      const at = Date.parse(earliest);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    }

    /** The live reaper's alarm (#938): close what has expired, then arm for what is next. */
    async alarm(): Promise<void> {
      await this.armLiveExpiry();
    }

    /** The context a live subscriber's checks run in: its own principal, under `live.subscribe`. */
    private liveContext(subscriber: { principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId }): OperationContext {
      return this.operationContext(
        subscriber.principal,
        subscriber.tenantId,
        subscriber.scopeId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'live.subscribe',
      );
    }

    /**
     * May this subscriber watch its `checkedWithin` root (#938)? Its own `ctx.check` of the
     * stated key on the root, the same walk a read of the root would make. A check that
     * throws is a refusal: an outage in the permission path must not become a feed.
     */
    private async mayWatchRoot(context: () => OperationContext, within: LiveWithin): Promise<boolean> {
      try {
        // Built inside the try: a context that cannot be built is a refusal too.
        const decision = await context().check(within.checked as PermissionKey, {
          entityType: within.entityType,
          entityId: within.entityId,
        });
        return decision.allowed;
      } catch {
        return false;
      }
    }

    /**
     * A subscriber said something.
     *
     * The channel is one-way by design — the server announces, the client re-reads
     * through the ordinary operation — so there is no client message that can cause a
     * read, a write, or a change of subscription. `ping`/`pong` is the whole protocol,
     * and it exists so an idle connection can be kept alive by either end.
     *
     * Deliberately NOT a place to let a client narrow or widen what it receives: a
     * filter the client chooses is a filter the client can choose wrongly, and the
     * only filter that matters here is the one it does not control.
     *
     * #1860: an exact `'ping'` is now answered by `setWebSocketAutoResponse` in the
     * constructor, at the runtime level, without waking this object — so this branch no
     * longer runs for it. Kept as the documented fallback for a client on an older
     * build, or a hop where the runtime's auto-response is unavailable.
     */
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
      this.webSocketMessagesHandled++;
      // Ungated, and safe to be: the reply is the constant `'pong'` and carries no event, no
      // entity and no time, so it tells the socket nothing it did not already know. Every
      // frame that is about the scope's data goes out through `fanOutLive`'s gates instead.
      if (message === 'ping') ws.send('pong');
    }

    /**
     * The client hung up. Close our end so the runtime stops holding the subscription.
     *
     * The runtime passes `reason` and `wasClean` too; neither is read, so neither is
     * named — there is nothing to do differently for an unclean close, because the
     * socket is going away either way and the client's poll is what covers the gap.
     */
    webSocketClose(ws: WebSocket, code: number): void {
      // 1006 is reserved: it is what the runtime REPORTS for an abnormal closure and
      // is not a code anything may SEND, so echoing it back throws — on precisely the
      // path where the connection is already in trouble.
      try {
        ws.close(code === 1006 ? 1000 : code, 'scope closing the subscription');
      } catch {
        // Already gone. Nothing to do, and nothing worth reporting.
      }
    }

    /**
     * A socket failed. Logged and not rethrown: there is no caller to fail, and the
     * runtime delivers `webSocketClose` after this, which is what does the cleanup.
     */
    webSocketError(_ws: WebSocket, error: unknown): void {
      console.error('substrat: live-read socket error', error);
    }

    /**
     * The outbox's high-water mark before a committing path runs (#938), or `null`
     * when nobody is listening.
     *
     * `null` and `''` are different answers: `null` means no subscriber, so nothing is
     * read at all and a scope pays nothing for a feature it is not using; `''` is the
     * honest empty-outbox answer, and every ULID sorts above it.
     *
     * Read BEFORE the transaction by every caller, which is what makes the pair below
     * able to name exactly the events that path added.
     */
    private liveHighWaterMark(): string | null {
      if (this.ctx.getWebSockets().length === 0) return null;
      return (
        (
          this.sql.exec('SELECT MAX(id) AS id FROM _substrat_outbox').toArray() as unknown as {
            id: string | null;
          }[]
        )[0]?.id ?? ''
      );
    }

    /**
     * What every committing path does after its transaction closes: drain the outbox
     * to consumers, then announce what landed to whoever may see it.
     *
     * **One step, because there is one rule.** The fan-out was wired into `invoke`
     * alone at first, and `attachmentAdd`/`attachmentRemove` commit and emit too —
     * `attachment.added` and `attachment.removed`, about a real entity. A watcher of
     * that entity would have missed them: no error, no gap it could see, just a screen
     * that did not update for one kind of change. That is the exact failure the
     * hibernation design exists to prevent, arriving through a different door, so the
     * answer is a step both doors take rather than a second call both must remember.
     *
     * Order is load-bearing: drain FIRST, announce after. A consumer's own emits are
     * changes too, and they land in the outbox above `liveSince` — so announcing first
     * would tell a subscriber about the cause and not the effect, and it would re-read
     * too early.
     */
    private async settleCommitted(
      tenantId: TenantId,
      scopeId: ScopeId,
      liveSince: string | null,
      /**
       * #1525: the call whose commit this is settling, or null — PASSED rather than
       * read off `this.invocationId` inside `dispatch`, so each of the three doors
       * says what it actually knows: `invoke` its own id, the two attachment verbs
       * null. Same discipline `recordDenial` adopted, and for the same reason.
       */
      invocationId: string | null,
    ): Promise<void> {
      await this.dispatch(tenantId, scopeId, invocationId);
      if (liveSince === null) return;
      try {
        await this.fanOutLive(liveSince, tenantId, scopeId);
      } catch (err) {
        // The write has COMMITTED and the caller is owed its answer. A failure to
        // announce is a failure of a hint, and the client's poll is the floor
        // underneath it — so this is logged and never rethrown. Rethrowing would turn
        // a delivered write into a 500 the caller would reasonably retry.
        console.error('substrat: live-read fan-out failed after commit', err);
      }
    }

    /**
     * Announce what just committed, to whoever may see it (#938).
     *
     * **Three properties, and each is load-bearing.**
     *
     * *Post-commit.* Called after the operation's transaction has closed and after the
     * consumer drain, so nothing is announced that a rollback could take back and
     * nothing a consumer emitted is missed. A subscriber told about a row that then
     * vanished would re-read, find nothing, and have no way to tell that from a
     * deletion.
     *
     * *Filtered per subscriber, per event, after the check.* The declared
     * `liveTargets` key is checked ON THE EVENT'S OWN ENTITY, through `ctx.check` —
     * the same evaluator, the same entity-narrowed grants, the same parent walk as the
     * read the client is about to make. An entity type no module declared is announced
     * to nobody. Knowing that a row exists and changed at 14:02 is information about
     * that row, so the empty payload is not what makes this safe; this is.
     *
     * *Narrowed, when the subscription asked to be* (#1853). A socket opened `within` an
     * entity hears only rows that reach it through live parent edges — each row's
     * ancestors are walked once per pass, however many sockets ask. A vouched root
     * replaces the check above, and its frames are `LiveNudge`s.
     *
     * *Never able to fail the operation.* The write has committed and the caller has
     * its answer. A socket that has gone away mid-fan-out, or a check that cannot be
     * evaluated, costs a subscriber its live update — which it survives, because the
     * client's contract is that a push is a hint and the poll is the floor.
     */
    private async fanOutLive(
      sinceEventId: string,
      tenantId: TenantId,
      scopeId: ScopeId,
    ): Promise<void> {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return;
      const rows = this.sql
        .exec(
          `SELECT id, type, entity_type, entity_id, occurred_at FROM _substrat_outbox
            WHERE id > ? ORDER BY id LIMIT ?`,
          sinceEventId,
          LIVE_FANOUT_LIMIT,
        )
        .toArray() as unknown as {
        id: string;
        type: string;
        entity_type: string;
        entity_id: string;
        occurred_at: string;
      }[];
      // Drop the undeclared entity types BEFORE any per-subscriber work. Not an
      // optimisation: it is the fail-closed rule stated once, in the one place that
      // decides, rather than relied upon inside the loop below.
      const announceable = rows.filter((r) => this.liveTargets.has(r.entity_type));
      if (announceable.length === 0) return;

      /**
       * Is a row's entity beneath a `within` root (#1853)? Each row's ancestors are walked
       * once per pass, on first need, so a check per socket is a set lookup — every widget
       * visitor's root is a different session, and a walk per (row, socket) would read the
       * same parent edges once per visitor. Post-commit state: a `ctx.relink` in the same
       * operation has already moved the edge the walk follows.
       */
      const parents = scopeTupleReader(this.sql);
      /**
       * A checked root's gate, asked once per (principal, key, root) per pass (#938): a
       * principal holding that root in several tabs is one check, fanned out to each socket.
       */
      const rootChecks = new Map<string, Promise<boolean>>();
      const ancestors = new Map<string, Promise<Set<string>>>();
      /**
       * How long the memos above may be trusted (#938, Codex #2077 r4, r5). They are decisions
       * about authorization (a grant, a parent edge), and a later socket or row awaits after
       * they are taken, so each carries the conditions it stays true under rather than the
       * pass chasing every way it could go stale. Opened at a decision's instant; the memos
       * are forgotten once any condition fails, and a decision is taken again when one fails
       * between it and its send (read against the clock right before the send):
       *
       * - `writes`: the store's write count. Any write at all, not only a grant: coarser than
       *   tracking the tables a check reads, so no write door added later can slip past it.
       * - `until`: the earliest `expires_at` after the instant it was opened, across every
       *   local store a check or the walk reads. Nothing that authorized a decision can lapse
       *   before it, and a lapse is no write. Scope-wide rather than the rows one decision
       *   relied on, because the checker does not report those: an over-short bound only costs
       *   a re-check.
       * - `remote`: the scope reads its tenant tuples, roles and org membership from the
       *   directory over RPC (`permission_source` not yet `local`), whose changes write
       *   nothing here and carry no bound this object can see. Then a root's gate is never
       *   remembered at all: asked for every socket and row, right before its send. What
       *   remains is the window the live-read freshness contract accepts — a revoke that
       *   lands during one evaluation can let that one nudge through, and the next does not.
       */
      interface Epoch {
        readonly writes: number;
        readonly until: string | null;
        readonly remote: boolean;
      }
      const openEpoch = (now: string): Epoch => ({
        writes: this.revision.statementsWritten,
        until: this.authorityLapsesAfter(now),
        remote: this.permissionSourceIsRemote(),
      });
      const holds = (e: Epoch, now: string) =>
        e.writes === this.revision.statementsWritten && (e.until === null || now < e.until);
      let epoch = openEpoch(new Date().toISOString());
      /** The epoch current at `now`, opening a new one (and forgetting every memo) if not. */
      const epochAt = (now: string): Epoch => {
        if (!holds(epoch, now)) {
          epoch = openEpoch(now);
          rootChecks.clear();
          ancestors.clear();
        }
        return epoch;
      };
      const reaches = async (
        row: (typeof announceable)[number],
        root: { entityType: string; entityId: string },
        now: string,
      ) => {
        let up = ancestors.get(row.id);
        if (!up) {
          // A walk that cannot answer is a frame not sent — the same fail-closed rule as the check.
          // Walked at the decision's own instant; remembered only while its epoch holds.
          up = ancestorsWithin(parents, { entityType: row.entity_type, entityId: row.entity_id }, now).catch(
            () => new Set<string>(),
          );
          ancestors.set(row.id, up);
        }
        return (await up).has(`${root.entityType}:${root.entityId}`);
      };

      for (const ws of sockets) {
        let subscription: LiveSubscription | null = null;
        try {
          subscription = readSubscription(ws.deserializeAttachment());
        } catch {
          subscription = null;
        }
        // A socket we cannot name is a socket we cannot filter for. Skipped, never
        // sent to — see `readSubscription` for why every unusable shape fails closed.
        if (!subscription) continue;
        // A socket that outlived a scope rebind, or was somehow accepted for another
        // node, must not be fed this scope's events. Cheap, and it makes the identity
        // the frames are filtered against an explicit precondition rather than an
        // assumption about how the subscription was created.
        if (subscription.tenantId !== tenantId || subscription.scopeId !== scopeId) continue;
        // The session that opened it has ended (#938): closed before anything is sent,
        // whatever the subscriber's grants still say. Checked on every pass, so it holds for
        // every kind of subscription, not only the ones with a gate to ask — and asked
        // again, against a fresh clock, immediately before every send below, because the
        // walk and the checks between here and there await, and a session can end during
        // them.
        const { expiresAt } = subscription;
        const sessionEnded = () => expiresAt !== undefined && expiresAt <= new Date().toISOString();
        if (sessionEnded()) {
          closeSessionEnded(ws);
          continue;
        }
        const { within } = subscription;

        // One context per subscriber, not per event: `ctx.check` is the expensive part
        // and the context is only the subject it is evaluated for. Built on first use, so
        // a vouched subscriber — whose frames the walk alone decides — never builds one.
        //
        // A frame this subscriber does not pass is NOT recorded as a denial (K-35),
        // and that is deliberate: `recordDenial` is called on a refused REQUEST, where
        // somebody asked for something and was told no. Nobody asked for these. Logging
        // one row per unentitled subscriber per event would bury the denials that mean
        // something — a broken screen, or somebody walking the surface — under the
        // ordinary, correct working of a filter.
        //
        // The operation name is carried anyway, for the events a fan-out cannot emit
        // but a future reader of this context might.
        let ctx: OperationContext | undefined;
        const subscriber = subscription;
        const context = () => (ctx ??= this.liveContext(subscriber));
        /**
         * A checked root's gate (#938), asked at most once per (principal, key, root) per
         * pass (`rootChecks`) and only once a row beneath the root is about to be announced,
         * so an idle subscription costs no check. A refusal, or a check that throws, closes the socket before anything is
         * sent: the grant is gone, the principal is, or the root moved out of the grant's
         * reach. Closed rather than skipped, so the subscription does not sit there asking
         * on every pass, and the client's reconnect meets the handshake's 403. Held with the
         * write count it was decided under, and asked again once that has moved.
         */
        let rootVerdict: { epoch: Epoch; allowed: boolean } | undefined;
        /** What this subscriber is owed for one row, decided at `now` under epoch `e`. */
        const decide = async (
          row: (typeof announceable)[number],
          e: Epoch,
          now: string,
        ): Promise<LiveChange | LiveNudge | 'skip' | 'revoked'> => {
          // A remote authority's verdict is never reused: see `Epoch`.
          if (rootVerdict?.epoch !== e || e.remote) rootVerdict = undefined;
          // Narrowing first: it is memoised across sockets, and a row outside the root
          // is out whatever the principal holds.
          if (within && !(await reaches(row, within, now))) return 'skip';
          if (within?.checked !== undefined) {
            if (rootVerdict === undefined) {
              let check: Promise<boolean> | undefined;
              if (e.remote) {
                check = this.mayWatchRoot(context, within);
              } else {
                const key = `${subscriber.principal}\n${within.checked}\n${within.entityType}:${within.entityId}`;
                check = rootChecks.get(key);
                if (!check) rootChecks.set(key, (check = this.mayWatchRoot(context, within)));
              }
              rootVerdict = { epoch: e, allowed: await check };
            }
            if (!rootVerdict.allowed) return 'revoked';
          }
          if (within?.vouched !== undefined || within?.checked !== undefined) {
            // The root was vouched for or checked, so the walk above was the row filter —
            // and the subscriber holds no read on this row, so it is told only that
            // something beneath its root changed. Never which row, never how.
            return { kind: 'nudge', id: row.id, at: row.occurred_at };
          }
          // Non-null: `announceable` is exactly the rows whose type is in the map.
          const permission = this.liveTargets.get(row.entity_type) as PermissionKey;
          try {
            const decision = await context().check(permission, {
              entityType: row.entity_type,
              entityId: row.entity_id,
            });
            if (!decision.allowed) return 'skip';
          } catch {
            // A check that cannot answer is a check that refuses. The alternative —
            // treating an evaluator failure as an allow — turns an outage in the
            // permission path into a disclosure, which is the one failure mode this
            // surface must not have.
            return 'skip';
          }
          return {
            kind: 'change',
            id: row.id,
            type: row.type,
            entityType: row.entity_type,
            entityId: row.entity_id,
            at: row.occurred_at,
          };
        };

        rows: for (const row of announceable) {
          for (let attempt = 0; attempt < LIVE_DECIDE_ATTEMPTS; attempt++) {
            const decidedAt = new Date().toISOString();
            const e = epochAt(decidedAt);
            const verdict = await decide(row, e, decidedAt);
            // Every gate as close to the send as it can be, with no await between these
            // reads and the send below — so nothing can land after them and before it.
            // The store wrote, or something the decision relied on lapsed, while it was being
            // taken (Codex #2077 r4, r5): decide again, from nothing remembered.
            if (!holds(e, new Date().toISOString())) continue;
            if (verdict === 'skip') continue rows;
            if (verdict === 'revoked') {
              try {
                ws.close(LIVE_CLOSE.revoked, 'the subscriber may no longer watch this root');
              } catch {
                // Already gone.
              }
              break rows;
            }
            // The clock is read again here too, after every await above.
            if (sessionEnded()) {
              closeSessionEnded(ws);
              break rows;
            }
            try {
              ws.send(JSON.stringify(verdict));
            } catch {
              // The socket went away between `getWebSockets()` and here. Stop writing to
              // this one and move on; the runtime will deliver `webSocketClose`.
              break rows;
            }
            continue rows;
          }
          // Still moving after every attempt: this row is not announced, and the client's
          // poll — the floor under every push — picks it up.
        }
      }
    }

    // -- attachments (#473): the metadata half of the attachment surface --------
    // The coordinator (worker) holds the bytes and the per-tenant R2 binding; this
    // DO holds the permission gate and the metadata fact, under the same per-scope
    // serialization and transactional (row + spine event) semantics as an invoke.
    // Bytes never cross this boundary — only the small record does.

    private attachmentGate(entityType: string): { read: PermissionKey; write: PermissionKey } {
      const gate = this.attachmentTargets.get(entityType);
      if (!gate) {
        throw new Error(
          `no registered module declares '${entityType}' in attachmentTargets — attachments ` +
            `bind only to declared entity types`,
        );
      }
      return gate;
    }

    private attachmentRow(attachmentId: string): AttachmentRecord | null {
      const row = this.sql
        .exec('SELECT * FROM _substrat_attachments WHERE id = ?', attachmentId)
        .toArray()[0] as unknown as AttachmentRowShape | undefined;
      return row ? attachmentRecordOfRow(row) : null;
    }

    /** Record an uploaded attachment: write gate + row + `attachment.added`, one txn. */
    async attachmentAdd(
      record: AttachmentRecord,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      // #476: when set, the gate is checked as this CONNECTION (not `principal`, which is
      // then only the ctx.principal placeholder the connector door passes).
      connectionId?: string,
    ): Promise<AttachmentRecord> {
      await this.ensureMigrations();
      const parsed = attachmentRecord.parse(record);
      const gate = this.attachmentGate(parsed.entity.entityType);
      return this.queue.enqueue(async () => {
        // #938: this path commits and emits too, so it takes the same mark-then-settle
        // pair `invoke` takes. Inside the queued body and before the transaction, for
        // the reason it is read there: that is where this call holds the DO to itself.
        const liveSince = this.liveHighWaterMark();
        try {
          await this.revision.transaction(async () => {
            const ctx = this.operationContext(
              principal, tenantId, scopeId, undefined, connectionId,
              undefined, undefined, undefined, 'attachments.upload',
            );
            assertAllowed(await ctx.check(gate.write, parsed.entity));
            this.sql.exec(
              `INSERT INTO _substrat_attachments
                 (id, entity_type, entity_id, filename, content_type, size, sha256,
                  visibility, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              parsed.id,
              parsed.entity.entityType,
              parsed.entity.entityId,
              parsed.filename,
              parsed.contentType,
              parsed.size,
              parsed.sha256,
              parsed.visibility,
              parsed.createdBy,
              parsed.createdAt,
            );
            kernelEmit(ctx, {
              type: ATTACHMENT_ADDED,
              schemaVersion: 1,
              entity: parsed.entity,
              piiClass: 'none',
              payload: { attachment: parsed },
            });
            // #1575: queue its text extraction in the same transaction — a `pending` row
            // and a job run. Nothing is extracted here, so nothing here can fail the upload.
            enqueueAttachmentText(doSpineSql(this.sql), parsed.id, ulid(), new Date().toISOString());
          });
        } catch (err) {
          if (err instanceof PermissionDenied) {
            this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.upload', err, null);
          }
          throw toRpcError(err);
        }
        // #1525: null. An attachment RPC carries no invocation, exactly as its denial
        // records none — so the deliveries it drains name no call rather than a wrong one.
        await this.settleCommitted(tenantId, scopeId, liveSince, null);
        return parsed;
      });
    }

    /** Records for one entity, newest first — read gate first. */
    async attachmentList(
      entity: EntityRef,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
    ): Promise<AttachmentRecord[]> {
      await this.ensureMigrations();
      const gate = this.attachmentGate(entity.entityType);
      try {
        const ctx = this.operationContext(
          principal, tenantId, scopeId, undefined, connectionId,
          undefined, undefined, undefined, 'attachments.list',
        );
        assertAllowed(await ctx.check(gate.read, entity));
      } catch (err) {
        if (err instanceof PermissionDenied) {
          this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.list', err, null);
        }
        throw toRpcError(err);
      }
      const rows = this.sql
        .exec(
          `SELECT id FROM _substrat_attachments WHERE entity_type = ? AND entity_id = ?
           ORDER BY id DESC`,
          entity.entityType,
          entity.entityId,
        )
        .toArray() as unknown as { id: string }[];
      return rows.map((r) => this.attachmentRow(r.id)).filter((r): r is AttachmentRecord => r !== null);
    }

    /**
     * Authorize one attachment (`read` before bytes are served, `write` before a remove is
     * attempted elsewhere) and return its record — null for an id this scope does not know.
     */
    async attachmentAuthorize(
      attachmentId: string,
      mode: 'read' | 'write',
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
      forEventId?: string,
    ): Promise<AttachmentRecord | null> {
      await this.ensureMigrations();
      const record = this.attachmentRow(attachmentId);
      if (!record) return null;
      // #726 remedy B: inside a connector dispatch the authority to read is the
      // DELIVERY, not a standing grant — see `admitByDelivery` in adapter-sqlite for
      // why, and note that the entity is resolved HERE, from this scope's own
      // kernel-stamped outbox row. The platform runs the connector and can name any
      // delivery; it cannot name an entity, which is what keeps the capability from
      // being the caller's assertion about its own reach.
      if (forEventId !== undefined && mode === 'read') {
        try {
          this.admitByDelivery(forEventId, record);
        } catch (err) {
          if (err instanceof PermissionDenied) {
            this.recordDenial(
              attachSubject(principal, connectionId),
              tenantId,
              'attachments.open',
              err,
              null,
            );
          }
          throw toRpcError(err);
        }
        return record;
      }
      const gate = this.attachmentGate(record.entity.entityType);
      try {
        const ctx = this.operationContext(
          principal, tenantId, scopeId, undefined, connectionId,
          undefined, undefined, undefined, 'attachments.open',
        );
        assertAllowed(await ctx.check(mode === 'read' ? gate.read : gate.write, record.entity));
      } catch (err) {
        if (err instanceof PermissionDenied) {
          this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.open', err, null);
        }
        throw toRpcError(err);
      }
      return record;
    }

    /** Authorize a job's read as its registered module, never as a person. */
    async systemAttachmentAuthorize(
      attachmentId: string,
      moduleId: ModuleId,
      tenantId: TenantId,
      scopeId: ScopeId,
      /** #1834: the instance the system door's gate read; see `invoke`. */
      systemDoorInstance?: string,
    ): Promise<AttachmentRecord | null | SystemDoorMoved> {
      await this.ensureMigrations();
      let systemDoor: SystemDoorPass;
      try {
        systemDoor = this.assertSystemDoor(moduleId, systemDoorInstance)!;
      } catch (err) {
        if (err instanceof SystemDoorMovedError) return SYSTEM_DOOR_MOVED;
        throw toRpcError(err);
      }
      if (!this.modules.has(moduleId)) {
        throw toRpcError(substratError('not_found', `module not registered in this scope: ${moduleId}`));
      }
      const record = this.attachmentRow(attachmentId);
      if (!record) return null;
      const gate = this.attachmentGate(record.entity.entityType);
      try {
        const ctx = this.operationContext(
          this.systemPrincipal, tenantId, scopeId, undefined, undefined,
          systemDoor, undefined, undefined, 'attachments.open',
        );
        assertAllowed(await ctx.check(gate.read, record.entity));
      } catch (err) {
        if (err instanceof PermissionDenied) {
          this.recordDenial({ kind: 'system', id: moduleId }, tenantId, 'attachments.open', err, null);
        }
        throw toRpcError(err);
      }
      return record;
    }

    /** Remove an attachment's metadata fact: write gate + delete + `attachment.removed`. */
    async attachmentRemove(
      attachmentId: string,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
    ): Promise<AttachmentRecord | null> {
      await this.ensureMigrations();
      return this.queue.enqueue(async () => {
        const record = this.attachmentRow(attachmentId);
        if (!record) return null;
        const gate = this.attachmentGate(record.entity.entityType);
        // #938: same mark-then-settle pair as the upload path above.
        const liveSince = this.liveHighWaterMark();
        try {
          await this.revision.transaction(async () => {
            const ctx = this.operationContext(
              principal, tenantId, scopeId, undefined, connectionId,
              undefined, undefined, undefined, 'attachments.remove',
            );
            assertAllowed(await ctx.check(gate.write, record.entity));
            this.sql.exec('DELETE FROM _substrat_attachments WHERE id = ?', attachmentId);
            kernelEmit(ctx, {
              type: ATTACHMENT_REMOVED,
              schemaVersion: 1,
              entity: record.entity,
              piiClass: 'none',
              payload: { attachment: record },
            });
          });
        } catch (err) {
          if (err instanceof PermissionDenied) {
            this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.remove', err, null);
          }
          throw toRpcError(err);
        }
        // #1525: null. An attachment RPC carries no invocation, exactly as its denial
        // records none — so the deliveries it drains name no call rather than a wrong one.
        await this.settleCommitted(tenantId, scopeId, liveSince, null);
        return record;
      });
    }

    // -- attachment text (#1575) ---------------------------------------------------

    /**
     * Extracted-text search as `ctx`'s subject: authorized first — the check `open` makes,
     * the target's read key on the owning entity — then matched over readable owners only
     * (`searchAttachments`). The term and the limit are judged here again, never trusted
     * from the coordinator.
     */
    private searchAttachmentsAs(ctx: OperationContext, term: string, limit: number): Promise<AttachmentRecord[]> {
      return searchAttachments(
        doSpineSql(this.sql),
        { targets: this.attachmentTargets, check: (permission, entity) => ctx.check(permission, entity) },
        term,
        limit,
      );
    }

    /**
     * #1575: `ScopeAttachments.search` for a principal or a connection. Its failure travels as
     * DATA, the capability verbs' envelope, because a throw across this RPC keeps only its
     * message — and the too-many-owners refusal's `reason` is what a UI explains it by.
     */
    async attachmentSearch(
      term: string,
      limit: number,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
    ): Promise<CapabilityAttachmentReply<AttachmentRecord[]>> {
      await this.ensureMigrations();
      return replyOf(() => {
        const ctx = this.operationContext(
          principal, tenantId, scopeId, undefined, connectionId,
          undefined, undefined, undefined, 'attachments.search',
        );
        return this.searchAttachmentsAs(ctx, term, limit);
      });
    }

    /**
     * #1575: the extraction job's read of one record. No gate, deliberately — extraction
     * is the kernel's own derivation and the coordinator is its only caller; what a person
     * learns is gated at search.
     */
    async attachmentTextSource(attachmentId: string): Promise<AttachmentRecord | null> {
      await this.ensureMigrations();
      return this.attachmentRow(attachmentId);
    }

    /**
     * #1575: write one extraction outcome, guarded on the attachment still existing.
     * Through the queue, so it can never land inside an invoke's or an upload's open
     * transaction and roll back with it.
     */
    async attachmentTextRecord(attachmentId: string, outcome: ExtractionOutcome): Promise<boolean> {
      await this.ensureMigrations();
      return this.queue.enqueue(async () =>
        this.revision.transactionSync(() =>
          recordAttachmentText(doSpineSql(this.sql), attachmentId, outcome, new Date().toISOString()),
        ),
      );
    }

    /**
     * #1575: start the scope's one-shot backfill, unless it is marked or holds no
     * attachments (`startAttachmentTextBackfill` reads before it writes, so a marked scope
     * writes nothing — and moves no write revision — on every drive).
     */
    async attachmentTextBackfillStart(): Promise<void> {
      await this.ensureMigrations();
      await this.queue.enqueue(async () =>
        this.revision.transactionSync(() =>
          startAttachmentTextBackfill(doSpineSql(this.sql), ulid(), new Date().toISOString()),
        ),
      );
    }

    /** #1575: one backfill batch, in one transaction (`queueAttachmentTextBackfill`). */
    async attachmentTextBackfillBatch(after: string | null): Promise<AttachmentTextBackfillBatch> {
      await this.ensureMigrations();
      return this.queue.enqueue(async () =>
        this.revision.transactionSync(() =>
          queueAttachmentTextBackfill(doSpineSql(this.sql), after, ulid, new Date().toISOString()),
        ),
      );
    }

    // -- attachments through a capability (#1686) -------------------------------
    // The coordinator hashed the session token; only the hash arrives. Each verb resolves it
    // INSIDE the queue, as `invoke` does, so nothing can revoke between the resolution and
    // the check — and a revoke or an expiry refuses the very next call. Reads are the
    // ordinary checker's, as `{ capability }`: its keys, its subtree, its minter's authority
    // now. Writes are refused whatever the keys say. No verb here takes a use.

    /**
     * Resolve the session and run `fn` as the capability; a refused check lands in the
     * denial log against `{ capability }`. A dead session throws before `fn` (no K-35 row).
     *
     * THE ORDER, for every verb: the session (here), then the target lookup, then the
     * check. So `attachmentGate` is only ever called inside `fn`: a dead link is told
     * `unauthenticated` and learns nothing about which entity types take attachments.
     *
     * The answer is an ENVELOPE, `invoke`'s: a failure travels as a value (`toWireFailure`)
     * because a throw across this boundary keeps only its message, and the caller has to
     * tell `permission_denied` from `unauthenticated` from `forbidden` — a 403, a 401 and a
     * 403 of a different kind to whoever is downloading.
     */
    private asCapability<T>(
      sessionHash: string,
      tenantId: TenantId,
      scopeId: ScopeId,
      operation: string,
      fn: (ctx: OperationContext, capability: CapabilityId) => Promise<T>,
    ): Promise<CapabilityAttachmentReply<T>> {
      return this.queue.enqueue(async () => {
        let capability: CapabilityId;
        try {
          capability = resolveCapabilitySession(
            doSpineSql(this.sql),
            sessionHash,
            instant.parse(new Date().toISOString()),
            operation,
          );
        } catch (err) {
          return { failure: toWireFailure(err) };
        }
        try {
          const ctx = this.operationContext(
            // A placeholder the subject never reads, as on the invoke path: `capabilityId`
            // is what the context acts as.
            capability as unknown as PrincipalId,
            tenantId, scopeId, undefined, undefined, undefined, undefined, undefined, operation,
            capability,
          );
          return { value: await fn(ctx, capability) };
        } catch (err) {
          if (err instanceof PermissionDenied) {
            this.recordDenial({ kind: 'capability', id: capability }, tenantId, operation, err, null);
          }
          return { failure: toWireFailure(err) };
        }
      });
    }

    async capabilityAttachmentList(
      entity: EntityRef,
      sessionHash: string,
      tenantId: TenantId,
      scopeId: ScopeId,
    ): Promise<CapabilityAttachmentReply<AttachmentRecord[]>> {
      await this.ensureMigrations();
      return this.asCapability(sessionHash, tenantId, scopeId, 'attachments.list', async (ctx) => {
        const gate = this.attachmentGate(entity.entityType);
        assertAllowed(await ctx.check(gate.read, entity));
        const rows = this.sql
          .exec(
            `SELECT id FROM _substrat_attachments WHERE entity_type = ? AND entity_id = ?
             ORDER BY id DESC`,
            entity.entityType,
            entity.entityId,
          )
          .toArray() as unknown as { id: string }[];
        return rows
          .map((r) => this.attachmentRow(r.id))
          .filter((r): r is AttachmentRecord => r !== null);
      });
    }

    /** The record of an attachment the capability may read, or null for an unknown id. */
    async capabilityAttachmentOpen(
      attachmentId: string,
      sessionHash: string,
      tenantId: TenantId,
      scopeId: ScopeId,
    ): Promise<CapabilityAttachmentReply<AttachmentRecord | null>> {
      await this.ensureMigrations();
      return this.asCapability(sessionHash, tenantId, scopeId, 'attachments.open', async (ctx) => {
        const record = this.attachmentRow(attachmentId);
        if (!record) return null;
        const gate = this.attachmentGate(record.entity.entityType);
        assertAllowed(await ctx.check(gate.read, record.entity));
        return record;
      });
    }

    /** #1575: extracted-text search as the capability — its keys, its subtree, its minter now. */
    async capabilityAttachmentSearch(
      term: string,
      limit: number,
      sessionHash: string,
      tenantId: TenantId,
      scopeId: ScopeId,
    ): Promise<CapabilityAttachmentReply<AttachmentRecord[]>> {
      await this.ensureMigrations();
      return this.asCapability(sessionHash, tenantId, scopeId, 'attachments.search', (ctx) =>
        this.searchAttachmentsAs(ctx, term, limit),
      );
    }

    /**
     * Refuse an upload or a remove through a capability, and record it. Throws for an
     * unknown attachment id too — the same answer either way — but only a known target has
     * a write key for the denial log to record.
     */
    async capabilityAttachmentRefuseWrite(
      sessionHash: string,
      tenantId: TenantId,
      scopeId: ScopeId,
      operation: 'attachments.upload' | 'attachments.remove',
      target: { entityType: string } | { attachmentId: string },
    ): Promise<CapabilityAttachmentReply<never>> {
      await this.ensureMigrations();
      return this.asCapability(sessionHash, tenantId, scopeId, operation, async (_ctx, capability) => {
        const entityType =
          'entityType' in target
            ? target.entityType
            : this.attachmentRow(target.attachmentId)?.entity.entityType;
        throw capabilityAttachmentWriteRefused(
          capability,
          operation,
          { tenantId, scopeId },
          entityType === undefined ? undefined : this.attachmentGate(entityType).write,
        );
      });
    }

    /** The kernel's schedule-switch SQL (#1666), over this DO's storage. */
    private switchSql(): SwitchSql {
      return switchSqlOver(this.sql);
    }

    /**
     * Where a module's schedules stand on this scope (#383, #1666) — the kernel's
     * `systemScheduleState`, the predicate the pure adapter runs too: `on` with a live
     * `system:<moduleId>` grant, `off` while the kill switch's marker is live, whatever
     * else is, and `ungranted` on a scope that never ran the module (a foreign vertical's,
     * which the sweep skips quietly).
     */
    async systemScheduleState(moduleId: string): Promise<SystemScheduleState> {
      return systemScheduleState(this.switchSql(), moduleId, new Date().toISOString());
    }

    /**
     * #1834: the system door's state read — `systemScheduleState`, and the instance that
     * answered it. The door consults the rewind hold after this read and pins every call it
     * then makes to this instance (`assertSystemDoor`).
     */
    async systemDoorState(moduleId: string): Promise<{ state: SystemScheduleState; instance: string }> {
      return { state: await this.systemScheduleState(moduleId), instance: this.instanceId };
    }

    /**
     * #1834: the system door's check on this side, and the ONLY maker of the `SystemDoorPass`
     * the operation context needs to act as `system:<moduleId>`. A call acting as a module must
     * carry the instance the host's door gate read (refused without one: no door gated it), and
     * is refused on any other instance. A PITR restore always restarts this object, so a call
     * landing on a new instance may meet rewound storage whose module the gate never checked
     * against the rewind hold. Both are refused before anything opens; the moved one is the
     * module-private `SystemDoorMovedError`, which the RPC answers as `SystemDoorMoved`, so the door
     * gates again and retries. No module, no pass.
     */
    private assertSystemDoor(moduleId: string | undefined, expected: string | undefined): SystemDoorPass | undefined {
      if (moduleId === undefined) return undefined;
      this.assertDoorPin(`module '${moduleId}'`, 'system door', expected);
      return { moduleId, [SYSTEM_DOOR_PASSED]: true };
    }

    /** #2029: the peer door's pin, for a call acting as `vertical:<slug>` — `assertDoorPin`. */
    private assertPeerDoor(vertical: string, expected: string | undefined): void {
      this.assertDoorPin(`vertical '${vertical}'`, 'peer door', expected);
    }

    /**
     * #2029: the peer door's pin for an RPC that answers a missed pin as `SystemDoorMoved` rather
     * than through `invoke`'s envelope: true when it missed. A call with no pin still throws.
     */
    private peerDoorMoved(vertical: string, expected: string | undefined): boolean {
      try {
        this.assertPeerDoor(vertical, expected);
        return false;
      } catch (err) {
        if (err instanceof SystemDoorMovedError) return true;
        throw err;
      }
    }

    /**
     * #1834's pin, for any door (#2029: the peer door's too). A call acting as a switched subject
     * must carry the instance the host's door gate read, and is refused on any other instance —
     * the moved one as the module-private `SystemDoorMovedError`, so the door re-gates.
     */
    private assertDoorPin(what: string, door: 'system door' | 'peer door', expected: string | undefined): void {
      // Strict, and deliberately so: no pin means no door gated this call, so it is refused rather
      // than run unchecked. The one innocent caller is a worker a deploy behind, still running host
      // code from before the pin, during a rolling deploy. Its refusal is transient: the host and this
      // object ship in the same bundle, so the window lasts as long as the rollout. Nothing ran, and
      // the reason says "not now" (`SYSTEM_DOOR_WAIT`) to whoever reads it: a schedule fires on the
      // next pass, a job run retries on its next drive, and a peer caller retries.
      if (expected === undefined) {
        throw substratError('forbidden', `a call acting as ${what} reached this scope without passing the ${door}`, {
          reason: SYSTEM_DOOR_WAIT,
        });
      }
      if (expected !== this.instanceId) {
        throw new SystemDoorMovedError(`the scope restarted after the ${door}'s gate read it; gate it again`);
      }
    }

    /**
     * The pre-#1666 read, kept for ONE reason: a coordinator a deploy behind this DO still
     * calls it. It answers the new question, not the old one — the old predicate counted any
     * live `system:` tuple, and the kill switch's OFF marker is one, so an old coordinator
     * asking the old question would run a switched-off scope's schedules.
     */
    async hasSystemGrant(moduleId: string): Promise<boolean> {
      return (await this.systemScheduleState(moduleId)) === 'on';
    }

    /**
     * `grantToSystem`'s scope-level write (#1666): the explicit grant — `INSERT OR REPLACE`,
     * as `writeTuple` — EXCEPT while the module's schedule kill switch is off, when it writes
     * nothing and answers `false`. The check and the write are one queued unit, so no switch
     * can move between them. Restore is the lever; a grant is not.
     */
    async writeSystemGrant(
      moduleId: string,
      relation: string,
      object: string,
      expiresAt: string | null,
    ): Promise<boolean> {
      return this.queue.enqueue(() => {
        if (systemSwitchedOff(this.switchSql(), moduleId)) return false;
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?)`,
          `system:${moduleId}`,
          relation,
          object,
          expiresAt,
        );
        return true;
      });
    }

    /**
     * Move a module's schedule switch on this scope (#1666) — the kernel's
     * `switchSystemSchedules`, serialized on the queue with every other tuple write and run
     * as one `transactionSync`, so its reads and writes are one unit.
     */
    async switchSystemSchedules(
      moduleId: string,
      scopeId: string,
      to: 'on' | 'off',
      at: string,
      tenantHeld = false,
      /** #2045: the switch call's fence — the scope refuses a move older than the one it applied. */
      fence?: string,
    ): Promise<SwitchOutcome & { instance: string }> {
      const outcome = await this.queue.enqueue(() =>
        this.revision.transactionSync(() =>
          switchSystemSchedules(this.switchSql(), { moduleId, scopeId, to, at, tenantHeld, fence }),
        ),
      );
      // #1819: the instance that applied it, which the rewind hold's release rule reads.
      return { ...outcome, instance: this.instanceId };
    }

    /**
     * The replay lever on this scope (#1705 PR 3): the kernel's `moveImportCursor`, queued with
     * every `importApply` on this scope and run as one `transactionSync`. A delivery on the same
     * edge is therefore wholly before the move, or refused by its compare-and-set after it.
     * Migrated first: the rows a replay moves aside go to `_substrat_import_replays`.
     */
    async importCursorMove(input: ImportCursorMoveAt & { now: number }): Promise<ImportCursorMoved> {
      await this.ensureMigrations();
      // The consumer's own running imports decide whether the edge exists: read here, in the
      // deployment whose handlers would run, never from the platform's request.
      const imports = this.crossVertical.consumes();
      return this.queue.enqueue(() =>
        this.revision.transactionSync(() => moveImportCursor(this.switchSql(), { ...input, imports })),
      );
    }

    /**
     * Move one PEER's kill switch on this scope (#1706) — the kernel's `switchPeer`, which is
     * the schedule switch's statement with a `vertical:` subject. Queued, one transaction.
     */
    async switchPeer(
      vertical: string,
      scopeId: string,
      to: 'on' | 'off',
      at: string,
      /** #2030: the directory holds a live tenant-level `vertical:` grant for the peer. */
      tenantHeld = false,
      /** #2045: the switch call's fence — the scope refuses a move older than the one it applied. */
      fence?: string,
    ): Promise<SwitchOutcome & { instance: string }> {
      const outcome = await this.queue.enqueue(() =>
        this.revision.transactionSync(() =>
          switchPeer(this.switchSql(), { vertical, scopeId, to, at, tenantHeld, fence }),
        ),
      );
      // #2029: the instance that applied it, which the rewind hold's release rule reads.
      return { ...outcome, instance: this.instanceId };
    }

    /**
     * #2029: the peer door's state read — where one peer stands here (`subjectGrantState` over its
     * subject, the predicate `admitPeer` refuses on), and the instance that answered it. The door
     * consults the rewind hold after this read and pins every call it then makes to this instance.
     */
    async peerDoorState(vertical: string): Promise<{ state: SystemScheduleState; instance: string }> {
      return {
        state: subjectGrantState(this.switchSql(), peerSubjectRef(vertical), new Date().toISOString()),
        instance: this.instanceId,
      };
    }

    /**
     * Does peer `vertical` hold each key at this scope's node now (#1706) — the checker's own
     * `covers`, queued so no invoke's open transaction is read half-done. The subject's `scope`
     * is the target scope only to satisfy the type: `covers` records nothing, and the tuple ref
     * it walks is the slug alone.
     */
    async peerCovers(
      tenantId: TenantId,
      scopeId: ScopeId,
      vertical: string,
      permissions: PermissionKey[],
      /** #2029: the instance the peer door's gate read; on another, nothing is read. */
      doorInstance?: string,
    ): Promise<PeerCoverage[] | SystemDoorMoved> {
      if (this.peerDoorMoved(vertical, doorInstance)) return SYSTEM_DOOR_MOVED;
      return this.peerCoverage(tenantId, scopeId, vertical, permissions);
    }

    /** `peerCovers`' read, for this object's own callers, which gated the peer themselves. */
    private async peerCoverage(
      tenantId: TenantId,
      scopeId: ScopeId,
      vertical: string,
      permissions: PermissionKey[],
    ): Promise<PeerCoverage[]> {
      await this.ensureMigrations();
      return this.queue.enqueue(async () => {
        const coverage = await this.checker.covers(
          { kind: 'vertical', id: vertical, scope: scopeId },
          permissions,
          { tenantId, scopeId },
        );
        const missing = new Set<string>(coverage.covered ? [] : coverage.missing);
        return permissions.map((permission) => ({ permission, held: !missing.has(permission) }));
      });
    }

    /**
     * `ctx.canAssign`'s bound for a principal the host names (#1931), queued like `peerCovers`
     * so no invoke's open transaction is read half-done. `null` when the tenant defines no such
     * role: a typed error thrown here would reach the host flattened, so the host types it.
     */
    async canAssignFor(
      tenantId: TenantId,
      scopeId: ScopeId,
      principal: PrincipalId,
      roleKey: string,
      /** #1184: bound at the TENANT node instead — a membership executor assigning tenant-wide. */
      atTenant = false,
    ): Promise<Coverage | null> {
      await this.ensureMigrations();
      return this.queue.enqueue(() =>
        this.assignmentBound({ kind: 'principal', id: principal }, tenantId, atTenant ? null : scopeId, roleKey),
      );
    }

    /** Check and grant in one serialized scope task; a refusal never writes a tuple. */
    async assignScopeRoleBoundedFor(
      tenantId: TenantId,
      scopeId: ScopeId,
      caller: PrincipalId,
      assignee: PrincipalId,
      roleKey: string,
    ): Promise<Coverage | null> {
      await this.ensureMigrations();
      return this.queue.enqueue(async () => {
        const bound = await this.assignmentBound({ kind: 'principal', id: caller }, tenantId, scopeId, roleKey);
        if (bound?.covered) {
          applyScopeRoleChange(this.switchSql(), scopeId, assignee, { revoke: [], grant: roleKey }, new Date().toISOString());
        }
        return bound;
      });
    }

    /** The scope's live scope-level role assignments, or one principal's (#1150). */
    async scopeRoleHoldersFor(scopeId: ScopeId, principal?: PrincipalId): Promise<ScopeRoleHolder[]> {
      await this.ensureMigrations();
      return this.queue.enqueue(() => scopeRoleHolders(this.switchSql(), scopeId, new Date().toISOString(), principal));
    }

    /**
     * The kernel's `changeScopeRole` in one serialized scope task (#1150). Its two refusals come
     * back as values: an error thrown here crosses the RPC flattened, so the coordinator types them.
     */
    async changeScopeRoleBoundedFor(
      tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId, from: string, to: string,
    ): Promise<Coverage | 'not-held' | 'unknown-to'> {
      await this.ensureMigrations();
      return this.queue.enqueue(() =>
        changeScopeRole(
          this.switchSql(), scopeId, principal, from, to, new Date().toISOString(), this.roleBound(caller, tenantId, scopeId),
          (run) => this.revision.transactionSync(run),
        ),
      );
    }

    /** The kernel's `revokeScopeRoles` in one serialized scope task (#1150). */
    async revokeScopeRolesBoundedFor(
      tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId,
    ): Promise<{ coverage: Coverage; revoked: string[] }> {
      await this.ensureMigrations();
      return this.queue.enqueue(() =>
        revokeScopeRoles(
          this.switchSql(), scopeId, principal, new Date().toISOString(), this.roleBound(caller, tenantId, scopeId),
          (run) => this.revision.transactionSync(run),
        ),
      );
    }

    /** The caller's bound per role at the scope; `null` for a role the tenant does not define. */
    private roleBound(caller: PrincipalId, tenantId: TenantId, scopeId: ScopeId): RoleBound {
      return (roleKey) => this.assignmentBound({ kind: 'principal', id: caller }, tenantId, scopeId, roleKey);
    }

    /**
     * §5.1's assignment bound, resolved against the SAME role table the checker
     * expands — the tenant's projected role, not a vertical's compile-time `ROLES`
     * array, because the projected role is what assignment would actually confer.
     * The one resolution both `ctx.canAssign` and `canAssignFor` answer from; `null`
     * when the tenant defines no such role.
     */
    private async assignmentBound(
      subject: CheckSubject,
      tenantId: TenantId,
      scopeId: ScopeId | null,
      roleKey: string,
    ): Promise<Coverage | null> {
      const role = await this.controlPlaneReader().getRole(tenantId, roleKey);
      if (!role) return null;
      return this.checker.covers(subject, role.permissions, { tenantId, scopeId });
    }

    /**
     * Every module this scope holds or has held system authority for, and where each
     * stands (#1674) — the kernel's `systemGrantsStatus`, over this DO's own storage. A
     * plain read like `systemScheduleState` above, not queued: nothing here decides a
     * write.
     */
    async systemGrantsStatus(): Promise<SystemGrantsEntry[]> {
      return systemGrantsStatus(this.switchSql(), new Date().toISOString());
    }

    // -- the rewind hold (#1819) ------------------------------------------------
    // Two halves. On EVERY scope instance: its identity, and whether it has armed a rewind, so
    // the host can tell storage the rewind will discard from storage it restored. On ONE object
    // per deployment, the one named `SWITCH_HOLDS_NAME` and never a scope's own: the claims
    // themselves, because a rewind replaces the rewound scope's whole storage. The claims table
    // is created on first use, so no scope ever carries it. #2029: `module_id` holds a hold KEY —
    // a module id, bare as #1819 stored it, or a peer's `vertical:<slug>`, which no module id can
    // spell (a module id has no `:`).

    /** This instance, and nothing before or after it: a restart is a new id. */
    private readonly instanceId = crypto.randomUUID();
    /** Whether this instance armed a rewind: then its writes are discarded at the restart. */
    private rewindArmed = false;
    /** Whether this instance began arming one: set before the restore call, and never cleared. */
    private rewindArming = false;

    /**
     * Which instance is serving, and whether it armed a rewind or began to. For an ambiguous
     * rewind throw: arming counts as armed, because the restore call may yet land.
     */
    rewindProbe(): { instance: string; armed: boolean } {
      return { instance: this.instanceId, armed: this.rewindArmed || this.rewindArming };
    }

    /** Whether this instance has created the claims table; it never goes away once it exists. */
    private switchHoldsReady = false;

    private switchHoldsTable(): void {
      if (this.switchHoldsReady) return;
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS _substrat_switch_holds (
           scope_id TEXT NOT NULL,
           module_id TEXT NOT NULL,
           claim_id TEXT NOT NULL,
           state TEXT NOT NULL,
           doomed TEXT,
           held_at TEXT NOT NULL,
           PRIMARY KEY (scope_id, module_id, claim_id)
         )`,
      );
      // #1839: the ON tombstones, and the one counter that orders them against a rewind's reads.
      // This object's storage is never rewound, so the counter only ever goes up.
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS _substrat_switch_hold_ons (
           scope_id TEXT NOT NULL,
           module_id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           PRIMARY KEY (scope_id, module_id)
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS _substrat_switch_hold_seq (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           seq INTEGER NOT NULL
         )`,
      );
      this.switchHoldsReady = true;
    }

    /**
     * #1839: where the ON counter stands now. A rewind reads this BEFORE it reads the scope's status,
     * and hands it to `switchHoldClaim`: an ON tombstoned after it may have moved after that read.
     */
    switchHoldToken(): number {
      this.switchHoldsTable();
      const row = this.sql.exec('SELECT seq FROM _substrat_switch_hold_seq WHERE id = 1').toArray()[0] as
        | { seq: number }
        | undefined;
      return row?.seq ?? 0;
    }

    /**
     * #1839: an operator's ON has moved: release the claims it read before the move (S0) on this
     * module, and tombstone the module with the next count, in one transaction. Called only AFTER the
     * move, so a rewind whose token predates the tombstone may have read the switch before the ON;
     * `switchHoldClaim` then refuses that stale read's row. A row it inserted before this ran is
     * either one of the S0 claims (released here) or a claim created after S0, which is left alone.
     */
    switchHoldOn(scopeId: string, moduleId: string, claimIds: string[]): void {
      this.switchHoldsTable();
      this.revision.transactionSync(() => {
        const seq = (
          this.sql
            .exec(
              `INSERT INTO _substrat_switch_hold_seq (id, seq) VALUES (1, 1)
               ON CONFLICT (id) DO UPDATE SET seq = seq + 1 RETURNING seq`,
            )
            .toArray()[0] as { seq: number }
        ).seq;
        this.sql.exec(
          `INSERT INTO _substrat_switch_hold_ons (scope_id, module_id, seq) VALUES (?, ?, ?)
           ON CONFLICT (scope_id, module_id) DO UPDATE SET seq = excluded.seq`,
          scopeId,
          moduleId,
          seq,
        );
        for (const claimId of claimIds) {
          this.sql.exec(
            'DELETE FROM _substrat_switch_holds WHERE scope_id = ? AND module_id = ? AND claim_id = ?',
            scopeId,
            moduleId,
            claimId,
          );
        }
      });
    }

    /**
     * One rewind's claim on these modules, `pending` until the rewind has armed. Only the rewind
     * that owns the claim calls this, and only before it arms. Each new row is stamped with THIS
     * object's clock, and `switchHoldYoungestMs` measures against the same clock (#1839). A row
     * already there keeps its stamp.
     *
     * `token` is `switchHoldToken` as the rewind read it before the status read these modules came
     * from. A module tombstoned by an ON after that is skipped: the read may predate the ON, and
     * the ON is the operator's newer word (#1839).
     */
    switchHoldClaim(scopeId: string, moduleIds: string[], claimId: string, token: number): void {
      this.switchHoldsTable();
      const at = new Date().toISOString();
      this.revision.transactionSync(() => {
        for (const moduleId of moduleIds) {
          this.sql.exec(
            `INSERT OR IGNORE INTO _substrat_switch_holds (scope_id, module_id, claim_id, state, doomed, held_at)
             SELECT ?, ?, ?, 'pending', NULL, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM _substrat_switch_hold_ons WHERE scope_id = ? AND module_id = ? AND seq > ?
              )`,
            scopeId,
            moduleId,
            claimId,
            at,
            scopeId,
            moduleId,
            token,
          );
        }
      });
    }

    /**
     * #1839: an OFF joins other rewinds' claims. The row takes its claim's state and doomed instance
     * from the claim's own rows, in this transaction, so it can never be staler than the claim; it
     * is stamped with this object's clock. A claim with no rows left is not joined: this cannot tell
     * a claim its rewind dropped (a refusal) from one an ON emptied, and a row created for a dropped
     * one would hold the module with no rewind behind it.
     */
    switchHoldJoin(scopeId: string, moduleId: string, claimIds: string[]): void {
      this.switchHoldsTable();
      const at = new Date().toISOString();
      this.revision.transactionSync(() => {
        for (const claimId of claimIds) {
          this.sql.exec(
            `INSERT OR IGNORE INTO _substrat_switch_holds (scope_id, module_id, claim_id, state, doomed, held_at)
             SELECT scope_id, ?, claim_id, state, doomed, ? FROM _substrat_switch_holds
              WHERE scope_id = ? AND claim_id = ? LIMIT 1`,
            moduleId,
            at,
            scopeId,
            claimId,
          );
        }
      });
    }

    /**
     * #1839: how long ago, on this object's clock, the youngest row of one claim was stamped; null
     * once the claim has no rows. The rewind waits on this, so its age and the stamp are read on
     * one clock and no two clocks are ever compared.
     */
    switchHoldYoungestMs(scopeId: string, claimId: string): number | null {
      this.switchHoldsTable();
      const row = this.sql
        .exec('SELECT MAX(held_at) AS youngest FROM _substrat_switch_holds WHERE scope_id = ? AND claim_id = ?', scopeId, claimId)
        .toArray()[0] as { youngest: string | null };
      return row.youngest ? Date.now() - Date.parse(row.youngest) : null;
    }

    /** The rewind armed (or may have): its claim is `armed`, naming the instance it doomed. */
    switchHoldArm(scopeId: string, claimId: string, doomed: string | null): void {
      this.switchHoldsTable();
      this.sql.exec(
        `UPDATE _substrat_switch_holds SET state = 'armed', doomed = ? WHERE scope_id = ? AND claim_id = ?`,
        doomed,
        scopeId,
        claimId,
      );
    }

    /** A definite refusal: this rewind's own claim goes, and no other. */
    switchHoldDrop(scopeId: string, claimId: string): void {
      this.switchHoldsTable();
      this.sql.exec('DELETE FROM _substrat_switch_holds WHERE scope_id = ? AND claim_id = ?', scopeId, claimId);
    }

    /** Every held (scope, module) in the deployment, one read for a whole sweep pass. */
    switchHoldsAll(): { scopeId: string; moduleId: string }[] {
      this.switchHoldsTable();
      return this.sql
        .exec('SELECT DISTINCT scope_id, module_id FROM _substrat_switch_holds')
        .toArray()
        .map((r) => ({ scopeId: r.scope_id as string, moduleId: r.module_id as string }));
    }

    /**
     * Every claim row on one scope, for a switch move to read before it moves: the release rule
     * reads the module's own rows, and an OFF (#1839) the scope's claims it would join.
     */
    switchHoldClaims(
      scopeId: string,
    ): { claimId: string; moduleId: string; state: 'pending' | 'armed'; doomed: string | null; heldAt: string }[] {
      this.switchHoldsTable();
      return this.sql
        .exec('SELECT claim_id, module_id, state, doomed, held_at FROM _substrat_switch_holds WHERE scope_id = ?', scopeId)
        .toArray()
        .map((r) => ({
          claimId: r.claim_id as string,
          moduleId: r.module_id as string,
          state: r.state as 'pending' | 'armed',
          doomed: (r.doomed as string | null) ?? null,
          heldAt: r.held_at as string,
        }));
    }

    /** Release these claims on one module, or every claim on the scope when `claimIds` is null. */
    switchHoldRelease(scopeId: string, moduleId: string | null, claimIds: string[] | null): void {
      this.switchHoldsTable();
      this.revision.transactionSync(() => {
        if (moduleId === null || claimIds === null) {
          this.sql.exec('DELETE FROM _substrat_switch_holds WHERE scope_id = ?', scopeId);
          this.sql.exec('DELETE FROM _substrat_switch_hold_ons WHERE scope_id = ?', scopeId);
          return;
        }
        for (const claimId of claimIds) {
          this.sql.exec(
            'DELETE FROM _substrat_switch_holds WHERE scope_id = ? AND module_id = ? AND claim_id = ?',
            scopeId,
            moduleId,
            claimId,
          );
        }
      });
    }

    /**
     * Where every peer this scope holds or has held grants for stands (#1706) — the
     * kernel's `peerGrantsStatus`, over this DO's own storage, and the same plain
     * unqueued read as the line above: nothing here decides a write.
     */
    async peerGrantsStatus(): Promise<PeerGrantsRow[]> {
      return peerGrantsStatus(this.switchSql(), new Date().toISOString());
    }

    /**
     * The exchange (#1672) — a capability's secret traded for a session, or for the
     * principal a `become` capability yields. Runs the kernel's `exchangeCapability`, the
     * function the pure adapter runs, in this DO: one queued body and one storage
     * transaction, so the use it takes and the `capability.exercised` event recording it
     * commit together or not at all; the event's consumers then settle as an invoke's do.
     *
     * The secret itself reaches this DO — it must, to be hashed and looked up — and goes
     * no further: nothing here stores or returns it.
     */
    async exchangeCapability(
      secret: string,
      tenantId: TenantId,
      scopeId: ScopeId,
      mode?: 'act' | 'become',
    ): Promise<CapabilityExchange | null> {
      await this.ensureMigrations();
      return await this.queue.enqueue(async () => {
        const liveSince = this.liveHighWaterMark();
        // ONE instant for the whole exchange: the row's `last_used_at`, the session's times
        // and the event's `occurredAt` are one fact, and two clock reads could disagree.
        const now = instant.parse(new Date().toISOString());
        let outcome: CapabilityExchange | null = null;
        await this.revision.transaction(async () => {
          outcome = await exchangeCapability(
            {
              sql: doSpineSql(this.sql),
              now,
              // Stamped `{ capability }` by the ordinary emit path, under the exchange's own
              // pseudo-operation name — the actor is the capability, as on every event it
              // goes on to cause.
              emit: (capability, event) =>
                kernelEmit(this.operationContext(
                  principalId.parse(ulid()),
                  tenantId,
                  scopeId,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  CAPABILITY_EXCHANGE_OPERATION,
                  capability,
                  [],
                  now,
                ), event),
            },
            secret,
            mode,
          );
        });
        if (outcome) await this.settleCommitted(tenantId, scopeId, liveSince, null);
        return outcome;
      });
    }

    /**
     * The platform's mint (#1672, `HostAdmin.mintCapability`) — a `become` capability,
     * serialized on the queue with every other spine write. One INSERT, so it needs no
     * transaction of its own; the hash is computed before it.
     */
    async mintBecomeCapability(
      input: BecomeCapabilityInput,
      actor: PlatformActorId,
    ): Promise<MintedCapability> {
      await this.ensureMigrations();
      return await this.queue.enqueue(() =>
        mintBecomeCapability(doSpineSql(this.sql), input, actor, instant.parse(new Date().toISOString())),
      );
    }

    /**
     * The platform's revoke (#1672, `HostAdmin.revokeCapability`) — of any capability in
     * this scope. Returns the record as it stood before, for the admin log, or `null`.
     */
    async revokeCapabilityAsPlatform(
      id: string,
      actor: PlatformActorId,
    ): Promise<CapabilityRecord | null> {
      await this.ensureMigrations();
      return await this.queue.enqueue(
        () =>
          this.revision.transactionSync(() =>
            revokeCapabilityAsPlatform(doSpineSql(this.sql), id, actor, instant.parse(new Date().toISOString())),
          ) ?? null,
      );
    }

    /**
     * The operator's read of this scope's capabilities (#1686). The kernel's one read
     * (`readCapabilityPage`): no `token_hash` selected, decoded to a record with no field to hold one.
     * Authorization and the K-3 cross-check happen on the coordinator first.
     */
    async listCapabilities(filter?: CapabilityFilter): Promise<CapabilityPage> {
      await this.ensureMigrations();
      return readCapabilityPage(doSpineSql(this.sql), filter);
    }

    /**
     * The last time a schedule's operation ran on this scope (#383), or null.
     *
     * `kind = 'schedule'` is not decoration (#1288): an operation may legally be
     * named `freshness:<something>`, and before the column this read answered with
     * the EVALUATOR's last recorded time for that event type — a cadence gate
     * driven by a verdict nothing ran.
     */
    async scheduleLastRun(operation: string): Promise<string | null> {
      const row = this.sql
        .exec(
          `SELECT last_run_at FROM _substrat_schedule_state WHERE kind = 'schedule' AND schedule_op = ?`,
          operation,
        )
        .toArray()[0] as { last_run_at: string | null } | undefined;
      return row?.last_run_at ?? null;
    }

    /**
     * #1232: everything the freshness evaluator needs about this scope, one round
     * trip regardless of how many types are declared — the newest matching event
     * per type, plus each type's recorded evaluator state (last recorded at +
     * outcome, kept in `_substrat_schedule_state` under `kind = 'freshness'`, which
     * since #1288 is what separates these rows from the schedule rows beside them —
     * the `freshness:` prefix on the key is retained but no longer load-bearing).
     */
    async freshnessProbe(types: string[]): Promise<
      Record<string, { observedAt: string | null; stateAt: string | null; stateOutcome: string | null }>
    > {
      const out: Record<string, { observedAt: string | null; stateAt: string | null; stateOutcome: string | null }> =
        {};
      for (const t of types) out[t] = { observedAt: null, stateAt: null, stateOutcome: null };
      if (types.length === 0) return out;
      // Each list travels as ONE bound JSON array (#1776): a DO binds at most 100 parameters,
      // and nothing caps how many event types the registered modules declare a window for.
      for (const row of this.sql
        .exec(
          `SELECT type, MAX(occurred_at) AS at FROM _substrat_outbox
            WHERE type IN (SELECT value FROM json_each(?)) GROUP BY type`,
          JSON.stringify(types),
        )
        .toArray() as unknown as { type: string; at: string | null }[]) {
        if (row.at !== null) out[row.type]!.observedAt = row.at;
      }
      const keys = types.map((t) => `freshness:${t}`);
      for (const row of this.sql
        .exec(
          `SELECT schedule_op, last_run_at, last_status FROM _substrat_schedule_state
            WHERE kind = 'freshness' AND schedule_op IN (SELECT value FROM json_each(?))`,
          JSON.stringify(keys),
        )
        .toArray() as unknown as { schedule_op: string; last_run_at: string | null; last_status: string | null }[]) {
        const t = row.schedule_op.slice('freshness:'.length);
        if (out[t]) {
          out[t]!.stateAt = row.last_run_at;
          out[t]!.stateOutcome = row.last_status;
        }
      }
      return out;
    }

    /**
     * Write one `_substrat_schedule_state` row (#383). Spine, kernel-written.
     *
     * `kind` is PASSED, never derived from the shape of `unit` (#1288) — deriving it
     * is precisely the convention this column replaced, and it is wrong for the one
     * input that matters: a schedule operation named `freshness:orders.placed` is a
     * schedule row, whatever its key looks like. `unit` is that row's key: a schedule
     * operation (`module/verb`, and then `at`/`status` are when it ran and how it
     * ended) or a freshness key (`freshness:<eventType>`, and then they are when the
     * verdict was recorded and what it was — nothing ran). See the bootstrap DDL.
     *
     * `kind` is LAST because this is a positional RPC — see the interface's own note
     * in `host.ts`. An old DO drops a trailing argument; a leading one it binds, and
     * every value after it lands one column to the left, silently.
     *
     * `invocationId` (#1525) is appended after `kind` for the same reason and defaulted
     * to null, so a coordinator that sends none — every freshness verdict, and every
     * caller predating this argument — records the honest "no call was carried".
     */
    async recordScheduleRun(
      unit: string,
      at: string,
      status: 'ok' | 'failed' | 'skipped',
      kind: ScheduleStateKind,
      invocationId?: string | null,
    ): Promise<void> {
      this.sql.exec(
        `INSERT INTO _substrat_schedule_state (kind, schedule_op, last_run_at, last_status, invocation_id)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, schedule_op) DO UPDATE SET last_run_at = excluded.last_run_at,
                                                      last_status = excluded.last_status,
                                                      invocation_id = excluded.invocation_id`,
        kind,
        unit,
        at,
        status,
        invocationId ?? null,
      );
    }

    // -- the resumable-run driver's store (#1577) -----------------------------
    //
    // D-14's DURABLE driver, and the only half of it that lives in the DO: the run
    // record and the step ledger. Every decision — what coalescing means, when a
    // step is skipped, when a run fails — is in the kernel's `JobRunStore` callers,
    // which the coordinator drives; these are reads and writes and nothing else, so
    // the two drivers cannot disagree about any of it.
    //
    // Each step commits on its OWN round trip rather than the pass batching them at
    // the end. That is what a mid-pass eviction keeps, and a DO is evicted and
    // revived constantly — batching would lose exactly the work resume exists for.

    /**
     * Coalescing, as ONE round trip: the live (`running`) run for this key, or this
     * row inserted and returned.
     *
     * **The single RPC is the atomicity**, and that is the whole reason it is shaped
     * this way rather than as a `jobRunLive` the coordinator follows with a
     * `jobRunInsert`. A Durable Object serializes its RPCs, so the lookup and the
     * insert cannot be interleaved by another caller; split across two calls they
     * can, and two concurrent starts then both find nothing and both insert. The
     * schema carries no unique constraint to catch that, deliberately — a crashed
     * run must stay restartable — so the indivisibility has to come from here.
     */
    async jobRunStartOrJoin(
      moduleId: string,
      job: string,
      instance: string,
      row: JobRunRow,
    ): Promise<JobRunRow> {
      const live =
        (this.sql
          .exec(
            `SELECT * FROM _substrat_job_runs
              WHERE module_id = ? AND job = ? AND instance = ? AND status = 'running'
              ORDER BY id DESC LIMIT 1`,
            moduleId,
            job,
            instance,
          )
          .toArray()[0] as unknown as JobRunRow | undefined) ?? null;
      if (live) return live;
      // `transactionSync`, and the two writes inlined rather than reached through
      // `jobRunInsert`: an `await` between them is an output-gate boundary, and the
      // point of doing this in one RPC is that there is no boundary to be evicted
      // at. Same reason `SCHEDULE_STATE_REBUILD` insists on it.
      this.revision.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO _substrat_job_runs
             (id, module_id, job, instance, payload, status, cursor, counters, attempts,
              last_error, started_at, updated_at, next_attempt_at, ended_at, subject_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id, row.module_id, row.job, row.instance, row.payload, row.status, row.cursor,
          row.counters, row.attempts, row.last_error, row.started_at, row.updated_at,
          row.next_attempt_at, row.ended_at, row.subject_id ?? null,
        );
      });
      return row;
    }

    /**
     * #2034 (#2042 review r1): the FENCE for a coordinator from before leases. Its only caller is
     * that coordinator's drive, which re-reads a run here and then runs the pass WITHOUT claiming
     * it, so a row handed back could run beside a claimed pass. It answers "no such run" to it,
     * always: the old drive skips, and only a coordinator that claims ever drives. Nothing else
     * reads a run through this method (the operator read is `jobRunList`). The coordinator ships in
     * the same script as this class, so an old one exists only for a deploy's overlap.
     */
    async jobRunById(_id: string): Promise<JobRunRow | null> {
      return null;
    }

    /** Insert a fresh run. The coordinator has already refused a non-queue-safe payload. */
    async jobRunInsert(row: JobRunRow): Promise<void> {
      this.sql.exec(
        `INSERT INTO _substrat_job_runs
           (id, module_id, job, instance, payload, status, cursor, counters, attempts,
            last_error, started_at, updated_at, next_attempt_at, ended_at, subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.module_id, row.job, row.instance, row.payload, row.status, row.cursor,
        row.counters, row.attempts, row.last_error, row.started_at, row.updated_at,
        row.next_attempt_at, row.ended_at, row.subject_id ?? null,
      );
    }

    /**
     * Was: `running` runs whose backoff has elapsed, oldest first, after `afterId` — the due read of
     * a coordinator from before #1834, which drove every row it returned. Now always empty (below).
     */
    async jobRunsDue(_now: string, _limit: number, _afterId?: string): Promise<JobRunRow[]> {
      // #2034 (#2042 review r1): fenced, as `jobRunById` is. Its only caller is a coordinator from
      // before #1834, which runs every row this returns without claiming it.
      return [];
    }

    /**
     * #1834: the drive's ONE snapshot of due runs — keys only, in the order they became due
     * (`JOB_RUN_DUE_AT`, then id). Spelled exactly as the pure adapter spells it. A coordinator
     * from before #2034 reads this too, but drives nothing from it: its re-read (`jobRunById`)
     * is fenced.
     */
    async jobRunsDueKeys(now: string, max: number): Promise<JobDueKey[]> {
      return this.sql
        .exec(
          `SELECT id, module_id, job FROM _substrat_job_runs
            WHERE status = 'running' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY ${JOB_RUN_DUE_AT}, id LIMIT ?`,
          now,
          max,
        )
        .toArray() as unknown as JobDueKey[];
    }

    /** The operator read, newest first. */
    async jobRunList(filter: JobRunFilter): Promise<JobRunRow[]> {
      const where: string[] = [];
      const params: (string | number)[] = [];
      for (const [column, value] of [
        ['module_id', filter.moduleId],
        ['job', filter.job],
        ['instance', filter.instance],
        ['status', filter.status],
      ] as const) {
        if (value !== undefined) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      }
      params.push(jobRunListLimit(filter.limit));
      return this.sql
        .exec(
          `SELECT * FROM _substrat_job_runs
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY id DESC LIMIT ?`,
          ...params,
        )
        .toArray() as unknown as JobRunRow[];
    }

    /**
     * Write a pass outcome onto the run row — every column at once.
     *
     * Whole rather than partial, and that is the shape not an accident: a commit
     * writes cursor AND counters AND a cleared error AND a cleared backoff, and a
     * partial update that wrote three of the four would leave a run carrying the
     * last failure's error beside the new cursor, which reads as broken forever.
     */
    async jobRunPatch(id: string, patch: JobRunPatch, owner?: string): Promise<boolean> {
      // A compare-and-set on `running` (#1632) and on the pass's lease (#2034) — see
      // `JOB_RUN_PATCH_SQL`. `owner` is LAST and optional: a coordinator from before leases
      // sends none, and patches the unleased rows it drives.
      return this.sql.exec(JOB_RUN_PATCH_SQL, ...this.jobPatchArgs(id, patch, owner)).rowsWritten > 0;
    }

    private jobPatchArgs(id: string, patch: JobRunPatch, owner: string | undefined) {
      return [
        patch.status, patch.cursor, patch.counters, patch.attempts, patch.lastError,
        patch.updatedAt, patch.nextAttemptAt, patch.endedAt, id, owner ?? null,
      ] as const;
    }

    /**
     * #2034: the claim — `JOB_RUN_CLAIM_SQL`, and whether it took over a lease, read in ONE
     * `transactionSync`: the single round trip is what makes it indivisible, as in
     * `jobRunStartOrJoin`. Null = the run is no longer running and due.
     */
    async jobRunClaim(id: string, owner: string, leaseMs: number): Promise<JobRunClaim | null> {
      return this.revision.transactionSync(() => {
        // #2042 r2, r4: a takeover is charged only when the lease it takes had BEGUN its pass.
        const before = this.sql.exec('SELECT lease_began_at FROM _substrat_job_runs WHERE id = ?', id).toArray()[0] as
          | { lease_began_at: string | null }
          | undefined;
        // #2042 r4: the due test and the expiry are THIS object's clock, never the coordinator's.
        const now = Date.now();
        const at = new Date(now).toISOString();
        const claimed = this.sql
          .exec(JOB_RUN_CLAIM_SQL, owner, new Date(now + leaseMs).toISOString(), at, JOB_LEASE_EXPIRED_NOTE, id, at)
          .toArray()[0] as unknown as JobRunRow | undefined;
        return claimed ? { run: claimed, takeover: (before?.lease_began_at ?? null) !== null } : null;
      });
    }

    /**
     * #2042 r3, r4: an admission miss — `JOB_RUN_MISS_SQL` (the relative count) and
     * `JOB_RUN_MISS_SETTLE_SQL` (the backoff or failure that count calls for) in ONE transaction,
     * by this object's clock. Null = the claim no longer held the run, or had begun.
     */
    async jobRunMiss(id: string, owner: string, note: string): Promise<{ misses: number; failed: boolean } | null> {
      return this.revision.transactionSync(() => {
        const at = new Date(Date.now()).toISOString();
        const counted = this.sql.exec(JOB_RUN_MISS_SQL, at, id, owner).toArray()[0] as
          | { admission_misses: number }
          | undefined;
        if (!counted) return null;
        const o = admissionMissOutcome(counted.admission_misses, at, note);
        this.sql.exec(JOB_RUN_MISS_SETTLE_SQL, o.status, o.nextAttemptAt, o.endedAt, o.lastError, id, counted.admission_misses);
        return { misses: counted.admission_misses, failed: o.status === 'failed' };
      });
    }

    /**
     * #2034 (#2042 r4): BEGIN a claimed pass — `JOB_RUN_BEGIN_SQL`, the commitment point: one
     * compare-and-set judged by this object's clock as it runs, never by a time the coordinator
     * computed. The coordinator invokes the handler if and only if this wrote.
     */
    async jobRunBegin(id: string, owner: string, marginMs: number): Promise<boolean> {
      const now = Date.now();
      return (
        this.sql.exec(JOB_RUN_BEGIN_SQL, new Date(now).toISOString(), id, owner, new Date(now + marginMs).toISOString())
          .rowsWritten > 0
      );
    }

    /**
     * #2034: a step boundary — renew the pass's lease, then read the step's ledger row, in one
     * round trip. A pass that lost its lease reads nothing and stops.
     */
    async jobStepBegin(
      runId: string,
      step: string,
      owner: string,
      leaseMs: number,
    ): Promise<{ held: boolean; row: JobStepRow | null }> {
      // #2042 r4: renewed to this object's now plus the lease.
      const until = new Date(Date.now() + leaseMs).toISOString();
      if (this.sql.exec(JOB_RUN_RENEW_SQL, until, runId, owner).rowsWritten === 0) return { held: false, row: null };
      return { held: true, row: this.stepRow(runId, step) };
    }

    /**
     * One step's ledger row — a non-null `result` is what means completed. Not called by a
     * coordinator since #2034 (`jobStepBegin` reads it while renewing); kept for one a deploy behind.
     */
    async jobStepRow(runId: string, step: string): Promise<JobStepRow | null> {
      return this.stepRow(runId, step);
    }

    private stepRow(runId: string, step: string): JobStepRow | null {
      return (
        (this.sql
          .exec(
            'SELECT step, result, attempts, last_error FROM _substrat_job_steps WHERE run_id = ? AND step = ?',
            runId,
            step,
          )
          .toArray()[0] as unknown as JobStepRow | undefined) ?? null
      );
    }

    /** Record one step attempt. `result` non-null = it completed and must not re-run. */
    async jobStepRecord(
      runId: string,
      step: string,
      result: string | null,
      attempts: number,
      lastError: string | null,
      at: string,
      owner?: string,
      leaseMs?: number,
    ): Promise<boolean> {
      // Only while the run is still `running` (#1632) and the pass holds its lease (#2034),
      // renewing the lease — to this object's now plus `leaseMs` (#2042 r4) — in the same
      // transaction; see `JOB_STEP_RECORD_SQL`. A coordinator from before leases sends neither,
      // holds no lease, and renews nothing.
      return this.revision.transactionSync(() => {
        const until = leaseMs === undefined ? null : new Date(Date.now() + leaseMs).toISOString();
        if (until !== null && this.sql.exec(JOB_RUN_RENEW_SQL, until, runId, owner ?? null).rowsWritten === 0) {
          return false;
        }
        this.sql.exec(JOB_STEP_RECORD_SQL, runId, step, result, attempts, lastError, at, runId, owner ?? null);
        return true;
      });
    }

    /**
     * A COMMITTED pass: the run's new state and the dropping of its step ledger, in
     * ONE RPC so they cannot come apart.
     *
     * Same reasoning as `jobRunStartOrJoin` — the single round trip is the
     * atomicity. As two calls, a stop in between leaves the advanced cursor beside
     * the finished pass's memo rows, and a handler that reuses a step name across
     * passes (legal: the determinism rule binds names to the payload and prior
     * results, not to the cursor) then skips work it never did. The kernel's
     * `runJobPass` carries the full argument.
     */
    async jobCommitPass(id: string, patch: JobRunPatch, owner?: string): Promise<boolean> {
      // `transactionSync` with both statements inline — NOT `await
      // this.jobRunPatch(...)` then the delete. The await is an output-gate
      // boundary, which is precisely the gap this method exists to close.
      return this.revision.transactionSync(() => {
        // #2034: the ledger goes only with a patch that applied — a stale holder's commit must
        // not empty the ledger of the pass that took the run over.
        if (this.sql.exec(JOB_RUN_PATCH_SQL, ...this.jobPatchArgs(id, patch, owner)).rowsWritten === 0) return false;
        this.sql.exec('DELETE FROM _substrat_job_steps WHERE run_id = ?', id);
        return true;
      });
    }

    // -- guards (K-17) --------------------------------------------------------

    /** This scope's spine, read under whatever transaction the caller already opened. */
    private versionAt(ref: EntityRef): EntityVersion | null {
      const q = entityVersionQuery(ref);
      return entityVersionOf(this.sql.exec(q.sql, ...q.params).toArray() as unknown as EntityVersionRow[]);
    }

    private async runGuards(
      operation: string,
      ctx: OperationContext,
      input: unknown,
    ): Promise<void> {
      const declared = this.guards.get(operation);
      if (!declared) return;
      for (const guard of declared) {
        const predicate = this.predicates.get(guard.predicate);
        if (!predicate) {
          throw new Error(
            `unknown guard predicate: '${guard.predicate}' — declared by ${guard.declaredBy} ` +
              `before '${operation}'; no registered module contributes it (operation blocked)`,
          );
        }
        try {
          await predicate.handler(ctx, guard.config, input);
        } catch (err) {
          // #1745: a guard refusing is recorded after the rollback, as a transition is —
          // marked here, where which guard threw is still known. Always rethrown.
          markGuardRefusal(err, guard.predicate, operation);
          throw err;
        }
      }
    }

    // -- migrations (port of applyPendingMigrations) --------------------------

    private ensureMigrations(): Promise<boolean> {
      if (!this.migrationPromise) this.migrationPromise = this.applyPendingMigrations();
      return this.migrationPromise;
    }

    /** Every registered module's derivation plans — what `repairDerivedObjects` and its checks read. */
    private derivedPlans(): DerivedPlans {
      return { state: this.statePlans, lists: this.listPlans, search: this.searchPlans };
    }

    /** A multi-statement script on this DO's own handle, one statement per exec. */
    private runScript(ddl: string): void {
      for (const stmt of splitSqlStatements(ddl)) this.sql.exec(stmt);
    }

    /**
     * #2090: the repair a pass with nothing pending runs, in a transaction of its own. A lost
     * state column fails the scope closed like a failed migration, named by the journaled
     * migration that added the column — the pure host's `repairDerived`.
     */
    private async repairDerived(): Promise<void> {
      try {
        await this.revision.transaction(async () => {
          this.revisionSuspended = true;
          try {
            repairDerivedObjects(doSpineSql(this.sql), (ddl) => this.runScript(ddl), this.derivedPlans(), {
              after: 'an applied migration',
            });
          } finally {
            this.revisionSuspended = false;
          }
        });
      } catch (err) {
        const version = err instanceof StateColumnLost ? err.migration : 'kernel@derived-objects';
        this.lastFailure = { version, error: (err as Error).message };
        throw migrationFailedError(version, (err as Error).message);
      }
    }

    /** Resolves true if this call applied at least one migration. */
    private async applyPendingMigrations(): Promise<boolean> {
      const { pending, diverged } = await planMigrations(this.modules.values(), this.applied);
      if (diverged) {
        // Recorded as a failed migration is, so the coordinator projects it the same way.
        this.lastFailure = diverged;
        throw migrationFailedError(diverged.version, diverged.error);
      }
      if (pending.length === 0) {
        // #2090: once per pass — so once per wake, and on every `retryMigrations` — check and
        // repair what the kernel derived onto the tables. Their migrations are journaled and will
        // never run again, so this is what reaches a scope stripped before the pass checked.
        await this.queue.enqueue(async () => this.repairDerived());
        return false;
      }
      this.migrationRuns += 1;
      await this.queue.enqueue(async () => {
        // #286: bookmark the instant before an UPGRADE migrates live data — the
        // backout's rewind point. Skipped on first provision (`applied` empty: an
        // empty scope has nothing to rewind to) and where PITR does not exist
        // (local dev, miniflare — the API is production-plane only). Taken inside
        // the queue so no writer can slip between the bookmark and the migration,
        // and committed immediately: if the migration below FAILS, the bookmark
        // row is precisely what survives to back out to.
        const storage = this.ctx.storage as unknown as {
          getCurrentBookmark?: () => Promise<string>;
        };
        if (this.applied.size > 0 && typeof storage.getCurrentBookmark === 'function') {
          try {
            const bookmark = await storage.getCurrentBookmark();
            this.sql.exec(
              `INSERT OR IGNORE INTO _substrat_migration_bookmarks (bookmark, taken_at, pending)
               VALUES (?, ?, ?)`,
              bookmark,
              new Date().toISOString(),
              JSON.stringify(pending.map((p) => `${p.moduleId}@${p.migration.version}`)),
            );
          } catch {
            // A failed bookmark must not block the migration: the scope would fail
            // closed over a safety net, which protects nothing. The backup path
            // (#278) remains the fallback rewind point.
          }
        }
        for (const [i, { moduleId, migration, digest, authored }] of pending.entries()) {
          const key = `${moduleId}@${migration.version}`;
          if (this.applied.has(key)) continue;
          let recorded: string | null = digest;
          try {
            await this.revision.transaction(async () => {
              const already = this.sql
                .exec(
                  'SELECT sql_digest FROM _substrat_migrations WHERE module_id = ? AND version = ?',
                  moduleId,
                  migration.version,
                )
                .toArray()[0] as { sql_digest: string | null } | undefined;
              if (already) {
                // Applied since this pass read the journal: held to the same digest rule.
                const error = migrationDivergence(already.sql_digest, digest, authored);
                if (error) throw new Error(error);
                recorded = already.sql_digest;
              } else {
                const started = performance.now();
                const before = (this.sql.exec('SELECT total_changes() AS n').toArray()[0] as { n: number }).n;
                // #1898, #2066: a migration runs on this DO's own handle, not `ctx.sql`, so the
                // spine rules a migration is held to are applied here.
                assertMigrationSql(migration.sql, { key, digest, authored });
                // #1722: not counted per statement, so `total_changes()` measures the migration
                // alone. The journal row below is a write, and advances the revision once.
                this.revisionSuspended = true;
                try {
                  this.runScript(migration.sql);
                  // #2090: the state columns this migration must have left, and after the last of
                  // the pass, the triggers and indexes a create-copy-rename rebuild dropped.
                  const last = i === pending.length - 1;
                  afterMigration(doSpineSql(this.sql), (ddl) => this.runScript(ddl), this.derivedPlans(), key, last);
                } finally {
                  this.revisionSuspended = false;
                }
                const after = (this.sql.exec('SELECT total_changes() AS n').toArray()[0] as { n: number }).n;
                this.sql.exec(
                  'INSERT INTO _substrat_migrations (module_id, version, applied_at, duration_ms, rows_changed, sql_digest) VALUES (?, ?, ?, ?, ?, ?)',
                  moduleId,
                  migration.version,
                  new Date().toISOString(),
                  Math.max(0, Math.round(performance.now() - started)),
                  after - before,
                  digest,
                );
              }
            });
          } catch (err) {
            // Retained so the coordinator can project it into the directory without
            // re-parsing the thrown message. The throw stays: `invoke` awaits
            // `ensureMigrations` on every operation and relies on the rejection to
            // fail closed, so resolving here would serve a half-migrated schema.
            // workerd logs this throw as `Uncaught (in promise)` when it leaves an RPC method,
            // as it does every exception an RPC call returns (a dump refusal, a denied check).
            // It is not an unhandled rejection: every caller awaits the memoised promise, and
            // the coordinator records the failure it receives (#1898 review).
            this.lastFailure = { version: key, error: (err as Error).message };
            throw migrationFailedError(key, (err as Error).message);
          }
          this.applied.set(key, recorded);
        }
      });
      return true;
    }

    /**
     * Events of `eventType` this delivery target has not yet consumed (K-22 §4.2).
     *
     * Executors run on the COORDINATOR, not here: they act through `HostAdmin`,
     * which is outside this DO. So the drain is a read here, the effect happens
     * there, and `recordExecutorAttempt` journals it afterwards — claiming before
     * running would make delivery at-most-once and lose an effect on any crash in
     * between.
     *
     * "Not yet consumed" means never attempted, or retrying and now due (#100).
     * Terminal rows — delivered or dead-lettered — are excluded by the join.
     *
     * Decoded per row (#1636). A row that will not decode comes back in `undecodable`,
     * never as an event: the coordinator journals it as a dead letter, and its handler is
     * never handed an event built from stand-ins. The whole list used to be one
     * `rows.map(decode)`, so one bad row threw the executor's pending list on every pass.
     * The journal write stays on the coordinator, beside every other attempt it records —
     * this stays a read.
     */
    pendingExecutorDeliveries(
      deliveryId: string,
      eventType: string,
    ): { events: DomainEvent[]; undecodable: { eventId: string; error: string }[] } {
      const rows = this.sql
        .exec(
          `SELECT o.* FROM _substrat_outbox o
           LEFT JOIN _substrat_deliveries d
             ON d.event_id = o.id AND d.consumer_module = ?
           WHERE o.type = ? AND ${emittedHere('o.')}
             AND (d.event_id IS NULL
                  OR (d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?))
           ORDER BY o.id`,
          deliveryId,
          eventType,
          new Date().toISOString(),
        )
        .toArray() as unknown as OutboxRow[];
      const events: DomainEvent[] = [];
      const undecodable: { eventId: string; error: string }[] = [];
      for (const r of rows) {
        try {
          events.push(domainEventOf(r));
        } catch (err) {
          undecodable.push({ eventId: r.id, error: String(err) });
        }
      }
      return { events, undecodable };
    }

    /**
     * Whether this scope is a copy (#2005) — the classification on its `_substrat_copy_origin` row
     * (#2009), which only the directory's word sets, not a load's events mark. A CP-less
     * coordinator has no directory to read a scope's kind from, so this is how it holds a copy's
     * executor deliveries inert; a coordinator with a directory asks that instead.
     */
    isCopy(): boolean {
      return this.sql.exec(IS_COPY_SQL).toArray().length > 0;
    }

    /** The lifecycle the platform last delivered to this scope (#1713), or null for none. */
    lifecycle(): StoredScopeLifecycle | null {
      return readLifecycle(this.switchSql());
    }

    /**
     * Store a lifecycle the platform delivered (#1713, `writeLifecycle`): kept only when it is not
     * older than the one held. Bookkeeping, like the copy marker: it changes what runs here, not
     * the scope's data, so it does not advance the write revision a carry fences on.
     */
    setLifecycle(
      next: ScopeLifecycle,
      /** #2016: the tenant the directory delivered this lifecycle for. A scope it is foreign to
       *  (`tenantVerdict`) refuses the delivery untouched; one provisioned before the receipt
       *  existed, whose role rows name this tenant, records it — the back-fill. */
      tenantId?: TenantId,
    ): LifecycleDelivery | { refused: 'tenant'; message: string } {
      const { verdict, held } = tenantId === undefined ? { verdict: null, held: null } : this.tenantVerdict(tenantId);
      if (verdict === 'foreign') {
        return { refused: 'tenant', message: `lifecycle delivery ${foreignTenant(held, tenantId!)}` };
      }
      // The back-fill: a scope provisioned before the receipt (its role rows agree), or one whose
      // tenant nothing recorded although it holds data (a load from a world that keeps its roles
      // elsewhere). The directory's word records it; a DO never provisioned here records nothing.
      const backfill = verdict === 'inferred' || (verdict === 'unknown' && this.holdsData());
      let out!: LifecycleDelivery;
      this.revision.transactionSync(() => {
        // A write the carry fences on, not bookkeeping: it happens once per legacy scope, and
        // over-counting only refuses a restore that could have landed. A carried-away copy takes
        // no write at all, so it is left to the next projection.
        if (backfill && !this.carriedAwayCopy) {
          this.sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES (?, ?)`, PROVISIONED_FOR_KEY, tenantId!);
        }
        out = { ...this.revision.bookkeeping(() => writeLifecycle(this.switchSql(), next)), tenantRecorded: this.provisionedFor() !== null };
      });
      return out;
    }

    /** Mark this scope a copy (#2005, `markCopyOrigin`): the repair of a copy that predates the
     *  marker. Answers whether this call stamped it; a store that already reads as a copy is left
     *  as it is, and a load's events mark is never moved (#2009). */
    markCopy(): boolean {
      let marked = false;
      this.revision.transactionSync(() => {
        marked = this.revision.bookkeeping(() => markCopyOrigin(this.switchSql(), new Date().toISOString()));
      });
      return marked;
    }

    /**
     * Clear a mistaken copy classification (#2005, `clearCopyMarker`); a load's events mark stays,
     * so copied work still never runs here (#2009). A
     * clear is a write like any other (Codex #2008 r11), never bookkeeping: it lets the store run
     * work a copy holds inert, so it advances the write revision, and a carry that exported
     * before it cannot wipe the repaired store. That carry's wipe keeps it instead.
     */
    clearCopyMark(
      /** The store the caller means (Codex #2008 r12–r13): the platform's reconcile of the store a
       *  carry landed names that carry's load stamp and the revision it read, so a store another
       *  load has replaced since (a governed restore, whose classification is its own) is refused,
       *  compared here, in the clear's own transaction. Absent for staff's correction. */
      expect?: LoadMarker,
    ): 'cleared' | 'absent' | 'changed' {
      return this.revision.transactionSync(() => {
        const from = this.metaValue(WRITE_REVISION_KEY);
        if (expect && (this.metaValue(LOAD_STAMP_KEY) !== expect.loadStamp || from !== expect.revision)) {
          return 'changed' as const;
        }
        const outcome = clearCopyMarker(this.switchSql());
        // The clear's own revisions, so a carry's refused wipe can tell that this clear, and
        // nothing else, is what changed here since its export (`COPY_MARK_CLEARED_KEY`).
        if (outcome === 'cleared') {
          this.sql.exec(
            `INSERT INTO _substrat_meta (key, value) VALUES (?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            COPY_MARK_CLEARED_KEY,
            JSON.stringify({ from, to: this.metaValue(WRITE_REVISION_KEY) }),
          );
        }
        return outcome;
      });
    }

    /**
     * The same read as a bare list of events, for a coordinator deployed before
     * `pendingExecutorDeliveries` (#1636). An undecodable row is left out rather than
     * thrown, so that pairing still delivers the rows behind it; the next coordinator
     * dead-letters it.
     */
    pendingExecutorEvents(deliveryId: string, eventType: string): DomainEvent[] {
      return this.pendingExecutorDeliveries(deliveryId, eventType).events;
    }

    /**
     * Journal one executor attempt (#100). `error` null means delivered;
     * `nextAttemptAt` null means terminal — so a failed attempt with no next time
     * is a dead letter.
     *
     * Written AFTER the effect, so a crash mid-effect retries rather than silently
     * marking success. The coordinator computes the backoff because it owns the
     * per-executor policy; the DO owns the state.
     *
     * `invocationId` is LAST because this is a positional RPC — the same rule
     * `recordScheduleRun` states. An old DO drops a trailing argument; a leading one
     * it binds, and every value after it lands one column to the left, silently.
     */
    recordExecutorAttempt(
      eventId: string,
      deliveryId: string,
      error: string | null,
      nextAttemptAt: string | null,
      /**
       * #1525: the call THIS attempt ran in, or null. Passed rather than read off
       * `this.invocationId`, and here there is no choice about it: executors run on
       * the COORDINATOR, so by the time this RPC arrives the queued body that held
       * the id has long returned and the field reads null. The coordinator is the
       * only side that knows, which is why the SQLite twin passes it too — a recorded
       * fact whose correctness argument differs per adapter is the kind that drifts.
       *
       * Defaulted, for the other half of the skew: a coordinator too old to pass it
       * calls this with four arguments, and `undefined` is not a value SQLite binds.
       * Null is the honest answer there anyway — that coordinator recorded no call.
       */
      invocationId: string | null = null,
    ): number {
      const prior = (
        this.sql
          .exec(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
            eventId,
            deliveryId,
          )
          .toArray() as unknown as { attempts: number }[]
      )[0];
      const attempts = (prior?.attempts ?? 0) + 1;
      this.sql.exec(
        `INSERT INTO _substrat_deliveries
           (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at,
            invocation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, consumer_module) DO UPDATE SET
           delivered_at = excluded.delivered_at,
           error = excluded.error,
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           -- #1525: overwritten, like the four above. The row describes the LATEST
           -- attempt, so a retry drained by a different call (or by none) must not
           -- keep claiming the call that made the first one.
           invocation_id = excluded.invocation_id`,
        eventId,
        deliveryId,
        new Date().toISOString(),
        error,
        attempts,
        nextAttemptAt,
        // #1525: the call this attempt ran in, as the coordinator named it.
        invocationId,
      );
      return attempts;
    }

    /** How many attempts this delivery has already had — the backoff input. */
    executorAttempts(eventId: string, deliveryId: string): number {
      const row = (
        this.sql
          .exec(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
            eventId,
            deliveryId,
          )
          .toArray() as unknown as { attempts: number }[]
      )[0];
      return row?.attempts ?? 0;
    }

    /**
     * Pending platform intents (platform-intents.md) — rows a vertical enqueued via
     * `ctx.requestPlatform` awaiting the platform's drain. Read here; executed on the coordinator
     * with HostAdmin authority (the DO cannot provision); `settlePlatformRequest` journals the
     * outcome afterwards, exactly the executor-drain shape (read here, effect there).
     */
    pendingPlatformRequests(): PlatformRequestRawRow[] {
      return this.sql
        .exec(
          `SELECT ${PLATFORM_REQUEST_COLUMNS}
             FROM _substrat_platform_requests WHERE status = 'pending' ORDER BY id`,
        )
        .toArray() as unknown as PlatformRequestRawRow[];
    }

    /**
     * The intent JOURNAL, newest first (#618) — every intent whatever became of it, where
     * `pendingPlatformRequests` deliberately returns only the drainable ones. A settled row keeps
     * its `last_error` verbatim, and this is the only RPC that hands that back: before it, the full
     * text of a connector's refusal was reachable only through the read-only SQL console with
     * system tables toggled on. The filter/ordering come from the kernel so the DO, the host and
     * `ctx.platformRequests` cannot disagree about what "newest 50 of this kind" means.
     */
    platformRequestHistory(filter?: PlatformRequestFilter): PlatformRequestRawRow[] {
      const q = platformRequestHistoryQuery(filter);
      return this.sql
        .exec(q.sql, ...q.params)
        .toArray() as unknown as PlatformRequestRawRow[];
    }

    /**
     * Journal a platform-request outcome after the coordinator ran it. `status`: 'done' (succeeded),
     * 'failed' (terminal — unknown kind or given up), or 'pending' (transient failure, will retry).
     * `result` is COALESCE'd so a value written on an earlier pass (e.g. a minted sibling scope id,
     * for two-phase idempotency) survives a null on retry. `attempts` bumps each settle; `settled_at`
     * is set only on a terminal outcome.
     *
     * **Compare-and-set on `pending` (#1600 review).** The drain reads pending rows, runs a
     * handler, then settles — and between the read and the settle a subject erasure can redact
     * the row. Settling by `id` alone let that stale pass overwrite the redaction and write a
     * provider's reply, which can quote the person, back into `last_error`. Nothing legitimate
     * is refused: `pendingPlatformRequests` returns only pending rows, so every settle targets
     * one that was pending when it was read. A settle that finds the row already terminal does
     * nothing, deliberately silently — throwing would make the drain's blanket catch retry a
     * row that is correctly over.
     */
    settlePlatformRequest(
      id: string,
      status: 'pending' | 'done' | 'failed',
      result: string | null,
      lastError: string | null,
      lastFailure: string | null = null,
    ): void {
      this.sql.exec(
        `UPDATE _substrat_platform_requests
           SET status = ?, result = COALESCE(?, result), last_error = ?, last_failure = ?,
               attempts = attempts + 1, settled_at = ?
         WHERE id = ? AND status = 'pending'`,
        status,
        result,
        lastError,
        lastFailure,
        status === 'pending' ? null : new Date().toISOString(),
        id,
      );
    }

    /**
     * Turn one connector delivery into a `connector:<provider>` platform intent (#574
     * phase 3) — the CP-less host's substitute for running the handler it cannot run.
     * One verb, not two, so the intent insert and the delivery journal commit together:
     * everything here is synchronous SQL in a single RPC, so a crash leaves either both
     * writes or neither, never an intent without its journal row (which would re-route
     * the event on the next drain). Backpressure throws BEFORE any write — the caller
     * records a failed attempt and the delivery retries on its own backoff, exactly as
     * a throwing handler would.
     *
     * `invocationId` is LAST, and defaulted, for the RPC-skew reason `recordExecutorAttempt`
     * states at length.
     */
    routeExecutorEventToPlatform(
      eventId: string,
      deliveryId: string,
      kind: string,
      payload: string,
      requestedBy: string,
      /**
       * #1525: the call this routing ran in, or null. On the hosted path this is the
       * dominant executor journal — every vertical is CP-less, so a connector delivery
       * becomes an intent here rather than running in `recordExecutorAttempt`'s caller —
       * so leaving it null would make the column read "no call" for the common case.
       */
      invocationId: string | null = null,
    ): PlatformRequestId {
      const pending = Number(
        (
          this.sql
            .exec(`SELECT COUNT(*) AS c FROM _substrat_platform_requests WHERE status = 'pending'`)
            .toArray()[0] as { c: number }
        ).c,
      );
      if (pending >= MAX_PENDING_PLATFORM_REQUESTS) {
        throw new Error(
          `too many pending platform requests (${pending}); the delivery retries once some have drained`,
        );
      }
      const id = platformRequestId.parse(ulid());
      // K-42: the intent inherits the SOURCE EVENT's stamp rather than being written
      // unstamped. Nobody is impersonating at this moment — the drain runs long after
      // the session's invoke returned — but the intent exists BECAUSE of an event that
      // was raised under one, and the platform drain is where an operator asks who
      // caused an outbound effect. Read here rather than passed over the RPC: the DO
      // owns the outbox, so a coordinator cannot claim a stamp or drop one.
      const source = this.sql
        .exec('SELECT impersonation FROM _substrat_outbox WHERE id = ?', eventId)
        .toArray()[0] as { impersonation: string | null } | undefined;
      this.sql.exec(
        `INSERT INTO _substrat_platform_requests
           (id, kind, payload, requested_by, impersonation, status, attempts, requested_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
        id,
        kind,
        payload,
        requestedBy,
        source?.impersonation ?? null,
        instant.parse(new Date().toISOString()),
      );
      this.recordExecutorAttempt(eventId, deliveryId, null, null, invocationId);
      return id;
    }

    /**
     * #1232: a CP-less pass's ONLY exit for its schedule outcomes — `admin.recordSweepRun`
     * is a control-plane write the null-CP proxy refuses. One batched intent per pass,
     * under its own low sub-cap, and a full journal DROPS the report (null) instead of
     * throwing: telemetry must never sink a pass, and must never starve the shared
     * 32-slot budget a provision-sibling needs. The next drained pass reports again.
     */
    enqueueSweepRuns(payload: string, requestedBy: string): PlatformRequestId | null {
      const counts = this.sql
        .exec(
          `SELECT COUNT(*) AS c, SUM(CASE WHEN kind = ? THEN 1 ELSE 0 END) AS k
             FROM _substrat_platform_requests WHERE status = 'pending'`,
          SWEEP_RUNS_KIND,
        )
        .toArray()[0] as { c: number; k: number | null };
      if (counts.c >= MAX_PENDING_PLATFORM_REQUESTS || (counts.k ?? 0) >= MAX_PENDING_SWEEP_RUNS) {
        return null;
      }
      const id = platformRequestId.parse(ulid());
      this.sql.exec(
        `INSERT INTO _substrat_platform_requests
           (id, kind, payload, requested_by, impersonation, status, attempts, requested_at)
         VALUES (?, ?, ?, ?, NULL, 'pending', 0, ?)`,
        id,
        SWEEP_RUNS_KIND,
        payload,
        requestedBy,
        instant.parse(new Date().toISOString()),
      );
      return id;
    }

    /** Executor deliveries that exhausted their attempts. */
    executorDeadLetters(): {
      eventId: string;
      executorId: string;
      eventType: string;
      attempts: number;
      error: string;
      lastAttemptAt: string;
    }[] {
      const rows = this.sql
        .exec(
          `SELECT d.event_id, d.consumer_module, d.attempts, d.error, d.delivered_at, o.type
           FROM _substrat_deliveries d
           JOIN _substrat_outbox o ON o.id = d.event_id
           WHERE d.consumer_module LIKE 'executor:%'
             AND d.error IS NOT NULL
             AND d.next_attempt_at IS NULL
           ORDER BY d.event_id`,
        )
        .toArray() as unknown as {
        event_id: string;
        consumer_module: string;
        attempts: number;
        error: string;
        delivered_at: string;
        type: string;
      }[];
      return rows.map((r) => ({
        eventId: r.event_id,
        executorId: r.consumer_module.slice('executor:'.length),
        eventType: r.type,
        attempts: r.attempts,
        error: r.error,
        lastAttemptAt: r.delivered_at,
      }));
    }

    // -- read-only introspection (kernel-design §5.4's admin-query RPC) --------
    // The console/dashboard "Data" view reaches THIS scope's own SQLite. Read-only
    // and table-shaped: no caller SQL, only a table name validated against the live
    // schema plus a bounded page, so nothing here can write the spine or inject.
    // Authorization + the (tenantId, scopeId) K-3 cross-check happen on the
    // coordinator BEFORE this RPC is reached (host.ts admin.listScopeTables).

    /** Every table in this scope's DB, with row counts; spine/internal tables flagged. */
    introspectTables(): ScopeTable[] {
      const names = (
        this.sql
          .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' ORDER BY name`)
          .toArray() as unknown as { name: string }[]
      ).map((r) => r.name);
      return names.map((name) => ({
        name,
        rowCount: Number(
          (this.sql.exec(`SELECT COUNT(*) AS c FROM "${name}"`).toArray()[0] as { c: number }).c,
        ),
        system: isSystemTable(name),
      }));
    }

    /** A bounded page of one table. Unknown table names throw — never queried blind. Kept for a
     *  coordinator from before #113; the current one calls `introspectTableReply`. */
    introspectTable(table: string, limit: number, offset: number): ScopeTablePage {
      try {
        return this.tablePage(table, limit, offset);
      } catch (e) {
        throw toRpcError(e);
      }
    }

    /** `introspectTable`, its refusal answered as DATA so its code survives the hop (#113). */
    introspectTableReply(table: string, limit: number, offset: number): Promise<DoReply<ScopeTablePage>> {
      return replyOf(() => this.tablePage(table, limit, offset));
    }

    private tablePage(table: string, limit: number, offset: number): ScopeTablePage {
      const known = new Set(
        (
          this.sql
            .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*'`)
            .toArray() as unknown as { name: string }[]
        ).map((r) => r.name),
      );
      if (!known.has(table)) throw substratError('not_found', `unknown table '${table}'`);
      // The ceiling clamps; a bound SQLite would misread (NaN, non-finite, fractional,
      // negative) is refused instead of reaching LIMIT / OFFSET (#1632).
      const l = Math.min(assertRowLimit('limit', limit), SCOPE_TABLE_PAGE_MAX);
      const o = assertRowOffset('offset', offset);
      const cursor = this.sql.exec(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, l, o);
      const columns = cursor.columnNames;
      const rows = Array.from(cursor.raw(), (row) => (row as unknown[]).map(cellToJson));
      const rowCount = Number(
        (this.sql.exec(`SELECT COUNT(*) AS c FROM "${table}"`).toArray()[0] as { c: number }).c,
      );
      return { table, columns, rows, rowCount, limit: l, offset: o };
    }

    /**
     * One read-only SQL statement against this scope's DB — the console (#219). User
     * SQL reaches `exec` here, so read-only-ness is enforced in two layers: the
     * kernel's shared textual gate (single statement, read verbs only — the same
     * rejections as the pure adapter), and, because DO `exec` has no read-only flag
     * (no sqlite3_stmt_readonly analogue), a transaction that ALWAYS rolls back — a
     * statement the gate misclassified still cannot persist a write. Rows are capped
     * at SCOPE_QUERY_ROW_MAX with `truncated` set, never an error.
     * Kept for a coordinator from before #113; the current one calls `introspectQueryReply`.
     */
    async introspectQuery(sql: string): Promise<ScopeQueryResult> {
      try {
        return await this.readOnlyQuery(sql);
      } catch (e) {
        throw toRpcError(e);
      }
    }

    /** `introspectQuery`, its refusal answered as DATA so its code survives the hop (#113). */
    introspectQueryReply(sql: string): Promise<DoReply<ScopeQueryResult>> {
      return replyOf(() => this.readOnlyQuery(sql));
    }

    private async readOnlyQuery(sql: string): Promise<ScopeQueryResult> {
      const stmt = assertReadOnlyQuery(sql);
      let result: ScopeQueryResult | undefined;
      const rollback = new Error('read-only console rollback');
      try {
        await this.revision.transaction(async () => {
          const cursor = this.sql.exec(stmt);
          const columns = cursor.columnNames;
          const rows: unknown[][] = [];
          let truncated = false;
          for (const row of cursor.raw()) {
            if (rows.length >= SCOPE_QUERY_ROW_MAX) {
              truncated = true;
              break;
            }
            rows.push((row as unknown[]).map(cellToJson));
          }
          result = { columns, rows, truncated };
          // Thrown on success too: the transaction must never commit.
          throw rollback;
        });
      } catch (e) {
        if (e !== rollback) throw e;
      }
      return result!;
    }

    // -- the denial log (K-35, #867) ------------------------------------------
    // The refusals recorded in THIS scope's own database, read back. Authorization and
    // the (tenantId, scopeId) K-3 cross-check happen on the coordinator before these
    // RPCs are reached, exactly as for the introspection reads above.

    /** A bounded page of raw denial rows, newest first. */
    listDenials(filter?: DenialFilter): PermissionDenial[] {
      const q = denialListQuery(filter);
      return (
        this.sql.exec(q.sql, ...q.params).toArray() as unknown as DenialRow[]
      ).map(mapDenialRow);
    }

    /**
     * #1745: the refusal log — every lifecycle move refused and failed with, recorded after
     * the rollback. Authorization and the K-3 cross-check happen on the coordinator first.
     */
    listRefusals(filter?: RefusalFilter): RefusalRecord[] {
      const q = refusalListQuery(filter);
      return (
        this.sql.exec(q.sql, ...q.params).toArray() as unknown as RefusalDbRow[]
      ).map(mapRefusalRow);
    }

    /**
     * The same log bucketed per (actor, permission) — or per operation when the filter
     * says `groupBy: 'operation'` (#1456) — with the window's own facts.
     */
    summarizeDenials(filter?: DenialFilter): DenialSummary {
      const b = denialSummaryQuery(filter);
      const grouped = mapDenialSummaryBuckets(b.groupBy, this.sql.exec(b.sql, ...b.params).toArray());
      const t = denialTotalsQuery(filter);
      const totals = this.sql.exec(t.sql, ...t.params).toArray()[0] as unknown as {
        total: number;
        actors: number;
      };
      // Unfiltered on purpose — these describe the log, not the query (denial-query.ts).
      const w = this.sql.exec(DENIAL_WINDOW_QUERY).toArray()[0] as unknown as DenialWindowRow;
      return {
        ...grouped,
        total: Number(totals.total),
        actors: Number(totals.actors),
        windowOldestAt: w.oldest_at ?? null,
        windowNewestAt: w.newest_at ?? null,
        drained: Number(w.drained ?? 0),
      };
    }

    /**
     * A COMPLETE dump of this scope's DB (preview-and-snapshots.md §3) — every table
     * (incl. the `_substrat_*` spine), its DDL, and every row. No `.backup()` on DO
     * SQLite, so this is the logical row-dump; safe because the DO is single-threaded
     * (a consistent snapshot, no concurrent writer). The coordinator wraps these tables
     * with the scope's identity after the K-3 check (host.ts admin.exportScope).
     */
    exportDump(): ScopeDumpTable[] {
      // The derived search index (#827) is excluded: its shadow tables cannot be
      // replayed — this host answers "object name reserved for internal use" — and
      // it is recomputable, so `importDump` rebuilds it from the loaded rows. A dump
      // carries the rows, never the index over them.
      const defs = (
        this.sql
          .exec(
            `SELECT name, sql FROM sqlite_master
              WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND sql IS NOT NULL
              ORDER BY name`,
          )
          .toArray() as unknown as { name: string; sql: string }[]
      ).filter(({ name }) => !isSearchIndexTable(name));
      return defs.map(({ name, sql }) => {
        // Raw positional rows, cells as-is (blobs kept as bytes, not nulled like a UI
        // read) so the dump reloads faithfully. The name is from the live schema.
        // #1722: the load stamp and the write revision describe THIS store, so they never leave
        // in a dump (`exportDumpStamped` hands the stamp over beside one); every load writes its own.
        const cursor =
          name === '_substrat_meta'
            ? this.sql.exec(
                `SELECT * FROM "${name}" WHERE key NOT IN (${STORE_LOCAL_META_KEYS.map(() => '?').join(', ')})`,
                ...STORE_LOCAL_META_KEYS,
              )
            : this.sql.exec(`SELECT * FROM "${name}"`);
        const columns = cursor.columnNames;
        const rows = Array.from(cursor.raw(), (row) => row as unknown[]);
        return { name, ddl: sql, columns, rows };
      });
    }

    /**
     * `exportDump`, with the store's load stamp read in the same call (#1722): the stamp a
     * carry's fenced wipe of this copy later expects. A store no load has stamped gets one now,
     * so the stamp handed out is present exactly while nothing has been loaded here since. One
     * synchronous method, so no load can land between the dump and the stamp.
     */
    exportDumpStamped(): { tables: ScopeDumpTable[]; loadStamp: string | null; revision: string | null } {
      let stamp = this.loadStamp();
      // A wiped copy takes no write, a stamp included; the carry refuses its tombstone anyway.
      if (!stamp && !this.carriedAwayCopy) {
        stamp = ulid();
        this.sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES (?, ?)`, LOAD_STAMP_KEY, stamp);
      }
      // Read after the stamp's own write, so it is the revision the store holds as it is dumped.
      return { tables: this.exportDump(), loadStamp: stamp, revision: this.metaValue(WRITE_REVISION_KEY) };
    }

    /**
     * Load a dump into this (freshly-provisioned) scope — the write half of the fork
     * (host.ts importScope). Drop-then-replay: the provisioning schema is wiped and rebuilt,
     * a vertical's tables from the dump's DDL and the `_substrat_*` spine from KERNEL_DDL
     * (#1883), then the dump's rows go back in.
     *
     * `destScopeId` is the scope being written INTO. A dump carries scope-level tuples
     * naming the scope it was captured from, so restoring one anywhere else needs them
     * re-pointed — see `rewriteScopeTuples`.
     *
     * What the dump did NOT carry is rebuilt by the next migration pass, which is why
     * this ends by forgetting the memoised one (#1589) — see the tail of the method.
     */
    /**
     * The additive spine-column migrations. KERNEL_DDL is all IF NOT EXISTS, so a
     * scope DO created before a column keeps the old shape until this runs on its next
     * wake. `importDump` runs it too, after rebuilding the spine from KERNEL_DDL: there every
     * ALTER is a duplicate, since a restore never brings a legacy spine table (#1883), but the
     * pass also creates `_substrat_outbox_invocation`, which KERNEL_DDL deliberately does not
     * and the restore's DROP of the outbox took with it. Attempt-and-tolerate: DO SQLite restricts PRAGMA, so there
     * is no column probe, and a duplicate is the steady state after the first cold
     * start (same argument as ControlPlaneDO.addColumn).
     */
    private applySpineColumnAdditions(): void {
      // Every column here is nullable with no DEFAULT (`attempts` is grandfathered): a restore may
      // have added it bare already, and then this ALTER is skipped as a duplicate (#1883).
      // `lint:spine-ddl` refuses one that is not.
      for (const alter of [
        // #1763: rows written before these fields keep NULL, meaning unrecorded.
        'ALTER TABLE _substrat_migrations ADD COLUMN duration_ms INTEGER',
        'ALTER TABLE _substrat_migrations ADD COLUMN rows_changed INTEGER',
        // #2066: the rows already there get the legacy mark below, never a digest.
        'ALTER TABLE _substrat_migrations ADD COLUMN sql_digest TEXT',
        'ALTER TABLE _substrat_tuples ADD COLUMN revoked_at TEXT',
        // #1632: legacy runs retain an unknown subject; no content-based backfill.
        'ALTER TABLE _substrat_job_runs ADD COLUMN subject_id TEXT',
        // #2034: the lease. NULL = nobody holds the run, which is right for every row already there.
        'ALTER TABLE _substrat_job_runs ADD COLUMN lease_owner TEXT',
        // #2042 r2, r4: whether the holder BEGAN its pass. NULL for any lease already there: free to take over.
        'ALTER TABLE _substrat_job_runs ADD COLUMN lease_began_at TEXT',
        // #2042 r3: consecutive admission misses. NULL = none, right for every run already there.
        'ALTER TABLE _substrat_job_runs ADD COLUMN admission_misses INTEGER',
        // Executor retry state (#100). The defaults read as "terminal", which is
        // right for every row already there: each is a completed delivery or a
        // consumer dead-letter.
        'ALTER TABLE _substrat_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE _substrat_deliveries ADD COLUMN next_attempt_at TEXT',
        // #1525: the invocation an attempt ran in, on a scope DO created before the
        // column. Nullable, and the null is honestly "no call was carried" — which
        // attempt produced a delivery already journalled cannot be decided afterwards,
        // exactly as #1237's outbox column argued.
        'ALTER TABLE _substrat_deliveries ADD COLUMN invocation_id TEXT',
        // K-34: the authorization column on a scope DO created before it existed. Nullable,
        // so legacy outbox rows read as "unrecorded". (_substrat_denials is a new table,
        // covered by KERNEL_DDL's IF NOT EXISTS with no ALTER.)
        'ALTER TABLE _substrat_outbox ADD COLUMN authorization TEXT',
        // #841: refusal attribution on a scope DO that predates it. Nullable, so an
        // intent settled before this column reads as "nobody classified this" rather
        // than claiming an origin the drain never decided.
        'ALTER TABLE _substrat_platform_requests ADD COLUMN last_failure TEXT',
        // K-42: the two-actor stamp on the three spine tables that record who did
        // what, for a scope DO created before impersonation existed. Nullable
        // everywhere, and the null means "nobody was impersonating" rather than
        // "unrecorded" — every one of those rows predates the possibility.
        'ALTER TABLE _substrat_outbox ADD COLUMN impersonation TEXT',
        'ALTER TABLE _substrat_platform_requests ADD COLUMN impersonation TEXT',
        'ALTER TABLE _substrat_denials ADD COLUMN impersonation TEXT',
        // #1525: the invocation a refusal happened during, on a scope DO created before
        // the column. Nullable, and the null is honestly "no id was carried" — a past
        // denial's call cannot be decided afterwards, as #1237's outbox column argued.
        'ALTER TABLE _substrat_denials ADD COLUMN invocation_id TEXT',
        // #1231: the emitting operation, on a scope DO created before the column.
        // Nullable so every legacy row reads as unrecorded rather than named.
        'ALTER TABLE _substrat_outbox ADD COLUMN operation TEXT',
        // #1242: the signals `version` dimension on the outbox, for a scope DO
        // created before the column. NULL stays honest — unstamped.
        'ALTER TABLE _substrat_outbox ADD COLUMN version TEXT',
        // #1237: the cause column on a scope DO created before it. Nullable, and the
        // null is honestly "unrecorded" for every legacy row — nothing can go back and
        // decide what a past consumer was reacting to.
        'ALTER TABLE _substrat_outbox ADD COLUMN caused_by TEXT',
        // #1237: the invocation column on a DO created before it. Nullable, and the
        // null is honestly "none was carried" for every legacy row.
        'ALTER TABLE _substrat_outbox ADD COLUMN invocation_id TEXT',
        // #1525: the invocation a fired schedule ran in, on a scope DO created before
        // the column. Nullable, and the null is honestly "no call was carried" for
        // every legacy row — a past run's id cannot be recovered afterwards, exactly
        // as the other #1525 columns above argued.
        'ALTER TABLE _substrat_schedule_state ADD COLUMN invocation_id TEXT',
        // #2009: the copy classification on a scope DO built before it (NULL reads as a copy;
        // see `COPY_ORIGIN_DDL`).
        'ALTER TABLE _substrat_copy_origin ADD COLUMN is_copy INTEGER',
      ]) {
        try {
          this.sql.exec(alter);
        } catch (err) {
          if (!/duplicate column name/i.test((err as Error).message)) throw err;
        }
      }
      // #1237: `readInvocation`'s lookup — WHERE invocation_id = ? ORDER BY id — over an outbox
      // that is never pruned. No index leads with invocation_id, so without this one SQLite
      // walks the PRIMARY KEY from the oldest event until it reaches the call, and reading a
      // recent invocation costs the scope's lifetime event count. The trailing id gives the
      // ORDER BY for free, as it does on `_substrat_outbox_drained`.
      //
      // HERE, after the column is ensured, and deliberately NOT in KERNEL_DDL beside the
      // other outbox indexes. KERNEL_DDL runs FIRST on every wake, and on a scope created
      // before #1237 its `CREATE TABLE IF NOT EXISTS` does not add the column — so an index
      // naming invocation_id there throws "no such column" and every existing scope fails to
      // boot. `lint:spine-ddl` compares KERNEL_DDL's indexes only, so this one is held to
      // both adapters by the query-plan test rather than by that gate.
      this.sql.exec('CREATE INDEX IF NOT EXISTS _substrat_outbox_invocation ON _substrat_outbox (invocation_id, id)');
      // #2066: what they ran was never measured. KERNEL_DDL's fence keeps any other NULL out.
      this.sql.exec(MIGRATION_DIGEST_MARK_LEGACY);
      this.ensureScheduleStateKind();
      this.ensureRefusalsAdmitGuards();
    }

    /**
     * #1745: `_substrat_refusals`, rebuilt to admit a guard row (a nullable `from_state`, plus
     * `guard` and `reason`) on a scope DO whose table predates it.
     */
    private ensureRefusalsAdmitGuards(): void {
      this.rebuildIfStale('_substrat_refusals', refusalsAdmitGuards, REFUSALS_REBUILD);
    }

    /**
     * #1288: `_substrat_schedule_state`, rebuilt with `kind` in its key on a scope DO
     * whose table predates the column. Not in the ALTER list above, because `kind`
     * joins the PRIMARY KEY and no ALTER can widen a key — the statements are the
     * kernel's, so the pure adapter rebuilds byte-identically.
     *
     * Detected from `sqlite_master.sql`: DO SQLite restricts `PRAGMA`, and reading
     * the stored DDL is the one probe both adapters can make.
     */
    private ensureScheduleStateKind(): void {
      this.rebuildIfStale('_substrat_schedule_state', scheduleStateHasKind, SCHEDULE_STATE_REBUILD);
    }

    /**
     * Run a kernel create-copy-drop-rename `script` over `table` when the stored DDL fails
     * `isCurrent` — the one shape `ensureScheduleStateKind` and `ensureRefusalsAdmitGuards`
     * share, so the pure adapter's twin rebuilds byte-identically.
     */
    private rebuildIfStale(table: string, isCurrent: (tableSql: string) => boolean, script: string): void {
      const row = this.sql
        .exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
        .toArray()[0] as { sql: string } | undefined;
      if (!row || isCurrent(row.sql)) return;
      // In a transaction, for the reason the kernel constants spell out: create-copy-
      // drop-rename has two intermediate states and both are unrecoverable on the next
      // wake. `transactionSync`, not the async one every operation uses — the DO
      // runtime forbids a manual BEGIN through `sql.exec`, and this body is wholly
      // synchronous, which is the one case the sync API is for (it commits at the
      // first await, and there is none). It also has to be sync because the caller is.
      this.revision.transactionSync(() => {
        for (const stmt of splitSqlStatements(script)) this.sql.exec(stmt);
      });
    }

    async importDump(
      tables: ScopeDumpTable[],
      destScopeId?: ScopeId,
      {
        switchOff,
        sourceScopeId,
        exact,
        loadStamp,
        expect,
        resolveKept,
        markCopy,
        provisionedFor,
      }: {
        /** The directory's recorded-off modules (#1742), switched off on `destScopeId` right after
         *  the replay re-points the grants, in the same event: a dump from before the switch was
         *  pulled carries the grants live and no marker. Needs `destScopeId`, the scope restored. */
        switchOff?: RecordedOffCarry & { at: string };
        /** The scope the dump was captured FROM (#1869), whose grants the re-point moves. */
        sourceScopeId?: ScopeId;
        /** The platform exported this dump itself, so the re-point never falls back (`RepointSource`). */
        exact?: boolean;
        /** #1722: the stamp this load leaves (`LOAD_STAMP_KEY`) — a carry names one, so the copy
         *  it lands can later be wiped under a fence. Without one, a load leaves no stamp. */
        loadStamp?: string;
        /** #1722: load only if this store still holds this load stamp (null: none) and, when
         *  `revision` is given, this write revision (null: never written). Compared inside the
         *  load's transaction, before the first drop; a mismatch throws `precondition_failed`
         *  and the store is untouched. */
        expect?: { loadStamp: string | null; revision?: string | null };
        /** #1722: the staff resolution of a kept copy, the one load a kept copy takes. It must be
         *  one (the marker set) at this write revision, the one the operator acted on. */
        resolveKept?: { revision: string | null; loadStamp?: string | null };
        /** #2005: the directory says this scope is not primary, so mark it a copy in its own
         *  storage (`markCopyOrigin`) — a carry of a copy that predates the marker brings none. */
        markCopy?: boolean;
        /** #2016: the tenant the platform says this scope belongs to. Recorded as its receipt; a
         *  store whose receipt names another tenant refuses the load (`conflict`) untouched. */
        provisionedFor?: TenantId;
      } = {},
    ): Promise<SwitchedOff[]> {
      // The WHOLE drop-then-replay runs under deferred foreign keys, in one transaction.
      //
      // Two distinct FK hazards, and both need the deferral — the second is why it cannot
      // wrap the inserts alone:
      //
      //  - Replay order. A dump is ordered by table NAME, which says nothing about foreign
      //    keys: a vertical whose child sorts before its parent (`crm_bank_accounts` before
      //    `crm_vendors`) would fail on its first insert.
      //  - THE DROPS. `DROP TABLE` performs an implicit `DELETE FROM`, so dropping a parent
      //    while a child table still holds rows raises `FOREIGN KEY constraint failed`
      //    before any replacement row exists. This bites only when the TARGET already has
      //    data, which is why it survived the first fix: an empty scope drops cleanly, and
      //    a populated one — the case that matters, since restore exists to overwrite real
      //    data — does not.
      //
      // Deferral holds every check until commit, by which point the old rows are gone and
      // the new ones are all in. It also covers what a topological sort cannot express: FK
      // cycles, and self-referencing rows within a single table.
      // A dump written before indexes were excluded may still carry them; skipped
      // rather than failing a restore over data about to be recomputed.
      // Matched without case, as SQLite resolves a table name (#1883 review).
      // #1686: a copy into another scope id loads no capability rows; a same-scope restore keeps them.
      const replayable = capabilitiesForLoad(
        tables.filter((t) => !isSearchIndexTable(t.name.toLowerCase())),
        destScopeId,
        sourceScopeId,
      );
      // The dump is untrusted input (#1143). `SqlStorage.exec` runs every statement
      // in the string it is given, so a `ddl` with anything appended to its CREATE
      // TABLE executed that too — with entirely plain identifiers, which is why no
      // amount of name checking reaches it. There is no prepare step here to compile
      // only the first statement, so the text itself has to be the one statement.
      // Pure input validation, so it runs before the first DROP: a refused dump touches nothing.
      assertReplayableDump(replayable, { maxColumns: DO_SQL_LIMITS.columns });
      // #1869: `exact` vouches for a named source; without one it would silently fall back.
      if (exact && !sourceScopeId) {
        throw substratError('validation_failed', 'restore refused: `exact` needs the scope the dump came from');
      }
      const switched = await this.revision.transaction(async () => {
        const before = this.loadMarker();
        // #1713: the lifecycle the platform delivered here, read before the drops take it.
        const lifecycleBefore = readLifecycle(this.switchSql());
        // #2016: this store's own tenant receipt, read before the drops take it. A load never
        // changes which tenant the scope belongs to: the platform's word for it (`provisionedFor`)
        // must agree with the receipt held, and is refused before the first drop if it does not.
        const receiptBefore = this.provisionedFor();
        if (provisionedFor !== undefined && receiptBefore !== null && receiptBefore !== provisionedFor) {
          const refused = substratError('conflict', tenantReceiptRefusal(receiptBefore, provisionedFor));
          tenantRefusals.add(refused);
          throw refused;
        }
        // #1722 (Codex #2008 r7): a kept copy holds writes nothing else has. No load replaces it
        // except its own resolution, and that only at the revision the operator acted on.
        const kept = this.metaValue(KEPT_DIVERGENT_KEY);
        if (resolveKept) {
          if (!kept) throw substratError('precondition_failed', 'no kept copy here to resolve; nothing was loaded');
          if (
            before.revision !== resolveKept.revision ||
            (resolveKept.loadStamp !== undefined && before.loadStamp !== resolveKept.loadStamp)
          ) {
            throw substratError('precondition_failed', 'the kept copy changed since it was read; nothing was loaded');
          }
        } else if (kept) {
          throw substratError('conflict', KEPT_COPY_REFUSAL);
        }
        if (expect) {
          if (before.loadStamp !== expect.loadStamp || (expect.revision !== undefined && before.revision !== expect.revision)) {
            throw substratError('precondition_failed', 'scope store changed since it was read; nothing was loaded');
          }
        }
        // #1722: the drops take `_substrat_meta` with them; the revision is written back below.
        this.revisionSuspended = true;
        try {
          this.sql.exec('PRAGMA defer_foreign_keys = ON');
          // Real tables only; `sqlite_*` internals are auto-managed and un-droppable.
          const existing = this.sql
            // Nor workerd's own `_cf_*` (the live reaper's alarm keeps `_cf_METADATA`), which
            // it refuses to drop.
            .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'`)
            .toArray() as unknown as { name: string }[];
          // Search index tables are left alone here and rebuilt below (#827): dropping a
          // shadow table directly is an error, and `sqlite_master` order would reach one
          // before its virtual table.
          for (const { name } of existing) {
            if (isSearchIndexTable(name.toLowerCase())) continue;
            this.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
          }
          // A vertical's tables take the dump's own DDL. The spine never does (#1883): a dump
          // that declared a column the checker compares on as COLLATE NOCASE would otherwise
          // decide how this DO's permission checks match. Every `_substrat_*` table is built
          // from KERNEL_DDL instead, and the dump contributes only rows, by column name
          // (`spineRowsInsert`), a missing column taking the kernel's default.
          for (const t of replayable) if (!isSpineTable(t.name)) this.sql.exec(t.ddl);
          // KERNEL_DDL also builds what the dump did not carry (#321). A dump captured from a
          // WORLD that stores some `_substrat_*` tables ELSEWHERE carries only a subset — an
          // `@substrat-run/adapter-sqlite` scope file keeps `_substrat_roles` /
          // `_substrat_tenant_tuples` in its DIRECTORY database, so its per-scope dump omits
          // them, and without them the very next permission check would raise a bare `no such
          // table: _substrat_roles`. Roles land empty here and are re-projected by the
          // restore's repair leg (host.projectRolesLocal) — the spine's job is only to exist so
          // the checker can read it. The column pass follows, for the one outbox index KERNEL_DDL
          // leaves to it.
          for (const stmt of splitSqlStatements(KERNEL_DDL)) this.sql.exec(stmt);
          this.applySpineColumnAdditions();
          const columnsOf = (name: string) => doBuiltColumnsOf(this.sql, name);
          assertSpineTablesBuilt(replayable.map((t) => t.name), columnsOf);
          assertJournalDumpCoherent(replayable);
          // A spine column this kernel does not know (a dump from a newer one) is kept, as a plain
          // untyped column the checker never reads.
          for (const t of replayable) {
            if (isSpineTable(t.name)) for (const alter of spineColumnAdditions(t, columnsOf(t.name))) this.sql.exec(alter);
          }
          for (const t of replayable) {
            const insert = dumpRowsInsert(t, columnsOf);
            for (const row of t.rows) this.sql.exec(insert, ...(row as unknown[]));
          }
          // #1738: a dump's `provisioned_for` names the scope (and tenant) it was captured from,
          // not this one, so it is never carried over. #2016: what stays is THIS store's own —
          // the platform's word when the load carries it (a copy into a fresh scope records its
          // own tenant here), else the receipt held before the drops. A store that held none
          // keeps none, and the repair projection that follows writes it.
          this.sql.exec(`DELETE FROM _substrat_meta WHERE key = ?`, PROVISIONED_FOR_KEY);
          const receipt = provisionedFor ?? receiptBefore;
          if (receipt !== null) {
            this.sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES (?, ?)`, PROVISIONED_FOR_KEY, receipt);
          }
          // #1722: whatever stamp an export read here no longer describes this store, so every load
          // replaces it: with the carry's own, or with none. And the write revision moves on from
          // where it stood before the drops, so it never goes back.
          if (loadStamp) {
            this.sql.exec(`INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES (?, ?)`, LOAD_STAMP_KEY, loadStamp);
          } else {
            this.sql.exec(`DELETE FROM _substrat_meta WHERE key = ?`, LOAD_STAMP_KEY);
          }
          this.sql.exec(
            `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES (?, ?)`,
            WRITE_REVISION_KEY,
            String(Number(before.revision ?? 0) + 1),
          );
          // #1575: attachment text is not in a dump, so the load left it as it was. Drop the
          // text of attachments the dump did not bring back, and queue extraction for those
          // it brought back without text — the bytes decide what that run finds.
          const now = new Date().toISOString();
          // #1686: nothing the source queued runs in a copy; a return leaves it all queued. BEFORE
          // the extraction queue below, which is this scope's own work, not the source's.
          settleCopiedWork(this.switchSql(), destScopeId, sourceScopeId, now);
          if (markCopy) markCopyOrigin(this.switchSql(), now);
          // #1713: a return keeps the newer of this store's lifecycle and the dump's, so a backup
          // from before a suspension does not lift it; a copy keeps only its own.
          settleLifecycleAfterLoad(this.switchSql(), lifecycleBefore, markCopy === true || isCopyLoad(destScopeId, sourceScopeId));
          reconcileAttachmentText(doSpineSql(this.sql), ulid, now);
          // Re-point the restored grants at THIS scope (after the spine exists, so a dump
          // that carried no tuples table still finds one here).
          if (destScopeId) {
            this.rewriteScopeTuples(destScopeId, sourceScopeId && { scopeId: sourceScopeId, exact }, new Date().toISOString());
          }
          // #827 / #119 / #811: the search triggers, the archive/trash guard triggers and the
          // derived list indexes went with the dropped tables, and the search index points at rows
          // that are gone. Repaired, and the search index rebuilt, AFTER the rows — which may
          // legitimately arrive archived or trashed — as the dump's own journal says they were
          // derived (#2090). Inside the replay's transaction: a dump whose journal owes a table a
          // state column it does not carry rolls the whole load back. A plan whose table this dump
          // did not carry is skipped: a restore must not invent one.
          repairDerivedObjects(doSpineSql(this.sql), (ddl) => this.runScript(ddl), this.derivedPlans(), {
            after: 'the restored dump',
            absentTable: 'skip',
          });
          // #1742: the recorded-off modules go back off INSIDE the replay's transaction, with
          // the spine and the re-point. A switch that throws rolls the whole restore back, so
          // the dump's grants never commit live without the switch that should cover them.
          return destScopeId && switchOff
            ? switchRecordedOff(this.switchSql(), { scopeId: destScopeId, ...switchOff })
            : [];
        } finally {
          this.revisionSuspended = false;
        }
      });
      this.carriedAwayCopy = this.metaValue(CARRIED_AWAY_KEY) !== null;
      // #1335 / #1686: the outbox arrived with the dump, so this DO's event ids resume above it,
      // as on a wake. A copy's own events then sort above every copied one, which is what
      // `emittedHere()` relies on. A dump whose top id is no ULID leaves the floor where it was.
      const top = (this.sql.exec('SELECT MAX(id) AS id FROM _substrat_outbox').toArray()[0] as { id: string | null } | undefined)?.id;
      if (top) {
        try {
          this.mintEventId.seedFrom(top);
        } catch {
          // Not a ULID: nothing this mint could have written, so there is no floor to keep.
        }
      }
      // The frontier arrived with the dump — refresh the in-memory applied set so a
      // later migrate() builds on the imported state, not the provisioning state.
      this.applied = readAppliedMigrations(this.sql);
      // …and forget that this INSTANCE ever ran a migration pass (#1589). Refreshing
      // the set above is not enough on its own: `ensureMigrations` memoises its
      // promise, so a warm DO answers "already migrated" from the cache and never
      // reads the set again. A restore replays only what the dump carries, so a dump
      // that omits a module's tables — a world that keeps part of the spine
      // elsewhere, a targeted repair supplying only the tables being fixed — leaves
      // them dropped and never rebuilt, and the next operation touching one fails
      // with a bare `no such table` until an eviction or `retryMigrations` resets the
      // latch. The pure host has no such memo (it re-reads `appliedMigrations` on
      // every pass), so this is the line that makes the two adapters agree; without
      // it the divergence is invisible to dev, CI and self-host, which is the #969
      // class exactly. Same two fields `retryMigrations` clears, for the same reason:
      // the next pass has to be a fresh one. Already-journaled versions are skipped
      // by the `applied` set and the in-transaction re-check, so a dump that DID
      // carry its tables re-applies nothing.
      //
      // `schemaVersionReported` is deliberately left set, as `retryMigrations` leaves
      // it. `migrate()` reports only when a pass APPLIED something, and a pass that
      // applies after this reset ends with every code-defined migration journaled —
      // the same `applied.size` the first pass already reported. A dump whose frontier
      // is complete applies nothing, so there is nothing to report either way.
      this.migrationPromise = undefined;
      this.lastFailure = null;
      return switched;
    }

    /**
     * `importDump` with its two refusals answered as values (#1722): across this RPC a throw
     * carries only its message, and the host has to tell "the store moved since it was read"
     * (`changed`, 412) and "this store is a kept copy" (`kept`, 409) from a failure.
     */
    async importDumpChecked(
      tables: ScopeDumpTable[],
      destScopeId: ScopeId,
      opts: Parameters<this['importDump']>[2],
    ): Promise<{ refused: 'changed' | 'kept' } | { refused: 'tenant'; message: string } | { refused: false; switchedOff: SwitchedOff[] }> {
      try {
        return { refused: false, switchedOff: await this.importDump(tables, destScopeId, opts) };
      } catch (e) {
        const code = errorCodeOf(e);
        if (code === 'precondition_failed') return { refused: 'changed' };
        if (e instanceof Error && tenantRefusals.has(e)) return { refused: 'tenant', message: e.message };
        if (code === 'conflict') return { refused: 'kept' };
        throw toRpcError(e);
      }
    }

    /** The kept-copy marker (#1722), or null when this store is not one. */
    keptCopy(): KeptCopy | null {
      const raw = this.metaValue(KEPT_DIVERGENT_KEY);
      return raw ? (JSON.parse(raw) as KeptCopy) : null;
    }

    /**
     * Release a kept copy that is the scope's live store after all (#1722, Codex #2008 r8): a carry
     * that protected its source when the route read elsewhere, while a rollback was about to bind
     * it. Clears the marker only, fenced on the write revision read; the data stays as it is.
     */
    releaseKeptCopy(
      revision: string | null,
      /** The directory says this scope is not primary (#2005): the released store is marked a copy. */
      markCopy?: boolean,
      /** The load stamp read with `revision` (Codex #2008 r13): a store a load replaced is refused.
       *  A kept copy refuses every load but its own resolution, so this holds by construction too. */
      loadStamp?: string | null,
    ): { released: true } | { refused: 'changed' | 'not-kept' } {
      return this.revision.transactionSync(() => {
        if (!this.metaValue(KEPT_DIVERGENT_KEY)) return { refused: 'not-kept' } as const;
        if (this.metaValue(WRITE_REVISION_KEY) !== revision) return { refused: 'changed' } as const;
        if (loadStamp !== undefined && this.metaValue(LOAD_STAMP_KEY) !== loadStamp) return { refused: 'changed' } as const;
        this.sql.exec(`DELETE FROM _substrat_meta WHERE key = ?`, KEPT_DIVERGENT_KEY);
        if (markCopy) this.revision.bookkeeping(() => markCopyOrigin(this.switchSql(), new Date().toISOString()));
        return { released: true } as const;
      });
    }

    /**
     * Discard a kept copy (#1722): the staff resolution that wipes it to the tombstone, only if it
     * is still one at the write revision the operator acted on. The marker goes with the wipe.
     */
    async discardKeptCopy(
      scopeId: ScopeId,
      revision: string | null,
      carriedAway: CarriedAway,
      /** The directory says this scope is not primary (#2005): as `wipeCarried`. */
      markCopy?: boolean,
      /** The load stamp read with `revision` (Codex #2008 r13), as `releaseKeptCopy`. */
      loadStamp?: string | null,
    ): Promise<{ discarded: true } | { refused: 'changed' | 'not-kept' }> {
      if (!this.metaValue(KEPT_DIVERGENT_KEY)) return { refused: 'not-kept' };
      try {
        await this.importDump(carriedAwayDump(carriedAway), scopeId, {
          sourceScopeId: scopeId,
          resolveKept: { revision, ...(loadStamp !== undefined ? { loadStamp } : {}) },
          markCopy: markCopy === true || this.isCopy(), // #2005: as `wipeCarried`
        });
        return { discarded: true };
      } catch (e) {
        if (errorCodeOf(e) === 'precondition_failed') return { refused: 'changed' };
        throw toRpcError(e);
      }
    }

    /** What a carry's restore into this store expects to find unchanged (#1722): see `LoadMarker`. */
    loadMarker(): LoadMarker {
      return { loadStamp: this.metaValue(LOAD_STAMP_KEY), revision: this.metaValue(WRITE_REVISION_KEY) };
    }

    /** This store's load stamp (#1722), or null when no load has written one. */
    private loadStamp(): string | null {
      return this.metaValue(LOAD_STAMP_KEY);
    }

    private metaValue(key: string): string | null {
      const row = this.sql.exec(`SELECT value FROM _substrat_meta WHERE key = ?`, key).toArray()[0] as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    }

    /**
     * Wipe the copy a carry left in this script (#1722), only if nothing was loaded here since
     * the carry exported it. A rollback that restored into this DO in the meantime replaced or
     * cleared the stamp, and its restore stays. Non-terminal, unlike `destroyStorage`: the store is a load of
     * the `carriedAway` tombstone, so a later restore into it works as on any scope. False when
     * refused.
     */
    async wipeCarried(
      scopeId: ScopeId,
      expectLoadStamp: string | null,
      carriedAway: CarriedAway,
      {
        expectRevision,
        protectIfChanged,
        markCopy,
      }: {
        /** The write revision the carry's export read; absent from a platform that read none. */
        expectRevision?: string | null;
        /** The caller read that the scope does not route here (Codex #2008 r8): a copy that changed
         *  in ANY way since the export, a load included, holds something the scope's live store may
         *  not, so it is kept rather than left an unmarked orphan. */
        protectIfChanged?: boolean;
        /** The directory says this scope is not primary (#2005, Codex #2008 r10): the store is a
         *  copy whatever its own marker says, which a copy made before the marker does not carry. */
        markCopy?: boolean;
      } = {},
    ): Promise<boolean> {
      // A store marked now stays one: the copy-origin row goes on the tombstone (the wipe), or
      // on the copy kept (a refusal), and never counts as a data write (`bookkeeping`).
      const copy = markCopy === true || this.isCopy();
      try {
        await this.importDump(carriedAwayDump(carriedAway), scopeId, {
          sourceScopeId: scopeId,
          expect: { loadStamp: expectLoadStamp, ...(expectRevision !== undefined ? { revision: expectRevision } : {}) },
          // #2005: a copy wiped is still a copy. The drop-and-replay takes the copy-origin row
          // with everything else, so it is written again, or the tombstone would read as primary.
          markCopy: copy,
        });
        return true;
      } catch (e) {
        const code = errorCodeOf(e);
        // Only on the directory's word: the store's own marker, read before the refused load, may
        // have been cleared by staff since (Codex #2008 r12), and marking it again would undo that.
        if (markCopy === true) {
          this.revision.transactionSync(() =>
            this.revision.bookkeeping(() => markCopyOrigin(this.switchSql(), carriedAway.at)),
          );
        }
        if (code === 'conflict') {
          // Already a kept copy, and the scope has been carried away from it again (Codex #2008
          // r9). That is recorded on the marker, which is a write: it advances the revision, so a
          // release (staff or a carry's auto-release) that read the revision before this, when the
          // scope still routed here, fails its compare-and-set rather than clearing the marker of
          // a copy the scope has just left.
          this.revision.transactionSync(() => {
            const raw = this.metaValue(KEPT_DIVERGENT_KEY);
            if (!raw) return;
            const kept = { ...(JSON.parse(raw) as KeptCopy), leftAgain: { to: carriedAway.to, at: carriedAway.at } };
            this.sql.exec(`UPDATE _substrat_meta SET value = ? WHERE key = ?`, JSON.stringify(kept), KEPT_DIVERGENT_KEY);
          });
          return false;
        }
        if (code !== 'precondition_failed') throw toRpcError(e);
        // Refused. When nothing was LOADED here since the export (the stamp is the one read) but
        // the store was WRITTEN (the revision moved), the copy holds a write the carry never
        // copied: protect it in the store itself, decided again inside its own transaction.
        this.revision.transactionSync(() => {
          const now = this.loadMarker();
          const writtenSince =
            expectRevision !== undefined && now.loadStamp === expectLoadStamp && now.revision !== expectRevision;
          const changedSince =
            now.loadStamp !== expectLoadStamp || (expectRevision !== undefined && now.revision !== expectRevision);
          // A wiped copy holds nothing to protect (and takes no write, the marker included).
          if (this.carriedAwayCopy || this.metaValue(KEPT_DIVERGENT_KEY)) return;
          if (!writtenSince && !(protectIfChanged && changedSince)) return;
          const kept: KeptCopy = { carriedTo: carriedAway.to, keptAt: carriedAway.at, revision: now.revision };
          this.sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES (?, ?)`, KEPT_DIVERGENT_KEY, JSON.stringify(kept));
          // Codex #2008 r12: changed ONLY by a staff clear of the copy marker — the clear's own
          // revisions span exactly the export's and the store's now — so the data is what the carry
          // copied, and only the fresher classification is not. Recorded on the marker with the
          // revision this keep committed at (the same run: no second bump), which the platform's
          // discard is fenced on once it has brought the clear to where the scope runs.
          const cleared = this.metaValue(COPY_MARK_CLEARED_KEY);
          const span = cleared ? (JSON.parse(cleared) as { from: string | null; to: string | null }) : null;
          if (writtenSince && span && span.from === expectRevision && span.to === now.revision) {
            const settled: KeptCopy = { ...kept, clearedOnly: { revision: this.metaValue(WRITE_REVISION_KEY) } };
            this.sql.exec(`UPDATE _substrat_meta SET value = ? WHERE key = ?`, JSON.stringify(settled), KEPT_DIVERGENT_KEY);
          }
        });
        return false;
      }
    }

    /**
     * Re-point scope-level tuples at the scope they now live in.
     *
     * Scope-level grants are written as `object = scope:<scopeId>` (the owner grant, every
     * role assignment). A dump carries the id of the scope it was captured FROM, so a fork,
     * a restore into a different scope, or #286's migration onto a stable script name all
     * land rows that name a scope this deployment may not even have. Nothing errors — the
     * rows insert fine — but the proof walk never matches them, so `/me` reports a role
     * while every `ctx.check` denies, which is the least debuggable shape this can fail in.
     *
     * Entity-level grants (`object = customer:<id>`) are untouched: those ids travel with
     * the dump and stay valid. Restoring ACROSS TENANTS would need the same treatment for
     * `_substrat_tenant_tuples`, which this does not attempt — a cross-tenant restore is a
     * governed copy, not a repair.
     *
     * Which rows move is `repointScopeGrants`'s (#1869): the dump's source scope, exactly.
     *
     * (subject, relation, object) is the primary key, so a moved row can meet one the dump
     * already holds for the destination scope. Which survives is that function's rule too
     * (#1882), with expiry judged at `now`, as this DO's checker judges it.
     */
    private rewriteScopeTuples(destScopeId: ScopeId, source: RepointSource | undefined, now: string): void {
      repointScopeGrants(this.switchSql(), destScopeId, source, now);
    }

    /**
     * Wipe this scope's storage — the reap half of deleteSnapshot (preview-and-
     * snapshots.md §9). The fork-only refusal lives on the coordinator (which holds
     * the directory record); this DO just deletes its own bytes. After deleteAll the
     * instance is inert; a stray re-open would rebuild an empty kernel schema, which
     * the directory no longer points at.
     */
    async destroyStorage(): Promise<void> {
      await this.ctx.storage.deleteAll();
      this.applied.clear();
      // The tombstone is written AFTER the wipe, on purpose: `deleteAll()` takes
      // everything, so a marker written before would go with it and a reaped DO
      // would be indistinguishable from a fresh one. Which is exactly how a
      // projection write that was already in flight could recreate storage for a
      // scope whose bytes the platform had just deleted — the fan-out selects live
      // scopes, then writes, and a reap can land between the two.
      //
      // Terminal by contract (`reaped` is not reversible, tenancy.ts), so this is a
      // permanent fence rather than a lock: any later write to this DO is refused
      // whenever it arrives, without coordinating with the lifecycle that killed it.
      await this.ctx.storage.put(REAPED_MARKER, true);
    }

    /** Whether this scope's storage was destroyed — see `destroyStorage`. */
    private async isReaped(): Promise<boolean> {
      return (await this.ctx.storage.get<boolean>(REAPED_MARKER)) === true;
    }

    /**
     * Redact one data subject's payloads from the spine (#37) — the Tier-1 half of an
     * erasure, which is an ordinary UPDATE because Tier 1 is mutable. The crypto half
     * (destroying the key that seals platform-retained copies) is the directory's.
     *
     * The payload goes; the envelope stays — id, type, entity, occurredAt and the
     * pseudonymous subject id. That is master-plan §5.3 held exactly: "pseudonymous keys
     * and transaction facts remain". A timeline still shows that something happened, to
     * what, and when; it no longer shows who, or what was said about them.
     *
     * **Two tables, one verb (#1600).** The outbox is not the only place the spine holds
     * an event's payload: this host is the CP-less one, so every connector delivery it
     * cannot run becomes a `connector:<provider>` intent carrying the whole event, and
     * nothing ever deletes those rows. Redacting one table and not the other left the
     * name in the live database and in every copy taken from it afterwards. One RPC
     * rather than two for `routeExecutorEventToPlatform`'s reason — a crash cannot land
     * half an erasure — and both halves are idempotent anyway, so a retry converges.
     *
     * This is the one sanctioned write that mutates the outbox. It is kernel code, not
     * module code, and an erasure request is precisely the case the append-only rule has
     * to yield to — the alternative is telling a data subject that the spine's convenience
     * outranks their Article 17 right.
     */
    async redactSubject(subjectId: string): Promise<SubjectRedactionCounts> {
      // One instant for the whole erasure — the intent tombstones must not disagree with
      // each other about when a person was erased.
      const at = new Date().toISOString();
      const doomed = (
        this.sql
          .exec(
            `SELECT id FROM _substrat_outbox
              WHERE subject_id = ? AND pii_class != 'none' AND payload IS NOT NULL`,
            subjectId,
          )
          .toArray() as unknown as { id: string }[]
      ).map((r) => r.id);
      for (const id of doomed) {
        this.sql.exec('UPDATE _substrat_outbox SET payload = NULL WHERE id = ?', id);
      }
      // A failed delivery's error text about one of those events (#1632) — keyed by event
      // id, so the outbox predicate names it. Not a copy of the event; not counted.
      this.sql.exec(DELIVERY_ERROR_REDACTION_SQL, REDACTED_DELIVERY_NOTE, REDACTED_DELIVERY_NOTE, subjectId);
      const sql = doRedactionSql(this.sql);
      return {
        events: doomed.length,
        intents: this.redactSubjectIntents(subjectId, at),
        // The job-run tables (#1632) — the kernel's walk, so the pure host runs the
        // identical SQL.
        jobRuns: redactSubjectJobRuns(sql, subjectId, at),
        // The free-text copies (#1632), and the tombstoned intents the coordinator hands to
        // the directory half. Last, so those ids include every intent tombstoned above.
        ...redactSubjectScopeText(sql, subjectId, at),
      };
    }

    /**
     * The intent-journal half of `redactSubject` (#1600) — the SQLite adapter's twin.
     *
     * Row-by-row rather than one `UPDATE … WHERE`, because the decision is structural and
     * SQL cannot make it: an intent payload is opaque JSON with no `pii_class` column to
     * test, so the SQL narrows to rows that could possibly match and the kernel predicate
     * decides. Query, predicate and statement all come from the kernel, so this adapter
     * and the pure one cannot drift about what a redacted intent is.
     */
    private redactSubjectIntents(subjectId: string, at: string): number {
      const q = platformRequestRedactionQuery(subjectId);
      const candidates = this.sql
        .exec(q.sql, ...q.params)
        .toArray() as unknown as PlatformRequestRedactionCandidate[];
      let redacted = 0;
      for (const row of candidates) {
        if (!intentPayloadCarriesSubject(row.payload, subjectId)) continue;
        this.sql.exec(
          PLATFORM_REQUEST_REDACTION_SQL,
          ...platformRequestRedactionParams(row.id, subjectId, at),
        );
        redacted += 1;
      }
      return redacted;
    }

    // -- event dispatch (port of dispatch) ------------------------------------

    /**
     * #1237: the invocation currently running in this DO, or null.
     *
     * DO-local: a Durable Object IS one scope, so there is no other scope's call to
     * confuse it with, and `invoke` sets and clears it inside its queued body, which no
     * other emitting body interleaves with. It still has to be cleared, because the DO
     * outlives the request and a value left set would stamp a later alarm-driven drain
     * with a call it had nothing to do with. A consumer's own cause is not kept here: it is
     * passed into the consumer's context (`ConsumerDelivery`, #2055).
     */
    private invocationId: string | null = null;

    private async dispatch(
      tenantId: TenantId,
      scopeId: ScopeId,
      /**
       * #1525: the call this drain is running in, or null. Every round of the loop
       * belongs to it: a consumer's own emit is delivered in the same tail, so the
       * whole cascade is one call's work.
       */
      invocationId: string | null,
    ): Promise<void> {
      // #1901: one line per delivery, capped per drain.
      const lines = asyncLinePass();
      try {
        await this.dispatchRounds(tenantId, scopeId, invocationId, lines);
      } finally {
        lines.end();
      }
    }

    private async dispatchRounds(
      tenantId: TenantId,
      scopeId: ScopeId,
      invocationId: string | null,
      lines: AsyncLinePass,
    ): Promise<void> {
      for (let round = 0; round < 50; round++) {
        let deliveredAny = false;
        for (const mod of this.modules.values()) {
          for (const consumer of mod.consumers) {
            const rows = this.sql
              .exec(
                `SELECT * FROM _substrat_outbox o
                 WHERE o.type = ? AND ${emittedHere('o.')}
                   AND NOT EXISTS (
                     SELECT 1 FROM _substrat_deliveries d
                     WHERE d.event_id = o.id AND d.consumer_module = ?
                   )
                 ORDER BY o.id`,
                consumer.eventType,
                mod.id,
              )
              .toArray() as unknown as OutboxRow[];
            for (const row of rows) {
              // #1901: this delivery's line — the call's id when it runs in one, else its own.
              const unit = {
                kind: 'consumer' as const,
                tenantId,
                scopeId,
                invocationId: asyncInvocationId(invocationId),
                operation: mod.id,
                eventType: consumer.eventType,
                eventId: row.id,
                // A module consumer is tried once: a throw dead-letters it (v0).
                attempt: 1,
                startedAt: Date.now(),
                versionId: this.env.SUBSTRAT_VERSION_ID ?? null,
              };
              let event: DomainEvent;
              try {
                event = domainEventOf(row);
              } catch (err) {
                // #1636: dead-letter an event that does not decode, exactly as a failed
                // handler is — the decode sat ABOVE the `try` below, so one bad row halted
                // every event of this type behind it, on every pass. The consumer is never
                // handed it: an event built from stand-ins is not one it may act on. Only
                // the decode is caught; the journal write is not.
                this.sql.exec(
                  `INSERT INTO _substrat_deliveries
                     (event_id, consumer_module, delivered_at, error, invocation_id)
                   VALUES (?, ?, ?, ?, ?)`,
                  row.id,
                  mod.id,
                  new Date().toISOString(),
                  String(err),
                  invocationId,
                );
                // Never reached the handler, so nothing threw in it: a warning, not an error.
                lines.write({ ...unit, outcome: 'dead-lettered' });
                continue;
              }
              try {
                await this.revision.transaction(async () => {
                  // #1237: anything this consumer emits was emitted BECAUSE of this event —
                  // the step a backwards walk used to stop dead at, since a consumer emit
                  // records no operation either. #1901: its `ctx.log` lines join this
                  // delivery's line.
                  const ctx = this.consumerContext(tenantId, scopeId, mod.id, {
                    causedBy: event.id,
                    invocationId: unit.invocationId,
                  });
                  await consumer.handler(ctx, event);
                  this.sql.exec(
                    `INSERT INTO _substrat_deliveries
                       (event_id, consumer_module, delivered_at, invocation_id)
                     VALUES (?, ?, ?, ?)`,
                    event.id,
                    mod.id,
                    new Date().toISOString(),
                    invocationId,
                  );
                });
                deliveredAny = true;
                lines.write({ ...unit, outcome: 'delivered' });
              } catch (err) {
                // Dead-letter (v0): journal the failure so one poison event
                // can't wedge the loop. Written outside the rolled-back txn.
                this.sql.exec(
                  `INSERT INTO _substrat_deliveries
                     (event_id, consumer_module, delivered_at, error, invocation_id)
                   VALUES (?, ?, ?, ?, ?)`,
                  event.id,
                  mod.id,
                  new Date().toISOString(),
                  String(err),
                  invocationId,
                );
                lines.write({ ...unit, outcome: 'dead-lettered', error: err });
              }
            }
          }
        }
        if (!deliveredAny) return;
      }
    }

    /**
     * K-35: record a refused check into the scope's denial log. Called from the invoke
     * catch after the storage transaction has rolled back, so this write is its own and
     * survives — the whole point, since the denial is the write the operation could not make.
     */
    /** K-42: the session a refused call ran under travels with the denial row. */
    /** #1745: a refused transition or refusing guard the operation failed with, written after its rollback. */
    private recordRefusal(
      subject: CheckSubject,
      tenantId: TenantId,
      scopeId: ScopeId,
      operation: string,
      err: unknown,
      invocationId: string | null,
      impersonation?: ImpersonationSession,
    ): void {
      const refused = refusalOf(err);
      if (!refused) return;
      const q = refusalInsert({
        tenantId,
        scopeId,
        refused,
        invokedOperation: operation,
        actor: JSON.stringify(actorOf(subject)),
        impersonation: impersonation ? JSON.stringify(impersonationStampOf(impersonation)) : null,
        invocationId,
        at: new Date().toISOString(),
      });
      this.sql.exec(q.sql, ...q.params);
    }

    private recordDenial(
      subject: CheckSubject,
      tenantId: TenantId,
      operation: string,
      err: PermissionDenied,
      /**
       * #1525: the invocation this refusal belongs to, or null — PASSED, never read off
       * `this.invocationId` here.
       *
       * Reading the ambient field is only self-evidently right where one call holds the
       * DO to itself, and two denial paths do not: `attachmentList` and
       * `attachmentAuthorize` run OUTSIDE `this.queue`, and both await before they
       * record (`ensureMigrations`, `ctx.check`). Whether the input gate can actually
       * reopen far enough for one of them to observe an in-flight call's id is NOT
       * settled here — a probe that raced twelve attachment refusals against invokes
       * holding an id (including one awaiting the control plane) recorded null every
       * time, so the gate evidently holds more than the shape of the code promises.
       *
       * Passed anyway, because the argument for the ambient read is an argument about
       * workerd's gate semantics, and the argument for a parameter is local: the invoke
       * path passes its own id, every attachment path passes null, and each says what it
       * actually knows. That is the property worth having on a recorded fact, and it
       * costs one argument. No test accompanies it — the condition could not be
       * reproduced, and a test that passes either way would be worse than none.
       */
      invocationId: string | null,
      impersonation?: ImpersonationSession,
    ): void {
      // Only an ENFORCED denial (assertAllowed, which attaches the checked permission +
      // node) is recorded. A module's own hand-thrown `new PermissionDenied('…')` carries
      // no permission key and is left to the module.
      if (!err.permission || !err.node) return;
      const actor = actorOf(subject);
      this.sql.exec(
        `INSERT INTO _substrat_denials
           (id, actor, permission, tenant_id, scope_id, operation, impersonation,
            invocation_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ulid(),
        JSON.stringify(actor),
        err.permission,
        err.node.tenantId,
        err.node.scopeId ?? null,
        operation,
        impersonation ? JSON.stringify(impersonationStampOf(impersonation)) : null,
        // #1525: the call this refusal belongs to, as the caller named it.
        invocationId,
        new Date().toISOString(),
      );
    }

    // -- operation context (port of operationContext) -------------------------

    private operationContext(
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      systemActor?: { system: string },
      connectionId?: string,
      /**
       * #1834: the system subject, only as the door check hands it out (`assertSystemDoor`) — so
       * no path can act as `system:<moduleId>` without passing that check.
       */
      systemDoor?: SystemDoorPass,
      /** #458: per-invoke tally of `ctx.requestPlatform` calls; absent for consumer dispatch. */
      signals?: { platformRequests: number },
      /**
       * K-42: the session this operation runs under, resolved by the coordinator
       * from the directory and handed down. Read here and nowhere module code can
       * reach — a vertical that could see it could branch on it, and "hide this row
       * when support is looking" is the one behaviour this feature must make
       * impossible.
       */
      impersonation?: ImpersonationSession,
      /**
       * #1231: the exact `invoke()` string this context runs on behalf of — stamped
       * onto every event it emits. Absent for consumer dispatch: a consumer runs on
       * behalf of no operation, and the emitted row's NULL says so.
       */
      operation?: string,
      /**
       * #1672: set when the caller holds a CAPABILITY session — already resolved from its
       * hash inside the queued body, before the transaction. Mutually exclusive with
       * `connectionId` and `systemModuleId`; `principal` is then a placeholder that the
       * subject below never reads.
       */
      capabilityId?: string,
      /**
       * #1672: the secrets `ctx.capabilities.mint` hands out during this invocation. The
       * caller owns the array (it withholds them from the idempotency recording); this
       * context appends to it and holds `ctx.sql`, `ctx.emit` and `ctx.requestPlatform` to
       * it — the tripwire that catches a module persisting one by accident (not a boundary
       * against one that means to; see `assertNoSecret`).
       */
      minted: string[] = [],
      /**
       * #1672: the instant to stamp, when the caller already read one. The exchange passes
       * the instant its row write used, so the `capability.exercised` event's `occurredAt`
       * and the row's `last_used_at` are the same value — a second read could disagree.
       */
      instantOverride?: Instant,
      /**
       * #1706: set when the caller is a PEER vertical — the subject `admitPeer` returned inside
       * the queued body. Mutually exclusive with the other non-person callers; `principal` is
       * then a placeholder that the subject below never reads.
       */
      peerSubject?: CheckSubject,
      /** #2055: the delivery a consumer's or an import's context runs for; absent otherwise. */
      delivery?: ConsumerDelivery,
    ): OperationContext {
      const checker = this.checker;
      const relations = this.relations;
      const searchPlans = this.searchPlans;
      const listPlans = this.listPlans;
      const statePlans = this.statePlans;
      const sql = this.sql;
      const mintEventId = this.mintEventId;
      /**
       * The operation's instant (#812), read once. The DO reads the wall clock —
       * there is no options bag to inject through, since workerd constructs it —
       * but the STABILITY half of the contract is the half module code depends
       * on, and it holds identically here: `ctx.now()`, every `occurredAt` and
       * every `requested_at` in one operation are the same value.
       */
      const at = instantOverride ?? instant.parse(new Date().toISOString());
      // The permission subject and the derived event actor for a NON-override caller
      // (#383/#97): a scheduled module, a connection, or a person. `systemActor` (the
      // override, used only by consumer dispatch) stays a separate bypass path below.
      const subject: CheckSubject = peerSubject
        ? peerSubject
        : capabilityId
        ? { kind: 'capability', id: capabilityId as CapabilityId }
        : systemDoor
          ? { kind: 'system', id: systemDoor.moduleId as ModuleId }
          : connectionId
            ? { kind: 'connection', id: connectionId }
            : { kind: 'principal', id: principal };
      const derivedActor = actorOf(subject);
      // #304: entitlement reads pick the same local-vs-RPC reader the permission checker
      // uses (projected scope → local table; console-managed → CP over RPC), resolved per
      // call so a scope that flips to 'local' is picked up without rebuilding the context.
      const entitlementReader = () => this.controlPlaneReader();
      // K-34: the checks that passed in THIS operation (a fresh context is built per
      // invoke, so this does not leak across operations). `emit` snapshots it; a
      // system/override actor is unconditionally allowed, so its checks are not recorded.
      const passed: EventAuthorization[] = [];
      // K-42: the two-actor stamp, computed once per operation. Every record this
      // operation writes about who did what carries it, and module code can
      // neither add it nor drop it.
      const stamp = impersonation ? impersonationStampOf(impersonation) : undefined;

      /**
       * The scope host's half of `ctx.atomic` (#770) — everything else is the
       * kernel's (`createAtomic`).
       *
       * The DO runtime FORBIDS `SAVEPOINT` through `sql.exec` outright ("please
       * use the state.storage.transaction() or state.storage.transactionSync()
       * APIs"), so this is not the pure adapter's mechanism spelled differently:
       * it is the nested async transaction, which workerd rolls back correctly
       * even across an `await`. `depth` is therefore unused here — the runtime
       * owns that stack itself. It is exactly this asymmetry that makes `RunSub`
       * closure-shaped rather than an enter/rollback/release triple.
       */
      const runSub: RunSub = (_depth, fn) => this.revision.transaction(fn);

      // Lifted so `grant` reuses the SAME check the operation itself passes —
      // a delegation check that could differ from the operation's would be a
      // second opinion about what the caller holds.
      const runCheck = async (unparsed: PermissionKey, entity?: EntityRef) => {
        // #1642: parsed before the system actor's early return, which never reaches
        // the checker — a cast key would otherwise become that path's proof relation.
        const permission = assertPermissionKey(unparsed);
        if (systemActor) {
          return {
            allowed: true as const,
            proof: [
              {
                subject: objectRef.parse(
                  `system:${systemActor.system.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
                ),
                relation: `granted:${permission}`,
                object: objectRef.parse(`scope:${scopeId}`),
              },
            ],
          };
        }
        const decision = await checker.check(subject, permission, { tenantId, scopeId }, entity);
        if (decision.allowed) {
          const grant = grantRefFromProof(permission, decision.proof);
          const entry: EventAuthorization = grant ? { permission, grant } : { permission };
          if (!passed.some((p) => p.permission === entry.permission && p.grant === entry.grant)) {
            passed.push(entry);
          }
        }
        return decision;
      };

      const runCanAssign = async (roleKey: string) => {
        const bound = await this.assignmentBound(subject, tenantId, scopeId, roleKey);
        if (!bound) {
          throw unknownRoleError(roleKey);
        }
        return bound;
      };

      // ctx.emit's writer, and the kernel's own events' (#1864): one path to the outbox, with the
      // reserved-type refusal applied to module code only. Never handed to module code as-is.
      const writeEvent = (event: DomainEventInput, author: 'module' | 'kernel'): void => {
        assertImpersonationWrites(impersonation, 'ctx.emit');
        const parsed = domainEventInput.parse(event);
        // #1864: a kernel-authored type is the kernel's to write — module code cannot forge one.
        if (author === 'module') assertModuleEmittableType(parsed.type);
        else assertKernelAuthoredType(parsed.type); // a new kernel event must join the reserved set
        // #1672: the COMPLETE parsed event — entity id, type and subject as well as payload.
        assertNoSecret('ctx.emit', parsed, minted);
        const full = domainEvent.parse({
          ...parsed,
          // #956: from the operation's instant, not a second reading of the clock.
          // `ORDER BY id` is how the outbox and every timeline page, so an id whose
          // timestamp disagreed with its own `occurredAt` sorted the log by a clock
          // nothing else in the operation used.
          id: eventId.parse(mintEventId(Date.parse(at))),
          occurredAt: at,
          tenantId,
          scopeId,
          actor: systemActor ?? derivedActor,
          ...(passed.length ? { authorization: passed.map((p) => ({ ...p })) } : {}),
          ...(stamp ? { impersonation: stamp } : {}),
          // #1231: kernel-stamped like the two above — `domainEventInput.parse`
          // already stripped anything module code tried to smuggle under this key.
          ...(operation ? { operation } : {}),
        });
        sql.exec(
          `INSERT INTO _substrat_outbox
             (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
              entity_type, entity_id, pii_class, subject_id, authorization,
              impersonation, operation, version, caused_by, invocation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          full.id,
          full.type,
          full.schemaVersion,
          full.occurredAt,
          full.tenantId,
          full.scopeId,
          JSON.stringify(full.actor),
          full.entity.entityType,
          full.entity.entityId,
          full.piiClass,
          full.subjectId ?? null,
          full.authorization ? JSON.stringify(full.authorization) : null,
          full.impersonation ? JSON.stringify(full.impersonation) : null,
          full.operation ?? null,
          // #1242: script configuration, not envelope data — the version is a fact
          // about the deploy, so it never rides `DomainEvent` for module code to
          // branch on; it exists for the observability joins the column serves.
          this.env.SUBSTRAT_VERSION_ID ?? null,
          // #1237: the delivery this context was built for, if any — passed in, never read
          // off the DO (#2055). A fact about the surrounding dispatch, never envelope data
          // module code could set or branch on.
          delivery?.causedBy ?? null,
          // #1237: a fact about the surrounding CALL, like the version above.
          this.invocationId,
          full.payload === undefined ? null : JSON.stringify(full.payload),
        );
      };
      const ctxRef: OperationContext = {
        tenantId,
        scopeId,
        // #1672: a capability's own id stands in so the type holds — it is not a person, and
        // the event actor says what it is instead. Every other door passes its own value.
        principal: capabilityId ? (capabilityId as unknown as PrincipalId) : principal,
        sql: guardSecrets(
          doScopedSql(
            sql,
            statefulTablesOf(statePlans),
            // #119 / #2090: after runtime DDL, inside this operation's transaction, what the kernel
            // derived onto any table is repaired — and a lost state column fails the operation.
            derivesAnything(this.derivedPlans())
              ? () => afterRuntimeDdl(doSpineSql(sql), (ddl) => this.runScript(ddl), this.derivedPlans())
              : undefined,
          ),
          minted,
        ),
        now: () => at,
        // #1746/#1747: the host stamps who and where; module code supplies only the template
        // and its fields. A consumer runs under the system override, so it logs as `system`.
        // The invocation id is read per call, as the DO holds it for the queued body's length.
        log: moduleLog({
          tenantId,
          scopeId,
          operation: operation ?? null,
          invocationId: () => this.invocationId ?? delivery?.invocationId ?? null,
          principalKind: systemActor ? 'system' : subject.kind,
          // The string-safe redaction: `redactSecrets` parses its serialization back, and a
          // log's text is not JSON.
          redact: (text) => redactSecretText(text, minted),
        }),
        emit: (event: DomainEventInput) => writeEvent(event, 'module'),
        requestPlatform: (request: PlatformRequestInput): PlatformRequestId => {
          assertImpersonationWrites(impersonation, 'ctx.requestPlatform');
          const input = platformRequestInput.parse(request);
          // #1672: the COMPLETE parsed request — its `kind` is persisted as surely as its payload.
          assertNoSecret('ctx.requestPlatform', input, minted);
          // #1474: a platform-authored kind (`sweep-runs`) never comes from module code —
          // the sweeper enqueues it through `enqueueSweepRuns`, which does not pass here.
          assertModuleEnqueueableKind(input.kind);
          // Backpressure (platform-intents.md): refuse when the scope already holds too many pending
          // intents, so a stuck or runaway vertical cannot flood the platform drain.
          const pending = Number(
            (
              sql
                .exec(`SELECT COUNT(*) AS c FROM _substrat_platform_requests WHERE status = 'pending'`)
                .toArray()[0] as { c: number }
            ).c,
          );
          if (pending >= MAX_PENDING_PLATFORM_REQUESTS) {
            throw new Error(`too many pending platform requests (${pending}); retry once some have drained`);
          }
          const id = platformRequestId.parse(ulid());
          const requestedBy = systemActor ?? derivedActor;
          sql.exec(
            `INSERT INTO _substrat_platform_requests
               (id, kind, payload, requested_by, impersonation, status, attempts, requested_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
            id,
            input.kind,
            JSON.stringify(input.payload ?? null),
            JSON.stringify(requestedBy),
            stamp ? JSON.stringify(stamp) : null,
            at,
          );
          if (signals) signals.platformRequests += 1;
          return id;
        },
        // The read half of `requestPlatform` (#618) — this scope's own journal, so no tenancy
        // predicate is needed or possible: the DO IS the scope.
        platformRequests: (filter?: PlatformRequestFilter): PlatformRequest[] => {
          const q = platformRequestHistoryQuery(filter);
          // The kernel's decoder, the one the coordinator maps the RPC's rows with (#1588):
          // tolerant, so one undecodable row cannot hide this scope's other intents from it.
          return (sql.exec(q.sql, ...q.params).toArray() as unknown as PlatformRequestRawRow[]).map(
            platformRequestOf,
          );
        },
        // #901. Mirror of the pure adapter, and the reason the contract suite
        // runs on both: the query is ordinary SQL, but it is only a seek rather
        // than a scan because of an index in spine DDL that workerd's regulator
        // has to permit — which no amount of local green would surface.
        versionOf: (entity: EntityRef): EntityVersion | null => {
          const q = entityVersionQuery(entity);
          return entityVersionOf(
            sql.exec(q.sql, ...q.params).toArray() as unknown as EntityVersionRow[],
          );
        },
        check: runCheck,
        canAssign: runCanAssign,
        // #827. Mirror of the pure adapter: the plan comes from registration, the
        // rows from this DO's own SQLite, and the index is maintained by triggers
        // that workerd's regulator has to permit — which is exactly what the
        // contract suite proves here and cannot prove anywhere else.
        search: (entityType: string, term: string, options?: SearchOptions): SearchHit[] => {
          const plan = searchPlans.get(entityType);
          if (!plan) throw new NotSearchable(entityType);
          const q = searchQuery(
            plan,
            searchMatchExpression(term, plan.tokenizer),
            searchLimit(options?.limit),
            // #119: active rows unless the archive is asked for.
            searchStateWhere(statePlans, entityType, options?.view),
          );
          return (sql.exec(q.sql, ...q.params).toArray() as unknown as { id: string; rank: number }[]).map(
            (row) => ({ entityType, id: row.id, rank: row.rank }),
          );
        },
        /**
         * #811. Mirror of the pure adapter, and the reason the contract suite runs
         * on both: the walk is ordinary SQL, but the indexes behind it are created
         * by DDL that workerd's regulator has to permit — which no amount of local
         * green would surface.
         */
        page: <T>(entityType: string, params: PageParams) => {
          const plan = listPlans.get(entityType);
          if (!plan) throw new NotListable(entityType);
          const limit = listLimitOf(params.limit);
          const q = listQuery(plan, {
            limit,
            sort: params.sort,
            order: params.order,
            cursor: params.cursor,
            filters: params.filters,
            // #119: the bin is the checked reader's, never this one's.
            view: uncheckedView('ctx.page', entityType, params.view),
          });
          const rows = sql.exec(q.sql, ...q.params).toArray() as unknown as Record<
            string,
            unknown
          >[];
          // `pageOf`'s rule, and each row's own cursor when asked (#2073).
          const mint = (row: T) =>
            cursorOf(row as Record<string, unknown>, q.sortColumn, plan.idColumn, q.order, q.view);
          if (!params.total) return pageOf(rows as T[], limit, mint, params.rowCursors);
          const counted = sql
            .exec(q.countSql, ...q.countParams)
            .toArray() as unknown as { n: number }[];
          return countedPageOf(rows as T[], limit, mint, counted[0]?.n ?? 0, params.rowCursors);
        },
        /**
         * Delegate a permission this caller holds onto one entity — see the
         * kernel's `OperationContext.grant` for why the verb exists.
         *
         * Same two guardrails as the pure adapter: entity-narrowed only, and
         * re-checked against the caller's own decision so it delegates rather
         * than elevates.
         */
        grant: async (principal: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
          assertImpersonationWrites(impersonation, 'ctx.grant');
          entityObjectRef(entity, 'ctx.grant'); // #1856: a tuple the walk can read back
          const held = await runCheck(permission, entity);
          if (!held.allowed) {
            throw new PermissionDenied(
              `cannot grant '${permission}' on ${entity.entityType}:${entity.entityId} — ` +
                'the caller does not hold it there (a grant delegates, it never elevates)',
            );
          }
          // #2071: an explicit grant, so it clears a tombstone `revoke` left.
          const g = delegatedGrantSql(principal, permission, `${entity.entityType}:${entity.entityId}`);
          sql.exec(g.sql, ...g.params);
        },
        /**
         * Deliberately NOT the #1856 grammar check `grant` and `link` make: a revoke writes
         * nothing the walk must read back, and a grant stored before that check existed must
         * stay removable.
         */
        revoke: async (principal: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
          assertImpersonationWrites(impersonation, 'ctx.revoke');
          const held = await runCheck(permission, entity);
          if (!held.allowed) {
            throw new PermissionDenied(
              `cannot revoke '${permission}' on ${entity.entityType}:${entity.entityId} — ` +
                'the caller does not hold it there',
            );
          }
          // K-21 (#2071): a tombstone, never a delete — a declared shape's top-up must be
          // able to tell a key taken back from one never held.
          const r = delegatedRevokeSql(principal, permission, `${entity.entityType}:${entity.entityId}`, at);
          sql.exec(r.sql, ...r.params);
        },
        atomic: createAtomic(runSub, { passed, signals }),
        // #1672: mint / revoke / list, written once in the kernel — the pure adapter hands
        // the same function the same four things. The raw spine seam (the kernel's own write
        // to `_substrat_capabilities`), the operation's OWN check, and `ctx.emit`. A
        // consumer's override actor is passed as the system actor it is, so a consumer
        // cannot mint: its checks allow unconditionally, which would make "the minter holds
        // it" vacuous.
        capabilities: createCapabilityVerbs({
          sql: doSpineSql(sql),
          subject: systemActor ? { kind: 'system', id: systemActor.system as ModuleId } : subject,
          now: at,
          check: runCheck,
          emit: (event) => writeEvent(event, 'kernel'),
          isOperation: (name) => this.operations.has(name),
          assertWrites: (verb) => assertImpersonationWrites(impersonation, verb),
          minted,
        }),
        // K-16 / #1864: link and relink, written once in the kernel over the raw spine seam.
        ...createEntityEdgeVerbs({
          sql: doSpineSql(sql),
          relations,
          now: at,
          emit: (event) => writeEvent(event, 'kernel'),
          assertWrites: (verb) => assertImpersonationWrites(impersonation, verb),
        }),
        // #119: archive and trash — the pure adapter's wiring, over the raw spine seam.
        ...createEntityStateVerbs({
          sql: doSpineSql(sql),
          plans: statePlans,
          now: at,
          check: runCheck,
          emit: (event) => writeEvent(event, 'kernel'),
          assertWrites: (verb) => assertImpersonationWrites(impersonation, verb),
        }),
        ...createTrashedReads({
          query: (q, params) =>
            sql.exec(q, ...(params as SqlStorageValue[])).toArray() as unknown as Record<string, unknown>[],
          listPlans,
          searchPlans,
          statePlans,
          check: runCheck,
        }),
        entitlement: async (key: string): Promise<EntitlementView | null> => {
          const held = await entitlementReader().listEntitlements(tenantId);
          return held.find((e) => e.key === key) ?? null;
        },
        entitlements: (): Promise<EntitlementView[]> => entitlementReader().listEntitlements(tenantId),
        // #687: seal a value to the connector that will receive it. Reads the PROJECTED
        // public key — the only half a scope ever holds — so a hosted vertical needs no
        // control-plane binding for this, exactly as it needs none for entitlements.
        //
        // Refuses rather than degrades when nothing is projected. A silently contactless
        // request is today's invisible failure in a new hat: the document starts at the
        // provider and reaches nobody, and nothing in the system says so.
        sealToConnection: async (provider: string, plaintext: string) => {
          const row = this.sql
            .exec(
              `SELECT key_id, public_key FROM _substrat_connection_keys
               WHERE tenant_id = ? AND provider = ?`,
              tenantId,
              provider,
            )
            .toArray()[0] as unknown as { key_id: string; public_key: string } | undefined;
          if (!row) {
            throw new ConnectionSealingKeyUnavailableError(
              provider,
              noSealingKeyMessage(provider, scopeId),
            );
          }
          return sealTo({ keyId: row.key_id, publicKey: row.public_key }, plaintext);
        },
      };
      kernelEmitters.set(ctxRef, (event) => writeEvent(event, 'kernel'));
      return ctxRef;
    }

    /** True once this scope has had entitlements projected at least once (#304) — the switch
     *  from trust-upstream to strict fail-closed entitlement enforcement on the local path. */
    private entitlementsEnforced(): boolean {
      const row = this.sql
        .exec(`SELECT value FROM _substrat_meta WHERE key = 'entitlements_enforced'`)
        .toArray()[0] as { value: string } | undefined;
      return row?.value === '1';
    }

    /** 'local' once this scope has been projected, else 'control-plane' (default). */
    private permissionSource(): 'local' | 'control-plane' {
      const row = this.sql
        .exec(`SELECT value FROM _substrat_meta WHERE key = 'permission_source'`)
        .toArray()[0] as { value: string } | undefined;
      return row?.value === 'local' ? 'local' : 'control-plane';
    }

    /**
     * Whether a check here reads the directory over RPC (#938, Codex #2077 r5): the same
     * choice `controlPlaneReader` makes per call, asked each time a live fan-out pass opens an epoch.
     */
    private permissionSourceIsRemote(): boolean {
      return this.permissionSource() !== 'local' && Boolean(this.env.CONTROL_PLANE);
    }

    /**
     * The earliest `expires_at` after `now` in any local store a check or the parent walk
     * reads (#938, Codex #2077 r5), or null when nothing here lapses. Until then, no grant,
     * tenant tuple, parent edge or entitlement this scope holds can stop authorizing without
     * a write. Revoked rows are not excluded: an earlier bound only costs a re-check.
     */
    private authorityLapsesAfter(now: string): string | null {
      const row = this.sql
        .exec(
          `SELECT MIN(e) AS until FROM (
             SELECT MIN(expires_at) AS e FROM _substrat_tuples WHERE expires_at > ?
             UNION ALL SELECT MIN(expires_at) FROM _substrat_tenant_tuples WHERE expires_at > ?
             UNION ALL SELECT MIN(expires_at) FROM _substrat_entitlements WHERE expires_at > ?
           )`,
          now,
          now,
          now,
        )
        .toArray()[0] as { until: string | null } | undefined;
      return row?.until ?? null;
    }

    /**
     * The checker's tenant-tuple/role reader. Chosen **per call** (the source can
     * flip at runtime, and the checker holds this wrapper for the DO's lifetime):
     * a projected scope — or one with no `CONTROL_PLANE` binding to read — evaluates
     * from LOCAL storage (scope-local permissions); otherwise it reads the shared
     * directory DO over RPC (the pre-projection behaviour). Reading the marker is a
     * cheap local indexed lookup.
     */
    private controlPlaneReader(): ControlPlaneReader {
      const pick = (): ControlPlaneReader => {
        const ns = this.env.CONTROL_PLANE;
        if (this.permissionSource() === 'local' || !ns) {
          return createLocalControlPlaneReader(this.sql);
        }
        const stub = ns.get(ns.idFromName('control-plane')) as unknown as ControlPlaneReader;
        // The CP DO's `listEntitlements` returns raw rows (all keys, incl. expired) — a
        // different shape than the reader's view, so it is reached through a raw cast and
        // filtered/mapped here. Expiry is applied at read, matching the local reader.
        const rawStub = stub as unknown as {
          listEntitlements(tenantId: string): Promise<
            { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[]
          >;
        };
        return {
          tenantTuples: (tenantId, subject, relationPrefix) =>
            stub.tenantTuples(tenantId, subject, relationPrefix),
          getRole: (tenantId, key) => stub.getRole(tenantId, key),
          listEntitlements: async (tenantId): Promise<EntitlementView[]> => {
            const now = new Date().toISOString();
            return (await rawStub.listEntitlements(tenantId))
              .filter((r) => r.expires_at === null || r.expires_at > now)
              .map((r) => ({
                key: r.entitlement_key,
                plan: r.plan,
                quota: r.quota,
                expiresAt: r.expires_at as EntitlementView['expiresAt'],
              }));
          },
        };
      };
      return {
        tenantTuples: (tenantId, subject, relationPrefix) => pick().tenantTuples(tenantId, subject, relationPrefix),
        getRole: (tenantId, key) => pick().getRole(tenantId, key),
        listEntitlements: (tenantId) => pick().listEntitlements(tenantId),
      };
    }

    // -- scope-local permission projection (docs/architecture/scope-local-permissions.md) --
    // The write side of the local reader: the coordinator fans role/tuple changes
    // into a scope's own storage (Phase 2), then flips the source to 'local'. Public
    // RPC methods so `CloudflareScopeHost` (and the projection sweep) can call them.

    /** Project (upsert) a role definition into this scope. */
    async projectRole(tenantId: string, role: { key: string; permissions: string[]; source: string }): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source, revoked_at)
           VALUES (?, ?, ?, ?, NULL)`,
          tenantId,
          role.key,
          JSON.stringify(role.permissions),
          role.source,
        );
      });
    }

    /** Tombstone a projected role — it stops granting but stays as evidence (K-21). */
    async revokeProjectedRole(tenantId: string, key: string, revokedAt: string): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `UPDATE _substrat_roles SET revoked_at = ? WHERE tenant_id = ? AND role_key = ?`,
          revokedAt,
          tenantId,
          key,
        );
      });
    }

    /** Project (upsert) a tenant-level tuple into this scope. `revokedAt` tombstones it. */
    async projectTenantTuple(
      tenantId: string,
      subject: string,
      relation: string,
      object: string,
      expiresAt: string | null,
      revokedAt: string | null = null,
    ): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_tenant_tuples
             (tenant_id, subject, relation, object, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          tenantId,
          subject,
          relation,
          object,
          expiresAt,
          revokedAt,
        );
      });
    }

    /** Flip which reader the checker uses. 'local' makes projections authoritative. */
    async setPermissionSource(source: 'local' | 'control-plane'): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('permission_source', ?)`,
          source,
        );
      });
    }

    /** `applyProjection`, its refusal answered as DATA so its code survives the hop (#113). */
    applyProjectionReply(...args: Parameters<ScopeDO['applyProjection']>): Promise<DoReply<SwitchedOff[]>> {
      return replyOf(() => this.applyProjection(...args));
    }

    /**
     * Replace this scope's projected view of a tenant's roles + tenant-level tuples
     * with a fresh snapshot, and make it authoritative (source = 'local'). A full
     * replace so it converges regardless of prior state — the coordinator's fan-out
     * and the reconciliation sweep both call it (scope-local-permissions.md Phase 2).
     * One enqueued unit, so no half-applied projection is ever visible to a check.
     */
    async applyProjection(
      tenantId: string,
      roles: { role_key: string; permissions: string; source: string }[],
      tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[],
      /** The tenant's entitlements (#304) — projected alongside roles/tuples so a hosted
       *  vertical reads them locally. **Preserve-on-undefined**: omitting it (a role-only
       *  re-projection like the restore repair) leaves the projected entitlements untouched,
       *  while passing a list — even `[]` — full-replaces them. This keeps pre-#304 callers
       *  from silently wiping a scope's entitlements. */
      entitlements?: { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[],
      /** Scope-level tuples (e.g. the owner's role grant at provision) seated into
       *  `_substrat_tuples` in this SAME transaction, additively (#332). Preserve-on-undefined:
       *  omitting it leaves existing scope tuples untouched, so a role-only re-projection keeps
       *  the owner grant. Passing them here (rather than a follow-up `writeTuple`) is what makes
       *  provision atomic — the grant and the enforcement flip land together or not at all.
       *
       *  Seated, not replaced (#1659): a missing tuple is created, a revoked one stays revoked.
       *  `lockout_reseat` marks the one exception — the owner-of-record's seat, which is
       *  re-seated even over a revoke when the scope would otherwise hold no effective role
       *  grant (`hasEffectiveRoleGrant`). */
      scopeTuples?: {
        subject: string;
        relation: string;
        object: string;
        expires_at: string | null;
        lockout_reseat?: boolean;
      }[],
      /** The tenant's identity links (#406) — projected alongside the rest so a CP-less
       *  vertical's auth adapter resolves logins locally. Same preserve-on-undefined
       *  convention as `entitlements`: omitting it (a role-only re-projection like the
       *  restore repair) leaves projected links untouched; passing a list — even `[]` —
       *  full-replaces them, which is how an unlink reaches the scope. */
      identities?: { provider: string; external_id: string; principal_id: string; scope_id: string | null }[],
      /** Live connections' PUBLIC sealing keys (#687) — projected alongside the rest so a
       *  CP-less vertical can seal a value to a connector before emitting it. Same
       *  preserve-on-undefined convention as `entitlements` and `identities`: omitting it
       *  (a role-only re-projection like the restore repair) leaves projected keys
       *  untouched; passing a list — even `[]` — full-replaces them, which is how a
       *  revoked connection stops being sealable to. */
      connectionKeys?: { connection_id: string; provider: string; key_id: string; public_key: string }[],
      /** The directory's recorded-off modules (#1742), switched off in THIS unit right after the
       *  seat, so no sweep can run the grants the seat just re-created. `scopeId` is the scope
       *  this projection provisions (the object of `scopeTuples`), never another. */
      switchOff?: RecordedOffCarry & { scopeId: string; at: string },
      /** Declared service subjects excluded only from human lockout repair (#1896). */
      serviceSubjects?: readonly string[],
    ): Promise<SwitchedOff[]> {
      if (await this.isReaped()) return [];
      // A projection that arrives after this scope was reaped is dropped, not
      // applied: writing it would recreate storage the platform deliberately
      // destroyed. Silent rather than throwing — the fan-out is a best-effort
      // convergence over many scopes and one dead sibling must not fail the others,
      // and a reaped scope converging to "nothing" IS convergence.
      // The whole body is synchronous storage work, so it is ONE transaction (#1738): the queue
      // serializes but does not roll back, and a role insert that throws part-way must not leave
      // the receipt (or a half-replaced role set) behind for `servesTenant` to trust.
      return this.queue.enqueue(() =>
        this.revision.transactionSync(() => {
          // #1738: the receipt `servesTenant` reads. First writer wins: absent or equal is written,
          // a receipt for ANOTHER tenant refuses the whole projection (K-3), before a single row
          // moves, so a misdirected projection can never re-point a scope or leave its roles behind.
          // A restore does not trip this: `importDump` keeps the destination's own receipt and
          // never the dump's (#2016), so the repair projection that follows finds its own tenant.
          // #2016: a scope with no receipt yet takes its first one only where its role rows agree
          // (`tenantVerdict`, the same reading the lifecycle back-fill uses), so a projection for
          // another tenant cannot pin a legacy scope to it.
          const { verdict, held } = this.tenantVerdict(tenantId);
          if (verdict === 'foreign') {
            throw substratError(
              'conflict',
              held !== null
                ? `applyProjection refused: this scope was provisioned for tenant ${held}, and a projection for tenant ${tenantId} would re-point it`
                : `applyProjection ${foreignTenant(held, tenantId)}`,
            );
          }
          // Written before any guard below can return early, so every projection leaves it.
          this.sql.exec(`INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES (?, ?)`, PROVISIONED_FOR_KEY, tenantId);
          this.sql.exec(`DELETE FROM _substrat_roles WHERE tenant_id = ?`, tenantId);
          for (const r of roles) {
            this.sql.exec(
              `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source, revoked_at)
               VALUES (?, ?, ?, ?, NULL)`,
              tenantId,
              r.role_key,
              r.permissions,
              r.source,
            );
          }
          this.sql.exec(`DELETE FROM _substrat_tenant_tuples WHERE tenant_id = ?`, tenantId);
          for (const t of tuples) {
            this.sql.exec(
              `INSERT OR REPLACE INTO _substrat_tenant_tuples
                 (tenant_id, subject, relation, object, expires_at, revoked_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              tenantId,
              t.subject,
              t.relation,
              t.object,
              t.expires_at,
              t.revoked_at,
            );
          }
          if (entitlements !== undefined) {
            this.sql.exec(`DELETE FROM _substrat_entitlements WHERE tenant_id = ?`, tenantId);
            for (const e of entitlements) {
              this.sql.exec(
                `INSERT OR REPLACE INTO _substrat_entitlements
                   (tenant_id, entitlement_key, expires_at, quota, plan)
                 VALUES (?, ?, ?, ?, ?)`,
                tenantId,
                e.entitlement_key,
                e.expires_at,
                e.quota,
                e.plan,
              );
            }
            // #304: once a scope has been projected WITH entitlements even once, its gate
            // switches from trust-upstream to strict fail-closed (a missing/expired key
            // denies). Left unset, a scope provisioned before #304 keeps trusting upstream
            // until a projection (fanOut / reconcile / re-provision) back-fills it — so the
            // enforcement flip is per-scope and never strands an un-back-filled scope.
            this.sql.exec(
              `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('entitlements_enforced', '1')`,
            );
          }
          // #406: identity links ride the same snapshot. Full replace, so an unlink is
          // durable against every later projection — unlike the compiled-in map this
          // replaces, where a version rollback silently resurrected a removed login.
          if (identities !== undefined) {
            this.sql.exec(`DELETE FROM _substrat_identity_links WHERE tenant_id = ?`, tenantId);
            for (const i of identities) {
              this.sql.exec(
                `INSERT OR REPLACE INTO _substrat_identity_links
                   (tenant_id, provider, external_id, principal_id, scope_id)
                 VALUES (?, ?, ?, ?, ?)`,
                tenantId,
                i.provider,
                i.external_id,
                i.principal_id,
                i.scope_id,
              );
            }
          }
          // #687: connection sealing keys ride the same snapshot. Full replace, so a
          // revoked connection's key stops being projected and `sealToConnection` starts
          // refusing — the same fail-closed direction an unlinked identity takes.
          if (connectionKeys !== undefined) {
            this.sql.exec(`DELETE FROM _substrat_connection_keys WHERE tenant_id = ?`, tenantId);
            for (const k of connectionKeys) {
              this.sql.exec(
                `INSERT OR REPLACE INTO _substrat_connection_keys
                   (tenant_id, connection_id, provider, key_id, public_key)
                 VALUES (?, ?, ?, ?, ?)`,
                tenantId,
                k.connection_id,
                k.provider,
                k.key_id,
                k.public_key,
              );
            }
          }
          // #332: scope-level grants (the owner's role tuple at provision) are written in the
          // SAME enqueued unit as the projection and the enforcement flip below. Additive upsert
          // — NOT a full replace — so existing scope tuples are preserved. This is what keeps a
          // scope from ever being left "roles projected, permission_source=local, zero tuples" by
          // a write that lands the projection but drops before a follow-up owner grant.
          //
          // #1659: SEATED, so a reconcile creates what is missing and leaves a revoke alone. It
          // used to be `INSERT OR REPLACE … revoked_at = NULL`, which undid an operator's revoke
          // of the owner seat or of a `system:` schedule grant on the next reconcile. And a
          // module switched off (#1666) gets no `system:` grant seated, new or old.
          for (const st of scopeTuples ?? []) {
            const seat = seatScopeTuple(st.subject, st.relation, st.object, st.expires_at);
            this.sql.exec(seat.sql, ...seat.params);
          }
          // #1659's one exception: the owner-of-record's seat comes back over a revoke when
          // No HUMAN holder remains — declared service subjects cannot prevent lockout repair.
          // That is the #332 lockout this path exists to repair. The flip guard below still
          // counts service authority; only the repair excludes the declared service subjects.
          // With any other effective holder, the revoke stands: a hand-over that seats a
          // successor before unseating the owner is not undone by the next promote. A holder of
          // a role the vertical no longer defines is NOT one — it passes no check, so it must
          // not stand in for the holder this repair exists to restore.
          if (roles.length > 0 && !this.hasEffectiveRoleGrant(tenantId, serviceSubjects)) {
            for (const st of scopeTuples ?? []) {
              if (!st.lockout_reseat) continue;
              this.sql.exec(
                `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at)
                 VALUES (?, ?, ?, ?, NULL)`,
                st.subject,
                st.relation,
                st.object,
                st.expires_at,
              );
            }
          }
          // #1742: the directory's recorded-off modules go back off HERE, after the seat and in
          // its unit. A wiped scope's seat has just re-created their `system:` grants (#1659), and
          // a re-assert arriving later from the control plane left a window in which this
          // deployment's own sweeper could fire them. Nothing runs between these two lines.
          const switched = switchOff ? switchRecordedOff(this.switchSql(), switchOff) : [];
          // #332: only switch on strict local enforcement when SOMEONE actually holds a role.
          // A projection that leaves role definitions but no effective principal→role grant would
          // make every check fail closed — a scope serving nothing but denials, unfixable from
          // inside. Leave `permission_source` as-is instead; a reconcile that restores the owner
          // grant re-runs this and flips safely. (A CP-less vertical uses the local reader
          // regardless of this flag, so the owner grant is written above in the same unit — this
          // guard is the belt to that suspenders, and it protects the CP-backed flip outright.)
          if (roles.length > 0 && !this.hasEffectiveRoleGrant(tenantId)) return switched;
          this.sql.exec(
            `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('permission_source', 'local')`,
          );
          return switched;
        }),
      );
    }

    /**
     * Resolve an external identity from this scope's projected links (#406) — the
     * CP-less auth adapter's read path, the local equivalent of the control plane's
     * `resolveIdentity`. A miss is `undefined`, which the caller must treat as an
     * unknown login (deny): an un-projected or stale-empty scope can only ever
     * refuse a legitimate login, never admit a revoked one.
     */
    async resolveProjectedIdentity(
      tenantId: string,
      provider: string,
      externalId: string,
    ): Promise<{ principal: string; scopeId: string | null } | undefined> {
      const row = this.sql
        .exec(
          `SELECT principal_id, scope_id FROM _substrat_identity_links
           WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
          tenantId,
          provider,
          externalId,
        )
        .toArray()[0] as unknown as { principal_id: string; scope_id: string | null } | undefined;
      if (!row) return undefined;
      return { principal: row.principal_id, scopeId: row.scope_id };
    }

    /** True if some principal holds a role this scope can actually EXPAND — a live
     *  (non-revoked, unexpired) `role:<key>` tuple, at scope OR tenant level, whose key names a
     *  current, non-revoked role definition for this tenant. The one predicate behind both the
     *  #332 flip guard and #1659's owner re-seat in `applyProjection`; the query is the
     *  kernel's `effectiveRoleGrantQuery`, where it is tested against a real SQLite. A tuple
     *  for a role the vertical no longer defines counts for nothing, exactly as in the local
     *  checker, which expands a role only through its definition. */
    private hasEffectiveRoleGrant(tenantId: string, excludedSubjects?: readonly string[]): boolean {
      const q = effectiveRoleGrantQuery(tenantId, new Date().toISOString(), undefined, excludedSubjects);
      const row = this.sql.exec(q.sql, ...q.params).toArray()[0] as { effective: number } | undefined;
      return row?.effective === 1;
    }
  };
}
