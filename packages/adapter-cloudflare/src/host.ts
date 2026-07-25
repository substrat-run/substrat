import {
  accessLogEntry,
  adminLogEntry,
  createTenantInput,
  identityLink,
  identityPool,
  createOrgInput,
  promotionAcknowledgement,
  bindHostnameInput,
  hostnameBinding,
  publishVersionInput,
  registerVerticalInput,
  vertical as verticalSchema,
  verticalChannel,
  verticalVersion,
  connection,
  connectionGrant,
  connectionSecret,
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
  type CreateConnectionInput,
  type AccessLogEntry,
  type AdminLogEntry,
  type CapabilityGrant,
  type CreateOrgInput,
  type CreateTenantInput,
  type DomainEvent,
  type EntityRef,
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
  type ReadScopeTableInput,
  type RoleAssignment,
  type RoleDefinition,
  type Scope,
  type ScopeDump,
  type ScopeDumpTable,
  type ScopeId,
  type ScopeStatus,
  type ScopeTable,
  type ScopeTablePage,
  type Tenant,
  type TenantId,
  type TenantRole,
  type TenantStatus,
} from '@substrat-run/contracts';
import { normalizeHostname, toRouteTarget } from './route-resolver.js';
import {
  resolveScopeRecord,
  ulid,
  type AccessLogFilter,
  type AuditLogFilter,
  type ExecutorDeadLetter,
  type ExecutorDrainReport,
  type ExecutorHandler,
  type ExecutorRetryPolicy,
  backoffAt,
  resolveRetryPolicy,
  unconfiguredSecretBox,
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
  type ScopeFilter,
  type ScopeHost,
  type ScopeStub,
} from '@substrat-run/kernel';
import type {
  AccessLogRow,
  AuditLogQuery,
  ChannelRow,
  ConnectionDoRow,
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
  createTenant(id: string, slug: string, name: string, createdAt: string): Promise<Tenant | null>;
  setTenantStatus(tenantId: string, status: TenantStatus): Promise<string>;
  getTenant(tenantId: string): Promise<Tenant | undefined>;
  listTenants(): Promise<Tenant[]>;
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
  listScopes(filter: { tenantId?: string; status?: string[]; vertical?: string }): Promise<ScopeRow[]>;
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
  listRoles(filter: { tenantId?: string; source?: string }): Promise<RoleRow[]>;
  writeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
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
  listHostnames(filter: { tenantId?: string; scopeId?: string }): Promise<HostnameRow[]>;
  readVertical(slug: string): Promise<VerticalRow | undefined>;
  insertVertical(slug: string, name: string, source: string, ownerTenant: string | null, envSpec: string | null, installSpec: string | null, listed: number, createdAt: string): Promise<void>;
  updateVerticalManifestMeta(slug: string, envSpec: string | null, installSpec: string | null): Promise<void>;
  updateVerticalListed(slug: string, listed: number): Promise<void>;
  updateVerticalPublishRequest(slug: string, requestedAt: string): Promise<void>;
  listVerticals(): Promise<VerticalRow[]>;
  readVersion(id: string): Promise<VersionRow | undefined>;
  insertVersion(v: {
    id: string; verticalSlug: string; version: string; manifestDigest: string;
    permissionDigest: string; migrationDigest: string; deploymentRef: string | null;
    createdAt: string;
  }): Promise<void>;
  listVersions(verticalSlug: string): Promise<VersionRow[]>;
  setAdmission(id: string, admission: string, note: string | null): Promise<void>;
  bindScopeVersion(scopeId: string, versionId: string, verticalSlug: string): Promise<void>;
  readChannel(verticalSlug: string, channel: string): Promise<ChannelRow | undefined>;
  setChannel(verticalSlug: string, channel: string, versionId: string, updatedAt: string): Promise<void>;
  listChannels(verticalSlug: string): Promise<ChannelRow[]>;
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
  grantEntitlement(tenantId: string, key: string): Promise<boolean>;
  revokeEntitlement(tenantId: string, key: string): Promise<boolean>;
  tenantHoldsEntitlement(tenantId: string, key: string): Promise<boolean>;
  listEntitlements(tenantId: string): Promise<string[]>;
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
    includeRevoked?: boolean;
  }): Promise<ConnectionDoRow[]>;
  readConnection(id: string): Promise<ConnectionDoRow | undefined>;
  readLiveConnection(
    tenantId: string,
    vertical: string,
    provider: string,
  ): Promise<(ConnectionDoRow & { key_id: string; ciphertext: string }) | undefined>;
  updateConnectionSecret(
    id: string,
    keyId: string,
    ciphertext: string,
    expiresAt: string | null,
    at: string,
  ): Promise<void>;
  revokeConnection(id: string, at: string): Promise<boolean>;
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
    limit?: number;
  }): Promise<AccessLogRow[]>;
  pruneAccessLog(limit: number): Promise<number>;
  recordAdmin(entry: AdminEntry): Promise<void>;
  auditLog(query: AuditLogQuery): Promise<AdminLogEntry[]>;
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

