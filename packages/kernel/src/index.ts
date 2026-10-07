export type {
  AccessLogFilter,
  AttachmentSearchOptions,
  AttachmentUploadInput,
  AuditLogFilter,
  BlobStoreProvisionInput,
  BlobStoreRecord,
  ConsumerHandler,
  ImportHandler,
  ExecutorDeadLetter,
  ExecutorDrainReport,
  ExecutorHandler,
  ExecutorOutcome,
  ExecutorRetryPolicy,
  ExecutorScope,
  MembershipChange,
  MembershipChangeResult,
  ConnectorConnection,
  ScopedConnectorConnection,
  ConnectorContext,
  ConnectorHandler,
  ConnectorOptions,
  ConnectorRequestInit,
  ConnectorResponse,
  Clock,
  FetchLike,
  GuardPredicate,
  HostAdmin,
  MigrateScopeOutcome,
  MigrationFrontier,
  ModuleRegistration,
  ConsumersOf,
  EventContract,
  EventPayloadOf,
  EventTypeOf,
  TypedConsumerHandler,
  TypedConsumers,
  OpenedAttachment,
  OperationContext,
  PageParams,
  OperationHandler,
  AppliedMigration,
  OpsFailureFilter,
  OpsFailureInput,
  KeptCopyResolution,
  IssueFilter,
  TelemetryPruneReport,
  SweepRunFilter,
  SweepRunInput,
  ProvisionScopeInput,
  RoleFilter,
  FreshnessRegistration,
  FreshnessReport,
  LiveChange,
  LiveFrame,
  LiveNudge,
  LiveReadSurface,
  LiveUpgradeRequest,
  OperationEntitlement,
  ScheduleRegistration,
  ScheduleRunReport,
  ScopeAttachments,
  ScopedSql,
  ScopeFilter,
  ScopeHost,
  ScopeStub,
  ScopeStubOptions,
  InvokeOptions,
  EmittedEvent,
  EmittedReport,
  SqlMigration,
  SqlValue,
  TenantBlobStore,
  TenantRelationalStore,
  TenantStoreProvisionInput,
  TenantStoreRecord,
} from './scope-host.js';
export type {
  /** @deprecated Import from `@substrat-run/adapter-cloudflare` (#1978); this kernel export goes in a later release. */
  AnalyticsEngineDatasetLike,
  ConnectionUseOutcome,
  ConnectionUseTiming,
  ConnectorCallErrorType,
  ConnectorCallRecord,
  ConnectorCallRecorder,
  CountingConnectorCallRecorder,
} from './connector-calls.js';
export {
  /** @deprecated Import from `@substrat-run/adapter-cloudflare` (#1978); this kernel export goes in a later release. */
  CONNECTOR_CALL_DATA_POINT_LAYOUT,
  CONNECTOR_CALL_ERROR_TYPES,
  /** @deprecated Import from `@substrat-run/adapter-cloudflare` (#1978); this kernel export goes in a later release. */
  analyticsEngineConnectorCallRecorder,
  /** @deprecated Import from `@substrat-run/adapter-cloudflare` (#1978); this kernel export goes in a later release. */
  connectorCallDataPoint,
  connectorCallErrorType,
  connectorCallRecord,
  noopConnectorCallRecorder,
  recordConnectorCall,
  settleConnectionUse,
} from './connector-calls.js';
export {
  assertRedrainWindow,
  attachmentBlobKey,
  attachmentSha256,
  consumersFor,
  entitlementDenial,
  requiredEntitlementFor,
  backoffAt,
  globalFetch,
  executorOutcomeOf,
  parseValidationRecords,
  resolveRetryPolicy,
  OPS_FAILURE_RETENTION_DAYS,
  SWEEP_RUN_RETENTION_DAYS,
  SWEEP_RUNS_INTENT_INDEX,
  sweepRunsIntentHasKind,
  ISSUE_RETENTION_DAYS,
  telemetryRetentionStatements,
  TELEMETRY_PRUNE_BATCH,
  assertRowLimit,
  assertRowOffset,
  EMITTED_REPORT_CAP,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  isUpgradeRequest,
  isVouchedWithin,
  vouchedWithin,
  type VouchedWithin,
  checkedWithin,
  isCheckedWithin,
  type CheckedWithin,
  LIVE_CLOSE,
  LIVE_SOCKETS_PER_PRINCIPAL,
} from './scope-host.js';
export {
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  LIVE_MODE_HEADER,
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  type LiveRefusal,
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  PLATFORM_SECRET_HEADER,
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  PLATFORM_REQUEST_HEADER,
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  EXPORTED_EVENTS_HEADER,
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  CONNECTOR_ATTACHMENT_RECORD_HEADER,
} from '@substrat-run/contracts/wire-headers';
export {
  isSecretBoxConfigured,
  SecretBoxUnconfiguredError,
  unconfiguredSecretBox,
  webCryptoSecretBox,
} from './secret-box.js';
export type { SealedSecret, SecretBox } from './secret-box.js';
export {
  ConnectionSealingKeyUnavailableError,
  generateSealingKeyPair,
  noSealingKeyMessage,
  openSealed,
  sealTo,
  SealedKeyUnavailableError,
} from './sealed-box.js';
export type { SealingKeyPair, SealingPublicKey } from './sealed-box.js';
export { createSubjectKeys } from './subject-keys.js';
export type { SubjectKeyRecords, SubjectKeyRow, SubjectKeys } from './subject-keys.js';
export { resolveScopeRecord } from './scope-record.js';
export type { ResolvedScopeRecord } from './scope-record.js';
export {
  assertAllowed,
  denyAllChecker,
  PermissionDenied,
  UNSAFE_allowAllChecker,
} from './permission-checker.js';
export { actorOf, asPrincipal, isUnknownRoleError, unknownRoleError } from './permission-checker.js';
export type { PermissionChecker } from './permission-checker.js';
export {
  ancestorsWithin,
  createTupleEvaluator,
  joinedMembershipExpiry,
  liveOrgMembership,
  memberAddedAudit,
  orgChangeBound,
  reachesWithin,
  tenantCoverage,
} from './permission-eval.js';
export type {
  PermissionTupleReader,
  TenantDirectoryReader,
  PermissionTupleRow,
  ScopeTupleReader,
} from './permission-eval.js';
export {
  CAPABILITY_COLUMNS,
  CAPABILITY_DDL,
  CAPABILITY_EXCHANGE_OPERATION,
  CAPABILITY_SESSION_PRUNE_BATCH,
  WITHHELD_SECRET,
  assertNoSecret,
  capabilityAttachmentWriteRefused,
  capabilityByIdQuery,
  capabilityExchangeable,
  capabilityGrantOf,
  capabilityListQuery,
  capabilityLive,
  capabilityRecordOf,
  capabilityTokenHash,
  carriesSecret,
  checkBecomeInput,
  createCapabilityVerbs,
  exchangeCapability,
  guardSecrets,
  mintBecomeCapability,
  mintCapabilitySecret,
  mintCapabilitySessionToken,
  persistedText,
  readCapabilities,
  readCapabilityPage,
  plausibleSessionToken,
  plausibleCapabilitySecret,
  redactSecrets,
  redactSecretText,
  resolveCapabilitySession,
  revokeCapabilityAsPlatform,
} from './capability.js';
export type {
  CapabilityGrantView,
  CapabilityRow,
  CapabilityVerbDeps,
  CapabilityVerbs,
} from './capability.js';
export { createEntityEdgeVerbs } from './entity-edges.js';
export type { EntityEdgeDeps, EntityEdgeVerbs } from './entity-edges.js';
export {
  addStatePlans,
  createEntityStateVerbs,
  entityStateMigrations,
  entityStatePlans,
  entityStateTriggerDdl,
  assertEntityStateIntact,
  ENTITY_STATE_MOVES_DDL,
  ENTITY_STATE_MOVES_TABLE,
  statefulTablesOf,
  entityStateWhere,
  stateColumnsOf,
  purgeIndexDdl,
} from './entity-state.js';
export {
  PURGE_BATCH,
  assertNoCallerPurge,
  isUnreachableParent,
  purgeCandidates,
  purgeCutoffOf,
  purgeDueOf,
  purgeHeldBy,
  purgeOnlyKeysOf,
  purgeReportOf,
  purgeStillDue,
  refuseTrashedTarget,
  registerTrashTargets,
  runPurgePass,
  withheldKeysFor,
} from './entity-trash.js';
export type { PurgeGateFacts, PurgePass, TrashRefusalDeps } from './entity-trash.js';
export type { EntityStateDeps, EntityStatePlan, EntityStateVerbs, StateColumns } from './entity-state.js';
export { TRASH_SCAN_BUDGET, createTrashedReads, searchStateWhere, uncheckedView } from './entity-state-reads.js';
export type { TrashedReadDeps, TrashedReads } from './entity-state-reads.js';
export { createAtomic } from './sub-transaction.js';
export type { RunSub, AtomicMarks } from './sub-transaction.js';
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_TERM,
  NotSearchable,
  SEARCH_INDEX_PREFIX,
  SearchTermTooShort,
  isSearchIndexTable,
  searchIndexDdl,
  searchIndexMigrations,
  searchIndexPlans,
  searchLimit,
  searchMatchExpression,
  searchPlansByEntityType,
  searchQuery,
} from './search-index.js';
export type {
  SearchHit,
  SearchIndexPlan,
  SearchOptions,
  SearchTokenizer,
  SearchableDeclaration,
} from './search-index.js';
export {
  ATTACHMENT_SEARCH_OWNER_MAX,
  ATTACHMENT_SEARCH_OWNERS_SQL,
  ATTACHMENT_SEARCH_SQL,
  ATTACHMENT_SEARCH_TOO_MANY_OWNERS,
  ATTACHMENT_TEXT_BACKFILL_BATCH,
  ATTACHMENT_TEXT_BACKFILL_JOB,
  ATTACHMENT_TEXT_DDL,
  ATTACHMENT_TEXT_JOB,
  ATTACHMENT_TEXT_MODULE,
  assertJobRegistrable,
  attachmentRecordOfRow,
  attachmentTextBackfillJob,
  attachmentTextJob,
  enqueueAttachmentText,
  kernelJobFor,
  isAttachmentTextRun,
  queueAttachmentTextBackfill,
  readAttachmentText,
  reconcileAttachmentText,
  recordAttachmentText,
  searchAttachments,
  startAttachmentTextBackfill,
} from './attachment-text.js';
export type {
  AttachmentRowShape,
  AttachmentTextBackfillBatch,
  KernelJobHandlers,
  AttachmentSearchGate,
  AttachmentTextSource,
  AttachmentTextState,
  AttachmentTextStatus,
} from './attachment-text.js';
export {
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  EXTRACTION_STRIDE,
  assertAttachmentExtractors,
  assertAttachmentTextBounds,
  chooseAttachmentExtractor,
  inputBoundRefusal,
  isPositiveIntegerBound,
  mediaTypeOf,
  normalizeExtractedText,
  resolveAttachmentTextBounds,
  runAttachmentExtractor,
  truncateUtf8,
} from './attachment-extractor.js';
export type {
  AttachmentExtractor,
  AttachmentExtractorInput,
  AttachmentExtractorResult,
  AttachmentTextBounds,
  ExtractionOutcome,
  ExtractionSignal,
} from './attachment-extractor.js';
export {
  CursorMismatch,
  FilterNotDeclared,
  LIST_INDEX_PREFIX,
  NotListable,
  SortNotDeclared,
  cursorOf,
  isListIndexName,
  listIndexColumns,
  listIndexDdl,
  listIndexMigrations,
  listIndexPlans,
  stateListIndexNames,
  listPlansByEntityType,
  listQuery,
  splitCursor,
} from './list-index.js';
export type {
  ComposedListQuery,
  ListDeclaration,
  ListIndexPlan,
  ListQueryParams,
} from './list-index.js';
export { moduleMigrations } from './module-migrations.js';
export {
  MIGRATION_DIGEST_FENCE_DDL,
  MIGRATION_DIGEST_LEGACY,
  MIGRATION_DIGEST_MARK_LEGACY,
  assertJournalDumpCoherent,
  assertMigrationSql,
  assertNoJournalSql,
  migrationDigest,
  migrationDivergence,
  migrationFailedError,
  migrationSteps,
  planMigrations,
  type MigrationPlan,
  type MigrationStep,
  type PendingMigration,
} from './migration-digest.js';
export { frozenClock, manualClock } from './clock.js';
export type { ManualClock } from './clock.js';
export { createUlid, ulid, ulidCeiling, ulidFloor, ulidTime, type UlidMint } from './ulid.js';
export { assertReadOnlyQuery } from './read-only-sql.js';
export { assertNoReservedColumnWrite, assertNoSpineReference, assertNoSpineWrite, assertNoStatefulDdl, changesSchema, guardSpine } from './spine-guard.js';
export {
  DO_SQL_LIMITS,
  tooManyResultColumns,
  tooManyTableColumns,
  assertWithinSqlLimits,
  guardSqlLimits,
} from './sql-limits.js';
export { assertPermissionKey } from './check-key.js';
export { assertModuleEnqueueableKind } from './platform-kinds.js';
export {
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  readRoutedNode,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  RouterAssertionError,
} from './routed-node.js';
export type {
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  RoutedNode,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  HeaderReader,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  ReadRoutedNodeOptions,
} from './routed-node.js';
export {
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  assertPlatformCall,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  PlatformCallError,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  kickFlags,
} from './platform-call.js';
export {
  signConnectState,
  verifyConnectState,
  ConnectStateError,
  CONNECT_STATE_PURPOSE,
} from './connect-state.js';
export type { ConnectStateClaim } from './connect-state.js';
export {
  PLATFORM_REQUEST_COLUMNS,
  platformRequestHistoryQuery,
  platformRequestOf,
  UNDECODED_REQUESTER,
} from './platform-request-query.js';
export type { PlatformRequestRawRow } from './platform-request-query.js';
export {
  CANCELLED_INTENT_NOTE,
  CANCELLED_JOB_NOTE,
  DELIVERY_ERROR_REDACTION_SQL,
  intentPayloadCarriesSubject,
  JOB_RUN_REDACTION_SQL,
  JOB_STEP_REDACTION_SQL,
  PLATFORM_REQUEST_REDACTION_SQL,
  platformRequestRedactionParams,
  platformRequestRedactionQuery,
  REDACTED_DELIVERY_NOTE,
  REDACTED_INTENT_MARKER,
  REDACTED_INTENT_NOTE,
  REDACTED_JOB_NOTE,
  redactedIntentPayload,
  redactSubjectJobRuns,
  REDACTED_FAILURE_NOTE,
  redactSubjectScopeText,
  ISSUE_EXEMPLAR_OWNER_BACKFILL_SQL,
  issueExemplarOwner,
  redactSubjectDirectoryText,
  platformIntentFailureMessage,
  intentIdOfFailureMessage,
} from './subject-redaction.js';
export type {
  LegacySubjectRedactionCounts,
  PlatformRequestRedactionCandidate,
  RedactionSql,
  SubjectRedactionCounts,
  SubjectTextTarget,
  IssueExemplarOwner,
} from './subject-redaction.js';
export {
  assertWithinErasureReach,
  eraseSubjectFromModules,
  isModuleErasureCounts,
  moduleErasurePlan,
  moduleRowsErased,
  SECURE_DELETE_MIN_SQLITE,
  tablesCreatedBy,
} from './module-erasure.js';
export {
  TABLE_OWNERS,
  TABLE_OWNERS_DDL,
  applyTableChange,
  assertMigrationLeavesLedgerAlone,
  assertTablesOwned,
  backfillOwnershipFromJournal,
  moduleTableNames,
  recordOwnershipSteps,
  runMigrationStatements,
  tableChangesOf,
  tableStatements,
} from './table-ownership.js';
export type { OwnerStore, TableChange, TableStatement, TableStep } from './table-ownership.js';
export { blankSqlComments, executableSqlStatements, splitSqlStatements } from './sql-statements.js';
export type {
  ModuleErasureCounts,
  ModuleErasurePlan,
  OnSubjectErased,
  SubjectErasureContext,
} from './module-erasure.js';
export {
  FINDINGS_DDL,
  FINDING_RETENTION_DAYS,
  createFindingRule,
  findingOfOpsFailure,
  findingOfSweepRun,
  pruneFindings,
  listFindingRules,
  listFindings,
  observeFinding,
  revokeFindingRule,
  setFindingStatus,
  type FindingPruneReport,
  type FindingAudit,
  type FindingChange,
  type FindingObservation,
} from './findings.js';
export { effectiveRoleGrantQuery, seatScopeTuple } from './scope-tuple-seat.js';
export { delegatedGrantSql, delegatedRevokeSql } from './entity-grant.js';
export { grantEntityShapeIn, shapeTopUpBatch, topUpEntityGrantShapes } from './entity-grant-shape.js';
export type { ShapePass } from './entity-grant-shape.js';
export { applyScopeRoleChange, changeScopeRole, combineCoverage, revokeScopeRoles, scopeRoleHolders, type Atomically, type RoleBound, type ScopeRoleHolder } from './scope-role-admin.js';
export { repointScopeGrants, type RepointSource } from './scope-repoint.js';
export { COPY_ORIGIN_DDL, capabilitiesForLoad, clearCopyMarker, emittedHere, isCopyLoad, IS_COPY_SQL, MARK_COPY_ORIGIN_SQL, markCopyOrigin, settleCopiedWork } from './scope-copy.js';
export { isLifecycleWrite, lifecycleAfterLoad, lifecycleReceipt, lifecycleRefusal, readLifecycle, settleLifecycleAfterLoad, SCOPE_LIFECYCLE_KEY, WRITE_LIFECYCLE_SQL, writeLifecycle } from './scope-lifecycle.js';
export { CARRIED_AWAY_KEY, COPY_MARK_CLEARED_KEY, KEPT_COPY_REFUSAL, KEPT_DIVERGENT_KEY, LOAD_STAMP_KEY, STORE_LOCAL_META_KEYS, WRITE_REVISION_KEY, type KeptCopy, carriedAwayDump, dumpMetaValue, isCopyMarkInsert, isWriteStatement, metaValueIn, type CarriedAway, type LoadMarker } from './carried-copy.js';
export { LEGACY_SCOPE_ROWS_BACKFILL, assertDirectoryTablesBuilt, assertSpineTablesBuilt, dumpRowsInsert, isSpineTable, loadDirectoryDump, spineColumnAdditions, spineRowsInsert, type KernelColumnsOf } from './spine-restore.js';
export {
  SYSTEM_SWITCH_OFF_PREDICATE,
  SYSTEM_SWITCH_OFF_QUERY,
  SYSTEM_SWITCH_OFF_RELATION,
  subjectSwitchedOff,
  SWITCH_FENCES_DDL,
  moveSwitch,
  recordedOffFromWire,
  switchRecordedOff,
  switchSubjectGrants,
  switchSystemSchedules,
  subjectGrantState,
  systemGrantsStatus,
  systemScheduleState,
  systemSwitchedOff,
  systemSwitchedOffMessage,
  tenantSystemSwitchedOffMessage,
} from './system-switch.js';
export type {
  RecordedOffCarry,
  SwitchCarryWire,
  SwitchOutcome,
  SwitchSql,
  SwitchedOff,
  SystemGrantsEntry,
  SystemScheduleState,
} from './system-switch.js';
export {
  PEER_SWITCHES_DDL,
  SWITCH_KINDS,
  SWITCH_OWED_DDL,
  SYSTEM_SWITCHES_DDL,
  SYSTEM_SWITCHES_TABLE,
  clearSwitchOwed,
  scopeOwesSwitch,
  markSwitchOwed,
  switchesOwedOf,
  dumpCarriesSwitches,
  forgetSwitchesOf,
  inUnitMovesToAudit,
  listSystemSwitchRecords,
  reassertActionOf,
  recordWriteSuperseded,
  reassertEntry,
  reassertOffRow,
  reassertOnRow,
  recordSwitchedOff,
  recordSwitchedOn,
  restoreSwitchRecord,
  scopesSwitchedOffFor,
  staleCarryRevertRow,
  staleCarryReverts,
  reportKeyOf,
  switchActionOf,
  switchAuditSubject,
  switchNotFoundMessage,
  switchFencesOf,
  switchRecordStatesOf,
  switchRecordsOf,
  switchSubjectOf,
  switchSupersededMessage,
  switchedOffOf,
  switchesBackfillSqlOf,
  switchesDdlOf,
  switchesTableExists,
  switchesTableOf,
  tenantHeldOf,
  tenantHoldsGrant,
  withRecorded,
} from './system-switch-record.js';
export type {
  InUnitReport,
  SwitchKind,
  SwitchRecordPrior,
  SwitchRecordWrite,
  SystemSwitchReassert,
  SystemSwitchReassertOptions,
  SystemSwitchRecordFilter,
  SystemSwitchRecordRow,
} from './system-switch-record.js';
export { ADMIN_LOG_INDEX_DDL, ADMIN_LOG_INDEXES_SQL } from './admin-log-ddl.js';
export {
  AUDITED_CHANGE_ACTIONS,
  AUDITED_OPERATIONS_BATCH,
  SETTLE_INTENT_SQL,
  SETTLE_OUTCOME_SQL,
  settleOutcomeParamsOf,
  operationKeyOf,
  auditedOperationsSql,
  effectiveOutcomes,
  isSupersededOutcome,
  readAuditedOperations,
  unknownOutcomeOf,
} from './audit-outcome.js';
export type {
  AuditedChangeAction,
  AuditedOperationRef,
  AuditedOperationRow,
  AuditedOperationSqlRow,
  AuditedPhase,
  EffectiveOutcome,
  OperationKey,
  SettleIntentRow,
  UnknownOutcome,
} from './audit-outcome.js';
export {
  VERSION_MIGRATIONS_DDL,
  splitManifestMigrations,
  splitVersionMigrationsBatch,
  versionMigrationsOf,
  versionsAwaitSplit,
  writeVersionMigrations,
} from './version-migrations.js';
export type { SplitManifest } from './version-migrations.js';
export {
  PEER_SUBJECT_PREFIX,
  admitPeer,
  collectPeers,
  peerGrantsStatus,
  peerSeats,
  peerSubjectRef,
  peerSwitchedOff,
  resolveVerticalInstanceFrom,
  switchPeer,
} from './peer.js';
export type { PeerDeclaration, PeerDeclarations, PeerGrantsRow, PeerSeat, VerticalInstanceCandidate } from './peer.js';
export {
  DENIAL_COLUMNS,
  DENIAL_WINDOW_QUERY,
  denialListQuery,
  denialSummaryQuery,
  denialTotalsQuery,
  mapDenialRow,
  mapDenialBucketRow,
  mapDenialOperationBucketRow,
  mapDenialSummaryBuckets,
  storedActor,
  type DenialRow,
  type DenialBucketRow,
  type DenialOperationBucketRow,
  type DenialSummaryBuckets,
  type DenialWindowRow,
} from './denial-query.js';
export {
  entityVersionQuery,
  entityVersionOf,
  assertIfMatch,
  OUTBOX_ENTITY_INDEX,
  type EntityVersion,
  type EntityVersionRow,
} from './entity-version.js';
export {
  IMPERSONATION_COLUMNS,
  IMPERSONATION_DDL,
  ImpersonationRefused,
  assertImpersonationWrites,
  assertSessionUsable,
  impersonationByIdQuery,
  impersonationListQuery,
  impersonationRowValues,
  impersonationStampOf,
  mapImpersonationRow,
  newImpersonationSession,
  type ImpersonationRow,
} from './impersonation.js';
export { readLifecycleFlow } from './lifecycle-flow.js';
export { OPERATION_SERIES_ID_SLACK_MS, operationSeriesQuery, readOperationSeries } from './operation-series.js';
export {
  REFUSALS_DDL,
  REFUSALS_INDEX,
  REFUSALS_REBUILD,
  REFUSALS_TABLE_DDL,
  markGuardRefusal,
  refusalInsert,
  refusalOf,
  refusalsAdmitGuards,
  refusedTransitionOf,
  type RefusalRow,
  type RefusedGuard,
} from './refusals.js';
export { REFUSAL_COLUMNS, mapRefusalRow, refusalListQuery, type RefusalDbRow } from './refusal-query.js';
export { readTimeline, readHistory, readScopeTimeline, readScopeHistory, facetEvents, walkEventCause, walkEventEffects, readInvocation, readDeadLetters, readExecutorDelivery, type ExecutorDelivery, type ExecutorDeliveryState } from './timeline.js';
export type { ScopeWalkPage } from './timeline.js';
export type { TimelineReader } from './timeline.js';
// #1636: one undecodable spine row no longer takes a list — or a delivery loop — with it.
export { rowDecoder, UNDECODED_ACTOR, UNDECODED_PERMISSION } from './row-decode.js';
export type { RowDecoder } from './row-decode.js';
export {
  domainEventOf,
  drainedEventOf,
  readUndrainedOutbox,
  undrainedEventsOf,
  UNDRAINED_SCAN_FACTOR,
  UNDRAINED_SKIPPED_IDS,
} from './outbox-event.js';
export type {
  OutboxEnvelopeRow,
  OutboxDrainRow,
  UndrainedEvents,
  UndrainedRead,
  UndrainedSkipped,
} from './outbox-event.js';
export {
  IDEMPOTENCY_DDL,
  assertIdempotencyKey,
  idempotencyLookupQuery,
  idempotencyPruneStatement,
  idempotencyRecordStatement,
  idempotencySubject,
  idempotencyOptedOutMessage,
  replayFor,
  type IdempotencyRow,
  type IdempotentReplay,
} from './idempotency.js';
export {
  JOB_RUN_DDL,
  JOB_RUN_PATCH_SQL,
  JOB_RUN_CLAIM_SQL,
  JOB_RUN_RENEW_SQL,
  JOB_RUN_BEGIN_SQL,
  JOB_RUN_MISS_SQL,
  JOB_RUN_MISS_SETTLE_SQL,
  admissionMissOutcome,
  JOB_STEP_RECORD_SQL,
  JOB_LEASE_MS,
  JOB_LEASE_MIN_MS,
  JOB_LEASE_ENTRY_MARGIN,
  JOB_ADMISSION_MISS_MAX,
  JOB_ADMISSION_BACKOFF_BASE_MS,
  JOB_ADMISSION_BACKOFF_MAX_MS,
  JOB_LEASE_TOO_SHORT_NOTE,
  admissionBackoffMs,
  JOB_LEASE_EXPIRED_NOTE,
  assertLeaseMs,
  JOB_DRIVE_LIMIT,
  JOB_DRIVE_SCAN_MAX,
  JOB_RUN_LIST_LIMIT,
  JOB_RUN_LIST_MAX,
  jobRunListLimit,
  JOB_STEP_REUSED,
  SYSTEM_DOOR_WAIT,
  JOB_DEFER_MS,
  JOB_RUN_DUE_AT,
  assertQueueSafe,
  jobRunOf,
  runDueJobRuns,
  runJobPass,
  startJobRun,
} from './job-run.js';
export type {
  JobDueKey,
  JobDriveReport,
  JobHandler,
  JobPassContext,
  JobPassOutcome,
  JobPassResult,
  JobRun,
  JobRegistration,
  JobRunClaim,
  JobRunFilter,
  JobRunKey,
  JobRunPatch,
  JobRunRow,
  JobRunStatus,
  JobRunStore,
  JobStepRow,
  StartJobRunInput,
} from './job-run.js';
export {
  /** @deprecated Import from `@substrat-run/control-plane-api` (#1978); this kernel export goes in a later release. */
  isTerminalDispatchFailure,
  /** @deprecated Import from `@substrat-run/control-plane-api` (#1978); this kernel export goes in a later release. */
  isTerminalProviderError,
  /** @deprecated Import from `@substrat-run/control-plane-api` (#1978); this kernel export goes in a later release. */
  providerErrorStatus,
  /** @deprecated Import from `@substrat-run/control-plane-api` (#1978); this kernel export goes in a later release. */
  RETRYABLE_CLIENT_STATUSES,
} from './provider-error.js';
export {
  runPlatformSweep,
  startPlatformSweeper,
  SCHEDULE_STATE_DDL,
  SCHEDULE_STATE_REBUILD,
  SCHEDULE_STATE_KIND_OF_OP,
  scheduleStateHasKind,
} from './platform-sweep.js';
export type {
  AccessLogSink,
  EventSink,
  EventDrainReport,
  EventDrainSkipped,
  AccessLogSweepReport,
  ConnectorSweeper,
  MigrationSweepReport,
  PlatformSweepOptions,
  PlatformSweepReport,
  PlatformSweeperHandle,
  ScheduleSweepReport,
  ScheduleStateKind,
  StartPlatformSweeperOptions,
} from './platform-sweep.js';
// #1653: which scopes are the real install, and which version runs on them — shared so
// every receipt writer and the sweep answer both questions the same way.
export {
  isPrimaryScope,
  isPrimaryScopeRow,
  INERT_SCOPE_REASON,
  runningVersionOf,
  PROVISION_RECONCILE_BATCH,
  PROVISION_RECONCILE_REPORTED_IDS,
  CROSS_VERTICAL_CONSUMERS_PER_PASS,
  runCrossVerticalFrom,
  registryImportCandidates,
  crossVerticalHealth,
  exportBreaksOf,
  exportBreakRefusal,
  EXPORT_BREAK_REFUSAL,
  isExportBreakRefusal,
  bindExportBreaksOf,
  bindExportBreakRefusal,
  BIND_EXPORT_BREAK_REFUSAL,
  isBindExportBreakRefusal,
} from './platform-sweep.js';
export type {
  CandidatesHint,
  CrossVerticalEdge,
  CrossVerticalOptions,
  CrossVerticalReach,
  CrossVerticalReport,
  ProvisionReconcileReport,
  ServingPointer,
} from './platform-sweep.js';
export {
  MIGRATION_FLAG_THRESHOLD,
  migrationFleet,
  migrationProgress,
  migrationSummary,
  scopeMigrationState,
} from './migration-progress.js';
export type { ScopeMigrationState } from './migration-progress.js';
export { foldMeterReading } from './meters.js';
export {
  MODEL_USAGE_RETENTION_DAYS,
  foldModelUsage,
  type ModelUsageFilter,
  type ModelUsageInput,
  type ModelUsageWindow,
} from './model-usage.js';
export type {
  MeterEntitlementInput,
  MeterInput,
  MeterScopeInput,
  MeterTenantInput,
} from './meters.js';

