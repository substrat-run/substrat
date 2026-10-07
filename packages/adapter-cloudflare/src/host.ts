import type { EntityGrantShape } from '@substrat-run/contracts';
import type { TenantVerdict } from './scope-do.js';
import { env as ambientEnv } from 'cloudflare:workers';
import { isRewindRefusal, REWIND_REFUSED } from './rewind-refusal.js';
import { isSystemDoorMoved, SYSTEM_DOOR_MOVED, SYSTEM_DOOR_REGATES, type SystemDoorMoved } from './system-door.js';
import {
  delegatedReadParams,
  operationSeriesCount,
  fromWireFailure,
  type ErrorCode,
  type WireFailure,
  exportReadInput,
  exportedBatch,
  importBatch,
  importResult,
  importState,
  type ExportedBatch,
  type ExportReadInput,
  type ImportBatch,
  type ImportResult,
  type ImportState,
  importsOfManifestJson,
  exportsOfManifestJson,
  type ExportBreak,
  type ManifestImports,
  importCursorMove,
  importCursorMoveAt,
  importCursorMoved,
  type ImportCursorMove,
  type ImportCursorMoveAt,
  type ImportCursorMoved,
  accessLogEntry,
  adminLogEntry,
  opsFailureEntry,
  opsFailureFingerprint,
  issueEntry,
  findingEntry,
  findingRuleEntry,
  type FindingEntry,
  type FindingFilter,
  type FindingRuleEntry,
  type FindingRuleInput,
  type FindingStatusInput,
  sweepRunEntry,
  FRESHNESS_HEARTBEAT_MINUTES,
  sweepRunsPayload,
  modelUsageEntry,
  attachmentRecord,
  type AttachmentRecord,
  type BlobStoreHandle,
  createTenantInput,
  identityLink,
  identityPool,
  createOrgInput,
  promotionAcknowledgement,
  bindAcknowledgement,
  bindHostnameInput,
  channelHistoryEntry,
  hostnameBinding,
  publishVersionInput,
  AUTO_ADMISSION_NOTE,
  registerVerticalInput,
  vertical as verticalSchema,
  verticalServingState,
  verticalChannel,
  verticalVersion,
  connection,
  capabilityExchange,
  mintedCapability,
  capabilityGrant,
  principalId,
  connectionGrant,
  connectionGrantRecord,
  connectionSecret,
  systemGrant,
  systemSwitch,
  systemSwitchOutcome,
  systemScheduleEntry,
  systemSwitchRecord,
  entitlementGrant,
  entitlementGrantInput,
  capabilityFilter,
  instant,
  meterReading,
  subjectRef,
  createConnectionInput,
  connectLinkFilter,
  connectLinkKey,
  consumeConnectLinkInput,
  mintConnectLinkInput,
  projectedConnectionGrant,
  projectedConnectionKey,
  moduleManifest,
  org as orgSchema,
  orgMembership,
  resolvedIdentity,
  identityMembership,
  roleDefinition,
  scope as scopeSchema,
  tenant as tenantSchema,
  tenantRole,
  type AdminAction,
  type ConnectLink,
  type ConnectLinkConsume,
  type ConnectLinkFilter,
  type ConnectLinkKey,
  type ConsumeConnectLinkInput,
  type MintConnectLinkInput,
  type Instant,
  type BeginImpersonationInput,
  type ImpersonationFilter,
  type ImpersonationSession,
  type ImpersonationSessionId,
  type Connection,
  type ConnectionFilter,
  type ConnectionGrant,
  type ConnectionId,
  type ConnectionSecret,
  type ModuleId,
  type ScheduleSpec,
  type SystemGrant,
  type SystemSwitch,
  type SystemSwitchResult,
  type SystemSwitchOutcome,
  type SystemScheduleEntry,
  type PeerGrantsEntry,
  type PeerGrantsStatusEntry,
  type SystemGrantsStatusEntry,
  type CreateConnectionInput,
  type AccessLogEntry,
  type AdminLogEntry,
  type OpsFailureEntry,
  type IssueEntry,
  type EntityHistoryInput,
  type EventCauseInput,
  delegatedReadRecord,
  ownerTransferAudit,
  memberChangeAudit,
  copyMarkAudit,
  type EventEffectsInput,
  type EffectsTree,
  type InvocationEventsInput,
  type InvocationEvents,
  type DeadLettersInput,
  type DeadLetter,
  type LifecycleFlowInput,
  type LifecycleFlowResult,
  type OperationSeriesInput,
  type OperationSeriesResult,
  type CauseChain,
  type EventFacetInput,
  type EventFacetResult,
  type HistoryEntry,
  type Page,
  type SweepRunEntry,
  type SweepRunsPayload,
  type FreshnessSpec,
  type ModelUsageEntry,
  type ModelUsageSummary,
  type CapabilityGrant,
  type CreateOrgInput,
  type CreateTenantInput,
  type DomainEvent,
  type EntitlementGrant,
  type EntityRef,
  type IdentityLink,
  type IdentityMembership,
  type IdentityPool,
  type ListPage,
  type MeterReading,
  type ProjectedConnectionGrant,
  type ProjectedConnectionKey,
  type ProjectedIdentityLink,
  type Node,
  type Org,
  type OrgId,
  type PermissionKey,
  type PlatformActorId,
  type OnBehalfOf,
  type BecomeCapabilityInput,
  type CapabilityExchange,
  type CapabilityId,
  type CapabilityFilter,
  type CapabilityPage,
  type CapabilityRecord,
  type MintedCapability,
  type PrincipalId,
  type PromotionAcknowledgement,
  type BindHostnameInput,
  type HostnameBinding,
  type PublishVersionInput,
  type RegisterVerticalInput,
  type Vertical,
  type VerticalVersion,
  type ResolvedIdentity,
  type QueryScopeInput,
  type ReadScopeTableInput,
  type RoleAssignment,
  type RoleDefinition,
  type Scope,
  type DirectoryDump,
  type ScopeDump,
  type ScopeDumpTable,
  type ScopeLineage,
  subjectShredReceipt,
  type SubjectShredReceipt,
  type ScopeId,
  connectorDispatchKind,
  type ConnectorDispatchPayload,
  type PlatformRequest,
  type PlatformRequestFilter,
  type PlatformRequestId,
  type PlatformRequestStatus,
  type PlatformRequestFailure,
  type ScopeStatus,
  type ScopeTable,
  type DenialFilter,
  type DenialSummary,
  type PermissionDenial,
  type RefusalFilter,
  type RefusalRecord,
  type ScopeQueryResult,
  type ScopeTablePage,
  type Tenant,
  type TenantId,
  type TenantRole,
  type TenantStatus,
  type TenantStoreHandle,
  callsOfManifestJson,
  outboundOfManifestJson,
  SCOPE_GATE_REASONS,
  substratError,
  redrainEventsInput,
  coverage,
  peerCoverage,
  peerGrantsEntry,
  peerSwitch,
  peerSwitchOutcome,
  verticalCaller,
  verticalResolution,
  verticalSlug,
  entityObjectRef,
  type Coverage,
  type PeerCoverage,
  type PeerSpec,
  type PeerSwitch,
  type PeerSwitchOutcome,
  type PeerSwitchResult,
  type VerticalCaller,
  type VerticalResolution,
  type DeclaredMigration,
  ATTACHMENT_BLOB_BINDING,
  blobStoreBindingName,
  lifecycleDelivery,
  scopeLifecycle,
  type LifecycleDelivery,
  type ScopeLifecycle,
  type StoredScopeLifecycle,
} from '@substrat-run/contracts';
import { normalizeHostname, toRouteTarget } from './route-resolver.js';
import {
  attachmentBlobKey,
  attachmentSha256,
  entitlementDenial,
  requiredEntitlementFor,
  type OperationEntitlement,
  foldMeterReading,
  parseValidationRecords,
  resolveScopeRecord,
  ulid,
  type CarriedAway,
  type KeptCopy,
  type LoadMarker,
  KEPT_COPY_REFUSAL,
  capabilityTokenHash,
  checkBecomeInput,
  plausibleSessionToken,
  type AccessLogFilter,
  type AuditLogFilter,
  type OpsFailureFilter,
  type OpsFailureInput,
  type AuditedOperationRef,
  type AuditedOperationRow,
  type IssueFilter,
  type TelemetryPruneReport,
  type AppliedMigration,
  type SweepRunFilter,
  type SweepRunInput,
  type ModelUsageFilter,
  type ModelUsageInput,
  type ModelUsageWindow,
  foldModelUsage,
  type BlobStoreProvisionInput,
  type BlobStoreRecord,
  type ScopeAttachments,
  type AttachmentUploadInput,
  type OpenedAttachment,
  type TenantBlobStore,
  type ExecutorDeadLetter,
  type ExecutorDrainReport,
  type ExecutorHandler,
  type ExecutorOutcome,
  type MembershipChange,
  type MembershipChangeResult,
  type ExecutorScope,
  type ExecutorRetryPolicy,
  type MigrateScopeOutcome,
  type MigrationFrontier,
  backoffAt,
  resolveRetryPolicy,
  executorOutcomeOf,
  isDeliveryRefusal,
  refusalJournalText,
  isSecretBoxConfigured,
  unconfiguredSecretBox,
  createSubjectKeys,
  generateSealingKeyPair,
  openSealed,
  ImpersonationRefused,
  assertSessionUsable,
  impersonationRowValues,
  mapImpersonationRow,
  newImpersonationSession,
  type ImpersonationRow,
  type SubjectKeys,
  type ConnectorContext,
  type ConnectorHandler,
  type ConnectorOptions,
  type FetchLike,
  type SecretBox,
  type HostAdmin,
  type ModuleRegistration,
  type OperationHandler,
  type PermissionChecker,
  type ProvisionScopeInput,
  type RoleFilter,
  type ScheduleRegistration,
  type ScheduleRunReport,
  type ScheduleStateKind,
  type ScopeFilter,
  type ScopeHost,
  type ScopeStub,
  type ScopeStubOptions,
  type InvokeOptions,
  type SqlValue,
  type TenantRelationalStore,
  type TenantStoreProvisionInput,
  type TenantStoreRecord,
  type FreshnessRegistration,
  type FreshnessReport,
  jobRunOf,
  assertLeaseMs,
  runDueJobRuns,
  SYSTEM_DOOR_WAIT,
  startJobRun,
  attachmentTextJob,
  assertAttachmentExtractors,
  resolveAttachmentTextBounds,
  assertJobRegistrable,
  ATTACHMENT_TEXT_BACKFILL_JOB,
  ATTACHMENT_TEXT_JOB,
  kernelJobFor,
  attachmentTextBackfillJob,
  searchLimit,
  searchMatchExpression,
  type AttachmentExtractor,
  type AttachmentTextBackfillBatch,
  type AttachmentTextBounds,
  type ExtractionOutcome,
  type JobDriveReport,
  type JobDueKey,
  type JobHandler,
  type JobRun,
  type JobRegistration,
  type JobRunClaim,
  type JobRunFilter,
  type JobRunPatch,
  type JobRunRow,
  type JobRunStore,
  type JobStepRow,
  type StartJobRunInput,
  type LiveReadSurface,
  type SubjectRedactionCounts,
  type LegacySubjectRedactionCounts,
  type SubjectTextTarget,
  globalFetch,
  assertRedrainWindow,
  platformRequestOf,
  type PlatformRequestRawRow,
  undrainedEventsOf,
  type UndrainedEvents,
  type UndrainedRead,
  type SwitchOutcome,
  type SwitchedOff,
  type SystemSwitchReassert,
  type SystemSwitchReassertOptions,
  inUnitMovesToAudit,
  staleCarryRevertRow,
  staleCarryReverts,
  type SystemSwitchRecordFilter,
  type SystemSwitchRecordRow,
  type SwitchKind,
  type SwitchRecordPrior,
  type SwitchRecordWrite,
  type RecordedOffCarry,
  type SwitchCarryWire,
  recordedOffFromWire,
  peerSubjectRef,
  SWITCH_KINDS,
  reassertActionOf,
  reassertEntry,
  reassertOffRow,
  reassertOnRow,
  switchActionOf,
  switchAuditSubject,
  recordAuditOutcome,
  auditWarningOf,
  switchNotFoundMessage,
  recordWriteSuperseded,
  switchSubjectOf,
  switchSupersededMessage,
  withRecorded,
  type SystemScheduleState,
  type PeerGrantsRow,
  type SystemGrantsEntry,
  systemSwitchedOffMessage,
  tenantSystemSwitchedOffMessage,
  CrossVerticalRegistry,
  importCursorSourceOf,
  exportBreaksOf,
  exportBreakRefusal,
  bindExportBreaksOf,
  bindExportBreakRefusal,
  collectPeers,
  peerSeats,
  connectorCallRecord,
  noopConnectorCallRecorder,
  recordConnectorCall,
  settleConnectionUse,
  splitManifestMigrations,
  type ConnectionUseOutcome,
  type ConnectorCallRecorder,
  unknownRoleError,
  type ScopeRoleHolder,
  assertRowLimit,
  assertRowOffset,
  emptyImportResult,
  INERT_SCOPE_REASON,
  lifecycleReceipt,
  lifecycleRefusal,
  isPrimaryScope,
  isPrimaryScopeRow,
  asyncInvocationId,
  asyncLinePass,
  assertNoCallerPurge,
  purgeReportOf,
  purgeStillDue,
  registerTrashTargets,
  type PurgePass,
  type AsyncLinePass,
  type EmittedReport,
  type FindingChange,
  type FindingPruneReport,
  memberAddedAudit,
  shapeTopUpBatch,
  type ConnectLinkKeyRow,
} from '@substrat-run/kernel';
import { attributedView, isModuleErasureCounts, moduleErasurePlan, moduleRowsErased } from '@substrat-run/kernel';
import {
  isOrangeToOrange,
  isUpgradeRequest,
  LIVE_MODE_HEADER,
  LIVE_PRINCIPAL_HEADER,
  LIVE_SCOPE_HEADER,
  LIVE_SUBSCRIBE_PATH,
  LIVE_TENANT_HEADER,
  LIVE_WITHIN_HEADER,
  LIVE_EXPIRES_HEADER,
  liveInstant,
  encodeLiveWithin,
  liveWithinOf,
  type LiveRefusal,
} from './live-reads.js';
import { tenantStoreDatabaseName, type D1TenantStores } from './d1.js';
import { blobStoreBucketName, r2TenantBlobStore, type R2BlobStores } from './r2.js';
import type {
  AccessLogRow,
  AuditLogQuery,
  IssueQuery,
  OpsFailureQuery,
  SweepRunQuery,
  SweepRunRow,
  OpsFailureRow,
  ModelUsageQuery,
  ModelUsageRow,
  ChannelHistoryRow,
  ChannelRow,
  ConnectionDoRow,
  ConnectionGrantDoRow,
  EntitlementRow,
  HostnameRow,
  MemberTupleRow,
  OrgRow,
  RoleRow,
  RouteRow,
  ScopeRow,
  VerticalRow,
  VersionRow,
  VersionListRow,
  LifecycleTargetRow,
  RepliedMethod,
} from './control-plane-do.js';
import { unwrapReply, type DoReply } from './do-reply.js';

/**
 * `CloudflareScopeHost` — the coordinator (design doc §5.7). It runs in the
 * Worker isolate; every scope's execution runs in a ScopeDO, and the whole
 * directory lives in the singleton ControlPlaneDO. This facade is the seam
 * between them.
 *
 * The directory is now DURABLE. `HostAdmin` is an ASYNCHRONOUS interface (D-14):
 * every method returns a Promise, which is exactly what lets the tenant
 * registry, scope lifecycle, roles, entitlements, identities, and the admin
 * audit log live in the ControlPlaneDO rather than in Worker-isolate memory — a
 * production coordinator is stateless across requests, so nothing directory-
 * shaped may be held here. Each admin method `await`s its RPCs directly (the
 * ControlPlaneDO is single-threaded, so write order is preserved) and audits
 * only when the effect actually changed something, mirroring the pure adapter's
 * idempotency. Provision and getScope gate against the ControlPlaneDO too.
 *
 * What the coordinator DOES keep in memory is registration-mechanics bookkeeping
 * (module ids, operation bindings, withdrawals, the entitlement key per
 * operation): that is code-time, derived from the bundled modules, not durable
 * directory state.
 *
 * Tuple ROUTING stays here (the scope-tuples-live-in-ScopeDO invariant the
 * checker depends on): scope-level tuples → the owning ScopeDO via
 * `scopeStub().writeTuple`; tenant-level tuples → `cp.writeTenantTuple`. Zod
 * parsing stays here too, so only clean data crosses to the DO and the DO throws
 * only plain Errors whose messages survive the RPC hop.
 */

/** An executor or a connector — same journal and retry, different argument. */
type RegisteredEffector =
  | {
      kind: 'executor';
      eventType: string;
      handler: ExecutorHandler;
      retry: Required<ExecutorRetryPolicy>;
    }
  | {
      kind: 'connector';
      eventType: string;
      handler: ConnectorHandler;
      retry: Required<ExecutorRetryPolicy>;
      timeoutMs: number;
      /** The `connector:<provider>` routing key a CP-less host enqueues under (#574 phase 3). */
      provider: string;
    };

/** DO row → contract shape. Never reads the secrets table — that is the split. */
const toConnection = (r: ConnectionDoRow): Connection =>
  connection.parse({
    id: r.id,
    tenantId: r.tenant_id,
    vertical: r.vertical,
    provider: r.provider,
    label: r.label,
    status: r.status,
    externalAccountRef: r.external_account_ref,
    scopes: JSON.parse(r.scopes) as string[],
    expiresAt: r.expires_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  });

interface ControlPlaneStub {
  /** #113: one of `REPLIED_METHODS`, its refusal answered as data (`ControlPlaneDO.reply`). */
  reply<M extends RepliedMethod>(
    method: M,
    args: Parameters<ControlPlaneStub[M]>,
  ): Promise<DoReply<Awaited<ReturnType<ControlPlaneStub[M]>>>>;
  /** #1713: hosted scopes and their directory lifecycle (`ControlPlaneDO.lifecycleTargets`). */
  lifecycleTargets(filter: {
    tenantId?: string;
    scopeId?: string;
    drift?: boolean;
    unrecorded?: boolean;
    limit?: number;
  }): Promise<LifecycleTargetRow[]>;
  /** #1713: what a scope's deployment acknowledged holding. */
  recordLifecycleReceipt(scopeId: string, delivered: string, at: string, tenantRecorded?: boolean): Promise<void>;
  /** #2016: note the heal's tenant-record asks, success or failure, so the walk rotates. */
  recordTenantAsks(scopeIds: string[], at: string): Promise<void>;
  /** #1713: raise the directory's epoch to at least this; answers the epoch now. */
  raiseLifecycleEpoch(atLeast: number): Promise<number>;
  createTenant(
    id: string,
    slug: string,
    name: string,
    createdAt: string,
    provisionedByTenant?: string | null,
  ): Promise<Tenant | null>;
  setTenantStatus(tenantId: string, status: TenantStatus): Promise<string>;
  setTenantName(tenantId: string, name: string): Promise<string>;
  reapTenant(tenantId: string): Promise<string>;
  getTenant(tenantId: string): Promise<Tenant | undefined>;
  listTenants(page?: ListPage): Promise<Tenant[]>;
  getTenantStore(
    tenantId: string,
    vertical: string,
    binding: string,
  ): Promise<{ kind: string; ref: string } | undefined>;
  putTenantStore(row: {
    tenantId: string;
    vertical: string;
    binding: string;
    kind: string;
    ref: string;
    createdAt: string;
  }): Promise<{ kind: string; ref: string }>;
  listTenantStores(filter: { tenantId?: string; vertical?: string }): Promise<
    {
      tenant_id: string;
      vertical: string;
      binding: string;
      kind: string;
      ref: string;
      created_at: string;
    }[]
  >;
  getBlobStore(
    tenantId: string,
    vertical: string,
    binding: string,
  ): Promise<{ kind: string; ref: string } | undefined>;
  putBlobStore(row: {
    tenantId: string;
    vertical: string;
    binding: string;
    kind: string;
    ref: string;
    createdAt: string;
  }): Promise<{ kind: string; ref: string }>;
  listBlobStores(filter: { tenantId?: string; vertical?: string }): Promise<
    {
      tenant_id: string;
      vertical: string;
      binding: string;
      kind: string;
      ref: string;
      created_at: string;
    }[]
  >;
  provisionScope(
    tenantId: string,
    scopeId: string,
    record: {
      slug: string;
      kind: string;
      name: string;
      vertical: string | null;
      storageShape: string;
      jurisdiction: string | null;
    },
    createdAt: string,
  ): Promise<boolean>;
  setMigrationState(
    scopeId: string,
    schemaVersion: string,
    failure: { version: string; error: string } | null,
  ): Promise<void>;
  listScopes(
    filter: { tenantId?: string; status?: string[]; vertical?: string } & ListPage,
  ): Promise<ScopeRow[]>;
  getScopeRecord(tenantId: string, scopeId: string): Promise<ScopeRow | undefined>;
  /** The getScope gate's refusal as data, null when access is allowed (#1718). */
  scopeAccessRefusal(
    tenantId: string,
    scopeId: string,
  ): Promise<{ code: ErrorCode | null; message: string; reason?: string } | null | undefined>;
  /** A scope lifecycle transition, its refusal answered as data (#1718). */
  transitionScopeOrRefusal(
    tenantId: string,
    scopeId: string,
    from: string[],
    to: ScopeStatus,
    action: string,
  ): Promise<
    | { ok: true; status: string; vertical: string | null }
    | { ok: false; code: ErrorCode | null; message: string }
  >;
  defineRole(tenantId: string, role: RoleDefinition): Promise<RoleDefinition | null>;
  listRoles(filter: { tenantId?: string; source?: string } & ListPage): Promise<RoleRow[]>;
  writeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
  /** #1743: a tenant-level `system:` grant — answers the switched-off scopes; empty = written. */
  writeTenantSystemGrant(
    tenantId: string,
    moduleId: string,
    relation: string,
    expiresAt: string | null,
  ): Promise<string[]>;
  /** All of a tenant's identity links — for identity-link projection (#406). */
  dumpTenantIdentities(
    tenantId: string,
  ): Promise<{ provider: string; external_id: string; principal_id: string; scope_id: string | null }[]>;
  /** All of a tenant's tenant-level tuples (incl tombstones) — for scope-local projection. */
  dumpTenantTuples(
    tenantId: string,
  ): Promise<{ subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[]>;
  readHostname(hostname: string): Promise<HostnameRow | undefined>;
  readRoute(hostname: string): Promise<RouteRow | undefined>;
  /** #1706: "vertical Y in tenant T", by the kernel's one rule — see `HostAdmin.resolveVerticalInstance`. */
  resolveVerticalInstance(tenantId: string, vertical: string): Promise<VerticalResolution>;
  demoteCanonical(scopeId: string, surface: string): Promise<void>;
  upsertHostname(h: {
    hostname: string; tenantId: string; scopeId: string; verticalSlug: string | null;
    surface: string; region: string | null; canonical: boolean; createdAt: string;
  }): Promise<void>;
  setHostnameStatus(hostname: string, status: string, note: string | null): Promise<void>;
  setHostnameIssuance(
    hostname: string,
    fields: {
      status: string;
      note: string | null;
      customHostnameId?: string | null;
      validationRecords: string | null;
    },
  ): Promise<void>;
  deleteHostname(hostname: string): Promise<void>;
  listHostnames(
    filter: { tenantId?: string; scopeId?: string; status?: string; verticalSlug?: string } & ListPage,
  ): Promise<HostnameRow[]>;
  readVertical(slug: string): Promise<VerticalRow | undefined>;
  insertVertical(slug: string, name: string, source: string, ownerTenant: string | null, envSpec: string | null, installSpec: string | null, listed: number, createdAt: string): Promise<void>;
  updateVerticalManifestMeta(slug: string, envSpec: string | null, installSpec: string | null, listed?: number | null): Promise<void>;
  updateVerticalListed(slug: string, listed: number): Promise<void>;
  updateVerticalPublishRequest(slug: string, requestedAt: string): Promise<void>;
  updateVerticalInstallsBlocked(slug: string, blocked: number): Promise<void>;
  updateVerticalTenantProvisioner(slug: string, granted: number): Promise<void>;
  updateVerticalEmailSender(slug: string, granted: number): Promise<void>;
  countScopesForVertical(slug: string): Promise<{ live: number; archived: number }>;
  deleteVertical(slug: string): Promise<void>;
  listVerticals(page?: ListPage): Promise<VerticalRow[]>;
  readVersion(id: string): Promise<VersionRow | undefined>;
  insertVersion(v: {
    id: string; verticalSlug: string; version: string; manifestDigest: string;
    permissionDigest: string; migrationDigest: string; deploymentRef: string | null;
    admission: string; admissionNote: string | null; manifestJson: string | null;
    originJson: string | null;
    migrations: DeclaredMigration[] | null;
    createdAt: string;
  }): Promise<void>;
  readVersionMigrations(
    id: string,
  ): Promise<{ verticalSlug: string; migrations: DeclaredMigration[] | null } | undefined>;
  listVersions(verticalSlug: string, page?: ListPage): Promise<VersionListRow[]>;
  setAdmission(id: string, admission: string, note: string | null): Promise<void>;
  bindScopeVersion(scopeId: string, versionId: string, verticalSlug: string, expectedVersionId?: string | null): Promise<void>;
  markScopeProvisioned(scopeId: string, versionId: string | null): Promise<void>;
  setVerticalServing(
    slug: string,
    s: { ref: string; versionId: string; doClassesJson: string; migrationTag: string },
  ): Promise<void>;
  setScopeServingRef(scopeId: string, servingRef: string | null): Promise<void>;
  setScopeExpiresAt(scopeId: string, expiresAt: string | null): Promise<void>;
  deleteScopeDirectory(scopeId: string): Promise<void>;
  readChannel(verticalSlug: string, channel: string): Promise<ChannelRow | undefined>;
  setChannel(verticalSlug: string, channel: string, versionId: string, updatedAt: string): Promise<void>;
  listChannels(verticalSlug: string, page?: ListPage): Promise<ChannelRow[]>;
  insertChannelHistory(h: ChannelHistoryRow): Promise<void>;
  listChannelHistory(
    verticalSlug: string,
    channel?: string,
    page?: ListPage,
  ): Promise<ChannelHistoryRow[]>;
  readOrg(tenantId: string, orgId: string): Promise<OrgRow | undefined>;
  createOrg(
    orgId: string,
    tenantId: string,
    slug: string,
    name: string,
    createdAt: string,
  ): Promise<boolean>;
  listOrgs(tenantId: string): Promise<OrgRow[]>;
  /** #1184: a bounded, fenced tenant-role add, as one DO unit. */
  applyMembership(change: MembershipChange, row: AdminEntry, orgRow?: AdminEntry): Promise<MembershipChangeResult>;
  /**
   * #1184: a tenant-level removal — the K-21 tombstone, the removal fence and (only if it
   * changed anything) the audit row — as one DO unit. Returns whether anything changed.
   */
  revokeAndFence(tenantId: string, principal: string, relation: string, object: string, row: AdminEntry): Promise<boolean>;
  listMembers(
    tenantId: string,
    object: string,
    includeRevoked: boolean,
  ): Promise<MemberTupleRow[]>;
  grantEntitlement(
    tenantId: string,
    key: string,
    input: { expiresAt?: string | null; quota?: number | null; plan?: string | null },
    actor: string,
  ): Promise<{ changed: boolean; before: EntitlementRow | null; after: EntitlementRow }>;
  revokeEntitlement(tenantId: string, key: string): Promise<EntitlementRow | null>;
  tenantHoldsEntitlement(tenantId: string, key: string): Promise<boolean>;
  listEntitlements(tenantId: string): Promise<EntitlementRow[]>;
  /** The three projections §5's meters fold from (#38); narrowed when a tenant is given. */
  meterRows(tenantId?: string): Promise<{
    tenants: { tenant_id: string; slug: string; status: string }[];
    scopes: { tenant_id: string; status: string }[];
    entitlements: { tenant_id: string; entitlement_key: string; plan: string | null; expires_at: string | null }[];
  }>;
  insertConnection(row: {
    id: string;
    tenantId: string;
    vertical: string;
    provider: string;
    label: string;
    externalAccountRef: string | null;
    scopes: string;
    expiresAt: string | null;
    createdBy: string;
    createdAt: string;
    keyId: string;
    ciphertext: string;
  }): Promise<void>;
  listConnections(filter: {
    tenantId?: string;
    vertical?: string;
    provider?: string;
    externalAccountRef?: string;
    includeRevoked?: boolean;
  }): Promise<ConnectionDoRow[]>;
  readConnection(id: string): Promise<ConnectionDoRow | undefined>;
  /** #687: this connection's sealing-key rows — current and retired alike. */
  readConnectionKeys(connectionId: string): Promise<
    {
      key_id: string;
      public_key: string;
      wrapped_key_id: string;
      wrapped_private: string;
      retired_at: string | null;
    }[]
  >;
  /** #687: mint-if-absent; returns the CURRENT key after the write, so a lost race adopts the winner's. */
  insertConnectionKey(row: {
    connectionId: string;
    keyId: string;
    publicKey: string;
    wrappedKeyId: string;
    wrappedPrivate: string;
    createdAt: string;
  }): Promise<{ key_id: string; public_key: string } | undefined>;
  readLiveConnection(
    tenantId: string,
    vertical: string,
    provider: string,
    externalAccountRef?: string,
  ): Promise<(ConnectionDoRow & { key_id: string; ciphertext: string }) | undefined>;
  updateConnectionSecret(
    id: string,
    keyId: string,
    ciphertext: string,
    expiresAt: string | null,
    at: string,
  ): Promise<void>;
  revokeConnection(id: string, at: string): Promise<boolean>;
  // connections.md §3.5.4 — a vertical's mailed connect links; the kernel's statements.
  insertConnectLink(row: {
    id: string;
    tenantId: string;
    scopeId: string;
    vertical: string;
    provider: string;
    createdBy: string;
    subjectRef: string | null;
    returnUrl: string | null;
    createdAt: string;
    expiresAt: string;
  }, audit: AdminEntry): Promise<ConnectLink>;
  readConnectLink(key: ConnectLinkKeyRow): Promise<ConnectLink | undefined>;
  listConnectLinks(
    filter: { tenantId: string; scopeId?: string; ids?: readonly string[]; provider?: string; outstandingOnly?: boolean },
    now: string,
  ): Promise<ConnectLink[]>;
  revokeConnectLink(key: ConnectLinkKeyRow, audit: AdminEntry): Promise<{ link: ConnectLink; changed: boolean } | undefined>;
  consumeConnectLink(
    input: ConnectLinkKeyRow & { provider: string; accountRef?: string; accountLabel?: string },
    now: string,
    audit: AdminEntry,
  ): Promise<ConnectLinkConsume>;
  restoreConnectLink(key: ConnectLinkKeyRow, now: string, audit: AdminEntry): Promise<ConnectLink | undefined>;
  recordConnectionGrant(row: {
    connectionId: string;
    tenantId: string;
    vertical: string;
    permission: string;
    scopeId: string | null;
    expiresAt: string | null;
    grantedBy: string;
    grantedAt: string;
  }): Promise<void>;
  listConnectionGrants(tenantId: string): Promise<ConnectionGrantDoRow[]>;
  // #1674, #2029: the kill switches' directory record — `system-switch-record.ts`. #2045 (Codex
  // r3): each write is also the call's write-ahead intent — the subject's owed mark and the scope's
  // cleared receipt land in the same transaction (`ControlPlaneDO.writeSwitchIntent`).
  recordSwitchedOff(row: SwitchRecordWrite): Promise<SwitchRecordPrior>;
  recordSwitchedOn(row: SwitchRecordWrite): Promise<SwitchRecordPrior>;
  restoreSwitchRecord(
    key: { kind: SwitchKind; tenantId: string; scopeId: string; key: string; operationId: string },
    prior: SwitchRecordPrior,
    /** #2045: also clear the call's own owed mark, in the same directory transaction. */
    clearOwed?: boolean,
  ): Promise<void>;
  listSystemSwitches(filter?: SystemSwitchRecordFilter): Promise<SystemSwitchRecordRow[]>;
  switchRecordsOf(kind: SwitchKind, tenantId: string, scopeId: string): Promise<[string, 'on' | 'off'][]>;
  /** #2045: each record row's position and fence together — what a move to the record reads, never the two apart. */
  switchRecordStatesOf(
    kind: SwitchKind,
    tenantId: string,
    scopeId: string,
  ): Promise<[string, { position: 'on' | 'off'; fence: string }][]>;
  /** #2045: the subjects owed a re-assert to their record — every switch call's, until the scope confirms it. */
  switchesOwedOf(kind: SwitchKind, tenantId: string, scopeId: string): Promise<[string, string][]>;
  clearSwitchOwed(kind: SwitchKind, tenantId: string, scopeId: string, key: string, fence: string): Promise<void>;
  tenantHeldOf(kind: SwitchKind, tenantId: string, keys: readonly string[], now: string): Promise<string[]>;
  recordConnectionUse(
    id: string,
    error: string | null,
    at: string,
  ): Promise<{ tenantId: string; vertical: string; provider: string } | null | void>;
  putConnectorState(id: string, key: string, value: string, at: string): Promise<void>;
  getConnectorState(id: string, key: string): Promise<string | undefined>;
  listConnectorState(id: string, prefix?: string): Promise<{ key: string; value: string }[]>;
  linkIdentity(
    provider: string,
    externalId: string,
    principal: string,
    tenantId: string,
    scopeId: string | null,
    createdAt: string,
  ): Promise<boolean>;
  /** Delete a principal's identity link(s) in a tenant. Idempotent (returns whether it changed). */
  unlinkIdentity(tenantId: string, principal: string): Promise<boolean>;
  readPool(
    provider: string,
  ): Promise<{ provider: string; topology: string; tenant_id: string | null } | undefined>;
  registerIdentityPool(
    provider: string,
    topology: string,
    tenantId: string | null,
    createdAt: string,
  ): Promise<boolean>;
  identityTenants(provider: string, externalId: string): Promise<string[]>;
  identityMemberships(
    provider: string,
    externalId: string,
    access: { id: string; actor: string; at: string },
  ): Promise<{ topology: string | null; memberships: unknown[] }>;
  resolveIdentity(
    tenantId: string,
    provider: string,
    externalId: string,
  ): Promise<{ principal: string; scopeId: string | null } | undefined>;
  // K-42 (#868): the impersonation session store lives in the directory, beside
  // the admin log and for the same reason — it is a platform record about a
  // tenant, not tenant data, and a scope DO must not be able to mint one.
  writeImpersonation(values: (string | null)[]): Promise<void>;
  readImpersonation(id: string): Promise<ImpersonationRow | undefined>;
  endImpersonation(id: string, endedAt: string): Promise<void>;
  listImpersonations(filter: unknown, now: string): Promise<ImpersonationRow[]>;
  recordAccess(entry: {
    id: string;
    actor: string;
    method: string;
    tenantId: string | null;
    scopeId: string | null;
    params: string | null;
    resultCount: number;
    at: string;
  }): Promise<void>;
  accessLog(query: {
    actor?: string;
    tenantId?: string;
    method?: string;
    drained?: boolean;
  } & ListPage): Promise<AccessLogRow[]>;
  markAccessLogDrained(upToId: string, drainedAt: string): Promise<number>;
  pruneAccessLog(limit: number): Promise<number>;
  // #37 — the per-subject key store. Storage only; the crypto is the kernel's.
  readSubjectKey(
    scopeId: string,
    subjectId: string,
  ): Promise<{ keyId: string | null; wrappedDek: string | null; shreddedAt: string | null } | undefined>;
  insertSubjectKey(input: {
    scopeId: string;
    subjectId: string;
    tenantId: string;
    keyId: string;
    wrappedDek: string;
    createdAt: string;
  }): Promise<void>;
  tombstoneSubjectKey(input: {
    scopeId: string;
    subjectId: string;
    tenantId: string;
    at: string;
  }): Promise<{ existed: boolean }>;
  recordAdmin(entry: AdminEntry): Promise<void>;
  auditLog(query: AuditLogQuery): Promise<AdminLogEntry[]>;
  recordOpsFailure(row: OpsFailureRow): Promise<void>;
  settleUnrecordedOutcome(input: { actor: string; intentId: string; error: string }): Promise<boolean>;
  auditedOperations(refs: AuditedOperationRef[]): Promise<AuditedOperationRow[]>;
  /** #1632: subject erasure's directory half — `redactSubjectDirectoryText`. */
  redactSubjectText(target: SubjectTextTarget): Promise<void>;
  listOpsFailures(query: OpsFailureQuery): Promise<OpsFailureEntry[]>;
  recordSweepRun(row: SweepRunRow): Promise<void>;
  listSweepRuns(query: SweepRunQuery): Promise<SweepRunEntry[]>;
  listIssues(query: IssueQuery): Promise<unknown[]>;
  /** #1632: the telemetry retentions, run by the scheduled pass — `telemetryRetentionStatements`. */
  pruneTelemetry(limit: number): Promise<TelemetryPruneReport>;
  pruneFindings(limit: number, audit: AdminEntry): Promise<FindingPruneReport>;
  // #1748 — findings; audited here, as every directory mutation is.
  listFindings(filter: FindingFilter): Promise<FindingEntry[]>;
  setFindingStatus(
    tenantId: TenantId,
    id: string,
    status: FindingStatusInput,
    at: string,
    audit: AdminEntry,
  ): Promise<FindingChange | undefined>;
  createFindingRule(
    tenantId: TenantId,
    input: FindingRuleInput,
    createdBy: string,
    at: string,
    audit: AdminEntry,
  ): Promise<{ rule: FindingRuleEntry; suppressed: string[] }>;
  revokeFindingRule(
    tenantId: TenantId,
    ruleId: string,
    at: string,
    audit: AdminEntry,
  ): Promise<{ before: FindingRuleEntry; after: FindingRuleEntry } | undefined>;
  listFindingRules(tenantId: TenantId, activeAt: string | undefined, limit: number | undefined): Promise<FindingRuleEntry[]>;
  setIssueStatus(
    fingerprint: string,
    status: 'new' | 'resolved' | 'ignored',
    at: string,
  ): Promise<{ before: unknown; after: unknown } | undefined>;
  recordModelUsage(row: ModelUsageRow): Promise<{ recorded: boolean }>;
  listModelUsage(query: ModelUsageQuery): Promise<ModelUsageRow[]>;
  // #40 — the directory's own backup/restore pair.
  exportDump(): Promise<ScopeDumpTable[]>;
  importDump(tables: ScopeDumpTable[]): Promise<void>;
}

interface AdminEntry {
  id: string;
  actor: string;
  action: string;
  /** Null for platform-level actions that target no tenant (K-23). */
  tenantId: string | null;
  /** The event that caused this action, when one did (K-22 §4.2). */
  causedBy: string | null;
  /** Who the actor acted for (#977), when an attributed view wrote the row. */
  onBehalfOf: OnBehalfOf | null;
  scopeId: string | null;
  vertical: string | null;
  before: unknown;
  after: unknown;
  at: string;
}


interface ScopeStubRpc {
  /** The applied-migration count if this call applied any, else null (nothing changed). */
  migrate(): Promise<number | null>;
  /**
   * A FRESH attempt of whatever is pending — clears the DO's memoised migration
   * promise first, so a warm instance's cached rejection is defeated (#49).
   * Same return contract as `migrate()`.
   */
  retryMigrations(): Promise<number | null>;
  /** Whether the scope is classified a copy (#2005, #2009): what a CP-less coordinator reads for primacy. */
  isCopy(): Promise<boolean>;
  /** Mark the scope a copy (#2005); whether this call stamped it. */
  markCopy(): Promise<boolean>;
  /** The lifecycle the platform last delivered to this scope (#1713), or null for none. */
  lifecycle(): Promise<StoredScopeLifecycle | null>;
  /** #2016: how `tenantId` reads against the scope's record, and its lifecycle — one door's read. */
  admission(tenantId: TenantId): Promise<{ verdict: TenantVerdict; lifecycle: StoredScopeLifecycle | null }>;
  /** Store a delivered lifecycle unless a newer one is held (#1713, `writeLifecycle`); #2016: a
   *  scope `tenantId` is foreign to refuses it, a legacy one records its receipt. */
  setLifecycle(
    next: ScopeLifecycle,
    tenantId?: TenantId,
  ): Promise<LifecycleDelivery | { refused: 'tenant'; message: string }>;
  /** Clear a mistaken copy classification (#2005); a load's copied-events mark is kept (#2009). */
  clearCopyMark(expect?: LoadMarker): Promise<'cleared' | 'absent' | 'changed'>;
  /**
   * The executor's due events, decoded per row (#1636): a row that will not decode is in
   * `undecodable`, for the coordinator to dead-letter, and never in `events`.
   */
  pendingExecutorDeliveries(
    deliveryId: string,
    eventType: string,
  ): Promise<{ events: DomainEvent[]; undecodable: { eventId: string; error: string }[] }>;
  recordExecutorAttempt(
    eventId: string,
    deliveryId: string,
    error: string | null,
    nextAttemptAt: string | null,
    /**
     * #1525: the call THIS attempt ran in, or null. LAST, like every argument added
     * to an RPC on this interface (see `recordScheduleRun` below for what a leading
     * one costs). Defaulted in the DO, so an old coordinator that sends none records
     * null — the honest value, since that coordinator knew of no call.
     */
    invocationId?: string | null,
  ): Promise<number>;
  executorAttempts(eventId: string, deliveryId: string): Promise<number>;
  executorDeadLetters(): Promise<ExecutorDeadLetter[]>;
  pendingPlatformRequests(): Promise<PlatformRequestRawRow[]>;
  /** #618: the intent JOURNAL (every status, newest first), where the read above is pending-only. */
  platformRequestHistory(filter?: PlatformRequestFilter): Promise<PlatformRequestRawRow[]>;
  settlePlatformRequest(
    id: string,
    status: 'pending' | 'done' | 'failed',
    result: string | null,
    lastError: string | null,
    /** #841 attribution, JSON-encoded. Defaulted in the DO so an older stub still binds. */
    lastFailure?: string | null,
  ): Promise<void>;
  /** #574 phase 3: enqueue a `connector:<provider>` intent + journal the delivery, atomically. */
  routeExecutorEventToPlatform(
    eventId: string,
    deliveryId: string,
    kind: string,
    payload: string,
    requestedBy: string,
    /** #1525: the call this routing ran in, or null. LAST and defaulted, as above. */
    invocationId?: string | null,
  ): Promise<PlatformRequestId>;
  /** #1232: a CP-less pass's schedule outcomes as one batched intent. Null = dropped (backpressure). */
  enqueueSweepRuns(payload: string, requestedBy: string): Promise<PlatformRequestId | null>;
  /** The migration that failed on this instance, read on `migrate()`'s reject path. */
  migrationFailure(): Promise<{ version: string; error: string; applied: number } | null>;
  invoke(
    operation: string,
    input: unknown,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
    /** The SKU the operation requires (#304) — enforced DO-side for a scope-local scope. */
    requiredEntitlement?: string,
    /** Set when the caller is a MODULE's system principal on a timer (#383). */
    systemModuleId?: string,
    /**
     * #113 phase 3: ask for failures as a value rather than a throw. A ScopeDO still
     * running older code ignores the argument and throws, which the caller handles —
     * so this is safe to deploy in either direction (see `scope-do.ts`).
     */
    failureEnvelope?: boolean,
    /**
     * #129, #116: the request preconditions to evaluate INSIDE the operation's
     * transaction. A ScopeDO running older code ignores the argument — which is
     * why the reply must say whether it honoured one; see `concurrency` and
     * `idempotency` below.
     */
    options?: InvokeOptions,
    /**
     * K-42 (#868): the impersonation session, resolved by the coordinator against
     * the directory and passed WHOLE. The DO cannot read the directory, and the
     * alternative — sending an id and having the DO trust it — would make a
     * session forgeable by anyone who can call the RPC. An older DO ignores the
     * argument, which is the SAFE direction here: it would run the operation as
     * the impersonated principal with no stamp, and the coordinator refuses that
     * outcome rather than accepting an unrecorded one (see `getImpersonatedScope`).
     */
    impersonation?: ImpersonationSession,
    /**
     * #1672: the HASH of a capability session token (the plaintext never crosses). The DO
     * resolves it to its capability inside its queue on every call. An older DO ignores the
     * argument and runs the call as the fresh placeholder principal the coordinator sent,
     * who holds nothing — and the coordinator refuses any success without `capability`.
     */
    capabilitySession?: string,
    /**
     * #1706: the calling PEER vertical, as the platform named it. The DO admits it inside its
     * queue on every call (`admitPeer`). An older DO ignores the argument and runs the call as
     * the fresh placeholder principal the coordinator sent, who holds nothing — and the
     * coordinator refuses any success without `vertical`.
     */
    verticalCaller?: VerticalCaller,
    /**
     * #1834: the instance the system door's gate read. The DO refuses the call on any other
     * instance (`SYSTEM_DOOR_MOVED`), and acknowledges with `systemDoor`.
     */
    systemDoorInstance?: string,
  ): Promise<{
    result: unknown;
    /** #458: platform intents this invoke enqueued — the coordinator's drain-hint feed. */
    platformRequests: number;
    /** Present iff the operation failed and the DO understood `failureEnvelope`. */
    failure?: WireFailure;
    /**
     * K-42: present iff the DO understood `impersonation` — the acknowledgement the
     * coordinator refuses a success without. Unlike every other argument on this
     * RPC, one an old DO silently drops fails OPEN: the operation would run as the
     * impersonated principal with nothing stamped and no read-only bound.
     */
    impersonation?: { honoured: boolean };
    /**
     * Present iff the DO understood `preconditions` and the operation declares
     * `concurrency` (#129).
     *
     * **Its absence is what makes version skew safe.** Every other argument added
     * to this RPC has been safe to ignore: an old DO that drops `failureEnvelope`
     * throws instead of returning a value, and the coordinator handles a throw. An
     * old DO that drops `ifMatch` would COMMIT THE WRITE and return 200 — the
     * caller's precondition silently unenforced, which is the exact lost update
     * the header was sent to prevent, now with a success telling the client it
     * did not happen.
     *
     * So the DO acknowledges rather than the coordinator assuming, and a
     * coordinator that sent `ifMatch` and got no acknowledgement refuses instead
     * of returning. Fail closed, in the one direction that would otherwise fail
     * open silently.
     */
    concurrency?: { version: string | null; ifMatchChecked: boolean };
    /**
     * Present iff the DO understood `idempotencyKey` (#116).
     *
     * Absent for the same reason and with a sharper consequence than
     * `concurrency` above: an old DO that drops the key does not skip a
     * comparison, it RUNS THE OPERATION — a second work order, on the retry the
     * header was sent to make free. So the acknowledgement is what the
     * coordinator refuses on, not something it infers.
     */
    idempotency?: { keyHonoured: boolean; replayed: boolean };
    /** #1672: present iff the DO understood `capabilitySession`, on `impersonation`'s reasoning. */
    capability?: { honoured: boolean };
    /** #1706: present iff the DO understood `verticalCaller`, on the same reasoning. */
    vertical?: { honoured: boolean };
    /** #1834: present iff the DO understood `systemDoorInstance`, on the same reasoning. */
    systemDoor?: { honoured: boolean };
    /**
     * #1834: the pin missed — this instance is not the one the door's gate read — so nothing ran.
     * Set only by the DO's pin check, never from an operation's failure: a handler cannot reach it.
     */
    systemDoorMoved?: true;
    /** #1705 PR 2: exported-type rows the commit added; absent means none (or an older DO). */
    exported?: number;
    /**
     * #1746: the events the call itself emitted, when `onEmitted` asked. Advisory, so an
     * older DO that drops it is safe: the invocation line reads "not recorded".
     */
    emitted?: { events: { type: string; entity: string }[]; total: number };
  }>;
  /** Trade a capability secret for a session or a principal (#1672) — the kernel's
   *  `exchangeCapability`, run in this scope's own storage. */
  exchangeCapability(
    secret: string,
    tenantId: TenantId,
    scopeId: ScopeId,
    mode?: 'act' | 'become',
  ): Promise<CapabilityExchange | null>;
  /** The platform's `become` mint (#1672), serialized in this scope's own storage. */
  mintBecomeCapability(input: BecomeCapabilityInput, actor: PlatformActorId): Promise<MintedCapability>;
  /** The platform's revoke (#1672) — the record as it stood before, or null. */
  revokeCapabilityAsPlatform(id: string, actor: PlatformActorId): Promise<CapabilityRecord | null>;
  /** The operator's read of this scope's capabilities (#1686) — records, never a hash. */
  listCapabilities(filter?: CapabilityFilter): Promise<CapabilityPage>;
  /** #1834: the system door's state read — where a module's schedules stand on this scope
   *  (#383, #1666), the kernel's `systemScheduleState` — and the instance that answered it. */
  systemDoorState(moduleId: string): Promise<{ state: SystemScheduleState; instance: string }>;
  /** #2029: the peer door's state read — where one peer stands on this scope (`subjectGrantState`
   *  over `vertical:<slug>`, `admitPeer`'s predicate) — and the instance that answered it. */
  peerDoorState(vertical: string): Promise<{ state: SystemScheduleState; instance: string }>;
  /** Move a module's schedule switch on this scope (#1666) — the kernel's
   *  `switchSystemSchedules`, as one serialized unit. */
  switchSystemSchedules(
    moduleId: string,
    scopeId: string,
    to: 'on' | 'off',
    at: string,
    /** #1823: the directory holds a live tenant-level grant for the module. */
    tenantHeld?: boolean,
    /** #2045: the switch call's fence — a move older than the one the scope applied is refused. */
    fence?: string,
  ): Promise<SwitchOutcome & { instance: string }>;
  /** Move one peer's kill switch on this scope (#1706) — the kernel's `switchPeer`. The
   *  instance that applied it rides along (#2029), for the rewind hold's release, as for
   *  `switchSystemSchedules`. The host and this object ship in one bundle. */
  switchPeer(
    vertical: string,
    scopeId: string,
    to: 'on' | 'off',
    at: string,
    /** #2030: the directory holds a live tenant-level grant for the peer. */
    tenantHeld?: boolean,
    /** #2045: as on `switchSystemSchedules`. */
    fence?: string,
  ): Promise<SwitchOutcome & { instance: string }>;
  /** Does a peer hold each key here now (#1706) — the checker's own `covers`. #2029: pinned to
   *  the instance the peer door's gate read; on any other the answer is `SystemDoorMoved`. */
  peerCovers(
    tenantId: TenantId,
    scopeId: ScopeId,
    vertical: string,
    permissions: PermissionKey[],
    doorInstance: string,
  ): Promise<PeerCoverage[] | SystemDoorMoved>;
  /** `ctx.canAssign`'s bound for a named principal (#1931); `null` for a role the tenant lacks. */
  canAssignFor(tenantId: TenantId, scopeId: ScopeId, principal: PrincipalId, roleKey: string, atTenant?: boolean): Promise<Coverage | null>;
  assignScopeRoleBoundedFor(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, assignee: PrincipalId, roleKey: string,
  ): Promise<Coverage | null>;
  /** #1150: the scope's role roster, and the two bounded writes over it — see `scope-do.ts`. */
  scopeRoleHoldersFor(scopeId: ScopeId, principal?: PrincipalId): Promise<ScopeRoleHolder[]>;
  changeScopeRoleBoundedFor(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId, from: string, to: string,
  ): Promise<Coverage | 'not-held' | 'unknown-to'>;
  revokeScopeRolesBoundedFor(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId,
  ): Promise<{ coverage: Coverage; revoked: string[] }>;
  /** Every module this scope holds or has held system authority for, and where each
   *  stands (#1674) — the kernel's `systemGrantsStatus`, run in the scope's own storage. */
  systemGrantsStatus(): Promise<SystemGrantsEntry[]>;
  /** #1819: the rewind hold, on the `SWITCH_HOLDS_NAME` object only — see `scope-do.ts`. */
  switchHoldToken(): Promise<number>;
  switchHoldClaim(scopeId: string, moduleIds: string[], claimId: string, token: number): Promise<void>;
  switchHoldOn(scopeId: string, moduleId: string, claimIds: string[]): Promise<void>;
  switchHoldJoin(scopeId: string, moduleId: string, claimIds: string[]): Promise<void>;
  switchHoldYoungestMs(scopeId: string, claimId: string): Promise<number | null>;
  switchHoldArm(scopeId: string, claimId: string, doomed: string | null): Promise<void>;
  switchHoldDrop(scopeId: string, claimId: string): Promise<void>;
  switchHoldsAll(): Promise<{ scopeId: string; moduleId: string }[]>;
  switchHoldClaims(scopeId: string): Promise<SwitchHoldClaim[]>;
  switchHoldRelease(scopeId: string, moduleId: string | null, claimIds: string[] | null): Promise<void>;
  /** #1819: which instance is serving this scope, and whether it armed a rewind. */
  rewindProbe(): Promise<{ instance: string; armed: boolean }>;
  /** Where every peer this scope holds or has held grants for stands (#1706) — the kernel's
   *  `peerGrantsStatus`, run in the scope's own storage. */
  peerGrantsStatus(): Promise<PeerGrantsRow[]>;
  /** `grantToSystem`'s scope-level write (#1666): `false`, and nothing written, while the
   *  module's schedule kill switch is off on this scope. */
  writeSystemGrant(moduleId: string, relation: string, object: string, expiresAt: string | null): Promise<boolean>;
  /** The last time a schedule's operation ran on this scope (#383), or null if never. */
  scheduleLastRun(operation: string): Promise<string | null>;
  /**
   * #119: one pass of a purge schedule — the DO picks what is due by its own clock and the declared
   * horizon, and purges it as the module's system principal. See the DO.
   */
  runPurgeSweep(
    operation: string,
    tenantId: TenantId,
    scopeId: ScopeId,
    systemDoorInstance: string,
  ): Promise<PurgePass | SystemDoorMoved>;
  /** #1232: the freshness evaluator's one-round-trip read — evidence + evaluator state per type. */
  freshnessProbe(
    types: string[],
  ): Promise<Record<string, { observedAt: string | null; stateAt: string | null; stateOutcome: string | null }>>;
  /** Write one `_substrat_schedule_state` row (#383) — `unit` is either a schedule
   *  operation (`module/verb`: when it ran, how it ended) or a freshness key
   *  (`freshness:<eventType>`: when the verdict was recorded, and what it was).
   *  `kind` says which, and is passed rather than read off the key's shape (#1288):
   *  an operation may legally be spelled `freshness:…`, and only the caller knows.
   *
   *  **LAST, like every argument added to an RPC on this interface**, and for the
   *  reason `invoke`'s `concurrency` acknowledgement spells out above: an old DO
   *  drops a trailing argument it does not know, but binds a LEADING one positionally
   *  — `kind` would land in `unit`, `unit` in `at`, `at` in `status`, and the row
   *  written would be three values in the wrong columns with no error anywhere. The
   *  schedule's real key is then never written, so its cadence gate finds nothing and
   *  the operation runs again on every pass. Appended, an old DO simply records what
   *  it always recorded. The reverse skew — a new DO, an old coordinator sending no
   *  kind — hits `kind TEXT NOT NULL` and throws, which is the loud half and is left
   *  loud deliberately: a default here would be the derived-from-the-key guess #1288
   *  exists to remove.
   *
   *  `invocationId` (#1525) is appended for the same positional reason and defaulted
   *  in the DO, so an old coordinator that sends none records null — honestly, since
   *  that coordinator minted no id to send. The coordinator passes one only for a
   *  fired or failed schedule; a freshness verdict invokes nothing, so it has none. */
  recordScheduleRun(
    unit: string,
    at: string,
    status: 'ok' | 'failed' | 'skipped',
    kind: ScheduleStateKind,
    invocationId?: string | null,
  ): Promise<void>;
  // -- the resumable-run driver's store (#1577). Reads and writes only: every
  //    decision lives in the kernel, which the COORDINATOR drives, so the durable
  //    driver and the in-process one cannot disagree about what a pass means.
  //
  //    NEW methods rather than widened ones, so the version-skew hazard the
  //    `recordScheduleRun` note below spells out does not arise: a DO that predates
  //    this has no such method and throws, which is the loud half and the right one —
  //    it also has no `_substrat_job_runs` (the table is created by KERNEL_DDL on the
  //    constructor that would carry these), so a run started against it would have
  //    nowhere to live. Fail closed and visible, never a row written to nowhere.
  //    Two of them are single RPCs BECAUSE a DO serializes its RPCs, which is the
  //    only atomicity available across this seam: `jobRunStartOrJoin` (else two
  //    concurrent starts both insert, and no unique index exists to catch the
  //    second) and `jobCommitPass` (else an advanced cursor can outlive the ledger
  //    drop and the next pass reads a stale memo). Splitting either back into two
  //    calls silently reintroduces the race.
  jobRunStartOrJoin(
    moduleId: string,
    job: string,
    instance: string,
    row: JobRunRow,
  ): Promise<JobRunRow>;
  jobRunInsert(row: JobRunRow): Promise<void>;
  jobRunsDueKeys(now: string, max: number): Promise<JobDueKey[]>;
  jobRunList(filter: JobRunFilter): Promise<JobRunRow[]>;
  jobRunClaim(id: string, owner: string, leaseMs: number): Promise<JobRunClaim | null>;
  jobRunBegin(id: string, owner: string, marginMs: number): Promise<boolean>;
  jobRunMiss(id: string, owner: string, note: string): Promise<{ misses: number; failed: boolean } | null>;
  jobRunPatch(id: string, patch: JobRunPatch, owner?: string): Promise<boolean>;
  jobCommitPass(id: string, patch: JobRunPatch, owner?: string): Promise<boolean>;
  jobStepBegin(runId: string, step: string, owner: string, leaseMs: number): Promise<{ held: boolean; row: JobStepRow | null }>;
  jobStepRecord(
    runId: string,
    step: string,
    result: string | null,
    attempts: number,
    lastError: string | null,
    at: string,
    owner?: string,
    leaseMs?: number,
  ): Promise<boolean>;
  /** This scope's live `connection:<id>` grant tuples (#726 gap 1) — the read-back.
   *  Unions the scope's own tuples with the projected tenant-level ones, because a
   *  scope check consults both (rule 2 inheritance). */
  listConnectionGrants(
    now: string,
  ): Promise<{ subject: string; relation: string; expires_at: string | null }[]>;
  /** A declared entity-grant shape's grant: marker plus keys, one unit (#2071). */
  grantEntityShape(principal: PrincipalId, entity: EntityRef, permissions: readonly string[]): Promise<void>;
  /** One bounded pass of the shape reconcile with its events (#2071). */
  topUpEntityGrantShapes(
    tenantId: string,
    scopeId: string,
    shapes: readonly EntityGrantShape[],
    limit: number,
  ): Promise<{ toppedUp: number; done: boolean }>;
  /** The EXPLICIT grant: `INSERT OR REPLACE`, so it clears a tombstone. */
  writeTuple(
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
  /** Provisioning's write (#1659): creates a missing tuple, never un-revokes one. */
  seatTuple(
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
  /** Provisioning's seat as one unit, then the recorded-off modules switched off in it (#1742). */
  seatTuples(
    tuples: { subject: string; relation: string; object: string; expires_at: string | null }[],
    switchOff?: RecordedOffCarry & { scopeId: string; at: string },
  ): Promise<SwitchedOff[]>;
  /** Tombstone a scope tuple by exact (subject, relation, object). Idempotent. */
  revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
  hasEffectiveRoleGrantFor(tenantId: string, subject: string): Promise<boolean>;
  /** Attachment surface, metadata half (#473) — see the ScopeDO methods of the same names.
   *  `connectionId` (#476) gates as a connection instead of `principal` when set. */
  attachmentAdd(
    record: AttachmentRecord,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
  ): Promise<AttachmentRecord>;
  attachmentList(
    entity: EntityRef,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
  ): Promise<AttachmentRecord[]>;
  attachmentAuthorize(
    attachmentId: string,
    mode: 'read' | 'write',
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
    /** #726 remedy B: admit by ownership of THIS delivery's entity, resolved here. */
    forEventId?: string,
  ): Promise<AttachmentRecord | null>;
  /** Read-only attachment gate for a registered module's system principal. */
  systemAttachmentAuthorize(
    attachmentId: string,
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
    /** #1834: the instance the system door's gate read; on any other it answers `SystemDoorMoved`. */
    systemDoorInstance?: string,
  ): Promise<AttachmentRecord | null | SystemDoorMoved>;
  attachmentRemove(
    attachmentId: string,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
  ): Promise<AttachmentRecord | null>;
  /**
   * #1686: the capability session's reads — `sessionHash` resolved inside the DO's queue.
   * Each answers an envelope whose failure is DATA (`invoke`'s discipline): a throw across
   * this boundary would keep its message and lose its code.
   */
  capabilityAttachmentList(
    entity: EntityRef,
    sessionHash: string,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<DoReply<AttachmentRecord[]>>;
  capabilityAttachmentOpen(
    attachmentId: string,
    sessionHash: string,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<DoReply<AttachmentRecord | null>>;
  /** #1686: always a failure — the refusal of a write through a capability, recorded (K-35). */
  capabilityAttachmentRefuseWrite(
    sessionHash: string,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: 'attachments.upload' | 'attachments.remove',
    target: { entityType: string } | { attachmentId: string },
  ): Promise<DoReply<never>>;
  /** #1575: extracted-text search as `principal` (or the connection), its failure as data. */
  attachmentSearch(
    term: string,
    limit: number,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
  ): Promise<DoReply<AttachmentRecord[]>>;
  /** #1575: the same search through a capability session, as an envelope. */
  capabilityAttachmentSearch(
    term: string,
    limit: number,
    sessionHash: string,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<DoReply<AttachmentRecord[]>>;
  /** #1575: the extraction job's record read — no gate, the kernel's own derivation. */
  attachmentTextSource(attachmentId: string): Promise<AttachmentRecord | null>;
  /** #1575: write an extraction outcome; false when the attachment was removed meanwhile. */
  attachmentTextRecord(attachmentId: string, outcome: ExtractionOutcome): Promise<boolean>;
  /** #1575: start the one-shot backfill unless the scope is marked or holds no attachments. */
  attachmentTextBackfillStart(): Promise<void>;
  /** #1575: one backfill batch after `after`, in one transaction. */
  attachmentTextBackfillBatch(after: string | null): Promise<AttachmentTextBackfillBatch>;
  /** Scope-local projection (scope-local-permissions.md): replace the tenant's roles + tuples and flip to local.
   *  `entitlements` (#304) rides the same snapshot — preserve-on-undefined, so a role-only re-projection
   *  leaves projected entitlements untouched. */
  applyProjection(
    tenantId: string,
    roles: { role_key: string; permissions: string; source: string }[],
    tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[],
    entitlements?: { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[],
    /** Scope-level tuples (e.g. the owner grant) seated in the same unit as the flip (#332) —
     *  never un-revoked, except a `lockout_reseat` one on a scope with no effective role grant (#1659). */
    scopeTuples?: {
      subject: string;
      relation: string;
      object: string;
      expires_at: string | null;
      lockout_reseat?: boolean;
    }[],
    /** The tenant's identity links (#406) — same preserve-on-undefined convention as entitlements. */
    identities?: { provider: string; external_id: string; principal_id: string; scope_id: string | null }[],
    /** Live connections' PUBLIC sealing keys (#687) — same preserve-on-undefined convention. */
    connectionKeys?: { connection_id: string; provider: string; key_id: string; public_key: string }[],
    /** The recorded-off modules switched off after the seat, in the same unit (#1742). */
    switchOff?: RecordedOffCarry & { scopeId: string; at: string },
    serviceSubjects?: readonly string[],
  ): Promise<SwitchedOff[]>;
  /** #113: `applyProjection`, its refusal answered as data. */
  applyProjectionReply(...args: Parameters<ScopeStubRpc['applyProjection']>): Promise<DoReply<SwitchedOff[]>>;
  /** Resolve an external identity from this scope's projected links (#406) — the CP-less auth read. */
  resolveProjectedIdentity(
    tenantId: string,
    provider: string,
    externalId: string,
  ): Promise<{ principal: string; scopeId: string | null } | undefined>;
  /** Read-only introspection of this scope's DB (§5.4 admin-query RPC). */
  introspectTables(): Promise<ScopeTable[]>;
  introspectTable(table: string, limit: number, offset: number): Promise<ScopeTablePage>;
  /** #113: `introspectTable`, its refusal answered as data. */
  introspectTableReply(table: string, limit: number, offset: number): Promise<DoReply<ScopeTablePage>>;
  /** One read-only SQL statement, gated + rolled back inside the DO (#219). */
  introspectQuery(sql: string): Promise<ScopeQueryResult>;
  /** #113: `introspectQuery`, its refusal answered as data. */
  introspectQueryReply(sql: string): Promise<DoReply<ScopeQueryResult>>;
  /** The K-35 denial log, read back (#867) — raw rows and the bucketed view. */
  listDenials(filter?: DenialFilter): Promise<PermissionDenial[]>;
  summarizeDenials(filter?: DenialFilter): Promise<DenialSummary>;
  /** #1745: the refusal log, read back — refused lifecycle moves, newest first. */
  listRefusals(filter?: RefusalFilter): Promise<RefusalRecord[]>;
  /** Complete logical dump of this scope's DB (preview-and-snapshots.md §3). */
  exportDump(): Promise<ScopeDumpTable[]>;
  /**
   * Load a dump into this (freshly-provisioned) scope — the fork write side.
   * `destScopeId` re-points the dump's scope-level grants at the destination.
   */
  importDump(
    tables: ScopeDumpTable[],
    destScopeId?: ScopeId,
    opts?: {
      /** The recorded-off modules switched off on `destScopeId` after the replay, in its event (#1742). */
      switchOff?: RecordedOffCarry & { at: string };
      /** The scope the dump was captured from (#1869): only its node grants are re-pointed. */
      sourceScopeId?: ScopeId;
      /** The platform exported the dump itself: no fallback (`RepointSource.exact`). */
      exact?: boolean;
      /** #1722: the stamp this load leaves; without one it leaves none. */
      loadStamp?: string;
      /** #2005: the directory says the scope is not primary — mark it a copy. */
      markCopy?: boolean;
      /** #2016: the tenant the platform says the scope belongs to, recorded as its receipt. */
      provisionedFor?: TenantId;
    },
  ): Promise<SwitchedOff[]>;
  /** #1722: what a carry's restore into this store expects to find unchanged. */
  loadMarker(): Promise<LoadMarker>;
  /** #1722: `importDump` with its refusals (`changed` under `expect`, `kept`) answered as values. */
  importDumpChecked(
    tables: ScopeDumpTable[],
    destScopeId: ScopeId,
    opts: {
      switchOff?: RecordedOffCarry & { at: string };
      sourceScopeId?: ScopeId;
      exact?: boolean;
      loadStamp?: string;
      expect?: LoadMarker;
      markCopy?: boolean;
      provisionedFor?: TenantId;
    },
  ): Promise<
    { refused: 'changed' | 'kept' } | { refused: 'tenant'; message: string } | { refused: false; switchedOff: SwitchedOff[] }
  >;
  /** #1722: the kept-copy marker, or null. */
  keptCopy(): Promise<KeptCopy | null>;
  /** #1722: discard a kept copy at the revision the operator acted on. */
  discardKeptCopy(
    scopeId: ScopeId,
    revision: string | null,
    carriedAway: CarriedAway,
    markCopy?: boolean,
    loadStamp?: string | null,
  ): Promise<{ discarded: true } | { refused: 'changed' | 'not-kept' }>;
  /** #1722: `exportDump` and the store's load stamp, read in one call. */
  exportDumpStamped(): Promise<{ tables: ScopeDumpTable[]; loadStamp: string | null; revision: string | null }>;
  /** #1722: wipe a carried copy if nothing was loaded since `expectLoadStamp`; false when refused. */
  wipeCarried(
    scopeId: ScopeId,
    expectLoadStamp: string | null,
    carriedAway: CarriedAway,
    opts?: { expectRevision?: string | null; protectIfChanged?: boolean; markCopy?: boolean },
  ): Promise<boolean>;
  /** #1722: clear a kept copy's marker where it is the live store, at the revision read. */
  releaseKeptCopy(
    revision: string | null,
    markCopy?: boolean,
    loadStamp?: string | null,
  ): Promise<{ released: true } | { refused: 'changed' | 'not-kept' }>;
  /** Wipe this scope's storage — the reap half of deleteSnapshot (§9). */
  destroyStorage(): Promise<void>;
  /**
   * Redact the spine payloads keyed to one data subject (#37); returns how many moved,
   * per table. Both spine copies of an event go in this one RPC (#1600) — the outbox row
   * and any platform intent this CP-less host routed the event into.
   *
   * **The `number` arm is version skew, not an alternative contract.** This RPC answered
   * with a bare outbox count until #1600, and an old DO on the other end of a new
   * coordinator still does — the skew this interface's own `recordScheduleRun` note
   * spells out, in the direction a RETURN type can carry it. The caller MUST fail on it
   * rather than read it as a count: an old DO redacts the outbox and leaves the intent
   * journal, which is precisely the defect #1600 exists to close, so treating its reply
   * as `{ events, intents: 0 }` would mint a receipt claiming an erasure that did not
   * happen. Typed as a union rather than cast at the call site so the skew has to be
   * handled to compile.
   *
   * **The `LegacySubjectRedactionCounts` arm is the same skew, one release later
   * (#1632).** A DO from after #1600 answers `{ events, intents }` and never looked at
   * the job-run tables, so it is refused the same way rather than read as `jobRuns: 0`.
   * And one from before the free-text half answers the job-run count without
   * `idempotencyResults` or `intentIds`, and is refused for the same reason.
   */
  redactSubject(
    subjectId: string,
  ): Promise<SubjectRedactionCounts | LegacySubjectRedactionCounts | number | { failure: WireFailure }>;
  /** PITR bookmarks recorded before migration passes (#286), newest first. */
  migrationBookmarks(limit?: number): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]>;
  appliedMigrations(limit?: number): Promise<AppliedMigration[]>;
  /** `SqlStorage.databaseSize` of this scope (#1524). */
  databaseSize(): Promise<number>;
  entityHistory(input: {
    entityType: string;
    entityId: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<HistoryEntry>>;
  /** The Tier-2 read, and what it stepped over (#1636) — an object, because it crosses the RPC. */
  undrainedEventsRead(limit: number): Promise<UndrainedRead>;
  markEventsDrained(eventIds: readonly string[], at: string): Promise<number>;
  /** #1705: the producer's release, decided by the DO's own registered exports. */
  /** #2029: `door`, the consumer peer's door — pinned to its gate's instance, or held off. */
  exportedEventsRead(
    input: ExportReadInput,
    tenantId: TenantId,
    scopeId: ScopeId,
    door: { instance: string } | { held: true },
  ): Promise<ExportedBatch | SystemDoorMoved>;
  /** #1705: what the DO's modules import, and its watermark per producer. */
  importStateRead(): Promise<ImportState>;
  /** #1705: apply a batch another vertical exported, under the watermark's compare-and-set.
   *  #2029: `doorInstance`, the instance the peer door's gate read; on any other the answer is
   *  `SystemDoorMoved` and nothing is applied. */
  importApply(
    batch: ImportBatch,
    tenantId: TenantId,
    scopeId: ScopeId,
    doorInstance: string,
  ): Promise<ImportResult | SystemDoorMoved>;
  /** #1705 PR 2: was this scope provisioned here for this tenant — read without migrating. */
  servesTenant(tenantId: TenantId): Promise<boolean>;
  /** #1705 PR 3: the replay lever, on the scope's queue, in one transaction. */
  importCursorMove(input: ImportCursorMoveAt & { now: number }): Promise<ImportCursorMoved>;
  redrainEvents(drainedBefore: string): Promise<number>;
  /** How many rows that reopen WOULD touch, touching none of them (#1545). */
  redrainCount(drainedBefore: string): Promise<number>;
  facetEvents(input: EventFacetInput): Promise<EventFacetResult>;
  eventCause(input: EventCauseInput): Promise<CauseChain>;
  eventEffects(input: EventEffectsInput): Promise<EffectsTree>;
  invocationEvents(input: InvocationEventsInput): Promise<InvocationEvents>;
  deadLetters(input: DeadLettersInput): Promise<Page<DeadLetter>>;
  lifecycleFlow(input: LifecycleFlowInput): Promise<LifecycleFlowResult>;
  operationSeries(input: OperationSeriesInput): Promise<OperationSeriesResult>;
  /** Rewind storage to a bookmark (#286's backout) — completes on the DO's restart. */
  rewindToBookmark(bookmark: string, opts?: { force?: boolean }): Promise<{ rewindingTo: string; instance?: string }>;
}

/**
 * Where a connector's scope-side effects land when the scope is served by ANOTHER
 * deployment (#574). Set only on the shared control plane's host — its own SCOPE
 * namespace is the module-less placeholder, so a connector write-back executed
 * locally would land in a DO that runs no modules. Each method is expected to ride
 * the vertical's platform-secret-gated `/internal/connector-*` surface.
 *
 * The DIRECTORY gates (live connection, tenant/vertical match) still run in this
 * host before any delegated call; the PERMISSION check runs at the far end, in the
 * vertical's own ScopeDO, against the delivered `connection:<id>` tuple — the
 * platform cannot skip it any more than any other caller can.
 */
export interface ConnectorDelegation {
  /** Invoke one operation in the serving deployment, as the connection. */
  invoke(args: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    operation: string;
    input: unknown;
  }): Promise<unknown>;
  /** Land provider bytes in the serving deployment, as the connection. */
  uploadAttachment(args: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    upload: AttachmentUploadInput;
  }): Promise<AttachmentRecord>;
  /**
   * Fetch ONE attachment's bytes back OUT of the serving deployment, as the
   * connection (#711) — the outbound leg's mirror of `uploadAttachment`.
   *
   * Needed because a signing connector has to send the vertical's own rendered
   * document, and the platform that runs the connector holds the credential but
   * not the bytes: the metadata row lives in the vertical's ScopeDO and the object
   * in the vertical's R2, neither of which the control plane can reach. So the read
   * crosses the same `/internal` seam the write does, permission-checked at the far
   * end against the connection's own grant.
   *
   * By id only. There is deliberately no delegated `list`: a connector that
   * searched for the document to send would need a rule for picking among an
   * instance's attachments, and the return path lands the sealed signed copy on
   * that same instance.
   */
  openAttachment(args: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    attachmentId: string;
    /**
     * The delivery this read is for (#726 remedy B). The serving deployment resolves it
     * against its OWN outbox to decide what may be read — so what crosses this seam is
     * the name of a delivery, not a claim about which entity the platform may reach.
     */
    eventId?: string;
  }): Promise<OpenedAttachment | null>;
  /** Write the scope-local `connection:<id>` grant tuple in the serving deployment. */
  grant(args: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    permission: PermissionKey;
    expiresAt?: string;
  }): Promise<void>;
}

/**
 * The schedule kill switch's reach into the deployment actually serving a scope (#1666).
 *
 * A hosted scope's `system:<module>` grants live in its vertical's dispatch deployment,
 * and the shared control plane's own `SCOPE` namespace is the module-less placeholder: a
 * switch written there tombstones nothing a sweep will ever read. So the write crosses the
 * same platform-secret `/internal/*` seam the connector grant does (`/internal/system-switch`),
 * and the audit row stays on this side. Set only on the shared control plane's host.
 */
export interface SystemSwitchDelegation {
  switch(args: {
    tenantId: TenantId;
    scopeId: ScopeId;
    moduleId: ModuleId;
    to: 'on' | 'off';
    /**
     * #1823: the directory holds a live TENANT-level grant for the module. The deployment has
     * no directory to read it from, and a module whose only authority on the scope is that
     * grant must still be switchable there.
     */
    tenantHeld?: boolean;
    /** #2045: the switch call's fence. A deployment built before it strips it and applies the move. */
    fence?: string;
  }): Promise<SwitchOutcome>;
  /**
   * The read half (#1674): every module the deployment serving this scope holds or has
   * held system authority for, and where each stands. Same reach as `switch` — the same
   * `/internal/*` seam, the same deployment, the same "who actually holds the grants"
   * answer — so the two can never disagree about what a hosted scope's switch shows.
   */
  status(args: { tenantId: TenantId; scopeId: ScopeId }): Promise<SystemScheduleEntry[]>;
  /**
   * #2045 (Codex r3): does the deployment serving this scope honour the switch fence? Asked
   * BEFORE any switch call records or moves anything (`/internal/switch-fence`): `false` is a
   * deployment's own proof that it predates the fence (the route is absent), and the call is
   * refused. Anything that is not a clear answer throws.
   */
  fenceSupported(args: { tenantId: TenantId; scopeId: ScopeId }): Promise<boolean>;
}

/**
 * The lifecycle's reach into the deployment serving a scope (#1713). Suspending a scope or a
 * tenant changes the directory, which a CP-less vertical never reads, so the platform delivers
 * the scope's lifecycle over the same platform-secret `/internal/*` seam the switches cross
 * (`/internal/lifecycle`), and the deployment holds the scope's work by it. Set only on the
 * shared control plane's host.
 */
export interface LifecycleDelegation {
  deliver(args: { tenantId: TenantId; scopeId: ScopeId; lifecycle: ScopeLifecycle }): Promise<LifecycleDelivery>;
}

/**
 * How far ahead of the clock a held lifecycle epoch may be and still be learned past (#1713). An
 * epoch is the time a directory restore minted it, so a legitimate one is behind its minter's
 * clock; the skew allows for clocks that disagree, and bounds what a forged answer can move.
 */
export const LIFECYCLE_EPOCH_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * #2016: how many served scopes one heal pass asks for their tenant record, beyond the drift and the
 * holds. Rotated least-recently-asked first, so a deployment that cannot answer yet (a build from
 * before the record) costs at most this many deliveries a pass and starves nothing.
 */
export const TENANT_UNRECORDED_PER_PASS = 50;

/** What one delivery pass did (#1713): a transition's push, or one heal sweep. */
export interface LifecycleDeliveryReport {
  /** Scopes the pass delivered to. */
  attempted: number;
  /** Deliveries the deployment acknowledged, its receipt recorded. */
  delivered: number;
  /** Deliveries that did not land: each is an ops-failure row, and the heal sweep asks again. */
  failed: number;
}

/**
 * The PEER kill switch's reach into the deployment actually serving a scope (#1706).
 *
 * `SystemSwitchDelegation` with the subject swapped, and it exists for the identical
 * reason: a hosted scope's `vertical:<slug>` grants — what one vertical may do when it
 * calls another's operations — live in its vertical's dispatch deployment, and the shared
 * control plane's own `SCOPE` namespace is the module-less placeholder. A switch written
 * there tombstones nothing a peer call will ever read, so the tenant would be told the peer
 * was cut off while every call it makes keeps being admitted. That is the one failure this
 * switch must never have.
 *
 * Separate from `SystemSwitchDelegation` rather than folded into it: they cross the same
 * `/internal/*` seam but answer about different subjects, and a deployment old enough to
 * serve one route and not the other must be able to say so per route. The audit rows for
 * both stay on this side. Set only on the shared control plane's host.
 */
export interface PeerSwitchDelegation {
  switch(args: {
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    to: 'on' | 'off';
    /**
     * #2030: the directory holds a live TENANT-level `vertical:` grant for the peer, which the
     * deployment has no directory to read. A deployment built before it strips the field and
     * answers `held: false` for a peer with nothing on the scope, as it always did.
     */
    tenantHeld?: boolean;
    /** #2045: as on `SystemSwitchDelegation.switch`. */
    fence?: string;
  }): Promise<SwitchOutcome>;
  /**
   * The read half: where every peer this scope holds or has held grants for stands. Same
   * reach as `switch` — the same seam, the same deployment, the same "who actually holds
   * the grants" answer — so the two can never disagree about what a hosted scope shows.
   * The bare position only: who switched a peer off, and why, is the admin log's, and the
   * admin log is the control plane's own store.
   */
  status(args: { tenantId: TenantId; scopeId: ScopeId }): Promise<PeerGrantsEntry[]>;
  /** #2045: as on `SystemSwitchDelegation.fenceSupported` — the same deployment, the same answer. */
  fenceSupported(args: { tenantId: TenantId; scopeId: ScopeId }): Promise<boolean>;
}

/**
 * The replay lever's reach (#1705 PR 3): move a hosted consumer's watermark in the deployment
 * that holds it. The shared control plane resolved the producer from its directory and wrote the
 * intent row, and the far end moves the cursor and the journal rows under the given `replayId`.
 * Set only on the shared control plane's host, like the switches. Unset, a scope served
 * elsewhere is refused `unavailable` rather than moved in the placeholder namespace, where
 * it would report a replay while the real watermark never moved.
 */
export interface ImportCursorDelegation {
  move(args: { tenantId: TenantId; scopeId: ScopeId; at: ImportCursorMoveAt }): Promise<ImportCursorMoved>;
}

/**
 * The Tier-2 drain's reach into the deployment actually serving a scope (#1334).
 *
 * The same problem `ConnectorDelegation` solves, for the other direction: on the shared
 * control plane `env.SCOPE` is the module-less placeholder namespace, and a hosted
 * scope's outbox lives in its vertical's dispatch deployment. Without this, the sweep's
 * drain phase would construct one empty placeholder DO per active scope per tick, log
 * an access row for each, and ship nothing — which from the lake's side is
 * indistinguishable from a fleet with no events. The two verbs are the two the drain
 * is made of, deliberately kept apart (read, ship, then stamp); the audit rows for
 * both stay on the host's own `readUndrainedEvents` / `markEventsDrained`, whichever
 * branch served them — K-24's rule that an auditor cannot tell from the row.
 */
export interface EventDrainDelegation {
  /**
   * The oldest not-yet-drained events of one scope, from the deployment serving it — with
   * what that deployment's read stepped over (#1636) as the array's optional `skipped`,
   * when the deployment is new enough to say.
   */
  readUndrained(args: {
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    limit: number;
  }): Promise<UndrainedEvents>;
  /** Stamp `drained_at` on shipped events in the serving deployment; returns how many changed. */
  markDrained(args: {
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    eventIds: readonly string[];
    drainedAt: string;
  }): Promise<number>;
  /**
   * Reopen rows stamped before `drainedBefore` in the serving deployment, so the drain
   * ships them again; returns how many (#1334). The third verb, and it must be delegated
   * for the same reason as the stamp it undoes: the rows live there, and clearing stamps
   * in the placeholder namespace would report success while reopening nothing.
   */
  redrain(args: {
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    drainedBefore: string;
    /**
     * Count and reopen nothing (#1545). It has to cross this seam like the instant does:
     * a delegated scope whose far end never hears the flag would reopen its window and
     * answer with a number that reads exactly like the count that was asked for.
     */
    countOnly?: boolean;
  }): Promise<number>;
}

export interface CloudflareScopeHostOptions {
  /**
   * The parsers attachment text is extracted with (#1575, K-43) — `defaultAttachmentExtractors()`
   * from `@substrat-run/attachment-extractors`, or a list of the deployment's own. The kernel
   * and this adapter parse no file format; omitted, every upload records `unsupported`, with
   * that reason, which is a valid configuration rather than a broken one.
   */
  attachmentExtractors?: readonly AttachmentExtractor[];
  /**
   * Tighter bounds for attachment text extraction (#1575): input ceiling, text cap, time
   * budget. Each may only lower the kernel's default (`resolveAttachmentTextBounds`).
   */
  attachmentTextBounds?: Partial<AttachmentTextBounds>;
  /**
   * Service accounts minted by this vertical, read before CP-less provisioning/reconcile
   * (#1896). Their roles still authorize work but do not prevent human lockout repair.
   * Keep this source complete; a failed read refuses provisioning before projection.
   */
  servicePrincipals?: (tenantId: TenantId, scopeId: ScopeId) => Promise<readonly PrincipalId[]>;
  scope: DurableObjectNamespace;
  /**
   * The shared directory DO. Optional: a **CP-less** vertical (docs/architecture/scope-
   * local-permissions.md, Phase 3) runs with no control plane — it evaluates
   * permissions from its scopes' own storage, trusts the router-asserted node for
   * lifecycle/tenancy, and treats entitlements as enforced upstream at provision.
   * Its admin surface (createTenant, defineRole, tenant grants, …) is unavailable;
   * such a vertical provisions via `provisionScopeLocal` and is served via
   * `getScope`/`invoke`.
   */
  controlPlane?: DurableObjectNamespace;
  /**
   * Accepted for parity with the pure adapter's constructor. In milestone 1 the
   * ScopeDO owns permission evaluation (a checker function cannot cross the RPC
   * boundary), so this is informational only — the DO builds the tuple checker.
   */
  checker?: PermissionChecker;
  /**
   * Seals per-tenant credentials at rest (#101). Lives on the COORDINATOR, not
   * in the ControlPlaneDO: the DO stores ciphertext and has never held a key.
   * Omitted, the host refuses to store a credential rather than storing one in
   * the clear.
   */
  secretBox?: SecretBox;
  /**
   * Egress for connectors. Defaults to the runtime's `fetch`. Injectable so a
   * provider can be stood up in memory for tests and dev.
   */
  fetch?: FetchLike;
  /**
   * #1691: where each connector call's data point goes, beside the health line
   * `recordConnectionUse` settles — on the platform, the control plane's Analytics
   * Engine dataset (`analyticsEngineConnectorCallRecorder`). Defaults to the no-op
   * recorder. Fire-and-forget: never awaited, and a throw is swallowed.
   */
  connectorCalls?: ConnectorCallRecorder;
  /**
   * Scope-local permissions (docs/architecture/scope-local-permissions.md, Phase 2). When
   * on, this host PROJECTS a tenant's roles + tenant-level tuples into its scopes on
   * every tenant-level write, and flips those scopes to evaluate permissions from
   * their own storage — taking the shared control-plane DO off the request hot path.
   * Default off: the RPC path is used and behaviour is exactly as before. Enabling
   * it for existing scopes wants a one-time `reconcileTenantProjection` back-fill.
   */
  scopeLocalPermissions?: boolean;
  /**
   * The live R2 client for per-tenant blob stores (#473) — `createR2BlobStores` with the
   * platform's Cloudflare credential. Same split as `tenantStores`: the ControlPlaneDO
   * keeps the ledger, this client mints. Omitted, `provisionBlobStore` refuses loudly.
   */
  blobStores?: R2BlobStores;
  /**
   * Worker-side reach to the per-tenant attachment bucket (#473): given a tenant, return
   * the `R2Bucket` binding carrying its attachments. Omitted, the host resolves it itself
   * (#1995): `env[blobStoreBindingName(ATTACHMENT_BLOB_BINDING, tenantId)]` off the
   * script's own env — the binding the platform attaches per installed tenant once the push
   * declares the store, which it does for any vertical whose modules declare attachment
   * targets. So a deployed vertical wires nothing, and the tenant is always the one this
   * host has already validated against the scope. Pass this only to point attachments
   * somewhere else (a test's bucket, a host with no such env). Resolving null, the
   * attachment surface refuses loudly rather than serving ungated bytes.
   */
  attachmentBuckets?: (tenantId: string) => unknown | null | Promise<unknown | null>;
  /**
   * The live D1 client for per-tenant relational stores (#301) —
   * `createD1TenantStores` with the platform's Cloudflare credential. Lives on the
   * COORDINATOR like `secretBox`: the ControlPlaneDO keeps the ledger and has never
   * held the credential. Omitted (dev, CP-less verticals, a deployment with no D1
   * credential), `provisionTenantStore`/`openTenantStore` refuse loudly rather than
   * letting a declared `tenantStoreNeed` appear provisioned while no store exists.
   */
  tenantStores?: D1TenantStores;
  /**
   * #574: route a connector's scope write-back (invoke / attachment / grant) to the
   * deployment actually serving the scope. Set only on the shared control plane's
   * host; a vertical's own host (CP-full or CP-less) leaves it unset and executes
   * locally.
   */
  connectorDelegation?: ConnectorDelegation;
  /**
   * #1666: route the schedule kill switch (`revokeFromSystem` / `restoreToSystem`) to the
   * deployment actually serving the scope. Set only on the shared control plane's host,
   * like `connectorDelegation` and for the same reason; a vertical's own host leaves it
   * unset and switches in its own scope DO.
   */
  systemSwitchDelegation?: SystemSwitchDelegation;
  /**
   * #1706: route the peer kill switch (`revokeFromPeer` / `restoreToPeer`) to the deployment
   * actually serving the scope. Set only on the shared control plane's host, exactly like
   * `systemSwitchDelegation` and for the same reason; unset, a scope served elsewhere is
   * refused `unavailable` rather than switched in the placeholder namespace.
   */
  peerSwitchDelegation?: PeerSwitchDelegation;
  /**
   * #1713: deliver a scope's lifecycle to the deployment serving it, after every transition and
   * on the heal sweep (`healLifecycles`). Set only on the shared control plane's host; unset, the
   * directory still moves and nothing is delivered.
   */
  lifecycleDelegation?: LifecycleDelegation;
  /**
   * #1705 PR 3: route the replay lever (`moveImportCursor`) to the deployment actually serving
   * the consumer scope. Set only on the shared control plane's host, like the switches.
   */
  importCursorDelegation?: ImportCursorDelegation;
  /**
   * #1334: route the Tier-2 drain's read and stamp to the deployment actually serving
   * the scope. Set only on the shared control plane's host, exactly like
   * `connectorDelegation` and for the same reason — its own `SCOPE` namespace holds no
   * hosted scope's outbox. A vertical's own host leaves it unset and reads locally.
   */
  eventDrainDelegation?: EventDrainDelegation;
  /**
   * **There is deliberately no `clock` here** (#956), and the absence is the fact.
   *
   * The pure adapter takes one (`SqliteScopeHostOptions.clock`): it is what
   * `ctx.now()` reads AND, since #1160, what the host judges elapsed time
   * against — tuple expiry, session expiry, entitlement expiry, schedule
   * cadence, a migration's `applied_at`. This host cannot offer the same option,
   * and the reason is that the elapsed-time reads split across a boundary an
   * options bag cannot cross:
   *
   *   - **Coordinator-side, and therefore reachable.** `resolveImpersonation`
   *     (`assertSessionUsable(record, new Date()…)`) and `runDueSchedules`
   *     (`const now = Date.now()`, compared against each schedule's cadence) run
   *     in this class. A `clock` option would reach both.
   *   - **DO-local, and therefore not.** `ctx.now()` (`scope-do.ts`, the `at`
   *     read once per invocation), the permission checker's tuple expiry
   *     (`checker.ts`, `now: () => new Date().toISOString()`), `systemScheduleState`,
   *     and the projected-entitlement reads. The ScopeDO is constructed by
   *     **workerd**, not by this class, which only ever holds a stub.
   *
   * So the honest option is not "a clock that works" but "a clock that moves
   * *some* of the host's judgements" — and that is worse than none. It would
   * carry the pure adapter's name and signature while silently disagreeing with
   * it on the one judgement the contract suite tests: a grant lapsing. `never`
   * makes a mistaken `clock:` a compile error rather than that.
   *
   * What this costs, stated rather than hidden: expiry-dependent behaviour is
   * held to the contract on the SQLite host only. `grantExpiryContractSuite`
   * (`packages/contract-tests/src/grant-expiry-suite.ts`) advances a
   * `manualClock` past a grant's `expiresAt` and asserts the denial; it mounts
   * on `adapter-sqlite` and NOT here, and its header carries the same reasoning
   * plus the two alternatives that were rejected. Both hosts run the same
   * predicate (`expires_at IS NULL OR expires_at > ?`); what differs is that on
   * one of them the transition can be reached without waiting for it.
   *
   * The day the ScopeDO can take a clock, this comment and that suite's mount
   * are the whole change.
   */
  clock?: never;
}

/**
 * K-3's refusal of a (tenant, scope) pair the host does not hold — the same answer for a scope that
 * does not exist and for one of another tenant (#1718), in one wording.
 */
const unknownScopeForTenant = (tenantId: string, scopeId: string) =>
  substratError('not_found', `unknown scope for tenant: (${tenantId}, ${scopeId})`);

/**
 * #2016: the line a CP-less host writes each time it admits a pair to a scope with no tenant record
 * and no role rows — nothing to hold the pair against. Ids only.
 */
export const tenantUnrecordedLine = (tenantId: string, scopeId: string) => ({
  substrat: 'tenant-unrecorded' as const,
  level: 'warn' as const,
  tenantId,
  scopeId,
  message: 'admitted to a scope whose tenant is not recorded; a reconcile or lifecycle delivery records it',
});

/**
 * Refuse to mark a scope a copy unless the request classifies it non-primary (#2005). The
 * classification is the platform directory's; the vertical applies the same `isPrimaryScope` to
 * it, so a primary can be marked only by a request that misstates its lineage, never by default.
 */
function assertCopyLineage(lineage: ScopeLineage): void {
  if (isPrimaryScope(lineage)) {
    throw substratError('conflict', 'mark-copy refused: the directory classifies this scope as primary, not as a copy');
  }
}

/**
 * A control-plane stand-in for a CP-less vertical (scope-local-permissions.md Phase 3).
 * The hot path a served scope actually touches becomes trust-the-upstream:
 *   - `scopeAccessRefusal` / `setMigrationState` → no-op: the router gates the scope's
 *     lifecycle + tenancy from the shared directory, and the vertical does not re-read a
 *     directory it does not have. Its own half of both gates reads the scope's storage
 *     instead (`validateScopeAccess`): the tenant the scope was provisioned for (#2016) and the lifecycle
 *     the platform delivered (#1713).
 *   - `tenantHoldsEntitlement` → true: the SKU was enforced on the shared control plane
 *     at provision (before `provisionInstance`), so a scope that EXISTS here was granted
 *     it upstream — a single-vertical deployment holds its own entitlements by construction.
 *   - `recordAdmin` / `recordAccess` → no-op: the shared control plane owns the audit spine.
 * Every other method throws — the admin directory surface genuinely is unavailable.
 */
function nullControlPlane(): ControlPlaneStub {
  const noop = async (): Promise<undefined> => undefined;
  const passthrough: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    scopeAccessRefusal: noop,
    setMigrationState: noop,
    recordAdmin: noop,
    recordAccess: noop,
    tenantHoldsEntitlement: async () => true,
    // #1674, #2029: the switches' record is a DIRECTORY store, and a CP-less host has no
    // directory — the shared control plane that delegates here keeps it. Same posture as
    // `recordAdmin`: nothing to write, nothing recorded to read back.
    recordSwitchedOff: async () => null,
    recordSwitchedOn: async () => null,
    restoreSwitchRecord: noop,
    listSystemSwitches: async () => [],
    switchRecordsOf: async () => [],
    switchRecordStatesOf: async () => [],
    switchesOwedOf: async () => [],
    clearSwitchOwed: noop,
    // #1823: no tenant tuples here either — the platform reads them and sends `tenantHeld`.
    tenantHeldOf: async () => [],
  };
  const unavailable = (method: string) =>
    new Error(
      `control plane unavailable: '${method}' — this host is scope-local / CP-less ` +
        `(docs/architecture/scope-local-permissions.md, Phase 3)`,
    );
  // A directory write through `reply` (#113) is named for the write it carries, not for `reply`.
  passthrough.reply = async (method: unknown) => {
    throw unavailable(String(method));
  };
  return new Proxy({} as ControlPlaneStub, {
    get: (_t, prop) =>
      typeof prop === 'string' && prop in passthrough
        ? passthrough[prop]
        : async () => {
            throw unavailable(String(prop));
          },
  });
}

/**
 * #1819: the ONE object in a deployment's scope namespace that carries the rewind hold (see
 * "the rewind hold" on `CloudflareScopeHost`). A name no `ScopeId` can parse to, so it is
 * never a scope.
 */
export const SWITCH_HOLDS_NAME = 'substrat:switch-holds';

/**
 * #1819: how long one read of the hold serves a sweep pass. The pass reads the whole hold once
 * (it is normally empty) rather than once per scope, so a scope never rewound costs no RPC.
 */
export const SWITCH_HOLD_SNAPSHOT_MS = 2_000;

/**
 * #1819: how long a rewind waits between writing its hold and rewinding. This is what makes the
 * snapshot safe. The pass reads its snapshot only AFTER the scope's own state read, and re-reads
 * one older than `SWITCH_HOLD_SNAPSHOT_MS`. A state read that met rewound storage therefore
 * finished at least this long after the hold was written, so a snapshot taken before the hold
 * is past its age by then and is re-read. Each side measures a duration on its own clock;
 * nothing compares two clocks.
 */
export const SWITCH_HOLD_SETTLE_MS = SWITCH_HOLD_SNAPSHOT_MS + 1_000;

/**
 * #1839: how many times a rewind waits again, after its settle, for a row a late OFF added to its
 * claim to be `SWITCH_HOLD_SETTLE_MS` old. The settle argument above holds per ROW, so a row
 * added during the settle needs its own full settle before the rewind arms. Each late OFF can
 * cost up to one more settle; past this many, the rewind is REFUSED rather than armed with a young
 * row, so a switch flapping through the wait cannot hold a rewind forever. See `settleClaim`.
 */
export const SWITCH_HOLD_EXTRA_WAITS = 3;

/**
 * #1819: how long a claim may stay `pending` before a switch move treats it as armed with no
 * doomed instance. A claim is pending from capture until its rewind armed or refused, which is
 * `SWITCH_HOLD_SETTLE_MS` times at most `1 + SWITCH_HOLD_EXTRA_WAITS`, plus a few calls. One still
 * pending long after that belongs to a rewinding request that died in between, and without this
 * bound its hold could never be released. The age is `held_at`, stamped on the hold object's
 * clock, against the releasing host's clock: minutes, not seconds.
 */
export const SWITCH_HOLD_PENDING_MAX_MS = 5 * 60_000;

/**
 * A move the deployment serving the scope applied, or may have, without attesting what the
 * platform needs from it (#2045 Codex r3): the switch fence (`fenced`), or for a tenant-held
 * module's OFF the evaluator that denies a tenant-level grant (`deniesTenantGrants`, #1823).
 *
 * The preflight (`switchTarget`'s `attestFence`) tells a deployment built before the fence apart
 * before anything is recorded or moved. On such a deployment only an ON is refused: the race the
 * fence closes is an older OFF landing after a newer ON, and with every ON refused there is no
 * newer ON to land after, so an OFF goes through unfenced (#2045 follow-up). A kill switch that
 * cannot be pulled until every vertical is re-pushed is the outage the fence must never cause.
 * An unfenced OFF keeps its write-ahead owed mark, so the first re-assert after the vertical is
 * redeployed moves the scope again under the record's fence.
 *
 * This error fires when a deployment that attested the fence answers a move without it — a
 * rollback to an old build between the preflight and the move — or when an ON reaches a
 * deployment without the fence. It is NOT compensated with an opposite move: an unfenced
 * compensation can undo a newer call's switch (Codex r3, finding 2). The call's record and its
 * write-ahead owed mark stay, and the call is refused.
 */
class UnattestedSwitch extends Error {}

/** A fenced move answered without `fenced`: the deployment predates the fence. */
const unfencedMessage = (scopeId: ScopeId): string =>
  `the deployment serving scope ${scopeId} predates the switch fence (#2045): it cannot refuse an older ` +
  `switch call's OFF landing after this ON, so no switch is turned on there. Switching off still works. ` +
  `Redeploy the vertical, then retry.`;

/** A tenant-held module's OFF answered without `deniesTenantGrants` (#1823). */
const undeniedMessage = (scopeId: ScopeId, moduleId: string): string =>
  `the deployment serving scope ${scopeId} predates the kill switch's tenant-grant denial (#1823): ` +
  `module '${moduleId}' holds a tenant-level grant that its OFF would leave authorizing there. ` +
  `Redeploy the vertical, then retry.`;

/**
 * The attachment bucket a host resolves when it was handed no resolver (#1995): the
 * platform's per-tenant binding, read off this script's own env, named by the one shared
 * encoding (`blobStoreBindingName`) for the tenant the caller passed in.
 */
function ambientAttachmentBucket(tenantId: string): unknown {
  return (ambientEnv as unknown as Record<string, unknown>)[blobStoreBindingName(ATTACHMENT_BLOB_BINDING, tenantId)] ?? null;
}

/**
 * #1834: what a door's gate read: the subject's state, the instance, the hold. A module's (the
 * system door) or, since #2029, a peer vertical's (the peer door).
 */
interface SubjectDoorGate {
  state: SystemScheduleState;
  /** The scope instance that answered the state read; every call through the door is pinned to it. */
  instance: string;
  /** The rewind hold keeps the subject off (#1819). Not consulted for a subject already `off`. */
  held: boolean;
  /** The hold could not be read; the gate failed open, as `switchHeld` documents. */
  error?: string;
}

/**
 * #1834: an opened door. `through` runs one call gated and pinned (`openDoor`). `kind` and `key`
 * name the subject: a module (`system`, the system door) or a peer vertical (`peer`, #2029).
 */
interface SubjectDoor {
  kind: SwitchKind;
  key: string;
  /** `call` answers the DO's `SystemDoorMoved` when the pin missed; anything else is its answer. */
  through<T>(call: (instance: string) => Promise<T | SystemDoorMoved>): Promise<T>;
}

/**
 * #2029: scope instances whose door has read the rewind hold and found NO claim on the scope at
 * all, so their doors skip the hold read for the rest of the instance's life. Isolate-wide, because
 * a host lives for one request: without it, every peer call would read the deployment's one hold
 * object — an extra hop, on a single object, on the hot path of every scope never rewound.
 *
 * Safe because claims are only ever added for storage a LATER instance serves. A rewind writes its
 * claim before it arms, and arming restarts the scope, so its rewound storage is always served by a
 * new instance with a new id, which reads the hold afresh (`SWITCH_HOLD_SETTLE_MS` puts every row of
 * the claim before that instance existed). A join (`switchHoldJoin`) goes into a rewind's claim too,
 * so into that same later instance. An instance that read no claim therefore never gains one; claims
 * only leave it, by a switch move. Only a GOOD read is remembered: a read that failed open is not.
 * Bounded: past `CLEAR_SCOPE_INSTANCES_MAX` it is emptied, which costs a re-read, nothing else.
 */
const CLEAR_SCOPE_INSTANCES = new Set<string>();
const CLEAR_SCOPE_INSTANCES_MAX = 10_000;
const rememberClearInstance = (key: string): void => {
  if (CLEAR_SCOPE_INSTANCES.size >= CLEAR_SCOPE_INSTANCES_MAX) CLEAR_SCOPE_INSTANCES.clear();
  CLEAR_SCOPE_INSTANCES.add(key);
};

/**
 * #2045: a carry's fences, by tuple subject (`RecordedOffCarry.fences`): for each recorded-off
 * subject, the operation id of the call the record holds.
 */
const switchFencesCarried = (
  kinds: [SwitchKind, { keys: readonly string[]; fences: ReadonlyMap<string, string> }][],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [kind, { keys, fences }] of kinds) {
    for (const key of keys) {
      const fence = fences.get(key);
      if (fence !== undefined) out[switchSubjectOf(kind, key)] = fence;
    }
  }
  return out;
};

/** #2029: how a door's refusals and a re-assert's name each kind of subject. */
const DOOR_WORDS = {
  system: { what: (key: string) => `module '${key}'`, door: 'system door', switchName: 'schedule', switched: 'schedules' },
  peer: { what: (key: string) => `peer vertical '${key}'`, door: 'peer door', switchName: 'peer', switched: 'peers' },
} as const satisfies Record<SwitchKind, { what(key: string): string; door: string; switchName: string; switched: string }>;

/** #2029: the rewind hold's key for one subject — a module's id, bare as #1819 stored it, or `vertical:<slug>`. */
const holdKeyOf = (kind: SwitchKind, key: string): string => (kind === 'system' ? key : peerSubjectRef(key));

/** #1819: one rewind's claim on one held module, as the hold object stores it. */
export interface SwitchHoldClaim {
  claimId: string;
  moduleId: string;
  /** `pending` from capture until the rewind armed; `armed` once it did (or may have). */
  state: 'pending' | 'armed';
  /** The scope instance the rewind armed, whose writes the restart discards; null if none. */
  doomed: string | null;
  heldAt: string;
}

export class CloudflareScopeHost implements ScopeHost {
  readonly admin: HostAdmin;

  private readonly scopeNs: DurableObjectNamespace;
  private readonly cp: ControlPlaneStub;
  private readonly servicePrincipals: CloudflareScopeHostOptions['servicePrincipals'];

  /** No control plane bound — `this.cp` is the throwing null object (Phase 3, CP-less). */
  private readonly cpLess: boolean;
  /** Project + evaluate permissions scope-locally (scope-local-permissions.md). */
  private readonly scopeLocalPermissions: boolean;

  // Registration-mechanics bookkeeping (validation only — the DO executes).
  // Code-time, derived from the bundled modules, NOT durable directory state.
  private readonly moduleIds = new Set<string>();
  /**
   * #1705: this deployment's cross-vertical declarations. The DO holds the handlers and makes
   * every decision. The coordinator keeps its own copy for two reasons: registration refuses
   * bad wiring at the same point as the pure host, and `importState` can answer "imports
   * nothing" without waking a DO.
   */
  private readonly crossVertical = new CrossVerticalRegistry();
  /** Module id → its declared recurring schedules (#383), for `registeredSchedules`/`runDueSchedules`. */
  private readonly moduleSchedules = new Map<string, ScheduleSpec[]>();
  /** #1706: every registered module's `peers`, as declared — read as one union per peer. */
  private readonly peerSources: { peers?: readonly PeerSpec[] }[] = [];
  /** #1232: declared freshness per module. Registered UNCONDITIONALLY — the schedule
   *  map is only populated for modules WITH schedules, and hanging freshness off it
   *  would drop a freshness-only module at registration. */
  private readonly moduleFreshness = new Map<string, FreshnessSpec[]>();
  /** Registered (module, version) pairs — the frontier `schemaVersion` counts toward (§5.3, #49). */
  private migrationTotal = 0;
  private readonly operations = new Set<string>();
  private readonly predicateNames = new Map<string, string>(); // name → module
  /** Executor id → {eventType, handler} (K-22 §4.2). Coordinator-side, not in the DO. */
  private readonly secretBox: SecretBox;
  private readonly fetchImpl: FetchLike;
  private readonly connectorCalls: ConnectorCallRecorder;
  /** The live D1 client for per-tenant stores (#301); undefined ⇒ refuse loudly. */
  private readonly tenantStores?: D1TenantStores;
  /** The live R2 client for per-tenant blob stores (#473); undefined ⇒ refuse loudly. */
  private readonly blobStores?: R2BlobStores;
  /** Worker-side attachment-bucket resolver (#473); the ambient per-tenant binding unless overridden (#1995). */
  private readonly attachmentBuckets: (tenantId: string) => unknown | null | Promise<unknown | null>;
  /** The parsers attachment text is extracted with (K-43); the host's own, never imported here. */
  private readonly attachmentExtractors: readonly AttachmentExtractor[];
  private readonly attachmentTextBounds: AttachmentTextBounds;
  private readonly executors = new Map<string, RegisteredEffector>();
  /**
   * `<moduleId>/<job>` → the pass body and its default step policy (#1577). Host
   * code like `executors`, and keyed the way a run row is: the coalescing key's
   * first two thirds, so a run read off the DO finds its handler by the columns it
   * already carries. The HANDLER stays on the coordinator — it holds credentials
   * and calls the internet, which is why the DO never sees it.
   */
  private readonly jobs = new Map<string, JobRegistration>();
  /**
   * The event an executor is effecting, stamped onto the admin rows it writes (K-22). Like
   * `onBehalfOf`, only ever set on a VIEW (`causedByView`, or `attributed` with a
   * `causedBy`), never on the host: a field set around the handler's `await` stamped every
   * admin call the host served meanwhile — a staff call included — with that event (#2055).
   */
  private readonly causedBy: string | null = null;
  /**
   * The person the actor acted for (#977). Never set on the host itself: only an
   * `attributed(…)` view answers it, so it cannot leak between requests.
   */
  private readonly onBehalfOf: OnBehalfOf | null = null;
  private readonly withdrawn = new Map<string, string>(); // operation → module
  /** Operation → who binds it (module, SKU flag, its declared schedules) — the §4.3 gate's
   *  input, resolved per invoke by the kernel's `requiredEntitlementFor` (#1654). */
  private readonly operationEntitlement = new Map<string, OperationEntitlement>();
  /** #574: remote connector write-back for scopes served by another deployment. */
  private readonly connectorDelegation?: ConnectorDelegation;
  /** #1334: the Tier-2 drain's reach into the deployment serving a scope. */
  private readonly eventDrainDelegation?: EventDrainDelegation;
  /** #1666: the schedule kill switch's reach into the deployment serving a scope. */
  private readonly systemSwitchDelegation?: SystemSwitchDelegation;
  /** #1713: the lifecycle's reach into the deployment serving a scope. */
  private readonly lifecycleDelegation?: LifecycleDelegation;
  /** #1706: the peer kill switch's reach into the deployment serving a scope. */
  private readonly peerSwitchDelegation?: PeerSwitchDelegation;
  /** #1705 PR 3: the replay lever's reach into the deployment serving a consumer scope. */
  private readonly importCursorDelegation?: ImportCursorDelegation;
  /**
   * #1819: the last read of the rewind hold, and when it was taken (before the read went out).
   * Per instance, so per pass: the host is built per request, and never outlives one.
   */
  private holdSnapshot: { at: number; held: Set<string>; scopes: Set<string>; good: boolean } | null = null;
  /**
   * #1819: the hold read in flight, and when it went out. The sweepers run up to eight scopes
   * at once on one host, and each can find the snapshot missing or old at the same moment; they
   * join this one read rather than each sending their own.
   */
  private holdRefresh: { at: number; done: Promise<{ error?: string }> } | null = null;

  /**
   * MUST be constructed per request. Never cache an instance across requests.
   *
   * The stub below is a Durable Object stub, which is an I/O object owned by the
   * request that created it — reusing one throws "Cannot perform I/O on behalf of a
   * different request". Every worker in this repo rebuilds the host per request
   * (`hostFor(env)`), which is what makes this safe, and it is the only thing that
   * does. The router learned this the expensive way: it memoised a resolver that
   * closed over a stub, the first request after each cold start succeeded, and every
   * request after that returned 1101 in production.
   */
  constructor(options: CloudflareScopeHostOptions) {
    this.servicePrincipals = options.servicePrincipals;
    this.secretBox = options.secretBox ?? unconfiguredSecretBox;
    this.tenantStores = options.tenantStores;
    this.blobStores = options.blobStores;
    this.attachmentBuckets = options.attachmentBuckets ?? ambientAttachmentBucket;
    assertAttachmentExtractors(options.attachmentExtractors ?? []);
    this.attachmentExtractors = options.attachmentExtractors ?? [];
    this.attachmentTextBounds = resolveAttachmentTextBounds(options.attachmentTextBounds);
    this.fetchImpl = options.fetch ?? globalFetch;
    this.connectorCalls = options.connectorCalls ?? noopConnectorCallRecorder;
    this.scopeLocalPermissions = options.scopeLocalPermissions ?? false;
    this.scopeNs = options.scope;
    this.cpLess = !options.controlPlane;
    this.cp = options.controlPlane
      ? (options.controlPlane.get(options.controlPlane.idFromName('control-plane')) as unknown as ControlPlaneStub)
      : nullControlPlane();
    this.connectorDelegation = options.connectorDelegation;
    this.eventDrainDelegation = options.eventDrainDelegation;
    this.systemSwitchDelegation = options.systemSwitchDelegation;
    this.lifecycleDelegation = options.lifecycleDelegation;
    this.peerSwitchDelegation = options.peerSwitchDelegation;
    this.importCursorDelegation = options.importCursorDelegation;
    this.admin = this.buildAdmin();
  }

  // -- registration mechanics (validation only) -----------------------------

  registerExecutor(
    id: string,
    eventType: string,
    handler: ExecutorHandler,
    retry?: ExecutorRetryPolicy,
  ): void {
    if (this.executors.has(id)) throw new Error(`executor '${id}' is already registered`);
    this.executors.set(id, {
      kind: 'executor',
      eventType,
      handler,
      retry: resolveRetryPolicy(retry),
    });
  }

  registerConnector(
    id: string,
    eventType: string,
    handler: ConnectorHandler,
    options?: ConnectorOptions,
  ): void {
    if (this.executors.has(id)) throw new Error(`executor '${id}' is already registered`);
    this.executors.set(id, {
      kind: 'connector',
      eventType,
      handler,
      retry: resolveRetryPolicy(options),
      timeoutMs: options?.timeoutMs ?? 30_000,
      provider: options?.provider ?? id,
    });
  }


  /**
   * Build the context a connector runs with. Tenant and vertical are AMBIENT —
   * taken from the event's scope, never from an argument — so a connector cannot
   * reach a credential another vertical connected even by accident.
   */
  private async connectorContext(
    tenantId: TenantId,
    scopeId: ScopeId,
    timeoutMs: number,
    /** The delivery this context is FOR (#726) — the dispatch capability's whole basis. */
    eventId: string,
  ): Promise<ConnectorContext> {
    const scope = await this.cp.getScopeRecord(tenantId, scopeId);
    const vertical = scope?.vertical ?? null;
    const admin = this.admin;
    const fetchImpl = this.fetchImpl;
    return {
      admin,
      tenantId,
      scopeId,
      vertical: vertical ?? '',
      connection: async (provider: string) => {
        if (!vertical) {
          throw new Error(
            `scope ${scopeId} is bound to no vertical, so it has no connection namespace — ` +
              `provision it with a vertical before using connectors`,
          );
        }
        const open = await admin.openConnection(tenantId, vertical, provider);
        if (!open) {
          throw new Error(
            `no live '${provider}' connection for tenant ${tenantId} / vertical '${vertical}'`,
          );
        }
        return {
          ...open,
          // The outbound read (#711), on THIS connection — authorized as the
          // credential the handler actually opened, so it cannot drift from it.
          //
          // No reentrancy hazard here: a connector runs on the COORDINATOR, never
          // inside the ScopeDO, so this is an ordinary RPC. What it does need is the
          // delegated read verb when the serving deployment is elsewhere (#574) —
          // the control plane holds the directory and the credential but not the
          // vertical's R2, so the bytes come back over the seam.
          // #726 gap 1: this connection's live grants IN THIS SCOPE, so a connector can
          // assert its preconditions at the top of a dispatch rather than meeting a
          // missing grant as a refusal several calls later.
          grants: async () =>
            (await this.connectionGrantsInScope(tenantId, scopeId))
              .filter((g) => g.connectionId === open.id)
              .map((g) => g.permission),
          openAttachment: (attachmentId: string) =>
            this.getConnectorAttachments(open.id, scopeId, { eventId }).then((a) =>
              a.open(attachmentId),
            ),
          // #687: open a cell the scope sealed TO this connection. The keyId-indexed
          // map goes in, never out — a connector receives the plaintext of one cell,
          // not a private key it could mislay. Retired keys are in the map too, so a
          // request pending across a rotation still opens.
          unseal: async (sealed) => openSealed(await this.openSealingKeys(open.id), sealed),
          fetch: async (input, init) => {
            // #1691: timed where the call is made, so the data point carries a duration.
            const started = Date.now();
            try {
              const res = await fetchImpl(input, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs),
              });
              await admin.recordConnectionUse(
                open.id,
                settleConnectionUse(provider, Date.now() - started, { response: res }),
              );
              return res;
            } catch (err) {
              await admin.recordConnectionUse(
                open.id,
                settleConnectionUse(provider, Date.now() - started, { error: err }),
              );
              throw err;
            }
          },
        };
      },
    };
  }

  /**
   * #1184: the scope reads an executor's handler may make. Plain RPCs to the ScopeDO: the
   * handler runs here on the coordinator, after the DO's own task has returned.
   */
  private executorScope(tenantId: TenantId, scopeId: ScopeId): ExecutorScope {
    const stub = this.scopeStub(scopeId);
    return {
      history: async (entity, page) =>
        stub.entityHistory({ entityType: entity.entityType, entityId: entity.entityId, limit: page?.limit, cursor: page?.cursor }),
      covers: async (principal, roleKey, level) => {
        const bound = await stub.canAssignFor(tenantId, scopeId, principalId.parse(principal), roleKey, level === 'tenant');
        if (!bound) throw unknownRoleError(roleKey);
        return coverage.parse(bound);
      },
    };
  }

  /**
   * Drain this scope's outbox into the registered executors (K-22 §4.2).
   *
   * Runs on the coordinator because executors act through `HostAdmin`, which the
   * ScopeDO cannot reach. Prompt: called inline after the operation returns, so the
   * common case completes inside the request.
   *
   * **Failure is contained here (#100).** A throwing handler used to escape
   * `invoke()` after the scope had already committed, reporting an error for work
   * that succeeded. It now records a failed attempt, backs off, dead-letters at
   * `maxAttempts`, and isolates each event and each executor so one poison
   * delivery cannot wedge the ones behind it. At-least-once still requires
   * idempotent handlers.
   */
  private async drainExecutors(
    tenantId: TenantId,
    scopeId: ScopeId,
    /**
     * #1525: the call this drain pass is running in, or null.
     *
     * The coordinator is the ONLY side that knows. Executors run here, not in the DO,
     * so by the time the journal RPC arrives the DO's queued body has returned and its
     * own `invocationId` field reads null — an ambient read there would record "no
     * call" for every attempt an operation's own tail made.
     */
    invocationId: string | null,
    /** #1184: what each attempt did, for the emitting call's `onExecutorOutcomes`. */
    outcomes?: ExecutorOutcome[],
  ): Promise<ExecutorDrainReport> {
    const report: ExecutorDrainReport = {
      attempted: 0,
      delivered: 0,
      retrying: 0,
      deadLettered: 0,
      routedToPlatform: 0,
    };
    if (this.executors.size === 0) return report;
    // #1901: one line per attempt, capped per pass. Written on the coordinator, where the
    // attempt runs — the DO only journals it.
    const lines = asyncLinePass();
    try {
      await this.drainExecutorsPass(tenantId, scopeId, invocationId, report, lines, outcomes);
    } finally {
      lines.end();
    }
    return report;
  }

  private async drainExecutorsPass(
    tenantId: TenantId,
    scopeId: ScopeId,
    invocationId: string | null,
    report: ExecutorDrainReport,
    lines: AsyncLinePass,
    outcomes: ExecutorOutcome[] | undefined,
  ): Promise<void> {
    const stub = this.scopeStub(scopeId);
    const scope = this.executorScope(tenantId, scopeId);
    // #2005: a non-primary scope (a fork, a snapshot, a preview of either kind) causes no
    // outbound effects, so its deliveries are journaled terminal with the reason and no
    // handler runs (`isInertScope`). Asked on the first due event, once per pass: most passes
    // have none, and the directory is one global object.
    let inert: Promise<boolean> | undefined;
    const isInert = (): Promise<boolean> => (inert ??= this.isInertScope(tenantId, scopeId));
    // #1713: a CP-less scope its lifecycle holds attempts nothing and journals nothing, so every
    // due delivery stays due for the first pass after it is live again. Asked on the first due
    // event, like `isInert`. Every caller passed `assertLive` already, so this is for the scope
    // suspended between that gate and the drain: a request in flight, whose write commits while
    // its effect waits. A host with a directory answers false without a read.
    let held: Promise<boolean> | undefined;
    const isHeld = (): Promise<boolean> => (held ??= this.lifecycleHeld(scopeId));
    drain: for (const [id, executor] of this.executors) {
      const deliveryId = `executor:${id}`;
      const { events, undecodable } = await stub.pendingExecutorDeliveries(deliveryId, executor.eventType);
      // #1636: an event the DO could not decode is dead-lettered for this executor at once,
      // and its handler never sees it. Terminal on the FIRST failure, unlike a handler's:
      // the decode is pure, so a retry cannot succeed. The rows behind it are delivered
      // below — the decode used to throw the whole list, on every pass.
      if ((undecodable.length > 0 || events.length > 0) && (await isHeld())) {
        report.lifecycleHeld = true;
        break drain;
      }
      // #1901: an attempt's line. The attempt number is the one the journal is about to record.
      const unitOf = (eventId: string, attempt: number) => ({
        kind: 'consumer' as const,
        tenantId,
        scopeId,
        invocationId: asyncInvocationId(invocationId),
        operation: deliveryId,
        eventType: executor.eventType,
        eventId,
        attempt,
        startedAt: Date.now(),
      });
      const outcomeOf = (event: DomainEvent, outcome: ExecutorOutcome['outcome'], error?: unknown): void => {
        outcomes?.push(executorOutcomeOf(id, event, outcome, error));
      };
      for (const bad of undecodable) {
        report.attempted += 1;
        const attempt = await stub.recordExecutorAttempt(bad.eventId, deliveryId, bad.error, null, invocationId);
        report.deadLettered += 1;
        lines.write({ ...unitOf(bad.eventId, attempt), outcome: 'dead-lettered' });
      }
      for (const event of events) {
        report.attempted += 1;
        const startedAt = Date.now();
        if (await isInert()) {
          // No next attempt, like an undecodable row: a scope does not become primary.
          const attempt = await stub.recordExecutorAttempt(event.id, deliveryId, INERT_SCOPE_REASON, null, invocationId);
          report.inert = (report.inert ?? 0) + 1;
          outcomeOf(event, 'inert', INERT_SCOPE_REASON);
          // Its own outcome, never `delivered`: no handler ran (#2005).
          lines.write({ ...unitOf(event.id, attempt), startedAt, outcome: 'inert' });
          continue;
        }
        // #2055: the handler writes through a view bound to its event, never through the host.
        const caused = this.causedByView(event.id);
        try {
          if (executor.kind === 'connector' && this.cpLess) {
            // #574 phase 3: this host cannot run a connector — no connection
            // directory, no credentials, no sanctioned egress. Route the delivery
            // onto the platform-requests surface instead: the DO enqueues the
            // `connector:<provider>` intent and journals the delivery as routed in
            // one atomic verb, and the platform's drain executes the handler with
            // the authority this host lacks. The intent row carries the retry
            // state from here on; the handler's own idempotency ledger absorbs
            // the at-least-once residue, as it already must in-process.
            await stub.routeExecutorEventToPlatform(
              event.id,
              deliveryId,
              connectorDispatchKind(executor.provider),
              JSON.stringify({ executorId: id, event } satisfies ConnectorDispatchPayload),
              JSON.stringify({ system: 'connector-dispatch' }),
              invocationId,
            );
            report.routedToPlatform! += 1;
            outcomeOf(event, 'routed');
            // Handed on, not run here: the platform's drain owns its attempts from now on.
            lines.write({ ...unitOf(event.id, 1), startedAt, outcome: 'routed' });
          } else if (executor.kind === 'connector') {
            await executor.handler(
              await caused.connectorContext(tenantId, scopeId, executor.timeoutMs, event.id),
              event,
            );
            const attempt = await stub.recordExecutorAttempt(event.id, deliveryId, null, null, invocationId);
            report.delivered += 1;
            outcomeOf(event, 'delivered');
            lines.write({ ...unitOf(event.id, attempt), startedAt, outcome: 'delivered' });
          } else {
            const result = await executor.handler(caused.admin, event, scope);
            // #1184: a refusal is the handler's own terminal decision — journaled with its
            // reason, no next attempt, listed by `executorDeadLetters` beside an exhausted one.
            const refused = isDeliveryRefusal(result) ? result : null;
            const text = refused && refusalJournalText(refused);
            const attempt = await stub.recordExecutorAttempt(event.id, deliveryId, text, null, invocationId);
            if (refused) {
              report.deadLettered += 1;
              outcomeOf(event, 'refused', refused.reason);
              lines.write({ ...unitOf(event.id, attempt), startedAt, outcome: 'dead-lettered', error: text });
            } else {
              report.delivered += 1;
              outcomeOf(event, 'delivered');
              lines.write({ ...unitOf(event.id, attempt), startedAt, outcome: 'delivered' });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
          // The DO owns the attempt count; the coordinator owns the policy, so it
          // reads the count to decide whether this attempt was the last.
          const prior = await stub.executorAttempts(event.id, deliveryId);
          const attempts = prior + 1;
          const exhausted = attempts >= executor.retry.maxAttempts;
          await stub.recordExecutorAttempt(
            event.id,
            deliveryId,
            message,
            exhausted ? null : backoffAt(attempts, executor.retry, new Date()),
            invocationId,
          );
          if (exhausted) report.deadLettered += 1;
          else report.retrying += 1;
          outcomeOf(event, exhausted ? 'dead-lettered' : 'retrying', err);
          lines.write({
            ...unitOf(event.id, attempts),
            startedAt,
            outcome: exhausted ? 'dead-lettered' : 'retrying',
            error: err,
          });
        }
      }
    }
  }

  async drainDue(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDrainReport> {
    // Same lifecycle gate `getScope` applies (K-3): a suspended or archived scope
    // does not get its effects driven either.
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    // #1525: null, and honestly so — a sweep is not a call. An attempt this pass makes
    // records no invocation, which is what distinguishes it from the first attempt the
    // emitting operation's own tail made.
    return this.drainExecutors(tenantId, scopeId, null);
  }

  registerJob(
    moduleId: ModuleId,
    name: string,
    handler: JobHandler,
    retry?: ExecutorRetryPolicy,
    options?: { leaseMs?: number },
  ): void {
    // #1575: the kernel's own jobs are dispatched before this registry is read.
    assertJobRegistrable(moduleId, name);
    assertLeaseMs(options?.leaseMs);
    const key = `${moduleId}/${name}`;
    if (this.jobs.has(key)) throw new Error(`job '${key}' is already registered`);
    this.jobs.set(key, { handler, retry, leaseMs: options?.leaseMs });
  }

  /**
   * D-14's DURABLE driver: the run store is RPC to the scope DO, and nothing else.
   *
   * The pass engine stays on the coordinator — it is the same kernel code the pure
   * adapter runs, so the two drivers cannot disagree about when a step is skipped or
   * when a run fails. What crosses into the DO is a row read and a row write, which
   * is also the only part that has to be durable.
   *
   * Every step costs a round trip, deliberately. Batching a pass's steps into one
   * write at the end would be cheaper and would lose exactly the work an eviction
   * mid-pass is supposed to keep — and a DO is evicted and revived constantly.
   */
  private jobStore(scopeId: ScopeId): JobRunStore {
    const stub = this.scopeStub(scopeId);
    return {
      startOrJoin: (key, row) => stub.jobRunStartOrJoin(key.moduleId, key.job, key.instance, row),
      dueKeys: (now, max) => stub.jobRunsDueKeys(now, max),
      claim: (id, owner, leaseMs) => stub.jobRunClaim(id, owner, leaseMs),
      begin: (id, owner, marginMs) => stub.jobRunBegin(id, owner, marginMs),
      miss: (id, owner, note) => stub.jobRunMiss(id, owner, note),
      list: (filter) => stub.jobRunList(filter),
      patch: (id, patch, owner) => stub.jobRunPatch(id, patch, owner),
      commitPass: (id, patch, owner) => stub.jobCommitPass(id, patch, owner),
      beginStep: (runId, name, owner, leaseMs) => stub.jobStepBegin(runId, name, owner, leaseMs),
      recordStep: (runId, name, result, attempts, lastError, at, owner, leaseMs) =>
        stub.jobStepRecord(runId, name, result, attempts, lastError, at, owner, leaseMs),
    };
  }

  /**
   * The extraction job's adapter half (#1575). The record and the outcome are RPCs to the
   * scope DO; the bytes are read here, where the per-tenant bucket is bound — the DO never
   * holds them. No permission gate on any of it: extraction is the kernel's own derivation,
   * and the person-facing gate is at search.
   */
  private attachmentTextHandler(tenantId: TenantId, scopeId: ScopeId): JobHandler {
    const stub = this.scopeStub(scopeId);
    return attachmentTextJob(
      {
        record: (attachmentId) => stub.attachmentTextSource(attachmentId),
        bytes: async (record) =>
          (await (await this.resolveAttachmentStore(tenantId)).get(attachmentBlobKey(scopeId, record.id)))?.body ??
          null,
        write: (attachmentId, outcome: ExtractionOutcome) => stub.attachmentTextRecord(attachmentId, outcome),
      },
      // K-43: the host's parsers, handed in — this adapter imports none.
      this.attachmentExtractors,
      this.attachmentTextBounds,
    );
  }

  async startJobRun(
    tenantId: TenantId,
    scopeId: ScopeId,
    input: StartJobRunInput,
  ): Promise<JobRun> {
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return jobRunOf(
      await startJobRun(this.jobStore(scopeId), input, ulid, () => new Date().toISOString()),
    );
  }

  async runDueJobs(
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: { maxPasses?: number; limit?: number },
  ): Promise<JobDriveReport> {
    // Same lifecycle gate as `drainDue`: a suspended scope's runs wait rather than
    // advance, and an archived one's never move again.
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    // #1575: the kernel's extraction jobs are this host's own, bound to this scope — no
    // deployment registers them, and none can shadow them. The backfill starts here, on
    // the drive, so a scope's first request never pays for attachments that predate it.
    const stub = this.scopeStub(scopeId);
    await stub.attachmentTextBackfillStart();
    const kernelJobs = {
      [ATTACHMENT_TEXT_JOB]: this.attachmentTextHandler(tenantId, scopeId),
      [ATTACHMENT_TEXT_BACKFILL_JOB]: attachmentTextBackfillJob({ queueBatch: (after) => stub.attachmentTextBackfillBatch(after) }),
    };
    return runDueJobRuns({
      store: this.jobStore(scopeId),
      handlerFor: (run) => kernelJobFor(run, kernelJobs) ?? this.jobs.get(`${run.module_id}/${run.job}`),
      now: () => new Date().toISOString(),
      // #1834: the door is opened FOR this pass, so its "not now" is tied to this pass alone.
      openScope: async (run, pass) =>
        this.buildStub(tenantId, scopeId, undefined, undefined,
          await this.openSystemDoor(run.module_id as ModuleId, tenantId, scopeId, undefined, pass)),
      // #1834: only this host's own door refusals defer a pass, recognised by identity.
      deferral: (err, pass) => this.takeDoorWait(err, pass),
      maxPasses: options?.maxPasses,
      limit: options?.limit,
    });
  }

  async jobRuns(tenantId: TenantId, scopeId: ScopeId, filter?: JobRunFilter): Promise<JobRun[]> {
    await this.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return (await this.jobStore(scopeId).list(filter ?? {})).map(jobRunOf);
  }

  async dispatchConnector(
    tenantId: TenantId,
    scopeId: ScopeId,
    handler: ConnectorHandler,
    event: DomainEvent,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    // The platform half of a routed delivery (#574 phase 3). The same lifecycle gate as
    // `drainDue` — a suspended scope's routed intent waits, it does not execute — and the
    // same context build as the in-process path, so the handler cannot tell which host
    // ran it. On a CP-less host `connectorContext` throws from the null control plane:
    // fail closed, exactly the hole routing exists to avoid.
    await this.assertLive(tenantId, scopeId);
    // Built on a view bound to the event, so its admin rows carry it and nothing else the
    // host serves does (#2055).
    await handler(
      await this.causedByView(event.id).connectorContext(tenantId, scopeId, options?.timeoutMs ?? 30_000, event.id),
      event,
    );
  }

  async executorDeadLetters(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDeadLetter[]> {
    await this.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return this.scopeStub(scopeId).executorDeadLetters();
  }

  /**
   * #1232: hand one pass's schedule outcomes to the scope's own intent journal —
   * the CP-less deployment's only road to `_substrat_sweep_runs`. Null = the
   * journal is full and the report was deliberately dropped, never queued late.
   */
  async enqueueSweepRuns(scopeId: ScopeId, payload: SweepRunsPayload): Promise<PlatformRequestId | null> {
    return this.scopeStub(scopeId).enqueueSweepRuns(
      JSON.stringify(sweepRunsPayload.parse(payload)),
      JSON.stringify({ system: 'scope-sweeper' }),
    );
  }

  async listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]> {
    await this.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    // Tolerant (#1588): one undecodable row comes back naming why, never throws for the list.
    return (await this.scopeStub(scopeId).pendingPlatformRequests()).map(platformRequestOf);
  }

  async listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]> {
    await this.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return (await this.scopeStub(scopeId).platformRequestHistory(filter)).map(platformRequestOf);
  }

  async settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: {
      status: PlatformRequestStatus;
      result?: unknown;
      lastError?: string | null;
      failure?: PlatformRequestFailure | null;
    },
  ): Promise<void> {
    await this.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    await this.scopeStub(scopeId).settlePlatformRequest(
      id,
      outcome.status,
      outcome.result === undefined ? null : JSON.stringify(outcome.result),
      outcome.lastError ?? null,
      outcome.failure == null ? null : JSON.stringify(outcome.failure),
    );
  }

  migrationFrontier(): MigrationFrontier {
    return { total: this.migrationTotal };
  }

  /**
   * The reconciliation sweep's wake + retry (kernel-design §5.3, #49).
   *
   * Reaches the DO through `retryMigrations`, NOT `migrate`: the DO memoises
   * its migration promise, so a warm instance that failed once returns the
   * cached rejection to `migrate()` forever — the retry RPC clears that latch
   * and makes a fresh attempt (already-journaled versions are skipped, so it
   * can never double-apply). The directory recording mirrors
   * `migrateAndRecord`, with one deliberate difference: a `null` from the DO
   * (nothing pending here) writes NOTHING — this host may not run the scope's
   * modules at all (the control plane sweeping verticals' scopes), and a
   * foreign host must never clear a failure recorded by the deployment that
   * owns it.
   *
   * NOT `validateScopeAccess`: that gate refuses `provisioning`, and a scope
   * stuck in provisioning on a failed migration is precisely a sweep target.
   * Requires a control plane (the CP-less host trusts its router for lifecycle
   * and has no directory to read a status from).
   */
  async migrateScope(tenantId: TenantId, scopeId: ScopeId): Promise<MigrateScopeOutcome> {
    const rec = await this.cp.getScopeRecord(tenantId, scopeId);
    // K-3: a scope under another tenant is indistinguishable from one that does not exist.
    if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
    if (rec.status !== 'active' && rec.status !== 'provisioning') {
      throw substratError('conflict', `scope not migratable (status: ${rec.status}): ${scopeId}`);
    }
    const stub = this.scopeStub(scopeId);
    try {
      const applied = await stub.retryMigrations();
      if (applied === null) return { status: 'noop' };
      await this.cp.setMigrationState(scopeId, String(applied), null);
      return { status: 'migrated', schemaVersion: String(applied) };
    } catch (err) {
      // Best-effort read-back, as in migrateAndRecord: a scope broken enough to
      // fail may be broken enough not to answer, and the recorder must not
      // replace the migration error with its own.
      let failure: { version: string; error: string; applied: number } | null = null;
      try {
        failure = await stub.migrationFailure();
      } catch {
        // deliberately swallowed — the rethrow below carries the real signal
      }
      if (!failure) throw err;
      await this.cp.setMigrationState(scopeId, String(failure.applied), {
        version: failure.version,
        error: failure.error,
      });
      return { status: 'failed', failure: { version: failure.version, error: failure.error } };
    }
  }

  /**
   * Read-only introspection of a scope's OWN database, reaching the scope DO directly
   * (kernel-design §5.4's admin-query RPC). Unlike `admin.listScopeTables`, this does
   * NOT consult the control-plane directory — so it works in a **CP-less vertical**, the
   * deployment that actually holds the scope's data (its ScopeDO runs the modules). The
   * vertical's platform-gated `/internal/tables` route calls it; authorization is that
   * gate (the caller is the control plane, which did the K-3 check + audit on its side).
   */
  async introspectScopeTables(scopeId: ScopeId): Promise<ScopeTable[]> {
    return this.scopeStub(scopeId).introspectTables();
  }

  async introspectScopeTable(scopeId: ScopeId, input: ReadScopeTableInput): Promise<ScopeTablePage> {
    return unwrapReply(await this.scopeStub(scopeId).introspectTableReply(input.table, input.limit, input.offset));
  }

  /** The SQL console's CP-less path (#219) — same trust line as the pair above. */
  async introspectScopeQuery(scopeId: ScopeId, input: QueryScopeInput): Promise<ScopeQueryResult> {
    return unwrapReply(await this.scopeStub(scopeId).introspectQueryReply(input.sql));
  }

  /**
   * The K-35 denial log's CP-less path (#867) — same trust line as the reads above.
   * The rows live in the scope's own DO, in the vertical's deployment, so a hosted
   * scope's denials are reachable only through the vertical's platform-gated
   * `/internal/denials` routes; the K-3 check and the K-24 audit entry are the control
   * plane's, made before it calls.
   */
  async listDenialsLocal(scopeId: ScopeId, filter?: DenialFilter): Promise<PermissionDenial[]> {
    return this.scopeStub(scopeId).listDenials(filter);
  }

  async summarizeDenialsLocal(scopeId: ScopeId, filter?: DenialFilter): Promise<DenialSummary> {
    return this.scopeStub(scopeId).summarizeDenials(filter);
  }

  /**
   * The operator's capability read's CP-less path (#1686) — the denial log's trust line: the
   * directory rows live in the scope's own DO, in the vertical's deployment, reachable only
   * through its platform-gated `/internal/capabilities`; the K-3 check and the K-24 entry are
   * the control plane's, made before it calls. Records only — the DO's query selects no hash.
   */
  async listCapabilitiesLocal(scopeId: ScopeId, filter?: CapabilityFilter): Promise<CapabilityPage> {
    return this.scopeStub(scopeId).listCapabilities(filter);
  }

  /**
   * The platform's `become` mint on the CP-less path (#1686) — `HostAdmin.mintCapability`'s
   * ScopeDO half, for the deployment that serves the scope. Its one caller is an owner claim
   * link, minted on the platform's instruction behind the vertical's platform-gated
   * `/internal/owner-claim`; the control plane made the K-3 check and keeps the admin log before
   * it called. Not a module verb: a module mints through `ctx.capabilities`, which mints `act`
   * capabilities only. Same lifecycle gate as the exchange, so a held scope mints nothing.
   */
  async mintCapabilityLocal(
    tenantId: TenantId,
    scopeId: ScopeId,
    input: BecomeCapabilityInput,
    actor: PlatformActorId,
  ): Promise<MintedCapability> {
    // Checked on this side too, as `HostAdmin.mintCapability` does: a typed refusal thrown
    // across the RPC arrives as a bare message.
    checkBecomeInput(input, new Date().toISOString() as Instant);
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return mintedCapability.parse(await this.scopeStub(scopeId).mintBecomeCapability(input, actor));
  }

  /**
   * The platform's revoke on the CP-less path (#1686) — how a re-minted claim link retires the
   * previous one. True when the scope held the capability (revoked now, or already); false when
   * it holds no such capability. No lifecycle gate: a revoke only narrows, so a held scope still
   * takes one. Idempotent.
   */
  async revokeCapabilityLocal(scopeId: ScopeId, capabilityId: CapabilityId, actor: PlatformActorId): Promise<boolean> {
    return (await this.scopeStub(scopeId).revokeCapabilityAsPlatform(capabilityId, actor)) !== null;
  }

  /**
   * Copy one scope's data into a fresh scope DO, entirely within THIS deployment —
   * the data half of an orchestrated snapshot (preview-and-snapshots.md §9). Like the
   * introspection pair above it consults no control plane: the vertical's platform-
   * gated `/internal/snapshot` route calls it, and the directory half (provenance row,
   * activation, version bind) stays on the control plane's side. Because source and
   * destination sit in the same SCOPE namespace, no scope bytes ever leave the
   * deployment — the §9 property the trust line rests on.
   *
   * #2016: `tenantId`, the tenant the platform snapshots for (absent from an older platform). The
   * source must not be foreign to it — a copy never reads another tenant's scope — and the fork
   * records it as its own receipt, not the source's.
   */
  async snapshotScopeLocal(
    sourceScopeId: ScopeId,
    destScopeId: ScopeId,
    tenantId?: TenantId,
  ): Promise<{ tables: number }> {
    if (tenantId !== undefined && (await this.scopeStub(sourceScopeId).admission(tenantId)).verdict === 'foreign') {
      throw unknownScopeForTenant(tenantId, sourceScopeId);
    }
    const tables = await this.scopeStub(sourceScopeId).exportDump();
    // #2009: a snapshot is a fork by construction (the control plane's row names `forkedFrom`, so
    // the directory never calls it primary), and a load classifies nothing by itself: marked here.
    await this.scopeStub(destScopeId).importDump(tables, destScopeId, {
      sourceScopeId,
      exact: true,
      markCopy: true,
      provisionedFor: tenantId,
    });
    return { tables: tables.length };
  }

  /**
   * Load a dump into one scope DO in THIS deployment (drop-then-replay) — the
   * CP-less write half of `exportScopeLocal`, behind the vertical's
   * `/internal/restore`. The control plane is the gate and the auditor; this end
   * just replaces its own bytes with the dump's, migration frontier included.
   */
  async restoreScopeLocal(
    scopeId: ScopeId,
    tables: ScopeDumpTable[],
    /** #1742: the directory's recorded-off modules, switched off on THIS scope in the replay's
     *  own event — a dump from before a switch was pulled brings its grants back live. #1869:
     *  `sourceScopeId`, the scope the dump was captured from, narrows the grant re-point to it;
     *  `exact` says the platform exported the dump itself, so the re-point never falls back.
     *  #1722: `loadStamp`, the stamp a carry leaves on the copy it lands, for a fenced wipe later,
     *  and `expect`, the marker the carry read here: the load is refused if the store moved since.
     *  #2005: `markCopy` — the directory's classification of the scope, sent when it is not
     *  primary; the restore then marks it a copy. Refused if it classifies a primary.
     *  #2016: `tenantId`, the tenant the platform restores for: recorded as the scope's receipt in
     *  the load's own transaction, and a store provisioned for another tenant refuses the load. */
    opts?: SwitchCarryWire & {
      sourceScopeId?: ScopeId;
      exact?: boolean;
      loadStamp?: string;
      expect?: LoadMarker;
      markCopy?: ScopeLineage;
      tenantId?: TenantId;
    },
  ): Promise<{ tables: number; switchedOff?: SwitchedOff[] }> {
    if (opts?.markCopy) assertCopyLineage(opts.markCopy);
    const carry = opts ? recordedOffFromWire(opts) : undefined;
    const load = {
      switchOff: carry ? { at: new Date().toISOString(), ...carry } : undefined,
      sourceScopeId: opts?.sourceScopeId,
      exact: opts?.exact,
      loadStamp: opts?.loadStamp,
      markCopy: opts?.markCopy !== undefined,
      provisionedFor: opts?.tenantId,
    };
    // The refusals come back as values (a throw over the RPC carries only its message) and are
    // thrown here, in the vertical's own isolate, so its route answers 409 or 412, not a fault.
    const out = await this.scopeStub(scopeId).importDumpChecked(tables, scopeId, {
      ...load,
      ...(opts?.expect ? { expect: opts.expect } : {}),
    });
    if (out.refused === false) {
      return { tables: tables.length, ...(carry ? { switchedOff: out.switchedOff } : {}) };
    }
    if (out.refused === 'kept') throw substratError('conflict', KEPT_COPY_REFUSAL);
    if (out.refused === 'tenant') throw substratError('conflict', out.message);
    // A retry of a load that already committed (its answer was lost on the way back) is
    // refused by the marker that load itself moved. The store holding THIS request's stamp
    // says so: no other load writes it. Answered as applied, without `switchedOff`, so the
    // caller's re-assert after the bind covers the OFF positions.
    const now = await this.scopeStub(scopeId).loadMarker();
    if (!opts?.loadStamp || now.loadStamp !== opts.loadStamp) {
      throw substratError('precondition_failed', 'scope store changed since the carry read it; nothing was loaded (#1722)');
    }
    return { tables: tables.length };
  }

  /** The kept-copy marker of this scope's store in THIS deployment (#1722), or null. */
  async keptCopyLocal(scopeId: ScopeId): Promise<KeptCopy | null> {
    return this.scopeStub(scopeId).keptCopy();
  }

  /**
   * Discard the kept copy of a scope in THIS deployment (#1722), behind the vertical's
   * `/internal/kept-copy/discard`: the staff resolution, only at the write revision the operator
   * acted on. Answers whether it was discarded, or why not.
   */
  async discardKeptCopyLocal(
    scopeId: ScopeId,
    revision: string | null,
    carriedAway: CarriedAway,
    /** #2005: the directory's classification, sent when the scope is not primary. */
    markCopy?: ScopeLineage,
    /** #1722 (Codex #2008 r13): the load stamp read with `revision`; a replaced store is refused. */
    loadStamp?: string | null,
  ): Promise<{ discarded: true } | { refused: 'changed' | 'not-kept' }> {
    if (markCopy) assertCopyLineage(markCopy);
    return this.scopeStub(scopeId).discardKeptCopy(
      scopeId,
      revision,
      carriedAway,
      markCopy !== undefined,
      ...(loadStamp !== undefined ? [loadStamp] : []),
    );
  }

  /**
   * What a carry's restore into this scope's store expects to find unchanged (#1722), behind
   * the vertical's `/internal/load-marker`. Read before the carry checks the binding again; the
   * restore then carries it as `expect`, and is refused if the store was loaded or written since.
   */
  async loadMarkerLocal(scopeId: ScopeId): Promise<LoadMarker> {
    return this.scopeStub(scopeId).loadMarker();
  }

  /**
   * Wipe the copy a carry left in THIS deployment (#1722), behind the vertical's
   * `/internal/wipe-carried`: only if nothing was loaded into the scope's DO since the stamp
   * the carry read (`expectLoadStamp`, null for a store no load has stamped). Non-terminal,
   * so a later bind back to this version can restore into it. False when refused.
   */
  async wipeCarriedLocal(
    scopeId: ScopeId,
    expectLoadStamp: string | null,
    carriedAway: CarriedAway,
    opts: {
      /** #1722: the write revision the carry's export read, so a write since refuses the wipe. */
      expectRevision?: string | null;
      /** #1722: the scope does not route here, so a copy changed in any way since is kept. */
      protectIfChanged?: boolean;
      /** #2005 (Codex #2008 r10): the directory's classification, sent when the scope is not
       *  primary — so a copy made before the marker leaves this wipe marked, tombstoned or kept. */
      markCopy?: ScopeLineage;
    } = {},
  ): Promise<boolean> {
    if (opts.markCopy) assertCopyLineage(opts.markCopy);
    return this.scopeStub(scopeId).wipeCarried(scopeId, expectLoadStamp, carriedAway, {
      ...(opts.expectRevision !== undefined ? { expectRevision: opts.expectRevision } : {}),
      ...(opts.protectIfChanged !== undefined ? { protectIfChanged: opts.protectIfChanged } : {}),
      markCopy: opts.markCopy !== undefined,
    });
  }

  /** Release a kept copy that is the live store after all (#1722), at the revision read. */
  async releaseKeptCopyLocal(
    scopeId: ScopeId,
    revision: string | null,
    /** #2005: the directory's classification, sent when the scope is not primary. */
    markCopy?: ScopeLineage,
    /** #1722 (Codex #2008 r13): the load stamp read with `revision`; a replaced store is refused. */
    loadStamp?: string | null,
  ): Promise<{ released: true } | { refused: 'changed' | 'not-kept' }> {
    if (markCopy) assertCopyLineage(markCopy);
    return this.scopeStub(scopeId).releaseKeptCopy(revision, markCopy !== undefined, ...(loadStamp !== undefined ? [loadStamp] : []));
  }

  /**
   * Store the lifecycle the platform delivered for one scope in THIS deployment (#1713), behind
   * the vertical's `/internal/lifecycle`. Kept unless the scope already holds a newer one, so a
   * push that arrives late cannot undo a later transition. `applied` is what the platform's heal
   * sweep records as delivered; `changed` says the gate's answer moved.
   *
   * #2016: `tenantId`, the tenant the directory delivered it for (absent from an older platform).
   * A scope provisioned for another tenant refuses the delivery (`conflict`) and stores nothing;
   * a scope provisioned before the tenant receipt existed records it here, its role rows agreeing.
   */
  async setLifecycleLocal(
    scopeId: ScopeId,
    next: ScopeLifecycle,
    tenantId?: TenantId,
  ): Promise<LifecycleDelivery> {
    const out = await this.scopeStub(scopeId).setLifecycle(scopeLifecycle.parse(next), tenantId);
    if ('refused' in out) throw substratError('conflict', out.message);
    return lifecycleDelivery.parse(out);
  }

  /**
   * Mark one scope in THIS deployment a copy (#2005), behind the vertical's `/internal/mark-copy`:
   * the repair of a copy that predates the marker, which a CP-less coordinator reads for primacy.
   * The control plane decides which scopes (its directory says they are not primary) and audits.
   */
  async markCopyLocal(scopeId: ScopeId, lineage: ScopeLineage): Promise<{ marked: boolean }> {
    assertCopyLineage(lineage);
    return { marked: await this.scopeStub(scopeId).markCopy() };
  }

  /**
   * Clear a mistaken copy classification from one scope in THIS deployment (#2005), behind the
   * vertical's `/internal/clear-copy-mark`: staff's correction for a scope the directory says IS
   * primary. Refused for a scope classified a copy. A load's copied-events mark is never touched
   * (#2009), so a primary restored from another scope's backup runs its own effects again and
   * still never runs the work it copied.
   */
  async clearCopyMarkLocal(
    scopeId: ScopeId,
    lineage: ScopeLineage,
    /** #1722 (Codex #2008 r12–r13): the store as the caller means it, its load stamp and write
     *  revision, compared in the clear's own transaction; refused (412) if either moved. The
     *  platform's reconcile of a carry's destination sends it; staff send none. */
    expect?: LoadMarker,
  ): Promise<{ cleared: boolean }> {
    if (!isPrimaryScope(lineage)) {
      throw substratError('conflict', 'clear-copy-mark refused: the directory classifies this scope as a copy (a preview or a fork)');
    }
    const outcome = await this.scopeStub(scopeId).clearCopyMark(...(expect ? [expect] : []));
    if (outcome === 'changed') {
      throw substratError('precondition_failed', `clear-copy-mark refused: scope ${scopeId}'s store changed since its revision was read`);
    }
    return { cleared: outcome === 'cleared' };
  }

  /**
   * Re-apply the vertical's OWN role definitions to one scope, CP-lessly — the
   * repair half of `restoreScopeLocal`. A dump captured from a CP-FULL world
   * carries the scope's tuples but an EMPTY roles table (definitions live in
   * that world's directory), so a plain restore leaves grants the local checker
   * cannot expand: /me shows a role while every ctx.check denies. Roles are
   * code-defined and deterministic, so re-projecting after import is always
   * safe; scope-level tuples (the restored grants) are never touched.
   */
  async projectRolesLocal(
    tenantId: TenantId,
    scopeId: ScopeId,
    roles: RoleDefinition[],
  ): Promise<void> {
    unwrapReply(await this.scopeStub(scopeId).applyProjectionReply(
      tenantId,
      roles.map((r) => ({ role_key: r.key, permissions: JSON.stringify(r.permissions), source: r.source })),
      [],
    ));
  }

  /**
   * Wipe one scope DO's storage in THIS deployment — the reap half of an orchestrated
   * deleteSnapshot (§9). The fork-only refusal and the directory cleanup live on the
   * control plane, which calls the vertical's `/internal/delete-scope` before deleting
   * the row; this end just destroys its own bytes.
   */
  async deleteScopeLocal(scopeId: ScopeId): Promise<void> {
    await this.scopeStub(scopeId).destroyStorage();
    // #1819: a deleted scope runs nothing; its claims go with it. Best effort, never a failed reap.
    await this.switchHoldsStub()
      .switchHoldRelease(scopeId, null, null)
      .catch(() => undefined);
  }

  /**
   * Dump one scope's tables from THIS deployment — the data half of a governed
   * `scope pull` (preview-and-snapshots.md §8/§9). Unlike the snapshot verb, this one
   * DOES move scope bytes across the boundary — that is its purpose, and why the
   * control-plane route in front of it is the gated, audited, masked-by-default
   * path (§6). The vertical's platform-gated `/internal/export` route calls it.
   */
  async exportScopeLocal(scopeId: ScopeId): Promise<ScopeDumpTable[]> {
    return this.scopeStub(scopeId).exportDump();
  }

  /**
   * `exportScopeLocal` with the store's load stamp, read in the same DO call (#1722): what a
   * carry's fenced wipe of the copy it leaves here expects. Behind the vertical's `/internal/export`.
   */
  async exportScopeStampedLocal(
    scopeId: ScopeId,
  ): Promise<{ tables: ScopeDumpTable[]; loadStamp: string | null; revision: string | null }> {
    return this.scopeStub(scopeId).exportDumpStamped();
  }

  /** Facet this host's own scope's outbox (#1239) — the vertical-host read. */
  async facetEventsLocal(scopeId: ScopeId, input: EventFacetInput): Promise<EventFacetResult> {
    return this.scopeStub(scopeId).facetEvents(input);
  }

  /** What one event set off (#1237) on this host's own scope — the vertical-host read. */
  async eventEffectsLocal(scopeId: ScopeId, input: EventEffectsInput): Promise<EffectsTree> {
    return this.scopeStub(scopeId).eventEffects(input);
  }

  /** Everything one call emitted (#1237) on this host's own scope — the vertical-host read. */
  async invocationEventsLocal(scopeId: ScopeId, input: InvocationEventsInput): Promise<InvocationEvents> {
    return this.scopeStub(scopeId).invocationEvents(input);
  }

  /** Every delivery that gave up (#1525) on this host's own scope — the vertical-host read. */
  async deadLettersLocal(scopeId: ScopeId, input: DeadLettersInput): Promise<Page<DeadLetter>> {
    return this.scopeStub(scopeId).deadLetters(input);
  }

  /** One entity's lifecycle replayed (#1744) on this host's own scope — the vertical-host read. */
  async lifecycleFlowLocal(scopeId: ScopeId, input: LifecycleFlowInput): Promise<LifecycleFlowResult> {
    return this.scopeStub(scopeId).lifecycleFlow(input);
  }

  /** Business volumes per bucket (#1750) on this host's own scope — the vertical-host read. */
  async operationSeriesLocal(scopeId: ScopeId, input: OperationSeriesInput): Promise<OperationSeriesResult> {
    return this.scopeStub(scopeId).operationSeries(input);
  }

  /** One event's causal chain (#1237) on this host's own scope — the vertical-host read. */
  async eventCauseLocal(scopeId: ScopeId, input: EventCauseInput): Promise<CauseChain> {
    return this.scopeStub(scopeId).eventCause(input);
  }

  /** One record's event history (#1235) on this host's own scope — the vertical-host read. */
  async entityHistoryLocal(scopeId: ScopeId, input: EntityHistoryInput): Promise<Page<HistoryEntry>> {
    return this.scopeStub(scopeId).entityHistory(input);
  }

  /** When this host's own scope applied each migration (#1236) — the vertical-host read. */
  async appliedMigrationsLocal(scopeId: ScopeId): Promise<AppliedMigration[]> {
    return this.scopeStub(scopeId).appliedMigrations();
  }

  /** This host's own scope's database size in bytes (#1524), the vertical-host read. */
  async databaseSizeLocal(scopeId: ScopeId): Promise<number> {
    return this.scopeStub(scopeId).databaseSize();
  }

  /**
   * The oldest not-yet-drained events of this host's own scope (#1334) — the far end of
   * the control plane's `EventDrainDelegation`. Bounded the same way the audited verb is,
   * so a caller cannot ask this side for more than the other would.
   */
  async undrainedEventsLocal(scopeId: ScopeId, limit: number): Promise<UndrainedEvents> {
    return undrainedEventsOf(await this.scopeStub(scopeId).undrainedEventsRead(Math.min(Math.max(limit, 1), 1000)));
  }

  /**
   * Stamp `drained_at` on this host's own scope (#1334) — the delegation's other half.
   * The instant is the control plane's, carried through, so the receipt it writes
   * beside its admin row names the same time the rows hold. No audit here: the
   * platform's `markEventsDrained` is the door, and this is what stands behind it.
   */
  async markEventsDrainedLocal(scopeId: ScopeId, eventIds: readonly string[], drainedAt: string): Promise<number> {
    return this.scopeStub(scopeId).markEventsDrained(eventIds, drainedAt);
  }

  /**
   * Reopen this host's own scope's drained rows (#1334) — the delegation's third half.
   * No audit here, as with the stamp: the platform's `redrainEvents` is the door.
   */
  async redrainEventsLocal(scopeId: ScopeId, drainedBefore: string): Promise<number> {
    return this.scopeStub(scopeId).redrainEvents(drainedBefore);
  }

  /**
   * How many rows that reopen would touch, in this host's own scope (#1545) — the
   * read-only half a dry run asks for. A separate method rather than a flag on the one
   * above: the two return the same shape, so a lost argument would turn a count into a
   * reopen silently, and a name cannot be lost that way. No audit, like the reopen: the
   * platform's `redrainEvents` is the door, and a count egresses nothing to record.
   */
  async redrainCountLocal(scopeId: ScopeId, drainedBefore: string): Promise<number> {
    return this.scopeStub(scopeId).redrainCount(drainedBefore);
  }

  /**
   * The PITR bookmarks one scope recorded before its migration passes (#286) — the
   * rewind points a backout UI offers. Behind the vertical's platform-gated
   * `/internal/bookmarks`; the control plane is the gate and the auditor.
   */
  async migrationBookmarksLocal(
    scopeId: ScopeId,
  ): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]> {
    return this.scopeStub(scopeId).migrationBookmarks();
  }

  /**
   * Rewind one scope to a pre-migration bookmark (#286's backout) — schema AND data,
   * discarding every write since; the DO enforces the freshness window and restarts
   * itself to complete the restore. Behind the vertical's `/internal/rewind`.
   *
   * #1819: what the scope has switched off is held outside it first, so the rewound grants
   * run nothing until the switch is back in the scope. See `rewindHolding`.
   */
  async rewindScopeLocal(
    scopeId: ScopeId,
    bookmark: string,
    opts?: { force?: boolean },
  ): Promise<{ rewindingTo: string }> {
    return this.rewindHolding(scopeId, () => this.scopeStub(scopeId).rewindToBookmark(bookmark, opts));
  }

  registerModule(registration: ModuleRegistration): void {
    const manifest = moduleManifest.parse(registration.manifest);
    if (this.moduleIds.has(manifest.id)) {
      throw new Error(`module already registered: ${manifest.id}`);
    }
    // #2068: the same refusal the ScopeDO applies at code time, here at registration, so a
    // misdeclared erasure fails where it is registered on both hosts.
    moduleErasurePlan(registration);
    const migrations = registration.migrations ?? [];
    const seen = new Set<string>();
    for (const m of migrations) {
      if (seen.has(m.version)) {
        throw new Error(`duplicate migration version in ${manifest.id}: ${m.version}`);
      }
      seen.add(m.version);
    }
    // IN-SCOPE consumes only (#1705): a `from` entry is an import, handled under `imports`.
    const declaredConsumes = new Set(
      manifest.events.consumes.filter((c) => c.from === undefined).map((c) => c.type),
    );
    for (const eventType of Object.keys(registration.consumers ?? {})) {
      if (!declaredConsumes.has(eventType)) {
        throw new Error(
          `${manifest.id} registers a consumer for undeclared event type: ${eventType}`,
        );
      }
    }
    for (const name of Object.keys(registration.predicates ?? {})) {
      const existing = this.predicateNames.get(name);
      if (existing) {
        throw new Error(
          `guard predicate already contributed by ${existing}: ${name} (names are global)`,
        );
      }
      this.predicateNames.set(name, manifest.id);
    }
    // #119: the trash rules, refused here too so a bad module fails at construction, not at its
    // scope's first wake. The scope holds the targets; the coordinator only needs the verdict.
    registerTrashTargets(
      manifest.id,
      new Set(Object.keys(registration.operations ?? {})),
      registration.operationInputs,
      manifest.entityStates,
      manifest.schedules,
    );
    // #1705: after the checks above, so a refused module leaves nothing registered here.
    this.crossVertical.register(manifest, registration.imports);
    this.moduleIds.add(manifest.id);
    if (manifest.schedules && manifest.schedules.length > 0) {
      this.moduleSchedules.set(manifest.id, manifest.schedules);
    }
    if (manifest.peers && manifest.peers.length > 0) {
      this.peerSources.push({ peers: manifest.peers });
    }
    if (manifest.freshness && manifest.freshness.length > 0) {
      this.moduleFreshness.set(manifest.id, manifest.freshness);
    }
    this.migrationTotal += migrations.length;
    const ownOperations = new Set(Object.keys(registration.operations ?? {}));
    for (const name of manifest.withdraws ?? []) {
      if (ownOperations.has(name)) {
        throw new Error(
          `${manifest.id} withdraws its own operation: ${name} (a module cannot withdraw itself — just don't register it)`,
        );
      }
      this.withdrawn.set(name, manifest.id);
      this.operations.delete(name);
      this.operationEntitlement.delete(name);
    }
    // #893: the facade validates what the DO will enforce. A schema declared for
    // an operation this module does not bind enforces nothing while reading as
    // coverage — refused here so it is caught at registration rather than never.
    const unboundInputs = Object.keys(registration.operationInputs ?? {}).filter(
      (name) => !ownOperations.has(name),
    );
    if (unboundInputs.length > 0) {
      throw new Error(
        `${manifest.id} declares operationInputs for unbound operation(s): ` +
          `${unboundInputs.sort().join(', ')} — a schema on nothing reads as a parse that is not there`,
      );
    }
    const binding: OperationEntitlement = {
      moduleId: manifest.id,
      entitlementKey: manifest.entitlementKey,
      scheduledOperations: new Set((manifest.schedules ?? []).map((sch) => sch.operation)),
    };
    for (const name of Object.keys(registration.operations ?? {})) {
      this.bindOperation(name);
      this.operationEntitlement.set(name, binding);
    }
  }

  defineOperation<I, O>(name: string, _handler: OperationHandler<I, O>): void {
    this.bindOperation(name);
  }

  private bindOperation(name: string): void {
    if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
    if (this.operations.has(name)) throw new Error(`operation already defined: ${name}`);
    this.operations.add(name);
  }

  // -- scope lifecycle ------------------------------------------------------

  async provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void> {
    // Shared with the pure adapter so the defaults cannot drift between them.
    const record = resolveScopeRecord(input);
    // Fail-closed tenant gate throws out of the awaited cp call BEFORE migrate
    // or audit, so a rejected provision creates nothing and writes no audit row.
    const created = await this.directory('provisionScope',
      input.tenantId,
      input.scopeId,
      record,
      new Date().toISOString(),
    );
    // Instantiate the scope DO and trigger its lazy migration.
    await this.migrateAndRecord(input.scopeId);
    // Scope-local permissions: a freshly-provisioned scope evaluates from its own
    // storage, so project the tenant's current roles/tuples into it (no-op when off,
    // or if migration threw above — a failed scope stays closed, never projected).
    await this.projectScope(input.tenantId, input.scopeId);
    // Project each registered module's SCHEDULE grants (#383): the system principal
    // holds exactly the permissions its schedules declared, on this scope, so
    // `ctx.check` resolves for scheduled work (the gate stays the check). Written to
    // the scope's own tuples, where the checker reads them — the same place the owner
    // grant and connection grants land. Idempotent, so a re-provision re-asserts them —
    // SEATED (#1659): a missing grant is recreated, a revoked one stays revoked. The
    // per-scope schedule kill switch is `revokeFromSystem` (#1666), and its OFF marker is
    // not a grant, so no reconcile can seat it away; `restoreToSystem` is the only way back.
    // (`grantToSystem` still clears a tuple's tombstone, but it does not move the switch.)
    const seats: { subject: string; relation: string; object: string; expires_at: string | null }[] = [];
    for (const [moduleId, schedules] of this.moduleSchedules) {
      const perms = new Set<string>();
      for (const s of schedules) for (const p of s.permissions) perms.add(p);
      for (const perm of perms) {
        seats.push({ subject: `system:${moduleId}`, relation: `granted:${perm}`, object: `scope:${input.scopeId}`, expires_at: null });
      }
    }
    // #1706: every declared PEER holds its keys on the scope from provisioning on — the one
    // call (`peerSeats`) that makes "declared and installed" mean "live". Same seat as the
    // schedule grants above, so a grant a switch tombstoned stays tombstoned and a
    // switched-off peer gets nothing seated.
    for (const seat of peerSeats(collectPeers(this.peerSources), input.scopeId)) {
      seats.push({ subject: seat.subject, relation: seat.relation, object: seat.object, expires_at: null });
    }
    // #1674: re-assert the recorded OFF positions after the seat (`system-switch-record.ts`).
    // Only where this seat landed in the scope's real store — a CP-less host, or a scope
    // bound to no vertical. A scope a vertical's deployment serves is seated there, later,
    // and re-asserted after that deployment's reconcile instead.
    //
    // #1742: in the SAME unit as the seat, so no sweep can land between them; the re-assert
    // after it then finds them off, and audits what the unit moved.
    const ownStore = this.cpLess || record.vertical === null;
    const seatAt = new Date().toISOString();
    const carry = ownStore ? await this.recordedOffCarry(input.tenantId, input.scopeId, seatAt) : undefined;
    const switchedOff = await this.scopeStub(input.scopeId).seatTuples(
      seats,
      carry ? { scopeId: input.scopeId, at: seatAt, ...carry } : undefined,
    );
    if (ownStore) {
      await this.admin.reassertSystemSwitches(
        actor,
        { tenantId: input.tenantId, scopeId: input.scopeId },
        { appliedInUnit: switchedOff },
      );
    }
    // Audit a real provision only; an idempotent re-provision changed nothing.
    if (created) {
      await this.recordAdmin(
        actor,
        'provisionScope',
        { tenantId: input.tenantId, scopeId: input.scopeId, vertical: record.vertical },
        null,
        record,
      );
    }
  }

  // Per-tenant relational stores (#301, PR-2 — the live D1 path). The coordinator holds
  // the platform's D1 credential (the same split secretBox uses: the DO records, it never
  // holds a key), the ControlPlaneDO serializes the ledger write, and the D1 REST client
  // does the actual mint. Unconfigured (dev without a CF credential, a CP-less vertical),
  // these fail loudly rather than silently no-op — a hosted vertical that declares a
  // `tenantStoreNeed` must not appear provisioned while its store does not exist.
  async provisionTenantStore(
    actor: PlatformActorId,
    input: TenantStoreProvisionInput,
  ): Promise<TenantStoreHandle> {
    const d1 = this.requireTenantStores(
      `provisionTenantStore(tenant=${input.tenantId} vertical=${input.vertical} binding=${input.binding})`,
    );
    // Fail closed on an unknown/non-active tenant, exactly as provisionScope does (§4.1's
    // "tenant is an FK string" hole). Checked here for the honest error; re-checked
    // inside the DO's ledger write, which is the serialization point that actually holds.
    const tenant = await this.cp.getTenant(input.tenantId);
    if (!tenant) {
      throw substratError('not_found', `cannot provision tenant store under unknown tenant: ${input.tenantId}`);
    }
    if (tenant.status !== 'active') {
      throw substratError('conflict',
        `cannot provision tenant store under non-active tenant (status: ${tenant.status}): ${input.tenantId}`,
      );
    }
    // Idempotent on (tenant, vertical, binding): a retried provision re-resolves the SAME
    // store rather than minting a second database (the K-31 ready-gate retries the whole
    // callback). An existing row short-circuits before any Cloudflare call and is NOT
    // re-audited — nothing changed.
    const existing = await this.cp.getTenantStore(input.tenantId, input.vertical, input.binding);
    if (existing) return { binding: input.binding, kind: 'relational', ref: existing.ref };
    // Mint the database, then record it. The name is deterministic so a provision that
    // crashed BETWEEN these two steps converges on the same database on retry (create
    // resolves a name collision to the existing id); the ledger row — not the name — is
    // the source of truth, carrying the D1 database_id Cloudflare assigned as the ref.
    const name = await tenantStoreDatabaseName(input.tenantId, input.vertical, input.binding);
    const ref = await d1.create(name);
    const stored = await this.directory('putTenantStore', {
      tenantId: input.tenantId,
      vertical: input.vertical,
      binding: input.binding,
      kind: 'relational',
      ref,
      createdAt: new Date().toISOString(),
    });
    if (stored.ref !== ref) {
      // A concurrent provision won the ledger write. One database is canonical — the
      // ledger's — so drop ours rather than orphan it (best-effort: a leaked delete
      // failure leaves an unreferenced empty database, never a wrong handle).
      await d1.remove(ref).catch(() => undefined);
      return { binding: input.binding, kind: 'relational', ref: stored.ref };
    }
    await this.recordAdmin(
      actor,
      'provisionTenantStore',
      { tenantId: input.tenantId, vertical: input.vertical },
      null,
      { binding: input.binding, kind: 'relational', ref },
    );
    return { binding: input.binding, kind: 'relational', ref };
  }

  openTenantStore(handle: TenantStoreHandle): TenantRelationalStore {
    // The COORDINATOR-side open: out-of-band SQL over the D1 HTTP API — driving a store's
    // migrations externally, ops reads, tests. The request-time open happens in the
    // vertical's worker instead, against the real `d1` binding the platform attached to
    // the serving script (`env[tenantStoreBindingName(handle.binding, tenantId)]`, wrapped
    // by `d1TenantRelationalStore`) — which is also why `native` is null here: this store
    // has no in-process driver to hand out.
    const d1 = this.requireTenantStores(`openTenantStore(binding=${handle.binding})`);
    return {
      query: async <T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> =>
        (await d1.query(handle.ref, sql, params)).results as T[],
      exec: async (sql: string, params: readonly SqlValue[] = []) => ({
        changes: (await d1.query(handle.ref, sql, params)).changes,
      }),
      native: null,
    };
  }

  /** The injected D1 client, or a loud refusal naming what to configure — typed
   *  `unavailable` for the reason its blob-store twin below is (#828). */
  private requireTenantStores(what: string): D1TenantStores {
    if (!this.tenantStores) {
      throw substratError(
        'unavailable',
        `per-tenant stores are not configured on this host (#301): pass ` +
          `CloudflareScopeHostOptions.tenantStores (createD1TenantStores with the platform's ` +
          `Cloudflare credential) — refused ${what}`,
      );
    }
    return this.tenantStores;
  }

  async provisionBlobStore(
    actor: PlatformActorId,
    input: BlobStoreProvisionInput,
  ): Promise<BlobStoreHandle> {
    // Mirror of provisionTenantStore (#301) with R2 in place of D1: fail-closed tenant
    // gate, ledger idempotency, deterministic name so a crashed retry converges, DO
    // first-writer-wins with loser teardown.
    const r2 = this.requireBlobStores(
      `provisionBlobStore(tenant=${input.tenantId} vertical=${input.vertical} binding=${input.binding})`,
    );
    const tenant = await this.cp.getTenant(input.tenantId);
    if (!tenant) {
      throw substratError('not_found', `cannot provision blob store under unknown tenant: ${input.tenantId}`);
    }
    if (tenant.status !== 'active') {
      throw substratError('conflict',
        `cannot provision blob store under non-active tenant (status: ${tenant.status}): ${input.tenantId}`,
      );
    }
    const existing = await this.cp.getBlobStore(input.tenantId, input.vertical, input.binding);
    if (existing) return { binding: input.binding, kind: 'blob', ref: existing.ref };
    const name = await blobStoreBucketName(input.tenantId, input.vertical, input.binding);
    const ref = await r2.create(name);
    const stored = await this.directory('putBlobStore', {
      tenantId: input.tenantId,
      vertical: input.vertical,
      binding: input.binding,
      kind: 'blob',
      ref,
      createdAt: new Date().toISOString(),
    });
    if (stored.ref !== ref) {
      await r2.remove(ref).catch(() => undefined);
      return { binding: input.binding, kind: 'blob', ref: stored.ref };
    }
    await this.recordAdmin(
      actor,
      'provisionBlobStore',
      { tenantId: input.tenantId, vertical: input.vertical },
      null,
      { binding: input.binding, kind: 'blob', ref },
    );
    return { binding: input.binding, kind: 'blob', ref };
  }

  /**
   * The injected R2 client, or a loud refusal naming what to configure.
   *
   * Typed `unavailable` (#828) for the reason `SecretBoxUnconfiguredError` is: this is a
   * DEPLOYMENT fact, not a fault in the caller's request — the same request succeeds
   * unchanged once the host is wired. Untyped, it reached the control-plane transport as
   * an unrecognised throw and was flattened to a bare `500 internal error`, so a message
   * that names its own fix was discarded at the boundary and the operator was left
   * unable to tell a missing client from a bad scope id.
   */
  private requireBlobStores(what: string): R2BlobStores {
    if (!this.blobStores) {
      throw substratError(
        'unavailable',
        `per-tenant blob stores are not configured on this host (#473): pass ` +
          `CloudflareScopeHostOptions.blobStores (createR2BlobStores with the platform's ` +
          `Cloudflare credential) — refused ${what}`,
      );
    }
    return this.blobStores;
  }

  async attachments(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeAttachments> {
    // Same fail-closed lifecycle gate + lazy-migration as getScope (#473). The permission
    // gates and metadata facts live in the ScopeDO (per-scope serialization, spine event
    // in the same transaction); bytes go straight to the per-tenant R2 bucket through the
    // binding the vertical's worker resolved — never through the DO.
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    return this.buildAttachmentSurface({ principal }, tenantId, scopeId, store);
  }

  async getSystemAttachments(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<Pick<ScopeAttachments, 'open'>> {
    // Reuse the system invoke door's module, tenant and lifecycle gate, and its rewind gate
    // (#1834). The DO authorizes each open against the attachment target's read permission as
    // system:<moduleId>; the worker reads bytes only after that gate succeeds.
    const door = await this.openSystemDoor(moduleId, tenantId, scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    const stub = this.scopeStub(scopeId);
    return {
      open: async (attachmentId) => {
        const record = await door.through<AttachmentRecord | null>((instance) =>
          stub.systemAttachmentAuthorize(attachmentId, moduleId, tenantId, scopeId, instance),
        );
        return record ? this.openAttachmentBytes(store, scopeId, record) : null;
      },
    };
  }

  async getConnectorAttachments(
    connectionId: ConnectionId,
    scopeId: ScopeId,
    forEvent?: { eventId: string },
  ): Promise<ScopeAttachments> {
    // The exact door `getConnectorScope` opens — same (tenant, vertical) gate — but it
    // returns the attachment surface instead of the invoke stub, gated as the connection
    // rather than a principal (#476).
    const conn = await this.cp.readConnection(connectionId);
    if (!conn) throw new Error(`connection not found: ${connectionId}`);
    if (conn.revoked_at) throw new Error(`connection ${connectionId} is revoked`);
    const scope = await this.cp.getScopeRecord(conn.tenant_id, scopeId);
    if (!scope) throw substratError('not_found', `unknown scope for connection: ${scopeId}`);
    if (scope.vertical !== conn.vertical) {
      throw new Error(
        `connection ${connectionId} is for vertical '${conn.vertical}' and scope ${scopeId} ` +
          `runs '${scope.vertical ?? 'none'}'`,
      );
    }
    await this.validateScopeAccess(conn.tenant_id as TenantId, scopeId);
    // #574: same delegation as getConnectorScope. `upload` is the verb the reconcile
    // path needs (landing the sealed PDF) and `open` the one the outbound path needs
    // (sending the vertical's own document, #711). `list` and `remove` still fail
    // loudly rather than pretending — and `list` stays undelegated on purpose, not
    // for want of plumbing: a connector picks the document it sends by id, so a
    // search seam would only create the ambiguity the id design removes.
    if (this.connectorDelegation) {
      const delegation = this.connectorDelegation;
      const tenant = conn.tenant_id as TenantId;
      const vertical = conn.vertical;
      const notDelegated = (verb: string) => async (): Promise<never> => {
        throw new Error(
          `connector attachment ${verb} is not delegated (#574) — upload and open are the ` +
            `verbs that cross the /internal seam to the serving deployment`,
        );
      };
      return {
        upload: (upload) =>
          delegation.uploadAttachment({ connectionId, tenantId: tenant, scopeId, vertical, upload }),
        open: (attachmentId) =>
          delegation.openAttachment({
            connectionId,
            tenantId: tenant,
            scopeId,
            vertical,
            attachmentId,
            // #726 remedy B: the delivery, resolved at the far end against the
            // deployment's own outbox. Absent outside a dispatch, where the ordinary
            // permission check still applies.
            eventId: forEvent?.eventId,
          }),
        list: notDelegated('list'),
        remove: notDelegated('remove'),
        // #1575: undelegated for `list`'s reason — a connector picks a document by id.
        search: notDelegated('search'),
      };
    }
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(conn.tenant_id as TenantId);
    return this.buildAttachmentSurface(
      { connectionId },
      conn.tenant_id as TenantId,
      scopeId,
      store,
      forEvent,
    );
  }

  /** Resolve the per-tenant R2 blob store, or fail closed. */
  private async resolveAttachmentStore(tenantId: TenantId): Promise<TenantBlobStore> {
    const bucket = await this.attachmentBuckets(tenantId);
    if (!bucket) {
      throw new Error(
        `no attachment bucket resolved for tenant ${tenantId} (#473, #1995) — this script has no ` +
          `${blobStoreBindingName(ATTACHMENT_BLOB_BINDING, tenantId)} binding. A vertical whose modules declare ` +
          `attachmentTargets gets one per installed tenant once it is pushed with a CLI that declares the ` +
          `store (re-push); off the platform, pass CloudflareScopeHostOptions.attachmentBuckets.`,
      );
    }
    return r2TenantBlobStore(bucket);
  }

  /**
   * The `ScopeAttachments` surface, gated as either a principal or a connection (#473/#476).
   * The subject decides two things: `createdBy` on the record, and the `connectionId` threaded
   * to the DO so its permission gate resolves against `connection:<id>` grants (and a denial is
   * attributed to the connection, not a laundered principal). Bytes never cross the DO boundary.
   */
  private buildAttachmentSurface(
    subject:
      | { principal: PrincipalId }
      | { connectionId: ConnectionId }
      | { capabilitySession: string },
    tenantId: TenantId,
    scopeId: ScopeId,
    store: TenantBlobStore,
    /** The delivery admitting this surface's reads (#726 remedy B), when there is one. */
    forEvent?: { eventId: string },
  ): ScopeAttachments {
    const stub = this.scopeStub(scopeId);
    if ('capabilitySession' in subject) {
      // #1686: a capability session. Its own ScopeDO verbs rather than a trailing argument
      // on the principal ones, so a DO that predates them fails the call (no such RPC
      // method) instead of ignoring the session and checking as someone else. Writes go to
      // the DO only to be refused and recorded — never to the blob store.
      const hash = subject.capabilitySession;
      return {
        upload: async (input) =>
          unwrapReply(
            await stub.capabilityAttachmentRefuseWrite(hash, tenantId, scopeId, 'attachments.upload', {
              entityType: input.entity.entityType,
            }),
          ),
        list: async (entity) =>
          unwrapReply(await stub.capabilityAttachmentList(entity, hash, tenantId, scopeId)),
        open: async (attachmentId) => {
          const record = unwrapReply(
            await stub.capabilityAttachmentOpen(attachmentId, hash, tenantId, scopeId),
          );
          return record ? this.openAttachmentBytes(store, scopeId, record) : null;
        },
        remove: async (attachmentId) =>
          unwrapReply(
            await stub.capabilityAttachmentRefuseWrite(hash, tenantId, scopeId, 'attachments.remove', {
              attachmentId,
            }),
          ),
        search: async (term, options) => {
          // Judged here too, so a short term reaches the caller as `SearchTermTooShort`
          // rather than as a message that crossed the RPC boundary. The DO judges again.
          searchMatchExpression(term, 'prefix');
          return unwrapReply(
            await stub.capabilityAttachmentSearch(term, searchLimit(options?.limit), hash, tenantId, scopeId),
          );
        },
      };
    }
    const connectionId = 'connectionId' in subject ? subject.connectionId : undefined;
    const createdBy = 'principal' in subject ? subject.principal : subject.connectionId;
    // The DO needs SOME principal-shaped value for `ctx.principal`; for a connection it is
    // the connection id, and the honest attribution rides the event actor — the same trick
    // `buildStub` uses for the invoke path.
    const asPrincipalId = ('principal' in subject
      ? subject.principal
      : (subject.connectionId as unknown as PrincipalId)) as PrincipalId;
    return {
      upload: async (input) => {
        const id = ulid();
        const key = attachmentBlobKey(scopeId, id);
        const record = attachmentRecord.parse({
          id,
          entity: input.entity,
          filename: input.filename,
          contentType: input.contentType,
          size: input.body.byteLength,
          sha256: await attachmentSha256(input.body),
          visibility: input.visibility,
          createdBy,
          createdAt: new Date().toISOString(),
        });
        // Bytes first, row second — a crash between the two leaves an orphaned object
        // (harmless, GC-able), never a row without bytes; a refused gate compensates.
        await store.put(key, input.body, { contentType: input.contentType });
        try {
          return await stub.attachmentAdd(record, asPrincipalId, tenantId, scopeId, connectionId);
        } catch (err) {
          await store.delete(key).catch(() => {});
          throw err;
        }
      },
      list: (entity) => stub.attachmentList(entity, asPrincipalId, tenantId, scopeId, connectionId),
      open: async (attachmentId) => {
        const record = await stub.attachmentAuthorize(
          attachmentId,
          'read',
          asPrincipalId,
          tenantId,
          scopeId,
          connectionId,
          forEvent?.eventId,
        );
        return record ? this.openAttachmentBytes(store, scopeId, record) : null;
      },
      remove: async (attachmentId) => {
        const removed = await stub.attachmentRemove(
          attachmentId,
          asPrincipalId,
          tenantId,
          scopeId,
          connectionId,
        );
        if (removed) await store.delete(attachmentBlobKey(scopeId, removed.id)).catch(() => {});
        return removed;
      },
      search: async (term, options) => {
        if (forEvent) {
          // The delivery-admitted surface reads the ONE attachment its delivery names.
          throw new Error('attachments.search is not available on a delivery-scoped surface');
        }
        searchMatchExpression(term, 'prefix');
        return unwrapReply(
          await stub.attachmentSearch(term, searchLimit(options?.limit), asPrincipalId, tenantId, scopeId, connectionId),
        );
      },
    };
  }

  /**
   * The bytes of an attachment the ScopeDO has already AUTHORIZED, read from the blob store
   * and held to the record's sha256 — one path for every subject, so a capability's download
   * meets the same integrity checks a principal's does.
   */
  private async openAttachmentBytes(
    store: TenantBlobStore,
    scopeId: ScopeId,
    record: AttachmentRecord,
  ): Promise<OpenedAttachment> {
    const obj = await store.get(attachmentBlobKey(scopeId, record.id));
    if (!obj) {
      throw new Error(
        `attachment ${record.id}: bytes missing from the blob store — the metadata row ` +
          `survived something the object did not (rewind/reap); see the #473 integrity notes`,
      );
    }
    if ((await attachmentSha256(obj.body)) !== record.sha256) {
      throw new Error(`attachment ${record.id}: bytes do not match the recorded sha256`);
    }
    return { record, body: obj.body, contentType: obj.contentType ?? record.contentType };
  }

  async importScope(
    actor: PlatformActorId,
    input: ProvisionScopeInput,
    dump: ScopeDump,
  ): Promise<void> {
    // Create the destination scope (directory row + DO + lazy migrate); the DO then
    // replaces its provisioned schema with the dump wholesale (drop-then-replay), so
    // the end state is the dump, at the source's frontier. Provenance is stamped from
    // the dump unless the caller set it (§3: a fork always records its origin).
    await this.provisionScope(actor, {
      ...input,
      forkedFrom: input.forkedFrom ?? (dump.scopeId as ScopeId),
      forkedAt: input.forkedAt ?? dump.capturedAt,
    });
    await this.scopeStub(input.scopeId).importDump(dump.tables, input.scopeId, {
      sourceScopeId: dump.scopeId as ScopeId,
      // A fork: its callers (snapshotScope) hand it a dump the platform exported.
      exact: true,
    });
    await this.admin.activateScope(actor, input.tenantId, input.scopeId);
    await this.recordAdmin(
      actor,
      'importScope',
      { tenantId: input.tenantId, scopeId: input.scopeId },
      null,
      { sourceScopeId: dump.scopeId, tables: dump.tables.length, capturedAt: dump.capturedAt },
    );
  }

  async restoreScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    dump: ScopeDump,
    opts?: { sourceScopeId?: ScopeId },
  ): Promise<void> {
    // Restore never creates a scope (that is importScope) — an unknown target fails closed.
    const existing = await this.admin.getScopeRecord(actor, tenantId, scopeId);
    if (!existing) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
    // #1742: a dump from before a switch was pulled brings the module's grants back live, so
    // the directory's recorded-off modules go back off in the replay's own event. Only where
    // this is the scope's real store, as for the provision's seat above; a hosted scope is
    // restored in its deployment, which the platform carries the same list to.
    const ownStore = this.cpLess || existing.vertical === null;
    const replayAt = new Date().toISOString();
    const carry = ownStore ? await this.recordedOffCarry(tenantId, scopeId, replayAt) : undefined;
    const switchedOff = await this.scopeStub(scopeId).importDump(dump.tables, scopeId, {
      switchOff: carry ? { at: replayAt, ...carry } : undefined,
      sourceScopeId: opts?.sourceScopeId ?? (dump.scopeId as ScopeId),
    });
    await this.recordAdmin(
      actor,
      'restoreScope',
      { tenantId, scopeId },
      null,
      { sourceScopeId: dump.scopeId, tables: dump.tables.length, capturedAt: dump.capturedAt },
    );
    if (carry) {
      await this.admin.reassertSystemSwitches(actor, { tenantId, scopeId }, { appliedInUnit: switchedOff });
    }
  }

  /**
   * #1742, #2029: what this host's own unit carries of the directory's record — the modules and
   * the peers recorded OFF on the scope, each with the ones held there only by a tenant-level
   * grant (#1823, #2030). Undefined when nothing is recorded off, so such a unit is unchanged.
   */
  private async recordedOffCarry(tenantId: TenantId, scopeId: ScopeId, at: string): Promise<RecordedOffCarry | undefined> {
    const [modules, peers] = await Promise.all([
      this.recordedOff('system', tenantId, scopeId, at),
      this.recordedOff('peer', tenantId, scopeId, at),
    ]);
    if (!modules.keys.length && !peers.keys.length) return undefined;
    return {
      moduleIds: modules.keys,
      tenantHeld: modules.tenantHeld,
      verticals: peers.keys,
      tenantHeldVerticals: peers.tenantHeld,
      fences: switchFencesCarried([
        ['system', modules],
        ['peer', peers],
      ]),
    };
  }

  /** The subjects of one kind the directory records OFF on the scope, and of those the tenant-held ones. */
  private async recordedOff(
    kind: SwitchKind,
    tenantId: TenantId,
    scopeId: ScopeId,
    at: string,
  ): Promise<{ keys: string[]; tenantHeld: string[]; fences: Map<string, string> }> {
    // #2045: the OFF rows and their fences in one read, so every key carried has its own row's fence.
    const fences = new Map(
      (await this.cp.switchRecordStatesOf(kind, tenantId, scopeId))
        .filter(([, row]) => row.position === 'off')
        .map(([key, row]) => [key, row.fence]),
    );
    const keys = [...fences.keys()];
    if (!keys.length) return { keys, tenantHeld: [], fences };
    return { keys, tenantHeld: await this.cp.tenantHeldOf(kind, tenantId, keys, at), fences };
  }

  async snapshotScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    opts?: { kind?: string; expiresAt?: string },
  ): Promise<ScopeId> {
    const source = await this.admin.getScopeRecord(actor, tenantId, scopeId);
    if (!source) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
    const dump = await this.admin.exportScope(actor, tenantId, scopeId);
    const snapshotId = ulid() as ScopeId;
    await this.importScope(
      actor,
      {
        tenantId,
        scopeId: snapshotId,
        kind: opts?.kind ?? 'archive',
        vertical: source.vertical,
        jurisdiction: source.jurisdiction,
        expiresAt: opts?.expiresAt,
        // forkedFrom/forkedAt are stamped from the dump by importScope.
      },
      dump,
    );
    // Bind the snapshot to the source's current version so it is a runnable copy at the
    // same frontier (a fresh bind, so it never re-triggers the snapshot path).
    if (source.verticalVersionId) {
      await this.admin.bindScopeVersion(actor, tenantId, snapshotId, source.verticalVersionId);
    }
    return snapshotId;
  }

  async deleteSnapshot(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    // The refusal that keeps this narrow: only a throwaway PREVIEW may be hard-deleted —
    // a FORK (`forkedFrom` set) or a clean-room preview (`kind === 'preview'`, source-less,
    // #509 ask (b)). A PRIMARY scope keeps the platform's tombstone-only rule (archive it).
    const rec = await this.admin.getScopeRecord(actor, tenantId, scopeId);
    if (!rec) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
    if (!rec.forkedFrom && rec.kind !== 'preview') {
      throw substratError('forbidden',
        `scope ${scopeId} is not a fork or preview — only previews may be deleted; ` +
          `archive a primary scope instead`,
      );
    }
    // Storage BEFORE the directory row: a crash between the two leaves a visible row
    // over empty storage — re-running deleteSnapshot converges — never orphaned bytes
    // with no record (the §9 hazard). Hostname rows go with the directory delete.
    await this.scopeStub(scopeId).destroyStorage();
    await this.cp.deleteScopeDirectory(scopeId);
    await this.recordAdmin(actor, 'deleteSnapshot', { tenantId, scopeId }, null, {
      forkedFrom: rec.forkedFrom,
      forkedAt: rec.forkedAt,
      expiresAt: rec.expiresAt,
      kind: rec.kind,
    });
  }

  /**
   * Migrate a scope and project its resulting migration count into the directory
   * (§5.4: fleet questions never fan out). The ScopeDO reports null when nothing
   * was pending, which skips the write — otherwise every stub mint would cost an
   * extra control-plane RPC to store a number that did not change.
   *
   * A failure is recorded and then RETHROWN (#32): the scope still fails closed,
   * but the directory learns which `module@version` broke and how many attempts it
   * has taken, instead of keeping a stale `schema_version` that renders as healthy.
   */
  private async migrateAndRecord(scopeId: ScopeId): Promise<void> {
    const stub = this.scopeStub(scopeId);
    try {
      const applied = await stub.migrate();
      if (applied !== null) await this.cp.setMigrationState(scopeId, String(applied), null);
    } catch (err) {
      // Best-effort: a scope that failed to migrate may also fail to answer, and a
      // broken recorder must not replace the migration error with its own — that
      // trades a diagnosable failure for a confusing one.
      try {
        const failure = await stub.migrationFailure();
        if (failure) {
          await this.cp.setMigrationState(scopeId, String(failure.applied), {
            version: failure.version,
            error: failure.error,
          });
        }
      } catch {
        // deliberately swallowed — the rethrow below is the real signal
      }
      throw err;
    }
  }

  async getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ScopeStub> {
    // Lifecycle gates (control-plane.md §4.1/§4.2), the K-3 fail-closed path,
    // evaluated durably in the ControlPlaneDO. A throw propagates here.
    await this.assertLive(tenantId, scopeId);

    await this.migrateAndRecord(scopeId);
    return this.buildStub(tenantId, scopeId, principal, undefined, undefined, options);
  }

  /**
   * A scope stub whose authority is a CONNECTION (#97).
   *
   * Three gates, all inherited from what the connection already is rather than
   * declared again: it must be live, the scope must be in its tenant, and the
   * scope must run its vertical. A leaked provider token therefore reaches
   * exactly the scopes that connection was for.
   *
   * What it may then DO is an ordinary permission check against
   * `connection:<id>` grants — one enforcement path, one way to revoke.
   */
  async getConnectorScope(connectionId: ConnectionId, scopeId: ScopeId): Promise<ScopeStub> {
    const conn = await this.cp.readConnection(connectionId);
    if (!conn) throw new Error(`connection not found: ${connectionId}`);
    if (conn.revoked_at) throw new Error(`connection ${connectionId} is revoked`);
    const scope = await this.cp.getScopeRecord(conn.tenant_id, scopeId);
    if (!scope) throw substratError('not_found', `unknown scope for connection: ${scopeId}`);
    if (scope.vertical !== conn.vertical) {
      throw new Error(
        `connection ${connectionId} is for vertical '${conn.vertical}' and scope ${scopeId} ` +
          `runs '${scope.vertical ?? 'none'}'`,
      );
    }
    await this.validateScopeAccess(conn.tenant_id as TenantId, scopeId);
    // #574: a scope served by ANOTHER deployment (the shared control plane running the
    // connector pass for a dispatch vertical) — the write-back rides the delegation
    // seam; migration is the serving deployment's business, exactly like provision.
    if (this.connectorDelegation) {
      const delegation = this.connectorDelegation;
      const tenant = conn.tenant_id as TenantId;
      const vertical = conn.vertical;
      return {
        tenantId: tenant,
        scopeId,
        invoke: async <O, I>(operation: string, input?: I): Promise<O> =>
          (await delegation.invoke({
            connectionId,
            tenantId: tenant,
            scopeId,
            vertical,
            operation,
            input,
          })) as O,
      };
    }
    await this.migrateAndRecord(scopeId);
    return this.buildStub(conn.tenant_id as TenantId, scopeId, undefined, connectionId);
  }

  /**
   * Read a session and hold it to its own rules — the lookup behind both the door
   * and every invoke through it. Kept in one place so the two can never disagree
   * about what "still usable" means.
   */
  private async resolveImpersonation(
    session: ImpersonationSessionId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ImpersonationSession> {
    const row = await this.cp.readImpersonation(String(session));
    if (!row) throw new ImpersonationRefused(`unknown impersonation session: ${session}`);
    const record = mapImpersonationRow(row);
    assertSessionUsable(record, new Date().toISOString() as Instant, { tenantId, scopeId });
    return record;
  }

  /**
   * The impersonation door (K-42, #868) — mirror of `getConnectorScope` and
   * `getSystemScope`. The session is the authority and it is read from the
   * directory, never described by the caller: a stub can only be minted by naming
   * a session somebody opened and the admin log already recorded.
   */
  async getImpersonatedScope(
    session: ImpersonationSessionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ScopeStub> {
    const record = await this.resolveImpersonation(session, tenantId, scopeId);
    // The same lifecycle gate the principal door applies: a suspended tenant
    // refuses a support session exactly as it refuses a user.
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return this.buildStub(
      tenantId,
      scopeId,
      record.principal,
      undefined,
      undefined,
      options,
      record.id,
    );
  }

  /**
   * A scope stub whose authority is a MODULE on a timer (#383) — the scheduler's
   * door, mirror of `getConnectorScope`. The module must be registered on this host
   * and the scope must pass the ordinary lifecycle gate; authority is then a check
   * against `system:<moduleId>` grants inside the stub.
   */
  async getSystemScope(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeStub> {
    return this.buildStub(tenantId, scopeId, undefined, undefined, await this.openSystemDoor(moduleId, tenantId, scopeId));
  }

  /**
   * #1834: the system door — the ONE place every entry acting as `system:<moduleId>` passes
   * through: a schedule's fire, a job run's `pass.scope()`, a module's attachment open. The
   * module must be registered here and the scope live, as before. Then the door GATES: the
   * scope's own state read for the module, and after it the rewind hold (#1819), in the order
   * `SWITCH_HOLD_SETTLE_MS` relies on. A module the hold keeps off is refused here, as a
   * schedule pass skips it.
   *
   * A gate read is about the instance that answered it, and a door can be held for as long as
   * a job pass runs. So every call through the door is PINNED to that instance: the DO refuses
   * one that lands on another (`SYSTEM_DOOR_MOVED`), since a PITR restore always restarts the
   * object, and the door gates again and retries. A restart within one call's round trip is
   * rare, so past `SYSTEM_DOOR_REGATES` it fails closed (`unavailable`). No clock is involved:
   * the gate and the call meet the same storage, or the call does not run.
   */
  private async openSystemDoor(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
    gated?: SubjectDoorGate,
    /** #1834: the job pass this door is opened for; its "not now" refusals are tied to it. */
    pass?: object,
  ): Promise<SubjectDoor> {
    if (!this.moduleIds.has(moduleId)) {
      throw substratError('not_found', `module not registered on this host: ${moduleId}`);
    }
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return this.openDoor('system', moduleId, scopeId, gated, pass);
  }

  /**
   * #1834: one door, for either kind of switched subject (#2029). The gate is read here unless the
   * caller read it (`runDueSchedules` reports a hold it could not read on its pass report); a held
   * subject is refused, and a call landing on another instance than the gate's re-gates, at most
   * `SYSTEM_DOOR_REGATES` times, then fails closed.
   *
   * The peer door (`kind: 'peer'`) is the system door's for a peer vertical. A PITR rewind to before
   * a peer was switched off brings its grants back live and its OFF marker gone, so the rewind holds
   * it outside the scope (`rewindHolding`, as for a module), and every peer entry — an invoke, a
   * delivery, a coverage read, an export read for it as consumer — opens this door after
   * `peerScopeGate`.
   */
  private async openDoor(
    kind: SwitchKind,
    key: string,
    scopeId: ScopeId,
    gated?: SubjectDoorGate,
    pass?: object,
  ): Promise<SubjectDoor> {
    const words = DOOR_WORDS[kind];
    const what = words.what(key);
    // A gate this door reads itself reports a hold it could not read; one handed in was the
    // caller's to report.
    const regate = async (): Promise<SubjectDoorGate> => {
      const fresh = await this.doorGate(kind, scopeId, key);
      if (fresh.error) console.error(`substrat: door of ${what} on ${scopeId}: ${fresh.error}`);
      return fresh;
    };
    let gate = gated ?? (await regate());
    return {
      kind,
      key,
      through: async <T>(call: (instance: string) => Promise<T | SystemDoorMoved>): Promise<T> => {
        for (let regates = 0; ; regates += 1) {
          if (gate.held) {
            // The hold ends when the switch is applied again: a job run waits it out without
            // spending its retries, because the driver defers on THIS refusal (`doorWait`).
            const held = substratError(
              'forbidden',
              `${what} is held off on this scope: it was rewound to before its ` +
                `${words.switchName} switch was turned off, and it stays off until ` +
                'the switch is applied again',
              { reason: SYSTEM_DOOR_WAIT },
            );
            this.heldRefusals.add(held);
            throw this.doorWait(pass, held);
          }
          const answer = await call(gate.instance);
          if (!isSystemDoorMoved(answer)) return answer;
          if (regates >= SYSTEM_DOOR_REGATES) {
            throw this.doorWait(pass,
              substratError(
                'unavailable',
                `the scope kept restarting under the ${words.door} of ${what} ` +
                  `(${regates + 1} attempts); nothing ran. Retry later`,
                { reason: SYSTEM_DOOR_WAIT },
              ),
            );
          }
          gate = await regate();
        }
      },
    };
  }

  /**
   * #1834: the refusals this host's system door threw that mean "not now" (a hold, a scope that
   * kept restarting), each tied by identity to the job pass whose door threw it. The job driver
   * defers a pass only on one of these, never on an error's shape, which any step or operation
   * could copy. A mark is ORIGIN and FRESHNESS together: it is consumed when the driver takes it,
   * and only the pass it names can take it, so a handler that keeps a refusal and throws it again
   * on a later pass is an ordinary failure there. Held weakly: an error nobody holds goes.
   */
  private readonly doorWaits = new WeakMap<object, object>();

  /**
   * #2029: the hold refusals this host's doors threw, by identity — so a peer delivery pauses its
   * edge, and a coverage read answers "holds nothing", on exactly those and on no error that only
   * looks like one. Held weakly, as `doorWaits` is.
   */
  private readonly heldRefusals = new WeakSet<object>();

  /** #2029: is `err` a hold refusal this host's door threw? */
  private isHeldRefusal(err: unknown): boolean {
    return typeof err === 'object' && err !== null && this.heldRefusals.has(err);
  }

  /** #1834: mark this door's own refusal as "not now" for the pass it was opened for, and hand it back. */
  private doorWait(pass: object | undefined, err: Error): Error {
    if (pass) this.doorWaits.set(err, pass);
    return err;
  }

  /** #1834: is `err` a "not now" this host's door threw on `pass`? Consumes the mark when it is. */
  private takeDoorWait(err: unknown, pass: object): boolean {
    if (typeof err !== 'object' || err === null || this.doorWaits.get(err) !== pass) return false;
    this.doorWaits.delete(err);
    return true;
  }

  /**
   * #1834: a door's gate — the scope's state read for the subject, the instance that answered it,
   * and then the rewind hold (#1819), for any subject the scope does not already have off. The
   * hold is read AFTER the state, which is the order `switchHeld` needs.
   *
   * `ungranted` reads the hold too (#2029): a subject held on the scope only by a TENANT-level
   * grant (#1823, #2030) comes back from a rewind with no scope grant and no marker, and the
   * tenant grant still authorizes it there. A rewind captured it off, so the hold must keep it so.
   */
  private async doorGate(kind: SwitchKind, scopeId: ScopeId, key: string): Promise<SubjectDoorGate> {
    const stub = this.scopeStub(scopeId);
    const { state, instance } = await (kind === 'system' ? stub.systemDoorState(key) : stub.peerDoorState(key));
    const cleared = `${scopeId} ${instance}`;
    if (state === 'off' || CLEAR_SCOPE_INSTANCES.has(cleared)) return { state, instance, held: false };
    const hold = await this.switchHeld(scopeId, holdKeyOf(kind, key));
    if (hold.scopeClear) rememberClearInstance(cleared);
    return { state, instance, held: hold.held, ...(hold.error ? { error: hold.error } : {}) };
  }

  /**
   * #1705: the consumer half. The same lifecycle gate as every door (K-3), then the ScopeDO
   * applies the batch, and the answer is re-parsed on this side of the RPC. Executors run here
   * afterwards, as they do after an invoke. A failure to drain them does not un-deliver a batch
   * that has committed, so it is contained, and the outbox is their backstop.
   */
  async deliverToPeer(tenantId: TenantId, scopeId: ScopeId, raw: ImportBatch): Promise<ImportResult> {
    const batch = importBatch.parse(raw);
    // The peer door's own gate (#1706): K-3's pair check, the refusal for a scope served
    // elsewhere, the lifecycle check and the migration. A delivery is a write into the
    // consumer's scope, so it takes the gate an invoke through that door takes.
    const record = await this.peerScopeGate(tenantId, scopeId, 'deliverToPeer');
    // #2004: a copy consumes no other vertical's events, at the door as in the sweep
    // (`scope-copy.ts`). A pause: nothing runs and the watermark stays.
    if (await this.isInertScope(tenantId, scopeId, record)) {
      return { ...emptyImportResult(batch), paused: { reason: INERT_SCOPE_REASON } };
    }
    // #2029: the producer is a peer, so the delivery goes through its door: a producer the rewind
    // hold keeps off pauses the edge, exactly as a switched-off one does inside the DO.
    const door = await this.openDoor('peer', batch.source.vertical, scopeId);
    let applied: ImportResult;
    try {
      applied = await door.through((instance) => this.scopeStub(scopeId).importApply(batch, tenantId, scopeId, instance));
    } catch (err) {
      if (!this.isHeldRefusal(err)) throw err;
      return { ...emptyImportResult(batch), paused: { reason: (err as Error).message } };
    }
    const result = importResult.parse(applied);
    if (result.delivered > 0) {
      try {
        await this.drainExecutors(tenantId, scopeId, null);
      } catch (err) {
        console.error('substrat: executor drain after a cross-vertical delivery failed', err);
      }
    }
    return result;
  }

  /**
   * The exchange (#1672) — the same fail-closed (tenant, scope) and lifecycle gate as
   * `getScope`, then the kernel's `exchangeCapability` inside the ScopeDO, where the
   * capability row lives. The answer is re-parsed on this side of the RPC.
   */
  async exchangeCapability(
    tenantId: TenantId,
    scopeId: ScopeId,
    secret: string,
    options?: { mode?: 'act' | 'become' },
  ): Promise<CapabilityExchange | null> {
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const outcome = await this.scopeStub(scopeId).exchangeCapability(
      secret,
      tenantId,
      scopeId,
      options?.mode,
    );
    return capabilityExchange.nullable().parse(outcome);
  }

  /**
   * The capability door (#1672) — mirror of the connection, system and impersonation doors.
   * The token is shape-checked and hashed HERE; only its hash reaches the ScopeDO, which
   * re-resolves it to its capability on every invoke and acknowledges that it did.
   */
  async getCapabilityScope(
    sessionToken: string,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ScopeStub> {
    if (!plausibleSessionToken(sessionToken)) {
      throw substratError('unauthenticated', 'not a capability session token');
    }
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const hash = await capabilityTokenHash(sessionToken);
    return this.buildStub(tenantId, scopeId, undefined, undefined, undefined, options, undefined, hash);
  }

  /**
   * The peer door (#1706) — mirror of the connection, system and capability doors. `caller`
   * is the platform's word (the router's, on the hosted path); the pair and lifecycle gate run
   * here, and the ScopeDO admits the peer inside its queue on every invoke and acknowledges it.
   */
  async getVerticalScope(
    caller: VerticalCaller,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ScopeStub> {
    const parsed = verticalCaller.parse(caller);
    await this.peerScopeGate(tenantId, scopeId, 'getVerticalScope');
    // #2029: gated against the rewind hold and pinned, as the system door is.
    const door = await this.openDoor('peer', parsed.vertical, scopeId);
    return this.buildStub(tenantId, scopeId, undefined, undefined, door, options, undefined, undefined, parsed);
  }

  /**
   * Does peer `vertical` hold each key at this scope's node now (#1706) — the ScopeDO's own
   * checker, so it answers what an invoke would be told, switch included.
   */
  async peerCovers(
    tenantId: TenantId,
    scopeId: ScopeId,
    vertical: string,
    permissions: readonly PermissionKey[],
  ): Promise<PeerCoverage[]> {
    await this.peerScopeGate(tenantId, scopeId, 'peerCovers');
    const slug = verticalSlug.parse(vertical);
    // #2029: a peer the rewind hold keeps off holds nothing here, as a switched-off one doesn't.
    const door = await this.openDoor('peer', slug, scopeId);
    try {
      return peerCoverage
        .array()
        .parse(
          await door.through((instance) =>
            this.scopeStub(scopeId).peerCovers(tenantId, scopeId, slug, [...permissions], instance),
          ),
        );
    } catch (err) {
      if (this.isHeldRefusal(err)) return permissions.map((permission) => ({ permission, held: false }));
      throw err;
    }
  }

  /**
   * `ctx.canAssign`'s bound for a principal the host names (#1931) — the ScopeDO's own role read
   * and checker, so it answers what that principal's operation would be told. Gated like
   * `peerCovers`: the (tenant, scope) pair, the lifecycle, and the served-here refusal.
   */
  async canAssign(tenantId: TenantId, scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<Coverage> {
    // CP-less, the gate below has no directory to hold the (tenant, scope) pair against, and a
    // scope asked under the wrong tenant would read that tenant's (empty) role table and answer
    // "no such role" — which the invite revoke treats as "confers nothing". The scope's own
    // provisioning receipt is K-3 here (#1738), read before anything migrates the DO, and the
    // refusal reads as the pure host's does: an unknown scope, not an unknown role.
    if (this.cpLess && !(await this.scopeStub(scopeId).servesTenant(tenantId))) {
      throw unknownScopeForTenant(tenantId, scopeId);
    }
    await this.peerScopeGate(tenantId, scopeId, 'canAssign');
    const bound = await this.scopeStub(scopeId).canAssignFor(tenantId, scopeId, principalId.parse(principal), roleKey);
    if (!bound) throw unknownRoleError(roleKey);
    return coverage.parse(bound);
  }

  async assignScopeRoleBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, assignee: PrincipalId, roleKey: string,
  ): Promise<Coverage> {
    if (this.cpLess && !(await this.scopeStub(scopeId).servesTenant(tenantId))) {
      throw unknownScopeForTenant(tenantId, scopeId);
    }
    await this.peerScopeGate(tenantId, scopeId, 'assignScopeRoleBounded');
    const bound = await this.scopeStub(scopeId).assignScopeRoleBoundedFor(
      tenantId, scopeId, principalId.parse(caller), principalId.parse(assignee), roleKey,
    );
    if (!bound) throw unknownRoleError(roleKey);
    return coverage.parse(bound);
  }

  async listScopeRoleHolders(tenantId: TenantId, scopeId: ScopeId, principal?: PrincipalId): Promise<ScopeRoleHolder[]> {
    await this.scopeRoleGate(tenantId, scopeId, 'listScopeRoleHolders');
    return this.scopeStub(scopeId).scopeRoleHoldersFor(scopeId, principal === undefined ? undefined : principalId.parse(principal));
  }

  async changeScopeRoleBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId, from: string, to: string,
  ): Promise<Coverage> {
    await this.scopeRoleGate(tenantId, scopeId, 'changeScopeRoleBounded');
    const target = principalId.parse(principal);
    const bound = await this.scopeStub(scopeId).changeScopeRoleBoundedFor(
      tenantId, scopeId, principalId.parse(caller), target, from, to,
    );
    if (bound === 'not-held') throw substratError('conflict', `${target} does not hold '${from}' at this scope`);
    if (bound === 'unknown-to') throw unknownRoleError(to);
    return coverage.parse(bound);
  }

  async revokeScopeRolesBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId,
  ): Promise<{ coverage: Coverage; revoked: string[] }> {
    await this.scopeRoleGate(tenantId, scopeId, 'revokeScopeRolesBounded');
    const result = await this.scopeStub(scopeId).revokeScopeRolesBoundedFor(
      tenantId, scopeId, principalId.parse(caller), principalId.parse(principal),
    );
    return { coverage: coverage.parse(result.coverage), revoked: result.revoked };
  }

  /** The (tenant, scope) gate the scope-role verbs share — `assignScopeRoleBounded`'s two checks. */
  private async scopeRoleGate(tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<void> {
    if (this.cpLess && !(await this.scopeStub(scopeId).servesTenant(tenantId))) {
      throw unknownScopeForTenant(tenantId, scopeId);
    }
    await this.peerScopeGate(tenantId, scopeId, verb);
  }

  /**
   * Where a peer verb (#1706) may reach a scope: its own ScopeDO, after the ordinary pair and
   * lifecycle gate. Refused, loudly, on the SHARED control plane for a scope bound to a
   * vertical, whose storage lives in that vertical's deployment — reaching through
   * `this.scopeStub` there would open an empty DO in the wrong namespace. On the hosted path a
   * peer reaches the target deployment itself, through the platform, never through this host.
   */
  private async peerScopeGate(tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<ScopeRow | undefined> {
    // K-3's pair check runs HERE, not only inside the ControlPlaneDO (#1714 review). An error
    // thrown in a Durable Object arrives at the coordinator FLATTENED — its code and
    // extensions gone — so a typed refusal thrown there reaches a caller untyped, which this
    // door's own tenant-confinement test proved. A RECORD crosses intact, so the coordinator
    // reads the record and types the refusal itself. `validateScopeAccess` still runs below
    // and still owns the lifecycle half (a suspended tenant or scope).
    let record: ScopeRow | undefined;
    if (!this.cpLess) {
      record = await this.cp.getScopeRecord(tenantId, scopeId);
      if (!record) {
        throw unknownScopeForTenant(tenantId, scopeId);
      }
      this.assertServedHere(record, scopeId, verb);
    }
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return record;
  }

  /**
   * Whether this scope is held inert (#2005): a fork, a snapshot or a preview, which causes no
   * outbound effects and consumes no other vertical's events (#2004). The one primacy question
   * every such door asks. Where there is a directory its record answers (`record`, the one
   * `peerScopeGate` returns, when the caller has already read it). A CP-less host has none, so it asks the scope's own storage
   * whether it is classified a copy (`_substrat_copy_origin`'s `is_copy`, #2009, set on the
   * directory's word): a preview and a snapshot reach a hosted vertical as restores the
   * platform marks.
   */
  private isInertScope(tenantId: TenantId, scopeId: ScopeId, record?: ScopeRow): Promise<boolean> {
    if (this.cpLess) return this.scopeStub(scopeId).isCopy();
    if (record) return Promise.resolve(!isPrimaryScopeRow(record));
    return this.cp.getScopeRecord(tenantId, scopeId).then((row) => !isPrimaryScopeRow(row));
  }

  /**
   * The capability's attachment door (#1686) — `getCapabilityScope`'s gate, then the
   * attachment surface with only the session's HASH going on to the ScopeDO. The DO
   * resolves it inside its queue on every call, checks each read as `{ capability }` and
   * refuses each write; the bytes stay on this side, as on every attachment path.
   */
  async getCapabilityAttachments(
    sessionToken: string,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeAttachments> {
    if (!plausibleSessionToken(sessionToken)) {
      throw substratError('unauthenticated', 'not a capability session token');
    }
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    const capabilitySession = await capabilityTokenHash(sessionToken);
    return this.buildAttachmentSurface({ capabilitySession }, tenantId, scopeId, store);
  }

  /**
   * Is this the SHARED control plane's host — the one whose own `SCOPE` namespace holds no
   * hosted scope's storage, and which routes scope writes to the serving deployment? The
   * delegations are set on that host and no other (their own docs say so), so any one of
   * them being present is the signal.
   */
  /**
   * Refuse a scope this host does not serve (#1706's door, and #1705's three cross-vertical
   * verbs).
   *
   * On the shared control plane `this.scopeStub` is the module-less placeholder namespace, so
   * reaching it for a scope bound to a vertical answers from an EMPTY Durable Object: a read
   * reports a hosted producer as having nothing to export, and a delivery would journal a
   * batch into a scope that is not the one it names. Both are wrong ANSWERS rather than
   * failures, which is the shape that goes unnoticed. One refusal, shared by the door's gate
   * and by the verbs that read a record of their own, so a caller never meets two of them.
   */
  private assertServedHere(record: { vertical: string | null }, scopeId: ScopeId, verb: string): void {
    if (this.servesScopesElsewhereNow && record.vertical !== null) {
      throw substratError(
        'unavailable',
        `${verb} cannot reach scope ${scopeId}: it is served by the '${record.vertical}' deployment, ` +
          'which a peer reaches through the platform, not through the shared control plane',
      );
    }
  }

  /** `ScopeHost.servesScopesElsewhere` (#1705 PR 3): any delegation set means the shared control plane. */
  servesScopesElsewhere(): boolean {
    return this.servesScopesElsewhereNow;
  }

  private get servesScopesElsewhereNow(): boolean {
    return Boolean(
      this.connectorDelegation ||
        this.systemSwitchDelegation ||
        this.peerSwitchDelegation ||
        this.eventDrainDelegation ||
        this.importCursorDelegation,
    );
  }

  /**
   * Where a platform capability verb (#1672) may write: this host's own ScopeDO — refused,
   * loudly, on the shared control plane for a scope bound to a vertical, whose storage lives
   * in that vertical's deployment. Writing through `this.scopeStub` there would mint into
   * an empty DO of the wrong namespace, a capability nobody could ever exchange. Delegating
   * these verbs to the serving deployment (as the schedule switch is) is a follow-up; the
   * claim-link migration is the first caller that needs it.
   */
  private async capabilityScopeStub(tenantId: TenantId, scopeId: ScopeId, verb: string) {
    const rec = await this.cp.getScopeRecord(tenantId, scopeId);
    if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
    if (this.servesScopesElsewhereNow && rec.vertical !== null) {
      throw substratError(
        'unavailable',
        `${verb} cannot reach scope ${scopeId}: it is served by the '${rec.vertical}' ` +
          'deployment, and platform capability verbs are not delegated there yet',
      );
    }
    await this.migrateAndRecord(scopeId);
    return { stub: this.scopeStub(scopeId), vertical: rec.vertical };
  }

  /** #1705: what this deployment imports — the sweep's reason to call no scope when it is empty. */
  registeredImports(): { from: string; type: string; schemaVersion: number }[] {
    return this.crossVertical.consumes();
  }

  registeredSchedules(): ScheduleRegistration[] {
    const out: ScheduleRegistration[] = [];
    for (const [moduleId, schedules] of this.moduleSchedules) {
      if (schedules.length > 0) out.push({ moduleId: moduleId as ModuleId, schedules });
    }
    return out;
  }

  registeredFreshness(): FreshnessRegistration[] {
    const out: FreshnessRegistration[] = [];
    for (const [moduleId, freshness] of this.moduleFreshness) {
      if (freshness.length > 0) out.push({ moduleId: moduleId as ModuleId, freshness });
    }
    return out;
  }

  /**
   * The freshness evaluator (#1232), CF half — same verdicts and gating as the pure
   * adapter's, over one `freshnessProbe` round trip to the scope DO. Aggregates
   * across EVERY registered module (two modules declaring one type share one
   * gating-state key and one dedupe unit — per-module evaluation would corrupt
   * both), collapsing duplicates to the tightest window; called once per scope,
   * any registered module's id as the entry ticket. NOT gated on the system
   * grant — see the kernel interface doc.
   */
  async checkFreshness(moduleId: ModuleId, tenantId: TenantId, scopeId: ScopeId): Promise<FreshnessReport> {
    const report: FreshnessReport = { checks: [] };
    if (!this.moduleIds.has(moduleId)) return report;
    if (!this.cpLess) {
      const rec = await this.cp.getScopeRecord(tenantId, scopeId);
      if (!rec || rec.status !== 'active') return report;
    } else if (lifecycleRefusal(await this.validateScopeAccess(tenantId, scopeId)) !== null) {
      // #2016: the pair is held to the scope's own record first, so a sweep roster entry whose
      // tenant disagrees with the scope is refused before the probe reads or writes anything.
      // #1713: a held scope emits nothing, so judging it stale would only raise a false alarm.
      return report;
    }
    const stub = this.scopeStub(scopeId);
    const windows = new Map<string, number>();
    for (const specs of this.moduleFreshness.values()) {
      for (const f of specs) {
        const prev = windows.get(f.eventType);
        if (prev === undefined || f.within.hours < prev) windows.set(f.eventType, f.within.hours);
      }
    }
    if (windows.size === 0) return report;
    const probe = await stub.freshnessProbe([...windows.keys()]);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    for (const [eventType, withinHours] of windows) {
      const p = probe[eventType] ?? { observedAt: null, stateAt: null, stateOutcome: null };
      const outcome: FreshnessReport['checks'][number]['outcome'] =
        p.observedAt === null
          ? 'skipped' // never observed — the never-run analogue, not a failure
          : now - Date.parse(p.observedAt) <= withinHours * 3_600_000
            ? 'ok'
            : 'failed';
      const changed = p.stateOutcome !== outcome;
      const heartbeatDue =
        p.stateAt === null || now - Date.parse(p.stateAt) > FRESHNESS_HEARTBEAT_MINUTES * 60_000;
      if (!changed && !heartbeatDue) continue;
      // #1288: 'freshness', said rather than inferred from the key's prefix.
      await stub.recordScheduleRun(`freshness:${eventType}`, nowIso, outcome, 'freshness');
      report.checks.push({ eventType, outcome, observedAt: p.observedAt, withinHours });
    }
    return report;
  }

  async runDueSchedules(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScheduleRunReport> {
    const report: ScheduleRunReport = { fired: 0, skipped: 0, failed: 0, errors: [], runs: [] };
    const schedules = this.moduleSchedules.get(moduleId);
    if (!schedules || schedules.length === 0) return report;
    // Only run on a live scope of this tenant; a scope archived between the sweep's
    // enumeration and here simply has nothing due. A CP-less host has no directory
    // to ask (#461), so it reads the lifecycle the platform delivered to the scope (#1713), in
    // the same call that holds the pair to the scope's own record (#2016): a roster entry whose
    // tenant disagrees is refused before a grant, a cadence row or a run is read or written.
    if (!this.cpLess) {
      const rec = await this.cp.getScopeRecord(tenantId, scopeId);
      if (!rec || rec.status !== 'active') return report;
    } else if (lifecycleRefusal(await this.validateScopeAccess(tenantId, scopeId)) !== null) {
      // #1713: the lifecycle the platform delivered holds the scope. Every schedule is
      // `skipped` and no cadence row moves, as under the kill switch, so a schedule that
      // came due meanwhile fires once on the first pass after the scope is live again.
      for (const schedule of schedules) {
        report.skipped += 1;
        report.runs!.push({ operation: schedule.operation, outcome: 'skipped' });
      }
      report.lifecycleHeld = true;
      return report;
    }

    const stub = this.scopeStub(scopeId);
    // The grant IS the switch (#383), and the kill switch is its lever (#1666): the
    // kernel's `systemScheduleState`, the one predicate both adapters run. A scope that
    // never held the module's grant (a foreign vertical's) is a quiet no-op, exactly as
    // before. A scope switched OFF reports every schedule `skipped`, never `failed`, and
    // does not touch its cadence rows — so a restore fires a due schedule on the next pass.
    // #1819: a scope rewound to before its switch was pulled answers `on`, and the rewind held
    // the module outside the scope. Both are read by the system door's own gate (#1834), which
    // every fire below then goes through, pinned to the instance this read came from.
    const gate = await this.doorGate('system', scopeId, moduleId);
    if (gate.state === 'ungranted') return report;
    if (gate.error) report.errors.push({ operation: 'switch-hold', error: gate.error });
    if (gate.state === 'off' || gate.held) {
      for (const schedule of schedules) {
        report.skipped += 1;
        report.runs!.push({ operation: schedule.operation, outcome: 'skipped' });
      }
      report.switchedOff = true;
      return report;
    }
    const now = Date.now();
    const lines = asyncLinePass();
    let door: SubjectDoor | undefined;
    for (const schedule of schedules) {
      const last = await stub.scheduleLastRun(schedule.operation);
      const lastRun = last ? Date.parse(last) : null;
      const dueAt = lastRun === null ? -Infinity : lastRun + schedule.cadence.everyMinutes * 60_000;
      if (now < dueAt) {
        report.skipped += 1;
        report.runs!.push({ operation: schedule.operation, outcome: 'skipped' });
        continue;
      }
      // #1525: one id for THIS call, minted before the invoke so it is the same id
      // whether the operation succeeds or throws — an event or a denial the call
      // produces either way carries it, and so does the row below.
      const invocationId = ulid();
      let status: 'ok' | 'failed' = 'ok';
      // #1901: the run's line, under the call's own id — the one its `ctx.log` lines carry.
      const startedAt = Date.now();
      let emitted: EmittedReport | undefined;
      let failure: { error: unknown } | undefined;
      // #119: a purge horizon's batch was full and moved something — the schedule stays due, so the next pass continues.
      let stillDue = false;
      try {
        // The gate above already answered for this pass; a fire that meets a restarted scope
        // is gated again by the door (#1834).
        door ??= await this.openSystemDoor(moduleId, tenantId, scopeId, gate);
        const scope = this.buildStub(tenantId, scopeId, undefined, undefined, door);
        if (schedule.purge) {
          // #119: a purge horizon's schedule runs its operation once per due entity, each its own
          // call and transaction — and the SCOPE decides which are due and runs them, so purge
          // authority is never an argument any stub can pass (`runPurgeSweep`).
          const pass = await door.through((instance) => stub.runPurgeSweep(schedule.operation, tenantId, scopeId, instance));
          // The purges' events, delivered the way each invoke's own tail delivers them.
          await this.drainExecutors(tenantId, scopeId, null);
          stillDue = purgeStillDue(pass);
          const outcome = purgeReportOf(schedule.operation, schedule.purge.entityType, pass);
          report.errors.push(...outcome.errors);
          if (outcome.failure) throw outcome.failure;
        } else {
          await scope.invoke(schedule.operation, schedule.input, { invocationId, onEmitted: (r) => (emitted = r) });
        }
        report.fired += 1;
      } catch (err) {
        status = 'failed';
        failure = { error: err };
        report.failed += 1;
        if (!schedule.purge) {
          report.errors.push({
            operation: schedule.operation,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      lines.write({
        kind: 'schedule',
        tenantId,
        scopeId,
        invocationId,
        operation: schedule.operation,
        startedAt,
        outcome: status,
        ...failure,
        dueAt: lastRun === null ? null : new Date(dueAt).toISOString(),
        latenessMs: lastRun === null ? null : now - dueAt,
        ...(emitted ? { emitted } : {}),
      });
      report.runs!.push({ operation: schedule.operation, outcome: status === 'ok' ? 'ok' : 'failed' });
      if (stillDue) continue;
      // #1288: 'schedule', whatever this operation happens to be called — including
      // `freshness:<something>`, which is exactly the row the evaluator no longer eats.
      await stub.recordScheduleRun(
        schedule.operation,
        new Date(now).toISOString(),
        status,
        'schedule',
        invocationId,
      );
    }
    lines.end();
    return report;
  }

  /** The stub body, shared by the principal, connection, system and impersonation doors. */
  private buildStub(
    tenantId: TenantId,
    scopeId: ScopeId,
    principal?: PrincipalId,
    connectionId?: ConnectionId,
    /**
     * #1834: the door this stub acts through. The ONLY way to make a stub acting as
     * `system:<moduleId>`: the module is the door's, and every invoke is gated and pinned by it.
     * #2029: a peer stub's door too (`openDoor('peer', …)`), gating and pinning each invoke the same way.
     */
    door?: SubjectDoor,
    options?: ScopeStubOptions,
    /**
     * K-42: the session this stub acts under. Re-read from the directory on
     * EVERY invoke rather than captured here — a stub is a capability and
     * nothing takes it away, so a session checked only at the door would be a
     * time box that never runs out for the one caller holding it, and
     * `endImpersonation` would stop nothing.
     */
    sessionId?: ImpersonationSessionId,
    /**
     * #1672: the HASH of a capability session token — the capability door hashed it and
     * the plaintext goes no further. The ScopeDO resolves it on every invoke, inside its
     * queue, and acknowledges it; see the refusal below for why the acknowledgement matters.
     */
    capabilitySession?: string,
    /**
     * #1706: the calling PEER vertical, as the platform named it. The ScopeDO admits it on
     * every invoke, inside its queue, and acknowledges it — the capability session's pattern.
     */
    verticalCaller?: VerticalCaller,
  ): ScopeStub {
    const stub = this.scopeStub(scopeId);
    const systemModuleId = door?.kind === 'system' ? (door.key as ModuleId) : undefined;
    const cp = this.cp;
    const operationEntitlement = this.operationEntitlement;
    // The DO needs SOME principal-shaped value for `ctx.principal`; for a
    // connection it is the connection id, for a schedule the module id, and the
    // honest attribution rides on the event actor instead. For a capability it is a
    // FRESH id nobody holds anything under (#1672): the DO replaces it with the resolved
    // capability, and a DO too old to know that would act as nobody rather than as someone.
    // A peer vertical (#1706) gets a fresh id too, for the same reason: the DO acts as the
    // admitted `{ vertical, scope }`, and a DO too old to know that acts as nobody.
    const asPrincipalId = (principal ??
      (connectionId as unknown as PrincipalId) ??
      (systemModuleId as unknown as PrincipalId) ??
      (capabilitySession !== undefined || verticalCaller !== undefined
        ? principalId.parse(ulid())
        : undefined)) as PrincipalId;

    return {
      tenantId,
      scopeId,
      // #1746: the door decided it — the same precedence `asPrincipalId` uses below.
      subjectKind:
        principal !== undefined
          ? 'principal'
          : connectionId !== undefined
            ? 'connection'
            : systemModuleId !== undefined
              ? 'system'
              : capabilitySession !== undefined
                ? 'capability'
                : verticalCaller !== undefined
                  ? 'vertical'
                  : undefined,
      invoke: async <O, I>(
        operation: string,
        input?: I,
        invokeOptions?: InvokeOptions,
      ): Promise<O> => {
        // #119: purge authority is never an invoke option — only the scope's own `runPurgeSweep`
        // purges — and an options object naming a cutoff is refused outright.
        assertNoCallerPurge(invokeOptions);
        // Entitlement gate (§4.3): a module loads for a tenant only if the tenant holds its
        // SKU flag. The COORDINATOR gates the console-managed path against the shared CP
        // (`cp.tenantHoldsEntitlement`); for a hosted/CP-less scope that call is a trusting
        // no-op, so the SAME `requiredKey` is passed to the DO, which fails closed against
        // its PROJECTED entitlements (#304). One or the other enforces, never neither.
        //
        // EXCEPTION (#1654): a module's own declared schedule, through this system door,
        // demands no SKU — its `system:<moduleId>` grant is the switch, as it already is for
        // permissions (#383). `requiredEntitlementFor` holds the whole rule and why; it
        // answers `undefined` there, so neither the coordinator nor the DO asks. Every other
        // door passes no `systemModuleId` and is gated exactly as before.
        const requiredKey = requiredEntitlementFor(
          operation,
          operationEntitlement.get(operation),
          systemModuleId,
        );
        if (requiredKey && !(await cp.tenantHoldsEntitlement(tenantId, requiredKey))) {
          // Required AND held (#691) — a second CP read, but only on the denial path.
          const now = new Date().toISOString();
          const all = await cp.listEntitlements(tenantId).catch(() => []);
          return Promise.reject(
            substratError(
              'not_found',
              entitlementDenial(
                operation,
                requiredKey,
                all.map((r) => ({
                  key: r.entitlement_key,
                  expired: r.expires_at !== null && r.expires_at <= now,
                })),
              ),
            ),
          );
        }
        // K-42: resolved per invoke, so expiry and `endImpersonation` both bite.
        const session =
          sessionId === undefined ? undefined : await this.resolveImpersonation(sessionId, tenantId, scopeId);
        const send = (systemDoorInstance?: string) =>
          stub.invoke(
            operation,
            input,
            asPrincipalId,
            tenantId,
            scopeId,
            connectionId,
            requiredKey,
            systemModuleId,
            true,
            invokeOptions,
            session,
            capabilitySession,
            verticalCaller,
            systemDoorInstance,
          );
        // #1834: through the door (a module's, or #2029 a peer's), pinned to the instance its gate
        // read. A missed pin comes back as an answer, which `through` re-gates on.
        const envelope = door
          ? await door.through(async (instance) => {
              const sent = await send(instance);
              return sent.systemDoorMoved === true ? SYSTEM_DOOR_MOVED : sent;
            })
          : await send();
        // The operation failed and the DO handed the error back as DATA — so it still
        // has its code and extensions, which a throw across this boundary would have
        // stripped down to a message (#113 §3). Rethrown here, where the caller expects
        // a throw: the envelope is the wire's shape, never the API's.
        if (envelope.failure) throw fromWireFailure(envelope.failure);
        // #129, and the order matters: the failure envelope is unwrapped FIRST, so a
        // legitimate `precondition_failed` reaches the caller as itself rather than
        // as the skew refusal below.
        //
        // Reaching here with an `ifMatch` and no acknowledgement means the DO did not
        // evaluate it — an instance still running code from before this landed. The
        // write has already committed; nothing here can undo it. What this refuses is
        // the SUCCESS: a caller told its conditional write succeeded, when in fact the
        // condition was never checked, will not retry and will not warn anyone.
        if (invokeOptions?.ifMatch !== undefined && envelope.concurrency?.ifMatchChecked !== true) {
          throw substratError(
            'unavailable',
            `${operation} ran on a scope host that did not evaluate If-Match — the write ` +
              'may have committed unconditionally. Retry once the scope has been migrated',
          );
        }
        // #116, the same shape and the sharper failure: an unacknowledged key means
        // the DO EXECUTED the operation rather than replaying a recording of it. The
        // write has committed and nothing here can undo it; what this refuses is the
        // success, because a caller told its retry was deduplicated will retry again.
        if (
          invokeOptions?.idempotencyKey !== undefined &&
          envelope.idempotency?.keyHonoured !== true
        ) {
          throw substratError(
            'unavailable',
            `${operation} ran on a scope host that did not honour Idempotency-Key — the ` +
              'operation may have executed a second time. Retry once the scope has been migrated',
          );
        }
        // K-42, and the same shape as the two skew refusals above with a sharper
        // reason: a DO too old to know about sessions ran this as the impersonated
        // principal with nothing stamped and no read-only bound. The write has
        // committed; what this refuses is the SUCCESS, because a support session
        // believed to be recorded and bounded is worse than no support session.
        // #1672, the same shape: a DO too old to know about capability sessions ignored the
        // hash and ran the call as the fresh placeholder principal, who holds nothing — so
        // the likely outcome is a refusal, but a SUCCESS here would have been decided
        // without the capability's grant, its allowlist or its liveness, and is refused.
        if (capabilitySession !== undefined && envelope.capability?.honoured !== true) {
          throw substratError(
            'unavailable',
            `${operation} ran on a scope host that did not understand capability sessions. ` +
              'Retry once the scope has been migrated',
          );
        }
        // #1706, the same shape: a DO too old to know about peer callers ran the call as the
        // fresh placeholder principal — without the peer's admission, its allowlist or its
        // switch. A success decided that way is refused.
        if (verticalCaller !== undefined && envelope.vertical?.honoured !== true) {
          throw substratError(
            'unavailable',
            `${operation} ran on a scope host that did not understand peer callers. ` +
              'Retry once the scope has been migrated',
          );
        }
        // #1834, the same shape: a DO too old to know the door's pin ran the call without
        // checking it met the storage the door's gate read.
        if (door !== undefined && envelope.systemDoor?.honoured !== true) {
          throw substratError(
            'unavailable',
            `${operation} ran on a scope host that did not understand the system door's pin. ` +
              'Retry once the scope has been migrated',
          );
        }
        if (session !== undefined && envelope.impersonation?.honoured !== true) {
          throw substratError(
            'unavailable',
            `${operation} ran on a scope host that did not understand impersonation — the ` +
              'operation may have run unrecorded and unbounded. Retry once the scope has ' +
              'been migrated',
          );
        }
        // K-42, the coordinator half of the pure adapter's post-commit guard: a
        // read-only session's transaction was rolled back, so it added nothing to
        // this scope's outbox — and draining anyway would run executors and
        // connectors as a side effect of a session that may not have side effects.
        // Whatever the outbox already held is the drain sweep's own backstop.
        // #1184: what this call's executors did inline, for `onExecutorOutcomes`.
        const executorOutcomes: ExecutorOutcome[] | undefined = invokeOptions?.onExecutorOutcomes ? [] : undefined;
        const drained =
          session?.mode === 'read-only'
            ? { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0, routedToPlatform: 0 }
            // #1525: this drain is part of the call that emitted the events — the
            // coordinator's half of the post-commit tail the DO ran the consumers in.
            : await this.drainExecutors(tenantId, scopeId, invokeOptions?.invocationId ?? null, executorOutcomes);
        // #458: the operation committed having enqueued platform intents — tell the
        // caller's harness so it can flag the response for the router kick (#381).
        // Routed connector deliveries (#574 phase 3) count too: the inline drain just
        // turned this operation's event into a `connector:<provider>` intent, and the
        // kick is what collapses its dispatch latency from sweep-cadence to seconds.
        const enqueued = envelope.platformRequests + (drained.routedToPlatform ?? 0);
        if (enqueued > 0) options?.onPlatformRequests?.(enqueued);
        if ((envelope.exported ?? 0) > 0) options?.onExportedEvents?.(envelope.exported!);
        if (envelope.concurrency) invokeOptions?.onEntityVersion?.(envelope.concurrency.version);
        if (envelope.idempotency?.replayed) invokeOptions?.onIdempotentReplay?.();
        if (envelope.emitted) invokeOptions?.onEmitted?.(envelope.emitted);
        if (executorOutcomes && session?.mode !== 'read-only' && !envelope.idempotency?.replayed) {
          invokeOptions?.onExecutorOutcomes?.(executorOutcomes);
        }
        return envelope.result as O;
      },
    };
  }

  async close(): Promise<void> {
    // Nothing to drain: every admin write awaits its RPC to completion inline.
  }

  // -- admin surface --------------------------------------------------------

  /** #977: this host, with every admin row it writes naming who the actor acted for. */
  attributed(onBehalfOf: OnBehalfOf, options?: { causedBy?: string }): this {
    return attributedView(this, { onBehalfOf, causedBy: options?.causedBy }, this.buildAdmin);
  }

  /** #2055: this host, with every admin row it writes naming `eventId` as its cause. */
  private causedByView(eventId: string): this {
    return attributedView(this, { causedBy: eventId }, this.buildAdmin);
  }

  private buildAdmin(): HostAdmin {
    // The directory row → the `scope` contract. Parsed, not cast: the columns are
    // nullable in the DO's SQLite (ALTER TABLE cannot add NOT NULL to a populated
    // table) while the contract requires them, so this parse is where that gap is
    // held shut — and it is the same parse the pure adapter does, which is what
    // makes the shared contract suite meaningful.
    const mapHostname = (r: HostnameRow): HostnameBinding =>
      hostnameBinding.parse({
        hostname: r.hostname,
        tenantId: r.tenant_id,
        scopeId: r.scope_id,
        verticalSlug: r.vertical_slug,
        surface: r.surface,
        region: r.region,
        status: r.status,
        statusNote: r.status_note,
        canonical: r.canonical === 1,
        createdAt: r.created_at,
        customHostnameId: r.custom_hostname_id,
        validationRecords: parseValidationRecords(r.validation_records),
      });

    const mapVertical = (r: VerticalRow): Vertical =>
      verticalSchema.parse({
        slug: r.slug,
        name: r.name,
        source: r.source,
        ownerTenant: r.owner_tenant,
        ...(r.env_spec ? { envSpec: JSON.parse(r.env_spec) } : {}),
        ...(r.install_spec ? (JSON.parse(r.install_spec) as Record<string, unknown>) : {}),
        listed: !!r.listed,
        ...(r.publish_requested_at ? { publishRequestedAt: r.publish_requested_at } : {}),
        installsBlocked: !!r.installs_blocked,
        tenantProvisioner: !!r.tenant_provisioner,
        emailSender: !!r.email_sender,
        ...(r.serving_ref ? { servingRef: r.serving_ref } : {}),
        ...(r.serving_version_id ? { servingVersionId: r.serving_version_id } : {}),
        createdAt: r.created_at,
      });
    // A listed version carries its surfaces as lifted JSON text, not its manifest (#1677):
    // read on exactly `outboundOfManifestJson`'s terms, so the two reads agree.
    const stringListOfJson = (json: string | null): string[] | null => {
      if (!json) return null;
      try {
        const v = JSON.parse(json) as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
      } catch {
        return null;
      }
    };
    const mapVersion = (r: VersionRow): VerticalVersion =>
      versionRecord(r, outboundOfManifestJson(r.manifest_json), callsOfManifestJson(r.manifest_json));
    const mapListedVersion = (r: VersionListRow): VerticalVersion =>
      versionRecord(r, stringListOfJson(r.outbound_json), stringListOfJson(r.calls_json));
    const versionRecord = (
      r: Omit<VersionRow, 'manifest_json'>,
      outbound: string[] | null,
      calls: string[] | null,
    ): VerticalVersion =>
      verticalVersion.parse({
        id: r.id,
        verticalSlug: r.vertical_slug,
        version: r.version,
        manifestDigest: r.manifest_digest,
        permissionDigest: r.permission_digest,
        migrationDigest: r.migration_digest,
        deploymentRef: r.deployment_ref,
        admission: r.admission,
        admissionNote: r.admission_note,
        origin: r.origin_json ? JSON.parse(r.origin_json) : null,
        outbound,
        calls,
        createdAt: r.created_at,
      });

    const mapOrg = (r: OrgRow): Org =>
      orgSchema.parse({
        id: r.org_id,
        tenantId: r.tenant_id,
        slug: r.slug,
        name: r.name,
        createdAt: r.created_at,
      });

    /**
     * Fail closed on an org that does not exist in this tenant. Scoped by tenant, not
     * just by id: an org from another tenant must read as absent, or grantToOrg would
     * reach across the boundary the record exists to make explicit.
     */
    const requireOrg = async (tenant: TenantId, id: OrgId): Promise<void> => {
      if (!(await this.cp.readOrg(tenant, id))) {
        throw substratError('not_found', `unknown org ${id} in tenant ${tenant}`);
      }
    };

    const mapScope = (r: ScopeRow): Scope =>
      scopeSchema.parse({
        id: r.scope_id,
        tenantId: r.tenant_id,
        parentScopeId: r.parent_scope_id,
        slug: r.slug,
        kind: r.kind,
        name: r.name,
        status: r.status,
        storageShape: r.storage_shape,
        // Legacy NULL means "unconstrained", which is `global` now (K-32) — coerce
        // on read so an old directory row parses against the non-nullable enum.
        jurisdiction: r.jurisdiction ?? 'global',
        vertical: r.vertical,
        schemaVersion: r.schema_version,
        verticalVersionId: r.vertical_version_id,
        provisionedVersionId: r.provisioned_version_id ?? null,
        migrationFailure:
          r.migration_failed_version && r.migration_last_attempt_at
            ? {
                version: r.migration_failed_version,
                error: r.migration_error ?? '',
                attempts: r.migration_attempts,
                lastAttemptAt: r.migration_last_attempt_at,
              }
            : null,
        forkedFrom: r.forked_from,
        forkedAt: r.forked_at,
        expiresAt: r.expires_at,
        ...(r.serving_ref ? { servingRef: r.serving_ref } : {}),
        archivedAt: r.archived_at ?? null,
        createdAt: r.created_at,
      });
    // The (version, scope) pair a bind and its impact read both start from, and the refusals
    // that come before any export-break question, in the order the bind makes them (#1756).
    const bindTarget = async (tenantId: string, scopeId: string, versionId: string) => {
      const v = await this.cp.readVersion(versionId);
      if (!v) throw substratError('not_found', `unknown version ${versionId}`);
      const scope = await this.cp.getScopeRecord(tenantId, scopeId);
      if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
      // The refusal the registry exists for — but scoped to a SERVING bind. Admission
      // gates code reaching an install; a PREVIEW fork is the builder's own tenant's data
      // at a non-canonical URL, serving no install, so it may run pending PR code — the
      // same own-tenant blast radius that lets a private vertical self-admit. This is what
      // lets a LISTED vertical's builder still preview their own new code (marketplace-publish.md
      // §2; issue #509 ask (d)). Every other scope kind keeps the refusal.
      if (v.admission !== 'admitted' && scope.kind !== 'preview') {
        throw substratError(
          'conflict',
          `version ${versionId} is ${v.admission}, not admitted — it cannot be bound to a scope`,
        );
      }
      return { v, scope };
    };

    const transitionScope = async (
      actor: PlatformActorId,
      action: AdminAction,
      tenantId: TenantId,
      scopeId: ScopeId,
      from: ScopeStatus[],
      to: ScopeStatus,
      // Extra `after` fields for transitions that carry more than the new status —
      // reap's `backupRef` (#493) is the first. Kept out of `before` deliberately: it
      // describes what the transition DID, not the state it left.
      afterExtra?: Record<string, unknown>,
    ) => {
      // The DO answers a refusal as data (#1718): a throw from there would arrive here
      // flattened, its code gone. The pair check stays in the DO, in the same read as the
      // write, so a row deleted concurrently is still refused `not_found`.
      const before = await this.cp.transitionScopeOrRefusal(tenantId, scopeId, from, to, action);
      if (!before.ok) {
        throw before.code ? substratError(before.code, before.message) : new Error(before.message);
      }
      // The audit target carries the scope's vertical (control-plane.md §4.4:
      // "vertical stays null until §4.2 lifecycle actions that name one"). The DO
      // returns it with the previous status, so the trail cannot disagree with
      // the directory about which deployment the action touched.
      await this.recordAdmin(
        actor,
        action,
        { tenantId, scopeId, vertical: before.vertical },
        { status: before.status },
        { status: to, ...afterExtra },
      );
      // #1713: after the directory moved and the move was audited, never before or instead.
      await this.deliverLifecycles(actor, { scopeId });
    };

    const writeGrant = async (
      subject: string,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
      expiresAt?: string,
    ): Promise<void> => {
      if (entity) {
        await this.writeScopeTuple(
          node.scopeId!,
          subject,
          `granted:${permission}`,
          entityObjectRef(entity, 'HostAdmin'), // #1856: grant and grantToOrg both land here
          expiresAt ?? null,
        );
      } else if (node.scopeId) {
        await this.writeScopeTuple(
          node.scopeId,
          subject,
          `granted:${permission}`,
          `scope:${node.scopeId}`,
          expiresAt ?? null,
        );
      } else {
        await this.cp.writeTenantTuple(
          node.tenantId,
          subject,
          `granted:${permission}`,
          `tenant:${node.tenantId}`,
          expiresAt ?? null,
        );
      }
    };

    /**
     * Where one scope's kill switch of one kind lands — the ONE rule the operator's switch and
     * the #1674 re-assert share, so a re-assert moves exactly the switch an operator's OFF would
     * have. `kind` is a module's schedule switch (#1666) or a peer's (#1706, #2029); `key` is the
     * module id or the peer's slug.
     *
     * Where the write lands is the whole point of the delegation branch. The shared control
     * plane's own `SCOPE` namespace is the module-less placeholder, so a hosted scope's switch
     * has to be moved in the deployment serving it, over that kind's delegation; writing it here
     * would report a switch pulled while every schedule kept firing, or every peer call kept
     * being admitted. A scope bound to no vertical (#1666 review) has no deployment to delegate
     * to: its store is the DO here, so the switch moves (or answers `held: false`) here too.
     * Delegating it would throw "no deployment serving scope" instead.
     */
    const switchTarget = async (kind: SwitchKind, tenantId: TenantId, scopeId: ScopeId) => {
      let vertical: string | null = null;
      if (!this.cpLess) {
        const rec = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
        vertical = rec.vertical;
      }
      const hosted = this.cpLess || vertical !== null;
      const systemDelegation = kind === 'system' && hosted ? this.systemSwitchDelegation : undefined;
      const peerDelegation = kind === 'peer' && hosted ? this.peerSwitchDelegation : undefined;
      const delegated = systemDelegation !== undefined || peerDelegation !== undefined;
      // #1819: a scope whose store is here was rewound here, so `switchInScope` releases its
      // hold here too. A delegated move releases in the deployment serving the scope.
      // #1823 (#2030 for a peer): a subject whose only authority on the scope is a TENANT-level
      // grant has nothing in the scope's storage for the switch to find, so the directory says
      // whether it is held. A caller moving several reads them in one call and passes each in.
      // An OFF of a tenant-held MODULE is refused, after the far end answers, unless that answer
      // attests the evaluator that denies a tenant-level grant (`deniesTenantGrants`). A
      // deployment built before #1823 drops `tenantHeld`, still answers `held: true` (the module's
      // scope-level grants were there to switch), and keeps authorizing the tenant-level grant —
      // so its `held` alone would have the platform record a scope off that is not. A peer needs
      // no attestation: its door refuses on the marker in every build that has the peer switch at
      // all (`admitPeer` and `switchPeer` arrived together, #1714). Every OFF the platform drives
      // moves through here: an operator's (`switchSubjectAt`) and a re-assert's, which every carry
      // ends with.
      //
      // #2045 (Codex r3): whether a delegated deployment honours the switch fence is settled
      // BEFORE anything moves (`attestFence`, once per target), never after the fact by putting a
      // move back. Without the fence an ON is refused and an OFF goes through unfenced (see
      // `UnattestedSwitch`). A move a fenced deployment answers without the attestation still
      // throws, as defence in depth against a rollback between the preflight and the move.
      const delegation = systemDelegation ?? peerDelegation;
      let attested: Promise<boolean> | undefined;
      const attestFence = (): Promise<boolean> =>
        (attested ??= delegation ? delegation.fenceSupported({ tenantId, scopeId }) : Promise.resolve(true));
      const move = async (
        key: string,
        to: 'on' | 'off',
        at: string,
        tenantHeld: boolean | undefined,
        /** #2045: the switch call's fence — its operation id, or for a re-assert the record's. */
        fence: string,
      ): Promise<SwitchOutcome> => {
        const fenced = await attestFence();
        if (!fenced && to === 'on') throw new UnattestedSwitch(unfencedMessage(scopeId));
        const held = tenantHeld ?? (await this.cp.tenantHeldOf(kind, tenantId, [key], at)).length > 0;
        const outcome = await (systemDelegation
          ? systemDelegation.switch({ tenantId, scopeId, moduleId: key as ModuleId, to, tenantHeld: held, fence })
          : peerDelegation
            ? peerDelegation.switch({ tenantId, scopeId, vertical: key, to, tenantHeld: held, fence })
            : this.switchInScope(kind, scopeId, key, to, at, held, fence));
        // An unfenced OFF answers without `fenced`, and that is what the callers read it by.
        if (fenced && outcome.fenced !== true) throw new UnattestedSwitch(unfencedMessage(scopeId));
        if (outcome.superseded) return outcome;
        if (kind === 'system' && to === 'off' && held && outcome.held && outcome.deniesTenantGrants !== true) {
          throw new UnattestedSwitch(undeniedMessage(scopeId, key));
        }
        return outcome;
      };
      return { vertical, delegated, move, attestFence };
    };

    /**
     * One kill switch moved on one scope — the ONE body `revokeFromSystem` / `restoreToSystem`
     * (#1666) and `revokeFromPeer` / `restoreToPeer` (#1706) share, so the two levers cannot
     * disagree about the record, the audit, the readback or the undo (#2029). The audit row is
     * written HERE either way — a deployment's host is CP-less, and its `recordAdmin` is a no-op.
     */
    const switchSubjectAt = async (
      actor: PlatformActorId,
      kind: SwitchKind,
      node: { tenantId: TenantId; scopeId: ScopeId },
      key: string,
      reason: string,
      to: 'on' | 'off',
    ): Promise<{ operationId: string; outcome: SwitchOutcome; auditWarning?: string }> => {
      const { tenantId, scopeId } = node;
      const { vertical, delegated, move, attestFence } = await switchTarget(kind, tenantId, scopeId);
      const action = switchActionOf(kind, to);
      if (kind === 'peer') {
        // The peer door's gate (#1706): with a delegation, its lifecycle half (a suspended tenant
        // or scope cannot be switched), the `scopeStub` half being what the delegation replaces.
        // Without one, a hosted scope is refused `unavailable` rather than switched in the
        // placeholder namespace, where it would tombstone nothing a peer call reads.
        if (delegated) await this.validateScopeAccess(tenantId, scopeId);
        else await this.peerScopeGate(tenantId, scopeId, action);
      }
      // AUDIT FIRST (#1666 review): the intent row lands before anything moves, and the
      // outcome row after — every attempt, a repeat included. The scope's store and the
      // admin log are separate, so no order makes the pair atomic; this one fails toward
      // "an intent with no recorded outcome" and never toward "a switch that moved with no
      // audit row". A retry after a crash re-audits even though it answers `changed: false`.
      //
      // #2089: every outcome row goes through the kernel's `recordAuditOutcome`, as the control
      // plane's audited changes do. One that cannot be written is logged with the operation id,
      // never swallowed; the call still answers with its own error (or, applied, with success and
      // `auditWarning`), and the scheduled settle closes the intent as `unknown`.
      const operationId = ulid();
      const target = { tenantId, scopeId, vertical };
      const base = { operationId, ...switchAuditSubject(kind, key, to) };
      await this.recordAdmin(actor, action, target, null, { ...base, phase: 'intent', reason });
      const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
      const recordOutcome = (row: { phase: 'applied' | 'refused' | 'failed' } & Record<string, unknown>) =>
        recordAuditOutcome(() => this.recordAdmin(actor, action, target, null, { ...base, ...row }), {
          flow: `${kind}-switch`,
          operationId,
          phase: row.phase,
        }, (message, fields) => console.error(message, fields));
      // #2045 (Codex r3): the deployment's fence is attested BEFORE anything is recorded or moved. An
      // ON on a deployment built before it is refused here, with nothing written anywhere but the
      // audit. An OFF goes on: the kill switch must work on every deployment (see `UnattestedSwitch`).
      try {
        if (!(await attestFence()) && to === 'on') {
          throw substratError('precondition_failed', `${unfencedMessage(scopeId)} Nothing was switched.`);
        }
      } catch (err) {
        await recordOutcome({ phase: 'refused', error: errorOf(err) });
        throw err;
      }
      // The directory's record (#1674; #2029 for a peer), written BEFORE the scope moves, both
      // ways — see `recordSwitchedOn` and (#1823) `recordSwitchedOff` for why that order is the
      // safe one. #2045 (Codex r3): the same write marks the subject owed and clears the scope's
      // reconcile receipt, so from here on the scope converges to this record whatever happens to
      // the move. The mark goes only when the scope confirms the move under this call's fence.
      const at = new Date().toISOString();
      const record = { kind, tenantId, scopeId, key, actor, reason, operationId, at };
      let prior: SwitchRecordPrior;
      try {
        prior = to === 'on' ? await this.cp.recordSwitchedOn(record) : await this.cp.recordSwitchedOff(record);
      } catch (err) {
        // Nothing has moved: fail the call here, audited. An ON must not switch a scope on
        // whose record still says off (the next reconcile would switch it back off), and an
        // OFF must not leave a scope off that the record does not know of (#1823).
        await recordOutcome({ phase: 'failed', error: errorOf(err) });
        throw err;
      }
      // #2045: a newer call on this subject has recorded its position already: this one writes
      // nothing, here or in the scope, and says so.
      if (recordWriteSuperseded(prior, record)) {
        await recordOutcome({ phase: 'refused', superseded: true });
        throw substratError('conflict', switchSupersededMessage(kind, scopeId, key, to));
      }
      let outcome: SwitchOutcome;
      try {
        try {
          outcome = await move(key, to, at, undefined, operationId);
        } catch (first) {
          if (first instanceof UnattestedSwitch) throw first;
          // #2045 (Codex r2): one retry under this call's own fence — idempotent, and refused by
          // the scope if a newer call has moved it meanwhile.
          outcome = await move(key, to, new Date().toISOString(), undefined, operationId);
        }
      } catch (err) {
        // The move threw twice, or was answered by a deployment that could not attest it. Either
        // way it may have landed, and an older call's move may still be in flight behind it, so no
        // readback can settle the scope and nothing is put back: the record is this call's position
        // under the newest fence, and its write-ahead mark makes the next re-assert move the scope
        // to it, under that fence, whichever way it lies now.
        await recordOutcome({
          phase: err instanceof UnattestedSwitch ? 'refused' : 'failed',
          error: errorOf(err),
          recordKept: true,
          reassertOwed: true,
        });
        if (err instanceof UnattestedSwitch) throw substratError('precondition_failed', err.message);
        throw err;
      }
      // #2045: the scope has applied a newer call on this subject, so this move wrote nothing. The
      // record is that newer call's too (its write overwrote this one's, mark included), so nothing
      // is undone and no mark is this call's to clear.
      if (outcome.superseded) {
        await recordOutcome({ phase: 'refused', superseded: true });
        throw substratError('conflict', switchSupersededMessage(kind, scopeId, key, to));
      }
      // A call that held nothing moved nothing, so its record write is undone: left `off`, it
      // would switch the subject off the day it is installed; left `on`, the next reconcile of
      // a wiped scope would leave it running. Retried once; a failure of both lands on the
      // outcome row as `recordError`, and the call says so.
      //
      // The scope confirmed this call's move (or that there was nothing to move), so its mark goes.
      // Held nothing, it goes WITH the undo, in one directory transaction: the row put back carries
      // the prior call's older id, and no later re-assert confirms under a fence older than this
      // call's mark. An undo that fails twice leaves the record AND the mark this call's, and the
      // next re-assert confirms both under it. Held, a failed clear is not the call's: the mark only
      // costs the next re-assert one idempotent move under this same record.
      //
      // An unfenced OFF that held something (a deployment built before the fence) confirmed nothing
      // under its fence, so its mark stays for the first re-assert after the vertical is redeployed.
      const unfenced = outcome.held && outcome.fenced !== true;
      let recordError: string | null = null;
      let owedError: string | null = null;
      if (!outcome.held) {
        const undo = () => this.cp.restoreSwitchRecord(record, prior, true);
        recordError = await undo().then(
          () => null,
          () => undo().then(() => null, errorOf),
        );
      } else if (!unfenced) {
        owedError = await this.cp.clearSwitchOwed(kind, tenantId, scopeId, key, operationId).then(() => null, errorOf);
      }
      const unrecorded = await recordOutcome({
        phase: outcome.held ? 'applied' : 'refused',
        changed: outcome.changed,
        permissions: outcome.permissions,
        ...(unfenced ? { unfenced: true, reassertOwed: true } : {}),
        ...(recordError ? { recordError } : {}),
        ...(owedError ? { owedError } : {}),
      });
      if (!outcome.held) {
        throw substratError(
          'not_found',
          switchNotFoundMessage(kind, scopeId, key, to) +
            (recordError ? `; and its directory record could not be put back (${recordError})` : ''),
        );
      }
      return { operationId, outcome, ...(unrecorded ? { auditWarning: auditWarningOf('the switch', unrecorded) } : {}) };
    };

    /** #1666: move one module's schedule switch on one scope — see `HostAdmin.revokeFromSystem`. */
    const switchSystem = async (
      actor: PlatformActorId,
      raw: SystemSwitch,
      to: 'on' | 'off',
    ): Promise<SystemSwitchResult> => {
      const input = systemSwitch.parse(raw);
      const { operationId, outcome, auditWarning } = await switchSubjectAt(actor, 'system', input.node, input.moduleId, input.reason, to);
      return {
        operationId,
        moduleId: input.moduleId,
        schedules: to,
        changed: outcome.changed,
        permissions: outcome.permissions as PermissionKey[],
        ...(auditWarning ? { auditWarning } : {}),
      };
    };

    /** #1706: move one PEER's kill switch on one scope — see `HostAdmin.revokeFromPeer`. */
    const switchPeerAt = async (
      actor: PlatformActorId,
      raw: PeerSwitch,
      to: 'on' | 'off',
    ): Promise<PeerSwitchResult> => {
      const input = peerSwitch.parse(raw);
      const { operationId, outcome, auditWarning } = await switchSubjectAt(actor, 'peer', input.node, input.vertical, input.reason, to);
      return {
        operationId,
        vertical: input.vertical,
        calls: to,
        changed: outcome.changed,
        permissions: outcome.permissions as PermissionKey[],
        ...(auditWarning ? { auditWarning } : {}),
      };
    };

    /**
     * The status read's admin-log join (#1674): the `intent` row of the `revokeFromSystem`
     * still in force for each OFF module — actor, reason, when. Paired to its `applied` row
     * by `operationId`, so a refused or failed attempt is never read as the explanation
     * (`switchSystemSchedules`'s `held` check means one can only occur on a module this
     * scope has never switched off before, so it can never be what a currently-off module
     * is explained by — this is belt-and-braces, not a case that is expected to fire).
     */
    const lastSwitchedOffBy = async (
      tenantId: TenantId,
      scopeId: ScopeId,
      /** The revoking action, and the payload field naming its subject (#1706). */
      action: 'revokeFromSystem' | 'revokeFromPeer',
      key: 'moduleId' | 'vertical',
      subjects: Set<string>,
    ): Promise<Map<string, { actor: PlatformActorId; reason: string; at: Instant }>> => {
      const moduleIds = subjects;
      // `order: 'desc'` is load-bearing: the loop below takes the FIRST intent it sees per
      // module as the latest one, and `auditLog`'s own default is 'asc' (oldest first).
      const rows = await this.cp.auditLog({ tenantId, scopeId, action: [action], order: 'desc' });
      const appliedOps = new Set<string>();
      for (const row of rows) {
        const payload = row.after as { phase?: string; operationId?: string } | null;
        if (payload?.phase === 'applied' && payload.operationId) appliedOps.add(payload.operationId);
      }
      const result = new Map<string, { actor: PlatformActorId; reason: string; at: Instant }>();
      for (const row of rows) {
        if (result.size === moduleIds.size) break;
        const payload = row.after as Record<string, unknown> | null;
        const subject = payload?.[key];
        if (!payload || payload.phase !== 'intent' || !payload.operationId || typeof subject !== 'string') continue;
        if (!moduleIds.has(subject) || result.has(subject)) continue;
        if (!appliedOps.has(String(payload.operationId)) || typeof payload.reason !== 'string') continue;
        result.set(subject, { actor: row.actor, reason: payload.reason, at: row.at });
      }
      return result;
    };

    /** #1674's join, bound to the schedule switch — the shape every caller here used. */
    const lastSwitchedOff = async (
      tenantId: TenantId,
      scopeId: ScopeId,
      moduleIds: Set<string>,
    ): Promise<Map<string, { actor: PlatformActorId; reason: string; at: Instant }>> =>
      lastSwitchedOffBy(tenantId, scopeId, 'revokeFromSystem', 'moduleId', moduleIds);

    /**
     * The status read (#1674): every module this scope holds or has held system authority
     * for, and where each stands — the SAME predicate `switchSystem` gates its writes on
     * (`systemScheduleState`, walked over every held subject by the kernel's
     * `systemGrantsStatus`), so the read and the runner cannot disagree. For a hosted
     * scope, delegated exactly as the write is (see `switchSystem` above): a deployment
     * built before #1666's route answers the same "redeploy the vertical", never a wrong
     * `on`. The admin-log join happens HERE only — never on the deployment, which holds
     * no admin log of its own.
     */
    const systemGrantsStatusOf = async (
      actor: PlatformActorId,
      node: { tenantId: TenantId; scopeId: ScopeId },
    ): Promise<SystemGrantsStatusEntry[]> => {
      const { tenantId, scopeId } = node;
      let vertical: string | null = null;
      if (!this.cpLess) {
        const rec = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
        vertical = rec.vertical;
      }
      // A hosted scope (a vertical bound, on a non-cpLess host) has no local storage worth
      // reading — its grants live in the deployment serving it, reachable only through the
      // delegation. Without one configured, the ternary below would silently fall to THIS
      // host's own placeholder DO and answer an unrelated (and likely empty) position as
      // if it were the scope's own — a fail-open wrong answer, not a fail-closed refusal.
      if (!this.cpLess && vertical !== null && !this.systemSwitchDelegation) {
        throw substratError(
          'unavailable',
          `no delegation configured for hosted scope ${scopeId} (vertical '${vertical}') — cannot read its schedule switches`,
        );
      }
      const delegation = this.cpLess || vertical !== null ? this.systemSwitchDelegation : undefined;
      // The scope's own position and the directory's record are independent reads.
      const [states, recordedRows] = await Promise.all([
        delegation
          ? delegation.status({ tenantId, scopeId })
          : this.scopeStub(scopeId).systemGrantsStatus().then((rows) => systemScheduleEntry.array().parse(rows)),
        this.cp.switchRecordsOf('system', tenantId, scopeId),
      ]);
      const offModules = new Set(states.filter((s) => s.schedules === 'off').map((s) => s.moduleId as string));
      const explanations =
        offModules.size > 0
          ? await lastSwitchedOff(tenantId, scopeId, offModules)
          : new Map<string, { actor: PlatformActorId; reason: string; at: Instant }>();
      const result = withRecorded(states, new Map(recordedRows)).map((s) => ({
        moduleId: s.moduleId as ModuleId,
        schedules: s.schedules,
        switchedOff: explanations.get(s.moduleId) ?? null,
        recorded: s.recorded,
      }));
      // K-24: reading the switch's position and any live incident reason is itself
      // access-logged, the same as every other HostAdmin read.
      await this.recordAccess(actor, 'systemGrantsStatus', { tenantId, scopeId }, null, result.length);
      return result;
    };

    /**
     * #1674: put the directory's OFF positions back into one scope — see
     * `HostAdmin.reassertSystemSwitches`. Every kind (#2029): the recorded-off modules, then the
     * recorded-off peers. Each moves through `switchTarget`, so it lands wherever an operator's
     * OFF would have — for a hosted scope, over that kind's `/internal/*` switch route.
     */
    const reassertSystemSwitchesOf = async (
      actor: PlatformActorId,
      node: { tenantId: TenantId; scopeId: ScopeId },
      opts?: SystemSwitchReassertOptions,
    ): Promise<SystemSwitchReassert[]> => {
      const results: SystemSwitchReassert[] = [];
      for (const kind of SWITCH_KINDS) results.push(...(await reassertKind(actor, kind, node, opts)));
      return results;
    };

    /** One kind's half of `reassertSystemSwitchesOf`. */
    const reassertKind = async (
      actor: PlatformActorId,
      kind: SwitchKind,
      node: { tenantId: TenantId; scopeId: ScopeId },
      opts?: SystemSwitchReassertOptions,
    ): Promise<SystemSwitchReassert[]> => {
      const { tenantId, scopeId } = node;
      const { vertical, delegated, move, attestFence } = await switchTarget(kind, tenantId, scopeId);
      const action = reassertActionOf(kind);
      const target = { tenantId, scopeId, vertical };
      const recorded = new Map(await this.cp.switchRecordsOf(kind, tenantId, scopeId));
      // #2045: every switch call's write-ahead mark, with the newest call that wrote it.
      const owed = new Map(await this.cp.switchesOwedOf(kind, tenantId, scopeId));
      // #1742 review: moves the deployment made from a stale list (restored ON after the list
      // was read), to undo before the OFF pass below.
      const reverts = staleCarryReverts(kind, recorded, opts?.appliedInUnit);
      // A hosted scope with no delegation configured (Copilot review): this host's own
      // namespace is the module-less placeholder, where the switch would answer `held: false`
      // quietly — a re-assert reported done, and a receipt written, while the deployment
      // serving the scope keeps its schedules running or its peer admitted. Refused loudly
      // instead, as the status read is, and only when a re-assert is owed: nothing recorded,
      // nothing to refuse.
      const reassertOwed = reverts.length > 0 || owed.size > 0 || [...recorded.values()].includes('off');
      if (reassertOwed && !this.cpLess && vertical !== null && !delegated) {
        throw substratError(
          'unavailable',
          `no delegation configured for hosted scope ${scopeId} (vertical '${vertical}') — cannot re-assert ` +
            `its switched-off ${DOOR_WORDS[kind].switched} in the deployment serving it`,
        );
      }
      // #2045 (Codex r3): a subject's mark goes only once the scope has confirmed a move under the
      // record's fence — a fenced answer that was not superseded. A throw anywhere below leaves
      // every mark not yet confirmed for the next pass.
      // An unfenced OFF (a deployment built before the fence) confirms nothing, so its mark stays.
      const confirm = async (key: string, fence: string, outcome: SwitchOutcome): Promise<void> => {
        if (owed.has(key) && !outcome.superseded && outcome.fenced === true) {
          await this.cp.clearSwitchOwed(kind, tenantId, scopeId, key, fence);
        }
      };
      // #2045 follow-up: on a deployment built before the fence no ON is sent (see
      // `UnattestedSwitch`). Every OFF below still moves, and the pass refuses at its end, so a
      // sweep records no receipt for a scope whose owed ON was not sent. Asked only when an ON is due.
      const onWithheld: string[] = [];
      const withholdOn = async (key: string): Promise<boolean> => {
        if (await attestFence()) return false;
        onWithheld.push(key);
        return true;
      };
      const at = new Date().toISOString();
      const reverted = new Set<string>();
      for (const key of reverts) {
        // Re-read immediately before the move: a staff OFF that completed since the read above
        // (record `off`) must not get a transient ON a due schedule, or a peer call, could use.
        // #2045: under the fence of the ON the record holds, which is the operator's own call — read
        // with the position, so it is that ON's fence and no other call's.
        const current = new Map(await this.cp.switchRecordStatesOf(kind, tenantId, scopeId)).get(key);
        if (current?.position !== 'on') continue;
        const fence = current.fence;
        if (await withholdOn(key)) continue;
        const outcome = await move(key, 'on', at, undefined, fence);
        reverted.add(key);
        if (outcome.changed) {
          await this.recordAdmin(actor, action, target, null, { operationId: ulid(), ...staleCarryRevertRow(kind, key, outcome) });
        }
        await confirm(key, fence, outcome);
      }
      // Read AFTER the reverts: an OFF that landed meanwhile is switched off below.
      const { keys, tenantHeld, fences } = await this.recordedOff(kind, tenantId, scopeId, at);
      // #1742: what the deployment already switched off inside its own unit, audited here —
      // the move below answers `changed: false` for it and would write no row. A move the
      // revert above undid is not credited as an in-unit OFF.
      for (const row of inUnitMovesToAudit(kind, keys, opts?.appliedInUnit, reverted)) {
        await this.recordAdmin(actor, action, target, null, { operationId: ulid(), ...row });
      }
      // #2045: every move here carries the fence of the call the record holds, so a scope a newer call
      // has moved since refuses it. A deployment from before the fence takes the OFF unfenced.
      const results: SystemSwitchReassert[] = [];
      const held = new Set(tenantHeld);
      for (const key of keys) {
        const fence = fences.get(key)!; // `recordedOff` read each key with its own row's fence
        const outcome = await move(key, 'off', at, held.has(key), fence);
        if (outcome.changed) {
          await this.recordAdmin(actor, action, target, null, {
            operationId: ulid(),
            ...reassertOffRow(kind, key, outcome.permissions),
            ...(outcome.fenced === true ? {} : { unfenced: true }),
          });
        }
        results.push(reassertEntry(kind, key, outcome));
        await confirm(key, fence, outcome);
      }
      // A subject marked owed converges to its record in either direction: OFF above, and here a
      // record of ON — sent whatever the scope reads now, because a scope that reads ON may still
      // be behind the record's fence, with an older call's OFF in flight that only the fence can
      // refuse (Codex r3, finding 1). Idempotent: an ON already in place changes nothing and moves
      // the fence. Every other record of ON keeps #1674's rule and turns nothing on.
      const settled = new Set([...keys, ...reverted]);
      const pending = [...owed.keys()].filter((key) => !settled.has(key));
      if (pending.length) {
        // Position and fence in one read: an ON is sent only under the fence of the ON it read.
        const now = new Map(await this.cp.switchRecordStatesOf(kind, tenantId, scopeId));
        for (const key of pending) {
          const row = now.get(key);
          if (row?.position !== 'on') {
            // No record (a call that held nothing, whose undo removed its row), or one that turned
            // OFF since the read above, which the next pass moves: nothing to send on this one. A
            // missing row's mark goes under its own id, so a newer call's mark stays.
            if (row === undefined) await this.cp.clearSwitchOwed(kind, tenantId, scopeId, key, owed.get(key)!);
            continue;
          }
          const fence = row.fence;
          if (await withholdOn(key)) continue;
          const outcome = await move(key, 'on', at, undefined, fence);
          if (outcome.changed) {
            await this.recordAdmin(actor, action, target, null, { operationId: ulid(), ...reassertOnRow(kind, key, outcome.permissions) });
            results.push(reassertEntry(kind, key, outcome));
          }
          await confirm(key, fence, outcome);
        }
      }
      if (onWithheld.length) {
        throw substratError(
          'precondition_failed',
          `${unfencedMessage(scopeId)} Its recorded OFF positions were applied; the owed ON of ` +
            `${onWithheld.map((k) => `'${k}'`).join(', ')} was not sent.`,
        );
      }
      return results;
    };

    /**
     * The peer switch's status read (#1706) — `systemGrantsStatusOf` with the subject
     * swapped, and delegated for the same reason the write is: a hosted scope's
     * `vertical:<slug>` grants live in the deployment serving it, and this host's own
     * namespace holds a placeholder no peer call ever consults. Reading the placeholder
     * would be confidently wrong rather than loudly unavailable, which on a kill switch's
     * status is the worse of the two, so a hosted scope with no delegation configured is
     * refused. The admin-log join happens HERE only — the deployment holds no admin log.
     */
    const peerGrantsStatusOf = async (
      actor: PlatformActorId,
      node: { tenantId: TenantId; scopeId: ScopeId },
    ): Promise<PeerGrantsStatusEntry[]> => {
      const { tenantId, scopeId } = node;
      let vertical: string | null = null;
      if (!this.cpLess) {
        const rec = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
        vertical = rec.vertical;
      }
      if (!this.cpLess && vertical !== null && !this.peerSwitchDelegation) {
        throw substratError(
          'unavailable',
          `no delegation configured for hosted scope ${scopeId} (vertical '${vertical}') — cannot read which ` +
            `peers may call it`,
        );
      }
      const delegation = this.cpLess || vertical !== null ? this.peerSwitchDelegation : undefined;
      const states = delegation
        ? await delegation.status({ tenantId, scopeId })
        : peerGrantsEntry.array().parse(await this.scopeStub(scopeId).peerGrantsStatus());
      const offPeers = new Set(states.filter((p) => p.calls === 'off').map((p) => p.vertical as string));
      const explanations =
        offPeers.size > 0
          ? await lastSwitchedOffBy(tenantId, scopeId, 'revokeFromPeer', 'vertical', offPeers)
          : new Map<string, { actor: PlatformActorId; reason: string; at: Instant }>();
      const result = states.map((p) => ({
        vertical: p.vertical,
        calls: p.calls,
        switchedOff: explanations.get(p.vertical) ?? null,
      }));
      await this.recordAccess(actor, 'peerGrantsStatus', { tenantId, scopeId }, null, result.length);
      return result;
    };

    return {
      // #2069: a view of the view this admin was built over — the person added, its event kept.
      attributed: (onBehalfOf: OnBehalfOf) => this.attributed(onBehalfOf).admin,
      // #603: fixed at construction — a worker deployed without SECRET_BOX_KEY can never
      // store a credential, and saying so is what lets a transport answer 503 instead of 500.
      canStoreSecrets: isSecretBoxConfigured(this.secretBox),
      defineRole: async (actor, tenantId, role) => {
        const parsed = roleDefinition.parse(role);
        const before = await this.cp.defineRole(tenantId, parsed);
        await this.recordAdmin(actor, 'defineRole', { tenantId }, before, parsed);
        await this.fanOut(tenantId); // role definitions are projected into the tenant's scopes
      },
      listRoles: async (actor, filter?: RoleFilter): Promise<TenantRole[]> => {
        const rows = await this.cp.listRoles({
          tenantId: filter?.tenantId,
          source: filter?.source,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        await this.recordAccess(actor, 'listRoles', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
        // Parsed, not cast — the same parse the pure adapter does, which is what
        // makes the shared contract suite mean anything.
        return rows.map((r) =>
          tenantRole.parse({
            tenantId: r.tenant_id,
            key: r.role_key,
            permissions: JSON.parse(r.permissions),
            source: r.source,
          }),
        );
      },
      assignRole: async (actor, assignment: RoleAssignment) => {
        const subject = `principal:${assignment.principalId}`;
        if (assignment.node.scopeId) {
          await this.writeScopeTuple(
            assignment.node.scopeId,
            subject,
            `role:${assignment.roleKey}`,
            `scope:${assignment.node.scopeId}`,
            null,
          );
        } else {
          await this.cp.writeTenantTuple(
            assignment.node.tenantId,
            subject,
            `role:${assignment.roleKey}`,
            `tenant:${assignment.node.tenantId}`,
            null,
          );
        }
        await this.recordAdmin(
          actor,
          'assignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          null,
          assignment,
        );
        // A scope-level assignment writes a scope tuple (already local); only a
        // tenant-level one changes the projected set and must fan out.
        if (!assignment.node.scopeId) await this.fanOut(assignment.node.tenantId);
      },
      unassignRole: async (actor, assignment: RoleAssignment) => {
        // Tombstone (K-21) — the checker skips revoked rows. A no-op returns false so
        // a repeat unassign stays silent (no second audit row, no needless fan-out).
        const relation = `role:${assignment.roleKey}`;
        const { tenantId, scopeId } = assignment.node;
        if (!scopeId) {
          // One ControlPlaneDO method (#1184): the revoke, the removal fence (raised even when
          // nothing was held) and the audit row, so no add can land between any two of them.
          const changed = await this.cp.revokeAndFence(
            tenantId,
            assignment.principalId,
            relation,
            `tenant:${tenantId}`,
            this.adminEntry(actor, 'unassignRole', { tenantId, scopeId: null }, assignment, null),
          );
          // A tenant-level revoke changes the projected set — the tombstone must reach scopes.
          if (changed) await this.fanOut(tenantId);
          return;
        }
        const changed = await this.scopeStub(scopeId).revokeTuple(
          `principal:${assignment.principalId}`,
          relation,
          `scope:${scopeId}`,
          new Date().toISOString(),
        );
        if (!changed) return;
        await this.recordAdmin(actor, 'unassignRole', { tenantId, scopeId }, assignment, null);
      },
      grant: async (actor, raw: CapabilityGrant) => {
        // Parsed like its `grantToConnection`/`grantToSystem` siblings, not taken on
        // trust: the parse is where an `expiresAt` carrying a UTC offset is normalised
        // to Z text (#963), and liveness here is a lexicographic `expires_at > ?`.
        const grant = capabilityGrant.parse(raw);
        await writeGrant(
          `principal:${grant.principalId}`,
          grant.permission,
          grant.node,
          grant.entity,
          grant.expiresAt,
        );
        await this.recordAdmin(
          actor,
          'grant',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          grant,
        );
        // Tenant-level grant → changes the projected set. Scope-level + entity
        // grants write scope tuples (already local), so they need no fan-out.
        if (!grant.node.scopeId) await this.fanOut(grant.node.tenantId);
      },
      grantEntityShape: async (actor, grant) => {
        await this.grantEntityShapeLocal(grant.node.scopeId, grant.principalId, grant.entity, grant.permissions);
        await this.recordAdmin(actor, 'grantEntityShape', grant.node, null, grant);
      },
      reconcileEntityGrantShapes: async (actor, node, shapes, opts) => {
        const toppedUp = await this.topUpEntityGrantShapesLocal(node.tenantId, node.scopeId, shapes, opts?.batch);
        if (toppedUp > 0) {
          await this.recordAdmin(actor, 'reconcileEntityGrantShapes', node, null, { shapes, toppedUp });
        }
        return { toppedUp };
      },
      grantToConnection: async (actor: PlatformActorId, raw: ConnectionGrant) => {
        const grant = connectionGrant.parse(raw);
        const conn = await this.cp.readConnection(grant.connectionId);
        if (!conn) throw new Error(`connection not found: ${grant.connectionId}`);
        if (conn.revoked_at) {
          throw new Error(`connection ${grant.connectionId} is revoked — grant nothing to it`);
        }
        // A grant may not reach outside what the connection already is: it is
        // keyed (tenant, vertical, provider), and letting it hold a permission
        // elsewhere would make that key decorative.
        if (conn.tenant_id !== grant.node.tenantId) {
          throw new Error(
            `connection ${grant.connectionId} belongs to tenant ${conn.tenant_id} and cannot ` +
              `be granted anything in ${grant.node.tenantId}`,
          );
        }
        if (grant.node.scopeId) {
          const scope = await this.cp.getScopeRecord(grant.node.tenantId, grant.node.scopeId);
          if (!scope) {
            throw substratError('not_found', `unknown scope ${grant.node.scopeId} in tenant ${grant.node.tenantId}`);
          }
          if (scope.vertical !== conn.vertical) {
            throw new Error(
              `connection ${grant.connectionId} is for vertical '${conn.vertical}' and scope ` +
                `${grant.node.scopeId} runs '${scope.vertical ?? 'none'}'`,
            );
          }
        }
        // #592: the directory-side record FIRST, so a grant whose tuple delivery
        // fails below is still gathered by the next provision/reconcile — the
        // repair channel — instead of vanishing. The tuple stays the only thing
        // the permission checker reads; this row is what the platform gathers
        // from so scopes provisioned AFTER the grant receive it too.
        await this.cp.recordConnectionGrant({
          connectionId: grant.connectionId,
          tenantId: grant.node.tenantId,
          vertical: conn.vertical,
          permission: grant.permission,
          scopeId: grant.node.scopeId ?? null,
          expiresAt: grant.expiresAt ?? null,
          grantedBy: grant.grantedBy,
          grantedAt: new Date().toISOString(),
        });
        // #574: a scope-level grant is a SCOPE tuple, and the scope's DO lives in the
        // deployment serving it — for the shared control plane that is the vertical's
        // dispatch script, so the tuple write rides the delegation seam. Tenant-level
        // grants stay directory-side either way.
        if (this.connectorDelegation && grant.node.scopeId) {
          await this.connectorDelegation.grant({
            connectionId: grant.connectionId as ConnectionId,
            tenantId: grant.node.tenantId,
            scopeId: grant.node.scopeId,
            vertical: conn.vertical,
            permission: grant.permission,
            expiresAt: grant.expiresAt,
          });
        } else {
          await writeGrant(
            subjectRef({ kind: 'connection', id: grant.connectionId }),
            grant.permission,
            grant.node,
            undefined,
            grant.expiresAt,
          );
        }
        await this.recordAdmin(
          actor,
          'grantToConnection',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId, vertical: conn.vertical },
          null,
          {
            connectionId: grant.connectionId,
            provider: conn.provider,
            permission: grant.permission,
            node: grant.node,
          },
        );
      },

      grantToSystem: async (actor: PlatformActorId, raw: SystemGrant) => {
        // The scheduler's grant (#383) — mirror of grantToConnection. Narrow: one
        // module, one permission; tombstones on revoke; shows in the permission diff.
        const grant = systemGrant.parse(raw);
        if (grant.node.scopeId) {
          // #1666: refused while the module is switched off on this scope — checked and
          // written in one DO unit. Restore is the lever; a grant is not.
          const written = await this.scopeStub(grant.node.scopeId).writeSystemGrant(
            grant.moduleId,
            `granted:${grant.permission}`,
            `scope:${grant.node.scopeId}`,
            grant.expiresAt ?? null,
          );
          if (!written) {
            throw substratError('conflict', systemSwitchedOffMessage(grant.moduleId, grant.node.scopeId));
          }
        } else {
          // #1743: refused while the record holds the module off on any scope — checked and
          // written in one control-plane call, where the record and the tenant tuple both live.
          const off = await this.cp.writeTenantSystemGrant(
            grant.node.tenantId,
            grant.moduleId,
            `granted:${grant.permission}`,
            grant.expiresAt ?? null,
          );
          if (off.length > 0) {
            throw substratError('conflict', tenantSystemSwitchedOffMessage(grant.moduleId, off));
          }
        }
        await this.recordAdmin(
          actor,
          'grantToSystem',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          { moduleId: grant.moduleId, permission: grant.permission, node: grant.node },
        );
        if (!grant.node.scopeId) await this.fanOut(grant.node.tenantId);
      },

      // #1666: the schedule kill switch and its lever back — `system-switch.ts` is the
      // whole rule, shared with the pure adapter; this is the directory check, the reach
      // into the scope's storage, and the audit row around it.
      peerGrantsStatus: peerGrantsStatusOf,
      revokeFromPeer: async (actor: PlatformActorId, raw: PeerSwitch) => switchPeerAt(actor, raw, 'off'),
      restoreToPeer: async (actor: PlatformActorId, raw: PeerSwitch) => switchPeerAt(actor, raw, 'on'),
      revokeFromSystem: async (actor: PlatformActorId, raw: SystemSwitch) => switchSystem(actor, raw, 'off'),
      restoreToSystem: async (actor: PlatformActorId, raw: SystemSwitch) => switchSystem(actor, raw, 'on'),
      // #1674: the switch's status read — same gate, same delegation, and (unlike the
      // deployment it may delegate to) the admin log to explain an `off` entry.
      systemGrantsStatus: systemGrantsStatusOf,
      // #1674: the directory's record of the switch — the fleet read, and the re-assert a
      // scope that lost its marker gets after a wipe or a restore.
      listSystemSwitches: async (actor: PlatformActorId, filter?: SystemSwitchRecordFilter) => {
        const rows = await this.cp.listSystemSwitches(filter);
        await this.recordAccess(
          actor,
          'listSystemSwitches',
          { tenantId: (filter?.tenantId as TenantId | undefined) ?? null },
          filter ?? null,
          rows.length,
        );
        return rows.map((r) => systemSwitchRecord.parse(r));
      },
      tenantHeldSystemModules: async (actor: PlatformActorId, tenantId: TenantId, moduleIds: readonly ModuleId[]) => {
        const held = moduleIds.length
          ? await this.cp.tenantHeldOf('system', tenantId, moduleIds, new Date().toISOString())
          : [];
        await this.recordAccess(actor, 'tenantHeldSystemModules', { tenantId }, { moduleIds: [...moduleIds] }, held.length);
        return held as ModuleId[];
      },
      peerSwitchCarry: async (actor: PlatformActorId, node: { tenantId: TenantId; scopeId: ScopeId }) => {
        const {
          keys: switchedOffPeers,
          tenantHeld: tenantHeldPeers,
          fences: all,
        } = await this.recordedOff('peer', node.tenantId, node.scopeId, new Date().toISOString());
        const fences = Object.fromEntries(switchedOffPeers.map((v) => [v, all.get(v)!]));
        await this.recordAccess(actor, 'peerSwitchCarry', node, null, switchedOffPeers.length);
        return { switchedOffPeers, tenantHeldPeers, fences };
      },
      reassertSystemSwitches: reassertSystemSwitchesOf,
      // #1672 — the platform's two capability verbs. Audited AFTER the write, on both, and
      // the failure each leaves is the safe one: a mint whose audit row did not land never
      // returned its secret, so nobody can ever exchange it; a revoke whose row did not land
      // has still revoked. Neither the secret nor its hash is ever in before/after.
      mintCapability: async (
        actor: PlatformActorId,
        tenantId: TenantId,
        scopeId: ScopeId,
        input: BecomeCapabilityInput,
      ): Promise<MintedCapability> => {
        // Checked HERE as well as in the DO: a typed refusal thrown across the RPC arrives as
        // a bare message, and the caller would lose `validation_failed`. One function, so the
        // two sides cannot disagree about what a valid mint is.
        checkBecomeInput(input, new Date().toISOString() as Instant);
        await this.validateScopeAccess(tenantId, scopeId);
        const { stub, vertical } = await this.capabilityScopeStub(tenantId, scopeId, 'mintCapability');
        const minted = await stub.mintBecomeCapability(input, actor);
        await this.recordAdmin(actor, 'mintCapability', { tenantId, scopeId, vertical }, null, {
          capabilityId: minted.id,
          mode: 'become',
          principal: input.principal,
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
          label: input.label ?? null,
        });
        return minted;
      },
      revokeCapability: async (
        actor: PlatformActorId,
        tenantId: TenantId,
        scopeId: ScopeId,
        capabilityId: CapabilityId,
      ): Promise<void> => {
        const { stub, vertical } = await this.capabilityScopeStub(tenantId, scopeId, 'revokeCapability');
        const before = await stub.revokeCapabilityAsPlatform(capabilityId, actor);
        if (!before) {
          throw substratError('not_found', `no capability ${capabilityId} in scope ${scopeId}`);
        }
        await this.recordAdmin(actor, 'revokeCapability', { tenantId, scopeId, vertical }, before, {
          capabilityId,
          revoked: true,
        });
      },

      grantToOrg: async (actor, orgId, permission, node, entity) => {
        // The org must exist in the node's tenant. A grant to a phantom org looks
        // applied, resolves for nobody, and still shows up in the permission diff.
        await requireOrg(node.tenantId, orgId);
        await writeGrant(`org:${orgId}`, permission, node, entity);
        await this.recordAdmin(
          actor,
          'grantToOrg',
          { tenantId: node.tenantId, scopeId: node.scopeId },
          null,
          { orgId, permission, node, entity },
        );
        if (!node.scopeId) await this.fanOut(node.tenantId);
      },
      // -- vertical + version registry (#31) ---------------------------------

      // -- the hostname map (K-26) -------------------------------------------

      bindHostname: async (actor, input: BindHostnameInput) => {
        const parsed = bindHostnameInput.parse(input);
        const scope = await this.cp.getScopeRecord(parsed.tenantId, parsed.scopeId);
        if (!scope) {
          throw substratError('not_found', `unknown scope ${parsed.scopeId} in tenant ${parsed.tenantId}`);
        }
        const existing = await this.cp.readHostname(parsed.hostname);
        // The holder's own status decides whether the name is reclaimable. Read it from
        // the scope record rather than joining it onto the hostname read: the router
        // shares that read's shape, and a scope status it can see is an invitation to
        // re-check suspension there (route-resolver's `readRoute` deliberately has none).
        const holder =
          existing && existing.scope_id !== parsed.scopeId
            ? await this.cp.getScopeRecord(existing.tenant_id, existing.scope_id)
            : undefined;
        const holderReleased = holder?.status === 'archived' || holder?.status === 'reaped';
        if (existing && existing.scope_id !== parsed.scopeId && !holderReleased) {
          // A hostname routes to exactly one place; silently rebinding would move
          // another tenant's traffic. Exception: the holder is ARCHIVED or REAPED (a
          // deleted app, storage since wiped) — it has released the name, so the rebind
          // reclaims it.
          throw substratError('conflict', `hostname '${parsed.hostname}' is already bound to another scope`);
        }
        // Exactly one canonical per (scope, surface).
        if (parsed.canonical) await this.cp.demoteCanonical(parsed.scopeId, parsed.surface);
        await this.cp.upsertHostname({
          hostname: parsed.hostname,
          tenantId: parsed.tenantId,
          scopeId: parsed.scopeId,
          verticalSlug: scope.vertical,
          surface: parsed.surface,
          region: parsed.region,
          canonical: parsed.canonical,
          createdAt: new Date().toISOString(),
        });
        await this.recordAdmin(
          actor,
          'bindHostname',
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId, vertical: scope.vertical },
          null,
          parsed,
        );
      },
      setHostnameStatus: async (actor, raw: string, status, note?: string) => {
        const hostname = raw.toLowerCase(); // DNS is case-insensitive; the map is normalized
        const row = await this.cp.readHostname(hostname);
        if (!row) throw substratError('not_found', `unknown hostname '${hostname}'`);
        if (row.status === status) return; // idempotent, unaudited
        await this.cp.setHostnameStatus(hostname, status, note ?? null);
        await this.recordAdmin(
          actor,
          'setHostnameStatus',
          { tenantId: row.tenant_id as TenantId, scopeId: row.scope_id as ScopeId },
          { status: row.status },
          { status, note: note ?? null },
        );
      },
      setHostnameIssuance: async (actor, raw, fields) => {
        const hostname = raw.toLowerCase(); // DNS is case-insensitive; the map is normalized
        const row = await this.cp.readHostname(hostname);
        if (!row) throw substratError('not_found', `unknown hostname '${hostname}'`);
        // A poll that finds nothing changed (same status, same records, id already set)
        // is not an event — skip the write and the audit entry, so the reconcile sweep
        // does not flood the admin log with no-op rows every interval.
        const recordsJson = JSON.stringify(fields.validationRecords);
        const idUnchanged =
          fields.customHostnameId === undefined || fields.customHostnameId === row.custom_hostname_id;
        if (row.status === fields.status && (row.validation_records ?? '[]') === recordsJson && idUnchanged) {
          return;
        }
        await this.cp.setHostnameIssuance(hostname, {
          status: fields.status,
          note: fields.note ?? null,
          customHostnameId: fields.customHostnameId,
          validationRecords: fields.validationRecords.length ? recordsJson : null,
        });
        await this.recordAdmin(
          actor,
          'setHostnameIssuance',
          { tenantId: row.tenant_id as TenantId, scopeId: row.scope_id as ScopeId },
          { status: row.status },
          { status: fields.status, note: fields.note ?? null },
        );
      },
      unbindHostname: async (actor, raw: string) => {
        const hostname = raw.toLowerCase(); // DNS is case-insensitive; the map is normalized
        const row = await this.cp.readHostname(hostname);
        if (!row) return; // idempotent, and a no-op is not audited
        await this.cp.deleteHostname(hostname);
        await this.recordAdmin(
          actor,
          'unbindHostname',
          { tenantId: row.tenant_id as TenantId, scopeId: row.scope_id as ScopeId },
          { hostname, status: row.status },
          null,
        );
      },
      listHostnames: async (actor, filter) => {
        const rows = await this.cp.listHostnames({
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
          status: filter?.status,
          verticalSlug: filter?.verticalSlug,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        await this.recordAccess(
          actor,
          'listHostnames',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map(mapHostname);
      },
      // #1706: the directory's answer to "vertical Y in tenant T", in the ControlPlaneDO, by
      // the kernel's one rule. No actor, not logged — `resolveHostname`'s machine-path reason.
      resolveVerticalInstance: async (tenantId: TenantId, vertical: string): Promise<VerticalResolution> =>
        verticalResolution.parse(await this.cp.resolveVerticalInstance(tenantId, verticalSlug.parse(vertical))),
      resolveHostname: async (raw: string) =>
        // The router's per-request read. No actor, not logged — the same machine-path
        // carve-out resolveIdentity has (K-24). Shares its mapping with the router's
        // own resolver so the two cannot disagree on what resolves.
        toRouteTarget(await this.cp.readRoute(normalizeHostname(raw))),
      registerVertical: async (actor, input: RegisterVerticalInput) => {
        const parsed = registerVerticalInput.parse(input);
        const envSpecJson = parsed.envSpec ? JSON.stringify(parsed.envSpec) : null;
        // The four registry-driven-install fields ride as one JSON blob (marketplace-publish.md §3).
        const installSpec: Record<string, unknown> = {};
        if (parsed.entitlements) installSpec.entitlements = parsed.entitlements;
        if (parsed.ownerGrants) installSpec.ownerGrants = parsed.ownerGrants;
        if (parsed.provides) installSpec.provides = parsed.provides;
        if (parsed.requires) installSpec.requires = parsed.requires;
        // Declared provisioner intent (#455) — the request half of the tenant-provisioner
        // capability; the grant is its own column, never part of this refreshable bag.
        if (parsed.provisions) installSpec.provisions = parsed.provisions;
        // Declared email-sender intent (#303) — the request half; the grant is its own column.
        if (parsed.sendsEmail) installSpec.sendsEmail = parsed.sendsEmail;
        // Where the scope lifecycle is held (#1713) — read by the lifecycle delivery's targets.
        if (parsed.lifecycle) installSpec.lifecycle = parsed.lifecycle;
        const installSpecJson = Object.keys(installSpec).length ? JSON.stringify(installSpec) : null;
        const existing = await this.cp.readVertical(parsed.slug);
        if (existing) {
          // Idempotent on an identical registration; a changed source OR owner conflicts —
          // claim-on-first-push (builder-plane.md): a slug's owner is fixed at first push.
          if (
            existing.source === parsed.source &&
            existing.name === parsed.name &&
            existing.owner_tenant === parsed.ownerTenant
          ) {
            // The env-spec evolves with the manifest — refresh it on an otherwise-identical
            // re-registration so a declared config change propagates without a conflict.
            // For BUILTIN verticals `listed` is seed metadata too (derived from the catalog's
            // `connected` flag), so it refreshes alongside — without this, rows registered
            // before they were listable stay unlisted forever (the empty-marketplace bug).
            // A pushed vertical's `listed` is the staff publish decision — never touched.
            await this.cp.updateVerticalManifestMeta(
              parsed.slug,
              envSpecJson,
              installSpecJson,
              parsed.source === 'builtin' ? (parsed.listed ? 1 : 0) : null,
            );
            return;
          }
          if (existing.owner_tenant !== parsed.ownerTenant) {
            throw substratError(
              'conflict',
              `vertical '${parsed.slug}' is owned by ${existing.owner_tenant ?? 'the platform'}, not ${parsed.ownerTenant ?? 'the platform'}`,
            );
          }
          throw substratError('conflict', `vertical '${parsed.slug}' is already registered as ${existing.source}`);
        }
        await this.cp.insertVertical(parsed.slug, parsed.name, parsed.source, parsed.ownerTenant, envSpecJson, installSpecJson, parsed.listed ? 1 : 0, new Date().toISOString());
        await this.recordAdmin(actor, 'registerVertical', { tenantId: null }, null, parsed);
      },
      listVerticals: async (actor, page) => {
        const rows = await this.cp.listVerticals(page);
        await this.recordAccess(actor, 'listVerticals', {}, page ?? null, rows.length);
        return rows.map(mapVertical);
      },
      publishVersion: async (actor, input: PublishVersionInput) => {
        const parsed = publishVersionInput.parse(input);
        const owning = await this.cp.readVertical(parsed.verticalSlug);
        if (!owning) {
          throw substratError('not_found', `unknown vertical '${parsed.verticalSlug}'`);
        }
        // Lands PENDING — a push is not a deploy — except for a PRIVATE vertical
        // (tenant-owned, not listed), whose blast radius is its own tenant: there the
        // sandbox contract is the gate and the version self-admits, noted so the
        // publish seam can tell a staff vouch from this shortcut.
        const selfAdmits = owning.owner_tenant !== null && !owning.listed;
        // The manifest is retained for the serving upload (#286), not audited — a whole
        // manifest per publish would drown the admin log in bundle metadata.
        const { manifestJson, origin, ...audited } = parsed;
        // The SQL migrations are stored apart from the manifest (#1764), so no read of the
        // version but the promote review's carries them.
        const split = splitManifestMigrations(manifestJson ?? null, 'push');
        await this.cp.insertVersion({
          ...audited,
          manifestJson: split.manifestJson,
          migrations: split.migrations,
          originJson: origin ? JSON.stringify(origin) : null,
          admission: selfAdmits ? 'admitted' : 'pending',
          admissionNote: selfAdmits ? AUTO_ADMISSION_NOTE : null,
          createdAt: new Date().toISOString(),
        });
        await this.recordAdmin(actor, 'publishVersion', { tenantId: null }, null, {
          ...audited,
          ...(origin ? { origin } : {}),
          admission: selfAdmits ? 'admitted' : 'pending',
        });
      },
      listVersions: async (actor, verticalSlug: string, page) => {
        const rows = await this.cp.listVersions(verticalSlug, page);
        await this.recordAccess(actor, 'listVersions', {}, { verticalSlug }, rows.length);
        return rows.map(mapListedVersion);
      },
      getVersion: async (actor, versionId: string, verticalSlug?: string) => {
        const row = await this.cp.readVersion(versionId);
        // A version of another vertical reads as absent when the caller named one.
        const hit = row && (verticalSlug === undefined || row.vertical_slug === verticalSlug) ? row : undefined;
        await this.recordAccess(actor, 'getVersion', {}, { versionId, verticalSlug }, hit ? 1 : 0);
        return hit ? mapVersion(hit) : undefined;
      },
      setVerticalListed: async (actor, slug: string, listed: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw substratError('not_found', `unknown vertical '${slug}'`);
        // Listing is the moment other tenants start trusting this code, so the
        // version they would install must carry a real staff vouch — an auto-admitted
        // prod version has never been read by anyone but its author.
        if (listed) {
          const prod = await this.cp.readChannel(slug, 'prod');
          const prodVersion = prod ? await this.cp.readVersion(prod.version_id) : undefined;
          if (prodVersion?.admission_note === AUTO_ADMISSION_NOTE) {
            throw substratError(
              'conflict',
              `vertical '${slug}' prod version ${prodVersion.id} is auto-admitted (private self-serve) — ` +
                `a staff admit must vouch for it before listing`,
            );
          }
        }
        await this.cp.updateVerticalListed(slug, listed ? 1 : 0); // also resolves any pending request
        await this.recordAdmin(actor, 'setVerticalListed', { tenantId: null }, { listed: !!existing.listed }, { listed });
      },
      requestPublish: async (actor, slug: string) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw substratError('not_found', `unknown vertical '${slug}'`);
        await this.cp.updateVerticalPublishRequest(slug, new Date().toISOString());
        await this.recordAdmin(actor, 'requestPublish', { tenantId: null }, null, { slug });
      },
      setVerticalInstallsBlocked: async (actor, slug: string, blocked: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw substratError('not_found', `unknown vertical '${slug}'`);
        await this.cp.updateVerticalInstallsBlocked(slug, blocked ? 1 : 0);
        await this.recordAdmin(actor, 'setVerticalInstallsBlocked', { tenantId: null }, { installsBlocked: !!existing.installs_blocked }, { installsBlocked: blocked });
      },
      setVerticalTenantProvisioner: async (actor, slug: string, granted: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw substratError('not_found', `unknown vertical '${slug}'`);
        await this.cp.updateVerticalTenantProvisioner(slug, granted ? 1 : 0);
        await this.recordAdmin(actor, 'setVerticalTenantProvisioner', { tenantId: null }, { tenantProvisioner: !!existing.tenant_provisioner }, { tenantProvisioner: granted });
      },
      setVerticalEmailSender: async (actor, slug: string, granted: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw substratError('not_found', `unknown vertical '${slug}'`);
        await this.cp.updateVerticalEmailSender(slug, granted ? 1 : 0);
        await this.recordAdmin(actor, 'setVerticalEmailSender', { tenantId: null }, { emailSender: !!existing.email_sender }, { emailSender: granted });
      },
      deleteVertical: async (actor, slug: string) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw substratError('not_found', `unknown vertical '${slug}'`);
        // Refuse while any restorable scope is bound: a deleted registry row would strand
        // those scopes' version pins and routing. An `archived` scope (a deleted app) still
        // blocks — unarchive can bring it back — but the refusal names reap/restore, not
        // "delete", because the app itself is already gone. `reaped` is terminal history and
        // never blocks. Deployed dispatch scripts are NOT reaped here — they become orphans
        // for the cleanup script (#248).
        const bound = await this.cp.countScopesForVertical(slug);
        if (bound.live > 0) {
          throw substratError(
            'conflict',
            `vertical '${slug}' still backs ${bound.live} scope(s) — delete or rebind them first`,
          );
        }
        if (bound.archived > 0) {
          throw substratError(
            'conflict',
            `vertical '${slug}' still backs ${bound.archived} archived scope(s) — reap or restore them first`,
          );
        }
        await this.cp.deleteVertical(slug);
        await this.recordAdmin(
          actor,
          'deleteVertical',
          { tenantId: null },
          { slug, source: existing.source, ownerTenant: existing.owner_tenant },
          null,
        );
      },
      admitVersion: async (actor, versionId: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw substratError('not_found', `unknown version ${versionId}`);
        if (v.admission === 'admitted') {
          // Idempotent — except an AUTO-admitted version, which this upgrades to a
          // manual vouch by clearing the note (what the publish seam requires).
          if (v.admission_note !== AUTO_ADMISSION_NOTE) return;
          await this.cp.setAdmission(versionId, 'admitted', null);
          await this.recordAdmin(actor, 'admitVersion', { tenantId: null }, { admission: v.admission, note: v.admission_note }, { admission: 'admitted', note: null });
          return;
        }
        if (v.admission === 'rejected') {
          throw substratError('conflict', `version ${versionId} was rejected — publish a new one`);
        }
        await this.cp.setAdmission(versionId, 'admitted', null);
        await this.recordAdmin(actor, 'admitVersion', { tenantId: null }, { admission: v.admission }, { admission: 'admitted' });
      },
      promotionImpact: async (actor, verticalSlug: string, channel, versionId: string): Promise<ExportBreak[]> => {
        const incoming = await this.cp.readVersion(versionId);
        if (!incoming || incoming.vertical_slug !== verticalSlug) {
          throw substratError('not_found', `unknown version ${versionId} for vertical '${verticalSlug}'`);
        }
        const current = await this.cp.readChannel(verticalSlug, channel);
        const outgoing = current ? await this.cp.readVersion(current.version_id) : undefined;
        const breaks = outgoing
          ? await this.exportBreaksBetween(actor, verticalSlug, outgoing.manifest_json, incoming.manifest_json)
          : [];
        await this.recordAccess(actor, 'promotionImpact', { tenantId: null }, { verticalSlug, channel, versionId }, breaks.length);
        return breaks;
      },
      rejectVersion: async (actor, versionId: string, note: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw substratError('not_found', `unknown version ${versionId}`);
        if (v.admission === 'admitted') {
          throw substratError('conflict', `version ${versionId} is already admitted — it may be bound`);
        }
        if (v.admission === 'rejected') return;
        await this.cp.setAdmission(versionId, 'rejected', note);
        await this.recordAdmin(actor, 'rejectVersion', { tenantId: null }, { admission: v.admission }, { admission: 'rejected', note });
      },
      promoteVersion: async (
        actor,
        verticalSlug: string,
        channel,
        versionId: string,
        acknowledge?: PromotionAcknowledgement,
      ) => {
        const incoming = await this.cp.readVersion(versionId);
        if (!incoming) throw substratError('not_found', `unknown version ${versionId}`);
        if (incoming.vertical_slug !== verticalSlug) {
          throw substratError('conflict', `version ${versionId} belongs to '${incoming.vertical_slug}'`);
        }
        if (incoming.admission !== 'admitted') {
          throw substratError(
            'conflict',
            `version ${versionId} is ${incoming.admission}, not admitted — it cannot be promoted`,
          );
        }
        const current = await this.cp.readChannel(verticalSlug, channel);
        const outgoing = current ? await this.cp.readVersion(current.version_id) : undefined;
        const ack = promotionAcknowledgement.parse(acknowledge ?? {});

        // §4's checkpoints, at the moment of exposure. A first promotion has
        // nothing to diff against — the gate is about change, not existence.
        if (outgoing) {
          if (outgoing.permission_digest !== incoming.permission_digest && !ack.permissionChange) {
            throw substratError('conflict',
              `promotion changes the permission surface (${outgoing.permission_digest} → ` +
                `${incoming.permission_digest}) — acknowledge it explicitly to promote`,
            );
          }
          if (outgoing.migration_digest !== incoming.migration_digest && !ack.migrationChange) {
            throw substratError('conflict',
              `promotion changes migrations (${outgoing.migration_digest} → ` +
                `${incoming.migration_digest}) — acknowledge it explicitly to promote`,
            );
          }
          // #1705 PR 3: an export an installed consumer imports, dropped or re-versioned.
          if (!ack.exportBreak) {
            const breaks = await this.exportBreaksBetween(actor, verticalSlug, outgoing.manifest_json, incoming.manifest_json);
            if (breaks.length > 0) throw substratError('precondition_failed', exportBreakRefusal(breaks));
          }
        }

        const promotedAt = new Date().toISOString();
        await this.cp.setChannel(verticalSlug, channel, versionId, promotedAt);
        // The timeline row: what makes rollback a choice among recorded moments, and
        // `at` the PITR anchor a data rollback would rewind to.
        await this.cp.insertChannelHistory({
          id: ulid(),
          vertical_slug: verticalSlug,
          channel,
          version_id: versionId,
          from_version_id: outgoing?.id ?? null,
          actor,
          at: promotedAt,
        });
        // For a PRIVATE vertical, prod IS what the owner's apps run: re-point the
        // owning tenant's live scopes in the same act, so merge-to-main (push +
        // promote) is a complete deploy and a rollback promote reaches the running
        // app. D-30's lockstep concern is a SHARED vertical's many tenants, which a
        // private vertical cannot have — this fires for no one else. Snapshots and
        // forks (forked_from set) and all previews keep their frontier untouched. A rebind
        // that crosses a migration digest snapshots first (fork-before-promote, §4).
        //
        // EXCEPTION (#321): a DISPATCH-BACKED vertical (its version has a
        // `deployment_ref`) serves in place off a stable script. Rebinding a legacy
        // scope's version HERE would reroute it to the incoming version's per-version
        // dispatch script — a fresh, empty Durable Object namespace — stranding its
        // data before the in-place serve can adopt it. So the control-plane-api promote
        // handler owns adopt-then-rebind for those, in the correct order (serve →
        // adopt legacy scopes onto the serving script → advance versions). We skip the
        // rebind here for them. An EMBEDDED vertical (no per-version script;
        // deployment_ref null — builtins, the contract tests) has no such hazard and
        // keeps the rebind here, which is the only place it happens for that path.
        if (channel === 'prod' && !incoming.deployment_ref) {
          const owning = await this.cp.readVertical(verticalSlug);
          if (owning && owning.owner_tenant !== null && !owning.listed) {
            const bound = (
              await this.cp.listScopes({ tenantId: owning.owner_tenant, vertical: verticalSlug, status: ['active'] })
            ).filter(isPrimaryScopeRow);
            for (const s of bound) {
              if (s.vertical_version_id === versionId) continue;
              const prev = s.vertical_version_id ? await this.cp.readVersion(s.vertical_version_id) : undefined;
              if (prev && prev.migration_digest !== incoming.migration_digest) {
                await this.snapshotScope(actor, s.tenant_id as TenantId, s.scope_id as ScopeId);
              }
              await this.cp.bindScopeVersion(s.scope_id, versionId, verticalSlug);
              await this.recordAdmin(
                actor,
                'bindScopeVersion',
                { tenantId: s.tenant_id as TenantId, scopeId: s.scope_id as ScopeId },
                prev ? { versionId: prev.id, version: prev.version } : null,
                { versionId, vertical: verticalSlug, version: incoming.version, via: 'promoteVersion' },
              );
            }
          }
        }
        await this.recordAdmin(
          actor,
          'promoteVersion',
          { tenantId: null, vertical: verticalSlug },
          outgoing ? { versionId: outgoing.id, version: outgoing.version } : null,
          { channel, versionId, version: incoming.version, acknowledged: ack },
        );
      },
      listChannels: async (actor, verticalSlug: string, page) => {
        // `prod` is the only live channel (#509 retired dev/staging). Filter before the parse
        // so a legacy dev/staging row — inert data a pre-retirement push may have left — never
        // reaches the now-`prod`-only `verticalChannel.parse` and throws.
        const rows = (await this.cp.listChannels(verticalSlug, page)).filter((r) => r.channel === 'prod');
        // The serving script runs ONE version (#286); surface it on the prod row so a
        // failed in-place serve (channel moved, serve did not) reads honestly instead of
        // claiming the new version is live (#321).
        const serving = (await this.cp.readVertical(verticalSlug))?.serving_version_id ?? null;
        await this.recordAccess(actor, 'listChannels', {}, { verticalSlug }, rows.length);
        return rows.map((r) =>
          verticalChannel.parse({
            verticalSlug: r.vertical_slug,
            channel: r.channel,
            versionId: r.version_id,
            updatedAt: r.updated_at,
            servingVersionId: r.channel === 'prod' ? serving : null,
          }),
        );
      },
      listChannelHistory: async (actor, verticalSlug: string, channel?, page?) => {
        const rows = await this.cp.listChannelHistory(verticalSlug, channel, page);
        await this.recordAccess(actor, 'listChannelHistory', {}, { verticalSlug, channel }, rows.length);
        return rows.map((r) =>
          channelHistoryEntry.parse({
            id: r.id,
            verticalSlug: r.vertical_slug,
            channel: r.channel,
            versionId: r.version_id,
            fromVersionId: r.from_version_id,
            actor: r.actor,
            at: r.at,
          }),
        );
      },
      bindingImpact: async (actor, tenantId, scopeId, versionId: string, opts): Promise<ExportBreak[]> => {
        const { v, scope } = await bindTarget(tenantId, scopeId, versionId);
        const breaks = await this.bindBreaks(actor, mapScope(scope), v, opts?.servingRef);
        await this.recordAccess(actor, 'bindingImpact', { tenantId, scopeId }, { versionId, ...opts }, breaks.length);
        return breaks;
      },
      bindScopeVersion: async (actor, tenantId, scopeId, versionId: string, opts) => {
        const { v, scope } = await bindTarget(tenantId, scopeId, versionId);
        if (opts?.expectedVersionId !== undefined && scope.vertical_version_id !== opts.expectedVersionId) {
          throw substratError('precondition_failed', 'scope binding changed; reload the scope and retry');
        }
        const ack = bindAcknowledgement.parse(opts?.acknowledge ?? {});
        // #1756: an export an app in this tenant imports, dropped or re-versioned by what this
        // scope would run. Before the snapshot, so a refused bind leaves nothing behind.
        if (!ack.exportBreak) {
          const breaks = await this.bindBreaks(actor, mapScope(scope), v);
          if (breaks.length > 0) throw substratError('precondition_failed', bindExportBreakRefusal(breaks));
        }
        // Fork-before-promote (§4): snapshot the pre-migration data if this rebind
        // crosses a migration boundary. Gated on a real digest change and on opt-in.
        if (opts?.snapshot && scope.vertical_version_id) {
          const outgoing = await this.cp.readVersion(scope.vertical_version_id);
          if (outgoing && outgoing.migration_digest !== v.migration_digest) {
            await this.snapshotScope(actor, tenantId, scopeId);
          }
        }
        await this.cp.bindScopeVersion(scopeId, versionId, v.vertical_slug, opts?.expectedVersionId);
        await this.recordAdmin(actor, 'bindScopeVersion', { tenantId, scopeId }, null, {
          versionId, vertical: v.vertical_slug, version: v.version,
          ...(opts?.expectedVersionId !== undefined ? { expectedVersionId: opts.expectedVersionId } : {}),
          ...(ack.exportBreak ? { acknowledged: ack } : {}),
        });
      },
      /**
       * Record that this scope's provision has now run against `versionId` (#1172).
       *
       * Audited like every other directory write, and deliberately narrow: it takes the
       * version rather than deriving it, so the caller records what it actually
       * reconciled against rather than whatever the scope happens to be bound to by the
       * time the write lands.
       */
      markScopeProvisioned: async (actor, tenantId, scopeId, versionId: string | null) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        await this.cp.markScopeProvisioned(scopeId, versionId);
        await this.recordAdmin(actor, 'markScopeProvisioned', { tenantId, scopeId }, null, {
          versionId,
        });
      },
      verticalServing: async (actor, verticalSlug: string) => {
        const r = await this.cp.readVertical(verticalSlug);
        if (!r) throw substratError('not_found', `unknown vertical '${verticalSlug}'`);
        await this.recordAccess(actor, 'verticalServing', {}, { verticalSlug }, r.serving_ref ? 1 : 0);
        if (!r.serving_ref || !r.serving_version_id || !r.serving_migration_tag) return null;
        return verticalServingState.parse({
          ref: r.serving_ref,
          versionId: r.serving_version_id,
          doClasses: r.serving_do_classes ? JSON.parse(r.serving_do_classes) : [],
          migrationTag: r.serving_migration_tag,
        });
      },
      setVerticalServing: async (actor, verticalSlug: string, state) => {
        const parsed = verticalServingState.parse(state);
        const r = await this.cp.readVertical(verticalSlug);
        if (!r) throw substratError('not_found', `unknown vertical '${verticalSlug}'`);
        await this.cp.setVerticalServing(verticalSlug, {
          ref: parsed.ref,
          versionId: parsed.versionId,
          doClassesJson: JSON.stringify(parsed.doClasses),
          migrationTag: parsed.migrationTag,
        });
        await this.recordAdmin(
          actor,
          'setVerticalServing',
          { tenantId: null },
          r.serving_ref
            ? { ref: r.serving_ref, versionId: r.serving_version_id }
            : null,
          { vertical: verticalSlug, ref: parsed.ref, versionId: parsed.versionId },
        );
      },
      versionManifest: async (actor, verticalSlug: string, versionId: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v || v.vertical_slug !== verticalSlug) {
          throw substratError('not_found', `unknown version ${versionId} for vertical '${verticalSlug}'`);
        }
        await this.recordAccess(actor, 'versionManifest', {}, { verticalSlug, versionId }, v.manifest_json ? 1 : 0);
        return v.manifest_json;
      },
      versionMigrations: async (actor, verticalSlug: string, versionId: string) => {
        const v = await this.cp.readVersionMigrations(versionId);
        if (!v || v.verticalSlug !== verticalSlug) {
          throw substratError('not_found', `unknown version ${versionId} for vertical '${verticalSlug}'`);
        }
        await this.recordAccess(actor, 'versionMigrations', {}, { verticalSlug, versionId }, v.migrations?.length ?? 0);
        return v.migrations;
      },
      setScopeServingRef: async (actor, tenantId, scopeId, servingRef, opts) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        const ack = bindAcknowledgement.parse(opts?.acknowledge ?? {});
        // #1756: onto (or off) a serving script, the scope runs other code before its pointer
        // moves. Judged here, so no caller that routes first and binds second passes unasked.
        const bound = scope.vertical_version_id ? await this.cp.readVersion(scope.vertical_version_id) : undefined;
        if (!ack.exportBreak && bound) {
          const breaks = await this.bindBreaks(actor, mapScope(scope), bound, servingRef);
          if (breaks.length > 0) throw substratError('precondition_failed', bindExportBreakRefusal(breaks));
        }
        await this.cp.setScopeServingRef(scopeId, servingRef);
        await this.recordAdmin(
          actor,
          'setScopeServingRef',
          { tenantId, scopeId },
          { servingRef: scope.serving_ref ?? null },
          { servingRef, ...(ack.exportBreak ? { acknowledged: ack } : {}) },
        );
      },
      recordKeptCopyResolution: async (actor, tenantId, scopeId, r) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        await this.recordAdmin(
          actor,
          'resolveKeptCopy',
          { tenantId, scopeId },
          { script: r.script, keptAt: r.keptAt, revision: r.revisionBefore },
          { action: r.action, liveScript: r.liveScript, revision: r.revisionAfter },
        );
      },
      setScopeExpiresAt: async (actor, tenantId, scopeId, expiresAt) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        await this.cp.setScopeExpiresAt(scopeId, expiresAt);
        await this.recordAdmin(
          actor,
          'setScopeExpiresAt',
          { tenantId, scopeId },
          { expiresAt: scope.expires_at ?? null },
          { expiresAt },
        );
      },
      scopeAppliedMigrations: async (actor, tenantId, scopeId) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        const applied = await this.scopeStub(scopeId).appliedMigrations();
        await this.recordAccess(actor, 'scopeAppliedMigrations', { tenantId, scopeId }, null, applied.length);
        return applied;
      },
      scopeMigrationBookmarks: async (actor, tenantId, scopeId) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        const bookmarks = await this.scopeStub(scopeId).migrationBookmarks();
        await this.recordAccess(actor, 'scopeMigrationBookmarks', { tenantId, scopeId }, null, bookmarks.length);
        return bookmarks;
      },
      scopeDatabaseSize: async (actor, tenantId, scopeId) => {
        // Reaped is refused, not read: addressing the deleted DO would recreate it.
        await this.scopeRecordForRead(tenantId, scopeId);
        const bytes = await this.scopeStub(scopeId).databaseSize();
        await this.recordAccess(actor, 'scopeDatabaseSize', { tenantId, scopeId }, null, 1);
        return bytes;
      },
      rewindScope: async (actor, tenantId, scopeId, bookmark, opts) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        // Audit FIRST: a destructive rewind that fails halfway must still be on the
        // record — the entry names the intent; the DO's refusals name the outcome.
        await this.recordAdmin(actor, 'rewindScope', { tenantId, scopeId }, null, {
          bookmark,
          force: opts?.force ?? false,
          delegated: opts?.localApply === false,
        });
        if (opts?.localApply === false) {
          // The scope's data lives in a dispatch vertical's own deployment; the route
          // delegates the actual rewind to its `/internal/rewind`. Touching this
          // host's namespace here would PITR an unrelated, unused DO.
          return { rewindingTo: bookmark };
        }
        // #1819: the same rewind a dispatched vertical runs, holding what the scope switched off.
        return this.rewindScopeLocal(scopeId, bookmark, { force: opts?.force });
      },
      createOrg: async (actor: PlatformActorId, input: CreateOrgInput) => {
        const parsed = createOrgInput.parse(input);
        const created = await this.directory('createOrg',
          parsed.id,
          parsed.tenantId,
          parsed.slug,
          parsed.name,
          new Date().toISOString(),
        );
        if (!created) return; // idempotent, and a no-op is not audited
        await this.recordAdmin(actor, 'createOrg', { tenantId: parsed.tenantId }, null, parsed);
      },
      listOrgs: async (actor, tenantId: TenantId) => {
        const orgs = (await this.cp.listOrgs(tenantId)).map(mapOrg);
        await this.recordAccess(actor, 'listOrgs', { tenantId }, null, orgs.length);
        return orgs;
      },
      getOrg: async (actor, tenantId: TenantId, orgId: OrgId) => {
        const r = await this.cp.readOrg(tenantId, orgId);
        await this.recordAccess(actor, 'getOrg', { tenantId }, { orgId }, r ? 1 : 0);
        return r ? mapOrg(r) : undefined;
      },
      addMember: async (actor, tenantId, principal, orgId, opts) => {
        await requireOrg(tenantId, orgId);
        const expiresAt = opts?.expiresAt ?? null;
        await this.cp.writeTenantTuple(
          tenantId,
          `principal:${principal}`,
          'member',
          `org:${orgId}`,
          expiresAt,
        );
        await this.recordAdmin(actor, 'addMember', { tenantId }, null, memberAddedAudit(principal, orgId, expiresAt));
        await this.fanOut(tenantId); // membership is a tenant-level tuple
      },
      applyMembership: async (actor, change) => {
        // The row is minted here, where attribution and `causedBy` live, and written by the
        // ControlPlaneDO in the same synchronous method as the fence, the bound and the tuple
        // (#1184): one DO unit, so nothing lands between the check and the write.
        const { tenantId, principal, roleKey, op, orgId } = change;
        const assignment = { principalId: principal, roleKey, node: { tenantId, scopeId: null } };
        const result = await this.cp.applyMembership(
          change,
          op === 'add'
            ? this.adminEntry(actor, 'assignRole', { tenantId, scopeId: null }, null, assignment)
            : this.adminEntry(actor, 'unassignRole', { tenantId, scopeId: null }, assignment, null),
          // #2047: the org's own row, when the change joins or leaves one. The unit fills in its
          // `before`/`after` and writes it only for what it does — a join's carries the expiry.
          orgId ? this.adminEntry(actor, op === 'add' ? 'addMember' : 'removeMember', { tenantId }, null, null) : undefined,
        );
        // The tenant-level tuple, or its tombstone, reaches the projections.
        if (result.applied && (op === 'add' || result.changed)) await this.fanOut(tenantId);
        return result;
      },
      removeMember: async (actor, tenantId, principal, orgId) => {
        await requireOrg(tenantId, orgId);
        // Tombstone (K-21), never DELETE, with the removal fence in the same DO method
        // (#1184). A repeat revoke stays a silent no-op rather than a second audit row.
        const changed = await this.cp.revokeAndFence(
          tenantId,
          principal,
          'member',
          `org:${orgId}`,
          this.adminEntry(actor, 'removeMember', { tenantId }, { principal, orgId }, null),
        );
        if (changed) await this.fanOut(tenantId); // the tombstone must reach the projections
      },
      listMembers: async (actor, tenantId, orgId, options) => {
        await requireOrg(tenantId, orgId);
        const rows = await this.cp.listMembers(
          tenantId,
          `org:${orgId}`,
          options?.includeRevoked ?? false,
        );
        await this.recordAccess(actor, 'listMembers', { tenantId }, { orgId, ...options }, rows.length);
        return rows.map((r) =>
          orgMembership.parse({
            principal: r.subject.slice('principal:'.length),
            orgId,
            revokedAt: r.revoked_at,
            expiresAt: r.expires_at,
          }),
        );
      },
      createTenant: async (actor, input: CreateTenantInput) => {
        const parsed = createTenantInput.parse(input);
        const created = await this.directory('createTenant',
          parsed.id,
          parsed.slug,
          parsed.name,
          new Date().toISOString(),
          parsed.provisionedByTenant ?? null,
        );
        // Idempotent: re-creating an existing tenant is a no-op, not audited.
        if (!created) return;
        await this.recordAdmin(actor, 'createTenant', { tenantId: parsed.id }, null, created);
      },
      setTenantStatus: async (actor, tenantId, status: TenantStatus) => {
        const before = await this.directory('setTenantStatus', tenantId, status);
        await this.recordAdmin(actor, 'setTenantStatus', { tenantId }, { status: before }, { status });
        // #1713: every hosted scope under the tenant holds or resumes its work by this.
        await this.deliverLifecycles(actor, { tenantId });
      },
      setTenantName: async (actor, tenantId, name: string) => {
        const before = await this.directory('setTenantName', tenantId, name);
        if (before === name) return; // no-op is not audited — nothing changed
        await this.recordAdmin(actor, 'setTenantName', { tenantId }, { name: before }, { name });
      },
      reapTenant: async (actor, tenantId) => {
        // Directory-side terminal reap (§4.8). The caller reaped every scope's storage
        // first (archive-if-needed → reapScope in the vertical deployment); the DO clears
        // the tenant's PII/config rows and flips the row to a `reaped` tombstone, keeping
        // the row + admin log. Only a `deleting` tenant may be reaped (checked in the DO).
        const before = await this.directory('reapTenant', tenantId);
        await this.recordAdmin(actor, 'reapTenant', { tenantId }, { status: before }, { status: 'reaped' });
      },
      listTenants: async (actor, page): Promise<Tenant[]> => {
        const tenants = (await this.cp.listTenants(page)).map((t) => tenantSchema.parse(t));
        // Enumerating every tenant on the platform is the read this log exists for.
        await this.recordAccess(actor, 'listTenants', {}, page ?? null, tenants.length);
        return tenants;
      },
      getTenant: async (actor, tenantId): Promise<Tenant | undefined> => {
        const t = await this.cp.getTenant(tenantId);
        await this.recordAccess(actor, 'getTenant', { tenantId }, null, t ? 1 : 0);
        return t ? tenantSchema.parse(t) : undefined;
      },
      listScopes: async (actor, filter?: ScopeFilter): Promise<Scope[]> => {
        const rows = await this.cp.listScopes({
          tenantId: filter?.tenantId,
          status: filter?.status
            ? Array.isArray(filter.status)
              ? filter.status
              : [filter.status]
            : undefined,
          vertical: filter?.vertical,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        await this.recordAccess(actor, 'listScopes', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
        return rows.map(mapScope);
      },
      getScopeRecord: async (actor, tenantId, scopeId): Promise<Scope | undefined> => {
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        await this.recordAccess(actor, 'getScopeRecord', { tenantId, scopeId }, null, row ? 1 : 0);
        return row ? mapScope(row) : undefined;
      },
      listTenantStores: async (
        actor,
        filter?: { tenantId?: TenantId; vertical?: string },
      ): Promise<TenantStoreRecord[]> => {
        const rows = await this.cp.listTenantStores({
          tenantId: filter?.tenantId,
          vertical: filter?.vertical,
        });
        await this.recordAccess(
          actor,
          'listTenantStores',
          { tenantId: filter?.tenantId ?? null },
          filter ?? null,
          rows.length,
        );
        return rows.map((r) => ({
          tenantId: r.tenant_id as TenantId,
          vertical: r.vertical,
          binding: r.binding,
          kind: 'relational',
          ref: r.ref,
          createdAt: r.created_at,
        }));
      },
      listBlobStores: async (
        actor,
        filter?: { tenantId?: TenantId; vertical?: string },
      ): Promise<BlobStoreRecord[]> => {
        const rows = await this.cp.listBlobStores({
          tenantId: filter?.tenantId,
          vertical: filter?.vertical,
        });
        await this.recordAccess(
          actor,
          'listBlobStores',
          { tenantId: filter?.tenantId ?? null },
          filter ?? null,
          rows.length,
        );
        return rows.map((r) => ({
          tenantId: r.tenant_id as TenantId,
          vertical: r.vertical,
          binding: r.binding,
          kind: 'blob',
          ref: r.ref,
          createdAt: r.created_at,
        }));
      },
      listScopeTables: async (actor, tenantId, scopeId): Promise<ScopeTable[]> => {
        // K-3 cross-check on the shared directory BEFORE reaching the scope DO: a pair
        // that does not resolve is unreachable, never another tenant's database.
        await this.scopeRecordForRead(tenantId, scopeId);
        const tables = await this.scopeStub(scopeId).introspectTables();
        await this.recordAccess(actor, 'listScopeTables', { tenantId, scopeId }, null, tables.length);
        return tables;
      },
      readExportedEvents: async (actor, tenantId, scopeId, raw): Promise<ExportedBatch> => {
        // #1705: the producer half. The DO decides what leaves, from its own registered
        // exports. This side gates the pair (K-3), parses both directions, and writes the
        // access row, because a platform read of domain data leaving a scope is one.
        const input = exportReadInput.parse(raw);
        // The read's own K-3 and reap gate, then the same refusal the door gives: on the
        // shared control plane this scope's outbox lives in its vertical's deployment, and
        // the placeholder here would report a hosted producer as having nothing to export.
        // Not `peerScopeGate`: a read must not migrate, and the phase makes this call once
        // per edge per pass, where an extra round trip is a fleet-wide cost.
        this.assertServedHere(await this.scopeRecordForRead(tenantId, scopeId), scopeId, 'readExportedEvents');
        const batch = await this.readExportsThroughDoor(input, tenantId, scopeId);
        await this.recordAccess(
          actor,
          'readExportedEvents',
          { tenantId, scopeId },
          { consumer: input.consumer, after: input.after, limit: input.limit },
          batch.events.length,
        );
        return batch;
      },
      importState: async (actor, tenantId, scopeId): Promise<ImportState> => {
        // Answered with no call at all when this deployment imports nothing: not the directory,
        // not the DO. "Imports nothing" is a fact about this code, and it names no scope, so it
        // tells a caller nothing about a (tenant, scope) pair it may not address.
        if (this.crossVertical.consumes().length === 0) return { consumes: [], cursors: [] };
        // Then the read's own gate, and the same refusal: a hosted scope's watermark lives in
        // its vertical's deployment, and the placeholder here would answer "never read
        // anything", which a pass would act on by re-delivering that edge from the start.
        this.assertServedHere(await this.scopeRecordForRead(tenantId, scopeId), scopeId, 'importState');
        const state = importState.parse(await this.scopeStub(scopeId).importStateRead());
        await this.recordAccess(actor, 'importState', { tenantId, scopeId }, null, state.cursors.length);
        return state;
      },
      moveImportCursor: async (actor, tenantId, scopeId, raw): Promise<ImportCursorMoved> =>
        this.moveImportCursorAt(actor, tenantId, scopeId, raw),
      readUndrainedEvents: async (actor, tenantId, scopeId, limit): Promise<UndrainedEvents> => {
        const record = await this.scopeRecordForRead(tenantId, scopeId);
        const bounded = Math.min(assertRowLimit('limit', limit ?? 200), 1000);
        // #1334: on the shared control plane the scope's outbox is in its vertical's
        // deployment, and this host's own namespace is the module-less placeholder —
        // reading it would construct an empty DO and answer "nothing to ship". The
        // delegation is the reach; the access row below is written either way, so
        // the branch is invisible to an auditor (K-24).
        const events =
          this.eventDrainDelegation && record.vertical
            ? await this.eventDrainDelegation.readUndrained({
                tenantId,
                scopeId,
                vertical: record.vertical,
                limit: bounded,
              })
            : undrainedEventsOf(await this.scopeStub(scopeId).undrainedEventsRead(bounded));
        await this.recordAccess(actor, 'readUndrainedEvents', { tenantId, scopeId }, { limit }, events.length);
        return events;
      },
      markEventsDrained: async (actor, tenantId, scopeId, eventIds): Promise<number> => {
        // The same refusal the reads carry: a reaped scope's storage is gone, and
        // addressing its DO would construct an empty one to stamp nothing in.
        const record = await this.scopeRecordForRead(tenantId, scopeId);
        if (eventIds.length === 0) return 0;
        const drainedAt = new Date().toISOString();
        // Delegated on the same rule as the read above: the stamp has to land where
        // the rows are, or the next tick reads and ships the same batch again.
        const drained =
          this.eventDrainDelegation && record.vertical
            ? await this.eventDrainDelegation.markDrained({
                tenantId,
                scopeId,
                vertical: record.vertical,
                eventIds,
                drainedAt,
              })
            : await this.scopeStub(scopeId).markEventsDrained(eventIds, drainedAt);
        // K-24's rule, one tier down (#1334): declaring domain payloads shipped is an
        // EGRESS, and the admin log is where "these events left the platform, at this
        // time, on this actor's say-so" is recorded. `drainAccessLog` audits the same
        // act for the smaller class of data; this one carries the larger. Only a
        // NONZERO change is recorded, so a retried pass that re-marks a batch it
        // already shipped writes no row claiming an egress that never happened.
        if (drained > 0) {
          await this.recordAdmin(
            actor,
            'drainEvents',
            { tenantId, scopeId },
            null,
            { drained, requested: eventIds.length, drainedAt },
          );
        }
        return drained;
      },
      redrainEvents: async (actor, tenantId, scopeId, input): Promise<number> => {
        // The same refusal the stamp carries: a reaped scope's storage is gone, and
        // addressing its DO would construct an empty one and report nothing reopened.
        const record = await this.scopeRecordForRead(tenantId, scopeId);
        const { drainedBefore, countOnly } = redrainEventsInput.parse(input);
        // The window rule at the HostAdmin boundary, not only at the control-plane door:
        // this verb is public, so an in-process caller reaches it without that route. Host
        // code, so the real clock is the right one to read (the DO host injects none).
        // Applied to a count too: a future instant is as meaningless to count as it is
        // dangerous to reopen, and one answer from this verb should not be reachable
        // through a door the other is refused at.
        assertRedrainWindow(drainedBefore, new Date().toISOString());
        // A COUNT reopens nothing, so it writes no receipt (#1545). Both rows below exist
        // for a second egress of a tenant's payloads: the intent because a reopen that
        // crashed before its outcome row would otherwise leave no trace, the outcome
        // because something moved. A count moves nothing and egresses nothing, and an
        // admin row saying a redrain was intended on a scope where none was is a false
        // statement about a tenant's data — the opposite of what the log is for.
        //
        // It IS a read, though, and K-24 admits no curated subset: every `HostAdmin` read
        // records actor, method, target and result count in the access log, so "who counted
        // every tenant's outbox" has an answer. The count itself is the result count — the
        // read returns one row, and the number in it is the fact worth having. The row lands
        // on THIS host whichever branch answered, like the drain's read.
        if (countOnly) {
          const redrainable =
            this.eventDrainDelegation && record.vertical
              ? await this.eventDrainDelegation.redrain({
                  tenantId,
                  scopeId,
                  vertical: record.vertical,
                  drainedBefore,
                  countOnly: true,
                })
              : await this.scopeStub(scopeId).redrainCount(drainedBefore);
          await this.recordAccess(
            actor,
            'redrainEvents',
            { tenantId, scopeId },
            { drainedBefore, countOnly: true },
            redrainable,
          );
          return redrainable;
        }
        // Audit FIRST, on `rewindScope`'s rule (K-33), because this has the same shape: the
        // mutation commits in a DO and the row is a separate write afterwards, so a failure
        // between them left a reopen that had happened with no receipt — and the retry could
        // not repair it, because the stamps were already clear and a second call returns 0
        // and writes nothing. The intent row is what cannot be lost that way; the outcome row
        // below still records how much actually moved. A second egress of a tenant's payloads
        // is exactly the thing K-24 must not lose track of.
        await this.recordAdmin(actor, 'redrainEvents', { tenantId, scopeId }, null, {
          intent: 'redrain',
          drainedBefore,
          delegated: Boolean(this.eventDrainDelegation && record.vertical),
        });
        // Delegated on the stamp's rule: the rows live in the vertical's deployment, and
        // clearing stamps in the placeholder namespace would succeed while reopening nothing.
        const redrained =
          this.eventDrainDelegation && record.vertical
            ? await this.eventDrainDelegation.redrain({
                tenantId,
                scopeId,
                vertical: record.vertical,
                drainedBefore,
              })
            : await this.scopeStub(scopeId).redrainEvents(drainedBefore);
        // The outcome beside the intent above — only when something changed, so a re-run over
        // a window already reopened adds no row claiming it moved anything.
        if (redrained > 0) {
          await this.recordAdmin(actor, 'redrainEvents', { tenantId, scopeId }, null, { redrained, drainedBefore });
        }
        return redrained;
      },
      facetEvents: async (actor, tenantId, scopeId, input: EventFacetInput): Promise<EventFacetResult> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        const result = await this.scopeStub(scopeId).facetEvents(input);
        await this.recordAccess(
          actor,
          'facetEvents',
          { tenantId, scopeId },
          delegatedReadParams.facetEvents(input, result),
          result.buckets.length,
        );
        return result;
      },
      entityHistory: async (
        actor,
        tenantId,
        scopeId,
        input: EntityHistoryInput,
      ): Promise<Page<HistoryEntry>> => {
        // K-3 cross-check on the directory BEFORE the scope DO, like every read here.
        await this.scopeRecordForRead(tenantId, scopeId);
        const page = await this.scopeStub(scopeId).entityHistory(input);
        await this.recordAccess(
          actor,
          'entityHistory',
          { tenantId, scopeId },
          { entityType: input.entityType, entityId: input.entityId },
          page.entries.length,
        );
        return page;
      },
      eventCause: async (actor, tenantId, scopeId, input: EventCauseInput): Promise<CauseChain> => {
        // K-3 cross-check on the directory BEFORE the scope DO, like every read here.
        await this.scopeRecordForRead(tenantId, scopeId);
        const result = await this.scopeStub(scopeId).eventCause(input);
        await this.recordAccess(
          actor,
          'eventCause',
          { tenantId, scopeId },
          { eventId: input.eventId },
          result.chain.length,
        );
        return result;
      },
      eventEffects: async (actor, tenantId, scopeId, input: EventEffectsInput): Promise<EffectsTree> => {
        // K-3 cross-check on the directory BEFORE the scope DO, like every read here.
        await this.scopeRecordForRead(tenantId, scopeId);
        const tree = await this.scopeStub(scopeId).eventEffects(input);
        await this.recordAccess(actor, 'eventEffects', { tenantId, scopeId }, { eventId: input.eventId }, tree.count);
        return tree;
      },
      invocationEvents: async (actor, tenantId, scopeId, input: InvocationEventsInput): Promise<InvocationEvents> => {
        // K-3 cross-check on the directory BEFORE the scope DO, like every read here.
        await this.scopeRecordForRead(tenantId, scopeId);
        const read = await this.scopeStub(scopeId).invocationEvents(input);
        await this.recordAccess(
          actor, 'invocationEvents', { tenantId, scopeId }, { invocationId: input.invocationId }, read.events.length,
        );
        return read;
      },
      deadLetters: async (actor, tenantId, scopeId, input: DeadLettersInput): Promise<Page<DeadLetter>> => {
        // K-3 cross-check on the directory BEFORE the scope DO, like every read here.
        await this.scopeRecordForRead(tenantId, scopeId);
        const page = await this.scopeStub(scopeId).deadLetters(input);
        await this.recordAccess(actor, 'deadLetters', { tenantId, scopeId }, null, page.entries.length);
        return page;
      },
      lifecycleFlow: async (actor, tenantId, scopeId, input: LifecycleFlowInput): Promise<LifecycleFlowResult> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        const flow = await this.scopeStub(scopeId).lifecycleFlow(input);
        await this.recordAccess(
          actor,
          'lifecycleFlow',
          { tenantId, scopeId },
          delegatedReadParams.lifecycleFlow(input),
          flow.observation.events,
        );
        return flow;
      },
      operationSeries: async (actor, tenantId, scopeId, input: OperationSeriesInput): Promise<OperationSeriesResult> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        const series = await this.scopeStub(scopeId).operationSeries(input);
        await this.recordAccess(
          actor,
          'operationSeries',
          { tenantId, scopeId },
          delegatedReadParams.operationSeries(input),
          operationSeriesCount(series),
        );
        return series;
      },
      readScopeTable: async (
        actor,
        tenantId,
        scopeId,
        input: ReadScopeTableInput,
      ): Promise<ScopeTablePage> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        // Checked here as well as in the ScopeDO, so the refusal keeps its code across the hop.
        assertRowLimit('limit', input.limit);
        assertRowOffset('offset', input.offset);
        const page = unwrapReply(await this.scopeStub(scopeId).introspectTableReply(input.table, input.limit, input.offset));
        await this.recordAccess(
          actor,
          'readScopeTable',
          { tenantId, scopeId },
          { table: input.table, limit: page.limit, offset: page.offset },
          page.rows.length,
        );
        return page;
      },
      listDenials: async (
        actor,
        tenantId,
        scopeId,
        filter?: DenialFilter,
      ): Promise<PermissionDenial[]> => {
        // K-3 cross-check on the shared directory BEFORE reaching the scope DO, as
        // every read here does: an unresolved pair is unreachable, never another
        // tenant's log.
        await this.scopeRecordForRead(tenantId, scopeId);
        const rows = await this.scopeStub(scopeId).listDenials(filter);
        await this.recordAccess(actor, 'listDenials', { tenantId, scopeId }, filter ?? null, rows.length);
        return rows;
      },
      // #1686: the operator's capability read. K-3 on the directory before the DO, like the
      // denial log. On the shared control plane a scope a vertical's own deployment serves
      // holds its storage THERE, and this namespace holds a placeholder: the control-plane
      // API asks the vertical (`listCapabilitiesLocal`), so this branch is the co-located one.
      listCapabilities: async (
        actor,
        tenantId,
        scopeId,
        filter?: CapabilityFilter,
      ): Promise<CapabilityPage> => {
        // Parsed here too: a typed refusal thrown inside the DO arrives as a bare message.
        const parsed = capabilityFilter.parse(filter ?? {});
        const rec = await this.scopeRecordForRead(tenantId, scopeId);
        this.assertServedHere(rec, scopeId, 'listCapabilities');
        const page = await this.scopeStub(scopeId).listCapabilities(parsed);
        await this.recordAccess(actor, 'listCapabilities', { tenantId, scopeId }, filter ?? null, page.entries.length);
        return page;
      },
      listRefusals: async (
        actor,
        tenantId,
        scopeId,
        filter?: RefusalFilter,
      ): Promise<RefusalRecord[]> => {
        // #1745: the denial log's discipline — K-3 on the directory before the DO is reached.
        await this.scopeRecordForRead(tenantId, scopeId);
        const rows = await this.scopeStub(scopeId).listRefusals(filter);
        await this.recordAccess(actor, 'listRefusals', { tenantId, scopeId }, filter ?? null, rows.length);
        return rows;
      },
      summarizeDenials: async (
        actor,
        tenantId,
        scopeId,
        filter?: DenialFilter,
      ): Promise<DenialSummary> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        const summary = await this.scopeStub(scopeId).summarizeDenials(filter);
        await this.recordAccess(
          actor,
          'summarizeDenials',
          { tenantId, scopeId },
          filter ?? null,
          summary.buckets.length,
        );
        return summary;
      },
      queryScope: async (
        actor,
        tenantId,
        scopeId,
        input: QueryScopeInput,
      ): Promise<ScopeQueryResult> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        const result = unwrapReply(await this.scopeStub(scopeId).introspectQueryReply(input.sql));
        // The statement is the logged argument: the access log is the evidence trail,
        // and for a console read the SQL is the whole story.
        await this.recordAccess(actor, 'queryScope', { tenantId, scopeId }, { sql: input.sql }, result.rows.length);
        return result;
      },
      exportScope: async (actor, tenantId, scopeId): Promise<ScopeDump> => {
        // K-3 cross-check on the shared directory BEFORE reaching the scope DO, exactly
        // as the introspection reads: an unresolved pair is unreachable, never another
        // tenant's database. The DO returns the tables; the coordinator, which knows the
        // scope's identity, stamps the dump.
        await this.scopeRecordForRead(tenantId, scopeId);
        const tables = await this.scopeStub(scopeId).exportDump();
        await this.recordAccess(actor, 'exportScope', { tenantId, scopeId }, null, tables.length);
        return { tenantId, scopeId, capturedAt: new Date().toISOString(), tables };
      },
      exportDirectory: async (actor): Promise<DirectoryDump> => {
        // No K-3 cross-check to make: there is one directory, and it is the thing that
        // WOULD answer such a check. The access-log entry carries no tenant for the same
        // reason (K-23) — this read's subject is every tenant at once.
        const tables = await this.cp.exportDump();
        await this.recordAccess(actor, 'exportDirectory', {}, null, tables.length);
        return { capturedAt: new Date().toISOString(), tables };
      },
      restoreDirectory: async (actor, dump: DirectoryDump): Promise<void> => {
        // The before-state is read BEFORE the replace, because after it the old counts
        // are gone — and "restored over 12 tenants" is the fact an operator reviewing
        // this entry needs. The admin entry is written AFTER: the restore replaces the
        // admin log too, so an entry written first would be overwritten by the very act
        // it records, leaving the platform's most consequential write invisible.
        const before = (await this.cp.listTenants({ limit: 1000 })).length;
        await this.cp.importDump(dump.tables);
        await this.recordAdmin(
          actor,
          'restoreDirectory',
          { tenantId: null },
          { tenants: before },
          { capturedAt: dump.capturedAt, tables: dump.tables.length },
        );
      },
      activateScope: async (actor, tenantId, scopeId) => {
        // Idempotent on `active`, unaudited because nothing changed. Provisioning is
        // a two-phase creation that the reconciliation sweep re-runs (K-31), so a
        // retry of an already-finished instance must converge rather than throw.
        // Every OTHER state still refuses: reviving a suspended scope through here
        // would route around unsuspend and its audit entry.
        const current = await this.cp.getScopeRecord(tenantId, scopeId);
        if (current?.status === 'active') return;
        await transitionScope(actor, 'activateScope', tenantId, scopeId, ['provisioning'], 'active');
      },
      suspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'suspendScope', tenantId, scopeId, ['active'], 'suspended'),
      unsuspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unsuspendScope', tenantId, scopeId, ['suspended'], 'active'),
      archiveScope: async (actor, tenantId, scopeId) =>
        // Also from `provisioning`: a scope whose provisioning never completed (a failed
        // create) must be abandonable, or its slug is stranded forever.
        transitionScope(actor, 'archiveScope', tenantId, scopeId, ['provisioning', 'active', 'suspended'], 'archived'),
      unarchiveScope: async (actor, tenantId, scopeId) => {
        // An archived scope is outside `fanOut`'s status filter (#1386), so every
        // tenant-level revoke that landed while it sat archived never reached its local
        // projection — and a bare flip would put that stale projection back on duty:
        // a principal removed from the tenant meanwhile keeps their access on the
        // unarchived scope until the next fan-out or sweep (#1473). So the flip is
        // preceded by a push of the tenant's CURRENT state into this one scope.
        //
        // Push BEFORE the flip, deliberately. A push that throws then leaves the scope
        // archived — where the coordinator already fails closed and the operator simply
        // retries — rather than active behind a projection nobody refreshed. And the
        // order is safe in every state the flip would refuse: on a live scope the push
        // is one idempotent write, and on a reaped scope the DO drops it (the reaped
        // marker survives `deleteAll()`), so nothing is resurrected.
        await this.projectScope(tenantId, scopeId);
        await transitionScope(actor, 'unarchiveScope', tenantId, scopeId, ['archived'], 'active');
        // And push AGAIN after it. The first push is a snapshot, and the directory does
        // not stop for it: a revoke that commits between that snapshot's read and the
        // flip fans out to every scope that is live at that moment — which this one is
        // not yet — so its own fan-out misses this scope and the flip puts the older
        // snapshot on duty. Once flipped, the scope is inside every later fan-out's
        // set, and a read taken now holds everything that committed before it; the
        // two together close the window, the way `fanOut` includes `provisioning`
        // scopes beside their own pull rather than leaving a gap between the two.
        // What remains is the race every pair of concurrent fan-outs has — snapshots
        // can land out of order — and the reconciliation sweep is what repairs that.
        await this.projectScope(tenantId, scopeId);
      },
      reapScope: async (actor, tenantId, scopeId, opts) => {
        // Reap an ARCHIVED scope's DO storage (Cloudflare never GCs a DO) while keeping
        // the directory row as a tombstone (§4.4). Storage BEFORE the status flip, the
        // same ordering deleteSnapshot keeps: a crash between the two leaves an `archived`
        // row over emptied storage and re-running converges, whereas flipping first would
        // strand live bytes under a `reaped` row that reap never revisits. The real wipe
        // for a CP-less scope (bytes in the vertical's own deployment) is done by the
        // caller via vertical.deleteScope before this; destroyStorage here wipes the
        // co-located SCOPE namespace (embedded / self-host / tests) and is a harmless
        // no-op when the bytes lived remotely.
        const rec = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!rec) throw substratError('not_found', `unknown scope ${scopeId} in tenant ${tenantId}`);
        if (rec.status !== 'archived') {
          throw substratError('conflict',
            `scope ${scopeId} is ${rec.status}, not archived — only an archived scope may be reaped`,
          );
        }
        // A serving scope always holds ≥1 bound hostname; a truly-dead one has been
        // unbound. The dashboard delete path unbinds AT archive, but a bare console
        // `archiveScope` does not — so reap cannot ASSUME the release, it must verify it.
        // Refuse (fail closed) while any name still resolves here: unbinding first is a
        // visible, reversible step, and it is the wall that stops the irreversible wipe
        // from ever landing on an app that is still online (§4.4). `force` is the
        // deliberate-teardown bypass (tenant reap / retention sweep), where every name is
        // being released anyway; the interactive per-scope reap never sets it.
        const bound = opts?.force ? [] : await this.cp.listHostnames({ scopeId, limit: 1 });
        if (bound.length > 0) {
          throw substratError('conflict',
            `scope ${scopeId} still resolves hostname '${bound[0]!.hostname}' — ` +
              `unbind it before reaping (reap wipes storage and cannot be undone)`,
          );
        }
        await this.scopeStub(scopeId).destroyStorage();
        // The recoverable copy the caller stored first (#493), named in the audit entry so
        // the trail answers "was there a backup" without correlating two timestamps.
        await transitionScope(actor, 'reapScope', tenantId, scopeId, ['archived'], 'reaped', {
          backupRef: opts?.backupRef ?? null,
        });
      },
      // -- subject erasure (#37) ----------------------------------------------
      sealSubjectPayloads: async (actor, tenantId, scopeId, items) => {
        await this.assertScope(tenantId, scopeId);
        const sealed = await this.subjectKeysFor(tenantId, scopeId).sealMany(items);
        await this.recordAccess(
          actor,
          'sealSubjectPayloads',
          { tenantId, scopeId },
          { subjects: new Set(items.map((i) => i.subjectId)).size },
          sealed.filter((s) => s !== null).length,
        );
        return sealed;
      },
      openSubjectPayloads: async (actor, tenantId, scopeId, items) => {
        await this.assertScope(tenantId, scopeId);
        const opened = await this.subjectKeysFor(tenantId, scopeId).openMany(items);
        await this.recordAccess(
          actor,
          'openSubjectPayloads',
          { tenantId, scopeId },
          { subjects: new Set(items.map((i) => i.subjectId)).size },
          opened.filter((o) => o !== null).length,
        );
        return opened;
      },
      shredSubject: async (actor, tenantId, scopeId, subjectId): Promise<SubjectShredReceipt> => {
        await this.assertScope(tenantId, scopeId);
        // Redact the live spine FIRST, destroy the key LAST. Both halves are idempotent and
        // a crash between them converges on retry, so the order is decided by which
        // half-done state harms the person: dying after the redaction leaves ciphertext in
        // a backup that no key opens; destroying the key first would leave their PII in the
        // live database while the audit log already claims they were erased.
        // Both spine copies (#1600): the outbox row AND any platform intent this event was
        // routed into. One RPC, so a crash cannot land half of it.
        const redacted = await this.scopeStub(scopeId).redactSubject(subjectId);
        // A refusal answered as data (#2068) — a module's `onSubjectErased` hook threw or reached
        // past its own tables, and the DO rolled the whole redaction back. Rethrown with its code,
        // before the key.
        if (typeof redacted === 'object' && 'failure' in redacted && redacted.failure) {
          throw fromWireFailure(redacted.failure);
        }
        // An OLD ScopeDO answers with a bare number — it redacted the outbox and never
        // looked at the intent journal. Refused here, BEFORE the key is destroyed, and
        // that order is the whole point: the key is the irreversible half, so proceeding
        // would leave the subject's platform-retained copies permanently unreadable, their
        // name still sitting in `_substrat_platform_requests`, and no admin-log row at all
        // (the log is written after this). Refusing leaves an erasure that can simply be
        // re-run once the scope is redeployed. Loud rather than partial, the way this
        // interface's reverse skew is left loud on `recordScheduleRun`.
        if (typeof redacted === 'number') {
          throw substratError(
            'unavailable',
            `scope ${scopeId} runs a ScopeDO from before #1600, whose redaction does not reach ` +
              `_substrat_platform_requests — erasing now would destroy the subject key while ` +
              `leaving their payloads in the intent journal. Redeploy the vertical and re-run.`,
          );
        }
        // A DO from after #1600 and before #1632: it redacted the outbox and the intent
        // journal and never looked at the job-run tables. Refused BEFORE the key, for the
        // reason above — its reply read as `jobRuns: 0` would receipt an erasure that left
        // the person in a step's memo.
        if (!('jobRuns' in redacted) || typeof redacted.jobRuns !== 'number') {
          throw substratError(
            'unavailable',
            `scope ${scopeId} runs a ScopeDO from before #1632, whose redaction does not reach ` +
              `_substrat_job_runs or _substrat_job_steps — erasing now would destroy the subject ` +
              `key while leaving their data in the job-run tables. Redeploy the vertical and re-run.`,
          );
        }
        // A DO from before the free-text half (#1632): it never looked at the idempotency
        // ledger or a queued sweep record, and cannot name the intents the directory's drain
        // failures quote. Refused before the key, for the reason above.
        if (
          !('idempotencyResults' in redacted) ||
          typeof redacted.idempotencyResults !== 'number' ||
          !Array.isArray(redacted.intentIds)
        ) {
          throw substratError(
            'unavailable',
            `scope ${scopeId} runs a ScopeDO whose redaction does not reach _substrat_idempotency ` +
              `or a queued sweep-runs intent — erasing now would destroy the subject key while ` +
              `leaving their data in those rows. Redeploy the vertical and re-run.`,
          );
        }
        // A DO from before the module half (#2068): it redacted the spine and never ran a
        // module's declared erasure or its `onSubjectErased` hook. Refused before the key, for
        // the reason above — its reply read as "no module rows" would receipt an erasure that
        // left the person in the vertical's own tables, with the key already gone.
        if (!('vertical' in redacted) || !isModuleErasureCounts(redacted.vertical)) {
          throw substratError(
            'unavailable',
            `scope ${scopeId} runs a ScopeDO from before #2068, whose redaction does not reach a module's ` +
              `own tables — erasing now would destroy the subject key while leaving their data in the ` +
              `vertical's rows. Redeploy the vertical and re-run.`,
          );
        }
        const {
          events: eventsRedacted,
          intents: intentsRedacted,
          jobRuns: jobRunsRedacted,
          idempotencyResults,
          intentIds,
          vertical,
        } = redacted;
        // The directory's failure text (#1632) — a drain failure quoting one of those intents,
        // an issue's exemplar, a sweep record's error. Still before the key.
        await this.cp.redactSubjectText({ tenantId, scopeId, subjectId, intentIds });
        const at = new Date().toISOString();
        const { existed } = await this.subjectKeysFor(tenantId, scopeId).destroy(subjectId, at);
        const receipt = subjectShredReceipt.parse({
          subjectId,
          eventsRedacted,
          intentsRedacted,
          jobRunsRedacted,
          ...vertical,
          keyDestroyed: existed,
          tombstoned: true,
        });
        // BOTH logs, deliberately: the admin log because this is a mutation, the access log
        // because it destroys evidence. An erasure is the one action where "who asked for
        // this to disappear" is itself part of the record.
        await this.recordAdmin(actor, 'shredSubject', { tenantId, scopeId }, null, receipt);
        // BOTH counts: the access log's number is "how much evidence this destroyed", and
        // an intent payload is a whole event's worth of it.
        await this.recordAccess(
          actor,
          'shredSubject',
          { tenantId, scopeId },
          { subjectId },
          eventsRedacted + intentsRedacted + jobRunsRedacted + idempotencyResults + moduleRowsErased(vertical),
        );
        return receipt;
      },

      // -- impersonation (K-42, #868) ----------------------------------------

      beginImpersonation: async (
        actor: PlatformActorId,
        input: BeginImpersonationInput,
      ): Promise<ImpersonationSession> => {
        // Fail closed on the scope before minting anything: a session naming a
        // scope that is not there is a credential for nothing, and issuing one
        // anyway leaves the admin log recording an access that could not happen.
        await this.assertScope(input.tenantId, input.scopeId);
        const session = newImpersonationSession(
          ulid(),
          actor,
          input,
          new Date().toISOString() as Instant,
        );
        await this.cp.writeImpersonation(impersonationRowValues(session));
        // BEFORE the session is usable, so the log entry precedes every row it
        // will ever touch. The reason rides in `after`: it is what a review reads
        // first, and a log saying a session opened but not why is half a record.
        await this.recordAdmin(
          actor,
          'beginImpersonation',
          { tenantId: session.tenantId, scopeId: session.scopeId },
          null,
          session,
        );
        return session;
      },

      endImpersonation: async (
        actor: PlatformActorId,
        id: ImpersonationSessionId,
      ): Promise<ImpersonationSession> => {
        const row = await this.cp.readImpersonation(String(id));
        if (!row) throw new ImpersonationRefused(`unknown impersonation session: ${id}`);
        const before = mapImpersonationRow(row);
        // Idempotent: "stop that session" must not fail because somebody else
        // already stopped it.
        if (before.endedAt !== null) return before;
        await this.cp.endImpersonation(String(id), new Date().toISOString());
        const after = mapImpersonationRow((await this.cp.readImpersonation(String(id)))!);
        await this.recordAdmin(
          actor,
          'endImpersonation',
          { tenantId: after.tenantId, scopeId: after.scopeId },
          before,
          after,
        );
        return after;
      },

      listImpersonations: async (
        actor: PlatformActorId,
        filter?: ImpersonationFilter,
      ): Promise<ImpersonationSession[]> => {
        const rows = await this.cp.listImpersonations(filter ?? {}, new Date().toISOString());
        const sessions = rows.map(mapImpersonationRow);
        // A staff READ, logged like every other one (K-24) — `result_count`
        // included, which is what separates "checked one session" from
        // "enumerated every support session on the platform".
        await this.recordAccess(
          actor,
          'listImpersonations',
          { tenantId: (filter?.tenantId ?? null) as TenantId | null },
          filter ?? null,
          sessions.length,
        );
        return sessions;
      },
      grantEntitlement: async (actor, tenantId, entitlementKey, plan?) => {
        const input = entitlementGrantInput.parse(plan ?? {});
        const result = await this.cp.grantEntitlement(tenantId, entitlementKey, input, actor);
        if (!result.changed) return; // idempotent — an unchanged grant is not audited
        await this.recordAdmin(
          actor,
          'grantEntitlement',
          { tenantId },
          result.before
            ? {
                entitlementKey,
                expiresAt: result.before.expires_at,
                quota: result.before.quota,
                plan: result.before.plan,
              }
            : null,
          {
            entitlementKey,
            expiresAt: result.after.expires_at,
            quota: result.after.quota,
            plan: result.after.plan,
          },
        );
        // #304: an entitlement change is a tenant-level write, so it fans out into the
        // tenant's projected scopes — the invalidation half of the OQ5 answer. A no-op
        // unless scope-local projection is on; the reconcile sweep repairs any drop.
        await this.fanOut(tenantId);
      },
      revokeEntitlement: async (actor, tenantId, entitlementKey) => {
        const removed = await this.cp.revokeEntitlement(tenantId, entitlementKey);
        if (!removed) return; // nothing held, nothing changed
        await this.recordAdmin(
          actor,
          'revokeEntitlement',
          { tenantId },
          { entitlementKey, expiresAt: removed.expires_at, quota: removed.quota, plan: removed.plan },
          null,
        );
        // The revoke must reach the projected scopes so a running vertical stops honouring
        // the entitlement — a dropped fan-out here would leave it enforcing a stale grant.
        await this.fanOut(tenantId);
      },
      listEntitlements: async (actor, tenantId): Promise<EntitlementGrant[]> => {
        const rows = await this.cp.listEntitlements(tenantId);
        const grants = rows.map((r) =>
          entitlementGrant.parse({
            entitlementKey: r.entitlement_key,
            expiresAt: r.expires_at,
            quota: r.quota,
            plan: r.plan,
            grantedAt: r.granted_at,
            grantedBy: r.granted_by,
          }),
        );
        await this.recordAccess(actor, 'listEntitlements', { tenantId }, null, grants.length);
        return grants;
      },
      readMeters: async (actor, filter?: { tenantId?: TenantId }): Promise<MeterReading> => {
        const only = filter?.tenantId;
        const rows = await this.cp.meterRows(only);
        const reading = foldMeterReading({
          readAt: instant.parse(new Date().toISOString()),
          tenants: rows.tenants.map((r) => ({
            tenantId: r.tenant_id as TenantId,
            slug: r.slug,
            status: r.status as TenantStatus,
          })),
          scopes: rows.scopes.map((r) => ({
            tenantId: r.tenant_id as TenantId,
            status: r.status as ScopeStatus,
          })),
          entitlements: rows.entitlements.map((r) => ({
            tenantId: r.tenant_id as TenantId,
            entitlementKey: r.entitlement_key,
            plan: r.plan,
            expiresAt: r.expires_at,
          })),
        });
        // Tenants covered, not totals: "read one tenant's meter" and "metered the whole
        // fleet" are different acts, and K-24 exists to tell them apart.
        await this.recordAccess(
          actor,
          'readMeters',
          { tenantId: only ?? null },
          filter ?? null,
          reading.perTenant.length,
        );
        return meterReading.parse(reading);
      },
      registerIdentityPool: async (actor, input: IdentityPool) => {
        const parsed = identityPool.parse(input);
        const created = await this.directory('registerIdentityPool',
          parsed.provider,
          parsed.topology,
          parsed.tenantId,
          new Date().toISOString(),
        );
        if (!created) return; // identical registration is idempotent, unaudited
        // Null tenant for a central pool: it belongs to no single tenant, which is
        // what made the admin log's tenantId nullable.
        await this.recordAdmin(actor, 'registerIdentityPool', { tenantId: parsed.tenantId }, null, parsed);
      },
      getIdentityPool: async (actor, provider: string) => {
        const r = await this.cp.readPool(provider);
        await this.recordAccess(actor, 'getIdentityPool', {}, { provider }, r ? 1 : 0);
        return r
          ? identityPool.parse({ provider: r.provider, topology: r.topology, tenantId: r.tenant_id })
          : undefined;
      },
      listIdentityTenants: async (actor, provider: string, externalId: string) => {
        const r = await this.cp.readPool(provider);
        if (!r) throw substratError('not_found', `identity pool '${provider}' is not registered`);
        if (r.topology !== 'central') {
          throw substratError('forbidden',
            `identity pool '${provider}' is tenant-bound — enumerating tenants is only ` +
              `meaningful on a central pool, where the same externalId is the same person`,
          );
        }
        const tenants = (await this.cp.identityTenants(provider, externalId)) as TenantId[];
        await this.recordAccess(actor, 'listIdentityTenants', {}, { provider }, tenants.length);
        return tenants;
      },
      listIdentityMemberships: async (
        actor,
        provider: string,
        externalId: string,
      ): Promise<IdentityMembership[]> => {
        // ONE round trip: the pool check, the join and the K-24 row all happen inside
        // the directory's own call. The id and timestamp are minted here, as
        // `recordAccess` mints them, so the log row is shaped exactly like its siblings.
        const { topology, memberships } = await this.cp.identityMemberships(provider, externalId, {
          id: ulid(),
          actor,
          at: new Date().toISOString(),
        });
        if (topology === null) throw substratError('not_found', `identity pool '${provider}' is not registered`);
        if (topology !== 'central') {
          throw substratError('forbidden',
            `identity pool '${provider}' is tenant-bound — enumerating tenants is only ` +
              `meaningful on a central pool, where the same externalId is the same person`,
          );
        }
        return memberships.map((m) => identityMembership.parse(m));
      },
      listIdentityLinks: async (actor, tenantId): Promise<IdentityLink[]> => {
        const rows = await this.cp.dumpTenantIdentities(tenantId);
        const links = rows.map((r) =>
          identityLink.parse({
            provider: r.provider,
            externalId: r.external_id,
            principal: r.principal_id,
            tenantId,
            scopeId: r.scope_id ?? undefined,
          }),
        );
        await this.recordAccess(actor, 'listIdentityLinks', { tenantId }, null, links.length);
        return links;
      },
      // -- the integrations hub (#101) ---------------------------------------

      createConnection: async (actor, raw: CreateConnectionInput) => {
        const input = createConnectionInput.parse(raw);
        // Sealed HERE, on the coordinator: the DO never holds a SecretBox and has
        // never seen a plaintext credential.
        const sealed = await this.secretBox.seal(JSON.stringify(input.secret));
        const now = new Date().toISOString();
        await this.cp.insertConnection({
          id: input.id,
          tenantId: input.tenantId,
          vertical: input.vertical,
          provider: input.provider,
          label: input.label,
          externalAccountRef: input.externalAccountRef ?? null,
          scopes: JSON.stringify(input.scopes),
          expiresAt: input.expiresAt ?? null,
          // The authorizing principal when supplied (a self-serve connect), else the
          // effecting platform actor. See connections.md §3.5.1 / createConnectionInput.
          createdBy: input.createdBy ?? actor,
          createdAt: now,
          keyId: sealed.keyId,
          ciphertext: sealed.ciphertext,
        });
        // METADATA ONLY — the admin log is append-only, so a credential written
        // here could never be removed.
        await this.recordAdmin(
          actor,
          'createConnection',
          { tenantId: input.tenantId, vertical: input.vertical },
          null,
          {
            id: input.id,
            provider: input.provider,
            label: input.label,
            scopes: input.scopes,
            externalAccountRef: input.externalAccountRef ?? null,
            createdBy: input.createdBy ?? actor,
          },
        );
      },

      connectionSealingKey: (id: ConnectionId) => this.ensureSealingKey(id),

      connectionSealingKeys: async (tenantId: TenantId, vertical: string) => {
        // LIVE connections only. A revoked connection's key is KEPT (its pending
        // ciphertext must still open) but stops being projected, so a scope can no
        // longer seal to a credential that has been withdrawn.
        const rows = await this.cp.listConnections({ tenantId, vertical });
        const out: ProjectedConnectionKey[] = [];
        for (const r of rows) out.push(await this.ensureSealingKey(r.id as ConnectionId));
        return out;
      },

      listConnections: async (actor, filter?: ConnectionFilter) => {
        const f = filter ?? {};
        const rows = await this.cp.listConnections(f);
        await this.recordAccess(actor, 'listConnections', {}, f, rows.length);
        return rows.map(toConnection);
      },

      listConnectionGrants: async (actor, tenantId: TenantId) => {
        // #592: live rows only — the gather source for provision/reconcile delivery,
        // and the readable "what may this connection invoke". A revoked connection's
        // grants are tombstoned by the revoke cascade and absent by construction.
        const rows = await this.cp.listConnectionGrants(tenantId);
        await this.recordAccess(actor, 'listConnectionGrants', { tenantId }, null, rows.length);
        return rows.map((r) =>
          connectionGrantRecord.parse({
            connectionId: r.connection_id,
            tenantId: r.tenant_id,
            vertical: r.vertical,
            permission: r.permission,
            scopeId: r.scope_id,
            expiresAt: r.expires_at,
            grantedBy: r.granted_by,
            grantedAt: r.granted_at,
            revokedAt: r.revoked_at,
          }),
        );
      },

      updateConnectionSecret: async (
        actor,
        id: ConnectionId,
        secret: ConnectionSecret,
        expiresAt?: string,
        opts?: { rotatedBy?: string },
      ) => {
        const row = await this.cp.readConnection(id);
        if (!row) throw new Error(`connection not found: ${id}`);
        const sealed = await this.secretBox.seal(JSON.stringify(connectionSecret.parse(secret)));
        const now = new Date().toISOString();
        await this.cp.updateConnectionSecret(
          id,
          sealed.keyId,
          sealed.ciphertext,
          expiresAt ?? row.expires_at,
          now,
        );
        await this.recordAdmin(
          actor,
          'updateConnectionSecret',
          { tenantId: row.tenant_id as TenantId, vertical: row.vertical },
          null,
          {
            id,
            provider: row.provider,
            rotatedAt: now,
            expiresAt: expiresAt ?? row.expires_at,
            // §3.5.1's attribution, rotate-side: the authorizing tenant principal,
            // never laundered into the actor column.
            ...(opts?.rotatedBy ? { rotatedBy: opts.rotatedBy } : {}),
          },
        );
      },

      revokeConnection: async (actor, id: ConnectionId) => {
        const row = await this.cp.readConnection(id);
        if (!row) throw new Error(`connection not found: ${id}`);
        const now = new Date().toISOString();
        const changed = await this.cp.revokeConnection(id, now);
        if (!changed) return; // idempotent, and a no-op is not audited
        await this.recordAdmin(
          actor,
          'revokeConnection',
          { tenantId: row.tenant_id as TenantId, vertical: row.vertical },
          { status: row.status },
          { id, provider: row.provider, status: 'revoked', revokedAt: now },
        );
      },

      // -- a vertical's mailed connect links (connections.md §3.5.4) --------------
      // Parsed here, run in the ControlPlaneDO as the kernel's statements (shared with
      // the pure adapter). Each move writes its audit row in the DO's own unit, from the
      // row minted here (actor, attribution) — so a failed audit write rolls the move back.
      // The DO has no clock of its own on this path — `now` is the coordinator's, the same
      // wall clock every other directory write uses.

      mintConnectLink: async (actor, raw: MintConnectLinkInput) => {
        const input = mintConnectLinkInput.parse(raw);
        return this.cp.insertConnectLink(
          {
            id: ulid(),
            tenantId: input.tenantId,
            scopeId: input.scopeId,
            vertical: input.vertical,
            provider: input.provider,
            createdBy: input.createdBy,
            subjectRef: input.subjectRef ?? null,
            returnUrl: input.returnUrl ?? null,
            createdAt: new Date().toISOString(),
            expiresAt: input.expiresAt,
          },
          this.adminEntry(actor, 'mintConnectLink', { tenantId: input.tenantId }, null, null),
        );
      },

      getConnectLink: async (actor, raw: ConnectLinkKey) => {
        const key = connectLinkKey.parse(raw);
        const link = await this.cp.readConnectLink(key);
        await this.recordAccess(actor, 'getConnectLink', key, { id: key.id }, link ? 1 : 0);
        return link;
      },

      listConnectLinks: async (actor, raw: ConnectLinkFilter) => {
        const filter = connectLinkFilter.parse(raw);
        const links = await this.cp.listConnectLinks(filter, new Date().toISOString());
        await this.recordAccess(actor, 'listConnectLinks', filter, filter, links.length);
        return links;
      },

      revokeConnectLink: async (actor, raw: ConnectLinkKey) => {
        const key = connectLinkKey.parse(raw);
        // Idempotent, and a no-op is not audited (the statement hands back no row for one).
        const audit = this.adminEntry(actor, 'revokeConnectLink', { tenantId: key.tenantId }, null, null);
        return (await this.cp.revokeConnectLink(key, audit))?.link;
      },

      consumeConnectLink: async (actor, raw: ConsumeConnectLinkInput) => {
        const input = consumeConnectLinkInput.parse(raw);
        const audit = this.adminEntry(actor, 'consumeConnectLink', { tenantId: input.tenantId }, null, null);
        return this.cp.consumeConnectLink(input, new Date().toISOString(), audit);
      },

      restoreConnectLink: async (actor, raw: ConnectLinkKey) => {
        const key = connectLinkKey.parse(raw);
        const audit = this.adminEntry(actor, 'restoreConnectLink', { tenantId: key.tenantId }, null, null);
        return (await this.cp.restoreConnectLink(key, new Date().toISOString(), audit)) !== undefined;
      },

      openConnection: async (
        tenantId,
        vertical: string,
        provider: string,
        externalAccountRef?: string,
      ) => {
        const row = await this.cp.readLiveConnection(tenantId, vertical, provider, externalAccountRef);
        if (!row) return undefined;
        const secret = connectionSecret.parse(
          JSON.parse(
            await this.secretBox.open({ keyId: row.key_id, ciphertext: row.ciphertext }),
          ),
        );
        return {
          id: row.id as ConnectionId,
          tenantId: row.tenant_id,
          vertical: row.vertical,
          provider: row.provider,
          secret,
          expiresAt: row.expires_at,
        };
      },

      recordConnectionUse: async (id: ConnectionId, outcome: ConnectionUseOutcome) => {
        const row = await this.cp.recordConnectionUse(
          id,
          outcome.ok ? null : outcome.error,
          new Date().toISOString(),
        );
        // #1691: the line is settled — now the data point, off the identity the DO read
        // from the row (never the caller's input), fire-and-forget.
        if (row) recordConnectorCall(this.connectorCalls, connectorCallRecord(row, outcome));
      },

      putConnectorState: async (id: ConnectionId, key: string, value: unknown) => {
        // JSON on the coordinator; the DO stores an opaque string, the same
        // division that keeps the SecretBox off the DO.
        await this.cp.putConnectorState(id, key, JSON.stringify(value ?? null), new Date().toISOString());
      },

      getConnectorState: async (id: ConnectionId, key: string) => {
        const raw = await this.cp.getConnectorState(id, key);
        return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
      },

      listConnectorState: async (id: ConnectionId, prefix?: string) => {
        // The DO stores opaque strings; JSON lives on the coordinator, the same
        // division get/put keep. Prefix filtering happened DO-side.
        const rows = await this.cp.listConnectorState(id, prefix);
        return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
      },

      linkIdentity: async (actor, input: IdentityLink) => {
        const parsed = identityLink.parse(input);
        const pool = await this.cp.readPool(parsed.provider);
        if (!pool) {
          throw substratError('conflict',
            `identity pool '${parsed.provider}' is not registered — a pool must declare ` +
              `its topology before it may link (central vs tenant-bound decides whether ` +
              `the same externalId in two tenants is one person or two)`,
          );
        }
        if (pool.topology === 'tenant-bound' && pool.tenant_id !== parsed.tenantId) {
          throw substratError('conflict',
            `identity pool '${parsed.provider}' is bound to tenant ${pool.tenant_id} and cannot link into ${parsed.tenantId}`,
          );
        }
        const changed = await this.directory('linkIdentity',
          parsed.provider,
          parsed.externalId,
          parsed.principal,
          parsed.tenantId,
          parsed.scopeId ?? null,
          new Date().toISOString(),
        );
        // Idempotent: an identity already bound is a no-op, not audited.
        if (!changed) return;
        await this.recordAdmin(
          actor,
          'linkIdentity',
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId },
          null,
          { provider: parsed.provider, externalId: parsed.externalId, principal: parsed.principal },
        );
        // #406: an identity link is a tenant-level write, so it fans out into the tenant's
        // projected scopes exactly as entitlements do (#304) — a no-op unless scope-local
        // projection is on; the reconcile sweep repairs any drop.
        await this.fanOut(parsed.tenantId);
      },
      unlinkIdentity: async (actor, tenantId: TenantId, principal: PrincipalId) => {
        // DELETE by principal (audit is the log), so the caller who removed a member
        // can sever their login without knowing the external subject. Idempotent.
        const changed = await this.cp.unlinkIdentity(tenantId, principal);
        if (!changed) return;
        await this.recordAdmin(actor, 'unlinkIdentity', { tenantId, scopeId: null }, { principal }, null);
        // The unlink must reach the projected scopes so the severed login stops resolving
        // there — this is what makes revocation durable at request time (#406); a dropped
        // fan-out is repaired by the reconcile sweep.
        await this.fanOut(tenantId);
      },
      resolveIdentity: async (
        tenantId,
        provider,
        externalId,
      ): Promise<ResolvedIdentity | undefined> => {
        const row = await this.cp.resolveIdentity(tenantId, provider, externalId);
        if (!row) return undefined;
        return resolvedIdentity.parse({ principal: row.principal, scopeId: row.scopeId });
      },
      /**
       * #1357: the K-24 row for a read this control plane delegated to a vertical.
       *
       * Routed through the SAME `recordAccess` the co-located branch uses rather than
       * writing the table directly — the id, the timestamp and the param truncation are
       * that helper's, so a delegated row and a co-located one are indistinguishable,
       * which is the point of the seam.
       */
      recordDelegatedRead: async (actor, record) => {
        const parsed = delegatedReadRecord.parse(record);
        await this.recordAccess(
          actor,
          parsed.method,
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId },
          parsed.params,
          parsed.resultCount,
        );
      },
      /**
       * #1665: one phase of an owner hand-over the control plane ran against the vertical that
       * holds the scope's owner seat. Parsed, then written as an ordinary `transferOwner` row:
       * the id and instant are stamped here, the actor is the request's.
       */
      recordOwnerTransfer: async (actor, entry) => {
        const { tenantId, scopeId, ...after } = ownerTransferAudit.parse(entry);
        await this.recordAdmin(actor, 'transferOwner', { tenantId, scopeId }, null, after);
      },
      /** #1150: one phase of a dashboard member change, written around the vertical's own. */
      recordMemberChange: async (actor, entry) => {
        const { tenantId, scopeId, ...after } = memberChangeAudit.parse(entry);
        await this.recordAdmin(actor, 'manageScopeMember', { tenantId, scopeId }, null, after);
      },
      /** #2064: an audited operation's rows, by the operation-id index, in bounded batches. */
      auditedOperations: async (actor, refs) => {
        const rows = await this.cp.auditedOperations([...refs]);
        await this.recordAccess(actor, 'auditedOperations', {}, { operations: refs.length }, rows.length);
        return rows;
      },
      /** #2064: settle an intent with no outcome — one unit in the directory DO. */
      settleUnrecordedOutcome: (actor, input) =>
        this.cp.settleUnrecordedOutcome({ actor, intentId: input.intentId, error: input.error }),
      /** #2005: one change to a scope's copy marker, written around the vertical's own change. */
      recordCopyMark: async (actor, entry) => {
        const { tenantId, scopeId, action, ...after } = copyMarkAudit.parse(entry);
        await this.recordAdmin(actor, action === 'mark' ? 'markScopeCopy' : 'clearScopeCopyMark', { tenantId, scopeId }, null, after);
      },
      accessLog: async (actor, filter?: AccessLogFilter): Promise<AccessLogEntry[]> => {
        const rows = await this.cp.accessLog({
          actor: filter?.actor,
          tenantId: filter?.tenantId,
          method: filter?.method,
          drained: filter?.drained,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        // Reading the access log is itself a read. Recorded before returning, so
        // the row describing this call is not in its own result.
        await this.recordAccess(actor, 'accessLog', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
        return rows.map((r) =>
          accessLogEntry.parse({
            id: r.id,
            actor: r.actor,
            method: r.method,
            tenantId: r.tenant_id,
            scopeId: r.scope_id,
            params: r.params,
            resultCount: r.result_count,
            drainedAt: r.drained_at,
            at: r.at,
          }),
        );
      },
      markAccessLogDrained: async (actor, upToId: string, drainedAt: string): Promise<number> => {
        const drained = await this.cp.markAccessLogDrained(upToId, drainedAt);
        if (drained > 0) {
          // The payload is the APPLIED state, so it belongs in `after` (contracts'
          // adminLogEntry: before = prior state, after = the applied payload).
          await this.recordAdmin(
            actor,
            'drainAccessLog',
            { tenantId: null },
            null,
            { drained, upToId, drainedAt },
          );
        }
        return drained;
      },
      pruneAccessLog: async (actor, limit: number): Promise<number> => {
        // Checked here as well as in the directory, so the refusal keeps its code across the hop.
        const pruned = await this.cp.pruneAccessLog(assertRowLimit('limit', limit));
        if (pruned > 0) {
          // The payload is the APPLIED state, so it belongs in `after` (contracts'
          // adminLogEntry: before = prior state, after = the applied payload) — the
          // same shape as drainAccessLog's row above (#557).
          await this.recordAdmin(actor, 'pruneAccessLog', { tenantId: null }, null, { pruned });
        }
        return pruned;
      },
      auditLog: async (actor, filter?: AuditLogFilter): Promise<AdminLogEntry[]> => {
        const rows = await this.cp.auditLog({
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
          actor: filter?.actor,
          // Normalised to an array here so the DO has one shape to handle.
          action: filter?.action
            ? Array.isArray(filter.action)
              ? filter.action
              : [filter.action]
            : undefined,
          since: filter?.since,
          until: filter?.until,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        // Reading the audit trail is itself audited.
        await this.recordAccess(
          actor,
          'auditLog',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map((r) => adminLogEntry.parse(r));
      },
      recordOpsFailure: async (entry: OpsFailureInput): Promise<void> => {
        await this.cp.recordOpsFailure({
          id: ulid(),
          actor: entry.actor,
          operation: entry.operation,
          stage: entry.stage ?? null,
          tenant_id: entry.tenantId ?? null,
          scope_id: entry.scopeId ?? null,
          vertical: entry.vertical ?? null,
          version: entry.version ?? null,
          status: entry.status ?? null,
          // Bounded here, not trusted from the catch site: one runaway upstream body
          // must not become a runaway directory row (#559).
          message: entry.message.slice(0, 2000),
          reference: entry.reference ?? null,
          origin: entry.origin ?? null,
          code: entry.code ?? null,
          fingerprint: opsFailureFingerprint(entry),
          at: new Date().toISOString(),
        });
      },
      listOpsFailures: async (actor, filter?: OpsFailureFilter): Promise<OpsFailureEntry[]> => {
        const rows = await this.cp.listOpsFailures({
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
          vertical: filter?.vertical,
          version: filter?.version,
          operation: filter?.operation,
          code: filter?.code,
          fingerprint: filter?.fingerprint,
          reference: filter?.reference,
          since: filter?.since,
          until: filter?.until,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        // Rows can name tenants and scopes, so reading them is recorded like the
        // audit trail's own reads (K-24).
        await this.recordAccess(
          actor,
          'listOpsFailures',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map((r) => opsFailureEntry.parse(r));
      },
      recordSweepRun: async (entry: SweepRunInput): Promise<void> => {
        await this.cp.recordSweepRun({
          id: ulid(),
          kind: entry.kind,
          unit: entry.unit,
          outcome: entry.outcome,
          tenant_id: entry.tenantId ?? null,
          scope_id: entry.scopeId ?? null,
          vertical: entry.vertical ?? null,
          version: entry.version ?? null,
          operation: entry.operation ?? null,
          connection_id: entry.connectionId ?? null,
          // Bounded here, not trusted from the sweep (the #559 rule).
          error: entry.error == null ? null : entry.error.slice(0, 2000),
          elapsed_ms: entry.elapsedMs ?? null,
          request_id: entry.requestId ?? null,
          event_type: entry.eventType ?? null,
          observed_at: entry.observedAt ?? null,
          platform_requests: entry.platformRequests == null ? null : JSON.stringify(entry.platformRequests),
          at: entry.at ?? new Date().toISOString(),
        });
      },
      listSweepRuns: async (actor, filter?: SweepRunFilter): Promise<SweepRunEntry[]> => {
        const rows = await this.cp.listSweepRuns({
          kind: filter?.kind,
          unit: filter?.unit,
          outcome: filter?.outcome,
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
          vertical: filter?.vertical,
          connectionId: filter?.connectionId,
          since: filter?.since,
          until: filter?.until,
          limit: filter?.limit,
          cursor: filter?.cursor,
          order: filter?.order,
        });
        // Rows can name tenants and scopes, so reading them is recorded (K-24).
        await this.recordAccess(
          actor,
          'listSweepRuns',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map((r) => sweepRunEntry.parse(r));
      },
      // Checked here as well as in the directory, so the refusal keeps its code across the hop.
      pruneTelemetry: async (_actor, limit: number): Promise<TelemetryPruneReport> =>
        this.cp.pruneTelemetry(assertRowLimit('limit', limit)),
      // #1748: the DO writes each stale resolution's audit row in the same unit, from this one.
      pruneFindings: async (actor, limit: number): Promise<FindingPruneReport> =>
        this.cp.pruneFindings(
          assertRowLimit('limit', limit),
          this.adminEntry(actor, 'resolveStaleFinding', { tenantId: null }, null, null),
        ),
      listIssues: async (actor, filter?: IssueFilter): Promise<IssueEntry[]> => {
        const rows = await this.cp.listIssues({
          status: filter?.status,
          operation: filter?.operation,
          code: filter?.code,
          limit: filter?.limit,
        });
        // Issues aggregate fleet-wide failures; the read is recorded like the rows' own (K-24).
        await this.recordAccess(actor, 'listIssues', {}, filter, rows.length);
        return rows.map((r) => issueEntry.parse(r));
      },
      setIssueStatus: async (actor, fingerprint, status): Promise<IssueEntry | undefined> => {
        const change = await this.cp.setIssueStatus(fingerprint, status, new Date().toISOString());
        if (!change) return undefined;
        const before = issueEntry.parse(change.before);
        const after = issueEntry.parse(change.after);
        // A lifecycle flip is a staff mutation — audited with the diff (K-33).
        await this.recordAdmin(
          actor,
          'setIssueStatus',
          { tenantId: null, vertical: after.lastVertical },
          { fingerprint, status: before.status },
          { fingerprint, status: after.status },
        );
        return after;
      },
      listFindings: async (actor, filter?: FindingFilter): Promise<FindingEntry[]> => {
        const rows = await this.cp.listFindings({ ...filter });
        await this.recordAccess(actor, 'listFindings', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
        return rows.map((r) => findingEntry.parse(r));
      },
      // #1748: each findings mutation writes its audit row in the DO's own unit, from the row
      // minted here (actor, attribution) — so a failed audit write rolls the mutation back.
      setFindingStatus: async (actor, tenantId, id, status): Promise<FindingEntry | undefined> => {
        const audit = this.adminEntry(actor, 'setFindingStatus', { tenantId }, null, null);
        const change = await this.cp.setFindingStatus(tenantId, id, status, new Date().toISOString(), audit);
        return change ? findingEntry.parse(change.after) : undefined;
      },
      createFindingRule: async (actor, tenantId, input) => {
        const audit = this.adminEntry(actor, 'createFindingRule', { tenantId }, null, null);
        const created = await this.directory('createFindingRule', tenantId, input, actor, new Date().toISOString(), audit);
        return { rule: findingRuleEntry.parse(created.rule), suppressed: created.suppressed.length };
      },
      revokeFindingRule: async (actor, tenantId, ruleId): Promise<FindingRuleEntry | undefined> => {
        const audit = this.adminEntry(actor, 'revokeFindingRule', { tenantId }, null, null);
        const change = await this.cp.revokeFindingRule(tenantId, ruleId, new Date().toISOString(), audit);
        return change ? findingRuleEntry.parse(change.after) : undefined;
      },
      listFindingRules: async (actor, tenantId, filter): Promise<FindingRuleEntry[]> => {
        const rows = await this.cp.listFindingRules(
          tenantId,
          filter?.active ? new Date().toISOString() : undefined,
          filter?.limit,
        );
        await this.recordAccess(actor, 'listFindingRules', { tenantId }, filter, rows.length);
        return rows.map((r) => findingRuleEntry.parse(r));
      },
      recordModelUsage: async (input: ModelUsageInput): Promise<{ recorded: boolean }> => {
        const l = input.line;
        return this.cp.recordModelUsage({
          id: ulid(),
          request_id: input.requestId,
          tenant_id: l.attribution.tenant,
          scope_id: l.attribution.scope,
          vertical: l.attribution.vertical,
          version: l.attribution.version,
          operation: l.attribution.operation,
          model: l.model,
          provider: l.provider,
          model_id: l.modelId,
          reported: l.reported ? 1 : 0,
          input_tokens: l.inputTokens,
          output_tokens: l.outputTokens,
          cached_input_tokens: l.cachedInputTokens,
          cache_write_tokens: l.cacheWriteTokens,
          list_usd: l.listUsd,
          at: l.at,
          elapsed_ms: l.elapsedMs,
        });
      },
      listModelUsage: async (actor, filter?: ModelUsageFilter): Promise<ModelUsageEntry[]> => {
        const rows = await this.cp.listModelUsage({ ...filter });
        await this.recordAccess(
          actor,
          'listModelUsage',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map(modelUsageEntryOf);
      },
      summarizeModelUsage: async (actor, window: ModelUsageWindow, marginPercent: number): Promise<ModelUsageSummary> => {
        const rows = await this.cp.listModelUsage({ ...window, order: 'asc' });
        await this.recordAccess(actor, 'summarizeModelUsage', { tenantId: window.tenantId ?? null }, window, rows.length);
        return foldModelUsage(rows.map(modelUsageEntryOf), { readAt: new Date().toISOString(), ...window, marginPercent });
      },
    };
  }

  // -- helpers --------------------------------------------------------------

  /** A directory write whose refusal must keep its code across the DO hop (#113). */
  private async directory<M extends RepliedMethod>(
    method: M,
    ...args: Parameters<ControlPlaneStub[M]>
  ): Promise<Awaited<ReturnType<ControlPlaneStub[M]>>> {
    return unwrapReply(await this.cp.reply(method, args));
  }

  /**
   * The getScope gate (control-plane.md §4.1/§4.2) — the pair check, then the tenant's and
   * the scope's lifecycle — thrown on THIS side of the RPC (#1718). The ControlPlaneDO
   * answers its refusal as data, because an error thrown there arrives here flattened, with
   * no code; a record crosses intact.
   *
   * A CP-less host's null control plane answers nothing: the router made the pair check from
   * the shared directory. The scope's own storage then makes it again (#2016), against the
   * tenant it was provisioned for (`ScopeDO.admission`), so a vertical that passes a scope id
   * under the wrong tenant meets K-3's refusal at the door instead of relying on the permission
   * gate's grant data to deny it.
   *
   * Answers with the lifecycle the CP-less scope holds (#1713), read in the same DO call as the
   * pair check, so an `assertLive` door still costs one round-trip; a door that reads the scope
   * without the lifecycle half pays the one DO call the pair check needs. Null with a directory,
   * whose refusal already covered the lifecycle.
   */
  private async validateScopeAccess(tenantId: TenantId, scopeId: ScopeId): Promise<StoredScopeLifecycle | null> {
    const refusal = await this.cp.scopeAccessRefusal(tenantId, scopeId);
    if (refusal) {
      throw refusal.code
        ? substratError(refusal.code, refusal.message, refusal.reason ? { reason: refusal.reason } : undefined)
        : new Error(refusal.message);
    }
    if (!this.cpLess) return null;
    const { verdict, lifecycle } = await this.scopeStub(scopeId).admission(tenantId);
    if (verdict === 'foreign') throw unknownScopeForTenant(tenantId, scopeId);
    // A scope with no tenant record and no role rows has nothing to hold the pair against, so it is
    // let through — a compatibility state, not a steady one: the next reconcile (every push runs
    // one against the scopes behind it, #1172) or lifecycle delivery records the directory's tenant.
    // Logged on every admission, so an operator sees a scope that has not converged.
    if (verdict === 'unknown') console.warn(JSON.stringify(tenantUnrecordedLine(tenantId, scopeId)));
    return lifecycle;
  }

  /**
   * THE lifecycle gate (#1713) at every door that runs a scope's work: a request's stubs and
   * attachments, a capability or impersonation session, a peer call or delivery, a subscription,
   * and the entry points no request asked for — the retry driver, the job runner, a schedule's
   * system stub, a routed connector delivery.
   *
   * `validateScopeAccess` first, which is the directory's gate where there is a directory. A
   * CP-less host has none, so it then reads the lifecycle the platform delivered to the scope's
   * own storage (`/internal/lifecycle`), judged by the kernel's `lifecycleRefusal` in the
   * directory's own words. The router refuses a suspended scope's requests first (#1730); this
   * is the deployment's own half, and the only one a timer or a retry ever meets.
   *
   * The admin and diagnostic reads (dead letters, job runs, platform requests, delivered
   * grants) keep `validateScopeAccess` alone: an operator still reads a suspended scope.
   */
  private async assertLive(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    const refusal = lifecycleRefusal(await this.validateScopeAccess(tenantId, scopeId), { tenantId, scopeId });
    if (refusal) throw substratError('conflict', refusal, { reason: SCOPE_GATE_REASONS.notActive });
  }

  /**
   * Deliver the directory's lifecycle to the deployments serving the matching scopes (#1713):
   * one scope after its transition, a tenant's scopes after the tenant's, or the heal sweep's
   * drift. Each delivery carries the directory's revisions, read in the same query as the
   * statuses, so a late one cannot undo a later transition: the deployment keeps only a delivery
   * strictly newer than the one it holds.
   *
   * Never throws. A transition is the operator's lever in an incident, and the router refuses
   * the scope's requests as soon as the directory moves (#1730), so a deployment that cannot be
   * reached must not refuse the lever. Each failure is an ops-failure row, no receipt is written,
   * and the heal sweep delivers again.
   */
  private async deliverLifecycles(
    actor: PlatformActorId,
    filter: { tenantId?: TenantId; scopeId?: ScopeId; drift?: boolean; limit?: number },
  ): Promise<LifecycleDeliveryReport> {
    const report: LifecycleDeliveryReport = { attempted: 0, delivered: 0, failed: 0 };
    const delegation = this.lifecycleDelegation;
    if (!delegation || this.cpLess) return report;
    let targets: LifecycleTargetRow[];
    // #2016: the heal also asks the served scopes whose deployment has not answered that it holds a
    // record of the scope's tenant, a copy as much as a primary (no push reconciles a copy), until
    // each answers that it does. A bounded slice per pass, after the drift and the holds.
    const askTenant = new Set<string>();
    try {
      targets = await this.cp.lifecycleTargets(filter);
      if (filter.drift) {
        const unrecorded = await this.cp.lifecycleTargets({ unrecorded: true, limit: TENANT_UNRECORDED_PER_PASS });
        // Noted before asking, so an ask that fails (or a deployment that never answers) rotates
        // behind the scopes not asked yet, and the next pass reaches them.
        if (unrecorded.length > 0) await this.cp.recordTenantAsks(unrecorded.map((u) => u.scope_id), new Date().toISOString());
        const seen = new Set(targets.map((t) => t.scope_id));
        for (const u of unrecorded) {
          askTenant.add(u.scope_id);
          if (!seen.has(u.scope_id)) targets.push(u);
        }
      }
    } catch (err) {
      console.error('substrat: could not read the scopes to deliver a lifecycle to (#1713)', err);
      return report;
    }
    for (const first of targets) {
      const tenantId = first.tenant_id as TenantId;
      const scopeId = first.scope_id as ScopeId;
      let t = first;
      let lifecycle = this.lifecycleOfTarget(t);
      if (!lifecycle) {
        // A status this code does not know (a newer directory): delivering a guess could lift a hold.
        report.failed += 1;
        console.error(`substrat: scope ${scopeId} has a lifecycle this code cannot read (#1713)`);
        continue;
      }
      // A live scope whose deployment already acknowledged exactly this has nothing to receive,
      // and neither does one with no receipt in a directory never restored: a deployment holding
      // no lifecycle runs live. That keeps an activation, and every transition before a
      // deployment carries the route, from posting a delivery that changes nothing. After a
      // restore (epoch > 0) no receipt says nothing about what the deployment holds, so it is
      // delivered. A HOLD is always delivered, and so is a scope the heal asks for its tenant record.
      if (
        !askTenant.has(scopeId) &&
        lifecycleRefusal(lifecycle) === null &&
        (t.delivered === null ? t.epoch === 0 : t.delivered === lifecycleReceipt(lifecycle))
      ) {
        continue;
      }
      report.attempted += 1;
      try {
        let answer = await delegation.deliver({ tenantId, scopeId, lifecycle });
        // SINGLE AUTHORITY (the invariant this rests on): an environment has exactly one directory,
        // the singleton `CONTROL_PLANE.idFromName('control-plane')`. A "fresh directory" restore is
        // that same object restored after its storage was lost, never a second live writer, and
        // the raise below always re-reads the CURRENT store and delivers what it says. Two control
        // planes healing one dispatch namespace at once is a split brain that corrupts far more
        // than lifecycle, and is out of scope here; fencing it in lifecycle alone would guarantee
        // nothing.
        //
        // The scope refused us as OLDER while holding a revision this directory's history did not
        // write: an epoch ahead of ours, or ours with other counters. Only another history of the
        // directory delivers those — the one a fresh-directory restore replaced, whose epoch a
        // clock running behind (or a restore in the same millisecond) cannot outrank. A scope only
        // ever holds epochs a directory minted, so this directory learns past it: its epoch is
        // raised above the one held (monotonic, one statement), and the scope is delivered again.
        const held = answer.lifecycle.revision;
        const foreign =
          !answer.applied &&
          held !== undefined &&
          (held.epoch > lifecycle.revision.epoch ||
            (held.epoch === lifecycle.revision.epoch && lifecycleReceipt(answer.lifecycle) !== lifecycleReceipt(lifecycle)));
        // Bounded, because the deployment answering is the vertical's own code: only a directory
        // that has been restored can meet another history (epoch > 0), and a legitimate epoch is
        // a mint time, so one further ahead than the skew is forged or broken. Either way nothing
        // is raised; the refusal is an ops failure for an operator to look at.
        if (foreign && (lifecycle.revision.epoch === 0 || held!.epoch > Date.now() + LIFECYCLE_EPOCH_SKEW_MS)) {
          report.failed += 1;
          await this.admin
            .recordOpsFailure({
              actor,
              operation: 'scope.lifecycle',
              stage: 'foreign-epoch',
              tenantId,
              scopeId,
              message:
                `the deployment refused this directory's lifecycle while holding epoch ${held!.epoch} ` +
                `(this directory is at ${lifecycle.revision.epoch}); not raised past it — ` +
                (lifecycle.revision.epoch === 0
                  ? 'this directory has never been restored, so no other history should have written it'
                  : 'it is further ahead of the clock than any directory mints'),
            })
            .catch((e: unknown) => console.error('substrat: could not record a foreign lifecycle epoch (#1713)', e));
          continue;
        }
        if (foreign) {
          await this.cp.raiseLifecycleEpoch(held!.epoch + 1);
          const [again] = await this.cp.lifecycleTargets({ scopeId });
          const next = again ? this.lifecycleOfTarget(again) : null;
          if (again && next) {
            t = again;
            lifecycle = next;
            answer = await delegation.deliver({ tenantId, scopeId, lifecycle });
          }
        }
        // The receipt is what the scope HOLDS: a newer delivery it kept instead is the truth.
        await this.cp.recordLifecycleReceipt(
          scopeId,
          lifecycleReceipt(answer.lifecycle),
          new Date().toISOString(),
          answer.tenantRecorded === true,
        );
        report.delivered += 1;
      } catch (err) {
        report.failed += 1;
        try {
          await this.admin.recordOpsFailure({
            actor,
            operation: 'scope.lifecycle',
            stage: 'deliver',
            tenantId,
            scopeId,
            message:
              `the lifecycle (scope ${t.scope_status}, tenant ${t.tenant_status}) did not reach the ` +
              `deployment serving this scope; the heal sweep will deliver it again: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch (recordErr) {
          console.error('substrat: could not record a lifecycle delivery failure (#1713)', recordErr);
        }
      }
    }
    return report;
  }

  /** One directory row as the lifecycle a delivery carries (#1713), or null for a status this code does not know. */
  private lifecycleOfTarget(t: LifecycleTargetRow): ScopeLifecycle | null {
    const parsed = scopeLifecycle.safeParse({
      scope: t.scope_status,
      tenant: t.tenant_status,
      at: new Date().toISOString(),
      revision: { epoch: t.epoch, scope: t.scope_rev, tenant: t.tenant_rev },
    });
    return parsed.success ? parsed.data : null;
  }

  /**
   * The heal sweep (#1713): deliver the lifecycle to every hosted scope whose deployment's
   * acknowledged state differs from the directory, and again to every scope held now — which is
   * what puts a hold back on a store a carry or a restore landed without it. Bounded per pass
   * (`limit`), drifted scopes first. Run from the shared control plane's cron.
   */
  async healLifecycles(actor: PlatformActorId, opts?: { limit?: number }): Promise<LifecycleDeliveryReport> {
    return this.deliverLifecycles(actor, { drift: true, limit: opts?.limit ?? 200 });
  }

  /**
   * Whether a CP-less host holds this scope's work (#1713): `assertLive`'s predicate, answered
   * rather than thrown, for the entry points that defer instead of refusing — a sweep pass, a
   * schedule run, an executor drain. Always false on a host with a directory, whose entry
   * points ask the directory themselves.
   */
  async lifecycleHeld(scopeId: ScopeId): Promise<boolean> {
    return this.cpLess && lifecycleRefusal(await this.scopeStub(scopeId).lifecycle()) !== null;
  }

  /**
   * K-3's cross-check on its own: the (tenant, scope) pair must exist and agree before a
   * subject-key operation touches anything. Without it a caller could reach another
   * tenant's keys by naming their scope id.
   */
  private async assertScope(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    const rec = await this.cp.getScopeRecord(tenantId, scopeId);
    if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
  }

  /**
   * The same K-3 cross-check, for a read that then opens the scope's STORAGE — every
   * introspection verb below. It adds one refusal the bare existence check cannot make:
   * a REAPED scope keeps its directory row as a tombstone (§4.4) while its storage is
   * gone, so the row resolves and the read looks legal. Addressing the DO anyway
   * CONSTRUCTS an empty one, and the answer comes back as a scope with no tables, no
   * events and no denials rather than as a scope that no longer exists — the read
   * quietly contradicting the reap that was meant to be irreversible. `archived` still
   * reads: its bytes are there, which is the whole distinction between the two states.
   */
  private async scopeRecordForRead(tenantId: TenantId, scopeId: ScopeId): Promise<ScopeRow> {
    const row = await this.cp.getScopeRecord(tenantId, scopeId);
    if (!row) throw unknownScopeForTenant(tenantId, scopeId);
    if (row.status === 'reaped') {
      throw substratError('conflict', `scope ${scopeId} is reaped — its storage is gone and cannot be read`);
    }
    return row;
  }

  /**
   * This scope's per-subject keys (#37). The crypto lives in the kernel
   * (`createSubjectKeys`); the adapter supplies only the three row operations, which here
   * are RPCs into the control-plane DO that holds the directory.
   */
  private subjectKeysFor(tenantId: TenantId, scopeId: ScopeId): SubjectKeys {
    return createSubjectKeys(this.secretBox, {
      read: (subjectId) => this.cp.readSubjectKey(scopeId, subjectId),
      insert: (subjectId, row) =>
        this.cp.insertSubjectKey({ scopeId, subjectId, tenantId, ...row }),
      tombstone: (subjectId, at) =>
        this.cp.tombstoneSubjectKey({ scopeId, subjectId, tenantId, at }),
    });
  }

  /**
   * Record a staff read (K-24). `params` is a bounded summary, capped so one query
   * cannot write an unbounded row.
   */
  private async recordAccess(
    actor: PlatformActorId,
    method: string,
    target: { tenantId?: TenantId | null; scopeId?: ScopeId | null },
    params: unknown,
    resultCount: number,
  ): Promise<void> {
    await this.cp.recordAccess({
      id: ulid(),
      actor,
      method,
      tenantId: target.tenantId ?? null,
      scopeId: target.scopeId ?? null,
      params: params == null ? null : JSON.stringify(params).slice(0, 500),
      resultCount,
      at: new Date().toISOString(),
    });
  }

  private async recordAdmin(
    actor: PlatformActorId,
    action: AdminAction,
    target: { tenantId: TenantId | null; scopeId?: ScopeId | null; vertical?: string | null },
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.cp.recordAdmin(this.adminEntry(actor, action, target, before, after));
  }

  /**
   * One admin-log row, minted here where attribution and `causedBy` live — for `recordAdmin`,
   * and for a ControlPlaneDO method that writes its row in the same unit as its effect (#1184).
   */
  private adminEntry(
    actor: PlatformActorId,
    action: AdminAction,
    target: { tenantId: TenantId | null; scopeId?: ScopeId | null; vertical?: string | null },
    before: unknown,
    after: unknown,
  ): AdminEntry {
    return {
      id: ulid(),
      actor,
      action,
      tenantId: target.tenantId,
      causedBy: this.causedBy,
      onBehalfOf: this.onBehalfOf,
      scopeId: target.scopeId ?? null,
      vertical: target.vertical ?? null,
      before: before ?? null,
      after: after ?? null,
      at: new Date().toISOString(),
    };
  }

  /**
   * The scope's own answer to "what may this connection do here" (#726 gap 1).
   *
   * Read from the ScopeDO's delivered tuples rather than the directory's grant rows:
   * the two are different facts, and the one a caller wants when asking whether a
   * dispatch will be refused is what this deployment would actually enforce. The
   * directory's view stays on `HostAdmin.listConnectionGrants`.
   */
  async connectionGrantsInScope(
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ProjectedConnectionGrant[]> {
    await this.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const now = new Date().toISOString();
    // Both stores again, but the CF split is not the pure adapter's. The DO holds the
    // scope's own tuples plus whatever tenant-level ones were PROJECTED into it (the
    // CP-less shape); a scope with a live control plane has its tenant-level grants in
    // the directory instead, where the checker reads them from (`cp.tenantTuples`). Read
    // only the DO and a tenant-wide grant would be reported absent on exactly the
    // deployments that have a control plane — the fleet — while being enforced.
    const rows = [
      ...(await this.scopeStub(scopeId).listConnectionGrants(now)),
      ...(await this.cp.dumpTenantTuples(tenantId))
        .filter(
          (r) =>
            r.subject.startsWith('connection:') &&
            r.relation.startsWith('granted:') &&
            r.revoked_at === null &&
            (r.expires_at === null || r.expires_at > now),
        )
        .map((r) => ({ subject: r.subject, relation: r.relation, expires_at: r.expires_at })),
    ];
    // One tuple per (connection, permission) however many stores answered.
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        const key = `${r.subject}\u0000${r.relation}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.subject.localeCompare(b.subject) || a.relation.localeCompare(b.relation))
      .map((r) =>
      projectedConnectionGrant.parse({
        connectionId: r.subject.slice('connection:'.length),
        permission: r.relation.slice('granted:'.length),
        ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
      }),
    );
  }

  private async writeScopeTuple(
    scopeId: ScopeId,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void> {
    await this.scopeStub(scopeId).writeTuple(subject, relation, object, expiresAt);
  }

  /**
   * The connection's CURRENT public sealing key, minted on first ask (#687).
   *
   * Mint-on-read rather than mint-only-at-connect, because the fleet already holds
   * live connections older than this feature — a Scrive credential in the fleet
   * carries years of real contracts, and "reconnect to acquire a keypair" is not a
   * migration anyone should have to run against production. Asking IS the
   * back-fill, and it is idempotent: the DO's insert loses silently against the
   * partial-unique index and re-reads the winner, so a race yields one key.
   *
   * Minted HERE, on the coordinator, for the reason the credential is: the DO has
   * never held a `SecretBox` and must never see an unsealed private half.
   */
  private async ensureSealingKey(connectionId: ConnectionId): Promise<ProjectedConnectionKey> {
    const conn = await this.cp.readConnection(connectionId);
    if (!conn) throw new Error(`connection not found: ${connectionId}`);
    const rows = await this.cp.readConnectionKeys(connectionId);
    const current = rows.find((r) => r.retired_at === null);
    if (current) {
      return projectedConnectionKey.parse({
        connectionId,
        provider: conn.provider,
        keyId: current.key_id,
        publicKey: current.public_key,
      });
    }
    const pair = await generateSealingKeyPair(`connection:${connectionId}:${ulid()}`);
    const wrapped = await this.secretBox.seal(pair.privateKey);
    const won = await this.cp.insertConnectionKey({
      connectionId,
      keyId: pair.keyId,
      publicKey: pair.publicKey,
      wrappedKeyId: wrapped.keyId,
      wrappedPrivate: wrapped.ciphertext,
      createdAt: new Date().toISOString(),
    });
    return projectedConnectionKey.parse({
      connectionId,
      provider: conn.provider,
      keyId: won?.key_id ?? pair.keyId,
      publicKey: won?.public_key ?? pair.publicKey,
    });
  }

  /**
   * EVERY private half this connection holds, keyed by keyId — retired ones too.
   *
   * A ciphertext sealed before a rotation still names the key that sealed it, so
   * the opener has to hold the whole map or every request pending across a
   * rotation dead-letters. When rotation eventually DESTROYS a retired key its row
   * goes and the open fails loudly, which is the intended erasure (D-5), not an
   * accident.
   */
  private async openSealingKeys(connectionId: ConnectionId): Promise<Record<string, string>> {
    const rows = await this.cp.readConnectionKeys(connectionId);
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.key_id] = await this.secretBox.open({
        keyId: r.wrapped_key_id,
        ciphertext: r.wrapped_private,
      });
    }
    return out;
  }

  private scopeStub(scopeId: ScopeId): ScopeStubRpc {
    // Deterministic DO id in milestone 1. Production mints per-jurisdiction ids
    // via newUniqueId (K-7) and stores the mapping in the directory — deferred.
    return this.scopeNs.get(this.scopeNs.idFromName(scopeId)) as unknown as ScopeStubRpc;
  }

  // -- the rewind hold (#1819) ------------------------------------------------
  // A PITR rewind to a bookmark from before a schedule kill switch was pulled brings the
  // module's `system:` grants back live, and nothing in the rewound storage says otherwise.
  // The scope's OFF modules are read while the pre-rewind storage still holds them, and each
  // rewind CLAIMS them on `SWITCH_HOLDS_NAME`, which the rewind cannot reach. A module is held
  // while any claim on it exists, and `runDueSchedules` skips a held module.
  //
  // #2029: the same for a PEER switched off (`vertical:<slug>`): the rewind claims the scope's
  // off peers beside its off modules, each under its hold key (`holdKeyOf`), and the peer door
  // refuses a held peer as the system door refuses a held module. Everything below holds for
  // both kinds; "module" reads as "subject".
  //
  // A claim is released only by a switch move KNOWN to survive its rewind (`switchInScope`): a
  // move on the restored storage, after the rewind armed. A move during the settle, or one the
  // doomed instance applied, lands in storage the restart discards, so it releases nothing. A
  // definite refusal drops only that rewind's own claim, so a concurrent rewind keeps its own.
  // An OFF landing in that same discarded storage joins the claims that would discard it (#1839).

  private switchHoldsStub(): ScopeStubRpc {
    return this.scopeNs.get(this.scopeNs.idFromName(SWITCH_HOLDS_NAME)) as unknown as ScopeStubRpc;
  }

  /**
   * Is this module held off on this scope? Read from one snapshot of the whole hold, re-read
   * once it is older than `SWITCH_HOLD_SNAPSHOT_MS`. Called only AFTER the scope's own state
   * read, which is the order `SWITCH_HOLD_SETTLE_MS` relies on.
   *
   * A failed read fails OPEN except for what this pass already knows is held. Failing closed
   * would turn one object's outage into every schedule of the deployment stopping; failing open
   * reopens only the gap this closes, for a rewind that lands during the outage, and the next
   * reconcile still switches that module off. The error is answered, for the pass to report.
   */
  private async switchHeld(
    scopeId: ScopeId,
    holdKey: string,
  ): Promise<{ held: boolean; error?: string; scopeClear?: true }> {
    const at = Date.now();
    let error: string | undefined;
    if (!this.holdSnapshot || at - this.holdSnapshot.at > SWITCH_HOLD_SNAPSHOT_MS) {
      const inflight = this.holdRefresh;
      // Join a read that went out within the snapshot age of this consult: its result is then as
      // fresh as one this consult would take itself, which is what the settle argument needs.
      // Only the consult that sent the read reports its failure.
      if (inflight && at - inflight.at <= SWITCH_HOLD_SNAPSHOT_MS) {
        await inflight.done;
      } else {
        const refresh = { at, done: this.refreshHolds(at) };
        this.holdRefresh = refresh;
        try {
          ({ error } = await refresh.done);
        } finally {
          if (this.holdRefresh === refresh) this.holdRefresh = null;
        }
      }
    }
    const snapshot = this.holdSnapshot;
    const held = snapshot?.held.has(`${scopeId} ${holdKey}`) ?? false;
    // #2029: a good read naming no row for this scope at all, for `doorGate`'s instance cache.
    const scopeClear = !error && snapshot?.good === true && !snapshot.scopes.has(scopeId);
    return { held, ...(error ? { error } : {}), ...(scopeClear ? { scopeClear: true as const } : {}) };
  }

  /** One read of the whole hold into the snapshot, stamped with when it went out. Never throws. */
  private async refreshHolds(at: number): Promise<{ error?: string }> {
    try {
      const rows = await this.switchHoldsStub().switchHoldsAll();
      // A slow read that lands after a newer one never replaces it.
      if (!this.holdSnapshot || at >= this.holdSnapshot.at) {
        this.holdSnapshot = {
          at,
          held: new Set(rows.map((r) => `${r.scopeId} ${r.moduleId}`)),
          scopes: new Set(rows.map((r) => r.scopeId)),
          good: true,
        };
      }
      return {};
    } catch (err) {
      const known = this.holdSnapshot?.held;
      const why = err instanceof Error ? err.message : String(err);
      // Deliberately re-stamped, so a failing hold object is retried once per snapshot age rather
      // than hammered per scope. For that long, other scopes reuse this possibly pre-hold set
      // silently, and only the consult that sent this read reports the error: the declared
      // fail-open, attributed once.
      if (!this.holdSnapshot || at >= this.holdSnapshot.at) {
        const scopes = new Set([...(known ?? [])].map((k) => k.slice(0, k.indexOf(' '))));
        this.holdSnapshot = { at, held: known ?? new Set(), scopes, good: false };
      }
      return {
        error: known
          ? `switch hold unreadable (${why}); the ${known.size} hold(s) from this pass's last good read ` +
            `still applied, any newer ones did not`
          : `switch hold unreadable (${why}); no earlier read in this pass, so no hold applied`,
      };
    }
  }

  /**
   * Move one module's switch in this host's own scope DO, and release the claims the move is
   * known to survive. The claims are read BEFORE the move (S0). A claim in S0 that was already
   * `armed` had its rewind armed before the move started, and a Durable Object has one live
   * instance at a time. So the instance that applied the move is either the doomed one (its
   * write is discarded: keep the claim) or one started after it, on the restored storage (the
   * write persists: release). A claim still `pending` in S0 may belong to a rewind that has not
   * armed yet, which would discard this move too: keep it, unless it is older than
   * `SWITCH_HOLD_PENDING_MAX_MS`. A claim created after S0 is never touched.
   *
   * An ON releases every claim in S0, surviving or not. A claim exists to keep off a module the
   * operator had off, and ON is their newer word: the directory records it before the move. If
   * the ON itself is discarded by a rewind, the scope comes back as the bookmark had it, and a
   * claim would then keep the module off while the directory and the status read both say ON.
   * The same call tombstones the module on the hold object (`switchHoldOn`), after the move: a
   * rewind that read the switch before this ON cannot claim the module from that read afterwards
   * (#1839). The release still covers only S0: a row a stale read inserted between S0 and the
   * tombstone, into a claim that did not hold the module at S0, stays. That window is a few calls,
   * and it errs toward OFF, until the next surviving move of the switch.
   *
   * An OFF that changed the switch JOINS the claims it would not survive (#1839): each claim in S0
   * or S1 (below) that is still pending (inside the bound), or armed with this move's instance as
   * its doomed one. Those are exactly the rewinds whose restart discards this OFF, and each of them captured
   * the module ON. The row takes the claim's state (`switchHoldJoin`, which never recreates a claim
   * with no rows left) and is stamped on the hold object's clock, and
   * a pending claim's rewind then waits for it to be a full settle old (`rewindHolding`). The
   * candidates are read twice, in S0 and again after the move (S1), so a claim written while
   * this move was queued is joined too. Both reads are scope-wide; S1 is taken only by an OFF
   * that changed the switch.
   *
   * A failed claims read does not stop the move. It is thrown after it, and the caller treats
   * that as a failed move, with the claims kept, which errs toward OFF. A failed join is thrown
   * the same way.
   *
   * An OFF then an ON of one module, milliseconds apart, can interleave so the ON's release reads
   * its claims before the OFF's join lands. The joined row then holds the module the operator just
   * turned ON, until the next surviving move of that switch releases it (another ON does).
   */
  private async switchInScope(
    kind: SwitchKind,
    scopeId: ScopeId,
    key: string,
    to: 'on' | 'off',
    at: string,
    tenantHeld = false,
    /** #2045: the switch call's fence; see `SWITCH_FENCES_DDL`. */
    fence?: string,
  ): Promise<SwitchOutcome> {
    // #2029: a peer's claims live beside the modules', under its own hold key.
    const holdKey = holdKeyOf(kind, key);
    let scopeClaims: SwitchHoldClaim[] | undefined;
    let readError: unknown;
    try {
      scopeClaims = await this.switchHoldsStub().switchHoldClaims(scopeId);
    } catch (err) {
      readError = err;
    }
    const stub = this.scopeStub(scopeId);
    const { instance, ...outcome } = await (kind === 'system'
      ? stub.switchSystemSchedules(key, scopeId, to, at, tenantHeld, fence)
      : stub.switchPeer(key, scopeId, to, at, tenantHeld, fence));
    if (!scopeClaims) throw readError;
    // #2045: a move the fence refused wrote nothing, so it is known to survive nothing and to
    // release nothing; the newer call that superseded it did whatever the hold needed.
    if (outcome.superseded) return outcome;
    const now = Date.now();
    const pendingLive = (c: SwitchHoldClaim) => c.state === 'pending' && now - Date.parse(c.heldAt) <= SWITCH_HOLD_PENDING_MAX_MS;
    const before = scopeClaims.filter((c) => c.moduleId === holdKey);
    if (to === 'on') {
      // Every ON, claims or not: its tombstone is what keeps a rewind's stale read from claiming
      // the module after this (#1839).
      this.holdSnapshot = null;
      await this.switchHoldsStub().switchHoldOn(scopeId, holdKey, before.map((c) => c.claimId));
    } else if (outcome.held && before.length > 0) {
      const survived = before.filter((c) => !pendingLive(c) && c.doomed !== instance);
      if (survived.length > 0) {
        this.holdSnapshot = null;
        await this.switchHoldsStub().switchHoldRelease(scopeId, holdKey, survived.map((c) => c.claimId));
      }
    }
    if (to === 'off' && outcome.changed) {
      // S1, read after the move: a claim written while this move was queued behind the capture
      // is in S1 only. S0 still counts: a claim pending in S0 may have armed with another
      // instance by S1, and this move may have landed before that arm.
      const after = await this.switchHoldsStub().switchHoldClaims(scopeId);
      const joins = new Set(
        [...scopeClaims, ...after].filter((c) => pendingLive(c) || c.doomed === instance).map((c) => c.claimId),
      );
      if (joins.size > 0) {
        this.holdSnapshot = null;
        await this.switchHoldsStub().switchHoldJoin(scopeId, holdKey, [...joins]);
      }
    }
    return outcome;
  }

  /**
   * Rewind one scope, claiming what it has switched off, and what an earlier rewind still holds on
   * it. The OFF modules are read and claimed BEFORE the rewind, while this storage still holds
   * them, and the rewind then waits until every row of its claim is `SWITCH_HOLD_SETTLE_MS` old
   * (`settleClaim`). Its claim is `armed` once the rewind arms, naming the doomed
   * instance. Only a DEFINITE refusal drops the claim, and only this rewind's own. Any other throw
   * may come after the DO armed the bookmark, so the claim is armed on what a probe finds: the
   * serving instance if it armed, else none. A probe that fails leaves the claim pending, and
   * `SWITCH_HOLD_PENDING_MAX_MS` bounds that.
   *
   * With nothing to claim, the rewind neither claims nor settles. An OFF that lands between that
   * status read and the arm (a few calls) is then NOT held at all: the rewound scope runs that
   * module until the next reconcile re-asserts the switch, #1819's gap for those milliseconds.
   * Closing it would make every rewind claim and settle, 3 s on each, to cover a few calls.
   */
  private async rewindHolding(
    scopeId: ScopeId,
    rewind: () => Promise<{ rewindingTo: string; instance?: string }>,
  ): Promise<{ rewindingTo: string }> {
    const holds = this.switchHoldsStub();
    // What this rewind must keep off: what the storage has off, AND what an earlier rewind still
    // holds here. A module held by an earlier rewind is ON in this storage (that is why it is
    // held), so the storage alone would give this rewind no claim on it. Then a re-assert that
    // lands on the instance THIS rewind dooms would release the earlier claim, and this
    // rewind's restart would discard the re-assert's write.
    // The token first: an ON that moves after these reads tombstones its module past it (#1839).
    const token = await holds.switchHoldToken();
    const [offInStorage, held] = await Promise.all([this.offInStorage(scopeId), holds.switchHoldsAll()]);
    const off = [...new Set([...offInStorage, ...held.filter((h) => h.scopeId === scopeId).map((h) => h.moduleId)])];
    if (off.length === 0) return { rewindingTo: (await rewind()).rewindingTo };
    const claimId = ulid();
    await holds.switchHoldClaim(scopeId, off, claimId, token);
    this.holdSnapshot = null;
    try {
      await this.settleClaim(holds, scopeId, claimId);
    } catch (err) {
      // Nothing was asked to arm: this rewind never happens, and what it claimed stays in storage.
      await holds.switchHoldDrop(scopeId, claimId).catch(() => undefined);
      throw err;
    }
    let result: { rewindingTo: string; instance?: string };
    try {
      result = await rewind();
    } catch (err) {
      if (isRewindRefusal(err)) {
        await holds.switchHoldDrop(scopeId, claimId).catch(() => undefined);
      } else {
        const probe = await this.scopeStub(scopeId)
          .rewindProbe()
          .catch(() => undefined);
        if (probe) await holds.switchHoldArm(scopeId, claimId, probe.armed ? probe.instance : null).catch(() => undefined);
      }
      throw err;
    }
    await holds.switchHoldArm(scopeId, claimId, result.instance ?? null).catch(() => undefined);
    return { rewindingTo: result.rewindingTo };
  }

  /**
   * The subjects this scope's own storage has switched off, as a rewind reads them before it arms:
   * its modules, and (#2029) its peers, each by its hold key (`holdKeyOf`).
   */
  private async offInStorage(scopeId: ScopeId): Promise<string[]> {
    const [modules, peers] = await Promise.all([this.systemGrantsStatusLocal(scopeId), this.peerGrantsStatusLocal(scopeId)]);
    return [
      ...modules.filter((e) => e.schedules === 'off').map((e) => holdKeyOf('system', e.moduleId)),
      ...peers.filter((e) => e.calls === 'off').map((e) => holdKeyOf('peer', e.vertical)),
    ];
  }

  /**
   * #1839: wait until every row of this rewind's claim is `SWITCH_HOLD_SETTLE_MS` old. The settle
   * argument holds per row: a row younger than that when the rewound storage exists can be missed
   * by a pass whose hold snapshot was read just before it. So after the settle, each round reads
   * the scope's OFF modules again and claims them (an OFF that landed after the capture, in storage
   * this rewind discards), then asks the hold object how old the claim's youngest row is, joined
   * rows (`switchInScope`) included. The age is measured on the hold object's clock, the same one
   * that stamped the row; this host only sleeps the difference. Each status read is preceded by a
   * token read, so a module an operator turned ON after that read is not claimed from it
   * (`switchHoldClaim`).
   *
   * Bounded at `SWITCH_HOLD_EXTRA_WAITS` more waits: past that, the rewind is REFUSED, with the
   * refusal prefix. Nothing was asked to arm, so `rewindHolding` drops only this claim, and every
   * OFF pulled meanwhile stays in the scope's own storage. The owner retries, and the retry's
   * capture reads them all. Arming instead would leave a row younger than the settle, whose module
   * a pass with a snapshot read shortly before that row could run once on the rewound storage.
   *
   * What remains: an OFF whose join lands after the last age read and before the arm (a few calls),
   * or on the doomed instance in the moment between the arm and its restart. It is claimed, but by
   * a row younger than the settle: that module can run once, in a pass whose hold snapshot was read
   * in the `SWITCH_HOLD_SNAPSHOT_MS` before the row, until that snapshot expires. If the claim has
   * no rows by then, the OFF has nothing to join (`switchHoldJoin`), and in that same moment it is
   * not held at all. That happens when an ON emptied the claim, and also when a tombstone refused
   * every module the capture read, so the capture wrote no rows. An OFF before the last re-read is
   * claimed by the re-read.
   */
  private async settleClaim(holds: ScopeStubRpc, scopeId: ScopeId, claimId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, SWITCH_HOLD_SETTLE_MS));
    for (let waits = 0; ; waits++) {
      const token = await holds.switchHoldToken();
      const off = await this.offInStorage(scopeId);
      if (off.length > 0) {
        await holds.switchHoldClaim(scopeId, off, claimId, token);
        this.holdSnapshot = null;
      }
      const youngest = await holds.switchHoldYoungestMs(scopeId, claimId);
      if (youngest === null || youngest >= SWITCH_HOLD_SETTLE_MS) return;
      if (waits === SWITCH_HOLD_EXTRA_WAITS) {
        throw new Error(
          `${REWIND_REFUSED}schedule switches kept being pulled off while this rewind waited for them to ` +
            `settle (${waits} extra waits); nothing was rewound, and those switches stay off. Retry the rewind`,
        );
      }
      // Never longer than one settle, even if the hold object's clock moved back under a restart.
      await new Promise((resolve) => setTimeout(resolve, SWITCH_HOLD_SETTLE_MS - Math.max(0, youngest)));
    }
  }

  // -- live reads (#938): the door ------------------------------------------
  // The coordinator's half of the live-read path. It decides two things and no more:
  // whether this CONNECTION can carry a push at all, and who is asking. What a
  // subscriber may then be told is decided in the scope DO, per event, per frame.

  /**
   * Subscribe a principal to this scope's changes — `ScopeHost.liveReads`.
   *
   * Present on this host and declared `never` on `SqliteScopeHost`: a live read needs
   * something that outlives a request and can be woken when an event lands, and on
   * Cloudflare that is the scope's own Durable Object. The seam's full reasoning is on
   * the contract (`ScopeHost.liveReads`), beside the `clock?: never` precedent it
   * mirrors.
   *
   * **Two kinds of refusal, and they are deliberately different shapes.** A request
   * that cannot carry a socket is answered with a `Response` (426, 501) — that is a
   * fact about the connection, addressed to the client. A scope that must not be
   * reached at all THROWS, exactly as `getScope` and the attachment door do, because
   * it is the same refusal an ordinary read of that scope would get and it should not
   * arrive as a different class of answer just because the caller asked for a socket.
   */
  readonly liveReads: LiveReadSurface<Request, Response> = {
    subscribe: async ({ tenantId, scopeId, principal, request, within, expiresAt }) => {
      // Decided before anything else, and thrown: a `within` that is neither a plain
      // EntityRef nor a value `vouchedWithin` built is a caller bug, and the two ways of
      // guessing at it both open a feed wider than was asked for (#1853).
      const narrowed = liveWithinOf(within);
      // The same for an expiry that is not an instant: read as "none", it would keep the
      // socket open past the session it was meant to end with (#938).
      const expires = expiresAt === undefined ? undefined : liveInstant(expiresAt);
      if (expiresAt !== undefined && !expires) {
        throw substratError('validation_failed', 'live reads: `expiresAt` must be an ISO 8601 instant');
      }
      if (!isUpgradeRequest(request)) {
        return new Response('live reads are a WebSocket surface', {
          status: 426,
          headers: { [LIVE_MODE_HEADER]: 'not-an-upgrade' satisfies LiveRefusal },
        });
      }
      /**
       * The orange-to-orange refusal (#938).
       *
       * Cloudflare does not carry WebSockets across an O2O hop — the customer's own
       * proxied zone in front of ours — so an upgrade offered here would fail
       * somewhere the vertical cannot see, and the client would be left holding a
       * socket that never delivers. Refused at the door instead, with a reason the
       * client can read, so the fallback to polling is a thing it KNOWS it is doing
       * rather than a silence it has to infer.
       *
       * Per request, never per hostname: whether a tenant is O2O is decided by the
       * tenant's own DNS, which is theirs to change without telling us. Anything
       * cached would be a fact with an invisible expiry date; this header is correct
       * on the request after they change it.
       *
       * 501, not 426: 426 means "upgrade and try again", and trying again is exactly
       * what will not work. This connection cannot carry the thing that was asked for.
       */
      if (isOrangeToOrange(request)) {
        return new Response(
          'live reads are not available over this connection — the request arrived ' +
            'through a proxied customer zone, which does not carry WebSockets. Poll instead.',
          { status: 501, headers: { [LIVE_MODE_HEADER]: 'poll' satisfies LiveRefusal } },
        );
      }
      /**
       * The same fail-closed lifecycle gate + lazy migration every other door takes
       * (`getScope`, `attachments`; control-plane.md §4.1/§4.2, K-3).
       *
       * A subscription is a new way INTO a scope, and the permission filter downstream
       * answers a different question: it decides what a subscriber may see, not whether
       * this scope should be reachable at all. Without this, an unknown, cross-tenant,
       * suspended or archiving scope could still be addressed and handed a 101 — a
       * scope that refuses every ordinary read while quietly holding an open socket.
       *
       * On a CP-less vertical, `validateScopeAccess` is a no-op on the null control
       * plane, and `assertLive` reads the lifecycle the platform delivered to the
       * scope's own storage instead (#1713).
       *
       * `migrateAndRecord`, not the DO's own `ensureMigrations`: the DO migrates
       * itself when the socket opens either way, but only this reports the applied
       * count to the directory — so a scope whose first contact after a deploy is a
       * subscription does not go dark in the migration fleet view.
       */
      await this.assertLive(tenantId, scopeId);
      await this.migrateAndRecord(scopeId);
      // Asserted, not carried through from the client: the principal is the
      // vertical's own resolution of its session, and the tenant and scope are the
      // node the router resolved. Every inbound copy is replaced, for the reason the
      // router strips `x-substrat-*` before setting its own.
      const headers = new Headers(request.headers);
      headers.set(LIVE_PRINCIPAL_HEADER, principal);
      headers.set(LIVE_TENANT_HEADER, tenantId);
      headers.set(LIVE_SCOPE_HEADER, scopeId);
      if (narrowed) headers.set(LIVE_WITHIN_HEADER, encodeLiveWithin(narrowed));
      else headers.delete(LIVE_WITHIN_HEADER);
      if (expires) headers.set(LIVE_EXPIRES_HEADER, expires);
      else headers.delete(LIVE_EXPIRES_HEADER);
      const forwarded = new Request(
        new URL(LIVE_SUBSCRIBE_PATH, 'https://scope.substrat.internal'),
        // `new Request(url, { …, headers })` rather than `new Request(request, …)`:
        // the DO is addressed by its own path, not the client's, and the upgrade
        // headers that matter travel in `headers` above. Verified in workerd — a
        // reconstructed request keeps `Upgrade`, `Connection` and the
        // `Sec-WebSocket-*` pair, which is what makes the router's own
        // strip-and-assert safe on this path too.
        { method: 'GET', headers },
      );
      // Through `scopeStub`, deliberately, rather than a second `idFromName` here:
      // that method's own comment says the id derivation is milestone-one and that
      // production will mint per-jurisdiction ids from the directory. A copy of the
      // derivation would keep compiling on the day it changes and address a DIFFERENT
      // object — a subscriber watching an empty scope while its writes land elsewhere.
      // `ScopeStubRpc` describes the RPC methods and not `fetch`, which every stub has;
      // the cast widens the view of one object, it does not mint a second one.
      const stub = this.scopeStub(scopeId) as unknown as {
        fetch(request: Request): Promise<Response>;
      };
      return stub.fetch(forwarded);
    },
  };

  // -- scope-local projection (docs/architecture/scope-local-permissions.md, Phase 2) --
  // The write side of the local reader (Phase 1): after any tenant-level change,
  // the coordinator PROJECTS the tenant's current roles + tenant-level tuples into
  // its scopes, which then evaluate permissions from their own storage. Cost moves
  // from the request hot path (every check) to the admin write path (rare).

  /** The tenant's current roles + tenant-level tuples + entitlements + identity links, in the
   *  shape the ScopeDO stores. Entitlements (#304) ride the same projection so a hosted scope
   *  reads plan/quota/expiry locally; expiry is applied at READ (in the scope), so the full list
   *  is carried. Identity links (#406) ride it too, so a scope resolves logins locally. */
  private async tenantProjection(
    tenantId: TenantId,
  ): Promise<{
    roles: { role_key: string; permissions: string; source: string }[];
    tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[];
    entitlements: { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[];
    identities: { provider: string; external_id: string; principal_id: string; scope_id: string | null }[];
  }> {
    const [roleRows, tuples, entitlementRows, identities] = await Promise.all([
      this.cp.listRoles({ tenantId }),
      this.cp.dumpTenantTuples(tenantId),
      this.cp.listEntitlements(tenantId),
      this.cp.dumpTenantIdentities(tenantId),
    ]);
    return {
      roles: roleRows.map((r) => ({ role_key: r.role_key, permissions: r.permissions, source: r.source })),
      tuples,
      entitlements: entitlementRows.map((e) => ({
        entitlement_key: e.entitlement_key,
        expires_at: e.expires_at,
        quota: e.quota,
        plan: e.plan,
      })),
      identities,
    };
  }

  /**
   * The public sealing keys a scope of THIS vertical may seal to (#687), in the shape
   * the ScopeDO stores.
   *
   * Per (tenant, vertical) rather than per tenant, unlike everything else in the
   * projection: a connection is keyed (tenant, vertical, provider) because a vertical
   * is a blast-radius boundary (D-30), so projecting another vertical's key would hand
   * this scope a write channel into a credential it may not reach. `[]` for a scope
   * bound to no vertical — which then seals to nothing, the fail-closed direction.
   */
  private async connectionKeyRows(
    tenantId: TenantId,
    vertical: string | null | undefined,
  ): Promise<{ connection_id: string; provider: string; key_id: string; public_key: string }[]> {
    if (!vertical) return [];
    const keys = await this.admin.connectionSealingKeys(tenantId, vertical);
    return keys.map((k) => ({
      connection_id: k.connectionId,
      provider: k.provider,
      key_id: k.keyId,
      public_key: k.publicKey,
    }));
  }

  /** Project the tenant's current state into ONE scope + flip it to local. */
  private async projectScope(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    if (!this.scopeLocalPermissions) return;
    // The directory decides which tenant this scope belongs to (#1738): the scope's first
    // projection pins its `provisioned_for` receipt, so a tenant taken from a request rather
    // than from the record must not reach `applyProjection` — it would pin the wrong one for
    // good. Read first, so a pair the directory does not hold writes nothing.
    const scope = await this.cp.getScopeRecord(tenantId, scopeId);
    if (!scope) throw unknownScopeForTenant(tenantId, scopeId);
    const { roles, tuples, entitlements, identities } = await this.tenantProjection(tenantId);
    const connectionKeys = await this.connectionKeyRows(tenantId, scope.vertical);
    unwrapReply(await this.scopeStub(scopeId).applyProjectionReply(
      tenantId,
      roles,
      tuples,
      entitlements,
      undefined,
      identities,
      connectionKeys,
    ));
  }

  /**
   * Fan the tenant's current state out into ALL its scopes — called after any
   * tenant-level write so every projected scope converges. A dropped fan-out is
   * repaired by `reconcileTenantProjection` (the reconciliation sweep, §5/§9).
   */
  private async fanOut(tenantId: TenantId): Promise<void> {
    if (!this.scopeLocalPermissions) return;
    const { roles, tuples, entitlements, identities } = await this.tenantProjection(tenantId);
    // Only scopes that can still EVALUATE a permission. Unfiltered, this projected
    // into `archived` and `reaped` rows too — and a reaped scope's storage was
    // deliberately `deleteAll()`d ("the bytes are gone, so there is no restore",
    // tenancy.ts), so writing a projection into its DO recreated storage for a scope
    // the platform believes dead. Silent, unbounded in the number of apps a tenant
    // has ever archived, and paid for on every membership change.
    //
    // `provisioning` is included: a scope mid-provision pulls the projection itself
    // at creation, and including it costs one idempotent write while excluding it
    // could race that pull. `suspended` is included because suspension is reversible
    // and a suspended scope must not come back with a stale projection.
    // Only scopes that can still EVALUATE a permission. Unfiltered, this projected
    // into `archived` and `reaped` rows too — and a reaped scope's storage was
    // deliberately `deleteAll()`d ("the bytes are gone, so there is no restore",
    // tenancy.ts), so writing a projection into its DO recreated storage for a scope
    // the platform believes dead. Silent, unbounded in the number of apps a tenant
    // has ever archived, and paid for on every membership change.
    //
    // `provisioning` is included: a scope mid-provision pulls the projection itself
    // at creation, and including it costs one idempotent write while excluding it
    // could race that pull. `suspended` is included because suspension is reversible
    // and a suspended scope must not come back with a stale projection.
    const scopes = await this.cp.listScopes({
      tenantId,
      status: ['provisioning', 'active', 'suspended'],
    });
    // #687: connection keys are per (tenant, vertical), so they are resolved per scope
    // rather than once for the tenant — memoized, because a fan-out over twenty scopes
    // of one vertical must not mint or re-read twenty times.
    const keysByVertical = new Map<
      string,
      Promise<{ connection_id: string; provider: string; key_id: string; public_key: string }[]>
    >();
    // allSettled, not all (#1738): a scope that refuses (its `provisioned_for` receipt names
    // another tenant) must not stop its siblings converging, or one bad scope would freeze every
    // revoke for the tenant's healthy ones. The failure is still loud, after the rest have landed.
    const settled = await Promise.allSettled(
      scopes.map(async (s) => {
        const vertical = s.vertical ?? '';
        if (!keysByVertical.has(vertical)) {
          keysByVertical.set(vertical, this.connectionKeyRows(tenantId, s.vertical));
        }
        unwrapReply(await this.scopeStub(s.scope_id as ScopeId).applyProjectionReply(
          tenantId,
          roles,
          tuples,
          entitlements,
          undefined,
          identities,
          await keysByVertical.get(vertical),
        ));
      }),
    );
    const failed = settled.flatMap((r, i) => (r.status === 'rejected' ? [{ scope: scopes[i]!.scope_id, reason: r.reason as unknown }] : []));
    if (failed.length === 0) return;
    // One aggregated error, so the caller learns which scopes did not converge and that the
    // rest did.
    const named = failed.map((f) => `${f.scope}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`).join('; ');
    throw substratError(
      'conflict',
      `projection reached ${scopes.length - failed.length} of ${scopes.length} scopes of tenant ${tenantId}; not converged — ${named}`,
    );
  }

  /**
   * Re-project a tenant's full state into every one of its scopes — the
   * reconciliation sweep + the back-fill for scopes provisioned before the flag was
   * on (scope-local-permissions.md §8/§9). Idempotent: a full replace that converges
   * whatever the prior projection was. Safe to run on a schedule or on demand.
   */
  async reconcileTenantProjection(tenantId: TenantId): Promise<void> {
    await this.fanOut(tenantId);
  }

  /**
   * Provision a scope WITHOUT a control plane (scope-local-permissions.md Phase 3) —
   * the entry a CP-less vertical's `/internal/provision` calls. The shared control
   * plane already owns this scope's directory row + entitlements (the dashboard wrote
   * them before calling the vertical); here the vertical sets up only the scope's OWN
   * state: migrate its modules, project the vertical's role definitions locally, project
   * the tenant's entitlements so the scope can read plan/quota/expiry at request time
   * (#304), grant the owner a role at scope level, and make the scope evaluate permissions
   * from its own storage. No tenant-level tuples, no control plane.
   */
  async provisionScopeLocal(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    owner: PrincipalId;
    /** The vertical's role definitions (projected so the local checker can expand them). */
    roles: RoleDefinition[];
    /** Which role the owner is assigned, at SCOPE level. */
    ownerRoleKey: string;
    /** The tenant's entitlements, passed by the platform at provision (#304) — projected so
     *  the scope's per-operation gate + `ctx.entitlement` read them locally. Absent ⇒ none
     *  projected (the gate then fails closed for any gated operation until a projection lands). */
    entitlements?: EntitlementGrant[];
    /** The tenant's identity links, passed by the platform at provision (#406) — projected so
     *  the vertical's auth adapter resolves `(provider, externalId) → principal` from the
     *  scope's own storage (`resolveIdentityLocal`). Absent ⇒ untouched, so a provision path
     *  predating #406 never wipes links a fan-out or reconcile already delivered. */
    identityLinks?: ProjectedIdentityLink[];
    /** The tenant's connection grants for THIS scope (#592), gathered by the platform from
     *  the directory (tenant-wide rows materialized per scope) and written as the
     *  `connection:<id>` tuples `connectorInvokeLocal`'s permission check reads — the same
     *  tuple `connectorGrantLocal` writes at grant time, now also delivered at
     *  provision/reconcile so a scope provisioned AFTER `grantToConnection` holds it too.
     *  Additive like the owner grant; a revoked connection's grants simply stop being
     *  delivered, and every delegated call re-passes the platform's live-connection gate
     *  first, so a stale tuple cannot act. */
    connectionGrants?: ProjectedConnectionGrant[];
    /** Live connections' PUBLIC sealing keys for this tenant's vertical (#687), gathered by
     *  the platform and projected so module code can `ctx.sealToConnection` — the channel a
     *  CP-less vertical uses to hand a connector a value the spine must not hold in the
     *  clear. Only ever public halves. Absent ⇒ untouched, so a provision path predating
     *  #687 never wipes keys a reconcile already delivered. */
    connectionKeys?: ProjectedConnectionKey[];
    /** The modules the directory records switched OFF on this scope (#1742), gathered by the
     *  platform from its record. Switched off again right after the seat, in the same DO unit,
     *  so a wiped scope's re-seated `system:` grants never run — not even once, before the
     *  platform's own re-assert arrives. Applies to THIS scope only, and only turns off. Absent
     *  ⇒ nothing is switched here, and the platform's re-assert after the call does it. */
    switchedOff?: readonly ModuleId[];
    /** #1823: of `switchedOff`, the modules held on this scope only by a tenant-level grant,
     *  which this deployment has no directory to read. Held for the in-unit OFF all the same. */
    tenantHeld?: readonly ModuleId[];
    /** #2029: the peers the directory records OFF here, and those held only by a tenant grant. */
    switchedOffPeers?: readonly string[];
    tenantHeldPeers?: readonly string[];
    /** #2045: each recorded-off subject's fence, by tuple subject. */
    switchFences?: Readonly<Record<string, string>>;
    /** #2071: the declared entity-grant shapes, as the platform's reconcile sends them from the
     *  reached version's reviewed registry. Only a shape declared `bootstrap: true` is reconciled;
     *  a sharing one is skipped. Each holder is topped up to the shape as it is now, after the
     *  seat, in bounded passes. Never a revoked key, never a removal. Absent ⇒ no reconcile. */
    entityGrants?: readonly EntityGrantShape[];
  }): Promise<{ switchedOff?: SwitchedOff[] }> {
    const carry = recordedOffFromWire(input);
    const services = await this.servicePrincipals?.(input.tenantId, input.scopeId);
    const stub = this.scopeStub(input.scopeId);
    await this.migrateAndRecord(input.scopeId); // create the module tables (setMigrationState no-ops on a null CP)
    const switchedOff = unwrapReply(await stub.applyProjectionReply(
      input.tenantId,
      input.roles.map((r) => ({ role_key: r.key, permissions: JSON.stringify(r.permissions), source: r.source })),
      [], // no tenant-level tuples — a CP-less vertical grants at scope level only
      // Only PROJECT (and thereby switch on strict enforcement) when the platform actually
      // supplies entitlements. Omitting them leaves the scope un-projected and trusting-
      // upstream, so a vertical whose provision path predates #304 is never denied — it
      // opts into enforcement the first time a projection carries entitlements (fanOut /
      // reconcile / a re-provision that passes them).
      input.entitlements
        ? input.entitlements.map((e) => ({
            entitlement_key: e.entitlementKey,
            expires_at: e.expiresAt,
            quota: e.quota,
            plan: e.plan,
          }))
        : undefined,
      // #332: the owner's scope-level role grant rides the SAME projection unit as the
      // enforcement flip, rather than a separate `writeTuple` after it. A drop between the two
      // used to leave the scope "roles projected, source=local, zero tuples" — enforcing nothing
      // but denials, with no builder-facing lever to fix it. Atomic now: grant and flip land
      // together, and the empty-tuple guard in `applyProjection` refuses the flip if they don't.
      //
      // #1659: every tuple here is SEATED — created if missing, left alone if revoked — so a
      // reconcile no longer undoes an operator's revoke. The owner's seat alone carries
      // `lockout_reseat`: it comes back over a revoke only when the scope would otherwise hold
      // no effective role grant — none whose role the vertical still defines — which is the
      // #332 lockout a reconcile exists to repair.
      [
        {
          subject: `principal:${input.owner}`,
          relation: `role:${input.ownerRoleKey}`,
          object: `scope:${input.scopeId}`,
          expires_at: null,
          lockout_reseat: true,
        },
        // #461: each registered module's SCHEDULE grants (#383) ride the same unit —
        // the CP-less mirror of `provisionScope`'s seatTuple loop. Without them the
        // grant-is-the-switch check makes every schedule a silent no-op (`fired: 0`,
        // no error — the #49 unfalsifiable zero).
        ...[...this.moduleSchedules].flatMap(([modId, schedules]) => {
          const perms = new Set<string>();
          for (const s of schedules) for (const p of s.permissions) perms.add(p);
          return [...perms].map((perm) => ({
            subject: `system:${modId}`,
            relation: `granted:${perm}`,
            object: `scope:${input.scopeId}`,
            expires_at: null,
          }));
        }),
        // #1706: each declared PEER's grants ride the same unit — the CP-less mirror of
        // `provisionScope`'s peer seat, through the one function that decides it.
        ...peerSeats(collectPeers(this.peerSources), input.scopeId).map((seat) => ({
          subject: seat.subject,
          relation: seat.relation,
          object: seat.object,
          expires_at: null,
        })),
        // #592: the tenant's connection grants ride the same unit — the provision-time
        // mirror of `connectorGrantLocal`, so the connector return path works on every
        // install, not only the one that existed when `grantToConnection` ran.
        ...(input.connectionGrants ?? []).map((g) => ({
          subject: `connection:${g.connectionId}`,
          relation: `granted:${g.permission}`,
          object: `scope:${input.scopeId}`,
          expires_at: g.expiresAt ?? null,
        })),
      ],
      // #406: identity links, delivered by the platform with provisioning exactly as
      // entitlements are (#310). Preserve-on-undefined, so an absent field never wipes
      // links a prior fan-out or reconcile projected.
      input.identityLinks
        ? input.identityLinks.map((l) => ({
            provider: l.provider,
            external_id: l.externalId,
            principal_id: l.principal,
            scope_id: l.scopeId ?? null,
          }))
        : undefined,
      // #687: the tenant's connection sealing keys, delivered with provisioning exactly as
      // entitlements and identity links are. Preserve-on-undefined for the same reason: an
      // absent field must never wipe keys a prior reconcile projected, or a working
      // signature flow would break on an unrelated re-provision.
      input.connectionKeys
        ? input.connectionKeys.map((k) => ({
            connection_id: k.connectionId,
            provider: k.provider,
            key_id: k.keyId,
            public_key: k.publicKey,
          }))
        : undefined,
      // #1742: the recorded-off modules and (#2029) peers, switched off after the seat in the
      // same unit, on the scope this call provisions — the one the seat's tuples name.
      carry ? { scopeId: input.scopeId, at: new Date().toISOString(), ...carry } : undefined,
      services?.map((id) => `principal:${id}`),
    ));
    if (input.entityGrants) await this.topUpEntityGrantShapesLocal(input.tenantId, input.scopeId, input.entityGrants);
    return carry ? { switchedOff } : {};
  }

  /**
   * Resolve an external identity from a scope's PROJECTED links (#406) — the CP-less
   * auth adapter's read path, the local equivalent of `HostAdmin.resolveIdentity` (same
   * exemption: a machine read on the request path, not audited). Reads only what the
   * platform projected into the scope (provision / reconcile / fan-out), so a miss means
   * "unknown login — deny": an un-projected scope can only refuse a legitimate login,
   * never admit a revoked one. A CP-full deployment keeps using `admin.resolveIdentity`;
   * this exists precisely for deployments where that surface is unavailable.
   */
  async resolveIdentityLocal(
    tenantId: TenantId,
    scopeId: ScopeId,
    provider: string,
    externalId: string,
  ): Promise<ResolvedIdentity | undefined> {
    const row = await this.scopeStub(scopeId).resolveProjectedIdentity(tenantId, provider, externalId);
    if (!row) return undefined;
    return resolvedIdentity.parse({ principal: row.principal, scopeId: row.scopeId });
  }

  /**
   * Grant a principal a role at SCOPE level in a CP-less vertical — the MEMBER half of
   * `provisionScopeLocal`'s owner grant. An invite-accept flow calls this so a newly-invited
   * teammate's principal resolves the invited role's permissions from the scope's own
   * storage. Idempotent (writeTuple is INSERT OR REPLACE). `roleKey` must be one the scope
   * already projected (via `provisionScopeLocal`), or the local checker expands it to nothing.
   */
  async assignScopeRole(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<void> {
    await this.scopeStub(scopeId).writeTuple(`principal:${principal}`, `role:${roleKey}`, `scope:${scopeId}`, null);
  }

  /**
   * Take a scope-level role back — the counterpart `assignScopeRole` went without (#1161).
   * A tombstone, exactly as `HostAdmin.unassignRole` writes for a scope-level assignment:
   * the row stays with `revoked_at` set and the local checker's walk skips it, so the
   * principal loses the role's permissions on the next check. `assignScopeRole` is
   * `INSERT OR REPLACE`, so a later re-assign clears the tombstone and grants again.
   *
   * Returns whether anything changed: a repeat revoke, or a revoke of a role that was never
   * assigned, is a silent `false` rather than an error, which lets a harness route stay
   * idempotent. Emits nothing on the scope outbox — the vertical whose flow revoked the
   * seat is the one that knows what to announce, and it emits from its own operation.
   * Guarded like `assignScopeRole`: at the harness route, not at this seam.
   *
   * What survives a reconcile (#1659), because the tombstone is only as durable as the next
   * write that is allowed to replace it:
   * - Provisioning does not clear it. `provisionScopeLocal` SEATS its tuples (the owner's
   *   role, the `system:` grants, the connection grants): it recreates a missing one and
   *   leaves a revoked one revoked, so a reconcile — every listed promote runs one — keeps
   *   your revoke.
   * - With ONE exception: the owner-of-record's seat is re-seated over a revoke when the
   *   scope would otherwise hold no effective role grant at all — a holder of a role the
   *   vertical no longer defines passes no check, so it does not count. A scope nobody can
   *   act in is the #332 lockout the reconcile exists to repair, so revoking the LAST holder
   *   is undone at the next reconcile. Seat the successor (in a role the vertical defines)
   *   before unseating the owner, and the revoke stands. The owner re-seated is the one the
   *   vertical's owner of record names. A hand-over by hand leaves that record on the ORIGINAL
   *   owner, who comes back if the successor is later revoked too; the platform's owner
   *   hand-over (`/internal/owner-transfer`, #1665) moves the record, and then the successor
   *   is the one re-seated. To lock a compromised owner out, suspend the scope; a seat revoke
   *   is not that lever.
   * - An explicit grant does clear it: `assignScopeRole` is `INSERT OR REPLACE`, and so is
   *   a vertical's `onProvision` hook that re-issues it — which re-seats whatever it names
   *   on every reconcile. Revoke the seats your own flow granted and does not re-grant.
   * On a CP-less host this records no admin-log row (there is no control plane to hold
   * one), so the row's `revoked_at` is the only evidence, and a re-assign replaces it.
   */
  /**
   * Does `principal` hold a role this scope can expand (#1665) — scope-level or projected from
   * the tenant, for a role the vertical still defines? What an owner hand-over asks of its
   * successor before anything moves: a member whose role was taken back is not one to hand to.
   */
  async hasScopeRoleLocal(tenantId: TenantId, scopeId: ScopeId, principal: PrincipalId): Promise<boolean> {
    return this.scopeStub(scopeId).hasEffectiveRoleGrantFor(tenantId, `principal:${principal}`);
  }

  async revokeScopeRole(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<boolean> {
    return this.scopeStub(scopeId).revokeTuple(
      `principal:${principal}`,
      `role:${roleKey}`,
      `scope:${scopeId}`,
      new Date().toISOString(),
    );
  }

  /**
   * Grant a principal an ENTITY-NARROWED permission in a CP-less vertical — the self-service
   * half of membership, the local equivalent of `HostAdmin.grant` with an `entity`. Where a
   * role reaches every entity in the scope, this reaches exactly one: an employee logging time
   * against their OWN record, a portal customer reading their OWN order. Writes the very tuple
   * the local checker's entity walk reads — `(principal:<id>, granted:<perm>, <type>:<id>)` —
   * so a grant issued here resolves identically to one the control plane fanned out. Idempotent
   * (writeTuple is INSERT OR REPLACE), so it is safe to re-issue on every link.
   */
  async grantEntityLocal(
    scopeId: ScopeId,
    principal: PrincipalId,
    permission: PermissionKey,
    entity: EntityRef,
  ): Promise<void> {
    await this.scopeStub(scopeId).writeTuple(
      `principal:${principal}`,
      `granted:${permission}`,
      entityObjectRef(entity, 'grantEntityLocal'), // #1856
      null,
    );
  }

  /**
   * Give a person a declared entity-grant SHAPE on one entity in a CP-less vertical (#2071) —
   * `grantEntityLocal` for every key of the shape, plus the marker that makes them a holder of
   * it, in one unit. What a vertical calls where it used to loop `grantEntityLocal` over its
   * `ENTITY_GRANTS` keys: a key the shape gains later then reaches this person at the next
   * provision or reconcile (`provisionScopeLocal`'s `entityGrants`). Idempotent, and explicit
   * like `grantEntityLocal`: it brings back a key or a marker a revoke tombstoned.
   */
  async grantEntityShapeLocal(
    scopeId: ScopeId,
    principal: PrincipalId,
    entity: EntityRef,
    permissions: readonly PermissionKey[],
  ): Promise<void> {
    await this.scopeStub(scopeId).grantEntityShape(principal, entity, permissions);
  }

  /**
   * Top every holder of each declared shape up to the shape as it is now (#2071), in bounded
   * passes — at most `batch` rows of work per scope transaction (default 500, at most 5000;
   * anything else is `validation_failed`), repeated until a pass finishes. Never re-grants a revoked
   * key, never removes one. Returns how many (person, entity) it topped up.
   */
  async topUpEntityGrantShapesLocal(
    tenantId: TenantId,
    scopeId: ScopeId,
    shapes: readonly EntityGrantShape[],
    batch?: number,
  ): Promise<number> {
    const limit = shapeTopUpBatch(batch);
    if (shapes.length === 0) return 0;
    const stub = this.scopeStub(scopeId);
    let toppedUp = 0;
    for (let done = false; !done; ) {
      const pass = await stub.topUpEntityGrantShapes(tenantId, scopeId, shapes, limit);
      toppedUp += pass.toppedUp;
      done = pass.done;
    }
    return toppedUp;
  }

  // -- the connector write-back's far end (#574) -----------------------------
  // A CP-less dispatch vertical cannot run a connector, so the shared control
  // plane runs the pass FOR it and reaches back through the platform-secret-gated
  // `/internal/connector-*` surface — these are that surface's host methods. The
  // directory gates (live connection, tenant/vertical match) ran on the platform
  // side before the call; what runs HERE is the half only this deployment can
  // enforce: the scope's own permission check against its delivered
  // `connection:<id>` tuple, in the scope's own DO. Fail closed — no grant, no
  // effect — exactly as for any other caller. And the lifecycle delivered to the
  // scope (#1713): a held scope's invoke and bytes doors refuse, as every other door does.

  /** Invoke ONE operation in this deployment as a CONNECTION (#574). */
  async connectorInvokeLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: string,
    input?: unknown,
  ): Promise<unknown> {
    await this.assertLive(tenantId, scopeId); // #1713: a held scope runs no connector work either
    await this.migrateAndRecord(scopeId);
    return this.buildStub(tenantId, scopeId, undefined, connectionId).invoke(operation, input);
  }

  /** Land provider bytes in this deployment as a CONNECTION — the bytes leg (#574). */
  async connectorAttachmentUploadLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    upload: AttachmentUploadInput,
  ): Promise<AttachmentRecord> {
    // The lifecycle gate every attachments door takes (#1713), ahead of the bucket: a held
    // scope's provider bytes wait for the delivery's retry rather than land (#1995).
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    return this.buildAttachmentSurface({ connectionId }, tenantId, scopeId, store).upload(upload);
  }

  /**
   * Hand ONE attachment's bytes back to the platform as a CONNECTION (#711) — the
   * read half of the bytes leg. Gated exactly like the write: the target's
   * `readPermission`, checked in this scope's own DO against the connection's
   * delivered `connection:<id>` tuple. `null` for an id this scope does not know,
   * so a caller falls back rather than failing a dispatch over a missing file.
   */
  async connectorAttachmentOpenLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    attachmentId: string,
    eventId?: string,
  ): Promise<OpenedAttachment | null> {
    // Same gate as the upload leg: a held scope's bytes are not read out of its bucket.
    await this.assertLive(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    return this.buildAttachmentSurface(
      { connectionId },
      tenantId,
      scopeId,
      store,
      // #726 remedy B: the platform named a delivery; this deployment decides what that
      // delivery reaches, from its own spine row. Absent ⇒ the ordinary grant check.
      eventId === undefined ? undefined : { eventId },
    ).open(attachmentId);
  }

  /**
   * The delivery half of `grantToConnection` for a scope served HERE (#574): write
   * the scope-local `connection:<id>` grant tuple the permission checker reads.
   * Revocation needs no mirror verb — every delegated call re-passes the platform's
   * live-connection gate first, so revoking the connection closes the door even
   * while the tuple remains; `expiresAt` bounds the tuple itself.
   */
  async connectorGrantLocal(
    connectionId: ConnectionId,
    scopeId: ScopeId,
    permission: PermissionKey,
    expiresAt?: string,
  ): Promise<void> {
    await this.writeScopeTuple(
      scopeId,
      subjectRef({ kind: 'connection', id: connectionId }),
      `granted:${permission}`,
      `scope:${scopeId}`,
      expiresAt ?? null,
    );
  }

  /** #2045 (Codex r3): every switch mover here honours the fence — what `/internal/switch-fence` reports. */
  readonly switchFenced = true as const;

  /**
   * The far end of the schedule kill switch for a scope served HERE (#1666):
   * `/internal/system-switch` lands on this, from the shared control plane's
   * `revokeFromSystem` / `restoreToSystem`. It moves the switch in the scope's own DO and
   * answers what it did; it audits nothing, because the control plane that asked holds the
   * admin log and writes the row once this returns. `held: false` is an answer, not a
   * throw — see `systemSwitchOutcome`.
   */
  async systemSwitchLocal(
    scopeId: ScopeId,
    moduleId: ModuleId,
    to: 'on' | 'off',
    opts?: { tenantHeld?: boolean; fence?: string },
  ): Promise<SystemSwitchOutcome> {
    // Parsed on the way out: this is the wire answer the platform reads, and the DO's
    // plain strings become the published shape here rather than on trust.
    // #1819: `switchInScope` releases a rewind's hold on the module once the switch lands.
    return systemSwitchOutcome.parse(
      await this.switchInScope('system', scopeId, moduleId, to, new Date().toISOString(), opts?.tenantHeld ?? false, opts?.fence),
    );
  }

  /**
   * The far end of the status read for a scope served HERE (#1674): `/internal/system-grants`
   * lands on this, from the shared control plane's `systemGrantsStatus`. No admin-log join
   * happens here — this deployment holds none — so it answers the bare per-module position
   * only, exactly like `systemSwitchLocal` answers a bare outcome; the platform joins its
   * own admin log onto this by moduleId once it returns.
   */
  async systemGrantsStatusLocal(scopeId: ScopeId): Promise<SystemScheduleEntry[]> {
    return systemScheduleEntry.array().parse(await this.scopeStub(scopeId).systemGrantsStatus());
  }

  /**
   * The far end of the peer switch's status read (#1706): `/internal/peer-grants` lands on
   * this, from the shared control plane's `peerGrantsStatus`. The bare per-peer position
   * only — who switched a peer off and why is the admin log's, and this deployment holds
   * none — so the platform joins its own log onto this by slug once it returns.
   */
  async peerGrantsStatusLocal(scopeId: ScopeId): Promise<PeerGrantsEntry[]> {
    return peerGrantsEntry.array().parse(await this.scopeStub(scopeId).peerGrantsStatus());
  }

  // -- the peer door's far end (#1706) ----------------------------------------
  // The platform identified the calling deployment (the router, at the hop the caller cannot
  // forge) and resolved THIS scope as the instance of this vertical in the caller's tenant;
  // it reaches here over the platform-secret-gated `/internal/vertical-invoke`. What runs
  // HERE is the half only this deployment can enforce: the peer's admission and its grants,
  // in the scope's own DO, on every call.

  /** Invoke ONE operation in this deployment as a PEER vertical (#1706). */
  async verticalInvokeLocal(
    caller: VerticalCaller,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: string,
    input?: unknown,
    options?: InvokeOptions,
  ): Promise<unknown> {
    return (await this.getVerticalScope(caller, tenantId, scopeId)).invoke(operation, input, options);
  }

  /**
   * Move one peer's kill switch on a scope served HERE (#1706) — the far end of
   * `revokeFromPeer` / `restoreToPeer` for a hosted scope. Nothing is audited here; the
   * platform writes the admin rows around this call, as for the schedule switch.
   * #2029: through `switchInScope`, so the move releases a rewind's hold on the peer once it
   * lands, as a module's does. #2030: `tenantHeld`, the platform's word that the peer holds a
   * live tenant-level grant, which this deployment has no directory to read.
   */
  async peerSwitchLocal(
    scopeId: ScopeId,
    vertical: string,
    to: 'on' | 'off',
    opts?: { tenantHeld?: boolean; fence?: string },
  ): Promise<PeerSwitchOutcome> {
    return peerSwitchOutcome.parse(
      await this.switchInScope(
        'peer',
        scopeId,
        verticalSlug.parse(vertical),
        to,
        new Date().toISOString(),
        opts?.tenantHeld ?? false,
        opts?.fence,
      ),
    );
  }

  // -- the cross-vertical far ends (#1705 PR 2) --------------------------------
  // The shared control plane runs the cross-vertical phase for every hosted edge and reaches the
  // scopes over `/internal/exported-events`, `/internal/import-state` and `/internal/import-events`,
  // which land here. The platform resolved the pair and the tenant; what runs HERE is what only
  // this deployment can decide: what its own code exports and to whom, and what its own code
  // imports and runs. Each verb first proves the scope is one this deployment serves
  // (`assertServesLocally`), because a CP-less host has no directory and an unprovisioned DO
  // answers every read with a plausible empty result.

  /** The producer's release after a watermark (#1705), for a scope served HERE. */
  async exportedEventsLocal(tenantId: TenantId, scopeId: ScopeId, raw: ExportReadInput): Promise<ExportedBatch> {
    const input = exportReadInput.parse(raw);
    await this.assertServesLocally(tenantId, scopeId, 'readExportedEvents');
    return this.readExportsThroughDoor(input, tenantId, scopeId);
  }

  /**
   * #2029: a producer's export read, through the CONSUMER's peer door: the consumer's grants on
   * this scope decide what leaves it, so a consumer the rewind hold keeps off must hold nothing
   * here, exactly as a switched-off one does. Gated and pinned like every door call; held, the
   * producer answers every key missing, so the edge pauses rather than reading past the hold.
   */
  private async readExportsThroughDoor(input: ExportReadInput, tenantId: TenantId, scopeId: ScopeId): Promise<ExportedBatch> {
    const stub = this.scopeStub(scopeId);
    const door = await this.openDoor('peer', input.consumer, scopeId);
    try {
      return exportedBatch.parse(await door.through((instance) => stub.exportedEventsRead(input, tenantId, scopeId, { instance })));
    } catch (err) {
      if (!this.isHeldRefusal(err)) throw err;
      return exportedBatch.parse(await stub.exportedEventsRead(input, tenantId, scopeId, { held: true }));
    }
  }

  /**
   * The consumer's imports and watermarks (#1705), for a scope served HERE. The served-here
   * check comes FIRST, before the "this deployment imports nothing" answer. That answer is a
   * fact about this code, but given for a scope this deployment does not serve, it would tell the
   * platform the scope imports nothing, when the truth is that the platform asked the wrong
   * deployment. The platform reads the former as a disagreement with its registry, and must
   * hear the latter as a refusal.
   */
  async importStateLocal(tenantId: TenantId, scopeId: ScopeId): Promise<ImportState> {
    await this.assertServesLocally(tenantId, scopeId, 'importState');
    if (this.crossVertical.consumes().length === 0) return { consumes: [], cursors: [] };
    return importState.parse(await this.scopeStub(scopeId).importStateRead());
  }

  /** Apply a producer's batch (#1705) to a scope served HERE, through the peer door's gate. */
  async importEventsLocal(tenantId: TenantId, scopeId: ScopeId, batch: ImportBatch): Promise<ImportResult> {
    await this.assertServesLocally(tenantId, scopeId, 'deliverToPeer');
    return this.deliverToPeer(tenantId, scopeId, batch);
  }

  /**
   * The replay lever's far end (#1705 PR 3), for a consumer scope served HERE. The platform
   * resolved the producer and wrote the intent row. What runs here is the move itself, in this
   * deployment's own store, under the platform's `replayId`. Nothing is audited here, as for the
   * switches: the admin rows are the platform's.
   */
  async importCursorLocal(tenantId: TenantId, scopeId: ScopeId, raw: ImportCursorMoveAt): Promise<ImportCursorMoved> {
    const input = importCursorMoveAt.parse(raw);
    await this.assertServesLocally(tenantId, scopeId, 'moveImportCursor');
    return this.moveInScope(scopeId, input);
  }

  /** The move in this host's own scope DO, on the real clock (host code may read it). */
  private async moveInScope(scopeId: ScopeId, at: ImportCursorMoveAt): Promise<ImportCursorMoved> {
    return importCursorMoved.parse(await this.scopeStub(scopeId).importCursorMove({ ...at, now: Date.now() }));
  }

  /**
   * `HostAdmin.moveImportCursor` (#1705 PR 3): the peer switch's shape. Resolve, audit the
   * intent, move where the scope's storage is (the delegation for a hosted scope, this host's
   * own DO otherwise), and audit the outcome. Every attempt leaves a row, and a failed one
   * says why.
   */
  private async moveImportCursorAt(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    raw: ImportCursorMove,
  ): Promise<ImportCursorMoved> {
    const move = importCursorMove.parse(raw);
    if (this.cpLess) {
      throw substratError(
        'unavailable',
        'moveImportCursor needs the directory to resolve the producer — the platform moves a watermark, ' +
          'and reaches this deployment through /internal/import-cursor',
      );
    }
    const rec = await this.cp.getScopeRecord(tenantId, scopeId);
    if (!rec) throw unknownScopeForTenant(tenantId, scopeId);
    const source = await importCursorSourceOf(
      (t, v) => this.admin.resolveVerticalInstance(t, v),
      { tenantId, scopeId, vertical: rec.vertical },
      move.from,
    );
    // Where the write lands is the peer switch's rule: a scope bound to a vertical is served by
    // that vertical's deployment, and its watermark lives there. Without a delegation that
    // refusal stands (`assertServedHere`) rather than a move in the placeholder namespace.
    const delegation = rec.vertical !== null ? this.importCursorDelegation : undefined;
    if (!delegation) this.assertServedHere(rec, scopeId, 'moveImportCursor');
    await this.validateScopeAccess(tenantId, scopeId);
    const replayId = ulid();
    const target = { tenantId, scopeId, vertical: rec.vertical };
    const base = { replayId, mode: move.mode, from: move.from, source: source.scopeId };
    await this.recordAdmin(actor, 'moveImportCursor', target, null, { ...base, phase: 'intent', reason: move.reason });
    const at: ImportCursorMoveAt = { move, source: source as ImportCursorMoveAt['source'], replayId };
    let moved: ImportCursorMoved;
    try {
      moved = delegation
        ? importCursorMoved.parse(await delegation.move({ tenantId, scopeId, at }))
        : await this.moveInScope(scopeId, at);
    } catch (err) {
      await this.recordAdmin(actor, 'moveImportCursor', target, null, {
        ...base,
        phase: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
      throw err;
    }
    await this.recordAdmin(actor, 'moveImportCursor', target, null, {
      ...base,
      phase: 'applied',
      previous: moved.previous,
      cursor: moved.cursor,
      archived: moved.archived,
    });
    return moved;
  }

  /** #1705 PR 3: the promote gate's question, over two stored manifests (`exportBreaksOf`). */
  private exportBreaksBetween(
    actor: PlatformActorId,
    producer: string,
    outgoingManifest: string | null,
    incomingManifest: string | null,
  ): Promise<ExportBreak[]> {
    return exportBreaksOf({
      admin: this.admin,
      actor,
      producer,
      outgoing: exportsOfManifestJson(outgoingManifest),
      incoming: exportsOfManifestJson(incomingManifest),
      readImports: (slug, versionId) => this.versionImports(slug, versionId),
    });
  }

  /**
   * #1756: the bind gate's question for one install (`bindExportBreaksOf`), from the directory.
   * The serving pointer is read only when the scope is on a serving script before or after the
   * move, the one case it decides anything, and the incoming version's manifest comes from the
   * row the caller already holds.
   */
  private async bindBreaks(
    actor: PlatformActorId,
    scope: Scope,
    incoming: VersionRow,
    servingRef?: string | null,
  ): Promise<ExportBreak[]> {
    const vertical = scope.vertical && (scope.servingRef || servingRef) ? await this.cp.readVertical(scope.vertical) : undefined;
    return bindExportBreaksOf({
      admin: this.admin,
      actor,
      scope,
      incoming: { id: incoming.id, verticalSlug: incoming.vertical_slug },
      ...(servingRef !== undefined ? { servingRef } : {}),
      serving:
        vertical?.serving_ref && vertical.serving_version_id
          ? { ref: vertical.serving_ref, versionId: vertical.serving_version_id }
          : null,
      readExports: async (versionId) =>
        exportsOfManifestJson(
          versionId === incoming.id ? incoming.manifest_json : ((await this.cp.readVersion(versionId))?.manifest_json ?? null),
        ),
      readImports: (slug, versionId) => this.versionImports(slug, versionId),
    });
  }

  /**
   * The served-here gate (#1705 PR 2), from whichever source of truth this host has.
   *
   * With a directory, the directory decides: the record must exist for this (tenant, scope), and
   * the shared control plane refuses a scope bound to a vertical (`assertServedHere`). Role rows
   * are not consulted, because a directory-backed host provisions without projecting them.
   *
   * CP-less, which is every pushed vertical, there is no directory. The scope must have been
   * provisioned in THIS deployment's namespace, for THIS tenant (`ScopeDO.servesTenant`).
   *
   * A scope this host does not hold is refused `conflict`, not `not_found`: over `/internal` a
   * 404 means "this deployment predates the route", and the platform reads it as exactly that.
   * One exception: the SHARED control plane (a directory host with delegations) refuses a scope
   * bound to a vertical `unavailable`, through `assertServedHere`, the same answer its peer door
   * gives. It never mounts these routes, so no `/internal` caller meets that answer.
   */
  private async assertServesLocally(tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<void> {
    if (!this.cpLess) {
      const record = await this.cp.getScopeRecord(tenantId, scopeId);
      if (!record) {
        throw substratError('conflict', `${verb} cannot answer for scope ${scopeId}: the directory has no such scope for tenant ${tenantId}`);
      }
      this.assertServedHere(record, scopeId, verb);
      return;
    }
    if (!(await this.scopeStub(scopeId).servesTenant(tenantId))) {
      throw substratError(
        'conflict',
        `${verb} cannot answer for scope ${scopeId}: this deployment holds no scope provisioned for tenant ` +
          `${tenantId} under that id — the platform resolved the scope to a deployment that does not serve it`,
      );
    }
  }
  /**
   * What one pushed version imports from other verticals (#1705 PR 2), from its stored manifest:
   * the control plane's cross-vertical narrowing reads this to decide which scopes it calls.
   *
   * Deliberately NOT through `admin.versionManifest`, which writes an access-log row per read.
   * The narrowing asks once per distinct running version on every pass and every kick. Audited,
   * the log would grow with fleet × tick rate + request rate, for a read of the platform's own
   * code metadata (a version's declared edges, which a push put there), not of a tenant's data.
   * Throws `not_found` for a version the registry does not know under that vertical, which the
   * narrowing reports and treats as "cannot say" rather than "imports nothing".
   */
  async versionImports(verticalSlug: string, versionId: string): Promise<ManifestImports> {
    const v = await this.cp.readVersion(versionId);
    if (!v || v.vertical_slug !== verticalSlug) {
      throw substratError('not_found', `unknown version ${versionId} for vertical '${verticalSlug}'`);
    }
    return importsOfManifestJson(v.manifest_json);
  }
}

/** A ledger row -> the wire entry, the attribution re-nested (#1054). */
function modelUsageEntryOf(r: ModelUsageRow): ModelUsageEntry {
  return modelUsageEntry.parse({
    id: r.id,
    requestId: r.request_id,
    attribution: {
      tenant: r.tenant_id,
      scope: r.scope_id,
      vertical: r.vertical,
      version: r.version,
      operation: r.operation,
    },
    model: r.model,
    provider: r.provider,
    modelId: r.model_id,
    reported: r.reported === 1,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_input_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    listUsd: r.list_usd,
    at: r.at,
    elapsedMs: r.elapsed_ms,
  });
}
