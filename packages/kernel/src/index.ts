export type {
  AccessLogFilter,
  AttachmentUploadInput,
  AuditLogFilter,
  BlobStoreProvisionInput,
  BlobStoreRecord,
  ConsumerHandler,
  ImportHandler,
  ExecutorDeadLetter,
  ExecutorDrainReport,
  ExecutorHandler,
  ExecutorRetryPolicy,
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
  IssueFilter,
  SweepRunFilter,
  SweepRunInput,
  ProvisionScopeInput,
  RoleFilter,
  FreshnessRegistration,
  FreshnessReport,
  LiveChange,
  LiveReadSurface,
  LiveUpgradeRequest,
  ScheduleRegistration,
  ScheduleRunReport,
  ScopeAttachments,
  ScopedSql,
  ScopeFilter,
  ScopeHost,
  ScopeStub,
  ScopeStubOptions,
  InvokeOptions,
  SqlMigration,
  SqlValue,
  TenantBlobStore,
  TenantRelationalStore,
  TenantStoreProvisionInput,
  TenantStoreRecord,
} from './scope-host.js';
export type {
  AnalyticsEngineDatasetLike,
  ConnectionUseOutcome,
  ConnectionUseTiming,
  ConnectorCallErrorType,
  ConnectorCallRecord,
  ConnectorCallRecorder,
  CountingConnectorCallRecorder,
} from './connector-calls.js';
export {
  CONNECTOR_CALL_DATA_POINT_LAYOUT,
  CONNECTOR_CALL_ERROR_TYPES,
  analyticsEngineConnectorCallRecorder,
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
  consumersFor,
  entitlementDenial,
  backoffAt,
  globalFetch,
  parseValidationRecords,
  resolveRetryPolicy,
  OPS_FAILURE_RETENTION_DAYS,
  SWEEP_RUN_RETENTION_DAYS,
  SWEEP_RUNS_INTENT_INDEX,
  sweepRunsIntentHasKind,
  ISSUE_RETENTION_DAYS,
} from './scope-host.js';
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
export { actorOf, asPrincipal } from './permission-checker.js';
export type { PermissionChecker } from './permission-checker.js';
export { createTupleEvaluator } from './permission-eval.js';
export type {
  PermissionTupleReader,
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
  plausibleSessionToken,
  redactSecrets,
  resolveCapabilitySession,
  revokeCapabilityAsPlatform,
} from './capability.js';
export type {
  CapabilityGrantView,
  CapabilityRow,
  CapabilityVerbDeps,
  CapabilityVerbs,
} from './capability.js';
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
export { frozenClock, manualClock } from './clock.js';
export type { ManualClock } from './clock.js';
export { createUlid, ulid, ulidCeiling, ulidTime, type UlidMint } from './ulid.js';
export { assertReadOnlyQuery } from './read-only-sql.js';
export { assertNoSpineWrite, guardSpine } from './spine-guard.js';
export { assertPermissionKey } from './check-key.js';
export { assertModuleEnqueueableKind } from './platform-kinds.js';
export { readRoutedNode, RouterAssertionError } from './routed-node.js';
export type { RoutedNode, HeaderReader, ReadRoutedNodeOptions } from './routed-node.js';
export {
  assertPlatformCall,
  PlatformCallError,
  PLATFORM_SECRET_HEADER,
  PLATFORM_REQUEST_HEADER,
  EXPORTED_EVENTS_HEADER,
  kickFlags,
  CONNECTOR_ATTACHMENT_RECORD_HEADER,
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
} from './subject-redaction.js';
export type {
  LegacySubjectRedactionCounts,
  PlatformRequestRedactionCandidate,
  RedactionSql,
  SubjectRedactionCounts,
} from './subject-redaction.js';
export { effectiveRoleGrantQuery, seatScopeTuple } from './scope-tuple-seat.js';
export {
  SYSTEM_SWITCH_OFF_PREDICATE,
  SYSTEM_SWITCH_OFF_RELATION,
  subjectSwitchedOff,
  switchSubjectGrants,
  switchSystemSchedules,
  subjectGrantState,
  systemGrantsStatus,
  systemScheduleState,
  systemSwitchedOff,
  systemSwitchedOffMessage,
} from './system-switch.js';
export type { SwitchOutcome, SwitchSql, SystemGrantsEntry, SystemScheduleState } from './system-switch.js';
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
export { readTimeline, readHistory, facetEvents, walkEventCause, walkEventEffects, readInvocation, readDeadLetters } from './timeline.js';
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
  JOB_STEP_RECORD_SQL,
  JOB_DRIVE_LIMIT,
  JOB_DRIVE_SCAN_MAX,
  JOB_RUN_LIST_LIMIT,
  JOB_RUN_LIST_MAX,
  jobRunListLimit,
  JOB_STEP_REUSED,
  assertQueueSafe,
  jobRunOf,
  runDueJobRuns,
  runJobPass,
  startJobRun,
} from './job-run.js';
export type {
  JobDriveReport,
  JobHandler,
  JobPassContext,
  JobPassOutcome,
  JobPassResult,
  JobRun,
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
  isTerminalDispatchFailure,
  isTerminalProviderError,
  providerErrorStatus,
  RETRYABLE_CLIENT_STATUSES,
} from './provider-error.js';
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
  runningVersionOf,
  PROVISION_RECONCILE_BATCH,
  PROVISION_RECONCILE_REPORTED_IDS,
  CROSS_VERTICAL_CONSUMERS_PER_PASS,
  runCrossVerticalFrom,
  registryImportCandidates,
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

export { invocationLog } from './invocation-log.js';
export type { InvocationLogLine, InvocationLogContext } from './invocation-log.js';

export {
  VERTICAL_EVENTS_DDL,
  EXPORT_HOPS_SQL,
  IMPORT_CURSORS_SQL,
  IMPORT_CURSOR_OF_SQL,
  IMPORT_CURSOR_ADVANCE_SQL,
  IMPORT_RECORD_SQL,
  OUTBOX_MARK_SQL,
  moveImportCursor,
  importCursorSourceOf,
  type CursorMoveSql,
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