export {
  moduleLog,
  moduleLogLine,
  renderTemplate,
  consoleLogSink,
  MODULE_LOG_LIMITS,
} from './module-log.js';
export type {
  ModuleLog,
  ModuleLogLine,
  ModuleLogLevel,
  ModuleLogFields,
  ModuleLogFieldValue,
  ModuleLogSink,
  ModuleLogContext,
} from './module-log.js';
export {
  asyncInvocationLine,
  asyncInvocationId,
  asyncLevelOf,
  asyncLinePass,
  consoleInvocationLineSink,
  ASYNC_LINES_PER_PASS,
} from './async-invocation-log.js';
export type { AsyncUnit, AsyncLinePass, InvocationLineSink } from './async-invocation-log.js';
export { invocationLine } from './invocation-log.js';
export type { AsyncInvocationKind, AsyncOutcome, InvocationLineFields } from './invocation-log.js';
export {
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  invocationLog,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  INVOCATION_RECORD_KEY,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  invocationStampOf,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  withInvocationLog,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  fieldCoverageArmed,
} from './invocation-log.js';
export type {
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  InvocationLogLine,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  InvocationLogContext,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  InvocationRecord,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  OutputFieldsReport,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  InvocationStamp,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  ModuleWorker,
  /** @deprecated Import from `@substrat-run/vertical-host` (#1978); this kernel export goes in a later release. */
  IncomingRequest,
} from './invocation-log.js';
export {
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  invocationLevelOf,
  /** @deprecated Import from `@substrat-run/contracts` (#1978); this kernel export goes in a later release. */
  type InvocationLevel,
} from '@substrat-run/contracts/invocation-record';

