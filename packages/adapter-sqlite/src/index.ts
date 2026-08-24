import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  accessLogEntry,
  adminLogEntry,
  opsFailureEntry,
  ATTACHMENT_ADDED,
  ATTACHMENT_REMOVED,
  attachmentRecord,
  type AttachmentRecord,
  type BlobStoreHandle,
  createTenantInput,
  domainEvent,
  domainEventInput,
  entitlementGrant,
  entitlementGrantInput,
  eventId,
  meterReading,
  platformRequestInput,
  platformRequestId,
  platformRequest,
  MAX_PENDING_PLATFORM_REQUESTS,
  identityLink,
  identityPool,
  instant,
  connection,
  connectionGrant,
  connectionGrantRecord,
  connectionSecret,
  systemGrant,
  subjectRef,
  createConnectionInput,
  projectedConnectionGrant,
  projectedConnectionKey,
  moduleManifest,
  createOrgInput,
  promotionAcknowledgement,
  bindHostnameInput,
  channelHistoryEntry,
  hostnameBinding,
  publishVersionInput,
  AUTO_ADMISSION_NOTE,
  routeTarget,
  registerVerticalInput,
  vertical as verticalSchema,
  verticalChannel,
  verticalVersion,
  objectRef,
  grantRefFromProof,
  org as orgSchema,
  orgMembership,
  principalId,
  resolvedIdentity,
  roleDefinition,
  scope as scopeSchema,
  tenant as tenantSchema,
  tenantRole,
  type AdminAction,
  type AccessLogEntry,
  type CheckSubject,
  type Connection,
  type ConnectionGrant,
  type ConnectionFilter,
  type ConnectionId,
  type ConnectionSecret,
  type CreateConnectionInput,
  type ModuleId,
  type ScheduleSpec,
  type SystemGrant,
  type AdminLogEntry,
  type OpsFailureEntry,
  type CapabilityGrant,
  type CreateTenantInput,
  type DomainEvent,
  type DomainEventInput,
  type EventAuthorization,
  type PlatformRequestInput,
  type PlatformRequestId,
  type PlatformRequest,
  type PlatformRequestFilter,
  type PlatformRequestStatus,
  type PlatformRequestFailure,
  type EntitlementGrant,
  type EntitlementGrantInput,
  type EntitlementView,
  type ProjectedConnectionGrant,
  type ProjectedConnectionKey,
  type EntityRef,
  type MeterReading,
  type CreateOrgInput,
  type IdentityLink,
  type IdentityPool,
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
  type ScopeId,
  subjectShredReceipt,
  type SubjectShredReceipt,
  type ScopeQueryResult,
  type ScopeStatus,
  type ScopeTable,
  type ScopeTablePage,
  type Tenant,
  type TenantId,
  type TenantRole,
  type TenantStatus,
  type TenantStoreHandle,
  type ListPage,
  SCOPE_TABLE_PAGE_DEFAULT,
  SCOPE_TABLE_PAGE_MAX,
  SCOPE_QUERY_ROW_MAX,
  verticalServingState,
  outboundOfManifestJson,
  listLimitOf,
} from '@substrat-run/contracts';
import {
  asPrincipal,
  assertAllowed,
  assertReadOnlyQuery,
  attachmentBlobKey,
  entitlementDenial,
  foldMeterReading,
  parseValidationRecords,
  resolveScopeRecord,
  ulid,
  OPS_FAILURE_RETENTION_DAYS,
  type AccessLogFilter,
  type AttachmentUploadInput,
  type AuditLogFilter,
  type OpsFailureFilter,
  type OpsFailureInput,
  type BlobStoreProvisionInput,
  type BlobStoreRecord,
  type OpenedAttachment,
  type ScopeAttachments,
  type TenantBlobStore,
  type ConsumerHandler,
  type ExecutorDeadLetter,
  type ExecutorDrainReport,
  type MigrateScopeOutcome,
  type MigrationFrontier,
  type ExecutorHandler,
  type ExecutorRetryPolicy,
  backoffAt,
  platformRequestHistoryQuery,
  PLATFORM_REQUEST_COLUMNS,
  resolveRetryPolicy,
  isSecretBoxConfigured,
  unconfiguredSecretBox,
  createSubjectKeys,
  generateSealingKeyPair,
  noSealingKeyMessage,
  openSealed,
  sealTo,
  ConnectionSealingKeyUnavailableError,
  type SubjectKeys,
  type ConnectorContext,
  type ConnectorHandler,
  type ConnectorOptions,
  type Clock,
  type FetchLike,
  type SecretBox,
  type GuardPredicate,
  type HostAdmin,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  PermissionDenied,
  type PermissionChecker,
  type ProvisionScopeInput,
  type RoleFilter,
  type ScheduleRegistration,
  type ScheduleRunReport,
  type ScopedSql,
  type ScopeFilter,
  type ScopeHost,
  type ScopeStub,
  type ScopeStubOptions,
  type SqlMigration,
  type SqlValue,
  type TenantRelationalStore,
  type TenantStoreProvisionInput,
  type TenantStoreRecord,
  createAtomic,
  type RunSub,
  NotSearchable,
  NotListable,
  listIndexMigrations,
  listIndexPlans,
  listQuery,
  cursorOf,
  type ListIndexPlan,
  type PageParams,
  isSearchIndexTable,
  searchIndexDdl,
  searchIndexMigrations,
  searchIndexPlans,
  searchLimit,
  searchMatchExpression,
  searchQuery,
  type SearchHit,
  type SearchIndexPlan,
  type SearchOptions,
} from '@substrat-run/kernel';
import { ScopeActor } from './actor.js';
import { createTupleChecker } from './checker.js';

interface ScopeRuntime {
  tenantId: TenantId;
  scopeId: ScopeId;
  db: Database.Database;
  actor: ScopeActor;
  appliedMigrations: Set<string>;
}

/** One `_substrat_attachments` row (#473), as SELECTed. */
interface AttachmentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  visibility: string;
  created_by: string;
  created_at: string;
}

interface RegisteredModule {
  id: string;
  migrations: SqlMigration[];
  consumers: { eventType: string; handler: ConsumerHandler }[];
  /** The module's declared recurring schedules (#383), empty if it declares none. */
  schedules: ScheduleSpec[];
}

/** A manifest guard, bound to the module whose manifest declared it (K-17). */
interface DeclaredGuard {
  predicate: string;
  config: Record<string, unknown>;
  declaredBy: string;
}

export interface SqliteScopeHostOptions {
  /** Directory holding one SQLite file per scope plus the directory database. */
  dir: string;
  /** Defaults to the built-in tuple checker (deny-by-default on empty tuples). */
  checker?: PermissionChecker;
  /**
   * Seals per-tenant credentials at rest (#101). Omitted, the host refuses to
   * store one at all rather than storing it in the clear — every other surface
   * keeps working, so a deployment that uses no connectors needs no key.
   */
  secretBox?: SecretBox;
  /**
   * Egress for connectors. Defaults to the runtime's `fetch`.
   *
   * Injectable so a test or a dev server can stand a provider up in memory —
   * which is the only way to exercise a connector end to end before real API
   * credentials exist, and remains the way to test failure paths a real
   * provider will not produce on demand.
   */
  fetch?: FetchLike;
  /**
   * What `ctx.now()` reads (#812). Defaults to the wall clock.
   *
   * The same seam as `fetch`, for the same reason: a scenario that needs an
   * absence window to lapse, a metering period to roll, or a booking hold to
   * expire cannot get there by waiting. Hand in a frozen or scripted clock and
   * the interesting case becomes assertable.
   */
  clock?: Clock;
}

const KERNEL_DDL = `
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
    -- NULL on rows written before the field existed — honestly unrecorded, not empty.
    authorization TEXT,
    drained_at TEXT
  );
  -- platform-intents.md: durable intents a vertical enqueues (ctx.requestPlatform) for the platform
  -- to drain and execute with HostAdmin authority — the sandbox-clean way a vertical asks for a
  -- privileged action. Written by the kernel (spine), settled by the platform drain.
  CREATE TABLE IF NOT EXISTS _substrat_platform_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    requested_by TEXT NOT NULL,
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
  -- recorded here OUTSIDE that transaction, on the deny path — the one event where an
  -- actor's intent and the permission model visibly disagree, and which no other log
  -- witnesses (the admin log records changes, the outbox records allowed mutations).
  -- Drains rather than expires (K-24's split): drained_at marks a shipped row.
  CREATE TABLE IF NOT EXISTS _substrat_denials (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    permission TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT,
    operation TEXT,
    at TEXT NOT NULL,
    drained_at TEXT
  );
  CREATE TABLE IF NOT EXISTS _substrat_migrations (
    module_id TEXT NOT NULL,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module_id, version)
  );
  CREATE TABLE IF NOT EXISTS _substrat_tuples (
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    -- K-21: revocation TOMBSTONES. The row stays and the walk skips it, because a
    -- tuple that once granted access is evidence of why an access was allowed
    -- (K-4) and D-32's compliance product has to produce that evidence.
    revoked_at TEXT,
    PRIMARY KEY (subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    -- For a TERMINAL row this is when it was delivered (or dead-lettered). For a
    -- row still retrying it is when it was last ATTEMPTED. The column predates
    -- retry state (#100) and is NOT NULL, so it carries both readings rather than
    -- forcing a table rebuild on every deployed scope.
    delivered_at TEXT NOT NULL,
    error TEXT,
    -- Retry state, executors only (#100). Consumers leave both at their defaults
    -- and keep the semantics they always had: a row means "do not deliver again".
    --   next_attempt_at IS NOT NULL  -> pending, due at that time
    --   next_attempt_at IS NULL      -> terminal: error IS NULL delivered, else dead
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    PRIMARY KEY (event_id, consumer_module)
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
`;

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
    };

interface ConnectionRow {
  id: string;
  tenant_id: string;
  vertical: string;
  provider: string;
  label: string;
  status: string;
  external_account_ref: string | null;
  scopes: string;
  expires_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

/** Row → contract shape. Never reads the secrets table — that is the point of the split. */
const toConnection = (r: ConnectionRow): Connection =>
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

interface TenantRow {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
  deleting_at: string | null;
  provisioned_by_tenant: string | null;
}

interface ScopeRow {
  scope_id: string;
  tenant_id: string;
  parent_scope_id: string | null;
  slug: string;
  kind: string;
  name: string;
  vertical: string | null;
  storage_shape: string;
  jurisdiction: string | null;
  status: string;
  schema_version: string;
  vertical_version_id: string | null;
  migration_failed_version: string | null;
  migration_error: string | null;
  migration_attempts: number;
  migration_last_attempt_at: string | null;
  forked_from: string | null;
  forked_at: string | null;
  expires_at: string | null;
  /** The dispatch script this scope's data lives in (#286); null = per-version dispatch. */
  serving_ref: string | null;
  /** When the scope last entered `archived` (§4.4); null if never archived. */
  archived_at: string | null;
  created_at: string;
}

/**
 * The four migration-health columns → the contract's nullable `migrationFailure`.
 * All-null is the healthy case (never attempted, or the last attempt succeeded and
 * cleared them); a version present means the scope failed closed and did not serve.
 *
 * Returns the *unparsed* shape — `scopeSchema.parse` brands `lastAttemptAt` into an
 * `Instant`, the same way every other row value in `mapScope` is branded on read.
 */
function mapMigrationFailure(r: {
  migration_failed_version: string | null;
  migration_error: string | null;
  migration_attempts: number;
  migration_last_attempt_at: string | null;
}): { version: string; error: string; attempts: number; lastAttemptAt: string } | null {
  if (!r.migration_failed_version || !r.migration_last_attempt_at) return null;
  return {
    version: r.migration_failed_version,
    error: r.migration_error ?? '',
    attempts: r.migration_attempts,
    lastAttemptAt: r.migration_last_attempt_at,
  };
}

interface HostnameRow {
  hostname: string;
  tenant_id: string;
  scope_id: string;
  vertical_slug: string | null;
  surface: string;
  region: string | null;
  status: string;
  status_note: string | null;
  canonical: number;
  created_at: string;
  custom_hostname_id: string | null;
  validation_records: string | null;
}

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

/**
 * Fold keyset page params (contracts pagination.ts) into an in-progress WHERE
 * build and return the `ORDER BY … [LIMIT ?]` tail. The cursor is EXCLUSIVE —
 * strictly after it ascending, strictly before it descending — and an unset
 * limit stays unbounded: internal callers mean "everything", and a silent cap
 * would let them mistake a page for the whole set.
 */
function keysetTail(
  where: string[],
  params: (string | number)[],
  key: string,
  page: ListPage | undefined,
  defaultOrder: 'asc' | 'desc' = 'asc',
): string {
  const order = (page?.order ?? defaultOrder) === 'desc' ? 'DESC' : 'ASC';
  if (page?.cursor) {
    where.push(order === 'DESC' ? `${key} < ?` : `${key} > ?`);
    params.push(page.cursor);
  }
  let tail = ` ORDER BY ${key} ${order}`;
  if (page?.limit !== undefined) {
    tail += ' LIMIT ?';
    params.push(page.limit);
  }
  return tail;
}

interface VerticalRow {
  slug: string;
  name: string;
  source: string;
  owner_tenant: string | null;
  /** The vertical's declared env-spec, as a JSON string (or null). */
  env_spec: string | null;
  /** Registry-driven install (marketplace-publish.md): {entitlements, ownerGrants, provides,
   *  requires} as one JSON string (or null). */
  install_spec: string | null;
  /** Published to the public marketplace (0/1). Set on insert; the publish action updates it;
   *  a re-push refresh never touches it. */
  listed: number;
  /** A builder's pending publish request (ISO timestamp, or null). Set by requestPublish,
   *  cleared by setVerticalListed. */
  publish_requested_at: string | null;
  /** New installs blocked (0/1) — the staff kill-switch; gates provisioning, not serving. */
  installs_blocked: number;
  /** Tenant-provisioner capability (0/1, #412) — staff grant; never touched by a re-push. */
  tenant_provisioner: number;
  /** Email-sender capability (0/1, #303) — staff grant; never touched by a re-push. */
  email_sender: number;
  /** The stable serving script (#286): name, current version, DO-class/tag delta base. */
  serving_ref: string | null;
  serving_version_id: string | null;
  serving_do_classes: string | null;
  serving_migration_tag: string | null;
  created_at: string;
}

interface VersionRow {
  id: string;
  vertical_slug: string;
  version: string;
  manifest_digest: string;
  permission_digest: string;
  migration_digest: string;
  deployment_ref: string | null;
  admission: string;
  admission_note: string | null;
  /** The pushed DeployManifest (JSON) — the serving upload's metadata source (#286). */
  manifest_json: string | null;
  /** Push provenance (`versionOrigin` JSON) — null for a pre-tracking push. */
  origin_json: string | null;
  created_at: string;
}

interface ChannelRow {
  vertical_slug: string;
  channel: string;
  version_id: string;
  updated_at: string;
}

interface ChannelHistoryRow {
  id: string;
  vertical_slug: string;
  channel: string;
  version_id: string;
  from_version_id: string | null;
  actor: string;
  at: string;
}

interface OrgRow {
  org_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  created_at: string;
}

interface AccessLogRow {
  id: string;
  actor: string;
  method: string;
  tenant_id: string | null;
  scope_id: string | null;
  params: string | null;
  result_count: number;
  drained_at: string | null;
  at: string;
}

interface AdminLogRow {
  id: string;
  actor: string;
  action: string;
  tenant_id: string | null;
  scope_id: string | null;
  vertical: string | null;
  before: string | null;
  after: string | null;
  caused_by: string | null;
  at: string;
}

interface OpsFailureRow {
  id: string;
  actor: string;
  operation: string;
  stage: string | null;
  tenant_id: string | null;
  scope_id: string | null;
  vertical: string | null;
  status: number | null;
  message: string;
  reference: string | null;
  at: string;
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
  payload: string | null;
}

/** A raw `_substrat_platform_requests` row as stored — snake_case, JSON columns as strings. */
interface PlatformRequestRawRow {
  id: string;
  kind: string;
  payload: string;
  requested_by: string;
  status: string;
  attempts: number;
  last_error: string | null;
  last_failure: string | null;
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
    failure: r.last_failure == null ? null : JSON.parse(r.last_failure),
    result: r.result === null ? null : JSON.parse(r.result),
    requestedAt: r.requested_at,
    settledAt: r.settled_at,
  });
}

/**
 * The dispatch capability (#726 remedy B): a connector delivery may read the attachments
 * of the entity the DELIVERED EVENT names, and nothing else.
 *
 * The read a signing connector needs is inherently per-dispatch — the event names one
 * `documentAttachmentId`, `bindDocument` already refused to bind an attachment owned by
 * anything but the instance being signed, and `openAttachment` takes an id rather than a
 * search. Modelling that as a standing scope-wide `protocol:read` grant was the mismatch
 * this closes: the grant site has no entity leg, so the narrow check was being asked a
 * question the grant model could only answer broadly — and `protocol:read` also gates
 * `protocol/get`, `list-templates` and `list-for-entity`, none of which a connector
 * sending one named document has any business reaching.
 *
 * **Derived here, never asserted by the caller.** The entity comes from this scope's own
 * kernel-stamped spine row, looked up by event id. On the hosted path the platform runs
 * the connector, so an entity passed across the seam would be the platform's word for
 * what it is allowed to read; an event id it must resolve against the deployment's own
 * outbox is not. The platform can name any delivery; it cannot name an entity.
 *
 * **No fallback to the permission check.** Inside a dispatch this IS the authority. A
 * grant would only re-widen what the whole point is to narrow, and there is no read a
 * connector legitimately makes during a delivery that the delivery does not name.
 */
const admitByDelivery = (
  rt: ScopeRuntime,
  eventId: string,
  row: { entity_type: string; entity_id: string; id: string },
): void => {
  const event = rt.db
    .prepare('SELECT entity_type, entity_id FROM _substrat_outbox WHERE id = ?')
    .get(eventId) as { entity_type: string; entity_id: string } | undefined;
  if (!event) {
    throw new PermissionDenied(
      `attachment ${row.id}: delivery ${eventId} is not an event of this scope, so it ` +
        `carries no authority to read anything here`,
    );
  }
  if (event.entity_type !== row.entity_type || event.entity_id !== row.entity_id) {
    throw new PermissionDenied(
      `attachment ${row.id} belongs to ${row.entity_type}/${row.entity_id}, and this ` +
        `delivery is for ${event.entity_type}/${event.entity_id} — a connector may read ` +
        `the attachments of the entity its event names, and no others`,
    );
  }
};

/** One grant tuple as `connectionGrantsInScope` reads it — either tuple store, same shape. */
type TupleReadRow = { subject: string; relation: string; expires_at: string | null };

export class SqliteScopeHost implements ScopeHost {
  readonly admin: HostAdmin;
  private readonly dir: string;
  private readonly checker: PermissionChecker;
  private readonly directory: Database.Database;
  private readonly scopes = new Map<string, ScopeRuntime>();
  private readonly scopesById = new Map<string, ScopeRuntime>();
  /** Per-tenant relational stores (#301), opened lazily and cached by `ref` (the bare
   *  `.sqlite` filename). The pure-adapter analogue of a per-tenant D1 — one file per
   *  (tenant, vertical, binding), physically separate from the scope DBs. */
  private readonly tenantStoreDbs = new Map<string, Database.Database>();
  private readonly operations = new Map<string, OperationHandler<never, unknown>>();
  private readonly modules = new Map<string, RegisteredModule>();
  /** operation name → guards declared before it, in registration order (K-17). */
  private readonly guards = new Map<string, DeclaredGuard[]>();
  /** predicate name → the module-contributed implementation. Names are global. */
  private readonly predicates = new Map<string, { module: string; handler: GuardPredicate }>();
  /** operation names whose default binding some manifest withdrew (K-17). */
  private readonly withdrawn = new Map<string, string>(); // operation → withdrawing module
  private readonly relations = new Map<string, Set<string>>();
  /** entityType → its derived FTS5 index (#827). One entity type, one index. */
  private readonly searchPlans = new Map<string, SearchIndexPlan>();
  /** #811: the paged lists modules declare, by entity type. Same one-owner rule as search. */
  private readonly listPlans = new Map<string, ListIndexPlan>();
  /** entityType → the declared attachment gate (#473): read key + write key (default: read). */
  private readonly attachmentTargets = new Map<string, { read: PermissionKey; write: PermissionKey }>();
  /** operation name → its owning module's entitlementKey (§4.3 gate). */
  private readonly operationEntitlement = new Map<string, string>();
  /**
   * #893: name → the declared input schema, parsed before guards and handler.
   * Populated only by `registerModule` — a bare `defineOperation` (tests, glue)
   * carries no declaration and stays unparsed, exactly as it carries no manifest
   * and stays ungated.
   */
  private readonly operationInput = new Map<string, { parse(value: unknown): unknown }>();
  private readonly roles = new Map<string, RoleDefinition>(); // 'tenantId/roleKey'
  /** Executor id → {eventType, handler} (K-22 §4.2). Host code, not module code. */
  private readonly executors = new Map<string, RegisteredEffector>();
  /**
   * The event currently being effected by an executor, stamped onto any admin rows
   * it writes. Ambient rather than threaded through every HostAdmin signature: it is
   * set and cleared immediately around one `await`, and executors run sequentially,
   * so there is no window where it belongs to a different event.
   */
  private causedBy: string | null = null;
  private readonly systemPrincipal: PrincipalId = principalId.parse(ulid());
  private readonly secretBox: SecretBox;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;

