import {
  fromWireFailure,
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
  accessLogEntry,
  adminLogEntry,
  opsFailureEntry,
  opsFailureFingerprint,
  issueEntry,
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
  capabilityGrant,
  principalId,
  connectionGrant,
  connectionGrantRecord,
  connectionSecret,
  systemGrant,
  systemSwitch,
  systemSwitchOutcome,
  systemScheduleEntry,
  entitlementGrant,
  entitlementGrantInput,
  instant,
  meterReading,
  subjectRef,
  createConnectionInput,
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
  type SystemGrantsStatusEntry,
  type CreateConnectionInput,
  type AccessLogEntry,
  type AdminLogEntry,
  type OpsFailureEntry,
  type IssueEntry,
  type EntityHistoryInput,
  type EventCauseInput,
  delegatedReadRecord,
  type EventEffectsInput,
  type EffectsTree,
  type InvocationEventsInput,
  type InvocationEvents,
  type DeadLettersInput,
  type DeadLetter,
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
  type BecomeCapabilityInput,
  type CapabilityExchange,
  type CapabilityId,
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
  type ScopeQueryResult,
  type ScopeTablePage,
  type Tenant,
  type TenantId,
  type TenantRole,
  type TenantStatus,
  type TenantStoreHandle,
  outboundOfManifestJson,
  substratError,
  redrainEventsInput,
  peerCoverage,
  peerSwitch,
  peerSwitchOutcome,
  verticalCaller,
  verticalResolution,
  verticalSlug,
  type PeerCoverage,
  type PeerSpec,
  type PeerSwitch,
  type PeerSwitchOutcome,
  type PeerSwitchResult,
  type VerticalCaller,
  type VerticalResolution,
} from '@substrat-run/contracts';
import { normalizeHostname, toRouteTarget } from './route-resolver.js';
import {
  attachmentBlobKey,
  entitlementDenial,
  foldMeterReading,
  parseValidationRecords,
  resolveScopeRecord,
  ulid,
  capabilityTokenHash,
  checkBecomeInput,
  plausibleSessionToken,
  type AccessLogFilter,
  type AuditLogFilter,
  type OpsFailureFilter,
  type OpsFailureInput,
  type IssueFilter,
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
  type ExecutorRetryPolicy,
  type MigrateScopeOutcome,
  type MigrationFrontier,
  backoffAt,
  resolveRetryPolicy,
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
  runDueJobRuns,
  startJobRun,
  type JobDriveReport,
  type JobHandler,
  type JobRun,
  type JobRunFilter,
  type JobRunPatch,
  type JobRunRow,
  type JobRunStore,
  type JobStepRow,
  type StartJobRunInput,
  type LiveReadSurface,
  type SubjectRedactionCounts,
  type LegacySubjectRedactionCounts,
  globalFetch,
  assertRedrainWindow,
  platformRequestOf,
  type PlatformRequestRawRow,
  undrainedEventsOf,
  type UndrainedEvents,
  type UndrainedRead,
  type SwitchOutcome,
  type SystemScheduleState,
  type SystemGrantsEntry,
  systemSwitchedOffMessage,
  CrossVerticalRegistry,
  collectPeers,
  peerSeats,
  connectorCallRecord,
  noopConnectorCallRecorder,
  recordConnectorCall,
  settleConnectionUse,
  type ConnectionUseOutcome,
  type ConnectorCallRecorder,
} from '@substrat-run/kernel';
import {
  isOrangeToOrange,
  isUpgradeRequest,
  LIVE_MODE_HEADER,
  LIVE_PRINCIPAL_HEADER,
  LIVE_SCOPE_HEADER,
  LIVE_SUBSCRIBE_PATH,
  LIVE_TENANT_HEADER,
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
  OrgRow,
  RoleRow,
  RouteRow,
  ScopeRow,
  VerticalRow,
  VersionRow,
} from './control-plane-do.js';

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
  validateScopeAccess(tenantId: string, scopeId: string): Promise<void>;
  transitionScope(
    tenantId: string,
    scopeId: string,
    from: string[],
    to: ScopeStatus,
    action: string,
  ): Promise<{ status: string; vertical: string | null }>;
  defineRole(tenantId: string, role: RoleDefinition): Promise<RoleDefinition | null>;
  listRoles(filter: { tenantId?: string; source?: string } & ListPage): Promise<RoleRow[]>;
  writeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
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
    createdAt: string;
  }): Promise<void>;
  listVersions(verticalSlug: string, page?: ListPage): Promise<VersionRow[]>;
  setAdmission(id: string, admission: string, note: string | null): Promise<void>;
  bindScopeVersion(scopeId: string, versionId: string, verticalSlug: string): Promise<void>;
  markScopeProvisioned(scopeId: string, versionId: string): Promise<void>;
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
  /** K-21 tombstone. Returns whether anything changed (idempotent revoke). */
  revokeMember(tenantId: string, subject: string, object: string, at: string): Promise<boolean>;
  /** Tombstone any tenant tuple by exact (subject, relation, object) — e.g. a role. Idempotent. */
  revokeTenantTuple(tenantId: string, subject: string, relation: string, object: string, at: string): Promise<boolean>;
  listMembers(
    tenantId: string,
    object: string,
    includeRevoked: boolean,
  ): Promise<{ subject: string; revoked_at: string | null }[]>;
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
  listOpsFailures(query: OpsFailureQuery): Promise<OpsFailureEntry[]>;
  recordSweepRun(row: SweepRunRow): Promise<void>;
  listSweepRuns(query: SweepRunQuery): Promise<SweepRunEntry[]>;
  listIssues(query: IssueQuery): Promise<unknown[]>;
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
  scopeId: string | null;
  vertical: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

/** A capability attachment verb's answer (#1686) — the ScopeDO's `CapabilityAttachmentReply`. */
type CapabilityAttachmentReply<T> = { value: T; failure?: undefined } | { failure: WireFailure };