interface ScopeStubRpc {
  /** The applied-migration count if this call applied any, else null (nothing changed). */
  migrate(): Promise<number | null>;
  pendingExecutorEvents(deliveryId: string, eventType: string): Promise<DomainEvent[]>;
  recordExecutorAttempt(
    eventId: string,
    deliveryId: string,
    error: string | null,
    nextAttemptAt: string | null,
  ): Promise<number>;
  executorAttempts(eventId: string, deliveryId: string): Promise<number>;
  executorDeadLetters(): Promise<ExecutorDeadLetter[]>;
  /** The migration that failed on this instance, read on `migrate()`'s reject path. */
  migrationFailure(): Promise<{ version: string; error: string; applied: number } | null>;
  invoke(
    operation: string,
    input: unknown,
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    connectionId?: string,
  ): Promise<unknown>;
  writeTuple(
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): Promise<void>;
  /** Tombstone a scope tuple by exact (subject, relation, object). Idempotent. */
  revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
  /** Scope-local projection (scope-local-permissions.md): replace the tenant's roles + tuples and flip to local. */
  applyProjection(
    tenantId: string,
    roles: { role_key: string; permissions: string; source: string }[],
    tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[],
  ): Promise<void>;
  /** Read-only introspection of this scope's DB (§5.4 admin-query RPC). */
  introspectTables(): Promise<ScopeTable[]>;
  introspectTable(table: string, limit: number, offset: number): Promise<ScopeTablePage>;
  /** Complete logical dump of this scope's DB (preview-and-snapshots.md §3). */
  exportDump(): Promise<ScopeDumpTable[]>;
  /** Load a dump into this (freshly-provisioned) scope — the fork write side. */
  importDump(tables: ScopeDumpTable[]): Promise<void>;
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
  /** Project + evaluate permissions scope-locally (scope-local-permissions.md). */
  private readonly scopeLocalPermissions: boolean;