  constructor(options: SqliteScopeHostOptions) {
    this.secretBox = options.secretBox ?? unconfiguredSecretBox;
    this.fetchImpl = options.fetch ?? ((input, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(input, init));
    this.clock = options.clock ?? (() => instant.parse(new Date().toISOString()));
    this.dir = options.dir;
    mkdirSync(this.dir, { recursive: true });
    this.directory = new Database(join(this.dir, '_directory.sqlite'));
    this.directory.pragma('journal_mode = WAL');
    this.applyDirectorySchema();
    this.loadRoles();
    this.checker =
      options.checker ??
      createTupleChecker({
        directory: this.directory,
        scopeDb: (scopeId) => this.scopesById.get(scopeId)?.db,
        getRole: (tenantId, key) => this.roles.get(`${tenantId}/${key}`),
      });
    this.admin = this.buildAdmin();
  }

  /**
   * The directory schema, applied on every open — and again after a restore (#40).
   *
   * Extracted from the constructor so the two callers cannot drift: a dump taken before
   * a directory migration carries the OLD shape, so replaying it verbatim would roll the
   * schema backwards and the next read of a newer column would fail with a bare `no such
   * column`. Every statement is IF NOT EXISTS and `ensureDirectoryColumns` probes before
   * it alters, so this only ever adds back what a copy did not carry.
   */
  private applyDirectorySchema(): void {
    this.directory.exec(`
      -- The tenant registry (control-plane.md §4.1). Before this a tenant was an
      -- FK string on scope rows; now it is a real record with a lifecycle status.
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        -- When the tenant last entered the deleting state; NULL otherwise. The
        -- grace-window reap sweep ages a tenant off this (§4.8), mirroring archived_at.
        deleting_at TEXT,
        -- Provenance (#412): the tenant that provisioned this one via a manager
        -- vertical, or NULL for a direct staff create. A FK to another tenants row.
        provisioned_by_tenant TEXT REFERENCES tenants(tenant_id)
      );
      -- The scope directory (§3.2). slug/kind/name/vertical are nullable HERE but
      -- required (except vertical) by the scope contract: the column set must be
      -- identical whether the table was created fresh or ALTERed up from the
      -- pre-directory shape (see ensureDirectoryColumns), and SQLite cannot ADD a
      -- NOT NULL column without inventing a default for existing rows. Nothing
      -- writes null — provisionScope always resolves a value, and the backfill
      -- fills legacy rows — so Zod is the enforcement point on read.
      CREATE TABLE IF NOT EXISTS scopes (
        scope_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        parent_scope_id TEXT,
        slug TEXT,
        kind TEXT,
        name TEXT,
        vertical TEXT,
        storage_shape TEXT NOT NULL DEFAULT 'A',
        jurisdiction TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        schema_version TEXT NOT NULL DEFAULT '0',
        vertical_version_id TEXT,
        -- Last FAILED migration attempt (§5.3). All null / 0 = healthy. Written on
        -- the failure path so a scope that fails closed stops rendering as active;
        -- cleared on the next success. See applyPendingMigrations.
        migration_failed_version TEXT,
        migration_error TEXT,
        migration_attempts INTEGER NOT NULL DEFAULT 0,
        migration_last_attempt_at TEXT,
        -- Fork provenance (preview-and-snapshots.md §3): the scope this one was
        -- copied from, and when. Both null for a normally-provisioned scope.
        forked_from TEXT,
        forked_at TEXT,
        -- Retention horizon for forks (preview-and-snapshots.md §3): the GC sweep
        -- reaps a fork past this instant. Null = no expiry.
        expires_at TEXT,
        -- The dispatch script this scope's data lives in (#286). NULL = legacy
        -- per-version dispatch (the bound version's own script).
        serving_ref TEXT,
        -- When the scope last entered the archived state (§4.4). Drives the reap sweep's
        -- age filter; null for scopes that never archived, cleared on unarchive.
        archived_at TEXT,
        created_at TEXT NOT NULL
      );
      -- The hostname map (K-26). A single environment-wide router resolves against
      -- this before dispatching to the vertical's worker.
      --
      -- The surface column is why one hostname per scope was not enough: the shop
      -- fronts a storefront AND a back office from one scope. The region column is
      -- Regional Services, which Cloudflare configures per hostname — the reason
      -- residency lives here rather than in a router deployed per jurisdiction.
      CREATE TABLE IF NOT EXISTS hostnames (
        hostname      TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        scope_id      TEXT NOT NULL,
        vertical_slug TEXT,
        surface       TEXT NOT NULL,
        region        TEXT,
        status        TEXT NOT NULL,
        status_note   TEXT,
        canonical     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        -- Cloudflare-for-SaaS issuance (§4.7): CF's custom-hostname id + the DNS records
        -- to publish (JSON). NULL for a platform hostname / a still-pending custom domain.
        custom_hostname_id  TEXT,
        validation_records  TEXT
      );
      CREATE INDEX IF NOT EXISTS hostnames_scope ON hostnames (scope_id, surface);
      CREATE INDEX IF NOT EXISTS hostnames_status ON hostnames (status);
      -- Per-tenant relational stores (#301). One row per (tenant, vertical, binding): the
      -- platform-minted per-tenant store a vertical declared as a tenantStoreNeed. ref
      -- is the opaque store handle — a per-tenant .sqlite path token here, a D1
      -- database_id on Cloudflare. The row is the idempotency + reap ledger: a retried
      -- provision re-resolves the SAME ref rather than minting a second database, and the
      -- platform knows what to tear down when a tenant is reaped (no orphaned databases).
      CREATE TABLE IF NOT EXISTS tenant_stores (
        tenant_id  TEXT NOT NULL,
        vertical   TEXT NOT NULL,
        binding    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        ref        TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, vertical, binding)
      );
      -- Per-tenant blob stores (#473) — the tenant_stores twin for attachment bytes.
      -- ref is the opaque handle: a per-tenant directory token here, an R2 bucket name
      -- on Cloudflare. Same idempotency + reap ledger role.
      CREATE TABLE IF NOT EXISTS blob_stores (
        tenant_id  TEXT NOT NULL,
        vertical   TEXT NOT NULL,
        binding    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        ref        TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, vertical, binding)
      );
      -- The vertical + version registry (#31). A scope binds to a VERSION, so
      -- dev/staging/prod are the same vertical pinned differently, and a preview
      -- deployment is a version nothing has been promoted to yet.
      CREATE TABLE IF NOT EXISTS verticals (
        slug         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        source       TEXT NOT NULL,
        -- The tenant that OWNS this vertical (builder-plane.md). NULL = platform-owned.
        -- Denormalized nullable column so ownership is queryable without parsing slugs.
        owner_tenant TEXT,
        -- The vertical's declared env-spec (moduleManifest.envSpec) as JSON, so a host or
        -- console can render a config form for any registered vertical. NULL = declares none.
        env_spec     TEXT,
        -- Registry-driven install (marketplace-publish.md §3): {entitlements, ownerGrants,
        -- provides, requires} as one JSON blob, so the dashboard installs without a hardcoded
        -- catalog entry. NULL = none declared.
        install_spec TEXT,
        -- Published to the public marketplace (marketplace-publish.md §2). 0 = private to
        -- owner_tenant. Its own column: set on insert, updated by the publish action, never
        -- clobbered by a re-push refresh.
        listed       INTEGER NOT NULL DEFAULT 0,
        -- A builder's pending publish request (marketplace-publish.md §5): ISO timestamp when
        -- the owner asked to be listed, awaiting staff review. NULL = none / resolved.
        publish_requested_at TEXT,
        -- New installs BLOCKED (staff kill-switch). 1 = hidden from the install catalog
        -- and provisioning refuses, for everyone including the owner. Existing scopes
        -- keep running — this gates provisioning, not serving.
        installs_blocked INTEGER NOT NULL DEFAULT 0,
        -- Tenant-provisioner capability (#412). 1 = this vertical's scopes may enqueue
        -- provision-tenant / set-entitlements intents the platform executes. A staff
        -- grant (set_vertical_tenant_provisioner), never set on insert or re-push.
        tenant_provisioner INTEGER NOT NULL DEFAULT 0,
        -- Email-sender capability (#303). 1 = this vertical's scopes may POST to the control
        -- plane's /internal/email/send relay and have transactional mail sent for them. A staff
        -- grant (set_vertical_email_sender), never set on insert or re-push.
        email_sender INTEGER NOT NULL DEFAULT 0,
        -- The ONE stable serving script (#286): the name every new scope's data DO
        -- lives in, the version it currently runs, and the DO-class/migration-tag
        -- base the next in-place upload diffs against.
        serving_ref TEXT,
        serving_version_id TEXT,
        serving_do_classes TEXT,
        serving_migration_tag TEXT,
        created_at   TEXT NOT NULL
      );
      -- admission: 'pending' until the gates pass. A push is not a deploy, and
      -- bind_scope_version refuses anything not admitted -- which is what makes
      -- that sentence structural rather than a convention.
      CREATE TABLE IF NOT EXISTS vertical_versions (
        id                TEXT PRIMARY KEY,
        vertical_slug     TEXT NOT NULL,
        version           TEXT NOT NULL,
        manifest_digest   TEXT NOT NULL,
        permission_digest TEXT NOT NULL,
        migration_digest  TEXT NOT NULL,
        deployment_ref    TEXT,
        admission         TEXT NOT NULL,
        admission_note    TEXT,
        -- The pushed DeployManifest (JSON) — what a serve rebuilds upload metadata
        -- from (#286). NULL = pre-#286 push, archivable but never served in place.
        manifest_json     TEXT,
        created_at        TEXT NOT NULL,
        UNIQUE (vertical_slug, version)
      );
      -- Channels (#31 step 2): a named pointer per vertical. Promotion moves it,
      -- and promotion is where the migration and permission diffs fire — the
      -- moment a change reaches anyone, rather than the moment it was typed.
      CREATE TABLE IF NOT EXISTS vertical_channels (
        vertical_slug TEXT NOT NULL,
        channel       TEXT NOT NULL,
        version_id    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (vertical_slug, channel)
      );
      -- The promotion timeline (append-only). The channel row remembers only where it
      -- points now; this remembers every move — what went live, what it replaced, who
      -- and exactly when. "at" is the PITR anchor a data rollback would rewind to
      -- (preview-and-snapshots.md §7). Never updated, never deleted except with the
      -- vertical itself.
      CREATE TABLE IF NOT EXISTS vertical_channel_history (
        id              TEXT PRIMARY KEY,
        vertical_slug   TEXT NOT NULL,
        channel         TEXT NOT NULL,
        version_id      TEXT NOT NULL,
        from_version_id TEXT,
        actor           TEXT NOT NULL,
        at              TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vch_vertical_channel
        ON vertical_channel_history (vertical_slug, channel);
      -- Organizations inside a tenant (K-22). Membership tuples point at these and
      -- grantToOrg targets them. Before this the id was a free-form string with no
      -- record, so a typo addressed a phantom org. The tenant_id column is also
      -- kernel-design §4.3's required orgId <-> tenantId join.
      CREATE TABLE IF NOT EXISTS orgs (
        org_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _substrat_tenant_tuples (
        tenant_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        relation TEXT NOT NULL,
        object TEXT NOT NULL,
        expires_at TEXT,
        -- K-21: see the note on _substrat_tuples. Membership lives here, so this
        -- is the column removeMember writes.
        revoked_at TEXT,
        PRIMARY KEY (tenant_id, subject, relation, object)
      );
      CREATE TABLE IF NOT EXISTS _substrat_roles (
        tenant_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permissions TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (tenant_id, role_key)
      );
      -- Per-tenant SKU flags (control-plane.md §4.3). A module loads for a tenant
      -- only if the tenant holds its manifest.entitlementKey — default-deny.
      -- #33 widens the flag into a plan: expires_at is enforced at the gate
      -- (lazy-at-read, like tuple expiry); quota/plan are expression the builder
      -- portal consumes; granted_at/granted_by are stamped platform-side and
      -- NULL only on rows born before the widening.
      CREATE TABLE IF NOT EXISTS _substrat_entitlements (
        tenant_id TEXT NOT NULL,
        entitlement_key TEXT NOT NULL,
        expires_at TEXT,
        quota INTEGER,
        plan TEXT,
        granted_at TEXT,
        granted_by TEXT,
        PRIMARY KEY (tenant_id, entitlement_key)
      );
      -- The identity seam (D-16; control-plane.md §6). An external identity
      -- (provider + external_id — an auth adapter at the edge) maps to a
      -- principal + home node. Provider-keyed so Better Auth, an OIDC issuer, or
      -- several at once coexist. Authentication input only — authorization stays
      -- in the tuples above.
      -- Registered identity pools (K-23). A provider declares its topology before it
      -- may link, so the directory knows whether the same externalId in two tenants is
      -- one human (central) or two (tenant-bound). tenant_id is non-null exactly when
      -- tenant-bound.
      CREATE TABLE IF NOT EXISTS _substrat_identity_pools (
        provider   TEXT PRIMARY KEY,
        topology   TEXT NOT NULL,
        tenant_id  TEXT,
        created_at TEXT NOT NULL
      );
      -- The integrations hub (#101). Keyed on (tenant, vertical, provider): a
      -- vertical is a blast-radius boundary (D-30) and verticals are built by
      -- different companies (D-33), so one vendor's host code must not reach a
      -- credential another vendor connected.
      CREATE TABLE IF NOT EXISTS _substrat_connections (
        id                   TEXT PRIMARY KEY,
        tenant_id            TEXT NOT NULL,
        vertical             TEXT NOT NULL,
        provider             TEXT NOT NULL,
        label                TEXT NOT NULL,
        status               TEXT NOT NULL,
        external_account_ref TEXT,
        scopes               TEXT NOT NULL,
        expires_at           TEXT,
        last_ok_at           TEXT,
        last_error           TEXT,
        last_error_at        TEXT,
        created_by           TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        revoked_at           TEXT
      );
      -- One LIVE connection per (tenant, vertical, provider, account). Revoked
      -- rows are kept as evidence (K-21's tombstone rule) and must not block a
      -- successor, which is why the index is partial rather than a table
      -- constraint. The account leg is COALESCEd so providers that never set an
      -- external_account_ref keep the original singleton semantics (all their
      -- NULLs collide on ''), while a multi-namespace provider (GitHub) holds
      -- one live connection PER account — the Vercel git-namespace shape.
      CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connections_live_account
        ON _substrat_connections (tenant_id, vertical, provider, COALESCE(external_account_ref, ''))
        WHERE revoked_at IS NULL;
      -- Sealed credentials, in their own table so that reading a connection's
      -- METADATA never touches ciphertext. Nothing above SecretBox sees plaintext.
      CREATE TABLE IF NOT EXISTS _substrat_connection_secrets (
        connection_id TEXT PRIMARY KEY,
        key_id        TEXT NOT NULL,
        ciphertext    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      -- Each connection's SEALING keypair (#687, design/signature-contact-carrier.md).
      -- The public half is projected into scopes so module code can seal a value TO
      -- this connector before emitting it; the private half is sealed under the host
      -- SecretBox exactly as the credential above is, and never leaves the directory.
      -- Keyed (connection_id, key_id) — a MAP from day one even holding one member,
      -- because widening a single-key column into a set later is a migration against
      -- live connections and starting with the map is free (D-4).
      CREATE TABLE IF NOT EXISTS _substrat_connection_keys (
        connection_id TEXT NOT NULL,
        key_id        TEXT NOT NULL,
        public_key    TEXT NOT NULL,
        wrapped_key_id TEXT NOT NULL,
        wrapped_private TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        retired_at    TEXT,
        PRIMARY KEY (connection_id, key_id)
      );
      -- The CURRENT key a new seal uses. Partial-unique rather than a column on the
      -- connection: rotation retires a row and inserts a new current one, and old
      -- ciphertext stays openable because its own key_id row is still here.
      CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connection_keys_current
        ON _substrat_connection_keys (connection_id) WHERE retired_at IS NULL;
      -- Connection grants as the directory records them (#592) — the durable half
      -- of grantToConnection, written alongside the enforcement tuple. The tuple
      -- lives where it is checked; this row is what provision/reconcile gather
      -- FROM, so a scope provisioned after the grant holds the same grants as one
      -- provisioned before it. Tombstoned by revokeConnection's cascade (K-21).
      CREATE TABLE IF NOT EXISTS _substrat_connection_grants (
        connection_id TEXT NOT NULL,
        tenant_id     TEXT NOT NULL,
        vertical      TEXT NOT NULL,
        permission    TEXT NOT NULL,
        scope_id      TEXT,
        expires_at    TEXT,
        granted_by    TEXT NOT NULL,
        granted_at    TEXT NOT NULL,
        revoked_at    TEXT
      );
      -- One row per (connection, permission, target) — COALESCEd so the NULL
      -- (tenant-wide) target collides with itself and a re-grant upserts in place.
      CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connection_grants_key
        ON _substrat_connection_grants (connection_id, permission, COALESCE(scope_id, ''));
      -- A connector's own durable state (#101 gap 3), keyed by connection. The
      -- dispatch-idempotency ledger: (connection, event key) -> what was done,
      -- so a redelivery skips instead of repeating an outward effect. Directory-
      -- side because a connector cannot write the scope during its own dispatch.
      CREATE TABLE IF NOT EXISTS _substrat_connector_state (
        connection_id TEXT NOT NULL,
        state_key     TEXT NOT NULL,
        value         TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (connection_id, state_key)
      );
      CREATE TABLE IF NOT EXISTS _substrat_identities (
        provider     TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        scope_id     TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, provider, external_id)
      );
      -- Append-only control-plane audit trail (control-plane.md §4.4). Lives in
      -- the directory, not a scope DB: it records cross-tenant staff actions and
      -- is stamped host-side. Never UPDATEd, never DELETEd.
      -- Staff READS (K-24). Separate from the admin log because they are two
      -- things: a mutation is permanent evidence, a read is operational history.
      -- One table would force one retention policy on both, the stricter would
      -- win, and read noise would bury the mutation rows an auditor came for.
      --
      -- drained_at marks a row shipped to Tier 2. ONLY drained rows may be
      -- pruned: expiring on age alone would destroy evidence while calling
      -- itself retention. The sweep's ship→stamp→prune cycle is what closes the
      -- window (kernel sweepAccessLog); a deployment that configures no sink
      -- drains nothing and the window stays unbounded — still stated, but now
      -- something the operator opts out of rather than something imposed.
      CREATE TABLE IF NOT EXISTS _substrat_access_log (
        id           TEXT PRIMARY KEY,
        actor        TEXT NOT NULL,
        method       TEXT NOT NULL,
        tenant_id    TEXT,
        scope_id     TEXT,
        params       TEXT,
        -- What separates navigation from an incident: "called listScopes" against
        -- "enumerated 4,000 tenants". A log that cannot tell them apart is a log
        -- nobody reads.
        result_count INTEGER NOT NULL,
        drained_at   TEXT,
        at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS _substrat_access_log_actor ON _substrat_access_log (actor, id);
      CREATE INDEX IF NOT EXISTS _substrat_access_log_tenant ON _substrat_access_log (tenant_id, id);
      -- Per-subject encryption keys (#37). In the DIRECTORY on purpose: these keys seal
      -- PII inside platform-retained copies of SCOPE databases, so keeping them in the
      -- scope DB would mean every backup carried both halves and a restore silently
      -- reversed every erasure it rolled past. master-plan.md:316 — "GDPR erasure claims
      -- are only as credible as the key store's independence".
      --
      -- The DEK is never stored raw: wrapped_dek is sealed by the host SecretBox, so a
      -- directory dump carries wrapped keys and the master key is somewhere else again.
      --
      -- A shred CLEARS wrapped_dek and stamps shredded_at, keeping the row. The row IS the
      -- tombstone: without it a later seal would mint a fresh key for the same subject and
      -- quietly restore readability the erasure was supposed to end. A key store that
      -- forgets who was erased can only erase them once.
      CREATE TABLE IF NOT EXISTS _substrat_subject_keys (
        scope_id     TEXT NOT NULL,
        subject_id   TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        key_id       TEXT,
        wrapped_dek  TEXT,
        created_at   TEXT NOT NULL,
        shredded_at  TEXT,
        PRIMARY KEY (scope_id, subject_id)
      );
      CREATE TABLE IF NOT EXISTS _substrat_admin_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        -- Nullable: a platform-level action targets no tenant (K-23).
        tenant_id TEXT,
        scope_id TEXT,
        vertical TEXT,
        before TEXT,
        after TEXT,
        -- The event that caused this action, when one did (K-22 §4.2). This is
        -- what joins the connector seam's two halves: the module's emit and the
        -- executor's effect. Null for a staff member acting directly.
        caused_by TEXT,
        at TEXT NOT NULL
      );
      -- Read-path indexes for the console (control-plane.md §4.5). The admin log
      -- is append-only and only grows, so every filter it offers needs one; the
      -- trailing id column makes each a covering index for the ORDER BY.
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_tenant ON _substrat_admin_log (tenant_id, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_scope ON _substrat_admin_log (scope_id, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_actor ON _substrat_admin_log (actor, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_action ON _substrat_admin_log (action, id);
      CREATE INDEX IF NOT EXISTS _substrat_admin_log_at ON _substrat_admin_log (at);
      -- Operational failures (#559): what the platform could NOT do. Unlike the
      -- never-swept admin log above, this is retention-bounded telemetry, pruned
      -- on write (OPS_FAILURE_RETENTION_DAYS). reference carries the upstream
      -- provider's trace handle so a CI error line resolves to a row here.
      CREATE TABLE IF NOT EXISTS _substrat_ops_failures (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        stage TEXT,
        tenant_id TEXT,
        scope_id TEXT,
        vertical TEXT,
        status INTEGER,
        message TEXT NOT NULL,
        reference TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS _substrat_ops_failures_vertical ON _substrat_ops_failures (vertical, id);
      CREATE INDEX IF NOT EXISTS _substrat_ops_failures_tenant ON _substrat_ops_failures (tenant_id, id);
      CREATE INDEX IF NOT EXISTS _substrat_ops_failures_reference ON _substrat_ops_failures (reference);
      CREATE INDEX IF NOT EXISTS _substrat_ops_failures_at ON _substrat_ops_failures (at);
      CREATE INDEX IF NOT EXISTS scopes_tenant ON scopes (tenant_id, scope_id);
    `);
    this.ensureDirectoryColumns();
  }

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
    });
  }

  /**
   * Build the context a connector runs with. Tenant and vertical are AMBIENT —
   * taken from the event's scope, never from an argument — so a connector cannot
   * reach a credential another vertical connected even by accident.
   *
   * `holdsActor` says whether the CALLER is already inside `rt.actor.enqueue`. It
   * decides how the connection's attachment read is built and nothing else: from
   * `dispatchExecutors` (true) the surface must not re-enqueue or the scope wedges;
   * from `dispatchConnector` (false) nothing is held, so the read takes an ordinary
   * serialized turn like every other reader. Getting this from the call site rather
   * than assuming the worse case is what keeps the platform-dispatch path under the
   * K-6 serialization the adapter promises.
   */
  private connectorContext(
    rt: ScopeRuntime,
    timeoutMs: number,
    holdsActor: boolean,
    /** The delivery this context is FOR (#726) — the dispatch capability's whole basis. */
    eventId: string,
  ): ConnectorContext {
    const vertical =
      (
        this.directory
          .prepare('SELECT vertical FROM scopes WHERE scope_id = ?')
          .get(rt.scopeId) as { vertical: string | null } | undefined
      )?.vertical ?? null;
    const admin = this.admin;
    const fetchImpl = this.fetchImpl;
    return {
      admin,
      tenantId: rt.tenantId,
      scopeId: rt.scopeId,
      vertical: vertical ?? '',
      connection: async (provider: string) => {
        if (!vertical) {
          throw new Error(
            `scope ${rt.scopeId} is bound to no vertical, so it has no connection namespace — ` +
              `provision it with a vertical before using connectors`,
          );
        }
        const open = await admin.openConnection(rt.tenantId, vertical, provider);
        if (!open) {
          throw new Error(
            `no live '${provider}' connection for tenant ${rt.tenantId} / vertical '${vertical}'`,
          );
        }
        return {
          ...open,
          // The outbound read (#711), on THIS connection — so it is authorized as
          // the credential the handler actually opened, and cannot drift from it.
          //
          // `reentrant` is the whole subtlety. Inside `dispatchExecutors` we are
          // already in this scope's actor task, and the ordinary surface re-enqueues
          // per verb: the nested task would wait on the task holding it and the
          // invoke would never return (`test/connector-reads.test.ts`). Outside it —
          // `dispatchConnector` — nothing is held, so the read takes an ordinary
          // serialized turn and stays under K-6 like every other reader. Assuming
          // the reentrant case everywhere would have dropped serialization on a path
          // that never needed it.
          // #726 gap 1: this connection's live grants IN THIS SCOPE, so a connector can
          // assert its preconditions at the top of a dispatch rather than discovering a
          // missing grant as a refusal several calls later.
          grants: async () =>
            (await this.connectionGrantsInScope(rt.tenantId, rt.scopeId))
              .filter((g) => g.connectionId === open.id)
              .map((g) => g.permission),
          openAttachment: async (attachmentId: string) => {
            const store = this.attachmentStore(rt.tenantId, vertical);
            return this.buildAttachments(rt, { kind: 'connection', id: open.id }, store, {
              reentrant: holdsActor,
              // #726 remedy (B): inside a dispatch the authority to read is the DELIVERY,
              // not a standing grant. See `admitByEvent` on `buildAttachments`.
              admitByEvent: eventId,
            }).open(attachmentId);
          },
          // #687: open a cell the scope sealed TO this connection. The keyId-indexed
          // map goes in, never out — a connector is handed the plaintext of one cell,
          // not a private key it could mislay. Retired keys are in the map too, so a
          // request pending across a rotation still opens.
          unseal: async (sealed) => openSealed(await this.openSealingKeys(open.id), sealed),
          fetch: async (input, init) => {
            try {
              const res = await fetchImpl(input, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs),
              });
              // A 5xx is the provider failing; a 4xx is usually us. Both are
              // worth recording, because "the connection stopped working" is the
              // question a health view answers.
              if (!res.ok) {
                await admin.recordConnectionUse(open.id, {
                  ok: false,
                  error: `HTTP ${res.status} from ${provider}`,
                });
              } else {
                await admin.recordConnectionUse(open.id, { ok: true });
              }
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

  registerModule(registration: ModuleRegistration): void {
    const manifest = moduleManifest.parse(registration.manifest);
    if (this.modules.has(manifest.id)) {
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
    const consumers = Object.entries(registration.consumers ?? {}).map(
      ([eventType, handler]) => {
        if (!declaredConsumes.has(eventType)) {
          throw new Error(
            `${manifest.id} registers a consumer for undeclared event type: ${eventType}`,
          );
        }
        return { eventType, handler };
      },
    );
    // Guards (K-17): the manifest half is DECLARATION, the registration half is
    // the named predicate. They are deliberately resolved LATE — at invoke, not
    // here. Registration order is caller-controlled (a vertical may register
    // before the engine whose predicate it wires), so a fast-fail here would be
    // a lie: it would reject wiring that is merely early. The honest fail-closed
    // point is the invoke path — an unresolvable predicate BLOCKS the guarded
    // operation rather than silently letting it through, so a typo can never
    // widen the gate. What we DO enforce eagerly is the half we can see whole:
    // predicate names are global and may not collide.
    for (const [name, handler] of Object.entries(registration.predicates ?? {})) {
      const existing = this.predicates.get(name);
      if (existing) {
        throw new Error(
          `guard predicate already contributed by ${existing.module}: ${name} (names are global)`,
        );
      }
      this.predicates.set(name, { module: manifest.id, handler });
    }
    for (const guard of manifest.guards ?? []) {
      const forOperation = this.guards.get(guard.before) ?? [];
      forOperation.push({
        predicate: guard.predicate,
        config: guard.config,
        declaredBy: manifest.id,
      });
      this.guards.set(guard.before, forOperation);
    }
    // #827: the search indexes this module's `searchables` declare, appended
    // AFTER its own migrations — which is what makes the content table exist by
    // the time a trigger references it. Derived, never authored: a module does
    // not write the DDL for an index the kernel owns.
    const searchMigrations = searchIndexMigrations(manifest.id, manifest.searchables);
    for (const m of searchMigrations) {
      if (seen.has(m.version)) {
        throw new Error(`duplicate migration version in ${manifest.id}: ${m.version}`);
      }
      seen.add(m.version);
    }
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
    // #811: the list indexes this module's `lists` declare — same placement and
    // the same reason as the search indexes above: appended AFTER the module's
    // own migrations, so `CREATE INDEX` names a table that exists.
    const listMigrations = listIndexMigrations(manifest.id, manifest.lists);
    for (const m of listMigrations) {
      if (seen.has(m.version)) {
        throw new Error(`duplicate migration version in ${manifest.id}: ${m.version}`);
      }
      seen.add(m.version);
    }
    for (const plan of listIndexPlans(manifest.id, manifest.lists)) {
      const existing = this.listPlans.get(plan.entityType);
      if (existing) {
        throw new Error(
          `list: '${plan.entityType}' declares a paged list in both '${existing.moduleId}' and ` +
            `'${plan.moduleId}' — one entity type, one walk; rename one`,
        );
      }
      this.listPlans.set(plan.entityType, plan);
    }
    this.modules.set(manifest.id, {
      id: manifest.id,
      migrations: [...migrations, ...searchMigrations, ...listMigrations],
      consumers,
      schedules: manifest.schedules ?? [],
    });
    for (const rel of manifest.entityRelations ?? []) {
      const parents = this.relations.get(rel.entityType) ?? new Set<string>();
      parents.add(rel.parentType);
      this.relations.set(rel.entityType, parents);
    }
    // Attachment targets (#473): entityType → the permission gate the kernel's attachment
    // surface enforces. Two modules re-declaring the same entityType with the SAME gate is
    // tolerated (idempotent); with different gates it is refused — ambiguous authority
    // over who may read an entity's attachments must not depend on registration order.
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
    // WITHDRAWAL (K-17): suppress another module's default binding. Order
    // independent — a manifest may withdraw an operation whose module has not
    // registered yet (recorded here, skipped at defineOperation) or one already
    // registered (removed from the map now). The name then behaves exactly like
    // an unregistered one: invoke → 'unknown operation', i.e. fail closed. The
    // engine's in-scope FUNCTION is untouched — withdrawal removes the binding,
    // not the capability, which is how a vertical re-offers the same transition
    // behind its own guarded operation.
    const ownOperations = new Set(Object.keys(registration.operations ?? {}));
    for (const name of manifest.withdraws ?? []) {
      if (ownOperations.has(name)) {
        throw new Error(
          `${manifest.id} withdraws its own operation: ${name} (a module cannot withdraw itself — just don't register it)`,
        );
      }
      this.withdrawn.set(name, manifest.id);
      this.operations.delete(name);
    }
    // A declared input schema for an operation this module does not bind is a
    // schema that enforces nothing while reading as coverage — the same reason
    // `checksDeclaredElsewhere` refuses a stale exemption.
    const declaredInputs = registration.operationInputs ?? {};
    const unbound = Object.keys(declaredInputs).filter((name) => !ownOperations.has(name));
    if (unbound.length > 0) {
      throw new Error(
        `${manifest.id} declares operationInputs for unbound operation(s): ` +
          `${unbound.sort().join(', ')} — a schema on nothing reads as a parse that is not there`,
      );
    }
    for (const [name, handler] of Object.entries(registration.operations ?? {})) {
      this.defineOperation(name, handler);
      // Record which SKU flag gates this operation (§4.3). Bare defineOperation
      // bindings (tests, glue) carry no manifest and stay ungated.
      this.operationEntitlement.set(name, manifest.entitlementKey);
      // #893: withdrawal removes the binding, so the schema follows the handler
      // rather than the name — a withdrawn operation has nothing to parse for.
      const schema = declaredInputs[name];
      if (schema && this.operations.has(name)) this.operationInput.set(name, schema);
    }
  }

  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void {
    if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
    if (this.operations.has(name)) throw new Error(`operation already defined: ${name}`);
    this.operations.set(name, handler as OperationHandler<never, unknown>);
  }

  async provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void> {
    // Mandatory active tenant (control-plane.md §4.1/§4.2): a scope with no
    // tenant record is the "tenant is an FK string" hole the registry closes —
    // fail closed, never silently create the scope orphaned.
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(input.tenantId) as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision scope under unknown tenant: ${input.tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision scope under non-active tenant (status: ${tenantRow.status}): ${input.tenantId}`,
      );
    }
    const record = resolveScopeRecord(input);
    // Idempotency is on the scope_id (§3.3: provisioning is idempotent and
    // journaled — safe to re-run), so an existing scope short-circuits before the
    // slug check: re-provisioning does not collide with itself.
    const existing =
      this.directory.prepare('SELECT 1 FROM scopes WHERE scope_id = ?').get(input.scopeId) !==
      undefined;
    if (!existing) {
      // The `scopes_tenant_slug` UNIQUE index makes this fail closed either way;
      // checking first is what turns a SQLITE_CONSTRAINT into a sentence naming
      // the scope that already holds the slug. An `archived` scope (a deleted app) has
      // released its name, and `reaped` is past archived — both excluded so the slug can
      // be reclaimed by a new scope. The unique index is partial on the same predicate,
      // so a retained tombstone row never blocks the reuse this pre-check permits.
      const slugOwner = this.directory
        .prepare(
          "SELECT scope_id FROM scopes WHERE tenant_id = ? AND slug = ? AND status NOT IN ('archived', 'reaped')",
        )
        .get(input.tenantId, record.slug) as { scope_id: string } | undefined;
      if (slugOwner) {
        throw new Error(
          `scope slug '${record.slug}' already taken under tenant ${input.tenantId} ` +
            `by ${slugOwner.scope_id} (slugs are unique within a tenant)`,
        );
      }
      this.directory
        .prepare(
          `INSERT INTO scopes
             (scope_id, tenant_id, parent_scope_id, slug, kind, name, vertical,
              storage_shape, jurisdiction, status, forked_from, forked_at, expires_at,
              serving_ref, created_at)
           -- 'provisioning', not 'active' (K-31): the directory row exists before the
           -- vertical has created the scope DO, and only activateScope says it has.
           -- serving_ref sub-selected (#286): a scope born while its vertical serves
           -- in place is born ON the serving script, so its routing points there.
           -- EXCEPTION (#527): a PREVIEW binds a specific (usually not-yet-serving)
           -- version and its data is restored into THAT version's per-version script;
           -- inheriting serving_ref would route it to the prod serving script instead
           -- (COALESCE(s.serving_ref, vv.deployment_ref)). A null slug matches no row,
           -- so the sub-select is NULL and routing falls through to the bound version.
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?,
                   (SELECT serving_ref FROM verticals WHERE slug = ?), ?)`,
        )
        .run(
          input.scopeId,
          input.tenantId,
          record.slug,
          record.kind,
          record.name,
          record.vertical,
          record.storageShape,
          record.jurisdiction,
          record.forkedFrom,
          record.forkedAt,
          record.expiresAt,
          record.kind === 'preview' ? null : record.vertical,
          new Date().toISOString(),
        );
    }
    const rt = this.runtime(input.tenantId, input.scopeId);
    await this.applyPendingMigrations(rt);
    // Project each registered module's SCHEDULE grants (#383): a system principal
    // holds exactly the permissions its schedules declared, on this scope. This is
    // what makes `ctx.check` resolve for scheduled work — the gate stays the check,
    // and revoking the tuple (console) is how scheduling is turned off per scope.
    // Idempotent (INSERT OR REPLACE), so a re-provision re-asserts the same grants.
    for (const mod of this.modules.values()) {
      const perms = new Set<string>();
      for (const s of mod.schedules) for (const p of s.permissions) perms.add(p);
      for (const perm of perms) {
        rt.db
          .prepare(
            `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
             VALUES (?, ?, ?, NULL)`,
          )
          .run(`system:${mod.id}`, `granted:${perm}`, `scope:${input.scopeId}`);
      }
    }
    // Audit a real provision only; an idempotent re-provision changed nothing.
    if (!existing) {
      this.recordAdmin(
        actor,
        'provisionScope',
        { tenantId: input.tenantId, scopeId: input.scopeId, vertical: record.vertical },
        null,
        record,
      );
    }
  }

  async provisionTenantStore(
    actor: PlatformActorId,
    input: TenantStoreProvisionInput,
  ): Promise<TenantStoreHandle> {
    // Fail closed on an unknown/inactive tenant, exactly as provisionScope does: a store
    // for a tenant that does not exist is the same "FK string" hole (§4.1). A store is
    // minted only for a tenant the directory actually knows and is serving.
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(input.tenantId) as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision tenant store under unknown tenant: ${input.tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision tenant store under non-active tenant (status: ${tenantRow.status}): ${input.tenantId}`,
      );
    }
    // Idempotent on (tenant, vertical, binding): a retried provision re-resolves the SAME
    // store rather than minting a second database (the K-31 ready-gate retries the whole
    // callback, so this must be safe to re-run). An existing row short-circuits before any
    // file is touched and is NOT re-audited — nothing changed.
    const existing = this.directory
      .prepare(
        'SELECT kind, ref FROM tenant_stores WHERE tenant_id = ? AND vertical = ? AND binding = ?',
      )
      .get(input.tenantId, input.vertical, input.binding) as
      | { kind: string; ref: string }
      | undefined;
    if (existing) {
      return { binding: input.binding, kind: 'relational', ref: existing.ref };
    }
    // The opaque handle `ref` is a bare `.sqlite` filename, prefixed `tstore__` so it can
    // never collide with a scope DB (`${tenantId}__${scopeId}.sqlite`). It is deterministic
    // from the key, but the row — not the convention — is the source of truth (on Cloudflare
    // the ref is a D1 database_id CF assigns, which is not derivable). ULID keeps two
    // verticals' identically-bound stores distinct even if a slug is ever reused. The
    // vertical is flattened to filename-safe characters: a builder-owned slug is
    // `<tenant>/<name>` (builder-plane.md), and a `/` in a bare filename is exactly what
    // the open guard below refuses.
    const safeVertical = input.vertical.replace(/[^A-Za-z0-9_-]+/g, '-');
    const ref = `tstore__${input.tenantId}__${safeVertical}__${input.binding}__${ulid()}.sqlite`;
    // Physically mint the database now, so a successful mint means the file exists (matching
    // "the platform mints the store"); the vertical then runs its OWN migrations against it.
    this.tenantStoreDb(ref);
    this.directory
      .prepare(
        `INSERT INTO tenant_stores (tenant_id, vertical, binding, kind, ref, created_at)
         VALUES (?, ?, ?, 'relational', ?, ?)`,
      )
      .run(input.tenantId, input.vertical, input.binding, ref, new Date().toISOString());
    this.recordAdmin(
      actor,
      'provisionTenantStore',
      { tenantId: input.tenantId, vertical: input.vertical },
      null,
      { binding: input.binding, kind: 'relational', ref },
    );
    return { binding: input.binding, kind: 'relational', ref };
  }

  openTenantStore(handle: TenantStoreHandle): TenantRelationalStore {
    // `ref` is platform-minted, but treat it as untrusted at the open boundary (parse,
    // don't trust): a bare filename only, so a crafted `ref` can never escape `this.dir`.
    if (handle.ref.includes('/') || handle.ref.includes('\\') || handle.ref.includes('..')) {
      throw new Error(`invalid tenant-store ref (must be a bare filename): ${handle.ref}`);
    }
    const db = this.tenantStoreDb(handle.ref);
    // Async wrappers over the sync driver: the CONTRACT is async (D1 is async on both
    // its worker-binding and HTTP paths), the pure adapter just resolves immediately.
    return {
      query: async <T = Record<string, SqlValue>>(
        sql: string,
        params: readonly SqlValue[] = [],
      ): Promise<T[]> => db.prepare(sql).all(...params) as T[],
      exec: async (sql: string, params: readonly SqlValue[] = []) => {
        const info = db.prepare(sql).run(...params);
        return { changes: info.changes };
      },
      native: db,
    };
  }

  /** Open (and cache) a per-tenant relational store file by its bare-filename `ref`. */
  private tenantStoreDb(ref: string): Database.Database {
    let db = this.tenantStoreDbs.get(ref);
    if (!db) {
      db = new Database(join(this.dir, ref));
      db.pragma('journal_mode = WAL');
      this.tenantStoreDbs.set(ref, db);
    }
    return db;
  }

  async provisionBlobStore(
    actor: PlatformActorId,
    input: BlobStoreProvisionInput,
  ): Promise<BlobStoreHandle> {
    // Same fail-closed tenant gate and (tenant, vertical, binding) idempotency as
    // provisionTenantStore (#301) — the blob store is the fourth store shape, not a
    // new lifecycle (#473).
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(input.tenantId) as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision blob store under unknown tenant: ${input.tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision blob store under non-active tenant (status: ${tenantRow.status}): ${input.tenantId}`,
      );
    }
    const existing = this.directory
      .prepare('SELECT ref FROM blob_stores WHERE tenant_id = ? AND vertical = ? AND binding = ?')
      .get(input.tenantId, input.vertical, input.binding) as { ref: string } | undefined;
    if (existing) {
      return { binding: input.binding, kind: 'blob', ref: existing.ref };
    }
    // The opaque `ref` is a bare directory name under `dir`, prefixed `blob__` so it can
    // never collide with a scope DB or a tenant store file. On Cloudflare the ref is an
    // R2 bucket name; here it is a per-tenant directory — the same file-per-unit grain
    // the scope DBs use, so the whole path runs in dev/CI without Cloudflare.
    const safeVertical = input.vertical.replace(/[^A-Za-z0-9_-]+/g, '-');
    const ref = `blob__${input.tenantId}__${safeVertical}__${input.binding}__${ulid()}`;
    mkdirSync(join(this.dir, ref), { recursive: true });
    this.directory
      .prepare(
        `INSERT INTO blob_stores (tenant_id, vertical, binding, kind, ref, created_at)
         VALUES (?, ?, ?, 'blob', ?, ?)`,
      )
      .run(input.tenantId, input.vertical, input.binding, ref, new Date().toISOString());
    this.recordAdmin(
      actor,
      'provisionBlobStore',
      { tenantId: input.tenantId, vertical: input.vertical },
      null,
      { binding: input.binding, kind: 'blob', ref },
    );
    return { binding: input.binding, kind: 'blob', ref };
  }

  /** A `TenantBlobStore` over the per-tenant directory a `ref` names (#473). Keys are
   *  platform-derived (`attachmentBlobKey`), but both `ref` and key are still guarded at
   *  the open boundary (parse, don't trust) so neither can escape `this.dir`. */
  private blobStore(ref: string): TenantBlobStore {
    if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) {
      throw new Error(`invalid blob-store ref (must be a bare directory name): ${ref}`);
    }
    const root = join(this.dir, ref);
    const resolveKey = (key: string): string => {
      if (key.startsWith('/') || key.includes('\\') || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        throw new Error(`invalid blob key: ${key}`);
      }
      return join(root, key);
    };
    const walk = (d: string, rel: string, out: string[]): void => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(d, e.name), r, out);
        else if (!e.name.endsWith('.meta')) out.push(r);
      }
    };
    return {
      put: async (key, body, opts) => {
        const p = resolveKey(key);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body);
        writeFileSync(`${p}.meta`, JSON.stringify({ contentType: opts?.contentType ?? null }));
      },
      get: async (key) => {
        const p = resolveKey(key);
        if (!existsSync(p)) return null;
        const body = new Uint8Array(readFileSync(p));
        let contentType: string | undefined;
        try {
          const meta = JSON.parse(readFileSync(`${p}.meta`, 'utf8')) as { contentType?: string | null };
          contentType = meta.contentType ?? undefined;
        } catch {
          // No sidecar (or unreadable): the caller falls back to the metadata row.
        }
        return contentType !== undefined ? { body, contentType } : { body };
      },
      delete: async (key) => {
        const p = resolveKey(key);
        rmSync(p, { force: true });
        rmSync(`${p}.meta`, { force: true });
      },
      list: async (prefix) => {
        const out: string[] = [];
        walk(root, '', out);
        return out.filter((k) => k.startsWith(prefix)).sort();
      },
    };
  }

  /** Resolve the blob store that carries a scope's attachments (#473): the platform-minted
   *  store for (tenant, the scope's vertical). Fails loudly when none was provisioned —
   *  the K-31 posture — and refuses ambiguity when several are, unless one is named
   *  ATTACHMENTS (the convention the deploy vocabulary documents). */
  private attachmentStore(tenantId: TenantId, vertical: string | null): TenantBlobStore {
    if (!vertical) {
      throw new Error('scope runs no vertical; attachments need the vertical\'s platform blob store (#473)');
    }
    const rows = this.directory
      .prepare('SELECT binding, ref FROM blob_stores WHERE tenant_id = ? AND vertical = ? ORDER BY binding')
      .all(tenantId, vertical) as { binding: string; ref: string }[];
    if (rows.length === 0) {
      throw new Error(
        `no blob store provisioned for (${tenantId}, ${vertical}) — declare runtimeNeeds.blobStores ` +
          `and provision it in the tenant lifecycle (provisionBlobStore, #473)`,
      );
    }
    const chosen = rows.length === 1 ? rows[0] : rows.find((r) => r.binding === 'ATTACHMENTS');
    if (!chosen) {
      throw new Error(
        `multiple blob stores provisioned for (${tenantId}, ${vertical}); name the one that ` +
          `carries attachments ATTACHMENTS`,
      );
    }
    return this.blobStore(chosen.ref);
  }

  async attachments(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeAttachments> {
    // Same fail-closed (tenantId, scopeId) pair + lifecycle gates + lazy-migration
    // retry as minting a stub — getScope IS that gate, so go through it.
    await this.getScope(principal, tenantId, scopeId);
    const rt = this.runtime(tenantId, scopeId);
    const scopeRow = this.directory
      .prepare('SELECT vertical FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { vertical: string | null } | undefined;
    const store = this.attachmentStore(tenantId, scopeRow?.vertical ?? null);
    return this.buildAttachments(rt, asPrincipal(principal), store);
  }

  /**
   * The attachment surface (#473) — `attachmentTargets` consumed at last. Metadata facts
   * live in `_substrat_attachments` inside the scope DB and move under the scope's strict
   * serialization, permission-checked as the ambient principal with the owning entity as
   * the per-entity ref, with a spine event in the same transaction. Bytes go straight to
   * the per-tenant blob store — never through the scope pipe (the issue's point).
   */
  private buildAttachments(
    rt: ScopeRuntime,
    subject: CheckSubject,
    store: TenantBlobStore,
    opts: { reentrant?: boolean; admitByEvent?: string } = {},
  ): ScopeAttachments {
    const targetGate = (entityType: string): { read: PermissionKey; write: PermissionKey } => {
      const gate = this.attachmentTargets.get(entityType);
      if (!gate) {
        throw new Error(
          `no registered module declares '${entityType}' in attachmentTargets — attachments bind ` +
            `only to declared entity types`,
        );
      }
      return gate;
    };
    const rowToRecord = (row: AttachmentRow): AttachmentRecord =>
      attachmentRecord.parse({
        id: row.id,
        entity: { entityType: row.entity_type, entityId: row.entity_id },
        filename: row.filename,
        contentType: row.content_type,
        size: row.size,
        sha256: row.sha256,
        visibility: row.visibility,
        createdBy: row.created_by,
        createdAt: row.created_at,
      });
    const sha256Hex = async (body: Uint8Array): Promise<string> => {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', body);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    // One attachment mutation/read = one serialized scope task, transactional exactly
    // like an operation invoke (including K-35 denial recording and prompt dispatch of
    // the events it emitted).
    const serialized = <T>(
      operation: string,
      fn: (ctx: OperationContext) => Promise<T>,
    ): Promise<T> =>
      rt.actor.enqueue(async () => {
        const ctx = this.operationContext(rt, subject);
        rt.db.exec('BEGIN IMMEDIATE');
        let result: T;
        try {
          result = await fn(ctx);
          rt.db.exec('COMMIT');
        } catch (err) {
          rt.db.exec('ROLLBACK');
          if (err instanceof PermissionDenied) this.recordDenial(rt, subject, operation, err);
          throw err;
        }
        await this.dispatch(rt);
        await this.dispatchExecutors(rt);
        return result;
      });

    /**
     * The REENTRANT runner (#711): no `enqueue`, no `BEGIN`. Used only for the
     * connector's dispatch-time read, which already runs inside the scope's actor
     * task — taking a second turn there is the deadlock `connector-reads.test.ts`
     * pins, and a transaction around a pure SELECT buys nothing that the enclosing
     * task's serialization has not already bought.
     *
     * Safe only for reads, which is why only reads are ever handed a surface built
     * this way: a write would need its own transaction and would emit a spine event
     * whose consumers must dispatch, and neither can happen here. A denial is still
     * recorded (K-35) — a fresh statement in autocommit, exactly as the serialized
     * runner does it after its ROLLBACK.
     */
    const reentrant = async <T>(
      operation: string,
      fn: (ctx: OperationContext) => Promise<T>,
    ): Promise<T> => {
      try {
        return await fn(this.operationContext(rt, subject));
      } catch (err) {
        if (err instanceof PermissionDenied) this.recordDenial(rt, subject, operation, err);
        throw err;
      }
    };

    const guarded = opts.reentrant ? reentrant : serialized;

    return {
      upload: async (input) => {
        const gate = targetGate(input.entity.entityType);
        const id = ulid();
        const key = attachmentBlobKey(rt.scopeId, id);
        const record = attachmentRecord.parse({
          id,
          entity: input.entity,
          filename: input.filename,
          contentType: input.contentType,
          size: input.body.byteLength,
          sha256: await sha256Hex(input.body),
          visibility: input.visibility,
          createdBy: subject.id,
          createdAt: new Date().toISOString(),
        });
        // Bytes first, row second: a crash between the two leaves an orphaned object
        // (harmless, GC-able via list), never a row without bytes. A refused check
        // compensates the object away below.
        await store.put(key, input.body, { contentType: input.contentType });
        try {
          return await guarded('attachments.upload', async (ctx) => {
            assertAllowed(await ctx.check(gate.write, input.entity));
            rt.db
              .prepare(
                `INSERT INTO _substrat_attachments
                   (id, entity_type, entity_id, filename, content_type, size, sha256,
                    visibility, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                record.id,
                record.entity.entityType,
                record.entity.entityId,
                record.filename,
                record.contentType,
                record.size,
                record.sha256,
                record.visibility,
                record.createdBy,
                record.createdAt,
              );
            ctx.emit({
              type: ATTACHMENT_ADDED,
              schemaVersion: 1,
              entity: input.entity,
              piiClass: 'none',
              payload: { attachment: record },
            });
            return record;
          });
        } catch (err) {
          await store.delete(key).catch(() => {});
          throw err;
        }
      },
      list: async (entity) => {
        const gate = targetGate(entity.entityType);
        return guarded('attachments.list', async (ctx) => {
          assertAllowed(await ctx.check(gate.read, entity));
          const rows = rt.db
            .prepare(
              `SELECT * FROM _substrat_attachments WHERE entity_type = ? AND entity_id = ?
               ORDER BY id DESC`,
            )
            .all(entity.entityType, entity.entityId) as AttachmentRow[];
          return rows.map(rowToRecord);
        });
      },
      open: async (attachmentId) => {
        const record = await guarded('attachments.open', async (ctx) => {
          const row = rt.db
            .prepare('SELECT * FROM _substrat_attachments WHERE id = ?')
            .get(attachmentId) as AttachmentRow | undefined;
          if (!row) return null;
          if (opts.admitByEvent !== undefined) {
            admitByDelivery(rt, opts.admitByEvent, row);
            return rowToRecord(row);
          }
          const gate = targetGate(row.entity_type);
          assertAllowed(
            await ctx.check(gate.read, { entityType: row.entity_type, entityId: row.entity_id }),
          );
          return rowToRecord(row);
        });
        if (!record) return null;
        const obj = await store.get(attachmentBlobKey(rt.scopeId, record.id));
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
        const removed = await guarded('attachments.remove', async (ctx) => {
          const row = rt.db
            .prepare('SELECT * FROM _substrat_attachments WHERE id = ?')
            .get(attachmentId) as AttachmentRow | undefined;
          if (!row) return null;
          const gate = targetGate(row.entity_type);
          assertAllowed(
            await ctx.check(gate.write, { entityType: row.entity_type, entityId: row.entity_id }),
          );
          rt.db.prepare('DELETE FROM _substrat_attachments WHERE id = ?').run(attachmentId);
          const record = rowToRecord(row);
          ctx.emit({
            type: ATTACHMENT_REMOVED,
            schemaVersion: 1,
            entity: record.entity,
            piiClass: 'none',
            payload: { attachment: record },
          });
          return record;
        });
        // Row (and event) first, bytes second: at worst an orphaned object, never a
        // dangling row.
        if (removed) await store.delete(attachmentBlobKey(rt.scopeId, removed.id)).catch(() => {});
        return removed;
      },
    };
  }

  async importScope(
    actor: PlatformActorId,
    input: ProvisionScopeInput,
    dump: ScopeDump,
  ): Promise<void> {
    // Create the destination scope (directory row + storage). Its migration step
    // creates some tables; the dump then replaces them wholesale, so the end state
    // is the dump, not whatever the local module set would have built. Provenance is
    // stamped from the dump unless the caller already set it (§3: a fork always
    // records where it came from).
    await this.provisionScope(actor, {
      ...input,
      forkedFrom: input.forkedFrom ?? (dump.scopeId as ScopeId),
      forkedAt: input.forkedAt ?? dump.capturedAt,
    });
    this.loadDump(input.tenantId, input.scopeId, dump.tables);
    await this.admin.activateScope(actor, input.tenantId, input.scopeId);
    this.recordAdmin(
      actor,
      'importScope',
      { tenantId: input.tenantId, scopeId: input.scopeId },
      null,
      { sourceScopeId: dump.scopeId, tables: dump.tables.length, capturedAt: dump.capturedAt },
    );
  }

  /** Drop-then-replay a dump into a scope's db, refreshing the migration frontier. */
  private loadDump(tenantId: TenantId, scopeId: ScopeId, tables: ScopeDumpTable[]): void {
    const rt = this.runtime(tenantId, scopeId);
    const db = rt.db;
    const load = db.transaction((dumped: ScopeDumpTable[]) => {
      // Deferred foreign keys cover the WHOLE drop-then-replay, drops included.
      //
      // Two distinct FK hazards, and the second is why this cannot wrap the inserts alone:
      //
      //  - Replay order. A dump is ordered by table NAME, which says nothing about foreign
      //    keys: a vertical whose child sorts before its parent (`crm_bank_accounts` before
      //    `crm_vendors`) would fail on its first insert.
      //  - THE DROPS. `DROP TABLE` performs an implicit `DELETE FROM`, so dropping a parent
      //    while a child table still holds rows raises `FOREIGN KEY constraint failed`
      //    before any replacement row exists. This bites only when the TARGET already has
      //    data — an empty scope drops cleanly, a populated one does not, and overwriting
      //    real data is the whole point of restore.
      //
      // Deferral holds every check until this transaction commits, by which point the old
      // rows are gone and the new ones are in. It also covers what a topological sort
      // cannot express: FK cycles, and self-referencing rows within one table.
      db.pragma('defer_foreign_keys = ON');
      // Drop the current schema — the dump's schema is authoritative. Only real
      // tables (never `sqlite_*` internals, which are auto-managed and un-droppable).
      const existing = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[];
      // Search index tables are left alone here and rebuilt below (#827). Dropping a
      // shadow table directly is an error, and dropping them in `sqlite_master` order
      // would reach one before its virtual table.
      for (const { name } of existing) {
        if (isSearchIndexTable(name)) continue;
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
      // A dump written before indexes were excluded may still carry them; skip those
      // too rather than failing a restore over data that is about to be recomputed.
      const replayable = dumped.filter((t) => !isSearchIndexTable(t.name));
      for (const t of replayable) db.exec(t.ddl);
      for (const t of replayable) {
        if (t.rows.length === 0) continue;
        const cols = t.columns.map((c) => `"${c}"`).join(', ');
        const placeholders = t.columns.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO "${t.name}" (${cols}) VALUES (${placeholders})`);
        for (const row of t.rows) stmt.run(...(row as unknown[]));
      }
      // Re-assert the per-scope kernel spine (#321): a partial dump (or one from a world
      // that stores some `_substrat_*` tables elsewhere) may omit spine tables this scope
      // must have — e.g. `_substrat_migrations`, which the frontier refresh below reads.
      // KERNEL_DDL is all IF NOT EXISTS, so it fills only the gaps and never disturbs a
      // table the dump carried.
      db.exec(KERNEL_DDL);
      // Rebuild the derived search indexes over the rows just loaded (#827). The DDL
      // drops and recreates, so this also repairs an index the dump left stale, and
      // the triggers it recreates are what keep the restored scope in step from here.
      // Skipped for a plan whose content table this dump did not carry — a restore
      // must not invent a table for an index to point at.
      const present = new Set(
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      for (const plan of this.searchPlans.values()) {
        if (present.has(plan.table)) db.exec(searchIndexDdl(plan));
      }
      // Re-point scope-level grants at the scope they now live in. They are written as
      // `object = scope:<scopeId>`, so a fork, a restore into a different scope, or #286's
      // migration onto a stable script name all land rows naming a scope that is not this
      // one. Nothing errors — the rows insert fine — but the proof walk never matches them,
      // so `/me` reports a role while every `ctx.check` denies. Entity-level grants
      // (`object = customer:<id>`) are untouched: those ids travel with the dump.
      // `UPDATE OR REPLACE` because (subject, relation, object) is the primary key — a
      // rewritten row collapses onto an existing one rather than failing the restore.
      db.prepare(
        `UPDATE OR REPLACE _substrat_tuples SET object = ?
          WHERE object LIKE 'scope:%' AND object <> ?`,
      ).run(`scope:${scopeId}`, `scope:${scopeId}`);
    });
    load(tables);
    // The frontier came in with the dump — refresh the cached applied-migration set so
    // a later bind/migrate builds on the loaded state, not the previous one.
    rt.appliedMigrations.clear();
    for (const r of db.prepare('SELECT module_id, version FROM _substrat_migrations').all() as {
      module_id: string;
      version: string;
    }[]) {
      rt.appliedMigrations.add(`${r.module_id}@${r.version}`);
    }
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
    this.loadDump(tenantId, scopeId, dump.tables);
    this.recordAdmin(
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
    // Close and evict the runtime handle before touching the file.
    const key = `${tenantId}/${scopeId}`;
    const rt = this.scopes.get(key);
    if (rt) {
      rt.db.close();
      this.scopes.delete(key);
      this.scopesById.delete(scopeId);
    }
    // Order is the retry story: hostnames first (a reaped preview URL must stop
    // resolving), then the STORAGE, then the directory row — so a crash mid-way leaves
    // a visible row over empty storage (re-running deleteSnapshot converges), never
    // orphaned bytes with no record (the §9 hazard).
    this.directory.prepare('DELETE FROM hostnames WHERE scope_id = ?').run(scopeId);
    rmSync(join(this.dir, `${tenantId}__${scopeId}.sqlite`), { force: true });
    this.directory.prepare('DELETE FROM scopes WHERE scope_id = ?').run(scopeId);
    this.recordAdmin(actor, 'deleteSnapshot', { tenantId, scopeId }, null, {
      forkedFrom: rec.forkedFrom,
      forkedAt: rec.forkedAt,
      expiresAt: rec.expiresAt,
      kind: rec.kind,
    });
  }

  async getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ScopeStub> {
    const row = this.directory
      .prepare('SELECT tenant_id, status FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string; status: string } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }

    // Lifecycle gates (control-plane.md §4.1/§4.2), all the K-3 fail-closed path.
    // The tenant record is mandatory: every scope has a tenant with a status
    // (provisioning enforces it), so a missing one is corruption, not a legacy
    // scope. A non-active tenant fails every scope under it; a non-active scope
    // fails on its own — this is what makes suspend/archive actually contain.
    const tenantRow = this.directory
      .prepare('SELECT status FROM tenants WHERE tenant_id = ?')
      .get(tenantId) as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`scope has no tenant record: (${tenantId}, ${scopeId})`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(`tenant not active (status: ${tenantRow.status}): ${tenantId}`);
    }
    // `provisioning` is handled BELOW rather than here, because a scope that never
    // finished setting up should still retry its migrations when touched — that lazy
    // retry, and the attempt counter a sweep backs off from, are the only self-healing
    // there is until #49 exists. `suspended` and `archived` are different: they are
    // deliberate states, and running migrations for them would be work on behalf of a
    // request that is going to be refused anyway.
    if (row.status !== 'active' && row.status !== 'provisioning') {
      throw new Error(`scope not active (status: ${row.status}): ${scopeId}`);
    }

    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);

    if (row.status !== 'active') {
      // Migrations passed and it is still `provisioning`, so nothing has confirmed
      // the scope exists on the vertical's side (K-31). Refused, but only after the
      // retry above has had its chance — and if THAT is what failed, it threw with
      // the migration's own message, which is the one an operator needs.
      throw new Error(`scope not active (status: ${row.status}): ${scopeId}`);
    }
    return this.buildStub(tenantId, scopeId, rt, asPrincipal(principal), options);
  }

  /**
   * A scope stub whose authority is a CONNECTION (#97).
   *
   * Three gates, all inherited from what the connection already is rather than
   * declared again: the connection must be live, the scope must belong to its
   * tenant, and the scope must run its vertical. A leaked provider token
   * therefore reaches exactly the scopes that connection was for — the
   * isolation the (tenant, vertical, provider) key already asserts, enforced at
   * the only door that could have widened it.
   *
   * What the connection may then DO is an ordinary permission check against
   * `connection:<id>` grants. One enforcement path, one place to read it, one
   * way to revoke it.
   */
  async getConnectorScope(connectionId: ConnectionId, scopeId: ScopeId): Promise<ScopeStub> {
    const conn = this.connectionRow(connectionId);
    if (conn.revoked_at) {
      throw new Error(`connection ${connectionId} is revoked`);
    }
    const scope = this.directory
      .prepare('SELECT tenant_id, vertical, status FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string; vertical: string | null; status: string } | undefined;
    if (!scope || scope.tenant_id !== conn.tenant_id) {
      // Same wording as the principal path: a scope in another tenant is
      // indistinguishable from one that does not exist.
      throw new Error(`unknown scope for connection: ${scopeId}`);
    }
    if (scope.vertical !== conn.vertical) {
      throw new Error(
        `connection ${connectionId} is for vertical '${conn.vertical}' and scope ${scopeId} ` +
          `runs '${scope.vertical ?? 'none'}'`,
      );
    }
    if (scope.status !== 'active') {
      throw new Error(`scope not active (status: ${scope.status}): ${scopeId}`);
    }
    const rt = this.runtime(conn.tenant_id as TenantId, scopeId);
    await this.applyPendingMigrations(rt);
    return this.buildStub(conn.tenant_id as TenantId, scopeId, rt, {
      kind: 'connection',
      id: connectionId,
    });
  }

  async getConnectorAttachments(
    connectionId: ConnectionId,
    scopeId: ScopeId,
  ): Promise<ScopeAttachments> {
    // The exact door `getConnectorScope` opens — same (tenant, vertical, active)
    // gate — but it returns the attachment surface instead of the invoke stub, with
    // every gate checked as the connection rather than a principal (#476).
    const conn = this.connectionRow(connectionId);
    if (conn.revoked_at) {
      throw new Error(`connection ${connectionId} is revoked`);
    }
    const scope = this.directory
      .prepare('SELECT tenant_id, vertical, status FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string; vertical: string | null; status: string } | undefined;
    if (!scope || scope.tenant_id !== conn.tenant_id) {
      throw new Error(`unknown scope for connection: ${scopeId}`);
    }
    if (scope.vertical !== conn.vertical) {
      throw new Error(
        `connection ${connectionId} is for vertical '${conn.vertical}' and scope ${scopeId} ` +
          `runs '${scope.vertical ?? 'none'}'`,
      );
    }
    if (scope.status !== 'active') {
      throw new Error(`scope not active (status: ${scope.status}): ${scopeId}`);
    }
    const rt = this.runtime(conn.tenant_id as TenantId, scopeId);
    await this.applyPendingMigrations(rt);
    const store = this.attachmentStore(conn.tenant_id as TenantId, scope.vertical);
    return this.buildAttachments(rt, { kind: 'connection', id: connectionId }, store);
  }

  async getSystemScope(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeStub> {
    // The scheduler's door (#383) — mirror of getConnectorScope. The module must be
    // registered on this host (a schedule can only invoke its own vertical's ops),
    // and the scope must be active. Authority is then an ordinary check against
    // `system:<moduleId>` grants inside the stub; nothing here is a person.
    if (!this.modules.has(moduleId)) {
      throw new Error(`module not registered on this host: ${moduleId}`);
    }
    const scope = this.directory
      .prepare('SELECT tenant_id, status FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string; status: string } | undefined;
    if (!scope || scope.tenant_id !== tenantId) {
      throw new Error(`unknown scope: ${scopeId}`);
    }
    if (scope.status !== 'active') {
      throw new Error(`scope not active (status: ${scope.status}): ${scopeId}`);
    }
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    return this.buildStub(tenantId, scopeId, rt, { kind: 'system', id: moduleId });
  }

  registeredSchedules(): ScheduleRegistration[] {
    const out: ScheduleRegistration[] = [];
    for (const mod of this.modules.values()) {
      if (mod.schedules.length > 0) {
        out.push({ moduleId: mod.id as ModuleId, schedules: mod.schedules });
      }
    }
    return out;
  }

  async runDueSchedules(
    moduleId: ModuleId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScheduleRunReport> {
    const report: ScheduleRunReport = { fired: 0, skipped: 0, failed: 0, errors: [] };
    const mod = this.modules.get(moduleId);
    if (!mod || mod.schedules.length === 0) return report;

    // The scope must be a live scope of this host. A non-active or missing scope is
    // not this driver's problem to raise — it simply has nothing due (the sweep
    // already enumerated `active` scopes; this guards a race where one archived
    // between enumeration and here).
    const scope = this.directory
      .prepare('SELECT status FROM scopes WHERE scope_id = ? AND tenant_id = ?')
      .get(scopeId, tenantId) as { status: string } | undefined;
    if (!scope || scope.status !== 'active') return report;

    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    // The grant IS the switch (#383): a scope runs a module's schedules only while it
    // holds a live `system:<moduleId>` grant. This is what makes a foreign-vertical
    // scope (one this module was never provisioned on) a quiet no-op, and what makes
    // "disable scheduling for this tenant" a plain grant revoke — no error, no run.
    const nowIso = new Date().toISOString();
    const hasGrant = rt.db
      .prepare(
        `SELECT 1 FROM _substrat_tuples
          WHERE subject = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
          LIMIT 1`,
      )
      .get(`system:${moduleId}`, nowIso);
    if (!hasGrant) return report;
    // The spine state table is created lazily on first sweep of a scope — it is
    // kernel-owned (`_substrat_*`), never in a module migration.
    rt.db.exec(
      `CREATE TABLE IF NOT EXISTS _substrat_schedule_state (
         schedule_op TEXT PRIMARY KEY,
         last_run_at TEXT,
         last_status TEXT
       )`,
    );

    const now = Date.now();
    for (const schedule of mod.schedules) {
      const row = rt.db
        .prepare('SELECT last_run_at FROM _substrat_schedule_state WHERE schedule_op = ?')
        .get(schedule.operation) as { last_run_at: string | null } | undefined;
      const lastRun = row?.last_run_at ? Date.parse(row.last_run_at) : null;
      const dueAt = lastRun === null ? -Infinity : lastRun + schedule.cadence.everyMinutes * 60_000;
      if (now < dueAt) {
        report.skipped += 1;
        continue;
      }
      // Due — invoke through the system door (a fresh stub per schedule keeps the
      // K-34 authorization accumulator clean, and the door re-checks the scope).
      let status: 'ok' | 'failed' = 'ok';
      try {
        const stub = await this.getSystemScope(moduleId, tenantId, scopeId);
        await stub.invoke(schedule.operation, schedule.input);
        report.fired += 1;
      } catch (err) {
        status = 'failed';
        report.failed += 1;
        report.errors.push({
          operation: schedule.operation,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      rt.db
        .prepare(
          `INSERT INTO _substrat_schedule_state (schedule_op, last_run_at, last_status)
             VALUES (?, ?, ?)
           ON CONFLICT(schedule_op) DO UPDATE SET last_run_at = excluded.last_run_at,
                                                  last_status = excluded.last_status`,
        )
        .run(schedule.operation, new Date(now).toISOString(), status);
    }
    return report;
  }

  /** The stub body, shared by the principal and connection doors. */
  private buildStub(
    tenantId: TenantId,
    scopeId: ScopeId,
    rt: ScopeRuntime,
    subject: CheckSubject,
    options?: ScopeStubOptions,
  ): ScopeStub {
    const operations = this.operations;

    return {
      tenantId,
      scopeId,
      invoke: async <O, I>(operation: string, input?: I): Promise<O> => {
        const handler = operations.get(operation);
        if (!handler) return Promise.reject(new Error(`unknown operation: ${operation}`));
        // Entitlement gate (control-plane.md §4.3): a module loads for a tenant
        // only if the tenant holds its SKU flag. Checked per invoke — the simple,
        // uncached path (K-OQ5); a DO-cached variant is a later benchmark call.
        // Fails closed the same way withdrawal does: the operation is unavailable.
        const requiredKey = this.operationEntitlement.get(operation);
        if (requiredKey && !this.tenantHoldsEntitlement(tenantId, requiredKey)) {
          return Promise.reject(
            new Error(
              entitlementDenial(operation, requiredKey, this.heldEntitlements(tenantId)),
            ),
          );
        }
        // #458: per-invoke tally of `ctx.requestPlatform` calls. Reported to the
        // harness only after the enqueue task resolves — i.e. after COMMIT — so a
        // rolled-back intent never signals.
        const signals = { platformRequests: 0 };
        const invoked = await rt.actor.enqueue(async () => {
          // Fresh per operation: the context carries the K-34 authorization accumulator,
          // which must not leak across operations (invokes are serialized per scope).
          const ctx = this.operationContext(rt, subject, undefined, signals);
          const clonedInput = structuredClone(input);
          // #893: parse, don't trust — at the scope door, from the operation's own
          // declaration. BEFORE `BEGIN`, so a malformed call never opens a
          // transaction, and before the guards, so a K-17 pre-condition reads the
          // same typed input the handler will.
          //
          // Every caller passes here: the HTTP mount, a scenario test, a seed, a
          // schedule. That is the point — parsing at the mount alone would leave
          // the demos' own suites exercising an unparsed path, and the wire is
          // where the untrusted input actually arrives.
          const parsed = this.operationInput.has(operation)
            ? (this.operationInput.get(operation) as { parse(v: unknown): unknown }).parse(clonedInput)
            : clonedInput;
          rt.db.exec('BEGIN IMMEDIATE');
          let result: O;
          try {
            // Manifest guards (K-17): pre-conditions, inside the operation's own
            // transaction, before the handler. A throw here blocks the operation
            // and rolls back exactly like a handler throw — fail closed.
            await this.runGuards(operation, ctx, parsed as I | undefined);
            result = await (handler as OperationHandler<I | undefined, O>)(ctx, parsed as I | undefined);
            rt.db.exec('COMMIT');
          } catch (err) {
            rt.db.exec('ROLLBACK');
            // K-35: a refused check rolled the operation back. Record it now — a fresh
            // statement in autocommit, AFTER the rollback, so the denial survives it.
            if (err instanceof PermissionDenied) this.recordDenial(rt, subject, operation, err);
            throw err;
          }
          // Post-commit, still inside the actor task: drain outbox → consumers,
          // then → executors. Prompt dispatch (K-22 §4.2): the common case
          // completes inside this request, with the outbox as the retry backstop
          // if it does not.
          await this.dispatch(rt);
          await this.dispatchExecutors(rt);
          return structuredClone(result);
        });
        if (signals.platformRequests > 0) options?.onPlatformRequests?.(signals.platformRequests);
        return invoked;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Manifest-declared operation guards (K-17; engine-protocol.md §6, kernel-
  // design open question 11). Guards are keyed on OPERATIONS, never on engine
  // transitions: the kernel sees operations and must not learn engine
  // internals. They are UNCONDITIONAL gates — policy that depends on vertical
  // data stays vertical-composed glue inside the operation handler.
  // -------------------------------------------------------------------------

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
        // Fail closed: a guard whose predicate cannot be resolved blocks the
        // operation. A dropped/misspelled predicate can never widen a gate.
        throw new Error(
          `unknown guard predicate: '${guard.predicate}' — declared by ${guard.declaredBy} ` +
            `before '${operation}'; no registered module contributes it (operation blocked)`,
        );
      }
      await predicate.handler(ctx, guard.config, input);
    }
  }

  async close(): Promise<void> {
    for (const { db } of this.scopes.values()) db.close();
    this.scopes.clear();
    this.scopesById.clear();
    this.directory.close();
  }

  // -------------------------------------------------------------------------
  // Event dispatch (testrun spec §9.2.3): at-least-once, kernel-journaled,
  // consumers run as system-actor operations in their own transactions.
  // -------------------------------------------------------------------------

  /**
   * Run executors over this scope's outbox (K-22 §4.2) — the connector half of the
   * seam. Same at-least-once journal as consumers, keyed on a distinct delivery id
   * so an executor and a module consumer on the same event do not shadow each other.
   *
   * Runs OUTSIDE the scope's transaction, and deliberately so: the executor acts on
   * the directory, which is not part of the scope's serialization domain. The
   * atomicity that matters already happened — the event only exists because the
   * emitting transaction committed.
   *
   * **Failure is contained here (#100), three ways.** A throwing handler used to
   * escape `invoke()` after COMMIT, so a caller saw an error for work that had in
   * fact succeeded; it now records a failed attempt and returns. Failures back off
   * rather than re-running on every dispatch, so a permanently-poisoned event no
   * longer re-runs its side effects at request rate. And each event and each
   * executor is isolated, so one bad delivery cannot wedge the ones behind it —
   * which the old `ORDER BY o.id` loop did, permanently.
   *
   * At-least-once still requires idempotent handlers. Retry is the backstop, not a
   * substitute.
   */
  private async dispatchExecutors(rt: ScopeRuntime): Promise<ExecutorDrainReport> {
    const report: ExecutorDrainReport = {
      attempted: 0,
      delivered: 0,
      retrying: 0,
      deadLettered: 0,
    };
    const now = new Date().toISOString();
    for (const [id, executor] of this.executors) {
      const deliveryId = `executor:${id}`;
      // Due = never attempted, or retrying and past its next attempt time.
      // Terminal rows (next_attempt_at IS NULL) are excluded by the join.
      const rows = rt.db
        .prepare(
          `SELECT o.* FROM _substrat_outbox o
           LEFT JOIN _substrat_deliveries d
             ON d.event_id = o.id AND d.consumer_module = ?
           WHERE o.type = ?
             AND (d.event_id IS NULL
                  OR (d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?))
           ORDER BY o.id`,
        )
        .all(deliveryId, executor.eventType, now) as OutboxRow[];

      for (const row of rows) {
        const event = this.parseOutboxRow(row);
        report.attempted += 1;
        this.causedBy = event.id;
        try {
          if (executor.kind === 'connector') {
            // `true`: dispatchExecutors is only ever reached from inside
            // `rt.actor.enqueue` (invoke's post-commit tail, or drainDue).
            await executor.handler(this.connectorContext(rt, executor.timeoutMs, true, event.id), event);
          } else {
            await executor.handler(this.admin, event);
          }
          this.recordExecutorDelivery(rt, row.id, deliveryId, null, executor.retry);
          report.delivered += 1;
        } catch (err) {
          const dead = this.recordExecutorDelivery(
            rt,
            row.id,
            deliveryId,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
            executor.retry,
          );
          if (dead) report.deadLettered += 1;
          else report.retrying += 1;
        } finally {
          this.causedBy = null;
        }
      }
    }
    return report;
  }

  /**
   * Journal one executor attempt. Returns true when this attempt was the last one
   * — i.e. the delivery is now dead-lettered.
   *
   * Written AFTER the handler ran, so a crash mid-effect retries rather than
   * silently marking success. Claiming first would make delivery at-most-once and
   * lose an effect on any crash in between.
   */
  private recordExecutorDelivery(
    rt: ScopeRuntime,
    eventId: string,
    deliveryId: string,
    error: string | null,
    retry: Required<ExecutorRetryPolicy>,
  ): boolean {
    const prior =
      (
        rt.db
          .prepare(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
          )
          .get(eventId, deliveryId) as { attempts: number } | undefined
      )?.attempts ?? 0;
    const attempts = prior + 1;
    const exhausted = attempts >= retry.maxAttempts;
    // Terminal on success or on exhaustion; otherwise schedule the next attempt.
    const nextAttemptAt =
      error === null || exhausted ? null : backoffAt(attempts, retry, new Date());
    rt.db
      .prepare(
        `INSERT INTO _substrat_deliveries
           (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, consumer_module) DO UPDATE SET
           delivered_at = excluded.delivered_at,
           error = excluded.error,
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at`,
      )
      .run(eventId, deliveryId, new Date().toISOString(), error, attempts, nextAttemptAt);
    return error !== null && exhausted;
  }

  async drainDue(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDrainReport> {
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    return rt.actor.enqueue(() => this.dispatchExecutors(rt));
  }

  async dispatchConnector(
    tenantId: TenantId,
    scopeId: ScopeId,
    handler: ConnectorHandler,
    event: DomainEvent,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    // The platform half of a routed `connector:<provider>` intent (#574 phase 3): run
    // ONE delivery with this host's directory, credentials and egress, no journal — the
    // intent row the caller settles is the journal. This adapter always holds its own
    // directory, so a node control plane can drain routed intents exactly as the
    // Cloudflare one does; the context build is the same one `dispatchExecutors` hands
    // an in-process connector.
    const rt = this.runtime(tenantId, scopeId);
    this.causedBy = event.id;
    try {
      // `false`: this path deliberately does NOT enqueue, so nothing is held and
      // the connection's reads take an ordinary serialized turn.
      await handler(this.connectorContext(rt, options?.timeoutMs ?? 30_000, false, event.id), event);
    } finally {
      this.causedBy = null;
    }
  }

  /**
   * The scope's own answer to "what may this connection do here" (#726 gap 1) — read
   * from the delivered `connection:<id>` tuples, which is the same row the checker
   * walks, so this cannot disagree with what would be enforced.
   *
   * Live only: a tombstoned tuple (K-21) and one past `expires_at` are both unenforced,
   * and reporting either would make the read a worse answer than no read at all.
   */
  async connectionGrantsInScope(
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ProjectedConnectionGrant[]> {
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    const now = new Date().toISOString();
    // BOTH tuple stores, because a scope check consults both: rule 2 inheritance means
    // a tenant-level grant (`grantToConnection` with `scopeId: null`) is enforced here
    // exactly as a scope-level one is. Reading only the scope's own table would answer
    // "not granted" where the checker answers allow — a read-back that disagrees with
    // enforcement is worse than none, since it is the read an operator would trust.
    const rows = [
      ...(rt.db
        .prepare(
          `SELECT subject, relation, expires_at FROM _substrat_tuples
           WHERE subject LIKE 'connection:%' AND relation LIKE 'granted:%'
             AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .all(now) as TupleReadRow[]),
      ...(this.directory
        .prepare(
          `SELECT subject, relation, expires_at FROM _substrat_tenant_tuples
           WHERE tenant_id = ? AND subject LIKE 'connection:%' AND relation LIKE 'granted:%'
             AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .all(tenantId, now) as TupleReadRow[]),
    ].sort((a, b) => a.subject.localeCompare(b.subject) || a.relation.localeCompare(b.relation));
    return rows.map((r) =>
      projectedConnectionGrant.parse({
        connectionId: r.subject.slice('connection:'.length),
        permission: r.relation.slice('granted:'.length),
        ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
      }),
    );
  }

  migrationFrontier(): MigrationFrontier {
    let total = 0;
    for (const mod of this.modules.values()) total += mod.migrations.length;
    return { total };
  }

  /**
   * The reconciliation sweep's wake + retry (kernel-design §5.3, #49). Reuses
   * `applyPendingMigrations` — the one place migrations apply, so the journal,
   * the directory projection and the attempt counter behave exactly as a lazy
   * wake — but converts the outcome to a structured result: the sweep reports
   * and backs off, it does not catch exceptions to guess at states. The wake
   * paths (`getScope`, `invoke`) keep their throw, so operations on a failed
   * scope still fail closed.
   */
  async migrateScope(tenantId: TenantId, scopeId: ScopeId): Promise<MigrateScopeOutcome> {
    const row = this.directory
      .prepare('SELECT tenant_id, status FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string; status: string } | undefined;
    // K-3: a scope under another tenant is indistinguishable from one that does not exist.
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    // `provisioning` allowed — a scope stuck there on a failed migration is a
    // sweep target. Suspended/archived are deliberate states; not disturbed.
    if (row.status !== 'active' && row.status !== 'provisioning') {
      throw new Error(`scope not migratable (status: ${row.status}): ${scopeId}`);
    }
    const rt = this.runtime(tenantId, scopeId);
    // Nothing pending FOR THIS HOST → noop, and deliberately no state write: a
    // host that does not run the scope's modules must never clear (or overwrite)
    // a failure recorded by the deployment that does.
    let pending = false;
    for (const mod of this.modules.values()) {
      for (const migration of mod.migrations) {
        if (!rt.appliedMigrations.has(`${mod.id}@${migration.version}`)) pending = true;
      }
    }
    if (!pending) return { status: 'noop' };
    try {
      await this.applyPendingMigrations(rt);
      return { status: 'migrated', schemaVersion: String(rt.appliedMigrations.size) };
    } catch {
      // `applyPendingMigrations` already projected the failure (finally-path);
      // read back what it recorded rather than re-deriving it here.
      const f = this.directory
        .prepare(
          'SELECT migration_failed_version, migration_error FROM scopes WHERE scope_id = ?',
        )
        .get(scopeId) as
        | { migration_failed_version: string | null; migration_error: string | null }
        | undefined;
      return {
        status: 'failed',
        failure: {
          version: f?.migration_failed_version ?? 'unknown',
          error: f?.migration_error ?? 'migration failed',
        },
      };
    }
  }

  async executorDeadLetters(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDeadLetter[]> {
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    const rows = rt.db
      .prepare(
        `SELECT d.event_id, d.consumer_module, d.attempts, d.error, d.delivered_at, o.type
         FROM _substrat_deliveries d
         JOIN _substrat_outbox o ON o.id = d.event_id
         WHERE d.consumer_module LIKE 'executor:%'
           AND d.error IS NOT NULL
           AND d.next_attempt_at IS NULL
         ORDER BY d.event_id`,
      )
      .all() as {
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

  async listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]> {
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    const rows = rt.db
      .prepare(
        `SELECT ${PLATFORM_REQUEST_COLUMNS}
           FROM _substrat_platform_requests WHERE status = 'pending' ORDER BY id`,
      )
      .all() as PlatformRequestRawRow[];
    return rows.map(rowToPlatformRequest);
  }

  async listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]> {
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    const q = platformRequestHistoryQuery(filter);
    return (rt.db.prepare(q.sql).all(...q.params) as PlatformRequestRawRow[]).map(
      rowToPlatformRequest,
    );
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
    const rt = this.runtime(tenantId, scopeId);
    await this.applyPendingMigrations(rt);
    await rt.actor.enqueue(() => {
      rt.db
        .prepare(
          `UPDATE _substrat_platform_requests
             SET status = ?, result = COALESCE(?, result), last_error = ?, last_failure = ?,
                 attempts = attempts + 1, settled_at = ?
           WHERE id = ?`,
        )
        .run(
          outcome.status,
          outcome.result === undefined ? null : JSON.stringify(outcome.result),
          outcome.lastError ?? null,
          outcome.failure == null ? null : JSON.stringify(outcome.failure),
          outcome.status === 'pending' ? null : new Date().toISOString(),
          id,
        );
    });
  }

  private async dispatch(rt: ScopeRuntime): Promise<void> {
    for (let round = 0; round < 50; round++) {
      let deliveredAny = false;
      for (const mod of this.modules.values()) {
        for (const consumer of mod.consumers) {
          const rows = rt.db
            .prepare(
              `SELECT * FROM _substrat_outbox o
               WHERE o.type = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM _substrat_deliveries d
                   WHERE d.event_id = o.id AND d.consumer_module = ?
                 )
               ORDER BY o.id`,
            )
            .all(consumer.eventType, mod.id) as OutboxRow[];
          for (const row of rows) {
            const event = this.parseOutboxRow(row);
            const ctx = this.operationContext(rt, asPrincipal(this.systemPrincipal), {
              system: mod.id,
            });
            rt.db.exec('BEGIN IMMEDIATE');
            try {
              await consumer.handler(ctx, event);
              rt.db
                .prepare(
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at)
                   VALUES (?, ?, ?)`,
                )
                .run(event.id, mod.id, new Date().toISOString());
              rt.db.exec('COMMIT');
              deliveredAny = true;
            } catch (err) {
              rt.db.exec('ROLLBACK');
              // Dead-letter (v0): journal the failure so one poison event
              // can't wedge the loop. Real redelivery/backoff is a later cut.
              rt.db
                .prepare(
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error)
                   VALUES (?, ?, ?, ?)`,
                )
                .run(event.id, mod.id, new Date().toISOString(), String(err));
            }
          }
        }
      }
      if (!deliveredAny) return;
    }
  }

  /**
   * K-35: record a refused check into the scope's denial log. Called from the invoke
   * catch AFTER `ROLLBACK`, so this INSERT runs in autocommit and survives — the whole
   * point, since the denial is exactly the write the rolled-back operation could not make.
   */
  private recordDenial(
    rt: ScopeRuntime,
    subject: CheckSubject,
    operation: string,
    err: PermissionDenied,
  ): void {
    // Only an ENFORCED denial (assertAllowed, which attaches the checked permission +
    // node) is recorded. A module's own hand-thrown `new PermissionDenied('…')` is its
    // policy, carries no permission key, and is left to the module.
    if (!err.permission || !err.node) return;
    const actor =
      subject.kind === 'system'
        ? { system: subject.id }
        : subject.kind === 'connection'
          ? { connection: subject.id }
          : (subject.id as PrincipalId);
    rt.db
      .prepare(
        `INSERT INTO _substrat_denials
           (id, actor, permission, tenant_id, scope_id, operation, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        JSON.stringify(actor),
        err.permission,
        err.node.tenantId,
        err.node.scopeId ?? null,
        operation,
        new Date().toISOString(),
      );
  }

  private parseOutboxRow(row: OutboxRow): DomainEvent {
    return domainEvent.parse({
      id: row.id,
      type: row.type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      tenantId: row.tenant_id,
      scopeId: row.scope_id,
      actor: JSON.parse(row.actor),
      entity: { entityType: row.entity_type, entityId: row.entity_id },
      piiClass: row.pii_class,
      ...(row.subject_id ? { subjectId: row.subject_id } : {}),
      ...(row.authorization ? { authorization: JSON.parse(row.authorization) } : {}),
      payload: row.payload === null ? undefined : JSON.parse(row.payload),
    });
  }

  // -------------------------------------------------------------------------
  // Admin surface (enforcement input, §9.2.5)
  // -------------------------------------------------------------------------

  /**
   * The single audit choke point (control-plane.md §4.4). EVERY control-plane
   * mutation — here and `provisionScope` — routes through this one method, so
   * "no mutation without a durable record" holds by construction rather than by
   * remembering a call per method. `before` is captured only where cheaply
   * readable; idempotent upserts with no cheap prior state pass `before: null`.
   */
  /**
   * Record a staff read (K-24). Called by every read on `HostAdmin`, which is why
   * they all take an actor: a read the log cannot attribute is unrepresentable.
   *
   * `params` is a bounded summary, not the raw filter — enough to know what was
   * asked, capped so one query cannot write an unbounded row.
   */
  private recordAccess(
    actor: PlatformActorId,
    method: string,
    target: { tenantId?: TenantId | null; scopeId?: ScopeId | null },
    params: unknown,
    resultCount: number,
  ): void {
    const summary = params == null ? null : JSON.stringify(params).slice(0, 500);
    this.directory
      .prepare(
        `INSERT INTO _substrat_access_log
           (id, actor, method, tenant_id, scope_id, params, result_count, drained_at, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        ulid(),
        actor,
        method,
        target.tenantId ?? null,
        target.scopeId ?? null,
        summary,
        resultCount,
        new Date().toISOString(),
      );
  }

  /**
   * K-3's cross-check on its own: the (tenant, scope) pair must exist and agree before a
   * subject-key operation touches anything. `scopeDbFor` already does this for calls that
   * need the scope FILE; sealing and opening need only the directory, and skipping the
   * check there would let a caller reach another tenant's keys by naming their scope id.
   */
  private assertScope(tenantId: TenantId, scopeId: ScopeId): void {
    const rec = this.directory
      .prepare('SELECT tenant_id FROM scopes WHERE scope_id = ?')
      .get(scopeId) as { tenant_id: string } | undefined;
    if (!rec || rec.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
  }

  /**
   * This scope's per-subject keys (#37). The crypto lives in the kernel
   * (`createSubjectKeys`); what the adapter supplies is the three row operations against
   * its own directory table, which is the only part that differs between adapters.
   */
  private subjectKeysFor(tenantId: TenantId, scopeId: ScopeId): SubjectKeys {
    return createSubjectKeys(this.secretBox, {
      read: (subjectId) => {
        const row = this.directory
          .prepare(
            'SELECT key_id, wrapped_dek, shredded_at FROM _substrat_subject_keys WHERE scope_id = ? AND subject_id = ?',
          )
          .get(scopeId, subjectId) as
          | { key_id: string | null; wrapped_dek: string | null; shredded_at: string | null }
          | undefined;
        return row
          ? { keyId: row.key_id, wrappedDek: row.wrapped_dek, shreddedAt: row.shredded_at }
          : undefined;
      },
      insert: (subjectId, row) => {
        // `OR IGNORE` rather than `OR REPLACE`: two concurrent exports of the same subject
        // both mint, and the loser must not overwrite the winner's key — a replaced key
        // orphans everything the first one already sealed.
        this.directory
          .prepare(
            `INSERT OR IGNORE INTO _substrat_subject_keys
               (scope_id, subject_id, tenant_id, key_id, wrapped_dek, created_at, shredded_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(scopeId, subjectId, tenantId, row.keyId, row.wrappedDek, row.createdAt);
      },
      tombstone: (subjectId, at) => {
        // The row survives with its key cleared. Upserted rather than updated, so shredding
        // a subject who was never exported still leaves the tombstone that stops a LATER
        // export from minting them a fresh key.
        const existing = this.directory
          .prepare(
            'SELECT wrapped_dek FROM _substrat_subject_keys WHERE scope_id = ? AND subject_id = ?',
          )
          .get(scopeId, subjectId) as { wrapped_dek: string | null } | undefined;
        this.directory
          .prepare(
            `INSERT INTO _substrat_subject_keys
               (scope_id, subject_id, tenant_id, key_id, wrapped_dek, created_at, shredded_at)
             VALUES (?, ?, ?, NULL, NULL, ?, ?)
             ON CONFLICT (scope_id, subject_id)
               DO UPDATE SET key_id = NULL, wrapped_dek = NULL, shredded_at = ?`,
          )
          .run(scopeId, subjectId, tenantId, at, at, at);
        return { existed: existing?.wrapped_dek != null };
      },
    });
  }

  /**
   * The connection's CURRENT public sealing key, minted on first ask (#687).
   *
   * Mint-on-read rather than mint-only-at-connect, because the fleet already
   * holds live connections older than this feature — Egeryds' Scrive credential
   * carries years of real contracts, and "reconnect to acquire a keypair" is not
   * a migration anyone should have to run against production. Asking IS the
   * back-fill, and it is idempotent: the partial-unique index makes a race
   * between two callers resolve to one current key rather than two.
   */
  private async ensureSealingKey(connectionId: string): Promise<ProjectedConnectionKey> {
    const conn = this.connectionRow(connectionId);
    const read = () =>
      this.directory
        .prepare(
          `SELECT key_id, public_key FROM _substrat_connection_keys
           WHERE connection_id = ? AND retired_at IS NULL`,
        )
        .get(connectionId) as { key_id: string; public_key: string } | undefined;
    const existing = read();
    if (existing) {
      return projectedConnectionKey.parse({
        connectionId,
        provider: conn.provider,
        keyId: existing.key_id,
        publicKey: existing.public_key,
      });
    }
    const pair = await generateSealingKeyPair(`connection:${connectionId}:${ulid()}`);
    // Sealed by the host SecretBox exactly as the credential is — the private half
    // is never at rest in the clear, and a stolen directory file yields neither.
    const wrapped = await this.secretBox.seal(pair.privateKey);
    try {
      this.directory
        .prepare(
          `INSERT INTO _substrat_connection_keys
             (connection_id, key_id, public_key, wrapped_key_id, wrapped_private, created_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          connectionId,
          pair.keyId,
          pair.publicKey,
          wrapped.keyId,
          wrapped.ciphertext,
          new Date().toISOString(),
        );
    } catch (err) {
      // Lost the race. The winner's key is the current one, and using it is
      // correct — minting a second would orphan whatever the first already sealed.
      if (!/UNIQUE constraint failed/i.test((err as Error).message)) throw err;
      const won = read();
      if (!won) throw err;
      return projectedConnectionKey.parse({
        connectionId,
        provider: conn.provider,
        keyId: won.key_id,
        publicKey: won.public_key,
      });
    }
    return projectedConnectionKey.parse({
      connectionId,
      provider: conn.provider,
      keyId: pair.keyId,
      publicKey: pair.publicKey,
    });
  }

  /**
   * EVERY private half this connection holds, keyed by keyId — including retired
   * ones, which is the point of keeping them.
   *
   * A ciphertext sealed before a rotation still names the key that sealed it, so
   * the opener has to hold the whole map or every pending request older than the
   * rotation dead-letters. When rotation eventually destroys a retired key, its
   * row goes and the open fails LOUDLY (`SealedKeyUnavailableError`) — which is
   * the intended erasure, not an accident (D-5).
   */
  private async openSealingKeys(connectionId: string): Promise<Record<string, string>> {
    const rows = this.directory
      .prepare(
        `SELECT key_id, wrapped_key_id, wrapped_private FROM _substrat_connection_keys
         WHERE connection_id = ?`,
      )
      .all(connectionId) as { key_id: string; wrapped_key_id: string; wrapped_private: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.key_id] = await this.secretBox.open({
        keyId: r.wrapped_key_id,
        ciphertext: r.wrapped_private,
      });
    }
    return out;
  }

  /** Load a connection or fail loudly — update/revoke must not silently no-op. */
  private connectionRow(id: string): ConnectionRow {
    const row = this.directory
      .prepare('SELECT * FROM _substrat_connections WHERE id = ?')
      .get(id) as ConnectionRow | undefined;
    if (!row) throw new Error(`connection not found: ${id}`);
    return row;
  }

  private recordAdmin(
    actor: PlatformActorId,
    action: AdminAction,
    target: { tenantId: TenantId | null; scopeId?: ScopeId | null; vertical?: string | null },
    before: unknown,
    after: unknown,
  ): void {
    this.directory
      .prepare(
        `INSERT INTO _substrat_admin_log
           (id, actor, action, tenant_id, scope_id, vertical, before, after, caused_by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        actor,
        action,
        target.tenantId ?? null,
        target.scopeId ?? null,
        target.vertical ?? null,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        this.causedBy,
        new Date().toISOString(),
      );
  }

  private tenantHoldsEntitlement(tenantId: TenantId, key: string): boolean {
    // An expired grant fails closed, exactly as if revoked (#33) — evaluated
    // lazily at check time like tuple expiry (never swept; the row survives for
    // renewal). ISO instants compare lexically.
    return (
      this.directory
        .prepare(
          `SELECT 1 FROM _substrat_entitlements
           WHERE tenant_id = ? AND entitlement_key = ?
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(tenantId, key, new Date().toISOString()) !== undefined
    );
  }

  /** Every key the tenant is granted, expiry flagged — the "held" half of a denial (#691). */
  private heldEntitlements(tenantId: TenantId): { key: string; expired: boolean }[] {
    const now = new Date().toISOString();
    return (
      this.directory
        .prepare(
          `SELECT entitlement_key, expires_at FROM _substrat_entitlements
           WHERE tenant_id = ? ORDER BY entitlement_key`,
        )
        .all(tenantId) as { entitlement_key: string; expires_at: string | null }[]
    ).map((r) => ({ key: r.entitlement_key, expired: r.expires_at !== null && r.expires_at <= now }));
  }

  private buildAdmin(): HostAdmin {
    const mapTenant = (r: TenantRow): Tenant =>
      tenantSchema.parse({
        id: r.tenant_id,
        slug: r.slug,
        name: r.name,
        status: r.status,
        createdAt: r.created_at,
        deletingAt: r.deleting_at ?? null,
        provisionedByTenant: r.provisioned_by_tenant ?? null,
      });
    const readTenant = (id: TenantId): Tenant | undefined => {
      const r = this.directory.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(id) as
        | TenantRow
        | undefined;
      return r ? mapTenant(r) : undefined;
    };

    const readPool = (provider: string): IdentityPool | undefined => {
      const r = this.directory
        .prepare('SELECT provider, topology, tenant_id FROM _substrat_identity_pools WHERE provider = ?')
        .get(provider) as { provider: string; topology: string; tenant_id: string | null } | undefined;
      return r
        ? identityPool.parse({ provider: r.provider, topology: r.topology, tenantId: r.tenant_id })
        : undefined;
    };

    /**
     * A pool must be registered before it may link, and a tenant-bound pool may only
     * link into its own tenant. Resolution needs no equivalent check — K-22's
     * (tenantId, provider, externalId) key already scopes reads — so this is the one
     * place the topology is established rather than merely assumed.
     */
    const requirePoolServes = (provider: string, tenant: TenantId): void => {
      const pool = readPool(provider);
      if (!pool) {
        throw new Error(
          `identity pool '${provider}' is not registered — a pool must declare its ` +
            `topology before it may link (central vs tenant-bound decides whether the ` +
            `same externalId in two tenants is one person or two)`,
        );
      }
      if (pool.topology === 'tenant-bound' && pool.tenantId !== tenant) {
        throw new Error(
          `identity pool '${provider}' is bound to tenant ${pool.tenantId} and cannot link into ${tenant}`,
        );
      }
    };

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
    const readVertical = (slugValue: string): Vertical | undefined => {
      const r = this.directory
        .prepare('SELECT * FROM verticals WHERE slug = ?')
        .get(slugValue) as VerticalRow | undefined;
      return r ? mapVertical(r) : undefined;
    };

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
    const readVersion = (id: string): VerticalVersion | undefined => {
      const r = this.directory
        .prepare('SELECT * FROM vertical_versions WHERE id = ?')
        .get(id) as VersionRow | undefined;
      return r ? mapVersion(r) : undefined;
    };

    const mapOrg = (r: OrgRow): Org =>
      orgSchema.parse({
        id: r.org_id,
        tenantId: r.tenant_id,
        slug: r.slug,
        name: r.name,
        createdAt: r.created_at,
      });

    // Scoped by tenant, not just by id: an org id from another tenant must read as
    // absent here, or `grantToOrg` would reach across the boundary the record exists
    // to make explicit.
    const readOrg = (tenant: TenantId, id: OrgId): Org | undefined => {
      const r = this.directory
        .prepare('SELECT * FROM orgs WHERE tenant_id = ? AND org_id = ?')
        .get(tenant, id) as OrgRow | undefined;
      return r ? mapOrg(r) : undefined;
    };

    /**
     * Fail closed on an org that does not exist in this tenant. This is what the
     * record buys: before it, membership and grants accepted any string, so a typo
     * produced a tuple pointing at a phantom that silently granted nothing and
     * appeared in no listing.
     */
    const requireOrg = (tenant: TenantId, id: OrgId): void => {
      if (!readOrg(tenant, id)) {
        throw new Error(`unknown org ${id} in tenant ${tenant}`);
      }
    };

    // The directory row → the `scope` contract. Parsed, not cast: the columns are
    // nullable in SQLite (ALTER TABLE cannot add NOT NULL to a populated table)
    // while the contract requires them, so this parse is where that gap is held
    // shut. A null slug reaching here means the backfill missed a row — which
    // should fail loudly rather than surface as an untyped hole in the console.
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
        // A row written before `global` existed as a name stored NULL for
        // "unconstrained"; that is exactly `global` now (K-32). Coerce on read so
        // a legacy row parses instead of throwing against the non-nullable enum —
        // the same "held shut at parse" the slug default above relies on.
        jurisdiction: r.jurisdiction ?? 'global',
        vertical: r.vertical,
        schemaVersion: r.schema_version,
        verticalVersionId: r.vertical_version_id,
        migrationFailure: mapMigrationFailure(r),
        forkedFrom: r.forked_from,
        forkedAt: r.forked_at,
        expiresAt: r.expires_at,
        ...(r.serving_ref ? { servingRef: r.serving_ref } : {}),
        archivedAt: r.archived_at ?? null,
        createdAt: r.created_at,
      });

    // Scope lifecycle transition (control-plane.md §4.2): validate ownership,
    // enforce the legal transition graph (fail closed on an illegal one), flip
    // the status, and audit before/after. un-archive is just another entry here
    // — an explicit, audited restore, never a silent flag flip.
    const transitionScope = (
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
      const row = this.directory
        .prepare('SELECT tenant_id, status, vertical FROM scopes WHERE scope_id = ?')
        .get(scopeId) as { tenant_id: string; status: string; vertical: string | null } | undefined;
      if (!row || row.tenant_id !== tenantId) {
        throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
      }
      if (!from.includes(row.status as ScopeStatus)) {
        throw new Error(
          `illegal scope transition for ${action}: ${row.status} → ${to} ` +
            `(allowed from: ${from.join('|')})`,
        );
      }
      // Stamp/clear archived_at so the reap sweep can age scopes (§4.4). Entering
      // `archived` records when; `unarchive` (→ active, a restore) clears it so a later
      // re-archive dates from the new event; `reaped` keeps it as terminal history.
      if (to === 'archived') {
        this.directory
          .prepare('UPDATE scopes SET status = ?, archived_at = ? WHERE scope_id = ?')
          .run(to, new Date().toISOString(), scopeId);
      } else if (to === 'active') {
        this.directory
          .prepare('UPDATE scopes SET status = ?, archived_at = NULL WHERE scope_id = ?')
          .run(to, scopeId);
      } else {
        this.directory.prepare('UPDATE scopes SET status = ? WHERE scope_id = ?').run(to, scopeId);
      }
      // The audit target carries the scope's vertical (control-plane.md §4.4:
      // "vertical stays null until §4.2 lifecycle actions that name one"). It is
      // read from the scope rather than passed in, so the trail cannot disagree
      // with the directory about which deployment the action touched.
      this.recordAdmin(
        actor,
        action,
        { tenantId, scopeId, vertical: row.vertical },
        { status: row.status },
        { status: to, ...afterExtra },
      );
    };

    const writeTenantTuple = (
      tenantId: string,
      subject: string,
      relation: string,
      object: string,
      expiresAt?: string,
    ) =>
      this.directory
        .prepare(
          `INSERT OR REPLACE INTO _substrat_tenant_tuples
             (tenant_id, subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(tenantId, subject, relation, object, expiresAt ?? null);

    const writeScopeTuple = (
      node: Node,
      subject: string,
      relation: string,
      object: string,
      expiresAt?: string,
    ) => {
      if (!node.scopeId) throw new Error('scope tuple requires node.scopeId');
      const rt = this.runtime(node.tenantId, node.scopeId);
      rt.db
        .prepare(
          `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(subject, relation, object, expiresAt ?? null);
    };

    const writeGrant = (
      subject: string,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
      expiresAt?: string,
    ) => {
      if (entity) {
        writeScopeTuple(
          node,
          subject,
          `granted:${permission}`,
          `${entity.entityType}:${entity.entityId}`,
          expiresAt,
        );
      } else if (node.scopeId) {
        writeScopeTuple(node, subject, `granted:${permission}`, `scope:${node.scopeId}`, expiresAt);
      } else {
        writeTenantTuple(
          node.tenantId,
          subject,
          `granted:${permission}`,
          `tenant:${node.tenantId}`,
          expiresAt,
        );
      }
    };

    return {
      // #603: fixed at construction — a host built without a box can never store a
      // credential, and saying so is what lets a transport answer 503 instead of 500.
      canStoreSecrets: isSecretBoxConfigured(this.secretBox),
      defineRole: async (actor: PlatformActorId, tenantId: TenantId, role: RoleDefinition) => {
        const parsed = roleDefinition.parse(role);
        const before = this.roles.get(`${tenantId}/${parsed.key}`) ?? null;
        this.directory
          .prepare(
            `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source)
             VALUES (?, ?, ?, ?)`,
          )
          .run(tenantId, parsed.key, JSON.stringify(parsed.permissions), String(parsed.source));
        this.roles.set(`${tenantId}/${parsed.key}`, parsed);
        this.recordAdmin(actor, 'defineRole', { tenantId }, before, parsed);
      },
      listRoles: async (actor, filter?: RoleFilter): Promise<TenantRole[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.source) {
          where.push('source = ?');
          params.push(filter.source);
        }
        const order = (filter?.order ?? 'asc') === 'desc' ? 'DESC' : 'ASC';
        if (filter?.cursor) {
          // Composite sort key `${tenantId}|${roleKey}` (pagination.ts) — the
          // tenant id is a ULID and never contains '|', so split on the FIRST.
          const split = filter.cursor.indexOf('|');
          const afterTenant = split === -1 ? filter.cursor : filter.cursor.slice(0, split);
          const afterKey = split === -1 ? '' : filter.cursor.slice(split + 1);
          const cmp = order === 'DESC' ? '<' : '>';
          where.push(`(tenant_id ${cmp} ? OR (tenant_id = ? AND role_key ${cmp} ?))`);
          params.push(afterTenant, afterTenant, afterKey);
        }
        let sql =
          'SELECT tenant_id, role_key, permissions, source FROM _substrat_roles' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ` ORDER BY tenant_id ${order}, role_key ${order}`;
        if (filter?.limit !== undefined) {
          sql += ' LIMIT ?';
          params.push(filter.limit);
        }
        const rows = this.directory.prepare(sql).all(...params) as {
          tenant_id: string;
          role_key: string;
          permissions: string;
          source: string;
        }[];
        // Parsed, not cast: `permissions` is a JSON blob in a TEXT column, so the
        // contract is the only thing standing between a corrupted row and the
        // console rendering a role with permissions nobody declared.
        this.recordAccess(actor, 'listRoles', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
        return rows.map((r) =>
          tenantRole.parse({
            tenantId: r.tenant_id,
            key: r.role_key,
            permissions: JSON.parse(r.permissions),
            source: r.source,
          }),
        );
      },
      assignRole: async (actor: PlatformActorId, assignment: RoleAssignment) => {
        const subject = `principal:${assignment.principalId}`;
        if (assignment.node.scopeId) {
          writeScopeTuple(
            assignment.node,
            subject,
            `role:${assignment.roleKey}`,
            `scope:${assignment.node.scopeId}`,
          );
        } else {
          writeTenantTuple(
            assignment.node.tenantId,
            subject,
            `role:${assignment.roleKey}`,
            `tenant:${assignment.node.tenantId}`,
          );
        }
        this.recordAdmin(
          actor,
          'assignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          null,
          assignment,
        );
      },
      unassignRole: async (actor: PlatformActorId, assignment: RoleAssignment) => {
        // Tombstone (K-21), never DELETE — the checker skips revoked_at rows, so the
        // assignment stops resolving while staying visible to audit. Guarded on
        // `revoked_at IS NULL` so a repeat unassign is a silent no-op.
        const subject = `principal:${assignment.principalId}`;
        const relation = `role:${assignment.roleKey}`;
        const now = new Date().toISOString();
        let changes: number;
        if (assignment.node.scopeId) {
          const rt = this.runtime(assignment.node.tenantId, assignment.node.scopeId);
          changes = rt.db
            .prepare(
              `UPDATE _substrat_tuples SET revoked_at = ?
               WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
            )
            .run(now, subject, relation, `scope:${assignment.node.scopeId}`).changes;
        } else {
          changes = this.directory
            .prepare(
              `UPDATE _substrat_tenant_tuples SET revoked_at = ?
               WHERE tenant_id = ? AND subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
            )
            .run(now, assignment.node.tenantId, subject, relation, `tenant:${assignment.node.tenantId}`).changes;
        }
        if (changes === 0) return; // never assigned, or already revoked — idempotent, unaudited
        this.recordAdmin(
          actor,
          'unassignRole',
          { tenantId: assignment.node.tenantId, scopeId: assignment.node.scopeId },
          assignment,
          null,
        );
      },
      grant: async (actor: PlatformActorId, grant: CapabilityGrant) => {
        writeGrant(
          `principal:${grant.principalId}`,
          grant.permission,
          grant.node,
          grant.entity,
          grant.expiresAt,
        );
        this.recordAdmin(
          actor,
          'grant',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          grant,
        );
      },
      grantToConnection: async (actor: PlatformActorId, raw: ConnectionGrant) => {
        const grant = connectionGrant.parse(raw);
        const conn = this.connectionRow(grant.connectionId);
        if (conn.revoked_at) {
          throw new Error(`connection ${grant.connectionId} is revoked — grant nothing to it`);
        }
        // The grant may not reach outside what the connection already is. A
        // connection is keyed (tenant, vertical, provider); letting it hold a
        // permission in another tenant would make the key decorative.
        if (conn.tenant_id !== grant.node.tenantId) {
          throw new Error(
            `connection ${grant.connectionId} belongs to tenant ${conn.tenant_id} and cannot ` +
              `be granted anything in ${grant.node.tenantId}`,
          );
        }
        if (grant.node.scopeId) {
          const scope = this.directory
            .prepare('SELECT tenant_id, vertical FROM scopes WHERE scope_id = ?')
            .get(grant.node.scopeId) as { tenant_id: string; vertical: string | null } | undefined;
          if (!scope || scope.tenant_id !== grant.node.tenantId) {
            throw new Error(`unknown scope ${grant.node.scopeId} in tenant ${grant.node.tenantId}`);
          }
          if (scope.vertical !== conn.vertical) {
            throw new Error(
              `connection ${grant.connectionId} is for vertical '${conn.vertical}' and scope ` +
                `${grant.node.scopeId} runs '${scope.vertical ?? 'none'}'`,
            );
          }
        }
        writeGrant(
          subjectRef({ kind: 'connection', id: grant.connectionId }),
          grant.permission,
          grant.node,
          undefined,
          grant.expiresAt,
        );
        // #592: the directory-side record, alongside the tuple. The tuple is checked
        // where it lives; this row is what provision/reconcile gather FROM, so the
        // grant reaches scopes provisioned after it without a human replaying it.
        this.directory
          .prepare(
            `INSERT OR REPLACE INTO _substrat_connection_grants
               (connection_id, tenant_id, vertical, permission, scope_id, expires_at,
                granted_by, granted_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            grant.connectionId,
            grant.node.tenantId,
            conn.vertical,
            grant.permission,
            grant.node.scopeId ?? null,
            grant.expiresAt ?? null,
            grant.grantedBy,
            new Date().toISOString(),
          );
        this.recordAdmin(
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
        // The scheduler's grant (#383) — mirror of grantToConnection. Narrow by
        // construction: it names one module and one permission, and (like every
        // grant) it tombstones on revoke and shows in the permission diff. No
        // provider/vertical cross-check as a connection has: a module's system
        // principal is bound to the module, and a scope only ever runs the modules
        // its own host registered.
        const grant = systemGrant.parse(raw);
        writeGrant(
          subjectRef({ kind: 'system', id: grant.moduleId }),
          grant.permission,
          grant.node,
          undefined,
          grant.expiresAt,
        );
        this.recordAdmin(
          actor,
          'grantToSystem',
          { tenantId: grant.node.tenantId, scopeId: grant.node.scopeId },
          null,
          { moduleId: grant.moduleId, permission: grant.permission, node: grant.node },
        );
      },

      grantToOrg: async (actor, orgId, permission, node, entity) => {
        // The org must exist in the node's tenant. A grant to a phantom org is
        // worse than an error: it looks applied, resolves for nobody, and shows up
        // in the permission diff as though access were conferred.
        requireOrg(node.tenantId, orgId);
        writeGrant(`org:${orgId}`, permission, node, entity);
        this.recordAdmin(
          actor,
          'grantToOrg',
          { tenantId: node.tenantId, scopeId: node.scopeId },
          null,
          { orgId, permission, node, entity },
        );
      },
      // -- vertical + version registry (#31) ---------------------------------

      // -- the hostname map (K-26) -------------------------------------------

      bindHostname: async (actor: PlatformActorId, input: BindHostnameInput) => {
        const parsed = bindHostnameInput.parse(input);
        const scope = this.directory
          .prepare('SELECT tenant_id, vertical FROM scopes WHERE scope_id = ?')
          .get(parsed.scopeId) as { tenant_id: string; vertical: string | null } | undefined;
        if (!scope || scope.tenant_id !== parsed.tenantId) {
          throw new Error(`unknown scope ${parsed.scopeId} in tenant ${parsed.tenantId}`);
        }
        const existing = this.directory
          .prepare(
            `SELECT h.scope_id AS scope_id, s.status AS scope_status
               FROM hostnames h LEFT JOIN scopes s ON s.scope_id = h.scope_id
              WHERE h.hostname = ?`,
          )
          .get(parsed.hostname) as { scope_id: string; scope_status: string | null } | undefined;
        const holderReleased =
          existing?.scope_status === 'archived' || existing?.scope_status === 'reaped';
        if (existing && existing.scope_id !== parsed.scopeId && !holderReleased) {
          // A hostname is globally unique and routes to exactly one place. Silently
          // rebinding it would move another tenant's traffic. Exception: the holder is
          // ARCHIVED or REAPED (a deleted app, storage since wiped) — it released the
          // name, so the rebind reclaims it.
          throw new Error(`hostname '${parsed.hostname}' is already bound to another scope`);
        }
        // Exactly one canonical per (scope, surface): "which one do certs and
        // redirects use" has to have one answer, so a new canonical demotes the old.
        if (parsed.canonical) {
          this.directory
            .prepare('UPDATE hostnames SET canonical = 0 WHERE scope_id = ? AND surface = ?')
            .run(parsed.scopeId, parsed.surface);
        }
        this.directory
          .prepare(
            // INSERT OR REPLACE resets issuance columns — a (re)bind starts a fresh
            // lifecycle, so any prior CF hostname id / DNS records must not linger.
            `INSERT OR REPLACE INTO hostnames
               (hostname, tenant_id, scope_id, vertical_slug, surface, region,
                status, status_note, canonical, created_at, custom_hostname_id, validation_records)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL)`,
          )
          .run(
            parsed.hostname,
            parsed.tenantId,
            parsed.scopeId,
            scope.vertical,
            parsed.surface,
            parsed.region,
            parsed.canonical ? 1 : 0,
            new Date().toISOString(),
          );
        this.recordAdmin(
          actor,
          'bindHostname',
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId, vertical: scope.vertical },
          null,
          parsed,
        );
      },
      setHostnameStatus: async (actor, raw: string, status, note?: string) => {
        const hostname = raw.toLowerCase(); // DNS is case-insensitive; the map is normalized
        const row = this.directory
          .prepare('SELECT tenant_id, scope_id, status FROM hostnames WHERE hostname = ?')
          .get(hostname) as
          | { tenant_id: string; scope_id: string; status: string }
          | undefined;
        if (!row) throw new Error(`unknown hostname '${hostname}'`);
        if (row.status === status) return; // idempotent, and a no-op is not audited
        this.directory
          .prepare('UPDATE hostnames SET status = ?, status_note = ? WHERE hostname = ?')
          .run(status, note ?? null, hostname);
        this.recordAdmin(
          actor,
          'setHostnameStatus',
          { tenantId: row.tenant_id as TenantId, scopeId: row.scope_id as ScopeId },
          { status: row.status },
          { status, note: note ?? null },
        );
      },
      setHostnameIssuance: async (actor, raw, fields) => {
        const hostname = raw.toLowerCase(); // DNS is case-insensitive; the map is normalized
        const row = this.directory
          .prepare(
            'SELECT tenant_id, scope_id, status, custom_hostname_id, validation_records FROM hostnames WHERE hostname = ?',
          )
          .get(hostname) as
          | {
              tenant_id: string;
              scope_id: string;
              status: string;
              custom_hostname_id: string | null;
              validation_records: string | null;
            }
          | undefined;
        if (!row) throw new Error(`unknown hostname '${hostname}'`);
        const recordsJson = fields.validationRecords.length
          ? JSON.stringify(fields.validationRecords)
          : null;
        const idUnchanged =
          fields.customHostnameId === undefined || fields.customHostnameId === row.custom_hostname_id;
        // A poll that changes nothing is not an event — skip it, so the reconcile sweep
        // does not append a no-op admin-log row every interval.
        if (
          row.status === fields.status &&
          (row.validation_records ?? null) === recordsJson &&
          idUnchanged
        ) {
          return;
        }
        if (fields.customHostnameId !== undefined) {
          this.directory
            .prepare(
              'UPDATE hostnames SET status = ?, status_note = ?, custom_hostname_id = ?, validation_records = ? WHERE hostname = ?',
            )
            .run(fields.status, fields.note ?? null, fields.customHostnameId, recordsJson, hostname);
        } else {
          this.directory
            .prepare(
              'UPDATE hostnames SET status = ?, status_note = ?, validation_records = ? WHERE hostname = ?',
            )
            .run(fields.status, fields.note ?? null, recordsJson, hostname);
        }
        this.recordAdmin(
          actor,
          'setHostnameIssuance',
          { tenantId: row.tenant_id as TenantId, scopeId: row.scope_id as ScopeId },
          { status: row.status },
          { status: fields.status, note: fields.note ?? null },
        );
      },
      unbindHostname: async (actor, raw: string) => {
        const hostname = raw.toLowerCase(); // DNS is case-insensitive; the map is normalized
        const row = this.directory
          .prepare('SELECT tenant_id, scope_id, status FROM hostnames WHERE hostname = ?')
          .get(hostname) as
          | { tenant_id: string; scope_id: string; status: string }
          | undefined;
        if (!row) return; // idempotent, and a no-op is not audited
        this.directory.prepare('DELETE FROM hostnames WHERE hostname = ?').run(hostname);
        this.recordAdmin(
          actor,
          'unbindHostname',
          { tenantId: row.tenant_id as TenantId, scopeId: row.scope_id as ScopeId },
          { hostname, status: row.status },
          null,
        );
      },
      listHostnames: async (actor, filter) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId); }
        if (filter?.scopeId) { where.push('scope_id = ?'); params.push(filter.scopeId); }
        if (filter?.status) { where.push('status = ?'); params.push(filter.status); }
        if (filter?.verticalSlug) { where.push('vertical_slug = ?'); params.push(filter.verticalSlug); }
        const tail = keysetTail(where, params, 'hostname', filter);
        let sql = 'SELECT * FROM hostnames';
        if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
        sql += tail;
        const rows = this.directory.prepare(sql).all(...params) as HostnameRow[];
        this.recordAccess(
          actor,
          'listHostnames',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map(mapHostname);
      },
      resolveHostname: async (raw: string) => {
        // The router's per-request read. No actor, not logged — same carve-out as
        // resolveIdentity (K-24): this is a machine path, not a staff read.
        const hostname = raw.toLowerCase();
        // Join the scope's dispatch script in the same read (orchestration.md §5.4).
        // A scope on the stable serving script (#286) routes THERE; falls back to the
        // bound version's own script. LEFT joins: neither resolves with null.
        // `outbound_json` mirrors the Cloudflare directory read (#303, D-46): the declared
        // outbound surface of the code this dispatch runs — the serving version's when the
        // stable serving script wins, the bound version's on the per-version fallback.
        const r = this.directory
          .prepare(
            `SELECT h.tenant_id, h.scope_id, h.vertical_slug, h.surface, h.region,
                    COALESCE(s.serving_ref, vv.deployment_ref) AS deployment_ref,
                    CASE WHEN s.serving_ref IS NOT NULL
                         THEN json_extract(sv.manifest_json, '$.outbound')
                         ELSE json_extract(vv.manifest_json, '$.outbound') END AS outbound_json
               FROM hostnames h
               LEFT JOIN scopes s ON s.scope_id = h.scope_id
               LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
               LEFT JOIN verticals vr ON vr.slug = s.vertical
               LEFT JOIN vertical_versions sv ON sv.id = vr.serving_version_id
              WHERE h.hostname = ? AND h.status = 'active'`,
          )
          .get(hostname) as
          | {
              tenant_id: string;
              scope_id: string;
              vertical_slug: string | null;
              surface: string;
              region: string | null;
              deployment_ref: string | null;
              outbound_json: string | null;
            }
          | undefined;
        if (!r) return undefined;
        let outboundHosts: string[] | null = null;
        if (r.outbound_json) {
          try {
            const parsed = JSON.parse(r.outbound_json) as unknown;
            if (Array.isArray(parsed)) {
              outboundHosts = parsed.filter((h): h is string => typeof h === 'string');
            }
          } catch {
            // Malformed JSON never breaks routing — the request dispatches unenforced.
          }
        }
        return routeTarget.parse({
          tenantId: r.tenant_id,
          scopeId: r.scope_id,
          verticalSlug: r.vertical_slug,
          deploymentRef: r.deployment_ref ?? null,
          surface: r.surface,
          region: r.region,
          outboundHosts,
        });
      },
      registerVertical: async (actor: PlatformActorId, input: RegisterVerticalInput) => {
        const parsed = registerVerticalInput.parse(input);
        const envSpecJson = parsed.envSpec ? JSON.stringify(parsed.envSpec) : null;
        // The four registry-driven-install fields ride as one JSON blob (marketplace-publish.md §3).
        const installSpec: Record<string, unknown> = {};
        if (parsed.entitlements) installSpec.entitlements = parsed.entitlements;
        if (parsed.ownerGrants) installSpec.ownerGrants = parsed.ownerGrants;
        if (parsed.provides) installSpec.provides = parsed.provides;
        if (parsed.requires) installSpec.requires = parsed.requires;
        if (parsed.provisions) installSpec.provisions = parsed.provisions;
        if (parsed.sendsEmail) installSpec.sendsEmail = parsed.sendsEmail;
        if (parsed.surfaces) installSpec.surfaces = parsed.surfaces;
        const installSpecJson = Object.keys(installSpec).length ? JSON.stringify(installSpec) : null;
        const existing = readVertical(parsed.slug);
        if (existing) {
          // Idempotent on an identical registration. A conflicting one throws:
          // changing a vertical's source silently rebinds what every scope on it
          // is understood to be running. A changed owner is the sharper form of that —
          // claim-on-first-push (builder-plane.md) fixes a slug's owner at first push.
          if (
            existing.source === parsed.source &&
            existing.name === parsed.name &&
            existing.ownerTenant === parsed.ownerTenant
          ) {
            // The env-spec is not identity — it evolves with the manifest, so refresh it
            // on an otherwise-identical re-registration (ensureCatalog runs each boot) so
            // a declared config change propagates without a conflict.
            this.directory
              .prepare('UPDATE verticals SET env_spec = ?, install_spec = ? WHERE slug = ?')
              .run(envSpecJson, installSpecJson, parsed.slug);
            // For BUILTIN verticals `listed` is seed metadata too (derived from the catalog's
            // `connected` flag), so it refreshes alongside — without this, rows registered
            // before they were listable stay unlisted forever (the empty-marketplace bug).
            // A pushed vertical's `listed` is the staff publish decision — never touched.
            if (parsed.source === 'builtin') {
              this.directory
                .prepare('UPDATE verticals SET listed = ? WHERE slug = ?')
                .run(parsed.listed ? 1 : 0, parsed.slug);
            }
            return;
          }
          if (existing.ownerTenant !== parsed.ownerTenant) {
            throw new Error(
              `vertical '${parsed.slug}' is owned by ${existing.ownerTenant ?? 'the platform'}, not ${parsed.ownerTenant ?? 'the platform'}`,
            );
          }
          throw new Error(
            `vertical '${parsed.slug}' is already registered as ${existing.source}`,
          );
        }
        this.directory
          .prepare(
            'INSERT INTO verticals (slug, name, source, owner_tenant, env_spec, install_spec, listed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(parsed.slug, parsed.name, parsed.source, parsed.ownerTenant, envSpecJson, installSpecJson, parsed.listed ? 1 : 0, new Date().toISOString());
        this.recordAdmin(actor, 'registerVertical', { tenantId: null }, null, parsed);
      },
      listVerticals: async (actor, page) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        const tail = keysetTail(where, params, 'slug', page);
        const sql =
          'SELECT * FROM verticals' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + tail;
        const rows = this.directory.prepare(sql).all(...params) as VerticalRow[];
        this.recordAccess(actor, 'listVerticals', {}, page ?? null, rows.length);
        return rows.map(mapVertical);
      },
      publishVersion: async (actor: PlatformActorId, input: PublishVersionInput) => {
        const parsed = publishVersionInput.parse(input);
        const owning = readVertical(parsed.verticalSlug);
        if (!owning) {
          throw new Error(`unknown vertical '${parsed.verticalSlug}'`);
        }
        // Lands PENDING — a push is not a deploy — except for a PRIVATE vertical
        // (tenant-owned, not listed), whose blast radius is its own tenant: there the
        // sandbox contract is the gate and the version self-admits, noted so the
        // publish seam can tell a staff vouch from this shortcut.
        const selfAdmits = owning.ownerTenant !== null && !owning.listed;
        // The manifest is retained for the serving upload (#286), not audited — a whole
        // manifest per publish would drown the admin log in bundle metadata.
        const { manifestJson, origin, ...audited } = parsed;
        this.directory
          .prepare(
            `INSERT INTO vertical_versions
               (id, vertical_slug, version, manifest_digest, permission_digest,
                migration_digest, deployment_ref, admission, admission_note, manifest_json,
                origin_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            audited.id,
            audited.verticalSlug,
            audited.version,
            audited.manifestDigest,
            audited.permissionDigest,
            audited.migrationDigest,
            audited.deploymentRef,
            selfAdmits ? 'admitted' : 'pending',
            selfAdmits ? AUTO_ADMISSION_NOTE : null,
            manifestJson ?? null,
            origin ? JSON.stringify(origin) : null,
            new Date().toISOString(),
          );
        this.recordAdmin(actor, 'publishVersion', { tenantId: null }, null, {
          ...audited,
          ...(origin ? { origin } : {}),
          admission: selfAdmits ? 'admitted' : 'pending',
        });
      },
      listVersions: async (actor, verticalSlug: string, page) => {
        const where: string[] = ['vertical_slug = ?'];
        const params: (string | number)[] = [verticalSlug];
        const tail = keysetTail(where, params, 'id', page);
        const rows = this.directory
          .prepare(`SELECT * FROM vertical_versions WHERE ${where.join(' AND ')}${tail}`)
          .all(...params) as VersionRow[];
        this.recordAccess(actor, 'listVersions', {}, { verticalSlug }, rows.length);
        return rows.map(mapVersion);
      },
      getVersion: async (actor, versionId: string, verticalSlug?: string) => {
        const v = readVersion(versionId);
        // A version of another vertical reads as absent when the caller named one.
        const hit = v && (verticalSlug === undefined || v.verticalSlug === verticalSlug) ? v : undefined;
        this.recordAccess(actor, 'getVersion', {}, { versionId, verticalSlug }, hit ? 1 : 0);
        return hit;
      },
      setVerticalListed: async (actor, slug: string, listed: boolean) => {
        const existing = readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        // Listing is the moment other tenants start trusting this code, so the
        // version they would install must carry a real staff vouch — an auto-admitted
        // prod version has never been read by anyone but its author.
        if (listed) {
          const prod = this.directory
            .prepare("SELECT version_id FROM vertical_channels WHERE vertical_slug = ? AND channel = 'prod'")
            .get(slug) as { version_id: string } | undefined;
          const prodVersion = prod ? readVersion(prod.version_id) : undefined;
          if (prodVersion?.admissionNote === AUTO_ADMISSION_NOTE) {
            throw new Error(
              `vertical '${slug}' prod version ${prodVersion.id} is auto-admitted (private self-serve) — ` +
                `a staff admit must vouch for it before listing`,
            );
          }
        }
        // Resolve any pending publish request either way, and set the flag.
        this.directory
          .prepare('UPDATE verticals SET listed = ?, publish_requested_at = NULL WHERE slug = ?')
          .run(listed ? 1 : 0, slug);
        this.recordAdmin(actor, 'setVerticalListed', { tenantId: null }, { listed: existing.listed }, { listed });
      },
      requestPublish: async (actor, slug: string) => {
        const existing = readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        this.directory.prepare('UPDATE verticals SET publish_requested_at = ? WHERE slug = ?').run(new Date().toISOString(), slug);
        this.recordAdmin(actor, 'requestPublish', { tenantId: null }, null, { slug });
      },
      setVerticalInstallsBlocked: async (actor, slug: string, blocked: boolean) => {
        const existing = readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        this.directory
          .prepare('UPDATE verticals SET installs_blocked = ? WHERE slug = ?')
          .run(blocked ? 1 : 0, slug);
        this.recordAdmin(actor, 'setVerticalInstallsBlocked', { tenantId: null }, { installsBlocked: existing.installsBlocked }, { installsBlocked: blocked });
      },
      setVerticalTenantProvisioner: async (actor, slug: string, granted: boolean) => {
        const existing = readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        this.directory
          .prepare('UPDATE verticals SET tenant_provisioner = ? WHERE slug = ?')
          .run(granted ? 1 : 0, slug);
        this.recordAdmin(actor, 'setVerticalTenantProvisioner', { tenantId: null }, { tenantProvisioner: existing.tenantProvisioner }, { tenantProvisioner: granted });
      },
      setVerticalEmailSender: async (actor, slug: string, granted: boolean) => {
        const existing = readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        this.directory
          .prepare('UPDATE verticals SET email_sender = ? WHERE slug = ?')
          .run(granted ? 1 : 0, slug);
        this.recordAdmin(actor, 'setVerticalEmailSender', { tenantId: null }, { emailSender: existing.emailSender }, { emailSender: granted });
      },
      deleteVertical: async (actor, slug: string) => {
        const existing = readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        // Refuse while any restorable scope is bound: a deleted registry row would strand
        // those scopes' version pins and routing. An `archived` scope (a deleted app) still
        // blocks — unarchive can bring it back — but the refusal names reap/restore, not
        // "delete", because the app itself is already gone. `reaped` is terminal history
        // and never blocks. The count names the blast radius.
        const bound = this.directory
          .prepare(
            'SELECT ' +
              "COUNT(*) FILTER (WHERE status NOT IN ('archived', 'reaped')) AS live, " +
              "COUNT(*) FILTER (WHERE status = 'archived') AS archived " +
              'FROM scopes WHERE vertical = ?',
          )
          .get(slug) as { live: number; archived: number };
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
        // Deployed dispatch scripts are NOT reaped here — they become orphans for the
        // cleanup script (#248), never destroyed alongside a registry row.
        this.directory.prepare('DELETE FROM vertical_channels WHERE vertical_slug = ?').run(slug);
        this.directory.prepare('DELETE FROM vertical_channel_history WHERE vertical_slug = ?').run(slug);
        this.directory.prepare('DELETE FROM vertical_versions WHERE vertical_slug = ?').run(slug);
        this.directory.prepare('DELETE FROM verticals WHERE slug = ?').run(slug);
        this.recordAdmin(
          actor,
          'deleteVertical',
          { tenantId: null },
          { slug, source: existing.source, ownerTenant: existing.ownerTenant },
          null,
        );
      },
      admitVersion: async (actor, versionId: string) => {
        const v = readVersion(versionId);
        if (!v) throw new Error(`unknown version ${versionId}`);
        if (v.admission === 'admitted') {
          // Idempotent — except an AUTO-admitted version, which this upgrades to a
          // manual vouch by clearing the note (what the publish seam requires).
          if (v.admissionNote !== AUTO_ADMISSION_NOTE) return;
          this.directory
            .prepare('UPDATE vertical_versions SET admission_note = NULL WHERE id = ?')
            .run(versionId);
          this.recordAdmin(actor, 'admitVersion', { tenantId: null }, { admission: v.admission, note: v.admissionNote }, {
            admission: 'admitted',
            note: null,
          });
          return;
        }
        if (v.admission === 'rejected') {
          throw new Error(`version ${versionId} was rejected — publish a new one`);
        }
        this.directory
          .prepare("UPDATE vertical_versions SET admission = 'admitted' WHERE id = ?")
          .run(versionId);
        this.recordAdmin(actor, 'admitVersion', { tenantId: null }, { admission: v.admission }, {
          admission: 'admitted',
        });
      },
      rejectVersion: async (actor, versionId: string, note: string) => {
        const v = readVersion(versionId);
        if (!v) throw new Error(`unknown version ${versionId}`);
        if (v.admission === 'admitted') {
          throw new Error(`version ${versionId} is already admitted — it may be bound`);
        }
        if (v.admission === 'rejected') return; // idempotent
        this.directory
          .prepare("UPDATE vertical_versions SET admission = 'rejected', admission_note = ? WHERE id = ?")
          .run(note, versionId);
        this.recordAdmin(actor, 'rejectVersion', { tenantId: null }, { admission: v.admission }, {
          admission: 'rejected',
          note,
        });
      },
      promoteVersion: async (
        actor,
        verticalSlug: string,
        channel,
        versionId: string,
        acknowledge?: PromotionAcknowledgement,
      ) => {
        const incoming = readVersion(versionId);
        if (!incoming) throw new Error(`unknown version ${versionId}`);
        if (incoming.verticalSlug !== verticalSlug) {
          throw new Error(`version ${versionId} belongs to '${incoming.verticalSlug}'`);
        }
        if (incoming.admission !== 'admitted') {
          throw new Error(
            `version ${versionId} is ${incoming.admission}, not admitted — it cannot be promoted`,
          );
        }
        const current = this.directory
          .prepare('SELECT version_id FROM vertical_channels WHERE vertical_slug = ? AND channel = ?')
          .get(verticalSlug, channel) as { version_id: string } | undefined;
        const outgoing = current ? readVersion(current.version_id) : undefined;
        const ack = promotionAcknowledgement.parse(acknowledge ?? {});

        // §4's two checkpoints, fired where the blast radius is. A FIRST promotion
        // has nothing to diff against, so there is nothing to acknowledge — the
        // gate is about change, not about existence.
        if (outgoing) {
          if (outgoing.permissionDigest !== incoming.permissionDigest && !ack.permissionChange) {
            throw new Error(
              `promotion changes the permission surface (${outgoing.permissionDigest} → ` +
                `${incoming.permissionDigest}) — acknowledge it explicitly to promote`,
            );
          }
          if (outgoing.migrationDigest !== incoming.migrationDigest && !ack.migrationChange) {
            throw new Error(
              `promotion changes migrations (${outgoing.migrationDigest} → ` +
                `${incoming.migrationDigest}) — acknowledge it explicitly to promote`,
            );
          }
        }

        const promotedAt = new Date().toISOString();
        this.directory
          .prepare(
            `INSERT INTO vertical_channels (vertical_slug, channel, version_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (vertical_slug, channel) DO UPDATE SET version_id = ?, updated_at = ?`,
          )
          .run(verticalSlug, channel, versionId, promotedAt, versionId, promotedAt);
        // The timeline row: what makes rollback a choice among recorded moments, and
        // `at` the PITR anchor a data rollback would rewind to.
        this.directory
          .prepare(
            `INSERT INTO vertical_channel_history
               (id, vertical_slug, channel, version_id, from_version_id, actor, at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(ulid(), verticalSlug, channel, versionId, outgoing?.id ?? null, actor, promotedAt);

        // For a PRIVATE vertical, prod IS what the owner's apps run: re-point the
        // owning tenant's live scopes in the same act, so merge-to-main (push +
        // promote) is a complete deploy and a rollback promote reaches the running
        // app. D-30's lockstep concern is a SHARED vertical's many tenants, which a
        // private vertical cannot have — this fires for no one else. Snapshots and
        // forks (forked_from set) keep their frontier untouched, and a rebind that
        // crosses a migration digest snapshots first (fork-before-promote, §4).
        //
        // EXCEPTION (#321): a DISPATCH-BACKED vertical (its version has a
        // `deploymentRef`) serves in place off a stable script. Rebinding a legacy
        // scope's version HERE would reroute it to the incoming version's per-version
        // dispatch script — a fresh, empty scope store — stranding its data before the
        // in-place serve can adopt it. The control-plane-api promote handler owns
        // adopt-then-rebind for those (serve → adopt legacy scopes → advance versions),
        // so we skip the rebind here. An EMBEDDED vertical (deploymentRef null) has no
        // per-version script and keeps the rebind here. See adapter-cloudflare parity.
        if (channel === 'prod' && !incoming.deploymentRef) {
          const owning = readVertical(verticalSlug);
          if (owning && owning.ownerTenant !== null && !owning.listed) {
            const bound = this.directory
              .prepare(
                `SELECT scope_id, tenant_id, vertical_version_id FROM scopes
                 WHERE vertical = ? AND tenant_id = ? AND status = 'active' AND forked_from IS NULL`,
              )
              .all(verticalSlug, owning.ownerTenant) as {
              scope_id: string;
              tenant_id: string;
              vertical_version_id: string | null;
            }[];
            for (const s of bound) {
              if (s.vertical_version_id === versionId) continue;
              const prev = s.vertical_version_id ? readVersion(s.vertical_version_id) : undefined;
              if (prev && prev.migrationDigest !== incoming.migrationDigest) {
                await this.snapshotScope(actor, s.tenant_id as TenantId, s.scope_id as ScopeId);
              }
              this.directory
                .prepare('UPDATE scopes SET vertical_version_id = ?, vertical = ? WHERE scope_id = ?')
                .run(versionId, verticalSlug, s.scope_id);
              this.recordAdmin(
                actor,
                'bindScopeVersion',
                { tenantId: s.tenant_id as TenantId, scopeId: s.scope_id as ScopeId },
                prev ? { versionId: prev.id, version: prev.version } : null,
                { versionId, vertical: verticalSlug, version: incoming.version, via: 'promoteVersion' },
              );
            }
          }
        }

        // The acknowledgement is recorded, not just enforced: that is what turns
        // "someone reviewed the permission change" into evidence.
        this.recordAdmin(
          actor,
          'promoteVersion',
          { tenantId: null, vertical: verticalSlug },
          outgoing ? { versionId: outgoing.id, version: outgoing.version } : null,
          { channel, versionId, version: incoming.version, acknowledged: ack },
        );
      },
      listChannels: async (actor, verticalSlug: string, page) => {
        // `prod` is the only live channel (#509 retired dev/staging). Filtering here keeps a
        // legacy dev/staging row — inert data a pre-retirement push may have left — from
        // reaching the now-`prod`-only `verticalChannel.parse` below and throwing.
        const where: string[] = ['vertical_slug = ?', "channel = 'prod'"];
        const params: (string | number)[] = [verticalSlug];
        const tail = keysetTail(where, params, 'channel', page);
        const rows = this.directory
          .prepare(`SELECT * FROM vertical_channels WHERE ${where.join(' AND ')}${tail}`)
          .all(...params) as ChannelRow[];
        // The serving script runs ONE version (#286); surface it on the prod row so a
        // failed in-place serve reads honestly instead of claiming the new version is
        // live (#321). Parity with the Cloudflare host.
        const serving =
          (
            this.directory
              .prepare('SELECT serving_version_id FROM verticals WHERE slug = ?')
              .get(verticalSlug) as { serving_version_id: string | null } | undefined
          )?.serving_version_id ?? null;
        this.recordAccess(actor, 'listChannels', {}, { verticalSlug }, rows.length);
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
        const where: string[] = ['vertical_slug = ?'];
        const params: (string | number)[] = [verticalSlug];
        if (channel) {
          where.push('channel = ?');
          params.push(channel);
        }
        // Newest first is the shipped order, so 'desc' is the DEFAULT here.
        const tail = keysetTail(where, params, 'id', page, 'desc');
        const rows = this.directory
          .prepare(`SELECT * FROM vertical_channel_history WHERE ${where.join(' AND ')}${tail}`)
          .all(...params) as ChannelHistoryRow[];
        this.recordAccess(actor, 'listChannelHistory', {}, { verticalSlug, channel }, rows.length);
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
        const v = readVersion(versionId);
        if (!v) throw new Error(`unknown version ${versionId}`);
        const scope = this.directory
          .prepare('SELECT tenant_id, kind, vertical_version_id FROM scopes WHERE scope_id = ?')
          .get(scopeId) as { tenant_id: string; kind: string; vertical_version_id: string | null } | undefined;
        if (!scope || scope.tenant_id !== tenantId) {
          throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        }
        // The refusal this registry exists for. Without it, "a push lands pending"
        // is a convention, and D-30's argument is that we cannot afford conventions
        // where lockstep upgrades are the failure mode. Scoped to a SERVING bind, though:
        // a PREVIEW fork serves no install (the builder's own tenant's data, non-canonical
        // URL), so it may run pending PR code — the own-tenant blast radius that lets a
        // private vertical self-admit, and what lets a LISTED vertical's builder keep
        // previewing their own new code (issue #509 ask (d)).
        if (v.admission !== 'admitted' && scope.kind !== 'preview') {
          throw new Error(
            `version ${versionId} is ${v.admission}, not admitted — it cannot be bound to a scope`,
          );
        }
        // Fork-before-promote (§4): snapshot the pre-migration data if this rebind
        // crosses a migration boundary. Gated on a real digest change — a code-only
        // rebind snapshots nothing — and on the caller opting in (until GC ships).
        if (opts?.snapshot && scope.vertical_version_id) {
          const outgoing = readVersion(scope.vertical_version_id);
          if (outgoing && outgoing.migrationDigest !== v.migrationDigest) {
            await this.snapshotScope(actor, tenantId, scopeId);
          }
        }
        this.directory
          .prepare('UPDATE scopes SET vertical_version_id = ?, vertical = ? WHERE scope_id = ?')
          .run(versionId, v.verticalSlug, scopeId);
        this.recordAdmin(actor, 'bindScopeVersion', { tenantId, scopeId }, null, {
          versionId,
          vertical: v.verticalSlug,
          version: v.version,
        });
      },
      verticalServing: async (actor, verticalSlug: string) => {
        const r = this.directory
          .prepare('SELECT * FROM verticals WHERE slug = ?')
          .get(verticalSlug) as VerticalRow | undefined;
        if (!r) throw new Error(`unknown vertical '${verticalSlug}'`);
        this.recordAccess(actor, 'verticalServing', {}, { verticalSlug }, r.serving_ref ? 1 : 0);
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
        const r = this.directory
          .prepare('SELECT * FROM verticals WHERE slug = ?')
          .get(verticalSlug) as VerticalRow | undefined;
        if (!r) throw new Error(`unknown vertical '${verticalSlug}'`);
        this.directory
          .prepare(
            `UPDATE verticals SET serving_ref = ?, serving_version_id = ?,
                    serving_do_classes = ?, serving_migration_tag = ? WHERE slug = ?`,
          )
          .run(parsed.ref, parsed.versionId, JSON.stringify(parsed.doClasses), parsed.migrationTag, verticalSlug);
        this.recordAdmin(
          actor,
          'setVerticalServing',
          { tenantId: null },
          r.serving_ref ? { ref: r.serving_ref, versionId: r.serving_version_id } : null,
          { vertical: verticalSlug, ref: parsed.ref, versionId: parsed.versionId },
        );
      },
      versionManifest: async (actor, verticalSlug: string, versionId: string) => {
        const v = this.directory
          .prepare('SELECT * FROM vertical_versions WHERE id = ?')
          .get(versionId) as VersionRow | undefined;
        if (!v || v.vertical_slug !== verticalSlug) {
          throw new Error(`unknown version ${versionId} for vertical '${verticalSlug}'`);
        }
        this.recordAccess(actor, 'versionManifest', {}, { verticalSlug, versionId }, v.manifest_json ? 1 : 0);
        return v.manifest_json;
      },
      setScopeServingRef: async (actor, tenantId, scopeId, servingRef) => {
        const scope = this.directory
          .prepare('SELECT tenant_id, serving_ref FROM scopes WHERE scope_id = ?')
          .get(scopeId) as { tenant_id: string; serving_ref: string | null } | undefined;
        if (!scope || scope.tenant_id !== tenantId) {
          throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        }
        this.directory
          .prepare('UPDATE scopes SET serving_ref = ? WHERE scope_id = ?')
          .run(servingRef, scopeId);
        this.recordAdmin(
          actor,
          'setScopeServingRef',
          { tenantId, scopeId },
          { servingRef: scope.serving_ref },
          { servingRef },
        );
      },
      setScopeExpiresAt: async (actor, tenantId, scopeId, expiresAt) => {
        const scope = this.directory
          .prepare('SELECT tenant_id, expires_at FROM scopes WHERE scope_id = ?')
          .get(scopeId) as { tenant_id: string; expires_at: string | null } | undefined;
        if (!scope || scope.tenant_id !== tenantId) {
          throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        }
        this.directory
          .prepare('UPDATE scopes SET expires_at = ? WHERE scope_id = ?')
          .run(expiresAt, scopeId);
        this.recordAdmin(
          actor,
          'setScopeExpiresAt',
          { tenantId, scopeId },
          { expiresAt: scope.expires_at },
          { expiresAt },
        );
      },
      scopeMigrationBookmarks: async (actor, tenantId, scopeId) => {
        const scope = this.directory
          .prepare('SELECT tenant_id FROM scopes WHERE scope_id = ?')
          .get(scopeId) as { tenant_id: string } | undefined;
        if (!scope || scope.tenant_id !== tenantId) {
          throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        }
        // No PITR on plain SQLite — an empty list, not an error: there is simply
        // nothing to offer. The backup/restore path (#278) is this host's rewind.
        this.recordAccess(actor, 'scopeMigrationBookmarks', { tenantId, scopeId }, null, 0);
        return [];
      },
      rewindScope: async () => {
        throw new Error(
          'point-in-time rewind is not available on this host (PITR is a Durable-Object-plane mechanism) — use the backup restore path',
        );
      },
      createOrg: async (actor: PlatformActorId, input: CreateOrgInput) => {
        const parsed = createOrgInput.parse(input);
        if (readOrg(parsed.tenantId, parsed.id)) return; // idempotent, unaudited
        // Checked explicitly rather than left to the UNIQUE index: OR IGNORE would
        // swallow a collision from a DIFFERENT id and report success, silently not
        // creating the org the caller asked for. Fail closed instead (as createTenant).
        const slugOwner = this.directory
          .prepare('SELECT org_id FROM orgs WHERE tenant_id = ? AND slug = ?')
          .get(parsed.tenantId, parsed.slug) as { org_id: string } | undefined;
        if (slugOwner) {
          throw new Error(
            `org slug '${parsed.slug}' already taken by ${slugOwner.org_id} (slugs are unique per tenant)`,
          );
        }
        this.directory
          .prepare(
            'INSERT INTO orgs (org_id, tenant_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(parsed.id, parsed.tenantId, parsed.slug, parsed.name, new Date().toISOString());
        this.recordAdmin(actor, 'createOrg', { tenantId: parsed.tenantId }, null, parsed);
      },
      listOrgs: async (actor, tenantId: TenantId) => {
        const rows = (
          this.directory
            .prepare('SELECT * FROM orgs WHERE tenant_id = ? ORDER BY slug')
            .all(tenantId) as OrgRow[]
        ).map(mapOrg);
        this.recordAccess(actor, 'listOrgs', { tenantId }, null, rows.length);
        return rows;
      },
      getOrg: async (actor, tenantId: TenantId, orgId: OrgId) => {
        const o = readOrg(tenantId, orgId);
        this.recordAccess(actor, 'getOrg', { tenantId }, { orgId }, o ? 1 : 0);
        return o;
      },
      addMember: async (actor, tenantId, principal, orgId) => {
        requireOrg(tenantId, orgId);
        // INSERT OR REPLACE, so re-adding a revoked member clears the tombstone —
        // they are a member again. The add/revoke history is not lost: it lives in
        // the append-only admin log, which is where "what happened" belongs. The
        // tuple carries "what is true now" plus enough to explain a live proof.
        writeTenantTuple(tenantId, `principal:${principal}`, 'member', `org:${orgId}`);
        this.recordAdmin(actor, 'addMember', { tenantId }, null, { principal, orgId });
      },
      removeMember: async (actor, tenantId, principal, orgId) => {
        requireOrg(tenantId, orgId);
        // Tombstone (K-21), never DELETE. Guarded on `revoked_at IS NULL` so a
        // repeat revoke neither moves the timestamp nor writes a second audit row.
        const info = this.directory
          .prepare(
            `UPDATE _substrat_tenant_tuples SET revoked_at = ?
             WHERE tenant_id = ? AND subject = ? AND relation = 'member' AND object = ?
               AND revoked_at IS NULL`,
          )
          .run(
            new Date().toISOString(),
            tenantId,
            `principal:${principal}`,
            `org:${orgId}`,
          );
        if (info.changes === 0) return; // never a member, or already revoked
        this.recordAdmin(actor, 'removeMember', { tenantId }, { principal, orgId }, null);
      },
      listMembers: async (actor, tenantId, orgId, options) => {
        requireOrg(tenantId, orgId);
        const rows = this.directory
          .prepare(
            `SELECT subject, revoked_at FROM _substrat_tenant_tuples
             WHERE tenant_id = ? AND relation = 'member' AND object = ?
             ${options?.includeRevoked ? '' : 'AND revoked_at IS NULL'}
             ORDER BY subject`,
          )
          .all(tenantId, `org:${orgId}`) as { subject: string; revoked_at: string | null }[];
        this.recordAccess(actor, 'listMembers', { tenantId }, { orgId, ...options }, rows.length);
        return rows.map((r) =>
          orgMembership.parse({
            principal: r.subject.slice('principal:'.length),
            orgId,
            revokedAt: r.revoked_at,
          }),
        );
      },
      createTenant: async (actor: PlatformActorId, input: CreateTenantInput) => {
        const parsed = createTenantInput.parse(input);
        // Idempotent: re-creating an existing tenant is a no-op, and a no-op is
        // not audited — nothing changed.
        if (readTenant(parsed.id)) return;
        // Checked explicitly rather than left to `INSERT OR IGNORE` + the
        // `tenants_slug` UNIQUE index: OR IGNORE would swallow a collision from a
        // DIFFERENT id and return as though the create were idempotent, silently
        // not creating the tenant the caller asked for. Fail closed instead.
        const slugOwner = this.directory
          .prepare('SELECT tenant_id FROM tenants WHERE slug = ?')
          .get(parsed.slug) as { tenant_id: string } | undefined;
        if (slugOwner) {
          throw new Error(
            `tenant slug '${parsed.slug}' already taken by ${slugOwner.tenant_id} (slugs are unique)`,
          );
        }
        this.directory
          .prepare(
            `INSERT INTO tenants (tenant_id, slug, name, status, created_at, provisioned_by_tenant)
             VALUES (?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            parsed.id,
            parsed.slug,
            parsed.name,
            new Date().toISOString(),
            parsed.provisionedByTenant ?? null,
          );
        this.recordAdmin(actor, 'createTenant', { tenantId: parsed.id }, null, readTenant(parsed.id));
      },
      setTenantStatus: async (actor: PlatformActorId, tenantId: TenantId, status: TenantStatus) => {
        const before = readTenant(tenantId);
        if (!before) throw new Error(`unknown tenant: ${tenantId}`);
        // `reaped` is terminal and destroys data — it is unreachable here and only
        // ever set by reapTenant, so a plain status flip cannot forge a tombstone
        // over live data (§4.8, the tenant analogue of reapScope's archived-only gate).
        if (status === 'reaped') {
          throw new Error(
            `tenant ${tenantId} cannot be set to 'reaped' via setTenantStatus — reap goes through reapTenant (control-plane.md §4.8)`,
          );
        }
        // Stamp/clear deleting_at so the grace-window sweep can age tenants (§4.8):
        // entering `deleting` stamps, leaving it (an un-delete) clears — exactly the
        // shape suspendScope/archiveScope use for archived_at.
        if (status === 'deleting') {
          this.directory
            .prepare('UPDATE tenants SET status = ?, deleting_at = ? WHERE tenant_id = ?')
            .run(status, new Date().toISOString(), tenantId);
        } else {
          this.directory
            .prepare('UPDATE tenants SET status = ?, deleting_at = NULL WHERE tenant_id = ?')
            .run(status, tenantId);
        }
        this.recordAdmin(
          actor,
          'setTenantStatus',
          { tenantId },
          { status: before.status },
          { status },
        );
      },
      setTenantName: async (actor: PlatformActorId, tenantId: TenantId, name: string) => {
        const before = readTenant(tenantId);
        if (!before) throw new Error(`unknown tenant: ${tenantId}`);
        if (before.name === name) return; // no-op is not audited — nothing changed
        this.directory.prepare('UPDATE tenants SET name = ? WHERE tenant_id = ?').run(name, tenantId);
        this.recordAdmin(actor, 'setTenantName', { tenantId }, { name: before.name }, { name });
      },
      listTenants: async (actor, page): Promise<Tenant[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        const tail = keysetTail(where, params, 'tenant_id', page);
        const sql =
          'SELECT * FROM tenants' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + tail;
        const rows = (this.directory.prepare(sql).all(...params) as TenantRow[]).map(mapTenant);
        // Enumerating every tenant on the platform is the read this log exists for.
        this.recordAccess(actor, 'listTenants', {}, page ?? null, rows.length);
        return rows;
      },
      getTenant: async (actor, tenantId: TenantId): Promise<Tenant | undefined> => {
        const t = readTenant(tenantId);
        this.recordAccess(actor, 'getTenant', { tenantId }, null, t ? 1 : 0);
        return t;
      },
      listScopes: async (actor, filter?: ScopeFilter): Promise<Scope[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
          // An empty array means "no status is acceptable" — match nothing, rather
          // than degenerating into an unfiltered read of the whole fleet.
          if (statuses.length === 0) return [];
          where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
          params.push(...statuses);
        }
        if (filter?.vertical) {
          where.push('vertical = ?');
          params.push(filter.vertical);
        }
        const tail = keysetTail(where, params, 'scope_id', filter);
        const sql =
          'SELECT * FROM scopes' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + tail;
        const scopes = (this.directory.prepare(sql).all(...params) as ScopeRow[]).map(mapScope);
        this.recordAccess(
          actor,
          'listScopes',
          { tenantId: filter?.tenantId ?? null },
          filter,
          scopes.length,
        );
        return scopes;
      },
      listTenantStores: async (
        actor,
        filter?: { tenantId?: TenantId; vertical?: string },
      ): Promise<TenantStoreRecord[]> => {
        const where: string[] = [];
        const params: string[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.vertical) {
          where.push('vertical = ?');
          params.push(filter.vertical);
        }
        const rows = this.directory
          .prepare(
            'SELECT * FROM tenant_stores' +
              (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
              ' ORDER BY tenant_id, vertical, binding',
          )
          .all(...params) as {
          tenant_id: string;
          vertical: string;
          binding: string;
          kind: string;
          ref: string;
          created_at: string;
        }[];
        this.recordAccess(
          actor,
          'listTenantStores',
          { tenantId: filter?.tenantId ?? null },
          filter,
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
        const where: string[] = [];
        const params: string[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.vertical) {
          where.push('vertical = ?');
          params.push(filter.vertical);
        }
        const rows = this.directory
          .prepare(
            'SELECT * FROM blob_stores' +
              (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
              ' ORDER BY tenant_id, vertical, binding',
          )
          .all(...params) as {
          tenant_id: string;
          vertical: string;
          binding: string;
          kind: string;
          ref: string;
          created_at: string;
        }[];
        this.recordAccess(
          actor,
          'listBlobStores',
          { tenantId: filter?.tenantId ?? null },
          filter,
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
      getScopeRecord: async (actor, tenantId: TenantId, scopeId: ScopeId): Promise<Scope | undefined> => {
        const r = this.directory.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(scopeId) as
          | ScopeRow
          | undefined;
        // Cross-check the pair (K-3): a scope that exists under a DIFFERENT tenant
        // reads as absent, never as itself. Same rule as getScope's stub mint.
        const found = r && r.tenant_id === tenantId;
        this.recordAccess(actor, 'getScopeRecord', { tenantId, scopeId }, null, found ? 1 : 0);
        if (!found) return undefined;
        return mapScope(r);
      },
      listScopeTables: async (actor, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeTable[]> => {
        // K-3: the (tenantId, scopeId) pair is cross-checked before we open anything;
        // a scope under a different tenant is unreachable, never another tenant's DB.
        const db = this.scopeDbFor(tenantId, scopeId);
        const names = (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
            .all() as { name: string }[]
        ).map((r) => r.name);
        const tables: ScopeTable[] = names.map((name) => ({
          name,
          rowCount: (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c,
          system: isSystemTable(name),
        }));
        this.recordAccess(actor, 'listScopeTables', { tenantId, scopeId }, null, tables.length);
        return tables;
      },
      readScopeTable: async (
        actor,
        tenantId: TenantId,
        scopeId: ScopeId,
        input: ReadScopeTableInput,
      ): Promise<ScopeTablePage> => {
        const db = this.scopeDbFor(tenantId, scopeId);
        // Validate the table against the LIVE schema — an unknown name throws, it is
        // never interpolated blind. That validated name is the only thing that reaches
        // the query, so the quoted identifier below carries no user input.
        const known = new Set(
          (
            db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
              name: string;
            }[]
          ).map((r) => r.name),
        );
        if (!known.has(input.table)) throw new Error(`unknown table '${input.table}'`);
        const limit = Math.min(Math.max(1, input.limit ?? SCOPE_TABLE_PAGE_DEFAULT), SCOPE_TABLE_PAGE_MAX);
        const offset = Math.max(0, input.offset ?? 0);
        const stmt = db.prepare(`SELECT * FROM "${input.table}" LIMIT ? OFFSET ?`).raw(true);
        const rows = (stmt.all(limit, offset) as unknown[][]).map((row) => row.map(cellToJson));
        const columns = stmt.columns().map((c) => c.name);
        const rowCount = (
          db.prepare(`SELECT COUNT(*) AS c FROM "${input.table}"`).get() as { c: number }
        ).c;
        this.recordAccess(actor, 'readScopeTable', { tenantId, scopeId }, { table: input.table, limit, offset }, rows.length);
        return { table: input.table, columns, rows, rowCount, limit, offset };
      },
      queryScope: async (
        actor,
        tenantId: TenantId,
        scopeId: ScopeId,
        input: QueryScopeInput,
      ): Promise<ScopeQueryResult> => {
        const db = this.scopeDbFor(tenantId, scopeId);
        // Layer 1, shared: the kernel's textual gate (single statement, read verbs
        // only) — the checked statement is the one that runs.
        const sql = assertReadOnlyQuery(input.sql);
        // Layer 2, authoritative: sqlite3_stmt_readonly via better-sqlite3. prepare()
        // itself rejects multi-statement strings and bad SQL with the driver's message.
        const stmt = db.prepare(sql);
        if (!stmt.readonly) throw new Error('read-only console: statement is not read-only');
        if (!stmt.reader) return { columns: [], rows: [], truncated: false };
        stmt.raw(true);
        const rows: unknown[][] = [];
        let truncated = false;
        // Iterate rather than .all(): the row cap bounds what leaves the DB, so an
        // over-broad SELECT costs a screenful, not the table.
        for (const row of stmt.iterate()) {
          if (rows.length >= SCOPE_QUERY_ROW_MAX) {
            truncated = true;
            break;
          }
          rows.push((row as unknown[]).map(cellToJson));
        }
        const columns = stmt.columns().map((c) => c.name);
        // The statement itself is the logged argument — the K-24 access log is the
        // evidence trail for what staff read, and here the read IS the SQL.
        this.recordAccess(actor, 'queryScope', { tenantId, scopeId }, { sql }, rows.length);
        return { columns, rows, truncated };
      },
      exportScope: async (actor, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeDump> => {
        // K-3: cross-check the pair before opening anything (same as the introspection reads).
        const db = this.scopeDbFor(tenantId, scopeId);
        // Every real table, keeping the `_substrat_*` spine but dropping SQLite's own
        // `sqlite_*` internals — those are auto-managed and `CREATE TABLE sqlite_*` is
        // rejected on reload. `sql` is the CREATE statement, replayed to rebuild the schema.
        //
        // The derived search index (#827) is dropped too, and for the same class of
        // reason: its shadow tables cannot be replayed (the DO host rejects the name
        // outright), and it is recomputable — `loadDump` rebuilds it from the content
        // tables it just loaded. A dump carries the rows, never the index over them.
        const defs = (
          db
            .prepare(
              `SELECT name, sql FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
                ORDER BY name`,
            )
            .all() as { name: string; sql: string }[]
        ).filter(({ name }) => !isSearchIndexTable(name));
        const tables: ScopeDumpTable[] = defs.map(({ name, sql }) => {
          // `.raw(true)` gives positional rows; cells stay as-is (blobs are Buffers, not
          // nulled as in a UI read) so the dump is byte-faithful. The name is from the live
          // schema, never user input, so the quoted identifier is safe.
          const stmt = db.prepare(`SELECT * FROM "${name}"`).raw(true);
          const rows = stmt.all() as unknown[][];
          const columns = stmt.columns().map((c) => c.name);
          return { name, ddl: sql, columns, rows };
        });
        this.recordAccess(actor, 'exportScope', { tenantId, scopeId }, null, tables.length);
        return { tenantId, scopeId, capturedAt: new Date().toISOString(), tables };
      },
      // -- directory disaster recovery (#40) ----------------------------------
      // The self-hosted half of the same story. A self-host has no DO point-in-time
      // recovery to fall back on, so for that deployment shape this pair is not the
      // second line of defence — it is the only one.
      exportDirectory: async (actor): Promise<DirectoryDump> => {
        // The directory database, dumped by exactly the same rules as a scope file
        // above: real tables only, DDL from `sqlite_master`, positional rows with
        // blobs kept as bytes.
        const defs = this.directory
          .prepare(
            `SELECT name, sql FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
              ORDER BY name`,
          )
          .all() as { name: string; sql: string }[];
        const tables: ScopeDumpTable[] = defs.map(({ name, sql }) => {
          const stmt = this.directory.prepare(`SELECT * FROM "${name}"`).raw(true);
          const rows = stmt.all() as unknown[][];
          const columns = stmt.columns().map((c) => c.name);
          return { name, ddl: sql, columns, rows };
        });
        // No tenant on the entry (K-23): this read's subject is every tenant at once.
        this.recordAccess(actor, 'exportDirectory', {}, null, tables.length);
        return { capturedAt: new Date().toISOString(), tables };
      },
      restoreDirectory: async (actor, dump: DirectoryDump): Promise<void> => {
        // Counted before the replace — afterwards the old directory is gone, and
        // "restored over N tenants" is the fact the audit entry exists to carry.
        const before = (
          this.directory.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number }
        ).n;
        // One transaction, foreign keys deferred to commit: the dump is ordered by
        // table NAME (which says nothing about references — `scopes` points at
        // `tenants`), and the DROPs themselves delete rows a populated child would
        // still be referencing. better-sqlite3 runs the function synchronously inside
        // BEGIN/COMMIT, and rolls back if it throws.
        this.directory.pragma('defer_foreign_keys = ON');
        this.directory.transaction(() => {
          const existing = this.directory
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[];
          for (const { name } of existing) this.directory.exec(`DROP TABLE IF EXISTS "${name}"`);
          for (const t of dump.tables) this.directory.exec(t.ddl);
          for (const t of dump.tables) {
            if (t.rows.length === 0) continue;
            const cols = t.columns.map((c) => `"${c}"`).join(', ');
            const placeholders = t.columns.map(() => '?').join(', ');
            const insert = this.directory.prepare(
              `INSERT INTO "${t.name}" (${cols}) VALUES (${placeholders})`,
            );
            for (const row of t.rows) insert.run(...(row as unknown[]));
          }
        })();
        // Carry a copy taken before a directory migration forward to the running
        // code's shape — the same assertion a cold start makes.
        this.applyDirectorySchema();
        // Roles are held in memory (`loadRoles`), so a restore that only rewrote the
        // table would leave every permission check reading the PRE-restore roles until
        // the process restarted — the exact silent-divergence a recovery must not have.
        this.loadRoles();
        this.recordAdmin(
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
        const current = this.directory
          .prepare('SELECT status FROM scopes WHERE scope_id = ? AND tenant_id = ?')
          .get(scopeId, tenantId) as { status: string } | undefined;
        if (current?.status === 'active') return;
        await transitionScope(actor, 'activateScope', tenantId, scopeId, ['provisioning'], 'active');
      },
      suspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'suspendScope', tenantId, scopeId, ['active'], 'suspended'),
      unsuspendScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unsuspendScope', tenantId, scopeId, ['suspended'], 'active'),
      archiveScope: async (actor, tenantId, scopeId) =>
        // Also from `provisioning`: a scope whose provisioning never completed (a failed
        // create) must be abandonable, or its slug is stranded forever (it can't reach a
        // terminal state that frees the name).
        transitionScope(actor, 'archiveScope', tenantId, scopeId, ['provisioning', 'active', 'suspended'], 'archived'),
      unarchiveScope: async (actor, tenantId, scopeId) =>
        transitionScope(actor, 'unarchiveScope', tenantId, scopeId, ['archived'], 'active'),
      reapScope: async (actor, tenantId, scopeId, opts) => {
        // Reap an ARCHIVED scope's storage while keeping its directory row as a tombstone
        // (§4.4). Only `archived` may be reaped — an illegal source fails closed. The
        // STORAGE goes before the status flip (the ordering deleteSnapshot keeps): a crash
        // between leaves an `archived` row over an emptied file and re-running converges,
        // whereas flipping first would strand a live file under a `reaped` row reap never
        // revisits. Hostnames were released at archive and the row survives, so — unlike
        // deleteSnapshot — neither is touched here.
        const rec = this.directory
          .prepare('SELECT tenant_id, status FROM scopes WHERE scope_id = ?')
          .get(scopeId) as { tenant_id: string; status: string } | undefined;
        if (!rec || rec.tenant_id !== tenantId) {
          throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
        }
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
        const bound = opts?.force
          ? undefined
          : (this.directory
              .prepare('SELECT hostname FROM hostnames WHERE scope_id = ? LIMIT 1')
              .get(scopeId) as { hostname: string } | undefined);
        if (bound) {
          throw new Error(
            `scope ${scopeId} still resolves hostname '${bound.hostname}' — ` +
              `unbind it before reaping (reap wipes storage and cannot be undone)`,
          );
        }
        const key = `${tenantId}/${scopeId}`;
        const rt = this.scopes.get(key);
        if (rt) {
          rt.db.close();
          this.scopes.delete(key);
          this.scopesById.delete(scopeId);
        }
        rmSync(join(this.dir, `${tenantId}__${scopeId}.sqlite`), { force: true });
        // The recoverable copy the caller stored first (#493), named in the audit entry so
        // the trail answers "was there a backup" without correlating two timestamps.
        await transitionScope(actor, 'reapScope', tenantId, scopeId, ['archived'], 'reaped', {
          backupRef: opts?.backupRef ?? null,
        });
      },
      // -- subject erasure (#37) ----------------------------------------------
      sealSubjectPayloads: async (actor, tenantId, scopeId, items) => {
        // K-3: the (tenant, scope) pair is cross-checked before any key is touched, the
        // same gate every introspection read passes.
        this.assertScope(tenantId, scopeId);
        const sealed = await this.subjectKeysFor(tenantId, scopeId).sealMany(items);
        // The count that matters for an incident is how many payloads left SEALED versus
        // how many were refused — a run that refused everything means a shredded subject's
        // data was about to be copied again.
        this.recordAccess(
          actor,
          'sealSubjectPayloads',
          { tenantId, scopeId },
          { subjects: new Set(items.map((i) => i.subjectId)).size },
          sealed.filter((s) => s !== null).length,
        );
        return sealed;
      },
      openSubjectPayloads: async (actor, tenantId, scopeId, items) => {
        this.assertScope(tenantId, scopeId);
        const opened = await this.subjectKeysFor(tenantId, scopeId).openMany(items);
        this.recordAccess(
          actor,
          'openSubjectPayloads',
          { tenantId, scopeId },
          { subjects: new Set(items.map((i) => i.subjectId)).size },
          opened.filter((o) => o !== null).length,
        );
        return opened;
      },
      shredSubject: async (actor, tenantId, scopeId, subjectId): Promise<SubjectShredReceipt> => {
        this.assertScope(tenantId, scopeId);
        // Redact the live spine FIRST. Both halves are idempotent and a crash between them
        // converges on retry, so the order is decided by which half-done state harms the
        // person: dying after this leaves ciphertext in a backup that no key opens; dying
        // after destroying the key first would leave their PII in the operational database
        // while the audit log says they were erased.
        //
        // The payload goes, the envelope stays — id, type, entity, occurredAt and the
        // (pseudonymous) subject id. That is §5.3's line held exactly: "pseudonymous keys
        // and transaction facts remain". A consumer's timeline still shows that something
        // happened, to what, and when; it no longer shows who or what was said.
        const db = this.scopeDbFor(tenantId, scopeId);
        const redacted = db
          .prepare(
            `UPDATE _substrat_outbox SET payload = NULL
              WHERE subject_id = ? AND pii_class != 'none' AND payload IS NOT NULL`,
          )
          .run(subjectId);
        const at = new Date().toISOString();
        const { existed } = await this.subjectKeysFor(tenantId, scopeId).destroy(subjectId, at);
        const receipt = subjectShredReceipt.parse({
          subjectId,
          eventsRedacted: redacted.changes,
          keyDestroyed: existed,
          tombstoned: true,
        });
        // BOTH logs, which is unusual and deliberate: the admin log because this is a
        // mutation, the access log because it destroys evidence. An erasure is the one
        // action where "who asked for this to disappear" is itself the record.
        this.recordAdmin(actor, 'shredSubject', { tenantId, scopeId }, null, receipt);
        this.recordAccess(actor, 'shredSubject', { tenantId, scopeId }, { subjectId }, redacted.changes);
        return receipt;
      },
      reapTenant: async (actor: PlatformActorId, tenantId: TenantId) => {
        // The terminal tenant reap (§4.8), the tenant analogue of reapScope. The
        // caller (the reap route / grace-window sweep) has already reaped every scope's
        // storage above the kernel; this clears the tenant's directory-side PII/config
        // and flips the row to a `reaped` tombstone. Only a `deleting` tenant may be
        // reaped — an illegal source fails closed, like reapScope's archived-only gate.
        const before = readTenant(tenantId);
        if (!before) throw new Error(`unknown tenant: ${tenantId}`);
        if (before.status !== 'deleting') {
          throw new Error(
            `tenant ${tenantId} is ${before.status}, not deleting — only a deleting tenant may be reaped`,
          );
        }
        // Clear the tenant's directory-side rows. Idempotent (set-to-empty), so a crash
        // mid-reap converges on retry. KEPT as the tombstone: the `tenants` row itself
        // and `_substrat_admin_log` (the compliance witness — never swept). Scope rows
        // were already reaped individually and stay as their own tombstones.
        const tables = [
          '_substrat_identities', // PII: external subjects/emails bound to principals
          '_substrat_identity_pools', // the tenant's IdP topology declarations
          '_substrat_tenant_tuples', // membership + tenant-level grants
          '_substrat_roles', // operator-defined roles
          '_substrat_entitlements', // per-tenant SKU flags
          'orgs', // K-22 org records
        ];
        const clear = this.directory.transaction(() => {
          for (const table of tables) {
            this.directory.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId);
          }
          this.directory
            .prepare(`UPDATE tenants SET status = 'reaped', deleting_at = NULL WHERE tenant_id = ?`)
            .run(tenantId);
        });
        clear();
        // Evict the in-memory role cache for this tenant (the one directory table
        // mirrored in memory) so a reaped role never resolves after the DELETE.
        for (const cacheKey of [...this.roles.keys()]) {
          if (cacheKey.startsWith(`${tenantId}/`)) this.roles.delete(cacheKey);
        }
        this.recordAdmin(
          actor,
          'reapTenant',
          { tenantId },
          { status: before.status },
          { status: 'reaped' },
        );
      },
      grantEntitlement: async (
        actor: PlatformActorId,
        tenantId: TenantId,
        entitlementKey: string,
        plan?: EntitlementGrantInput,
      ) => {
        const input = entitlementGrantInput.parse(plan ?? {});
        const existing = this.directory
          .prepare(
            'SELECT expires_at, quota, plan FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
          )
          .get(tenantId, entitlementKey) as
          | { expires_at: string | null; quota: number | null; plan: string | null }
          | undefined;
        // PATCH semantics (entitlementGrantInput): omitted preserves, null clears —
        // a bare re-grant on an idempotent provisioning path must not erase a
        // trial's expiry and quietly turn it perpetual.
        const next = {
          expiresAt: input.expiresAt !== undefined ? input.expiresAt : (existing?.expires_at ?? null),
          quota: input.quota !== undefined ? input.quota : (existing?.quota ?? null),
          plan: input.plan !== undefined ? input.plan : (existing?.plan ?? null),
        };
        // Idempotent: a grant that changes nothing is not audited.
        if (
          existing &&
          existing.expires_at === next.expiresAt &&
          existing.quota === next.quota &&
          existing.plan === next.plan
        ) {
          return;
        }
        const now = new Date().toISOString();
        // granted_at/granted_by restamp on every effective change: a renewal is a
        // new grant act, and the full history is the admin log below.
        this.directory
          .prepare(
            `INSERT INTO _substrat_entitlements
               (tenant_id, entitlement_key, expires_at, quota, plan, granted_at, granted_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, entitlement_key) DO UPDATE SET
               expires_at = excluded.expires_at,
               quota = excluded.quota,
               plan = excluded.plan,
               granted_at = excluded.granted_at,
               granted_by = excluded.granted_by`,
          )
          .run(tenantId, entitlementKey, next.expiresAt, next.quota, next.plan, now, actor);
        this.recordAdmin(
          actor,
          'grantEntitlement',
          { tenantId },
          existing
            ? { entitlementKey, expiresAt: existing.expires_at, quota: existing.quota, plan: existing.plan }
            : null,
          { entitlementKey, ...next },
        );
      },
      revokeEntitlement: async (actor: PlatformActorId, tenantId: TenantId, entitlementKey: string) => {
        const existing = this.directory
          .prepare(
            'SELECT expires_at, quota, plan FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
          )
          .get(tenantId, entitlementKey) as
          | { expires_at: string | null; quota: number | null; plan: string | null }
          | undefined;
        if (!existing) return; // nothing held, nothing changed
        this.directory
          .prepare('DELETE FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?')
          .run(tenantId, entitlementKey);
        this.recordAdmin(
          actor,
          'revokeEntitlement',
          { tenantId },
          { entitlementKey, expiresAt: existing.expires_at, quota: existing.quota, plan: existing.plan },
          null,
        );
      },
      listEntitlements: async (actor, tenantId: TenantId): Promise<EntitlementGrant[]> => {
        const grants = (
          this.directory
            .prepare(
              `SELECT entitlement_key, expires_at, quota, plan, granted_at, granted_by
               FROM _substrat_entitlements WHERE tenant_id = ? ORDER BY entitlement_key`,
            )
            .all(tenantId) as {
            entitlement_key: string;
            expires_at: string | null;
            quota: number | null;
            plan: string | null;
            granted_at: string | null;
            granted_by: string | null;
          }[]
        ).map((r) =>
          entitlementGrant.parse({
            entitlementKey: r.entitlement_key,
            expiresAt: r.expires_at,
            quota: r.quota,
            plan: r.plan,
            grantedAt: r.granted_at,
            grantedBy: r.granted_by,
          }),
        );
        this.recordAccess(actor, 'listEntitlements', { tenantId }, null, grants.length);
        return grants;
      },
      readMeters: async (actor, filter?: { tenantId?: TenantId }): Promise<MeterReading> => {
        // Three narrow reads, one fold (`foldMeterReading`) — the billable rule is the
        // kernel's, not this adapter's, so the Cloudflare directory cannot drift into
        // quoting a different number for the same fleet.
        const only = filter?.tenantId;
        const where = only ? ' WHERE tenant_id = ?' : '';
        const args = only ? [only] : [];
        const reading = foldMeterReading({
          readAt: instant.parse(new Date().toISOString()),
          tenants: (
            this.directory.prepare(`SELECT tenant_id, slug, status FROM tenants${where}`).all(...args) as {
              tenant_id: string;
              slug: string;
              status: string;
            }[]
          ).map((r) => ({ tenantId: r.tenant_id as TenantId, slug: r.slug, status: r.status as TenantStatus })),
          scopes: (
            this.directory.prepare(`SELECT tenant_id, status FROM scopes${where}`).all(...args) as {
              tenant_id: string;
              status: string;
            }[]
          ).map((r) => ({ tenantId: r.tenant_id as TenantId, status: r.status as ScopeStatus })),
          entitlements: (
            this.directory
              .prepare(`SELECT tenant_id, entitlement_key, plan, expires_at FROM _substrat_entitlements${where}`)
              .all(...args) as {
              tenant_id: string;
              entitlement_key: string;
              plan: string | null;
              expires_at: string | null;
            }[]
          ).map((r) => ({
            tenantId: r.tenant_id as TenantId,
            entitlementKey: r.entitlement_key,
            plan: r.plan,
            expiresAt: r.expires_at,
          })),
        });
        // The count that matters for K-24 is how many TENANTS this reading covered —
        // "read the meter for one tenant" and "metered the whole fleet" are different
        // acts, and the totals alone would not tell them apart.
        this.recordAccess(actor, 'readMeters', { tenantId: only ?? null }, filter ?? null, reading.perTenant.length);
        return meterReading.parse(reading);
      },
      registerIdentityPool: async (actor: PlatformActorId, input: IdentityPool) => {
        const parsed = identityPool.parse(input);
        const existing = readPool(parsed.provider);
        if (existing) {
          // Idempotent on an identical registration. A CONFLICTING one throws:
          // flipping a live pool's topology silently reinterprets every row it owns
          // — the same externalId across tenants would change from one human to two.
          if (existing.topology === parsed.topology && existing.tenantId === parsed.tenantId) {
            return;
          }
          throw new Error(
            `identity pool '${parsed.provider}' is already registered as ${existing.topology}` +
              `${existing.tenantId ? ` for tenant ${existing.tenantId}` : ''}`,
          );
        }
        this.directory
          .prepare(
            'INSERT INTO _substrat_identity_pools (provider, topology, tenant_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(parsed.provider, parsed.topology, parsed.tenantId, new Date().toISOString());
        this.recordAdmin(
          actor,
          'registerIdentityPool',
          // Null for a central pool: it belongs to no single tenant, which is what
          // made the admin log's tenantId nullable.
          { tenantId: parsed.tenantId },
          null,
          parsed,
        );
      },
      getIdentityPool: async (actor, provider: string) => {
        const pool = readPool(provider);
        this.recordAccess(actor, 'getIdentityPool', {}, { provider }, pool ? 1 : 0);
        return pool;
      },
      listIdentityTenants: async (actor, provider: string, externalId: string) => {
        const pool = readPool(provider);
        if (!pool) throw new Error(`identity pool '${provider}' is not registered`);
        if (pool.topology !== 'central') {
          throw new Error(
            `identity pool '${provider}' is tenant-bound — enumerating tenants is only ` +
              `meaningful on a central pool, where the same externalId is the same person`,
          );
        }
        const tenants = (
          this.directory
            .prepare(
              'SELECT tenant_id FROM _substrat_identities WHERE provider = ? AND external_id = ? ORDER BY tenant_id',
            )
            .all(provider, externalId) as { tenant_id: string }[]
        ).map((r) => r.tenant_id as TenantId);
        // Which tenants a given login touches — a cross-tenant question, and one
        // worth being able to ask who asked.
        this.recordAccess(actor, 'listIdentityTenants', {}, { provider }, tenants.length);
        return tenants;
      },
      listIdentityLinks: async (actor, tid: TenantId) => {
        // The projection read (#406): what the platform gathers to deliver a tenant's
        // links with provisioning/reconcile — the same trust line entitlements ride
        // (#310). The pure adapter has no projection layer (single process — the
        // directory IS local), so this is a plain directory read, access-logged.
        const links = (
          this.directory
            .prepare(
              'SELECT provider, external_id, principal_id, scope_id FROM _substrat_identities WHERE tenant_id = ?',
            )
            .all(tid) as { provider: string; external_id: string; principal_id: string; scope_id: string | null }[]
        ).map((r) =>
          identityLink.parse({
            provider: r.provider,
            externalId: r.external_id,
            principal: r.principal_id,
            tenantId: tid,
            scopeId: r.scope_id ?? undefined,
          }),
        );
        this.recordAccess(actor, 'listIdentityLinks', { tenantId: tid }, null, links.length);
        return links;
      },
      // -- the integrations hub (#101) ---------------------------------------

      createConnection: async (actor: PlatformActorId, raw: CreateConnectionInput) => {
        const input = createConnectionInput.parse(raw);
        const sealed = await this.secretBox.seal(JSON.stringify(input.secret));
        const now = new Date().toISOString();
        try {
          this.directory
            .prepare(
              `INSERT INTO _substrat_connections
                 (id, tenant_id, vertical, provider, label, status, external_account_ref,
                  scopes, expires_at, last_ok_at, last_error, last_error_at,
                  created_by, created_at, revoked_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
            )
            .run(
              input.id,
              input.tenantId,
              input.vertical,
              input.provider,
              input.label,
              input.externalAccountRef ?? null,
              JSON.stringify(input.scopes),
              input.expiresAt ?? null,
              // The authorizing principal when supplied (a self-serve connect), else the
              // effecting platform actor. See connections.md §3.5.1 / createConnectionInput.
              input.createdBy ?? actor,
              now,
            );
        } catch (err) {
          if (/UNIQUE constraint failed/i.test((err as Error).message)) {
            const account = input.externalAccountRef
              ? ` under account '${input.externalAccountRef}'`
              : '';
            throw new Error(
              `tenant ${input.tenantId} already has a live '${input.provider}' connection ` +
                `for vertical '${input.vertical}'${account} — revoke it before connecting another`,
            );
          }
          throw err;
        }
        this.directory
          .prepare(
            `INSERT INTO _substrat_connection_secrets (connection_id, key_id, ciphertext, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.id, sealed.keyId, sealed.ciphertext, now);
        // METADATA ONLY. `_substrat_admin_log` is append-only, so a credential
        // written here could never be removed — the redaction is the point, and
        // it is structural rather than a rule someone has to remember.
        this.recordAdmin(
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
        // LIVE connections only. A revoked connection's key is kept (its pending
        // ciphertext must still open) but stops being projected, so a scope can no
        // longer seal to a credential that has been withdrawn.
        const rows = this.directory
          .prepare(
            `SELECT id FROM _substrat_connections
             WHERE tenant_id = ? AND vertical = ? AND revoked_at IS NULL`,
          )
          .all(tenantId, vertical) as { id: string }[];
        const out: ProjectedConnectionKey[] = [];
        for (const r of rows) out.push(await this.ensureSealingKey(r.id));
        return out;
      },

      listConnections: async (actor: PlatformActorId, filter?: ConnectionFilter) => {
        const f = filter ?? {};
        const where: string[] = [];
        const params: SqlValue[] = [];
        if (f.tenantId) (where.push('tenant_id = ?'), params.push(f.tenantId));
        if (f.vertical) (where.push('vertical = ?'), params.push(f.vertical));
        if (f.provider) (where.push('provider = ?'), params.push(f.provider));
        if (f.externalAccountRef) (where.push('external_account_ref = ?'), params.push(f.externalAccountRef));
        if (!f.includeRevoked) where.push('revoked_at IS NULL');
        const rows = this.directory
          .prepare(
            `SELECT * FROM _substrat_connections
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY tenant_id, vertical, provider`,
          )
          .all(...params) as ConnectionRow[];
        this.recordAccess(actor, 'listConnections', {}, f, rows.length);
        return rows.map(toConnection);
      },

      listConnectionGrants: async (actor: PlatformActorId, tenantId: TenantId) => {
        // #592: live rows only — the gather source for provision/reconcile delivery,
        // and the readable "what may this connection invoke". A revoked connection's
        // grants are tombstoned by the revoke cascade and absent by construction.
        const rows = this.directory
          .prepare(
            `SELECT * FROM _substrat_connection_grants
             WHERE tenant_id = ? AND revoked_at IS NULL
             ORDER BY connection_id, permission`,
          )
          .all(tenantId) as {
          connection_id: string;
          tenant_id: string;
          vertical: string;
          permission: string;
          scope_id: string | null;
          expires_at: string | null;
          granted_by: string;
          granted_at: string;
          revoked_at: string | null;
        }[];
        this.recordAccess(actor, 'listConnectionGrants', { tenantId }, null, rows.length);
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
        actor: PlatformActorId,
        id: ConnectionId,
        secret: ConnectionSecret,
        expiresAt?: string,
        opts?: { rotatedBy?: string },
      ) => {
        const row = this.connectionRow(id);
        const sealed = await this.secretBox.seal(JSON.stringify(connectionSecret.parse(secret)));
        const now = new Date().toISOString();
        this.directory
          .prepare(
            `UPDATE _substrat_connection_secrets
             SET key_id = ?, ciphertext = ?, updated_at = ? WHERE connection_id = ?`,
          )
          .run(sealed.keyId, sealed.ciphertext, now, id);
        // A refresh revives a connection that had lapsed or errored.
        this.directory
          .prepare(
            `UPDATE _substrat_connections
             SET status = 'active', expires_at = ?, last_error = NULL, last_error_at = NULL
             WHERE id = ?`,
          )
          .run(expiresAt ?? row.expires_at, id);
        // The event, never the token. "Rotated at T" is the auditable fact — plus WHO
        // authorized it when the rotation was a tenant admin's act (§3.5.1's attribution,
        // rotate-side): the principal, never laundered into the actor column.
        this.recordAdmin(
          actor,
          'updateConnectionSecret',
          { tenantId: row.tenant_id as TenantId, vertical: row.vertical },
          null,
          {
            id,
            provider: row.provider,
            rotatedAt: now,
            expiresAt: expiresAt ?? row.expires_at,
            ...(opts?.rotatedBy ? { rotatedBy: opts.rotatedBy } : {}),
          },
        );
      },

      revokeConnection: async (actor: PlatformActorId, id: ConnectionId) => {
        const row = this.connectionRow(id);
        if (row.revoked_at) return; // idempotent, and a no-op is not audited
        const now = new Date().toISOString();
        this.directory
          .prepare(`UPDATE _substrat_connections SET status = 'revoked', revoked_at = ? WHERE id = ?`)
          .run(now, id);
        // The sealed blob goes NOW. A tombstoned connection is evidence that a
        // grant existed (K-21); keeping the usable credential would make it a
        // liability instead. The row says what happened; the secret does not.
        this.directory
          .prepare('DELETE FROM _substrat_connection_secrets WHERE connection_id = ?')
          .run(id);
        // Connector state dies with the connection: it is that connection's
        // private bookkeeping and means nothing once it can no longer act.
        this.directory
          .prepare('DELETE FROM _substrat_connector_state WHERE connection_id = ?')
          .run(id);
        // #592: its grants tombstone (K-21 — evidence, not roster). Absent from the
        // next gather, so no later provision/reconcile delivers them again.
        this.directory
          .prepare(
            `UPDATE _substrat_connection_grants SET revoked_at = ?
             WHERE connection_id = ? AND revoked_at IS NULL`,
          )
          .run(now, id);
        this.recordAdmin(
          actor,
          'revokeConnection',
          { tenantId: row.tenant_id as TenantId, vertical: row.vertical },
          { status: row.status },
          { id, provider: row.provider, status: 'revoked', revokedAt: now },
        );
      },

      openConnection: async (
        tenantId: TenantId,
        vertical: string,
        provider: string,
        externalAccountRef?: string,
      ) => {
        const rows = this.directory
          .prepare(
            `SELECT * FROM _substrat_connections
             WHERE tenant_id = ? AND vertical = ? AND provider = ? AND revoked_at IS NULL
             ${externalAccountRef === undefined ? '' : 'AND external_account_ref = ?'}
             LIMIT 2`,
          )
          .all(
            ...(externalAccountRef === undefined
              ? [tenantId, vertical, provider]
              : [tenantId, vertical, provider, externalAccountRef]),
          ) as ConnectionRow[];
        // Several live accounts and no selector: failing beats acting against
        // an arbitrary one of the tenant's provider accounts (scope-host.ts).
        if (rows.length > 1) {
          throw new Error(
            `tenant ${tenantId} has multiple live '${provider}' connections for vertical ` +
              `'${vertical}' — pass externalAccountRef to select one`,
          );
        }
        const row = rows[0];
        if (!row) return undefined;
        const sealed = this.directory
          .prepare('SELECT key_id, ciphertext FROM _substrat_connection_secrets WHERE connection_id = ?')
          .get(row.id) as { key_id: string; ciphertext: string } | undefined;
        if (!sealed) return undefined; // revoked mid-flight, or never sealed
        const secret = connectionSecret.parse(
          JSON.parse(await this.secretBox.open({ keyId: sealed.key_id, ciphertext: sealed.ciphertext })),
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
        const now = new Date().toISOString();
        if (outcome.ok) {
          this.directory
            .prepare(
              `UPDATE _substrat_connections
               SET last_ok_at = ?, last_error = NULL, last_error_at = NULL,
                   status = CASE WHEN status = 'error' THEN 'active' ELSE status END
               WHERE id = ?`,
            )
            .run(now, id);
          return;
        }
        this.directory
          .prepare(
            `UPDATE _substrat_connections
             SET last_error = ?, last_error_at = ?,
                 status = CASE WHEN status = 'revoked' THEN status ELSE 'error' END
             WHERE id = ?`,
          )
          .run(outcome.error.slice(0, 2000), now, id);
      },

      putConnectorState: async (id: ConnectionId, key: string, value: unknown) => {
        this.directory
          .prepare(
            `INSERT INTO _substrat_connector_state (connection_id, state_key, value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (connection_id, state_key)
             DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(id, key, JSON.stringify(value ?? null), new Date().toISOString());
      },

      getConnectorState: async (id: ConnectionId, key: string) => {
        const row = this.directory
          .prepare('SELECT value FROM _substrat_connector_state WHERE connection_id = ? AND state_key = ?')
          .get(id, key) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as unknown) : undefined;
      },

      listConnectorState: async (id: ConnectionId, prefix?: string) => {
        const rows = this.directory
          .prepare(
            'SELECT state_key, value FROM _substrat_connector_state WHERE connection_id = ? ORDER BY state_key',
          )
          .all(id) as { state_key: string; value: string }[];
        // Prefix filter in JS: the key space per connection is small (one row per
        // dispatch), and it dodges LIKE/GLOB metacharacter escaping on the prefix.
        return rows
          .filter((r) => !prefix || r.state_key.startsWith(prefix))
          .map((r) => ({ key: r.state_key, value: JSON.parse(r.value) as unknown }));
      },

      linkIdentity: async (actor: PlatformActorId, input: IdentityLink) => {
        const parsed = identityLink.parse(input);
        requirePoolServes(parsed.provider, parsed.tenantId);
        // Read before write. `INSERT OR IGNORE` alone cannot tell "already bound to the
        // same principal" (idempotent) from "already bound to someone else" (a
        // collision), and silently ignoring the second resolves one person as another.
        const existing = this.directory
          .prepare(
            `SELECT principal_id FROM _substrat_identities
             WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
          )
          .get(parsed.tenantId, parsed.provider, parsed.externalId) as
          | { principal_id: string }
          | undefined;
        if (existing) {
          if (existing.principal_id === parsed.principal) return; // idempotent, unaudited
          throw new Error(
            `identity ${parsed.provider}:${parsed.externalId} in tenant ${parsed.tenantId} ` +
              `is already bound to ${existing.principal_id}`,
          );
        }
        this.directory
          .prepare(
            `INSERT INTO _substrat_identities
               (provider, external_id, principal_id, tenant_id, scope_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.provider,
            parsed.externalId,
            parsed.principal,
            parsed.tenantId,
            parsed.scopeId ?? null,
            new Date().toISOString(),
          );
        this.recordAdmin(
          actor,
          'linkIdentity',
          { tenantId: parsed.tenantId, scopeId: parsed.scopeId },
          null,
          { provider: parsed.provider, externalId: parsed.externalId, principal: parsed.principal },
        );
      },
      unlinkIdentity: async (actor: PlatformActorId, tenantId: TenantId, principal: PrincipalId) => {
        // DELETE, not a tombstone — the identity map is current state (audit is the log),
        // and re-inviting must be able to re-link a fresh principal for the same person.
        const info = this.directory
          .prepare(`DELETE FROM _substrat_identities WHERE tenant_id = ? AND principal_id = ?`)
          .run(tenantId, principal);
        if (info.changes === 0) return; // no link — idempotent, unaudited
        this.recordAdmin(actor, 'unlinkIdentity', { tenantId, scopeId: null }, { principal }, null);
      },
      resolveIdentity: async (
        tenantId: TenantId,
        provider: string,
        externalId: string,
      ): Promise<ResolvedIdentity | undefined> => {
        const row = this.directory
          .prepare(
            `SELECT principal_id, scope_id FROM _substrat_identities
             WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
          )
          .get(tenantId, provider, externalId) as
          | { principal_id: string; scope_id: string | null }
          | undefined;
        if (!row) return undefined;
        return resolvedIdentity.parse({ principal: row.principal_id, scopeId: row.scope_id });
      },
      accessLog: async (actor, filter?: AccessLogFilter): Promise<AccessLogEntry[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.actor) { where.push('actor = ?'); params.push(filter.actor); }
        if (filter?.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId); }
        if (filter?.method) { where.push('method = ?'); params.push(filter.method); }
        if (filter?.drained !== undefined) {
          where.push(filter.drained ? 'drained_at IS NOT NULL' : 'drained_at IS NULL');
        }
        // Cursor + order mirror auditLog: the id is a ULID, so it IS the cursor.
        const tail = keysetTail(where, params, 'id', filter);
        let sql = 'SELECT * FROM _substrat_access_log';
        if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
        sql += tail;
        const rows = this.directory.prepare(sql).all(...params) as AccessLogRow[];
        // Reading the access log is itself a read. Recorded BEFORE the rows are
        // returned, so the row describing this call is not in its own result.
        this.recordAccess(actor, 'accessLog', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
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
        // `drained_at IS NULL` makes the stamp idempotent: a retried pass that ships
        // the same batch twice re-stamps nothing and reports 0, so the admin log does
        // not grow a row claiming an egress that already happened.
        const info = this.directory
          .prepare(
            `UPDATE _substrat_access_log SET drained_at = ?
             WHERE id <= ? AND drained_at IS NULL`,
          )
          .run(drainedAt, upToId);
        if (info.changes > 0) {
          // The payload is the APPLIED state, so it belongs in `after` (contracts'
          // adminLogEntry: before = prior state, after = the applied payload).
          this.recordAdmin(
            actor,
            'drainAccessLog',
            { tenantId: null },
            null,
            { drained: info.changes, upToId, drainedAt },
          );
        }
        return info.changes;
      },
      pruneAccessLog: async (actor, limit: number): Promise<number> => {
        // ONLY drained rows. Age alone is not a licence to delete evidence.
        const info = this.directory
          .prepare(
            `DELETE FROM _substrat_access_log WHERE id IN (
               SELECT id FROM _substrat_access_log WHERE drained_at IS NOT NULL ORDER BY id LIMIT ?
             )`,
          )
          .run(limit);
        if (info.changes > 0) {
          // The payload is the APPLIED state, so it belongs in `after` (contracts'
          // adminLogEntry: before = prior state, after = the applied payload) — the
          // same shape as drainAccessLog's row above (#557).
          this.recordAdmin(actor, 'pruneAccessLog', { tenantId: null }, null, { pruned: info.changes });
        }
        return info.changes;
      },
      auditLog: async (actor, filter?: AuditLogFilter): Promise<AdminLogEntry[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.scopeId) {
          where.push('scope_id = ?');
          params.push(filter.scopeId);
        }
        if (filter?.actor) {
          where.push('actor = ?');
          params.push(filter.actor);
        }
        if (filter?.action) {
          const actions = Array.isArray(filter.action) ? filter.action : [filter.action];
          if (actions.length === 0) return []; // no action is acceptable — match nothing
          where.push(`action IN (${actions.map(() => '?').join(', ')})`);
          params.push(...actions);
        }
        if (filter?.since) {
          where.push('at >= ?');
          params.push(filter.since);
        }
        if (filter?.until) {
          where.push('at < ?');
          params.push(filter.until);
        }
        const order = filter?.order === 'desc' ? 'DESC' : 'ASC';
        if (filter?.cursor) {
          // ULID order is chronological, so the entry id IS the cursor: page
          // forward past it in asc, backward before it in desc.
          where.push(order === 'DESC' ? 'id < ?' : 'id > ?');
          params.push(filter.cursor);
        }
        let sql =
          'SELECT * FROM _substrat_admin_log' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ` ORDER BY id ${order}`;
        if (filter?.limit !== undefined) {
          sql += ' LIMIT ?';
          params.push(filter.limit);
        }
        const rows = this.directory.prepare(sql).all(...params) as AdminLogRow[];
        // Reading the audit trail is itself audited. Who examined the record of
        // who did what is exactly the question an incident asks second.
        this.recordAccess(
          actor,
          'auditLog',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map((r) =>
          adminLogEntry.parse({
            id: r.id,
            actor: r.actor,
            action: r.action,
            tenantId: r.tenant_id,
            scopeId: r.scope_id,
            vertical: r.vertical,
            before: r.before === null ? null : JSON.parse(r.before),
            after: r.after === null ? null : JSON.parse(r.after),
            causedBy: r.caused_by,
            at: r.at,
          }),
        );
      },
      recordOpsFailure: async (entry: OpsFailureInput): Promise<void> => {
        this.directory
          .prepare(
            `INSERT INTO _substrat_ops_failures
               (id, actor, operation, stage, tenant_id, scope_id, vertical, status, message, reference, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ulid(),
            entry.actor,
            entry.operation,
            entry.stage ?? null,
            entry.tenantId ?? null,
            entry.scopeId ?? null,
            entry.vertical ?? null,
            entry.status ?? null,
            // Bounded here, not trusted from the catch site: one runaway upstream
            // body must not become a runaway directory row (#559).
            entry.message.slice(0, 2000),
            entry.reference ?? null,
            new Date().toISOString(),
          );
        // Prune-on-write (#559): retention lives here, not in a cron — every insert
        // pays for its own housekeeping, so the table stays bounded even where no
        // scheduled pass runs (this adapter has none).
        const horizon = new Date(Date.now() - OPS_FAILURE_RETENTION_DAYS * 86_400_000).toISOString();
        this.directory.prepare('DELETE FROM _substrat_ops_failures WHERE at < ?').run(horizon);
      },
      listOpsFailures: async (actor, filter?: OpsFailureFilter): Promise<OpsFailureEntry[]> => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filter?.tenantId) {
          where.push('tenant_id = ?');
          params.push(filter.tenantId);
        }
        if (filter?.scopeId) {
          where.push('scope_id = ?');
          params.push(filter.scopeId);
        }
        if (filter?.vertical) {
          where.push('vertical = ?');
          params.push(filter.vertical);
        }
        if (filter?.operation) {
          where.push('operation = ?');
          params.push(filter.operation);
        }
        if (filter?.reference) {
          where.push('reference = ?');
          params.push(filter.reference);
        }
        if (filter?.since) {
          where.push('at >= ?');
          params.push(filter.since);
        }
        if (filter?.until) {
          where.push('at < ?');
          params.push(filter.until);
        }
        // Default DESC, unlike the audit log: an operator asks "what broke lately".
        const order = (filter?.order ?? 'desc') === 'desc' ? 'DESC' : 'ASC';
        if (filter?.cursor) {
          // ULID order is chronological, so the entry id IS the cursor.
          where.push(order === 'DESC' ? 'id < ?' : 'id > ?');
          params.push(filter.cursor);
        }
        let sql =
          'SELECT * FROM _substrat_ops_failures' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ` ORDER BY id ${order}`;
        if (filter?.limit !== undefined) {
          sql += ' LIMIT ?';
          params.push(filter.limit);
        }
        const rows = this.directory.prepare(sql).all(...params) as OpsFailureRow[];
        // Rows can name tenants and scopes, so reading them is recorded like the
        // audit trail's own reads (K-24).
        this.recordAccess(
          actor,
          'listOpsFailures',
          { tenantId: filter?.tenantId ?? null, scopeId: filter?.scopeId ?? null },
          filter,
          rows.length,
        );
        return rows.map((r) =>
          opsFailureEntry.parse({
            id: r.id,
            actor: r.actor,
            operation: r.operation,
            stage: r.stage,
            tenantId: r.tenant_id,
            scopeId: r.scope_id,
            vertical: r.vertical,
            status: r.status,
            message: r.message,
            reference: r.reference,
            at: r.at,
          }),
        );
      },
    };
  }

  /**
   * The directory's own migration path (control-plane.md §7: "the directory
   * becomes a real database, with its own migrations"). It is not a module, so
   * it has no `SqlMigration[]` journal — but a dev directory created before the
   * scope record grew its naming columns must still open. ALTER in what's
   * missing, backfill legacy rows to the same defaults `provisionScope` applies,
   * then add the uniqueness the contract has always claimed ("slug — unique
   * within tenant"). Idempotent: on a fresh directory every column already
   * exists and every UPDATE matches nothing.
   */
  /**
   * Additive column migration for a table that already exists in someone's data
   * directory. `PRAGMA table_info` is available in the pure adapter (the DO adapter
   * has to attempt-and-tolerate instead — see its `ensureDirectoryColumns`).
   */
  private ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
    const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
    if (!existing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  /**
   * Rebuild `_substrat_identities` when it still carries the pre-K-22 global key.
   * A PRIMARY KEY cannot be ALTERed, so this is create-copy-drop-rename.
   *
   * The old shape is detected from `sqlite_master.sql` rather than `PRAGMA table_info`
   * (which reports PK membership but not composition readably), and because the same
   * check works on DO SQLite, where PRAGMA is restricted — so both adapters can use
   * one detection strategy.
   *
   * Rows carry `tenant_id` already, so the copy is lossless: what changes is which
   * columns are unique, not what is stored. Two pools that both issued `123` were
   * previously ONE row (the second link silently ignored); after the rebuild the
   * surviving row keeps its tenant and the other tenant's link can be made again.
   */
  private ensureIdentityKey(): void {
    const row = this.directory
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('_substrat_identities') as { sql: string } | undefined;
    if (!row || row.sql.includes('PRIMARY KEY (tenant_id, provider, external_id)')) return;
    this.directory.exec(`
      CREATE TABLE _substrat_identities_new (
        provider     TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        scope_id     TEXT,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, provider, external_id)
      );
      INSERT OR IGNORE INTO _substrat_identities_new
        (provider, external_id, principal_id, tenant_id, scope_id, created_at)
        SELECT provider, external_id, principal_id, tenant_id, scope_id, created_at
        FROM _substrat_identities;
      DROP TABLE _substrat_identities;
      ALTER TABLE _substrat_identities_new RENAME TO _substrat_identities;
    `);
  }

  /**
   * Drop the admin log's `tenant_id NOT NULL` (K-23). SQLite cannot relax a column
   * constraint in place, so this is the same create-copy-drop-rename the identity key
   * uses, detected the same way — from `sqlite_master.sql`, which works on DO SQLite
   * too. Rows are copied verbatim: the log stays append-only in content, this only
   * widens what a future row may say.
   */
  private ensureAdminLogTenantNullable(): void {
    const row = this.directory
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('_substrat_admin_log') as { sql: string } | undefined;
    if (!row || !/tenant_id TEXT NOT NULL/.test(row.sql)) return;
    this.directory.exec(`
      CREATE TABLE _substrat_admin_log_new (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        tenant_id TEXT,
        scope_id TEXT,
        vertical TEXT,
        before TEXT,
        after TEXT,
        at TEXT NOT NULL
      );
      INSERT INTO _substrat_admin_log_new
        SELECT id, actor, action, tenant_id, scope_id, vertical, before, after, at
        FROM _substrat_admin_log;
      DROP TABLE _substrat_admin_log;
      ALTER TABLE _substrat_admin_log_new RENAME TO _substrat_admin_log;
    `);
  }

  private ensureDirectoryColumns(): void {
    this.ensureIdentityKey();
    this.ensureAdminLogTenantNullable();
    // The pre-account-aware live-uniqueness index: superseded by
    // _substrat_connections_live_account (created in the bootstrap DDL), which
    // adds the external-account leg so one tenant can hold the same provider
    // under several accounts. Existing data always satisfies the wider key.
    this.directory.exec('DROP INDEX IF EXISTS _substrat_connections_live');
    this.ensureColumn(this.directory, '_substrat_admin_log', 'caused_by', 'caused_by TEXT');
    // §4.8's grace-window timestamp on tenants (mirrors scopes' archived_at).
    this.ensureColumn(this.directory, 'tenants', 'deleting_at', 'deleting_at TEXT');
    this.ensureColumn(
      this.directory,
      'tenants',
      'provisioned_by_tenant',
      'provisioned_by_tenant TEXT REFERENCES tenants(tenant_id)',
    );
    // §4.7 custom-hostname issuance: CF's hostname id + the DNS records to publish (JSON).
    this.ensureColumn(this.directory, 'hostnames', 'custom_hostname_id', 'custom_hostname_id TEXT');
    this.ensureColumn(this.directory, 'hostnames', 'validation_records', 'validation_records TEXT');
    // K-21's tombstone on tenant-level tuples (membership lives here).
    this.ensureColumn(this.directory, '_substrat_tenant_tuples', 'revoked_at', 'revoked_at TEXT');
    // builder-plane.md Phase 1b: who owns a vertical (NULL = platform-owned).
    this.ensureColumn(this.directory, 'verticals', 'owner_tenant', 'owner_tenant TEXT');
    this.ensureColumn(this.directory, 'verticals', 'env_spec', 'env_spec TEXT');
    // marketplace-publish.md §3: registry-driven install metadata (one JSON blob).
    this.ensureColumn(this.directory, 'verticals', 'install_spec', 'install_spec TEXT');
    this.ensureColumn(this.directory, 'verticals', 'listed', 'listed INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(this.directory, 'verticals', 'publish_requested_at', 'publish_requested_at TEXT');
    this.ensureColumn(this.directory, 'verticals', 'installs_blocked', 'installs_blocked INTEGER NOT NULL DEFAULT 0');
    // #412: the tenant-provisioner capability — a staff grant on the registry row.
    this.ensureColumn(this.directory, 'verticals', 'tenant_provisioner', 'tenant_provisioner INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(this.directory, 'verticals', 'email_sender', 'email_sender INTEGER NOT NULL DEFAULT 0');
    // #286: the stable serving script + what the next in-place upload diffs against.
    this.ensureColumn(this.directory, 'verticals', 'serving_ref', 'serving_ref TEXT');
    this.ensureColumn(this.directory, 'verticals', 'serving_version_id', 'serving_version_id TEXT');
    this.ensureColumn(this.directory, 'verticals', 'serving_do_classes', 'serving_do_classes TEXT');
    this.ensureColumn(this.directory, 'verticals', 'serving_migration_tag', 'serving_migration_tag TEXT');
    this.ensureColumn(this.directory, 'vertical_versions', 'manifest_json', 'manifest_json TEXT');
    // Push provenance (git CI vs a terminal) — null for a pre-tracking push.
    this.ensureColumn(this.directory, 'vertical_versions', 'origin_json', 'origin_json TEXT');
    // #33: the SKU flag learns to express a plan. All nullable — a legacy row
    // reads as a perpetual boolean flag, exactly its pre-widening semantics.
    for (const [col, ddl] of [
      ['expires_at', 'expires_at TEXT'],
      ['quota', 'quota INTEGER'],
      ['plan', 'plan TEXT'],
      ['granted_at', 'granted_at TEXT'],
      ['granted_by', 'granted_by TEXT'],
    ] as const) {
      this.ensureColumn(this.directory, '_substrat_entitlements', col, ddl);
    }
    const existing = new Set(
      (this.directory.prepare('PRAGMA table_info(scopes)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const [column, ddl] of [
      ['parent_scope_id', 'parent_scope_id TEXT'],
      ['slug', 'slug TEXT'],
      ['kind', 'kind TEXT'],
      ['name', 'name TEXT'],
      ['vertical', 'vertical TEXT'],
      ['vertical_version_id', 'vertical_version_id TEXT'],
      ['migration_failed_version', 'migration_failed_version TEXT'],
      ['migration_error', 'migration_error TEXT'],
      ['migration_attempts', 'migration_attempts INTEGER NOT NULL DEFAULT 0'],
      ['migration_last_attempt_at', 'migration_last_attempt_at TEXT'],
      ['forked_from', 'forked_from TEXT'],
      ['forked_at', 'forked_at TEXT'],
      ['expires_at', 'expires_at TEXT'],
      ['serving_ref', 'serving_ref TEXT'],
      ['archived_at', 'archived_at TEXT'],
    ] as const) {
      if (!existing.has(column)) this.directory.exec(`ALTER TABLE scopes ADD COLUMN ${ddl}`);
    }
    // A ULID lowercases into a valid slug, so the placeholder is unique by
    // construction — the same default provisionScope resolves.
    this.directory.exec(`
      UPDATE scopes SET slug = lower(scope_id) WHERE slug IS NULL;
      UPDATE scopes SET kind = 'scope' WHERE kind IS NULL;
      UPDATE scopes SET name = slug WHERE name IS NULL;
    `);
    // Created after the backfill: a UNIQUE index over NULL slugs would permit the
    // duplicates it exists to forbid (SQLite treats NULLs as distinct).
    //
    // PARTIAL on the live statuses: an `archived` scope (a deleted app) and a `reaped`
    // one keep their directory row as a tombstone but release their name (§4.4), so the
    // slug must be reclaimable while the row survives — matching the CF adapter, which
    // has no unique index and gates on the same pre-check. A full index would let the
    // tombstone block the reuse the contract intends. DROP-then-create so a DB carrying
    // the old full index (an escrow/self-host file) is migrated to the partial one.
    this.directory.exec('DROP INDEX IF EXISTS scopes_tenant_slug');
    this.directory.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS scopes_tenant_slug ON scopes (tenant_id, slug) " +
        "WHERE status NOT IN ('archived', 'reaped')",
    );
    this.directory.exec('CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug ON tenants (slug)');
    this.directory.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS orgs_tenant_slug ON orgs (tenant_id, slug)',
    );
  }

  private loadRoles(): void {
    const rows = this.directory
      .prepare('SELECT tenant_id, role_key, permissions, source FROM _substrat_roles')
      .all() as { tenant_id: string; role_key: string; permissions: string; source: string }[];
    for (const r of rows) {
      this.roles.set(`${r.tenant_id}/${r.role_key}`, {
        key: r.role_key,
        permissions: JSON.parse(r.permissions),
        source: r.source,
      } as RoleDefinition);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * `subject` decides BOTH the permission check and the event actor, so the two
   * can never disagree about who acted (#97). `overrideActor` remains for the
   * system-actor path, where the acting module is the honest answer.
   */
  private operationContext(
    rt: ScopeRuntime,
    subject: CheckSubject,
    overrideActor?: { system: string },
    /** #458: per-invoke tally of `ctx.requestPlatform` calls; absent for consumer dispatch. */
    signals?: { platformRequests: number },
  ): OperationContext {
    const principal = subject.id as PrincipalId;
    const checker = this.checker;
    const relations = this.relations;
    const searchPlans = this.searchPlans;
    const listPlans = this.listPlans;
    // K-34: the checks that passed in THIS operation. The context is created per invoke
    // (see buildStub), so this accumulates one operation's authorizations; `emit` snapshots
    // whatever has passed up to that point. A system/override actor is unconditionally
    // allowed, so its checks are not authorizations and are not recorded.
    const passed: EventAuthorization[] = [];

    /**
     * The operation's instant (#812), read ONCE when the context is built.
     *
     * Everything the operation stamps — its own rows via `ctx.now()`, the
     * `occurredAt` on every event it emits, the `requested_at` on every platform
     * intent it enqueues — comes from here, so a row and the event announcing it
     * can never disagree about when. Reading the clock per-call would have made
     * `ctx.now()` deterministic only in the sense that each reading is separately
     * unpredictable.
     */
    const at = this.clock();

    /**
     * The scope host's half of `ctx.atomic` (#770) — everything else is the
     * kernel's (`createAtomic`). SQLite gives us savepoints, which nest inside
     * the operation's `BEGIN IMMEDIATE` and roll back independently.
     *
     * `ROLLBACK TO` does not pop the savepoint, so the `RELEASE` after it is
     * what keeps the stack balanced. It runs in its own try: if the enclosing
     * transaction has been aborted outright (`SQLITE_FULL`, `SQLITE_BUSY`, an
     * explicit `ON CONFLICT ROLLBACK`) the unwind fails too, and the caller is
     * far better served by the ORIGINAL error than by the one raised while
     * trying to recover from it.
     */
    const runSub: RunSub = async (depth, fn) => {
      const name = `substrat_sub_${depth}`;
      rt.db.exec(`SAVEPOINT ${name}`);
      let out: unknown;
      try {
        out = await fn();
      } catch (err) {
        try {
          rt.db.exec(`ROLLBACK TO ${name}`);
          rt.db.exec(`RELEASE ${name}`);
        } catch {
          /* the transaction itself is gone; the original error is the useful one */
        }
        throw err;
      }
      rt.db.exec(`RELEASE ${name}`);
      return out as never;
    };

    // Lifted out of the object literal so `grant` can reuse it: a delegation
    // check has to be the SAME check the operation itself passes, or the two
    // could disagree about what the caller holds.
    const runCheck: OperationContext['check'] = async (permission, entity?) => {
      if (overrideActor) {
        return {
          allowed: true as const,
          proof: [
            {
              subject: objectRef.parse(
                `system:${overrideActor.system.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
              ),
              relation: `granted:${permission}`,
              object: objectRef.parse(`scope:${rt.scopeId}`),
            },
          ],
        };
      }
      const decision = await checker.check(
        subject,
        permission,
        { tenantId: rt.tenantId, scopeId: rt.scopeId },
        entity,
      );
      if (decision.allowed) {
        const grant = grantRefFromProof(permission, decision.proof);
        const entry: EventAuthorization = grant ? { permission, grant } : { permission };
        if (!passed.some((p) => p.permission === entry.permission && p.grant === entry.grant)) {
          passed.push(entry);
        }
      }
      return decision;
    };

    return {
      tenantId: rt.tenantId,
      scopeId: rt.scopeId,
      principal,
      sql: scopedSql(rt.db),
      now: () => at,
      emit: (event: DomainEventInput) => {
        const input = domainEventInput.parse(event);
        const full = domainEvent.parse({
          ...input,
          id: eventId.parse(ulid()),
          occurredAt: at,
          tenantId: rt.tenantId,
          scopeId: rt.scopeId,
          actor:
            overrideActor ??
            (subject.kind === 'system'
              ? { system: subject.id }
              : subject.kind === 'connection'
                ? { connection: subject.id }
                : principal),
          ...(passed.length ? { authorization: passed.map((p) => ({ ...p })) } : {}),
        });
        rt.db
          .prepare(
            `INSERT INTO _substrat_outbox
               (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
                entity_type, entity_id, pii_class, subject_id, authorization, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
            full.payload === undefined ? null : JSON.stringify(full.payload),
          );
      },
      requestPlatform: (request: PlatformRequestInput): PlatformRequestId => {
        const input = platformRequestInput.parse(request);
        // Backpressure (platform-intents.md): refuse when the scope already holds too many pending
        // intents, so a stuck or runaway vertical cannot flood the platform drain.
        const pending = (
          rt.db
            .prepare(`SELECT COUNT(*) AS c FROM _substrat_platform_requests WHERE status = 'pending'`)
            .get() as { c: number }
        ).c;
        if (pending >= MAX_PENDING_PLATFORM_REQUESTS) {
          throw new Error(`too many pending platform requests (${pending}); retry once some have drained`);
        }
        const id = platformRequestId.parse(ulid());
        const requestedBy =
          overrideActor ??
          (subject.kind === 'system'
            ? { system: subject.id }
            : subject.kind === 'connection'
              ? { connection: subject.id }
              : principal);
        rt.db
          .prepare(
            `INSERT INTO _substrat_platform_requests
               (id, kind, payload, requested_by, status, attempts, requested_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
          )
          .run(
            id,
            input.kind,
            JSON.stringify(input.payload ?? null),
            JSON.stringify(requestedBy),
            at,
          );
        if (signals) signals.platformRequests += 1;
        return id;
      },
      // The read half of `requestPlatform` (#618) — this scope's own journal, so no tenancy
      // predicate is needed or possible: the runtime IS the scope.
      platformRequests: (filter?: PlatformRequestFilter): PlatformRequest[] => {
        const q = platformRequestHistoryQuery(filter);
        return (rt.db.prepare(q.sql).all(...q.params) as PlatformRequestRawRow[]).map(
          rowToPlatformRequest,
        );
      },
      check: runCheck,
      /**
       * #827. The plan is registration state, the index is scope state: an entity
       * type nobody declared is `NotSearchable` (a wiring mistake), and a declared
       * one whose index has not been provisioned in THIS scope cannot happen —
       * the DDL rides the same journal as the module's own migrations.
       */
      search: (entityType: string, term: string, options?: SearchOptions): SearchHit[] => {
        const plan = searchPlans.get(entityType);
        if (!plan) throw new NotSearchable(entityType);
        const q = searchQuery(
          plan,
          searchMatchExpression(term, plan.tokenizer),
          searchLimit(options?.limit),
        );
        return (rt.db.prepare(q.sql).all(...q.params) as { id: string; rank: number }[]).map(
          (row) => ({ entityType, id: row.id, rank: row.rank }),
        );
      },
      /**
       * #811. The plan is registration state, the indexes are scope state — same
       * split as search, and the same consequence: an entity nobody declared is
       * `NotListable` (a wiring mistake), while a declared one whose indexes are
       * missing in THIS scope cannot happen, because the DDL rides the same
       * journal as the module's own migrations.
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
        });
        const rows = rt.db.prepare(q.sql).all(...(q.params as never[])) as Record<
          string,
          unknown
        >[];
        // A FULL page may have more; a short one is the end of the walk. Same rule
        // as `pageOf`, applied here because the cursor is a COLUMN's value (plus
        // the tie-break) rather than a field the caller could name.
        const last = rows.length >= limit ? rows[rows.length - 1] : undefined;
        const nextCursor =
          last === undefined ? null : cursorOf(last, q.sortColumn, plan.idColumn);
        const page = { entries: rows as T[], nextCursor };
        if (!params.total) return page;
        const counted = rt.db.prepare(q.countSql).all(...(q.countParams as never[])) as {
          n: number;
        }[];
        return { ...page, total: counted[0]?.n ?? 0 };
      },
      /**
       * Narrow a permission this caller already holds onto one entity (#K-sharing).
       *
       * The verb user-initiated sharing needs, and the reason it did not exist:
       * every entity-narrowed grant in the fleet is made at SEED time by
       * `host.admin.grant`, so an app where a person shares their own record with
       * someone had no supported mechanism at all.
       *
       * Two guardrails make it non-escalating by construction:
       *
       * 1. **Entity-narrowed only.** `entity` is required, so module code can
       *    never write a scope-wide or tenant-wide grant.
       * 2. **You may only grant what you hold ON THAT ENTITY.** The caller's own
       *    decision is re-checked here rather than trusted, so an operation
       *    cannot hand out more than it was given — delegation, never elevation.
       *
       * A system/override actor is allowed by construction and therefore skips
       * guardrail 2 the same way its `check` does.
       */
      grant: async (principal: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
        const held = await runCheck(permission, entity);
        if (!held.allowed) {
          throw new PermissionDenied(
            `cannot grant '${permission}' on ${entity.entityType}:${entity.entityId} — ` +
              'the caller does not hold it there (a grant delegates, it never elevates)',
          );
        }
        rt.db
          .prepare(
            `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object)
             VALUES (?, ?, ?)`,
          )
          .run(
            `principal:${principal}`,
            `granted:${permission}`,
            `${entity.entityType}:${entity.entityId}`,
          );
      },
      /** Withdraw a grant this caller could have made. Same guardrails, same reason. */
      revoke: async (principal: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
        const held = await runCheck(permission, entity);
        if (!held.allowed) {
          throw new PermissionDenied(
            `cannot revoke '${permission}' on ${entity.entityType}:${entity.entityId} — ` +
              'the caller does not hold it there',
          );
        }
        rt.db
          .prepare(
            `DELETE FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?`,
          )
          .run(
            `principal:${principal}`,
            `granted:${permission}`,
            `${entity.entityType}:${entity.entityId}`,
          );
      },
      atomic: createAtomic(runSub, { passed, signals }),
      link: (child: EntityRef, parent: EntityRef) => {
        const allowed = relations.get(child.entityType);
        if (!allowed?.has(parent.entityType)) {
          throw new Error(
            `undeclared entity relation: ${child.entityType} → ${parent.entityType} ` +
              `(declare it in a module manifest's entityRelations)`,
          );
        }
        rt.db
          .prepare(
            `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object)
             VALUES (?, 'parent', ?)`,
          )
          .run(`${child.entityType}:${child.entityId}`, `${parent.entityType}:${parent.entityId}`);
      },
      // #304: the request-time entitlement read. The pure adapter is single-process, so the
      // directory is local — no projection needed; it reads `_substrat_entitlements` straight,
      // with the same expiry-at-read filter as the gate (#33), and the SAME contract the DO
      // adapter satisfies through its scope-local projection. `plan`/`quota` are exposed, not
      // enforced — the kernel gates presence + expiry, the vertical decides what quota means.
      entitlement: async (key: string): Promise<EntitlementView | null> => {
        const row = this.directory
          .prepare(
            `SELECT entitlement_key, plan, quota, expires_at FROM _substrat_entitlements
             WHERE tenant_id = ? AND entitlement_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .get(rt.tenantId, key, new Date().toISOString()) as
          | { entitlement_key: string; plan: string | null; quota: number | null; expires_at: string | null }
          | undefined;
        return row
          ? { key: row.entitlement_key, plan: row.plan, quota: row.quota, expiresAt: row.expires_at as EntitlementView['expiresAt'] }
          : null;
      },
      entitlements: async (): Promise<EntitlementView[]> => {
        const rows = this.directory
          .prepare(
            `SELECT entitlement_key, plan, quota, expires_at FROM _substrat_entitlements
             WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .all(rt.tenantId, new Date().toISOString()) as {
          entitlement_key: string;
          plan: string | null;
          quota: number | null;
          expires_at: string | null;
        }[];
        return rows.map((r) => ({
          key: r.entitlement_key,
          plan: r.plan,
          quota: r.quota,
          expiresAt: r.expires_at as EntitlementView['expiresAt'],
        }));
      },
      // #687: seal a value to the connector that will receive it. The pure adapter is
      // single-process, so the directory is right here — no projection needed, and the
      // SAME contract the DO adapter satisfies through its scope-local projection. The
      // division is deliberate and matches `entitlement` above: identical semantics,
      // adapter-appropriate storage. Only the PUBLIC half is ever read on this path.
      sealToConnection: async (provider: string, plaintext: string) => {
        const vertical =
          (
            this.directory
              .prepare('SELECT vertical FROM scopes WHERE scope_id = ?')
              .get(rt.scopeId) as { vertical: string | null } | undefined
          )?.vertical ?? null;
        const row = vertical
          ? (this.directory
              .prepare(
                `SELECT id FROM _substrat_connections
                 WHERE tenant_id = ? AND vertical = ? AND provider = ? AND revoked_at IS NULL
                 ORDER BY created_at LIMIT 1`,
              )
              .get(rt.tenantId, vertical, provider) as { id: string } | undefined)
          : undefined;
        if (!row) {
          throw new ConnectionSealingKeyUnavailableError(
            provider,
            noSealingKeyMessage(provider, rt.scopeId),
          );
        }
        const key = await this.ensureSealingKey(row.id);
        return sealTo({ keyId: key.keyId, publicKey: key.publicKey }, plaintext);
      },
    };
  }

  private async applyPendingMigrations(rt: ScopeRuntime): Promise<void> {
    const pending: { moduleId: string; migration: SqlMigration }[] = [];
    for (const mod of this.modules.values()) {
      for (const migration of mod.migrations) {
        if (!rt.appliedMigrations.has(`${mod.id}@${migration.version}`)) {
          pending.push({ moduleId: mod.id, migration });
        }
      }
    }
    // Nothing pending → nothing to record. A scope provisioned before any module
    // registers legitimately sits at schema_version '0'.
    if (pending.length === 0) return;
    // The failing `module@version` and its cause, captured structurally rather than
    // re-parsed out of the thrown message — the directory record has to name both.
    let failure: { version: string; error: string } | undefined;
    try {
      await rt.actor.enqueue(() => {
        for (const { moduleId, migration } of pending) {
          const key = `${moduleId}@${migration.version}`;
          if (rt.appliedMigrations.has(key)) continue;
          rt.db.exec('BEGIN IMMEDIATE');
          try {
            const already = rt.db
              .prepare('SELECT 1 FROM _substrat_migrations WHERE module_id = ? AND version = ?')
              .get(moduleId, migration.version);
            if (!already) {
              rt.db.exec(migration.sql);
              rt.db
                .prepare(
                  'INSERT INTO _substrat_migrations (module_id, version, applied_at) VALUES (?, ?, ?)',
                )
                .run(moduleId, migration.version, new Date().toISOString());
            }
            rt.db.exec('COMMIT');
          } catch (err) {
            rt.db.exec('ROLLBACK');
            failure = { version: key, error: (err as Error).message };
            throw new Error(
              `migration failed for ${key} — scope fails closed: ${(err as Error).message}`,
            );
          }
          rt.appliedMigrations.add(key);
        }
      });
    } finally {
      // `finally`, not the success path: a scope that failed closed is exactly the
      // one the fleet needs to see, and projecting only on success is what let a
      // half-migrated scope keep a stale `schema_version` and render as healthy
      // (#32). The throw still propagates — recording is not recovering.
      this.recordMigrationState(rt, failure);
    }
  }

  /**
   * Project a scope's migration state into the directory — §5.4's "fleet questions
   * never fan out", so the index answers "which scopes are behind" and "which
   * failed" without waking anything.
   *
   * `appliedMigrations.size` is written on both paths: after a partial failure it
   * is the count that actually landed, which is more truthful than the pre-attempt
   * value. On success the failure columns are cleared, so `attempts` counts
   * *consecutive* failures — what the sweep's backoff (#49) needs.
   */
  private recordMigrationState(
    rt: ScopeRuntime,
    failure: { version: string; error: string } | undefined,
  ): void {
    const version = String(rt.appliedMigrations.size);
    if (!failure) {
      this.directory
        .prepare(
          `UPDATE scopes SET schema_version = ?, migration_failed_version = NULL,
             migration_error = NULL, migration_attempts = 0, migration_last_attempt_at = NULL
           WHERE scope_id = ?`,
        )
        .run(version, rt.scopeId);
      return;
    }
    this.directory
      .prepare(
        `UPDATE scopes SET schema_version = ?, migration_failed_version = ?,
           migration_error = ?, migration_attempts = migration_attempts + 1,
           migration_last_attempt_at = ?
         WHERE scope_id = ?`,
      )
      .run(version, failure.version, failure.error, new Date().toISOString(), rt.scopeId);
  }

  /**
   * The scope's own database handle, after cross-checking the (tenantId, scopeId)
   * pair against the directory (K-3). A scope that is absent, or lives under a
   * DIFFERENT tenant, throws — the introspection reads never open another tenant's
   * DB, and never CREATE one for an id that was never provisioned.
   */
  private scopeDbFor(tenantId: TenantId, scopeId: ScopeId): Database.Database {
    const r = this.directory.prepare('SELECT tenant_id FROM scopes WHERE scope_id = ?').get(scopeId) as
      | { tenant_id: string }
      | undefined;
    if (!r || r.tenant_id !== tenantId) throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    return this.runtime(tenantId, scopeId).db;
  }

  private runtime(tenantId: TenantId, scopeId: ScopeId): ScopeRuntime {
    const key = `${tenantId}/${scopeId}`;
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const db = new Database(join(this.dir, `${tenantId}__${scopeId}.sqlite`));
    db.pragma('journal_mode = WAL');
    db.exec(KERNEL_DDL);
    // KERNEL_DDL is all IF NOT EXISTS, so a scope DB created before K-21 keeps the
    // old shape — ALTER the tombstone in.
    this.ensureColumn(db, '_substrat_tuples', 'revoked_at', 'revoked_at TEXT');
    // Executor retry state (#100), same reasoning: scopes provisioned before it
    // already have the table. Defaults read as "terminal", which is exactly right
    // for the rows already there — every one of them is a completed delivery or a
    // consumer dead-letter.
    this.ensureColumn(db, '_substrat_deliveries', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(db, '_substrat_deliveries', 'next_attempt_at', 'next_attempt_at TEXT');
    // K-34: the authorization column on a scope DB created before it existed. Nullable,
    // so legacy outbox rows read as "unrecorded" — the honest value. (_substrat_denials
    // is a whole new table, so KERNEL_DDL's IF NOT EXISTS covers it with no ALTER.)
    this.ensureColumn(db, '_substrat_outbox', 'authorization', 'authorization TEXT');
    // #841: refusal attribution on a scope DB that predates it. Nullable, so every row
    // already settled reads as "nobody classified this" rather than claiming an origin
    // the drain never actually decided.
    this.ensureColumn(db, '_substrat_platform_requests', 'last_failure', 'last_failure TEXT');
    const appliedMigrations = new Set<string>(
      (
        db.prepare('SELECT module_id, version FROM _substrat_migrations').all() as {
          module_id: string;
          version: string;
        }[]
      ).map((r) => `${r.module_id}@${r.version}`),
    );
    const created: ScopeRuntime = { tenantId, scopeId, db, actor: new ScopeActor(), appliedMigrations };
    this.scopes.set(key, created);
    this.scopesById.set(scopeId, created);
    return created;
  }
}

/** The platform spine (`_substrat_*`) and SQLite internals — the UI groups these apart. */
function isSystemTable(name: string): boolean {
  return name.startsWith('_substrat') || name.startsWith('sqlite_');
}

/** SQLite cell → a JSON-safe value: bigints stringify, blobs read as null (contract). */
function cellToJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return null;
  return v;
}

function scopedSql(db: Database.Database): ScopedSql {
  return {
    query: <T>(sql: string, params: readonly SqlValue[] = []): T[] =>
      db.prepare(sql).all(...params) as T[],
    exec: (sql: string, params: readonly SqlValue[] = []) => {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes };
    },
  };
}