/** Rethrow a capability attachment verb's failure, rebuilt with its code; else its value. */
function unwrapCapabilityReply<T>(reply: CapabilityAttachmentReply<T>): T {
  if (reply.failure) throw fromWireFailure(reply.failure);
  return reply.value as T;
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
  /** Where a module's schedules stand on this scope (#383, #1666) — the kernel's
   *  `systemScheduleState`, run in the scope's own storage. */
  systemScheduleState(moduleId: string): Promise<SystemScheduleState>;
  /** Move a module's schedule switch on this scope (#1666) — the kernel's
   *  `switchSystemSchedules`, as one serialized unit. */
  switchSystemSchedules(moduleId: string, scopeId: string, to: 'on' | 'off', at: string): Promise<SwitchOutcome>;
  /** Move one peer's kill switch on this scope (#1706) — the kernel's `switchPeer`. */
  switchPeer(vertical: string, scopeId: string, to: 'on' | 'off', at: string): Promise<SwitchOutcome>;
  /** Does a peer hold each key here now (#1706) — the checker's own `covers`. */
  peerCovers(
    tenantId: TenantId,
    scopeId: ScopeId,
    vertical: string,
    permissions: PermissionKey[],
  ): Promise<PeerCoverage[]>;
  /** Every module this scope holds or has held system authority for, and where each
   *  stands (#1674) — the kernel's `systemGrantsStatus`, run in the scope's own storage. */
  systemGrantsStatus(): Promise<SystemGrantsEntry[]>;
  /** `grantToSystem`'s scope-level write (#1666): `false`, and nothing written, while the
   *  module's schedule kill switch is off on this scope. */
  writeSystemGrant(moduleId: string, relation: string, object: string, expiresAt: string | null): Promise<boolean>;
  /** The last time a schedule's operation ran on this scope (#383), or null if never. */
  scheduleLastRun(operation: string): Promise<string | null>;
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
   *  exists to remove. */
  recordScheduleRun(
    unit: string,
    at: string,
    status: 'ok' | 'failed' | 'skipped',
    kind: ScheduleStateKind,
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
  jobRunById(id: string): Promise<JobRunRow | null>;
  jobRunInsert(row: JobRunRow): Promise<void>;
  jobRunsDue(now: string, limit: number, afterId?: string): Promise<JobRunRow[]>;
  jobRunList(filter: JobRunFilter): Promise<JobRunRow[]>;
  jobRunPatch(id: string, patch: JobRunPatch): Promise<void>;
  jobCommitPass(id: string, patch: JobRunPatch): Promise<void>;
  jobStepRow(runId: string, step: string): Promise<JobStepRow | null>;
  jobStepRecord(
    runId: string,
    step: string,
    result: string | null,
    attempts: number,
    lastError: string | null,
    at: string,
  ): Promise<void>;
  /** This scope's live `connection:<id>` grant tuples (#726 gap 1) — the read-back.
   *  Unions the scope's own tuples with the projected tenant-level ones, because a
   *  scope check consults both (rule 2 inheritance). */
  listConnectionGrants(
    now: string,
  ): Promise<{ subject: string; relation: string; expires_at: string | null }[]>;
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
  /** Tombstone a scope tuple by exact (subject, relation, object). Idempotent. */
  revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
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
  ): Promise<CapabilityAttachmentReply<AttachmentRecord[]>>;
  capabilityAttachmentOpen(
    attachmentId: string,
    sessionHash: string,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<CapabilityAttachmentReply<AttachmentRecord | null>>;
  /** #1686: always a failure — the refusal of a write through a capability, recorded (K-35). */
  capabilityAttachmentRefuseWrite(
    sessionHash: string,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: 'attachments.upload' | 'attachments.remove',
    target: { entityType: string } | { attachmentId: string },
  ): Promise<CapabilityAttachmentReply<never>>;
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
  ): Promise<void>;
  /** Resolve an external identity from this scope's projected links (#406) — the CP-less auth read. */
  resolveProjectedIdentity(
    tenantId: string,
    provider: string,
    externalId: string,
  ): Promise<{ principal: string; scopeId: string | null } | undefined>;
  /** Read-only introspection of this scope's DB (§5.4 admin-query RPC). */
  introspectTables(): Promise<ScopeTable[]>;
  introspectTable(table: string, limit: number, offset: number): Promise<ScopeTablePage>;
  /** One read-only SQL statement, gated + rolled back inside the DO (#219). */
  introspectQuery(sql: string): Promise<ScopeQueryResult>;
  /** The K-35 denial log, read back (#867) — raw rows and the bucketed view. */
  listDenials(filter?: DenialFilter): Promise<PermissionDenial[]>;
  summarizeDenials(filter?: DenialFilter): Promise<DenialSummary>;
  /** Complete logical dump of this scope's DB (preview-and-snapshots.md §3). */
  exportDump(): Promise<ScopeDumpTable[]>;
  /**
   * Load a dump into this (freshly-provisioned) scope — the fork write side.
   * `destScopeId` re-points the dump's scope-level grants at the destination.
   */
  importDump(tables: ScopeDumpTable[], destScopeId?: ScopeId): Promise<void>;
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
   */
  redactSubject(
    subjectId: string,
  ): Promise<SubjectRedactionCounts | LegacySubjectRedactionCounts | number>;
  /** PITR bookmarks recorded before migration passes (#286), newest first. */
  migrationBookmarks(limit?: number): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]>;
  appliedMigrations(limit?: number): Promise<{ moduleId: string; version: string; appliedAt: string | null }[]>;
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
  exportedEventsRead(input: ExportReadInput, tenantId: TenantId, scopeId: ScopeId): Promise<ExportedBatch>;
  /** #1705: what the DO's modules import, and its watermark per producer. */
  importStateRead(): Promise<ImportState>;
  /** #1705: apply a batch another vertical exported, under the watermark's compare-and-set. */
  importApply(batch: ImportBatch, tenantId: TenantId, scopeId: ScopeId): Promise<ImportResult>;
  redrainEvents(drainedBefore: string): Promise<number>;
  /** How many rows that reopen WOULD touch, touching none of them (#1545). */
  redrainCount(drainedBefore: string): Promise<number>;
  facetEvents(input: EventFacetInput): Promise<EventFacetResult>;
  eventCause(input: EventCauseInput): Promise<CauseChain>;
  eventEffects(input: EventEffectsInput): Promise<EffectsTree>;
  invocationEvents(input: InvocationEventsInput): Promise<InvocationEvents>;
  deadLetters(input: DeadLettersInput): Promise<Page<DeadLetter>>;
  /** Rewind storage to a bookmark (#286's backout) — completes on the DO's restart. */
  rewindToBookmark(bookmark: string, opts?: { force?: boolean }): Promise<{ rewindingTo: string }>;
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
  }): Promise<SwitchOutcome>;
  /**
   * The read half (#1674): every module the deployment serving this scope holds or has
   * held system authority for, and where each stands. Same reach as `switch` — the same
   * `/internal/*` seam, the same deployment, the same "who actually holds the grants"
   * answer — so the two can never disagree about what a hosted scope's switch shows.
   */
  status(args: { tenantId: TenantId; scopeId: ScopeId }): Promise<SystemScheduleEntry[]>;
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
   * the `R2Bucket` binding carrying its attachments — typically
   * `env[blobStoreBindingName('<BINDING>', tenantId)]`, where `<BINDING>` is the
   * vertical's declared `blobStoreNeed.binding`. The VERTICAL's worker supplies this
   * because only it knows its declared binding name; the kernel owns everything else
   * (key derivation, permission gates, metadata facts). Omitted (or resolving null),
   * `attachments()` refuses loudly rather than serving ungated bytes.
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
 * A control-plane stand-in for a CP-less vertical (scope-local-permissions.md Phase 3).
 * The hot path a served scope actually touches becomes trust-the-upstream:
 *   - `validateScopeAccess` / `setMigrationState` → no-op: the router already gated the
 *     scope's lifecycle + tenancy from the shared directory, so the vertical trusts the
 *     asserted node rather than re-reading a directory it does not have.
 *   - `tenantHoldsEntitlement` → true: the SKU was enforced on the shared control plane
 *     at provision (before `provisionInstance`), so a scope that EXISTS here was granted
 *     it upstream — a single-vertical deployment holds its own entitlements by construction.
 *   - `recordAdmin` / `recordAccess` → no-op: the shared control plane owns the audit spine.
 * Every other method throws — the admin directory surface genuinely is unavailable.
 */
function nullControlPlane(): ControlPlaneStub {
  const noop = async (): Promise<undefined> => undefined;
  const passthrough: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    validateScopeAccess: noop,
    setMigrationState: noop,
    recordAdmin: noop,
    recordAccess: noop,
    tenantHoldsEntitlement: async () => true,
  };
  return new Proxy({} as ControlPlaneStub, {
    get: (_t, prop) =>
      typeof prop === 'string' && prop in passthrough
        ? passthrough[prop]
        : async () => {
            throw new Error(
              `control plane unavailable: '${String(prop)}' — this host is scope-local / CP-less ` +
                `(docs/architecture/scope-local-permissions.md, Phase 3)`,
            );
          },
  });
}

export class CloudflareScopeHost implements ScopeHost {
  readonly admin: HostAdmin;

