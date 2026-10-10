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
  ScopeScriptCopy,
  ScopeCopyRole,
  ScopeCopyMoveConfirmation,
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
export { GRANT_CHILDREN_INDEX_DDL } from './grant-scoped-read.js';
export type { GrantedEntitiesPage, GrantedEntityIdsMayRepeatPage } from './grant-scoped-read.js';
export type {
  ConnectionUseOutcome,
  ConnectionUseTiming,
  ConnectorCallErrorType,
  ConnectorCallRecord,
  ConnectorCallRecorder,
  CountingConnectorCallRecorder,
} from './connector-calls.js';
export {
  connectorCallRecord,
  noopConnectorCallRecorder,
  recordConnectorCall,
  settleConnectionUse,
} from './connector-calls.js';
export { requestEmail, settlePlatformRequestIn } from './email-intent.js';
export type { OutcomeEventStamp, PlatformRequestSettle } from './email-intent.js';
export type {
  MailAddress,
  MailSender,
  MailSendResult,
  OutboundMail,
  OutboundMailAttachment,
} from './mail-sender.js';
export {
  COPY_CLAIM_SQL,
  COPY_RESTORE_FENCE_LAPSED,
  copyRestoreFence,
  copyRestoreFenceLapsed,
  type CopyRestoreFence,
  BACKFILL_MOVE_ID,
  COPY_BACKFILL_SCOPE_SQL,
  COPY_BACKFILL_SQL,
  COPY_BACKFILL_SUPERSEDE_SQL,
  copyBackfillParams,
  copyBackfillRefusal,
  type ScopeCopyBackfillResult,
  type CopyBackfillScopeRow,
  type ErasureEpochStamp,
  COPY_EXPIRED_SQL,
  COPY_MOVE_CONFIRM_SQL,
  COPY_MOVE_LIVE_PREDICATE,
  SCOPE_SCRIPT_COPY_COLUMNS,
  copyMoveConfirmParams,
  copyMoveLiveParams,
  scopeScriptCopyOf,
  type ScopeScriptCopyRow,
} from './scope-copy-ledger.js';
export {
  SCOPE_COPY_LEASE_MS,
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
  assertRowLimit,
  assertRowOffset,
  EMITTED_REPORT_CAP,
  isUpgradeRequest,
  isVouchedWithin,
  vouchedWithin,
  type VouchedWithin,
  checkedWithin,
  isCheckedWithin,
  type CheckedWithin,
} from './scope-host.js';
export {
  isSecretBoxConfigured,
  SecretBoxUnconfiguredError,
  unconfiguredSecretBox,
  webCryptoSecretBox,
} from './secret-box.js';
export type { SealedSecret, SecretBox } from './secret-box.js';
export { visibleContinuation, CONTINUATION_POSITION_CAP } from './visible-continuation.js';
export type { ContinuationBinding, ContinuationKey, ContinuationKeys, ContinuationPosition, ContinuationStore } from './visible-continuation.js';
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
export { actorOf, asPrincipal, unknownRoleError } from './permission-checker.js';
export type { Holdings, PermissionChecker } from './permission-checker.js';
export {
  ancestorsWithin,
  createTupleEvaluator,
  grantedEntitiesForContext,
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
  CAPABILITY_DDL,
  CAPABILITY_EXCHANGE_OPERATION,
  CAPABILITY_SESSION_PRUNE_BATCH,
  WITHHELD_SECRET,
  assertNoSecret,
  capabilityAttachmentWriteRefused,
  capabilityByIdQuery,
  capabilityTokenHash,
  checkBecomeInput,
  createCapabilityVerbs,
  exchangeCapability,
  guardSecrets,
  mintBecomeCapability,
  mintCapabilitySecret,
  readCapabilityPage,
  plausibleSessionToken,
  plausibleCapabilitySecret,
  redactSecrets,
  redactSecretText,
  resolveCapabilitySession,
  revokeCapabilityAsPlatform,
  CAPABILITY_BECOME_MINT_OPERATION,
  becomeMintCheck,
  readBecomeLinkStates,
  assertBecomeLinkStateIds,
  mintBecomeCapabilityAsPrincipal,
  revokeBecomeCapabilityAsPrincipal,
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
  ENTITY_STATE_MOVES_DDL,
  statefulTablesOf,
} from './entity-state.js';
export {
  PURGE_BATCH,
  assertNoCallerPurge,
  heldPurgePass,
  isUnreachableParent,
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
export type { PurgeDue, PurgeGateFacts, PurgePass, TrashRefusalDeps } from './entity-trash.js';
export type { EntityStateDeps, EntityStatePlan, EntityStateVerbs, StateColumns } from './entity-state.js';
export {
  afterMigration,
  afterRuntimeDdl,
  derivesAnything,
  repairDerivedObjects,
  StateColumnLost,
} from './derived-objects.js';
export type { DerivedPlans } from './derived-objects.js';
export { createTrashedReads, searchStateWhere, uncheckedView } from './entity-state-reads.js';
export type { TrashedReadDeps, TrashedReads } from './entity-state-reads.js';
export { createAtomic } from './sub-transaction.js';
export type { RunSub, AtomicMarks } from './sub-transaction.js';
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  NotSearchable,
  SearchTermTooShort,
  isSearchIndexTable,
  searchIndexMigrations,
  searchIndexPlans,
  searchLimit,
  searchMatchExpression,
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
  chooseAttachmentExtractor,
  resolveAttachmentTextBounds,
  runAttachmentExtractor,
} from './attachment-extractor.js';
export type {
  AttachmentExtractor,
  AttachmentExtractorInput,
  AttachmentExtractorResult,
  AttachmentTextBounds,
  ExtractionOutcome,
  ExtractionSignal,
  ExtractionTimers,
} from './attachment-extractor.js';
export {
  CursorMismatch,
  FilterNotDeclared,
  NotListable,
  SortNotDeclared,
  cursorOf,
  listIndexMigrations,
  listIndexPlans,
  listQuery,
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
  MIGRATION_DIGEST_MARK_LEGACY,
  assertJournalDumpCoherent,
  assertMigrationSql,
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
export { createUlid, ulid, ulidTime, type UlidMint } from './ulid.js';
export { assertReadOnlyQuery } from './read-only-sql.js';
export { guardSpine } from './spine-guard.js';
export {
  DO_SQL_LIMITS,
  tooManyResultColumns,
  tooManyTableColumns,
  guardSqlLimits,
} from './sql-limits.js';
export { assertPermissionKey } from './check-key.js';
export { assertModuleEnqueueableKind } from './platform-kinds.js';
export {
  signConnectState,
  verifyConnectState,
  ConnectStateError,
  CONNECT_STATE_PURPOSE,
} from './connect-state.js';
export type { ConnectStateClaim } from './connect-state.js';
export {
  CONNECT_LINKS_DDL,
  consumeConnectLinkRow,
  insertConnectLink,
  listConnectLinks,
  readConnectLink,
  restoreConnectLinkRow,
  revokeConnectLinkRow,
  type ConnectLinkAudit,
  type ConnectLinkKeyRow,
} from './connect-links.js';
export {
  PLATFORM_REQUEST_COLUMNS,
  platformRequestHistoryQuery,
  platformRequestOf,
} from './platform-request-query.js';
export type { PlatformRequestRawRow } from './platform-request-query.js';
export {
  CANCELLED_JOB_NOTE,
  DELIVERY_ERROR_REDACTION_SQL,
  intentPayloadCarriesSubject,
  PLATFORM_REQUEST_REDACTION_SQL,
  platformRequestRedactionParams,
  platformRequestRedactionQuery,
  REDACTED_DELIVERY_NOTE,
  REDACTED_INTENT_MARKER,
  REDACTED_JOB_NOTE,
  redactSubjectJobRuns,
  REDACTED_FAILURE_NOTE,
  redactSubjectScopeText,
  ISSUE_EXEMPLAR_OWNER_BACKFILL_SQL,
  issueExemplarOwner,
  redactSubjectDirectoryText,
  platformIntentFailureMessage,
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
  eraseSubjectFromModules,
  isModuleErasureCounts,
  moduleErasurePlan,
  moduleRowsErased,
  SECURE_DELETE_MIN_SQLITE,
} from './module-erasure.js';
export {
  TABLE_OWNERS_DDL,
  assertMigrationLeavesLedgerAlone,
  recordOwnershipSteps,
  runMigrationStatements,
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
export { delegatedRevokeSql, writeExplicitTupleIn } from './entity-grant.js';
export { SHAPE_MARKER_INDEX_DDL, grantEntityShapeIn, shapeTopUpBatch, topUpEntityGrantShapes } from './entity-grant-shape.js';
export type { ShapeCursor, ShapePass } from './entity-grant-shape.js';
export { applyScopeRoleChange, changeScopeRole, revokeScopeRoles, scopeRoleHolders, type Atomically, type RoleBound, type ScopeRoleHolder } from './scope-role-admin.js';
export { repointScopeGrants, type RepointSource } from './scope-repoint.js';
export { COPY_ORIGIN_DDL, capabilitiesForLoad, clearCopyMarker, emittedHere, isCopyLoad, IS_COPY_SQL, markCopyOrigin, settleCopiedWork } from './scope-copy.js';
export { isLifecycleWrite, lifecycleReceipt, lifecycleRefusal, readLifecycle, settleLifecycleAfterLoad, writeLifecycle } from './scope-lifecycle.js';
export { CARRIED_AWAY_KEY, COPY_MARK_CLEARED_KEY, KEPT_COPY_REFUSAL, KEPT_DIVERGENT_KEY, LOAD_STAMP_KEY, STORE_LOCAL_META_KEYS, WRITE_REVISION_KEY, type KeptCopy, carriedAwayDump, dumpMetaValue, isCopyMarkInsert, isWriteStatement, metaValueIn, type CarriedAway, type LoadMarker } from './carried-copy.js';
export { LEGACY_SCOPE_ROWS_BACKFILL, assertSpineTablesBuilt, dumpRowsInsert, isSpineTable, loadDirectoryDump, spineColumnAdditions, type KernelColumnsOf } from './spine-restore.js';
export {
  SYSTEM_SWITCH_OFF_QUERY,
  SWITCH_FENCES_DDL,
  moveSwitch,
  recordedOffFromWire,
  switchRecordedOff,
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
  clearSwitchOwed,
  scopeOwesSwitch,
  markSwitchOwed,
  switchesOwedOf,
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
  SETTLE_INTENT_SQL,
  SETTLE_OUTCOME_SQL,
  settleOutcomeParamsOf,
  operationKeyOf,
  auditedOperationsSql,
  effectiveOutcomes,
  isSupersededOutcome,
  readAuditedOperations,
  unknownOutcomeOf,
  UNRECORDED_OUTCOME_LOG,
  recordAuditOutcome,
  auditWarningOf,
} from './audit-outcome.js';
export type {
  AuditLogError,
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
  admitPeer,
  collectPeers,
  peerGrantsStatus,
  peerSeats,
  peerSubjectRef,
  resolveVerticalInstanceFrom,
  switchPeer,
} from './peer.js';
export { PEER_BINDINGS_DDL, resolvePeerInstanceFrom } from './peer.js';
export type { PeerDeclaration, PeerDeclarations, PeerGrantsRow, PeerSeat, VerticalInstanceCandidate } from './peer.js';
export {
  DENIAL_WINDOW_QUERY,
  denialListQuery,
  denialSummaryQuery,
  denialTotalsQuery,
  mapDenialRow,
  mapDenialSummaryBuckets,
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
export { operationSeriesQuery, readOperationSeries } from './operation-series.js';
export {
  REFUSALS_INDEX,
  REFUSALS_REBUILD,
  REFUSALS_TABLE_DDL,
  markGuardRefusal,
  refusalInsert,
  refusalOf,
  refusalsAdmitGuards,
  type RefusalRow,
  type RefusedGuard,
} from './refusals.js';
export { mapRefusalRow, refusalListQuery, type RefusalDbRow } from './refusal-query.js';
export { readTimeline, readHistory, readScopeTimeline, readScopeHistory, facetEvents, walkEventCause, walkEventEffects, readInvocation, readDeadLetters, readExecutorDelivery, type ExecutorDelivery, type ExecutorDeliveryState } from './timeline.js';
export type { ScopeWalkPage } from './timeline.js';
export type { TimelineReader } from './timeline.js';
// #1636: one undecodable spine row no longer takes a list — or a delivery loop — with it.
export type { RowDecoder } from './row-decode.js';
export {
  domainEventOf,
  readUndrainedOutbox,
  undrainedEventsOf,
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
  JOB_ADMISSION_MISS_MAX,
  JOB_LEASE_TOO_SHORT_NOTE,
  admissionBackoffMs,
  JOB_LEASE_EXPIRED_NOTE,
  assertLeaseMs,
  jobRunListLimit,
  SYSTEM_DOOR_WAIT,
  JOB_DEFER_MS,
  JOB_RUN_DUE_AT,
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
  runPlatformSweep,
  startPlatformSweeper,
  SCHEDULE_STATE_DDL,
  SCHEDULE_STATE_REBUILD,
  scheduleStateHasKind,
} from './platform-sweep.js';
export type {
  AccessLogSink,
  EventSink,
  EventDrainReport,
  EventDrainSkipped,
  PlatformRequestUnsettleable,
  AccessLogSweepReport,
  ConnectorSweeper,
  MigrationSweepReport,
  PlatformSweepOptions,
  PlatformSweepReport,
  PlatformSweeperHandle,
  ScheduleSweepReport,
  ScheduleStateKind,
  StartPlatformSweeperOptions,
  StorageGaugeSweepOptions,
  StorageGaugeSweepReport,
} from './platform-sweep.js';
export { StorageReadUnsupported } from './platform-sweep.js';
// #1653: which scopes are the real install, and which version runs on them — shared so
// every receipt writer and the sweep answer both questions the same way.
export {
  isPrimaryScope,
  isPrimaryScopeRow,
  INERT_SCOPE_REASON,
  runningVersionOf,
  PROVISION_RECONCILE_BATCH,
  CROSS_VERTICAL_CONSUMERS_PER_PASS,
  runCrossVerticalFrom,
  registryImportCandidates,
  crossVerticalHealth,
  exportBreaksOf,
  exportBreakRefusal,
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
  migrationProgress,
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
  SCOPE_STORAGE_DDL,
  forgetScopeStorage,
  listScopeStorageAttemptRows,
  listScopeStorageRows,
  pruneScopeStorageRows,
  recordScopeStorageRows,
  type ScopeStorageAttempt,
  type ScopeStorageFilter,
  type ScopeStorageReadingInput,
} from './storage-gauge.js';

export {
  moduleLog,
  consoleLogSink,
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
  asyncInvocationId,
  asyncLinePass,
  consoleInvocationLineSink,
  ASYNC_LINES_PER_PASS,
} from './async-invocation-log.js';
export type { AsyncUnit, AsyncLinePass, InvocationLineSink } from './async-invocation-log.js';
export { invocationLine } from './invocation-line.js';
export type {
  AsyncInvocationKind,
  AsyncOutcome,
  InvocationLineFields,
  InvocationLogLine,
  OutputFieldsReport,
} from './invocation-line.js';

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
  planExportBatch,
  withheldNote,
  CrossVerticalRegistry,
  type ExportRow,
  type RegisteredImport,
} from './vertical-events.js';
export { attributedView, type ConsumerDelivery, type HostAttribution } from './attribution.js';
export {
  isDeliveryRefusal,
  refuseDelivery,
  refusalJournalText,
  type DeliveryRefusal,
} from './delivery-refusal.js';
export {
  MEMBER_ADD_REQUESTED,
  MEMBER_REMOVE_REQUESTED,
  MEMBERSHIP_EXECUTOR_ID,
  MEMBERSHIP_REMOVAL_SKEW_MS,
  membershipEntity,
  membershipRemoveExecutorId,
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
