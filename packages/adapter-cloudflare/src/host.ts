import {
  accessLogEntry,
  adminLogEntry,
  opsFailureEntry,
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
  connectionGrant,
  connectionGrantRecord,
  connectionSecret,
  systemGrant,
  entitlementGrant,
  entitlementGrantInput,
  instant,
  meterReading,
  subjectRef,
  createConnectionInput,
  moduleManifest,
  org as orgSchema,
  orgMembership,
  resolvedIdentity,
  roleDefinition,
  scope as scopeSchema,
  tenant as tenantSchema,
  tenantRole,
  type AdminAction,
  type Connection,
  type ConnectionFilter,
  type ConnectionGrant,
  type ConnectionId,
  type ConnectionSecret,
  type ModuleId,
  type ScheduleSpec,
  type SystemGrant,
  type CreateConnectionInput,
  type AccessLogEntry,
  type AdminLogEntry,
  type OpsFailureEntry,
  type CapabilityGrant,
  type CreateOrgInput,
  type CreateTenantInput,
  type DomainEvent,
  type EntitlementGrant,
  type EntityRef,
  type IdentityLink,
  type IdentityPool,
  type ListPage,
  type MeterReading,
  type ProjectedConnectionGrant,
  type ProjectedIdentityLink,
  type Node,
  type Org,
  type OrgId,
  type PermissionKey,
  type PlatformActorId,
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
  platformRequest,
  connectorDispatchKind,
  type ConnectorDispatchPayload,
  type PlatformRequest,
  type PlatformRequestFilter,
  type PlatformRequestId,
  type PlatformRequestStatus,
  type ScopeStatus,
  type ScopeTable,
  type ScopeQueryResult,
  type ScopeTablePage,
  type Tenant,
  type TenantId,
  type TenantRole,
  type TenantStatus,
  type TenantStoreHandle,
  outboundOfManifestJson,
} from '@substrat-run/contracts';
import { normalizeHostname, toRouteTarget } from './route-resolver.js';
import {
  attachmentBlobKey,
  entitlementDenial,
  foldMeterReading,
  parseValidationRecords,
  resolveScopeRecord,
  ulid,
  type AccessLogFilter,
  type AuditLogFilter,
  type OpsFailureFilter,
  type OpsFailureInput,
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
  type ScopeFilter,
  type ScopeHost,
  type ScopeStub,
  type ScopeStubOptions,
  type SqlValue,
  type TenantRelationalStore,
  type TenantStoreProvisionInput,
  type TenantStoreRecord,
} from '@substrat-run/kernel';
import { tenantStoreDatabaseName, type D1TenantStores } from './d1.js';
import { blobStoreBucketName, r2TenantBlobStore, type R2BlobStores } from './r2.js';
import type {
  AccessLogRow,
  AuditLogQuery,
  OpsFailureQuery,
  OpsFailureRow,
  ChannelHistoryRow,
  ChannelRow,
  ConnectionDoRow,
  ConnectionGrantDoRow,
  EntitlementRow,
  HostnameRow,
  OrgRow,
  RoleRow,
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
  recordConnectionUse(id: string, error: string | null, at: string): Promise<void>;
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
  resolveIdentity(
    tenantId: string,
    provider: string,
    externalId: string,
  ): Promise<{ principal: string; scopeId: string | null } | undefined>;
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

/** A raw `_substrat_platform_requests` row over the DO RPC — snake_case, JSON columns as strings. */
interface PlatformRequestRawRow {
  id: string;
  kind: string;
  payload: string;
  requested_by: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result: string | null;
  requested_at: string;
  settled_at: string | null;
}

/** Map a stored platform-request row to the `PlatformRequest` contract shape (JSON columns parsed). */
function rowToPlatformRequest(r: PlatformRequestRawRow): PlatformRequest {
  return platformRequest.parse({
    id: r.id,
    kind: r.kind,
    payload: JSON.parse(r.payload),
    requestedBy: JSON.parse(r.requested_by),
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    result: r.result === null ? null : JSON.parse(r.result),
    requestedAt: r.requested_at,
    settledAt: r.settled_at,
  });
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
  pendingExecutorEvents(deliveryId: string, eventType: string): Promise<DomainEvent[]>;
  recordExecutorAttempt(
    eventId: string,
    deliveryId: string,
    error: string | null,
    nextAttemptAt: string | null,
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
  ): Promise<void>;
  /** #574 phase 3: enqueue a `connector:<provider>` intent + journal the delivery, atomically. */
  routeExecutorEventToPlatform(
    eventId: string,
    deliveryId: string,
    kind: string,
    payload: string,
    requestedBy: string,
  ): Promise<PlatformRequestId>;
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
  ): Promise<{
    result: unknown;
    /** #458: platform intents this invoke enqueued — the coordinator's drain-hint feed. */
    platformRequests: number;
  }>;
  /** Whether this scope holds a live `system:<moduleId>` grant (#383) — the schedule switch. */
  hasSystemGrant(moduleId: string): Promise<boolean>;
  /** The last time a schedule's operation ran on this scope (#383), or null if never. */
  scheduleLastRun(operation: string): Promise<string | null>;
  /** Record a schedule run's timestamp + outcome (#383). */
  recordScheduleRun(operation: string, at: string, status: 'ok' | 'failed'): Promise<void>;
  writeTuple(
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
  ): Promise<AttachmentRecord | null>;
  attachmentRemove(
    attachmentId: string,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
  ): Promise<AttachmentRecord | null>;
  /** Scope-local projection (scope-local-permissions.md): replace the tenant's roles + tuples and flip to local.
   *  `entitlements` (#304) rides the same snapshot — preserve-on-undefined, so a role-only re-projection
   *  leaves projected entitlements untouched. */
  applyProjection(
    tenantId: string,
    roles: { role_key: string; permissions: string; source: string }[],
    tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[],
    entitlements?: { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[],
    /** Scope-level tuples (e.g. the owner grant) written in the same unit as the flip (#332). */
    scopeTuples?: { subject: string; relation: string; object: string; expires_at: string | null }[],
    /** The tenant's identity links (#406) — same preserve-on-undefined convention as entitlements. */
    identities?: { provider: string; external_id: string; principal_id: string; scope_id: string | null }[],
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
  /** Complete logical dump of this scope's DB (preview-and-snapshots.md §3). */
  exportDump(): Promise<ScopeDumpTable[]>;
  /**
   * Load a dump into this (freshly-provisioned) scope — the fork write side.
   * `destScopeId` re-points the dump's scope-level grants at the destination.
   */
  importDump(tables: ScopeDumpTable[], destScopeId?: ScopeId): Promise<void>;
  /** Wipe this scope's storage — the reap half of deleteSnapshot (§9). */
  destroyStorage(): Promise<void>;
  /** Null the spine payloads keyed to one data subject (#37); returns how many moved. */
  redactSubject(subjectId: string): Promise<number>;
  /** PITR bookmarks recorded before migration passes (#286), newest first. */
  migrationBookmarks(limit?: number): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]>;
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

export interface CloudflareScopeHostOptions {
  scope: DurableObjectNamespace;
  /**
   * The shared directory DO. Optional: a **CP-less** vertical (docs/design/scope-
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
   * Scope-local permissions (docs/design/scope-local-permissions.md, Phase 2). When
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
                `(docs/design/scope-local-permissions.md, Phase 3)`,
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
  /** Module id → its declared recurring schedules (#383), for `registeredSchedules`/`runDueSchedules`. */
  private readonly moduleSchedules = new Map<string, ScheduleSpec[]>();
  /** Registered (module, version) pairs — the frontier `schemaVersion` counts toward (§5.3, #49). */
  private migrationTotal = 0;
  private readonly operations = new Set<string>();
  private readonly predicateNames = new Map<string, string>(); // name → module
  /** Executor id → {eventType, handler} (K-22 §4.2). Coordinator-side, not in the DO. */
  private readonly secretBox: SecretBox;
  private readonly fetchImpl: FetchLike;
  /** The live D1 client for per-tenant stores (#301); undefined ⇒ refuse loudly. */
  private readonly tenantStores?: D1TenantStores;
  /** The live R2 client for per-tenant blob stores (#473); undefined ⇒ refuse loudly. */
  private readonly blobStores?: R2BlobStores;
  /** Worker-side attachment-bucket resolver (#473); undefined ⇒ attachments() refuses. */
  private readonly attachmentBuckets?: (tenantId: string) => unknown | null | Promise<unknown | null>;
  private readonly executors = new Map<string, RegisteredEffector>();
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
    this.fetchImpl = options.fetch ?? ((input, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(input, init));
    this.scopeLocalPermissions = options.scopeLocalPermissions ?? false;
    this.scopeNs = options.scope;
    this.cpLess = !options.controlPlane;
    this.cp = options.controlPlane
      ? (options.controlPlane.get(options.controlPlane.idFromName('control-plane')) as unknown as ControlPlaneStub)
      : nullControlPlane();
    this.connectorDelegation = options.connectorDelegation;
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
          openAttachment: (attachmentId: string) =>
            this.getConnectorAttachments(open.id, scopeId).then((a) => a.open(attachmentId)),
          fetch: async (input, init) => {
            try {
              const res = await fetchImpl(input, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs),
              });
              await admin.recordConnectionUse(
                open.id,
                res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status} from ${provider}` },
              );
              return res;
            } catch (err) {
              await admin.recordConnectionUse(open.id, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
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
      const events = await stub.pendingExecutorEvents(deliveryId, executor.eventType);
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
            );
            report.routedToPlatform! += 1;
          } else if (executor.kind === 'connector') {
            await executor.handler(
              await this.connectorContext(tenantId, scopeId, executor.timeoutMs),
              event,
            );
            await stub.recordExecutorAttempt(event.id, deliveryId, null, null);
            report.delivered += 1;
          } else {
            await executor.handler(this.admin, event);
            await stub.recordExecutorAttempt(event.id, deliveryId, null, null);
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
    return this.drainExecutors(tenantId, scopeId);
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
        await this.connectorContext(tenantId, scopeId, options?.timeoutMs ?? 30_000),
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

  async listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return (await this.scopeStub(scopeId).pendingPlatformRequests()).map(rowToPlatformRequest);
  }

  async listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return (await this.scopeStub(scopeId).platformRequestHistory(filter)).map(rowToPlatformRequest);
  }

  async settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: { status: PlatformRequestStatus; result?: unknown; lastError?: string | null },
  ): Promise<void> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    await this.scopeStub(scopeId).settlePlatformRequest(
      id,
      outcome.status,
      outcome.result === undefined ? null : JSON.stringify(outcome.result),
      outcome.lastError ?? null,
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
    const declaredConsumes = new Set(manifest.events.consumes.map((c) => c.type));
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
    this.moduleIds.add(manifest.id);
    if (manifest.schedules && manifest.schedules.length > 0) {
      this.moduleSchedules.set(manifest.id, manifest.schedules);
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
    // grant and connection grants land. Idempotent, so a re-provision re-asserts them.
    for (const [moduleId, schedules] of this.moduleSchedules) {
      const perms = new Set<string>();
      for (const s of schedules) for (const p of s.permissions) perms.add(p);
      for (const perm of perms) {
        await this.scopeStub(input.scopeId).writeTuple(
          `system:${moduleId}`,
          `granted:${perm}`,
          `scope:${input.scopeId}`,
          null,
        );
      }
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

  /** The injected D1 client, or a loud refusal naming what to configure. */
  private requireTenantStores(what: string): D1TenantStores {
    if (!this.tenantStores) {
      throw new Error(
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

  /** The injected R2 client, or a loud refusal naming what to configure. */
  private requireBlobStores(what: string): R2BlobStores {
    if (!this.blobStores) {
      throw new Error(
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
          }),
        list: notDelegated('list'),
        remove: notDelegated('remove'),
      };
    }
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(conn.tenant_id as TenantId);
    return this.buildAttachmentSurface({ connectionId }, conn.tenant_id as TenantId, scopeId, store);
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
    subject: { principal: PrincipalId } | { connectionId: ConnectionId },
    tenantId: TenantId,
    scopeId: ScopeId,
    store: TenantBlobStore,
  ): ScopeAttachments {
    const connectionId = 'connectionId' in subject ? subject.connectionId : undefined;
    const createdBy = 'principal' in subject ? subject.principal : subject.connectionId;
    // The DO needs SOME principal-shaped value for `ctx.principal`; for a connection it is
    // the connection id, and the honest attribution rides the event actor — the same trick
    // `buildStub` uses for the invoke path.
    const asPrincipalId = ('principal' in subject
      ? subject.principal
      : (subject.connectionId as unknown as PrincipalId)) as PrincipalId;
    const stub = this.scopeStub(scopeId);
    const sha256Hex = async (body: Uint8Array): Promise<string> => {
      const digest = await crypto.subtle.digest('SHA-256', body);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
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
        );
        if (!record) return null;
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

  registeredSchedules(): ScheduleRegistration[] {
    const out: ScheduleRegistration[] = [];
    for (const [moduleId, schedules] of this.moduleSchedules) {
      if (schedules.length > 0) out.push({ moduleId: moduleId as ModuleId, schedules });
    }
    return out;
  }

  async runDueSchedules(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScheduleRunReport> {
    const report: ScheduleRunReport = { fired: 0, skipped: 0, failed: 0, errors: [] };
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
    // The grant IS the switch (#383): run only where the scope holds a live
    // `system:<moduleId>` grant. Skips a foreign-vertical scope and a per-tenant
    // revoke quietly — no run, no error.
    if (!(await stub.hasSystemGrant(moduleId))) return report;
    const now = Date.now();
    for (const schedule of schedules) {
      const last = await stub.scheduleLastRun(schedule.operation);
      const lastRun = last ? Date.parse(last) : null;
      const dueAt = lastRun === null ? -Infinity : lastRun + schedule.cadence.everyMinutes * 60_000;
      if (now < dueAt) {
        report.skipped += 1;
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
      await stub.recordScheduleRun(schedule.operation, new Date(now).toISOString(), status);
    }
    return report;
  }

  /** The stub body, shared by the principal, connection, and system doors. */
  private buildStub(
    tenantId: TenantId,
    scopeId: ScopeId,
    principal?: PrincipalId,
    connectionId?: ConnectionId,
    systemModuleId?: string,
    options?: ScopeStubOptions,
  ): ScopeStub {
    const stub = this.scopeStub(scopeId);
    const cp = this.cp;
    const operationEntitlement = this.operationEntitlement;
    // The DO needs SOME principal-shaped value for `ctx.principal`; for a
    // connection it is the connection id, for a schedule the module id, and the
    // honest attribution rides on the event actor instead.
    const asPrincipalId = (principal ??
      (connectionId as unknown as PrincipalId) ??
      (systemModuleId as unknown as PrincipalId)) as PrincipalId;

    return {
      tenantId,
      scopeId,
      invoke: async <O, I>(operation: string, input?: I): Promise<O> => {
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
            new Error(
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
        const envelope = await stub.invoke(
          operation,
          input,
          asPrincipalId,
          tenantId,
          scopeId,
          connectionId,
          requiredKey,
          systemModuleId,
        );
        const drained = await this.drainExecutors(tenantId, scopeId);
        // #458: the operation committed having enqueued platform intents — tell the
        // caller's harness so it can flag the response for the router kick (#381).
        // Routed connector deliveries (#574 phase 3) count too: the inline drain just
        // turned this operation's event into a `connector:<provider>` intent, and the
        // kick is what collapses its dispatch latency from sweep-cadence to seconds.
        const enqueued = envelope.platformRequests + (drained.routedToPlatform ?? 0);
        if (enqueued > 0) options?.onPlatformRequests?.(enqueued);
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
      grant: async (actor, grant: CapabilityGrant) => {
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
        await writeGrant(
          subjectRef({ kind: 'system', id: grant.moduleId }),
          grant.permission,
          grant.node,
          undefined,
          grant.expiresAt,
        );
        await this.recordAdmin(
          actor,
          'grantToSystem',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          { moduleId: grant.moduleId, permission: grant.permission, node: grant.node },
        );
        if (!grant.node.scopeId) await this.fanOut(grant.node.tenantId);
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
        const holderStatus = (existing as { scope_status?: string } | undefined)?.scope_status;
        const holderReleased = holderStatus === 'archived' || holderStatus === 'reaped';
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
      resolveHostname: async (raw: string) =>
        // The router's per-request read. No actor, not logged — the same machine-path
        // carve-out resolveIdentity has (K-24). Shares its mapping with the router's
        // own resolver so the two cannot disagree on what resolves.
        toRouteTarget(await this.cp.readHostname(normalizeHostname(raw))),
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
          throw new Error(`unknown vertical '${parsed.verticalSlug}'`);
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
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
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
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        await this.cp.updateVerticalPublishRequest(slug, new Date().toISOString());
        await this.recordAdmin(actor, 'requestPublish', { tenantId: null }, null, { slug });
      },
      setVerticalInstallsBlocked: async (actor, slug: string, blocked: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        await this.cp.updateVerticalInstallsBlocked(slug, blocked ? 1 : 0);
        await this.recordAdmin(actor, 'setVerticalInstallsBlocked', { tenantId: null }, { installsBlocked: !!existing.installs_blocked }, { installsBlocked: blocked });
      },
      setVerticalTenantProvisioner: async (actor, slug: string, granted: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        await this.cp.updateVerticalTenantProvisioner(slug, granted ? 1 : 0);
        await this.recordAdmin(actor, 'setVerticalTenantProvisioner', { tenantId: null }, { tenantProvisioner: !!existing.tenant_provisioner }, { tenantProvisioner: granted });
      },
      setVerticalEmailSender: async (actor, slug: string, granted: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        await this.cp.updateVerticalEmailSender(slug, granted ? 1 : 0);
        await this.recordAdmin(actor, 'setVerticalEmailSender', { tenantId: null }, { emailSender: !!existing.email_sender }, { emailSender: granted });
      },
      deleteVertical: async (actor, slug: string) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        // Refuse while any restorable scope is bound: a deleted registry row would strand
        // those scopes' version pins and routing. An `archived` scope (a deleted app) still
        // blocks — unarchive can bring it back — but the refusal names reap/restore, not
        // "delete", because the app itself is already gone. `reaped` is terminal history and
        // never blocks. Deployed dispatch scripts are NOT reaped here — they become orphans
        // for the cleanup script (#248).
        const bound = await this.cp.countScopesForVertical(slug);
        if (bound.live > 0) {
          throw new Error(
            `vertical '${slug}' still backs ${bound.live} scope(s) — delete or rebind them first`,
          );
        }
        if (bound.archived > 0) {
          throw new Error(
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
        if (!v) throw new Error(`unknown version ${versionId}`);
        if (v.admission === 'admitted') {
          // Idempotent — except an AUTO-admitted version, which this upgrades to a
          // manual vouch by clearing the note (what the publish seam requires).
          if (v.admission_note !== AUTO_ADMISSION_NOTE) return;
          await this.cp.setAdmission(versionId, 'admitted', null);
          await this.recordAdmin(actor, 'admitVersion', { tenantId: null }, { admission: v.admission, note: v.admission_note }, { admission: 'admitted', note: null });
          return;
        }
        if (v.admission === 'rejected') {
          throw new Error(`version ${versionId} was rejected — publish a new one`);
        }
        await this.cp.setAdmission(versionId, 'admitted', null);
        await this.recordAdmin(actor, 'admitVersion', { tenantId: null }, { admission: v.admission }, { admission: 'admitted' });
      },
      rejectVersion: async (actor, versionId: string, note: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw new Error(`unknown version ${versionId}`);
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
        if (!incoming) throw new Error(`unknown version ${versionId}`);
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
        if (!v) throw new Error(`unknown version ${versionId}`);
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
      verticalServing: async (actor, verticalSlug: string) => {
        const r = await this.cp.readVertical(verticalSlug);
        if (!r) throw new Error(`unknown vertical '${verticalSlug}'`);
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
        if (!r) throw new Error(`unknown vertical '${verticalSlug}'`);
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
          throw new Error(`unknown version ${versionId} for vertical '${verticalSlug}'`);
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
      scopeMigrationBookmarks: async (actor, tenantId, scopeId) => {
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        const bookmarks = await this.scopeStub(scopeId).migrationBookmarks();
        await this.recordAccess(actor, 'scopeMigrationBookmarks', { tenantId, scopeId }, null, bookmarks.length);
        return bookmarks;
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
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!row) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
        const tables = await this.scopeStub(scopeId).introspectTables();
        await this.recordAccess(actor, 'listScopeTables', { tenantId, scopeId }, null, tables.length);
        return tables;
      },
      readScopeTable: async (
        actor,
        tenantId,
        scopeId,
        input: ReadScopeTableInput,
      ): Promise<ScopeTablePage> => {
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!row) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
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
      queryScope: async (
        actor,
        tenantId,
        scopeId,
        input: QueryScopeInput,
      ): Promise<ScopeQueryResult> => {
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!row) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
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
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!row) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
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
      unarchiveScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unarchiveScope', tenantId, scopeId, ['archived'], 'active'),
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
        const eventsRedacted = await this.scopeStub(scopeId).redactSubject(subjectId);
        const at = new Date().toISOString();
        const { existed } = await this.subjectKeysFor(tenantId, scopeId).destroy(subjectId, at);
        const receipt = subjectShredReceipt.parse({
          subjectId,
          eventsRedacted,
          keyDestroyed: existed,
          tombstoned: true,
        });
        // BOTH logs, deliberately: the admin log because this is a mutation, the access log
        // because it destroys evidence. An erasure is the one action where "who asked for
        // this to disappear" is itself part of the record.
        await this.recordAdmin(actor, 'shredSubject', { tenantId, scopeId }, null, receipt);
        await this.recordAccess(actor, 'shredSubject', { tenantId, scopeId }, { subjectId }, eventsRedacted);
        return receipt;
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

      recordConnectionUse: async (
        id: ConnectionId,
        outcome: { ok: true } | { ok: false; error: string },
      ) => {
        await this.cp.recordConnectionUse(
          id,
          outcome.ok ? null : outcome.error,
          new Date().toISOString(),
        );
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
          status: entry.status ?? null,
          // Bounded here, not trusted from the catch site: one runaway upstream body
          // must not become a runaway directory row (#559).
          message: entry.message.slice(0, 2000),
          reference: entry.reference ?? null,
          at: new Date().toISOString(),
        });
      },
      listOpsFailures: async (actor, filter?: OpsFailureFilter): Promise<OpsFailureEntry[]> => {
        const rows = await this.cp.listOpsFailures({
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
          vertical: filter?.vertical,
          operation: filter?.operation,
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

  private async writeScopeTuple(
    scopeId: ScopeId,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void> {
    await this.scopeStub(scopeId).writeTuple(subject, relation, object, expiresAt);
  }

  private scopeStub(scopeId: ScopeId): ScopeStubRpc {
    // Deterministic DO id in milestone 1. Production mints per-jurisdiction ids
    // via newUniqueId (K-7) and stores the mapping in the directory — deferred.
    return this.scopeNs.get(this.scopeNs.idFromName(scopeId)) as unknown as ScopeStubRpc;
  }

  // -- scope-local projection (docs/design/scope-local-permissions.md, Phase 2) --
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

  /** Project the tenant's current state into ONE scope + flip it to local. */
  private async projectScope(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    if (!this.scopeLocalPermissions) return;
    const { roles, tuples, entitlements, identities } = await this.tenantProjection(tenantId);
    await this.scopeStub(scopeId).applyProjection(tenantId, roles, tuples, entitlements, undefined, identities);
  }

  /**
   * Fan the tenant's current state out into ALL its scopes — called after any
   * tenant-level write so every projected scope converges. A dropped fan-out is
   * repaired by `reconcileTenantProjection` (the reconciliation sweep, §5/§9).
   */
  private async fanOut(tenantId: TenantId): Promise<void> {
    if (!this.scopeLocalPermissions) return;
    const { roles, tuples, entitlements, identities } = await this.tenantProjection(tenantId);
    const scopes = await this.cp.listScopes({ tenantId });
    await Promise.all(
      scopes.map((s) =>
        this.scopeStub(s.scope_id as ScopeId).applyProjection(tenantId, roles, tuples, entitlements, undefined, identities),
      ),
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
      [
        {
          subject: `principal:${input.owner}`,
          relation: `role:${input.ownerRoleKey}`,
          object: `scope:${input.scopeId}`,
          expires_at: null,
        },
        // #461: each registered module's SCHEDULE grants (#383) ride the same unit —
        // the CP-less mirror of `provisionScope`'s writeTuple loop. Without them the
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
  ): Promise<OpenedAttachment | null> {
    await this.migrateAndRecord(scopeId);
    const store = await this.resolveAttachmentStore(tenantId);
    return this.buildAttachmentSurface({ connectionId }, tenantId, scopeId, store).open(
      attachmentId,
    );
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
}