  private readonly scopeNs: DurableObjectNamespace;
  private readonly cp: ControlPlaneStub;
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
  /** Worker-side attachment-bucket resolver (#473); undefined ⇒ attachments() refuses. */
  private readonly attachmentBuckets?: (tenantId: string) => unknown | null | Promise<unknown | null>;
  private readonly executors = new Map<string, RegisteredEffector>();
  /**
   * `<moduleId>/<job>` → the pass body and its default step policy (#1577). Host
   * code like `executors`, and keyed the way a run row is: the coalescing key's
   * first two thirds, so a run read off the DO finds its handler by the columns it
   * already carries. The HANDLER stays on the coordinator — it holds credentials
   * and calls the internet, which is why the DO never sees it.
   */
  private readonly jobs = new Map<string, { handler: JobHandler; retry?: ExecutorRetryPolicy }>();
  /**
   * The event currently being effected, stamped onto admin rows the executor writes.
   * Ambient rather than threaded through every HostAdmin signature: set and cleared
   * around one await, with executors running sequentially, so there is no window
   * where it belongs to a different event.
   */
  private causedBy: string | null = null;
  private readonly withdrawn = new Map<string, string>(); // operation → module
  private readonly operationEntitlement = new Map<string, string>();
  /** #574: remote connector write-back for scopes served by another deployment. */
  private readonly connectorDelegation?: ConnectorDelegation;
  /** #1334: the Tier-2 drain's reach into the deployment serving a scope. */
  private readonly eventDrainDelegation?: EventDrainDelegation;
  /** #1666: the schedule kill switch's reach into the deployment serving a scope. */
  private readonly systemSwitchDelegation?: SystemSwitchDelegation;

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
    this.secretBox = options.secretBox ?? unconfiguredSecretBox;
    this.tenantStores = options.tenantStores;
    this.blobStores = options.blobStores;
    this.attachmentBuckets = options.attachmentBuckets;
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
  ): Promise<ExecutorDrainReport> {
    const report: ExecutorDrainReport = {
      attempted: 0,
      delivered: 0,
      retrying: 0,
      deadLettered: 0,
      routedToPlatform: 0,
    };
    if (this.executors.size === 0) return report;
    const stub = this.scopeStub(scopeId);
    for (const [id, executor] of this.executors) {
      const deliveryId = `executor:${id}`;
      const { events, undecodable } = await stub.pendingExecutorDeliveries(deliveryId, executor.eventType);
      // #1636: an event the DO could not decode is dead-lettered for this executor at once,
      // and its handler never sees it. Terminal on the FIRST failure, unlike a handler's:
      // the decode is pure, so a retry cannot succeed. The rows behind it are delivered
      // below — the decode used to throw the whole list, on every pass.
      for (const bad of undecodable) {
        report.attempted += 1;
        await stub.recordExecutorAttempt(bad.eventId, deliveryId, bad.error, null, invocationId);
        report.deadLettered += 1;
      }
      for (const event of events) {
        report.attempted += 1;
        this.causedBy = event.id;
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
          } else if (executor.kind === 'connector') {
            await executor.handler(
              await this.connectorContext(tenantId, scopeId, executor.timeoutMs, event.id),
              event,
            );
            await stub.recordExecutorAttempt(event.id, deliveryId, null, null, invocationId);
            report.delivered += 1;
          } else {
            await executor.handler(this.admin, event);
            await stub.recordExecutorAttempt(event.id, deliveryId, null, null, invocationId);
            report.delivered += 1;
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
        } finally {
          this.causedBy = null;
        }
      }
    }
    return report;
  }

  async drainDue(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDrainReport> {
    // Same lifecycle gate `getScope` applies (K-3): a suspended or archived scope
    // does not get its effects driven either.
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
  ): void {
    const key = `${moduleId}/${name}`;
    if (this.jobs.has(key)) throw new Error(`job '${key}' is already registered`);
    this.jobs.set(key, { handler, retry });
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
      get: (id) => stub.jobRunById(id),
      due: (now, limit, afterId) => stub.jobRunsDue(now, limit, afterId),
      list: (filter) => stub.jobRunList(filter),
      patch: (id, patch) => stub.jobRunPatch(id, patch),
      commitPass: (id, patch) => stub.jobCommitPass(id, patch),
      step: (runId, name) => stub.jobStepRow(runId, name),
      recordStep: (runId, name, result, attempts, lastError, at) =>
        stub.jobStepRecord(runId, name, result, attempts, lastError, at),
    };
  }

  async startJobRun(
    tenantId: TenantId,
    scopeId: ScopeId,
    input: StartJobRunInput,
  ): Promise<JobRun> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return runDueJobRuns({
      store: this.jobStore(scopeId),
      handlerFor: (run) => this.jobs.get(`${run.module_id}/${run.job}`),
      now: () => new Date().toISOString(),
      openScope: (run) => this.getSystemScope(run.module_id as ModuleId, tenantId, scopeId),
      maxPasses: options?.maxPasses,
      limit: options?.limit,
    });
  }

  async jobRuns(tenantId: TenantId, scopeId: ScopeId, filter?: JobRunFilter): Promise<JobRun[]> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
    this.causedBy = event.id;
    try {
      await handler(
        await this.connectorContext(tenantId, scopeId, options?.timeoutMs ?? 30_000, event.id),
        event,
      );
    } finally {
      this.causedBy = null;
    }
  }

  async executorDeadLetters(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDeadLetter[]> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    // Tolerant (#1588): one undecodable row comes back naming why, never throws for the list.
    return (await this.scopeStub(scopeId).pendingPlatformRequests()).map(platformRequestOf);
  }

  async listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    if (!rec) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    if (rec.status !== 'active' && rec.status !== 'provisioning') {
      throw new Error(`scope not migratable (status: ${rec.status}): ${scopeId}`);
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
    return this.scopeStub(scopeId).introspectTable(input.table, input.limit, input.offset);
  }

  /** The SQL console's CP-less path (#219) — same trust line as the pair above. */
  async introspectScopeQuery(scopeId: ScopeId, input: QueryScopeInput): Promise<ScopeQueryResult> {
    return this.scopeStub(scopeId).introspectQuery(input.sql);
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
   * Copy one scope's data into a fresh scope DO, entirely within THIS deployment —
   * the data half of an orchestrated snapshot (preview-and-snapshots.md §9). Like the
   * introspection pair above it consults no control plane: the vertical's platform-
   * gated `/internal/snapshot` route calls it, and the directory half (provenance row,
   * activation, version bind) stays on the control plane's side. Because source and
   * destination sit in the same SCOPE namespace, no scope bytes ever leave the
   * deployment — the §9 property the trust line rests on.
   */
  async snapshotScopeLocal(
    sourceScopeId: ScopeId,
    destScopeId: ScopeId,
  ): Promise<{ tables: number }> {
    const tables = await this.scopeStub(sourceScopeId).exportDump();
    await this.scopeStub(destScopeId).importDump(tables, destScopeId);
    return { tables: tables.length };
  }

  /**
   * Load a dump into one scope DO in THIS deployment (drop-then-replay) — the
   * CP-less write half of `exportScopeLocal`, behind the vertical's
   * `/internal/restore`. The control plane is the gate and the auditor; this end
   * just replaces its own bytes with the dump's, migration frontier included.
   */
  async restoreScopeLocal(scopeId: ScopeId, tables: ScopeDumpTable[]): Promise<{ tables: number }> {
    await this.scopeStub(scopeId).importDump(tables, scopeId);
    return { tables: tables.length };
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
    await this.scopeStub(scopeId).applyProjection(
      tenantId,
      roles.map((r) => ({ role_key: r.key, permissions: JSON.stringify(r.permissions), source: r.source })),
      [],
    );
  }

  /**
   * Wipe one scope DO's storage in THIS deployment — the reap half of an orchestrated
   * deleteSnapshot (§9). The fork-only refusal and the directory cleanup live on the
   * control plane, which calls the vertical's `/internal/delete-scope` before deleting
   * the row; this end just destroys its own bytes.
   */
  async deleteScopeLocal(scopeId: ScopeId): Promise<void> {
    await this.scopeStub(scopeId).destroyStorage();
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
   */
  async rewindScopeLocal(
    scopeId: ScopeId,
    bookmark: string,
    opts?: { force?: boolean },
  ): Promise<{ rewindingTo: string }> {
    return this.scopeStub(scopeId).rewindToBookmark(bookmark, opts);
  }

  registerModule(registration: ModuleRegistration): void {
    const manifest = moduleManifest.parse(registration.manifest);
    if (this.moduleIds.has(manifest.id)) {
      throw new Error(`module already registered: ${manifest.id}`);
    }
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
    for (const name of Object.keys(registration.operations ?? {})) {
      this.bindOperation(name);
      this.operationEntitlement.set(name, manifest.entitlementKey);
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
    const created = await this.cp.provisionScope(
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
    for (const [moduleId, schedules] of this.moduleSchedules) {
      const perms = new Set<string>();
      for (const s of schedules) for (const p of s.permissions) perms.add(p);
      for (const perm of perms) {
        await this.scopeStub(input.scopeId).seatTuple(
          `system:${moduleId}`,
          `granted:${perm}`,
          `scope:${input.scopeId}`,
          null,
        );
      }
    }
    // #1706: every declared PEER holds its keys on the scope from provisioning on — the one
    // call (`peerSeats`) that makes "declared and installed" mean "live". Same seat as the
    // schedule grants above, so a grant a switch tombstoned stays tombstoned and a
    // switched-off peer gets nothing seated.
    for (const seat of peerSeats(collectPeers(this.peerSources), input.scopeId)) {
      await this.scopeStub(input.scopeId).seatTuple(seat.subject, seat.relation, seat.object, null);
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
      throw new Error(`cannot provision tenant store under unknown tenant: ${input.tenantId}`);
    }
    if (tenant.status !== 'active') {
      throw new Error(
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
    const stored = await this.cp.putTenantStore({
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
      throw new Error(`cannot provision blob store under unknown tenant: ${input.tenantId}`);
    }
    if (tenant.status !== 'active') {
      throw new Error(
        `cannot provision blob store under non-active tenant (status: ${tenant.status}): ${input.tenantId}`,
      );
    }
    const existing = await this.cp.getBlobStore(input.tenantId, input.vertical, input.binding);
    if (existing) return { binding: input.binding, kind: 'blob', ref: existing.ref };
    const name = await blobStoreBucketName(input.tenantId, input.vertical, input.binding);
    const ref = await r2.create(name);
    const stored = await this.cp.putBlobStore({
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    return this.buildAttachmentSurface({ principal }, tenantId, scopeId, store);
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
    if (!scope) throw new Error(`unknown scope for connection: ${scopeId}`);
    if (scope.vertical !== conn.vertical) {
      throw new Error(
        `connection ${connectionId} is for vertical '${conn.vertical}' and scope ${scopeId} ` +
          `runs '${scope.vertical ?? 'none'}'`,
      );
    }
    await this.cp.validateScopeAccess(conn.tenant_id as TenantId, scopeId);
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

  /** Resolve the per-tenant R2 blob store, or fail closed exactly as `attachments` did. */
  private async resolveAttachmentStore(tenantId: TenantId): Promise<TenantBlobStore> {
    if (!this.attachmentBuckets) {
      throw new Error(
        `attachments are not configured on this host (#473): pass ` +
          `CloudflareScopeHostOptions.attachmentBuckets — (tenantId) => ` +
          `env[blobStoreBindingName('<BINDING>', tenantId)] for the vertical's declared blob store`,
      );
    }
    const bucket = await this.attachmentBuckets(tenantId);
    if (!bucket) {
      throw new Error(
        `no attachment bucket resolved for tenant ${tenantId} (#473) — is the per-tenant blob ` +
          `store provisioned and its r2_bucket binding attached to the serving script?`,
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
          unwrapCapabilityReply(
            await stub.capabilityAttachmentRefuseWrite(hash, tenantId, scopeId, 'attachments.upload', {
              entityType: input.entity.entityType,
            }),
          ),
        list: async (entity) =>
          unwrapCapabilityReply(await stub.capabilityAttachmentList(entity, hash, tenantId, scopeId)),
        open: async (attachmentId) => {
          const record = unwrapCapabilityReply(
            await stub.capabilityAttachmentOpen(attachmentId, hash, tenantId, scopeId),
          );
          return record ? this.openAttachmentBytes(store, scopeId, record) : null;
        },
        remove: async (attachmentId) =>
          unwrapCapabilityReply(
            await stub.capabilityAttachmentRefuseWrite(hash, tenantId, scopeId, 'attachments.remove', {
              attachmentId,
            }),
          ),
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
          sha256: await sha256Hex(input.body),
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
    if ((await sha256Hex(obj.body)) !== record.sha256) {
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
    await this.scopeStub(input.scopeId).importDump(dump.tables, input.scopeId);
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
  ): Promise<void> {
    // Restore never creates a scope (that is importScope) — an unknown target fails closed.
    const existing = await this.admin.getScopeRecord(actor, tenantId, scopeId);
    if (!existing) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
    await this.scopeStub(scopeId).importDump(dump.tables, scopeId);
    await this.recordAdmin(
      actor,
      'restoreScope',
      { tenantId, scopeId },
      null,
      { sourceScopeId: dump.scopeId, tables: dump.tables.length, capturedAt: dump.capturedAt },
    );
  }

  async snapshotScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    opts?: { kind?: string; expiresAt?: string },
  ): Promise<ScopeId> {
    const source = await this.admin.getScopeRecord(actor, tenantId, scopeId);
    if (!source) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
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
    if (!rec) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
    if (!rec.forkedFrom && rec.kind !== 'preview') {
      throw new Error(
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
    await this.cp.validateScopeAccess(tenantId, scopeId);

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
    if (!scope) throw new Error(`unknown scope for connection: ${scopeId}`);
    if (scope.vertical !== conn.vertical) {
      throw new Error(
        `connection ${connectionId} is for vertical '${conn.vertical}' and scope ${scopeId} ` +
          `runs '${scope.vertical ?? 'none'}'`,
      );
    }
    await this.cp.validateScopeAccess(conn.tenant_id as TenantId, scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    if (!this.moduleIds.has(moduleId)) {
      throw new Error(`module not registered on this host: ${moduleId}`);
    }
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return this.buildStub(tenantId, scopeId, undefined, undefined, moduleId);
  }

  /**
   * #1705: the consumer half. The same lifecycle gate as every door (K-3), then the ScopeDO
   * applies the batch, and the answer is re-parsed on this side of the RPC. Executors run here
   * afterwards, as they do after an invoke. A failure to drain them does not un-deliver a batch
   * that has committed, so it is contained, and the outbox is their backstop.
   */
  async deliverToPeer(tenantId: TenantId, scopeId: ScopeId, raw: ImportBatch): Promise<ImportResult> {
    const batch = importBatch.parse(raw);
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    const result = importResult.parse(await this.scopeStub(scopeId).importApply(batch, tenantId, scopeId));
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    return this.buildStub(tenantId, scopeId, undefined, undefined, undefined, options, undefined, undefined, parsed);
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
    return peerCoverage
      .array()
      .parse(await this.scopeStub(scopeId).peerCovers(tenantId, scopeId, verticalSlug.parse(vertical), [...permissions]));
  }

  /**
   * Where a peer verb (#1706) may reach a scope: its own ScopeDO, after the ordinary pair and
   * lifecycle gate. Refused, loudly, on the SHARED control plane for a scope bound to a
   * vertical, whose storage lives in that vertical's deployment — reaching through
   * `this.scopeStub` there would open an empty DO in the wrong namespace. On the hosted path a
   * peer reaches the target deployment itself, through the platform, never through this host.
   */
  private async peerScopeGate(tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<void> {
    if (this.servesScopesElsewhere) {
      const rec = await this.cp.getScopeRecord(tenantId, scopeId);
      if (rec && rec.vertical !== null) {
        throw substratError(
          'unavailable',
          `${verb} cannot reach scope ${scopeId}: it is served by the '${rec.vertical}' deployment, ` +
            'which a peer reaches through the platform, not through the shared control plane',
        );
      }
    }
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
  private get servesScopesElsewhere(): boolean {
    return Boolean(this.connectorDelegation || this.systemSwitchDelegation || this.eventDrainDelegation);
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
    if (!rec) throw substratError('not_found', `unknown scope for tenant: (${tenantId}, ${scopeId})`);
    if (this.servesScopesElsewhere && rec.vertical !== null) {
      throw substratError(
        'unavailable',
        `${verb} cannot reach scope ${scopeId}: it is served by the '${rec.vertical}' ` +
          'deployment, and platform capability verbs are not delegated there yet',
      );
    }
    await this.migrateAndRecord(scopeId);
    return { stub: this.scopeStub(scopeId), vertical: rec.vertical };
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
    // to ask (#461) — it already trusts the router-asserted (tenant, scope) for the
    // whole request path, and lifecycle for its scopes lives wherever provisioning
    // does, so the grant check below is the only gate it can and does enforce.
    if (!this.cpLess) {
      const rec = await this.cp.getScopeRecord(tenantId, scopeId);
      if (!rec || rec.status !== 'active') return report;
    }

    const stub = this.scopeStub(scopeId);
    // The grant IS the switch (#383), and the kill switch is its lever (#1666): the
    // kernel's `systemScheduleState`, the one predicate both adapters run. A scope that
    // never held the module's grant (a foreign vertical's) is a quiet no-op, exactly as
    // before. A scope switched OFF reports every schedule `skipped`, never `failed`, and
    // does not touch its cadence rows — so a restore fires a due schedule on the next pass.
    const state = await stub.systemScheduleState(moduleId);
    if (state === 'ungranted') return report;
    if (state === 'off') {
      for (const schedule of schedules) {
        report.skipped += 1;
        report.runs!.push({ operation: schedule.operation, outcome: 'skipped' });
      }
      report.switchedOff = true;
      return report;
    }
    const now = Date.now();
    for (const schedule of schedules) {
      const last = await stub.scheduleLastRun(schedule.operation);
      const lastRun = last ? Date.parse(last) : null;
      const dueAt = lastRun === null ? -Infinity : lastRun + schedule.cadence.everyMinutes * 60_000;
      if (now < dueAt) {
        report.skipped += 1;
        report.runs!.push({ operation: schedule.operation, outcome: 'skipped' });
        continue;
      }
      let status: 'ok' | 'failed' = 'ok';
      try {
        const scope = await this.getSystemScope(moduleId, tenantId, scopeId);
        await scope.invoke(schedule.operation, schedule.input);
        report.fired += 1;
      } catch (err) {
        status = 'failed';
        report.failed += 1;
        report.errors.push({
          operation: schedule.operation,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // #1288: 'schedule', whatever this operation happens to be called — including
      // `freshness:<something>`, which is exactly the row the evaluator no longer eats.
      await stub.recordScheduleRun(schedule.operation, new Date(now).toISOString(), status, 'schedule');
      report.runs!.push({ operation: schedule.operation, outcome: status === 'ok' ? 'ok' : 'failed' });
    }
    return report;
  }

  /** The stub body, shared by the principal, connection, system and impersonation doors. */
  private buildStub(
    tenantId: TenantId,
    scopeId: ScopeId,
    principal?: PrincipalId,
    connectionId?: ConnectionId,
    systemModuleId?: string,
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
      invoke: async <O, I>(
        operation: string,
        input?: I,
        invokeOptions?: InvokeOptions,
      ): Promise<O> => {
        // Entitlement gate (§4.3): a module loads for a tenant only if the tenant holds its
        // SKU flag. The COORDINATOR gates the console-managed path against the shared CP
        // (`cp.tenantHoldsEntitlement`); for a hosted/CP-less scope that call is a trusting
        // no-op, so the SAME `requiredKey` is passed to the DO, which fails closed against
        // its PROJECTED entitlements (#304). One or the other enforces, never neither.
        const requiredKey = operationEntitlement.get(operation);
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
        const envelope = await stub.invoke(
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
        );
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
        const drained =
          session?.mode === 'read-only'
            ? { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0, routedToPlatform: 0 }
            // #1525: this drain is part of the call that emitted the events — the
            // coordinator's half of the post-commit tail the DO ran the consumers in.
            : await this.drainExecutors(tenantId, scopeId, invokeOptions?.invocationId ?? null);
        // #458: the operation committed having enqueued platform intents — tell the
        // caller's harness so it can flag the response for the router kick (#381).
        // Routed connector deliveries (#574 phase 3) count too: the inline drain just
        // turned this operation's event into a `connector:<provider>` intent, and the
        // kick is what collapses its dispatch latency from sweep-cadence to seconds.
        const enqueued = envelope.platformRequests + (drained.routedToPlatform ?? 0);
        if (enqueued > 0) options?.onPlatformRequests?.(enqueued);
        if (envelope.concurrency) invokeOptions?.onEntityVersion?.(envelope.concurrency.version);
        if (envelope.idempotency?.replayed) invokeOptions?.onIdempotentReplay?.();
        return envelope.result as O;
      },
    };
  }

  async close(): Promise<void> {
    // Nothing to drain: every admin write awaits its RPC to completion inline.
  }

  // -- admin surface --------------------------------------------------------

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
    const mapVersion = (r: VersionRow): VerticalVersion =>
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
        outbound: outboundOfManifestJson(r.manifest_json),
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
        throw new Error(`unknown org ${id} in tenant ${tenant}`);
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
      const before = await this.cp.transitionScope(tenantId, scopeId, from, to, action);
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
          `${entity.entityType}:${entity.entityId}`,
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
     * #1666: move one module's schedule switch on one scope — see `HostAdmin.revokeFromSystem`.
     *
     * Where the write lands is the whole point of the delegation branch. The shared control
     * plane's own `SCOPE` namespace is the module-less placeholder, so a hosted scope's
     * switch has to be moved in the deployment serving it; writing it here would report a
     * switch pulled while every schedule kept firing. The audit row is written HERE either
     * way — the deployment's host is CP-less, and its `recordAdmin` is a no-op.
     */
    /**
     * #1706: move one PEER's kill switch on one scope — see `HostAdmin.revokeFromPeer`. The
     * schedule switch's audit discipline (intent first, outcome after, every attempt). Reaches
     * the scope's own ScopeDO; on the SHARED control plane a scope served by a vertical's own
     * deployment is refused `unavailable` (`peerScopeGate`) until the verb is delegated there.
     */
    const switchPeerAt = async (
      actor: PlatformActorId,
      raw: PeerSwitch,
      to: 'on' | 'off',
    ): Promise<PeerSwitchResult> => {
      const input = peerSwitch.parse(raw);
      const { tenantId, scopeId } = input.node;
      let vertical: string | null = null;
      if (!this.cpLess) {
        const rec = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!rec) throw substratError('not_found', `unknown scope for tenant: (${tenantId}, ${scopeId})`);
        vertical = rec.vertical;
      }
      await this.peerScopeGate(tenantId, scopeId, to === 'off' ? 'revokeFromPeer' : 'restoreToPeer');
      const operationId = ulid();
      const action = to === 'off' ? 'revokeFromPeer' : 'restoreToPeer';
      const target = { tenantId, scopeId, vertical };
      const base = { operationId, vertical: input.vertical, calls: to };
      await this.recordAdmin(actor, action, target, null, { ...base, phase: 'intent', reason: input.reason });
      let outcome: SwitchOutcome;
      try {
        outcome = await this.scopeStub(scopeId).switchPeer(input.vertical, scopeId, to, new Date().toISOString());
      } catch (err) {
        await this.recordAdmin(actor, action, target, null, {
          ...base,
          phase: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined);
        throw err;
      }
      await this.recordAdmin(actor, action, target, null, {
        ...base,
        phase: outcome.held ? 'applied' : 'refused',
        changed: outcome.changed,
        permissions: outcome.permissions,
      });
      if (!outcome.held) {
        throw substratError(
          'not_found',
          `scope ${scopeId} holds no grant for peer '${input.vertical}' — nothing to switch ${to} ` +
            `(check the slug: it is the calling vertical's registry id, as the target's \`peers\` names it)`,
        );
      }
      return {
        operationId,
        vertical: input.vertical,
        calls: to,
        changed: outcome.changed,
        permissions: outcome.permissions as PermissionKey[],
      };
    };

    const switchSystem = async (
      actor: PlatformActorId,
      raw: SystemSwitch,
      to: 'on' | 'off',
    ): Promise<SystemSwitchResult> => {
      const input = systemSwitch.parse(raw);
      const { tenantId, scopeId } = input.node;
      let vertical: string | null = null;
      if (!this.cpLess) {
        const rec = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!rec) throw substratError('not_found', `unknown scope for tenant: (${tenantId}, ${scopeId})`);
        vertical = rec.vertical;
      }
      // AUDIT FIRST (#1666 review): the intent row lands before anything moves, and the
      // outcome row after — every attempt, a repeat included. The scope's store and the
      // admin log are separate, so no order makes the pair atomic; this one fails toward
      // "an intent with no recorded outcome" and never toward "a switch that moved with no
      // audit row". A retry after a crash re-audits even though it answers `changed: false`.
      const operationId = ulid();
      const action = to === 'off' ? 'revokeFromSystem' : 'restoreToSystem';
      const target = { tenantId, scopeId, vertical };
      const base = { operationId, moduleId: input.moduleId, schedules: to };
      await this.recordAdmin(actor, action, target, null, { ...base, phase: 'intent', reason: input.reason });
      // A scope bound to no vertical (#1666 review) has no deployment to delegate to: its
      // store is the DO here, so the switch moves (or answers `held: false`) here too.
      // Delegating it would throw "no deployment serving scope" instead. A scope WITH a
      // vertical still delegates, and still fails loudly when none serves it.
      const delegation = this.cpLess || vertical !== null ? this.systemSwitchDelegation : undefined;
      let outcome: SwitchOutcome;
      try {
        outcome = delegation
          ? await delegation.switch({ tenantId, scopeId, moduleId: input.moduleId, to })
          : await this.scopeStub(scopeId).switchSystemSchedules(input.moduleId, scopeId, to, new Date().toISOString());
      } catch (err) {
        // Best effort: the original error is what the caller must see, and the intent row
        // already says an attempt was made.
        await this.recordAdmin(actor, action, target, null, {
          ...base,
          phase: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined);
        throw err;
      }
      await this.recordAdmin(actor, action, target, null, {
        ...base,
        phase: outcome.held ? 'applied' : 'refused',
        changed: outcome.changed,
        permissions: outcome.permissions,
      });
      if (!outcome.held) {
        throw substratError(
          'not_found',
          `scope ${scopeId} holds no system grant for module '${input.moduleId}' — nothing to switch ${to} ` +
            `(check the module id: it is the module's manifest id, e.g. '@substrat-run/engine-absence')`,
        );
      }
      return {
        operationId,
        moduleId: input.moduleId,
        schedules: to,
        changed: outcome.changed,
        permissions: outcome.permissions as PermissionKey[],
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
    const lastSwitchedOff = async (
      tenantId: TenantId,
      scopeId: ScopeId,
      moduleIds: Set<string>,
    ): Promise<Map<string, { actor: PlatformActorId; reason: string; at: Instant }>> => {
      // `order: 'desc'` is load-bearing: the loop below takes the FIRST intent it sees per
      // module as the latest one, and `auditLog`'s own default is 'asc' (oldest first).
      const rows = await this.cp.auditLog({ tenantId, scopeId, action: ['revokeFromSystem'], order: 'desc' });
      const appliedOps = new Set<string>();
      for (const row of rows) {
        const payload = row.after as { phase?: string; operationId?: string } | null;
        if (payload?.phase === 'applied' && payload.operationId) appliedOps.add(payload.operationId);
      }
      const result = new Map<string, { actor: PlatformActorId; reason: string; at: Instant }>();
      for (const row of rows) {
        if (result.size === moduleIds.size) break;
        const payload = row.after as
          | { phase?: string; operationId?: string; moduleId?: string; reason?: string }
          | null;
        if (!payload || payload.phase !== 'intent' || !payload.operationId || !payload.moduleId) continue;
        if (!moduleIds.has(payload.moduleId) || result.has(payload.moduleId)) continue;
        if (!appliedOps.has(payload.operationId) || typeof payload.reason !== 'string') continue;
        result.set(payload.moduleId, { actor: row.actor, reason: payload.reason, at: row.at });
      }
      return result;
    };

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
        if (!rec) throw substratError('not_found', `unknown scope for tenant: (${tenantId}, ${scopeId})`);
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
      const states = delegation
        ? await delegation.status({ tenantId, scopeId })
        : systemScheduleEntry.array().parse(await this.scopeStub(scopeId).systemGrantsStatus());
      const offModules = new Set(states.filter((s) => s.schedules === 'off').map((s) => s.moduleId as string));
      const explanations =
        offModules.size > 0
          ? await lastSwitchedOff(tenantId, scopeId, offModules)
          : new Map<string, { actor: PlatformActorId; reason: string; at: Instant }>();
      const result = states.map((s) => ({
        moduleId: s.moduleId,
        schedules: s.schedules,
        switchedOff: explanations.get(s.moduleId) ?? null,
      }));
      // K-24: reading the switch's position and any live incident reason is itself
      // access-logged, the same as every other HostAdmin read.
      await this.recordAccess(actor, 'systemGrantsStatus', { tenantId, scopeId }, null, result.length);
      return result;
    };

    return {
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
        const subject = `principal:${assignment.principalId}`;
        const relation = `role:${assignment.roleKey}`;
        const now = new Date().toISOString();
        const changed = assignment.node.scopeId
          ? await this.scopeStub(assignment.node.scopeId).revokeTuple(subject, relation, `scope:${assignment.node.scopeId}`, now)
          : await this.cp.revokeTenantTuple(assignment.node.tenantId, subject, relation, `tenant:${assignment.node.tenantId}`, now);
        if (!changed) return;
        await this.recordAdmin(
          actor,
          'unassignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          assignment,
          null,
        );
        // A tenant-level revoke changes the projected set — the tombstone must reach scopes.
        if (!assignment.node.scopeId) await this.fanOut(assignment.node.tenantId);
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
            throw new Error(`unknown scope ${grant.node.scopeId} in tenant ${grant.node.tenantId}`);
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
          await writeGrant(
            subjectRef({ kind: 'system', id: grant.moduleId }),
            grant.permission,
            grant.node,
            undefined,
            grant.expiresAt,
          );
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
      revokeFromPeer: async (actor: PlatformActorId, raw: PeerSwitch) => switchPeerAt(actor, raw, 'off'),
      restoreToPeer: async (actor: PlatformActorId, raw: PeerSwitch) => switchPeerAt(actor, raw, 'on'),
      revokeFromSystem: async (actor: PlatformActorId, raw: SystemSwitch) => switchSystem(actor, raw, 'off'),
      restoreToSystem: async (actor: PlatformActorId, raw: SystemSwitch) => switchSystem(actor, raw, 'on'),
      // #1674: the switch's status read — same gate, same delegation, and (unlike the
      // deployment it may delegate to) the admin log to explain an `off` entry.
      systemGrantsStatus: systemGrantsStatusOf,
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
        await this.cp.validateScopeAccess(tenantId, scopeId);
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
          throw new Error(`unknown scope ${parsed.scopeId} in tenant ${parsed.tenantId}`);
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
          throw new Error(`hostname '${parsed.hostname}' is already bound to another scope`);
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
        if (!row) throw new Error(`unknown hostname '${hostname}'`);
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
        if (!row) throw new Error(`unknown hostname '${hostname}'`);
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
            throw new Error(
              `vertical '${parsed.slug}' is owned by ${existing.owner_tenant ?? 'the platform'}, not ${parsed.ownerTenant ?? 'the platform'}`,
            );
          }
          throw new Error(`vertical '${parsed.slug}' is already registered as ${existing.source}`);
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
        await this.cp.insertVersion({
          ...audited,
          manifestJson: manifestJson ?? null,
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
        return rows.map(mapVersion);
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
            throw new Error(
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
      rejectVersion: async (actor, versionId: string, note: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw substratError('not_found', `unknown version ${versionId}`);
        if (v.admission === 'admitted') {
          throw new Error(`version ${versionId} is already admitted — it may be bound`);
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
          throw new Error(`version ${versionId} belongs to '${incoming.vertical_slug}'`);
        }
        if (incoming.admission !== 'admitted') {
          throw new Error(
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
            throw new Error(
              `promotion changes the permission surface (${outgoing.permission_digest} → ` +
                `${incoming.permission_digest}) — acknowledge it explicitly to promote`,
            );
          }
          if (outgoing.migration_digest !== incoming.migration_digest && !ack.migrationChange) {
            throw new Error(
              `promotion changes migrations (${outgoing.migration_digest} → ` +
                `${incoming.migration_digest}) — acknowledge it explicitly to promote`,
            );
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
        // forks (forked_from set) keep their frontier untouched, and a rebind that
        // crosses a migration digest snapshots first (fork-before-promote, §4).
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
            ).filter((s) => !s.forked_from);
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
      bindScopeVersion: async (actor, tenantId, scopeId, versionId: string, opts) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw substratError('not_found', `unknown version ${versionId}`);
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        // The refusal the registry exists for — but scoped to a SERVING bind. Admission
        // gates code reaching an install; a PREVIEW fork is the builder's own tenant's data
        // at a non-canonical URL, serving no install, so it may run pending PR code — the
        // same own-tenant blast radius that lets a private vertical self-admit. This is what
        // lets a LISTED vertical's builder still preview their own new code (marketplace-publish.md
        // §2; issue #509 ask (d)). Every other scope kind keeps the refusal.
        if (v.admission !== 'admitted' && scope.kind !== 'preview') {
          throw new Error(
            `version ${versionId} is ${v.admission}, not admitted — it cannot be bound to a scope`,
          );
        }
        // Fork-before-promote (§4): snapshot the pre-migration data if this rebind
        // crosses a migration boundary. Gated on a real digest change and on opt-in.
        if (opts?.snapshot && scope.vertical_version_id) {
          const outgoing = await this.cp.readVersion(scope.vertical_version_id);
          if (outgoing && outgoing.migration_digest !== v.migration_digest) {
            await this.snapshotScope(actor, tenantId, scopeId);
          }
        }
        await this.cp.bindScopeVersion(scopeId, versionId, v.vertical_slug);
        await this.recordAdmin(actor, 'bindScopeVersion', { tenantId, scopeId }, null, {
          versionId, vertical: v.vertical_slug, version: v.version,
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
      markScopeProvisioned: async (actor, tenantId, scopeId, versionId: string) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
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
      setScopeServingRef: async (actor, tenantId, scopeId, servingRef) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        await this.cp.setScopeServingRef(scopeId, servingRef);
        await this.recordAdmin(
          actor,
          'setScopeServingRef',
          { tenantId, scopeId },
          { servingRef: scope.serving_ref ?? null },
          { servingRef },
        );
      },
      setScopeExpiresAt: async (actor, tenantId, scopeId, expiresAt) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
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
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        const applied = await this.scopeStub(scopeId).appliedMigrations();
        await this.recordAccess(actor, 'scopeAppliedMigrations', { tenantId, scopeId }, null, applied.length);
        return applied;
      },
      scopeMigrationBookmarks: async (actor, tenantId, scopeId) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
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
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
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
        return this.scopeStub(scopeId).rewindToBookmark(bookmark, { force: opts?.force });
      },
      createOrg: async (actor: PlatformActorId, input: CreateOrgInput) => {
        const parsed = createOrgInput.parse(input);
        const created = await this.cp.createOrg(
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
      addMember: async (actor, tenantId, principal, orgId) => {
        await requireOrg(tenantId, orgId);
        await this.cp.writeTenantTuple(
          tenantId,
          `principal:${principal}`,
          'member',
          `org:${orgId}`,
          null,
        );
        await this.recordAdmin(actor, 'addMember', { tenantId }, null, { principal, orgId });
        await this.fanOut(tenantId); // membership is a tenant-level tuple
      },
      removeMember: async (actor, tenantId, principal, orgId) => {
        await requireOrg(tenantId, orgId);
        // Tombstone (K-21), never DELETE. The DO reports whether anything changed
        // so a repeat revoke stays a silent no-op rather than a second audit row.
        const changed = await this.cp.revokeMember(
          tenantId,
          `principal:${principal}`,
          `org:${orgId}`,
          new Date().toISOString(),
        );
        if (!changed) return;
        await this.recordAdmin(actor, 'removeMember', { tenantId }, { principal, orgId }, null);
        await this.fanOut(tenantId); // the tombstone must reach the projections
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
          }),
        );
      },
      createTenant: async (actor, input: CreateTenantInput) => {
        const parsed = createTenantInput.parse(input);
        const created = await this.cp.createTenant(
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
        const before = await this.cp.setTenantStatus(tenantId, status);
        await this.recordAdmin(actor, 'setTenantStatus', { tenantId }, { status: before }, { status });
      },
      setTenantName: async (actor, tenantId, name: string) => {
        const before = await this.cp.setTenantName(tenantId, name);
        if (before === name) return; // no-op is not audited — nothing changed
        await this.recordAdmin(actor, 'setTenantName', { tenantId }, { name: before }, { name });
      },
      reapTenant: async (actor, tenantId) => {
        // Directory-side terminal reap (§4.8). The caller reaped every scope's storage
        // first (archive-if-needed → reapScope in the vertical deployment); the DO clears
        // the tenant's PII/config rows and flips the row to a `reaped` tombstone, keeping
        // the row + admin log. Only a `deleting` tenant may be reaped (checked in the DO).
        const before = await this.cp.reapTenant(tenantId);
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
        await this.scopeRecordForRead(tenantId, scopeId);
        const batch = exportedBatch.parse(await this.scopeStub(scopeId).exportedEventsRead(input, tenantId, scopeId));
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
        await this.scopeRecordForRead(tenantId, scopeId);
        // Answered without waking the DO when this deployment imports nothing, which on a
        // sweep with the phase on is most scopes on most passes.
        if (this.crossVertical.consumes().length === 0) return { consumes: [], cursors: [] };
        const state = importState.parse(await this.scopeStub(scopeId).importStateRead());
        await this.recordAccess(actor, 'importState', { tenantId, scopeId }, null, state.cursors.length);
        return state;
      },
      readUndrainedEvents: async (actor, tenantId, scopeId, limit): Promise<UndrainedEvents> => {
        const record = await this.scopeRecordForRead(tenantId, scopeId);
        const bounded = Math.min(Math.max(limit ?? 200, 1), 1000);
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
        await this.recordAccess(actor, 'facetEvents', { tenantId, scopeId }, input, result.buckets.length);
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
      readScopeTable: async (
        actor,
        tenantId,
        scopeId,
        input: ReadScopeTableInput,
      ): Promise<ScopeTablePage> => {
        await this.scopeRecordForRead(tenantId, scopeId);
        const page = await this.scopeStub(scopeId).introspectTable(input.table, input.limit, input.offset);
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
        const result = await this.scopeStub(scopeId).introspectQuery(input.sql);
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
        if (!rec) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        if (rec.status !== 'archived') {
          throw new Error(
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
          throw new Error(
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
        const { events: eventsRedacted, intents: intentsRedacted, jobRuns: jobRunsRedacted } = redacted;
        const at = new Date().toISOString();
        const { existed } = await this.subjectKeysFor(tenantId, scopeId).destroy(subjectId, at);
        const receipt = subjectShredReceipt.parse({
          subjectId,
          eventsRedacted,
          intentsRedacted,
          jobRunsRedacted,
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
          eventsRedacted + intentsRedacted + jobRunsRedacted,
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
        const created = await this.cp.registerIdentityPool(
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
        if (!r) throw new Error(`identity pool '${provider}' is not registered`);
        if (r.topology !== 'central') {
          throw new Error(
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
        if (topology === null) throw new Error(`identity pool '${provider}' is not registered`);
        if (topology !== 'central') {
          throw new Error(
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
          throw new Error(
            `identity pool '${parsed.provider}' is not registered — a pool must declare ` +
              `its topology before it may link (central vs tenant-bound decides whether ` +
              `the same externalId in two tenants is one person or two)`,
          );
        }
        if (pool.topology === 'tenant-bound' && pool.tenant_id !== parsed.tenantId) {
          throw new Error(
            `identity pool '${parsed.provider}' is bound to tenant ${pool.tenant_id} and cannot link into ${parsed.tenantId}`,
          );
        }
        const changed = await this.cp.linkIdentity(
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
        const pruned = await this.cp.pruneAccessLog(limit);
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

  /**
   * Record a staff read (K-24). `params` is a bounded summary, capped so one query
   * cannot write an unbounded row.
   */
  /**
   * K-3's cross-check on its own: the (tenant, scope) pair must exist and agree before a
   * subject-key operation touches anything. Without it a caller could reach another
   * tenant's keys by naming their scope id.
   */
  private async assertScope(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    const rec = await this.cp.getScopeRecord(tenantId, scopeId);
    if (!rec) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
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
    if (!row) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    if (row.status === 'reaped') {
      throw new Error(`scope ${scopeId} is reaped — its storage is gone and cannot be read`);
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
    await this.cp.recordAdmin({
      id: ulid(),
      actor,
      action,
      tenantId: target.tenantId,
      causedBy: this.causedBy,
      scopeId: target.scopeId ?? null,
      vertical: target.vertical ?? null,
      before: before ?? null,
      after: after ?? null,
      at: new Date().toISOString(),
    });
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
    await this.cp.validateScopeAccess(tenantId, scopeId);
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
    subscribe: async ({ tenantId, scopeId, principal, request }) => {
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
       * Costs a CP-less vertical nothing: `validateScopeAccess` is a **no-op** on the
       * null control plane (the router already gated lifecycle and tenancy from the
       * shared directory), so this is the hosted-vertical shape unchanged.
       *
       * `migrateAndRecord`, not the DO's own `ensureMigrations`: the DO migrates
       * itself when the socket opens either way, but only this reports the applied
       * count to the directory — so a scope whose first contact after a deploy is a
       * subscription does not go dark in the migration fleet view.
       */
      await this.cp.validateScopeAccess(tenantId, scopeId);
      await this.migrateAndRecord(scopeId);
      // Asserted, not carried through from the client: the principal is the
      // vertical's own resolution of its session, and the tenant and scope are the
      // node the router resolved. Every inbound copy is replaced, for the reason the
      // router strips `x-substrat-*` before setting its own.
      const headers = new Headers(request.headers);
      headers.set(LIVE_PRINCIPAL_HEADER, principal);
      headers.set(LIVE_TENANT_HEADER, tenantId);
      headers.set(LIVE_SCOPE_HEADER, scopeId);
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
    const { roles, tuples, entitlements, identities } = await this.tenantProjection(tenantId);
    const scope = await this.cp.getScopeRecord(tenantId, scopeId);
    const connectionKeys = await this.connectionKeyRows(tenantId, scope?.vertical);
    await this.scopeStub(scopeId).applyProjection(
      tenantId,
      roles,
      tuples,
      entitlements,
      undefined,
      identities,
      connectionKeys,
    );
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
    await Promise.all(
      scopes.map(async (s) => {
        const vertical = s.vertical ?? '';
        if (!keysByVertical.has(vertical)) {
          keysByVertical.set(vertical, this.connectionKeyRows(tenantId, s.vertical));
        }
        await this.scopeStub(s.scope_id as ScopeId).applyProjection(
          tenantId,
          roles,
          tuples,
          entitlements,
          undefined,
          identities,
          await keysByVertical.get(vertical),
        );
      }),
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
  }): Promise<void> {
    const stub = this.scopeStub(input.scopeId);
    await this.migrateAndRecord(input.scopeId); // create the module tables (setMigrationState no-ops on a null CP)
    await stub.applyProjection(
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
    );
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
   *   before unseating the owner, and the revoke stands. The owner re-seated is the one `owner_of_record` names, which is first-write-
   *   wins — if a successor is later revoked too, the ORIGINAL owner comes back. To lock a
   *   compromised owner out, suspend the scope; a seat revoke is not that lever.
   * - An explicit grant does clear it: `assignScopeRole` is `INSERT OR REPLACE`, and so is
   *   a vertical's `onProvision` hook that re-issues it — which re-seats whatever it names
   *   on every reconcile. Revoke the seats your own flow granted and does not re-grant.
   * On a CP-less host this records no admin-log row (there is no control plane to hold
   * one), so the row's `revoked_at` is the only evidence, and a re-assign replaces it.
   */
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
      `${entity.entityType}:${entity.entityId}`,
      null,
    );
  }

  // -- the connector write-back's far end (#574) -----------------------------
  // A CP-less dispatch vertical cannot run a connector, so the shared control
  // plane runs the pass FOR it and reaches back through the platform-secret-gated
  // `/internal/connector-*` surface — these are that surface's host methods. The
  // directory gates (live connection, tenant/vertical match) ran on the platform
  // side before the call; what runs HERE is the half only this deployment can
  // enforce: the scope's own permission check against its delivered
  // `connection:<id>` tuple, in the scope's own DO. Fail closed — no grant, no
  // effect — exactly as for any other caller.

  /** Invoke ONE operation in this deployment as a CONNECTION (#574). */
  async connectorInvokeLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: string,
    input?: unknown,
  ): Promise<unknown> {
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

  /**
   * The far end of the schedule kill switch for a scope served HERE (#1666):
   * `/internal/system-switch` lands on this, from the shared control plane's
   * `revokeFromSystem` / `restoreToSystem`. It moves the switch in the scope's own DO and
   * answers what it did; it audits nothing, because the control plane that asked holds the
   * admin log and writes the row once this returns. `held: false` is an answer, not a
   * throw — see `systemSwitchOutcome`.
   */
  async systemSwitchLocal(scopeId: ScopeId, moduleId: ModuleId, to: 'on' | 'off'): Promise<SystemSwitchOutcome> {
    // Parsed on the way out: this is the wire answer the platform reads, and the DO's
    // plain strings become the published shape here rather than on trust.
    return systemSwitchOutcome.parse(
      await this.scopeStub(scopeId).switchSystemSchedules(moduleId, scopeId, to, new Date().toISOString()),
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
   */
  async peerSwitchLocal(scopeId: ScopeId, vertical: string, to: 'on' | 'off'): Promise<PeerSwitchOutcome> {
    return peerSwitchOutcome.parse(
      await this.scopeStub(scopeId).switchPeer(verticalSlug.parse(vertical), scopeId, to, new Date().toISOString()),
    );
  }
}

/** SHA-256 hex of an attachment's bytes — what `AttachmentRecord.sha256` holds. */
async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