  // Registration-mechanics bookkeeping (validation only — the DO executes).
  // Code-time, derived from the bundled modules, NOT durable directory state.
  private readonly moduleIds = new Set<string>();
  private readonly operations = new Set<string>();
  private readonly predicateNames = new Map<string, string>(); // name → module
  /** Executor id → {eventType, handler} (K-22 §4.2). Coordinator-side, not in the DO. */
  private readonly secretBox: SecretBox;
  private readonly fetchImpl: FetchLike;
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
    this.fetchImpl = options.fetch ?? ((input, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(input, init));
    this.scopeLocalPermissions = options.scopeLocalPermissions ?? false;
    this.scopeNs = options.scope;
    this.cp = options.controlPlane
      ? (options.controlPlane.get(options.controlPlane.idFromName('control-plane')) as unknown as ControlPlaneStub)
      : nullControlPlane();
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
          if (executor.kind === 'connector') {
            await executor.handler(
              await this.connectorContext(tenantId, scopeId, executor.timeoutMs),
              event,
            );
          } else {
            await executor.handler(this.admin, event);
          }
          await stub.recordExecutorAttempt(event.id, deliveryId, null, null);
          report.delivered += 1;
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

  async executorDeadLetters(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDeadLetter[]> {
    await this.cp.validateScopeAccess(tenantId, scopeId);
    await this.migrateAndRecord(scopeId);
    return this.scopeStub(scopeId).executorDeadLetters();
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
    await this.scopeStub(input.scopeId).importDump(dump.tables);
    await this.admin.activateScope(actor, input.tenantId, input.scopeId);
    await this.recordAdmin(
      actor,
      'importScope',
      { tenantId: input.tenantId, scopeId: input.scopeId },
      null,
      { sourceScopeId: dump.scopeId, tables: dump.tables.length, capturedAt: dump.capturedAt },
    );
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
  ): Promise<ScopeStub> {
    // Lifecycle gates (control-plane.md §4.1/§4.2), the K-3 fail-closed path,
    // evaluated durably in the ControlPlaneDO. A throw propagates here.
    await this.cp.validateScopeAccess(tenantId, scopeId);

    await this.migrateAndRecord(scopeId);
    return this.buildStub(tenantId, scopeId, principal);
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
    await this.migrateAndRecord(scopeId);
    return this.buildStub(conn.tenant_id as TenantId, scopeId, undefined, connectionId);
  }

  /** The stub body, shared by the principal and connection doors. */
  private buildStub(
    tenantId: TenantId,
    scopeId: ScopeId,
    principal?: PrincipalId,
    connectionId?: ConnectionId,
  ): ScopeStub {
    const stub = this.scopeStub(scopeId);
    const cp = this.cp;
    const operationEntitlement = this.operationEntitlement;
    // The DO needs SOME principal-shaped value for `ctx.principal`; for a
    // connection it is the connection id, and the honest attribution rides on
    // the event actor instead.
    const asPrincipalId = (principal ?? (connectionId as unknown as PrincipalId)) as PrincipalId;

    return {
      tenantId,
      scopeId,
      invoke: async <O, I>(operation: string, input?: I): Promise<O> => {
        // Entitlement gate (§4.3): a module loads for a tenant only if the tenant
        // holds its SKU flag. Fails closed the same way withdrawal does.
        const requiredKey = operationEntitlement.get(operation);
        if (requiredKey && !(await cp.tenantHoldsEntitlement(tenantId, requiredKey))) {
          return Promise.reject(
            new Error(
              `operation not entitled: ${operation} — tenant does not hold '${requiredKey}'`,
            ),
          );
        }
        const result = (await stub.invoke(
          operation,
          input,
          asPrincipalId,
          tenantId,
          scopeId,
          connectionId,
        )) as O;
        await this.drainExecutors(tenantId, scopeId);
        return result;
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
        createdAt: r.created_at,
      });

    const transitionScope = async (
      actor: PlatformActorId,
      action: AdminAction,
      tenantId: TenantId,
      scopeId: ScopeId,
      from: ScopeStatus[],
      to: ScopeStatus,
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
        { status: to },
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
      defineRole: async (actor, tenantId, role) => {
        const parsed = roleDefinition.parse(role);
        const before = await this.cp.defineRole(tenantId, parsed);
        await this.recordAdmin(actor, 'defineRole', { tenantId }, before, parsed);
        await this.fanOut(tenantId); // role definitions are projected into the tenant's scopes
      },
      listRoles: async (actor, filter?: RoleFilter): Promise<TenantRole[]> => {
        const rows = await this.cp.listRoles({ tenantId: filter?.tenantId, source: filter?.source });
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
        await writeGrant(
          subjectRef({ kind: 'connection', id: grant.connectionId }),
          grant.permission,
          grant.node,
          undefined,
          grant.expiresAt,
        );
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
        const holderArchived = (existing as { scope_status?: string } | undefined)?.scope_status === 'archived';
        if (existing && existing.scope_id !== parsed.scopeId && !holderArchived) {
          // A hostname routes to exactly one place; silently rebinding would move
          // another tenant's traffic. Exception: the holder is ARCHIVED (a deleted app) —
          // it has released the name, so the rebind reclaims it.
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
      listHostnames: async (actor, filter) => {
        const rows = await this.cp.listHostnames({
          tenantId: filter?.tenantId,
          scopeId: filter?.scopeId,
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
            await this.cp.updateVerticalManifestMeta(parsed.slug, envSpecJson, installSpecJson);
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
      listVerticals: async (actor) => {
        const rows = await this.cp.listVerticals();
        await this.recordAccess(actor, 'listVerticals', {}, null, rows.length);
        return rows.map(mapVertical);
      },
      publishVersion: async (actor, input: PublishVersionInput) => {
        const parsed = publishVersionInput.parse(input);
        if (!(await this.cp.readVertical(parsed.verticalSlug))) {
          throw new Error(`unknown vertical '${parsed.verticalSlug}'`);
        }
        // Lands PENDING — a push is not a deploy.
        await this.cp.insertVersion({ ...parsed, createdAt: new Date().toISOString() });
        await this.recordAdmin(actor, 'publishVersion', { tenantId: null }, null, parsed);
      },
      listVersions: async (actor, verticalSlug: string) => {
        const rows = await this.cp.listVersions(verticalSlug);
        await this.recordAccess(actor, 'listVersions', {}, { verticalSlug }, rows.length);
        return rows.map(mapVersion);
      },
      setVerticalListed: async (actor, slug: string, listed: boolean) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        await this.cp.updateVerticalListed(slug, listed ? 1 : 0); // also resolves any pending request
        await this.recordAdmin(actor, 'setVerticalListed', { tenantId: null }, { listed: !!existing.listed }, { listed });
      },
      requestPublish: async (actor, slug: string) => {
        const existing = await this.cp.readVertical(slug);
        if (!existing) throw new Error(`unknown vertical '${slug}'`);
        await this.cp.updateVerticalPublishRequest(slug, new Date().toISOString());
        await this.recordAdmin(actor, 'requestPublish', { tenantId: null }, null, { slug });
      },
      admitVersion: async (actor, versionId: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw new Error(`unknown version ${versionId}`);
        if (v.admission === 'admitted') return;
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

        await this.cp.setChannel(verticalSlug, channel, versionId, new Date().toISOString());
        await this.recordAdmin(
          actor,
          'promoteVersion',
          { tenantId: null, vertical: verticalSlug },
          outgoing ? { versionId: outgoing.id, version: outgoing.version } : null,
          { channel, versionId, version: incoming.version, acknowledged: ack },
        );
      },
      listChannels: async (actor, verticalSlug: string) => {
        const rows = await this.cp.listChannels(verticalSlug);
        await this.recordAccess(actor, 'listChannels', {}, { verticalSlug }, rows.length);
        return rows.map((r) =>
          verticalChannel.parse({
            verticalSlug: r.vertical_slug,
            channel: r.channel,
            versionId: r.version_id,
            updatedAt: r.updated_at,
          }),
        );
      },
      bindScopeVersion: async (actor, tenantId, scopeId, versionId: string) => {
        const v = await this.cp.readVersion(versionId);
        if (!v) throw new Error(`unknown version ${versionId}`);
        // The refusal the registry exists for.
        if (v.admission !== 'admitted') {
          throw new Error(
            `version ${versionId} is ${v.admission}, not admitted — it cannot be bound to a scope`,
          );
        }
        const scope = await this.cp.getScopeRecord(tenantId, scopeId);
        if (!scope) throw new Error(`unknown scope ${scopeId} in tenant ${tenantId}`);
        await this.cp.bindScopeVersion(scopeId, versionId, v.vertical_slug);
        await this.recordAdmin(actor, 'bindScopeVersion', { tenantId, scopeId }, null, {
          versionId, vertical: v.vertical_slug, version: v.version,
        });
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
        );
        // Idempotent: re-creating an existing tenant is a no-op, not audited.
        if (!created) return;
        await this.recordAdmin(actor, 'createTenant', { tenantId: parsed.id }, null, created);
      },
      setTenantStatus: async (actor, tenantId, status: TenantStatus) => {
        const before = await this.cp.setTenantStatus(tenantId, status);
        await this.recordAdmin(actor, 'setTenantStatus', { tenantId }, { status: before }, { status });
      },
      listTenants: async (actor): Promise<Tenant[]> => {
        const tenants = (await this.cp.listTenants()).map((t) => tenantSchema.parse(t));
        // Enumerating every tenant on the platform is the read this log exists for.
        await this.recordAccess(actor, 'listTenants', {}, null, tenants.length);
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
        });
        await this.recordAccess(actor, 'listScopes', { tenantId: filter?.tenantId ?? null }, filter, rows.length);
        return rows.map(mapScope);
      },
      getScopeRecord: async (actor, tenantId, scopeId): Promise<Scope | undefined> => {
        const row = await this.cp.getScopeRecord(tenantId, scopeId);
        await this.recordAccess(actor, 'getScopeRecord', { tenantId, scopeId }, null, row ? 1 : 0);
        return row ? mapScope(row) : undefined;
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
      grantEntitlement: async (actor, tenantId, entitlementKey) => {
        const changed = await this.cp.grantEntitlement(tenantId, entitlementKey);
        if (!changed) return; // idempotent
        await this.recordAdmin(actor, 'grantEntitlement', { tenantId }, null, { entitlementKey });
      },
      revokeEntitlement: async (actor, tenantId, entitlementKey) => {
        const changed = await this.cp.revokeEntitlement(tenantId, entitlementKey);
        if (!changed) return; // nothing held, nothing changed
        await this.recordAdmin(actor, 'revokeEntitlement', { tenantId }, { entitlementKey }, null);
      },
      listEntitlements: async (actor, tenantId): Promise<string[]> => {
        const keys = await this.cp.listEntitlements(tenantId);
        await this.recordAccess(actor, 'listEntitlements', { tenantId }, null, keys.length);
        return keys;
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

      updateConnectionSecret: async (
        actor,
        id: ConnectionId,
        secret: ConnectionSecret,
        expiresAt?: string,
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
          { id, provider: row.provider, rotatedAt: now, expiresAt: expiresAt ?? row.expires_at },
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

      openConnection: async (tenantId, vertical: string, provider: string) => {
        const row = await this.cp.readLiveConnection(tenantId, vertical, provider);
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
      },
      unlinkIdentity: async (actor, tenantId: TenantId, principal: PrincipalId) => {
        // DELETE by principal (audit is the log), so the caller who removed a member
        // can sever their login without knowing the external subject. Idempotent.
        const changed = await this.cp.unlinkIdentity(tenantId, principal);
        if (!changed) return;
        await this.recordAdmin(actor, 'unlinkIdentity', { tenantId, scopeId: null }, { principal }, null);
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
          limit: filter?.limit,
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
      pruneAccessLog: async (actor, limit: number): Promise<number> => {
        const pruned = await this.cp.pruneAccessLog(limit);
        if (pruned > 0) {
          await this.recordAdmin(actor, 'pruneAccessLog', { tenantId: null }, { pruned }, null);
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
    };
  }

  // -- helpers --------------------------------------------------------------

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

  /** The tenant's current roles + tenant-level tuples, in the shape the ScopeDO stores. */
  private async tenantProjection(
    tenantId: TenantId,
  ): Promise<{
    roles: { role_key: string; permissions: string; source: string }[];
    tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[];
  }> {
    const [roleRows, tuples] = await Promise.all([
      this.cp.listRoles({ tenantId }),
      this.cp.dumpTenantTuples(tenantId),
    ]);
    return {
      roles: roleRows.map((r) => ({ role_key: r.role_key, permissions: r.permissions, source: r.source })),
      tuples,
    };
  }

  /** Project the tenant's current state into ONE scope + flip it to local. */
  private async projectScope(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    if (!this.scopeLocalPermissions) return;
    const { roles, tuples } = await this.tenantProjection(tenantId);
    await this.scopeStub(scopeId).applyProjection(tenantId, roles, tuples);
  }

  /**
   * Fan the tenant's current state out into ALL its scopes — called after any
   * tenant-level write so every projected scope converges. A dropped fan-out is
   * repaired by `reconcileTenantProjection` (the reconciliation sweep, §5/§9).
   */
  private async fanOut(tenantId: TenantId): Promise<void> {
    if (!this.scopeLocalPermissions) return;
    const { roles, tuples } = await this.tenantProjection(tenantId);
    const scopes = await this.cp.listScopes({ tenantId });
    await Promise.all(
      scopes.map((s) => this.scopeStub(s.scope_id as ScopeId).applyProjection(tenantId, roles, tuples)),
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
   * state: migrate its modules, project the vertical's role definitions locally, grant
   * the owner a role at scope level, and make the scope evaluate permissions from its
   * own storage. No tenant-level tuples, no control plane.
   */
  async provisionScopeLocal(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    owner: PrincipalId;
    /** The vertical's role definitions (projected so the local checker can expand them). */
    roles: RoleDefinition[];
    /** Which role the owner is assigned, at SCOPE level. */
    ownerRoleKey: string;
  }): Promise<void> {
    const stub = this.scopeStub(input.scopeId);
    await this.migrateAndRecord(input.scopeId); // create the module tables (setMigrationState no-ops on a null CP)
    await stub.applyProjection(
      input.tenantId,
      input.roles.map((r) => ({ role_key: r.key, permissions: JSON.stringify(r.permissions), source: r.source })),
      [], // no tenant-level tuples — a CP-less vertical grants at scope level only
    );
    await stub.writeTuple(
      `principal:${input.owner}`,
      `role:${input.ownerRoleKey}`,
      `scope:${input.scopeId}`,
      null,
    );
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
}