export {
  VERTICAL_EVENTS_DDL,
  EXPORT_HOPS_SQL,
  emptyImportResult,
  IMPORT_CURSORS_SQL,
  IMPORT_CURSOR_OF_SQL,
  IMPORT_CURSOR_ADVANCE_SQL,
  IMPORT_RECORD_SQL,
  OUTBOX_MARK_SQL,
  emittedSinceQuery,
  emittedReportOf,
  moveImportCursor,
  importCursorSourceOf,
  exportedSinceQuery,
  exportReadQuery,
  exportReadPlan,
  exportsOf,
  planExportBatch,
  withheldNote,
  CrossVerticalRegistry,
  type ExportRow,
  type RegisteredImport,
} from './vertical-events.js';
export { attributedHost, attributedView, type ConsumerDelivery, type HostAttribution } from './attribution.js';
export {
  isDeliveryRefusal,
  refuseDelivery,
  refusalJournalText,
  REFUSAL_JOURNAL_PREFIX,
  type DeliveryRefusal,
} from './delivery-refusal.js';
export {
  MEMBER_ADD_REQUESTED,
  MEMBER_REMOVE_REQUESTED,
  MEMBERSHIP_EXECUTOR_ID,
  MEMBERSHIP_REMOVAL_SKEW_MS,
  membershipEntity,
  membershipRemoveExecutorId,
  memberRemoveRequestedPayload,
  registerMembershipExecutor,
  type MemberRemoveRequestedPayload,
  type MembershipExecutorOptions,
} from './membership-executor.js';
export {
  membershipFencesBackfillSql,
  MEMBERSHIP_FENCES_DDL,
  MEMBERSHIP_FENCES_TABLE,
  MEMBERSHIP_FENCE_SINCE_SQL,
  RAISE_MEMBERSHIP_FENCE_SQL,
  membershipFencesTableExists,
} from './membership-fence.js';
