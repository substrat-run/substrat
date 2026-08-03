import type {
  AdminAction,
  ListPage,
  Connection,
  ConnectionFilter,
  ConnectionId,
  ConnectionGrant,
  ConnectionSecret,
  CreateConnectionInput,
  OpenConnection,
  AccessLogEntry,
  BindHostnameInput,
  AdminLogEntry,
  CapabilityGrant,
  CreateTenantInput,
  Decision,
  DomainEvent,
  DomainEventInput,
  PlatformRequestInput,
  PlatformRequestId,
  PlatformRequest,
  PlatformRequestStatus,
  EntitlementGrant,
  EntitlementGrantInput,
  EntitlementView,
  EntityRef,
  IdentityLink,
  IdentityPool,
  Jurisdiction,
  ModuleId,
  ModuleManifest,
  ScheduleSpec,
  SystemGrant,
  CreateOrgInput,
  Node,
  Org,
  OrgId,
  OrgMembership,
  PermissionKey,
  PlatformActorId,
  ChannelName,
  ChannelHistoryEntry,
  DnsRecord,
  HostnameBinding,
  HostnameStatus,
  PromotionAcknowledgement,
  PublishVersionInput,
  RegisterVerticalInput,
  VerticalServingState,
  RouteTarget,
  PrincipalId,
  ResolvedIdentity,
  RoleAssignment,
  RoleDefinition,
  QueryScopeInput,
  ReadScopeTableInput,
  Scope,
  ScopeDump,
  ScopeQueryResult,
  ScopeId,
  ScopeStatus,
  ScopeTable,
  ScopeTablePage,
  StorageShape,
  Tenant,
  TenantId,
  TenantRole,
  TenantStoreHandle,
  AttachmentRecord,
  BlobStoreHandle,
  Visibility,
  Vertical,
  VerticalChannel,
  VerticalVersion,
  TenantStatus,
} from '@substrat-run/contracts';

/**
 * The scope-host contract — the adapter seam (§5.1 of the design doc).
 *
 * Module code registers OPERATIONS; callers invoke them through a capability
 * stub. The operation handler runs INSIDE the scope's execution domain
 * (Durable Object on the Cloudflare adapter, per-scope actor locally), which is
 * what makes "one hop, then local queries" true in production and what makes
 * invariants enforceable: the handler sees sql/emit/check, the caller sees
 * only invoke().
 *
 * Contract semantics, pinned (K-6):
 * - Strict serialization per scope: one operation at a time, to completion.
 * - Structured-clone boundary: inputs and results are cloned even in-process;
 *   code can never share mutable state with a scope.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface ScopedSql {
  query<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
  exec(sql: string, params?: readonly SqlValue[]): { changes: number };
}

/** What an operation handler sees — ambient tenancy, no IDs passed around (§7.8 of the plan). */
export interface OperationContext {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  readonly principal: PrincipalId;
  readonly sql: ScopedSql;
  /** Envelope is stamped kernel-side (id, occurredAt, tenant, scope, actor); input is validated. */
  emit(event: DomainEventInput): void;
  /**
   * Enqueue a PLATFORM INTENT (docs/design/platform-intents.md) — how a sandbox-clean vertical asks
   * the platform to perform a privileged action (e.g. provision a sibling scope) without an upward
   * call. Writes a durable row into this scope's `_substrat_platform_requests` spine, atomic with
   * the operation; the platform pulls and executes it later, knowing the tenant inherently (it reads
   * this scope's DO). Call it AFTER the vertical's own permission check — authorization is the
   * vertical's, isolation is the platform's. Origin fields (id, requestedAt, requestedBy) are
   * stamped kernel-side; returns the new request id so the caller can report/track it. Throws if the
   * scope already holds `MAX_PENDING_PLATFORM_REQUESTS` pending intents (backpressure).
   */
  requestPlatform(request: PlatformRequestInput): PlatformRequestId;
  /** Node-level check; pass `entity` for per-entity checks (portal access, §4.2 rule 3). */
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
  /**
   * Read one of the tenant's currently-held entitlements at request time (#304) — the
   * sanctioned way a hosted vertical gates a feature or enforces its own quota WITHOUT a
   * control-plane binding. Returns the live view (`key`, `plan`, `quota`, `expiresAt`) or
   * `null` when the tenant does not hold the key or the grant has expired — expiry is applied
   * at read, so a non-null result is always live. `plan`/`quota` are expression only: the
   * kernel enforces presence + expiry (that is the per-operation entitlement gate), the
   * vertical decides what `quota` means. On a hosted vertical this reads the scope-local
   * projection (scope-local-permissions.md); on a console-managed one it reads the directory.
   */
  entitlement(key: string): Promise<EntitlementView | null>;
  /** Every entitlement the tenant currently holds (expired grants excluded), as read views. */
  entitlements(): Promise<EntitlementView[]>;
  /**
   * Record a relation tuple child→parent (K-16) — the write path for the
   * permission evaluator's entity-edge rule (design doc §4.2 rule 3). The
   * relation must be declared in some registered module's `entityRelations`.
   * Idempotent.
   */
  link(child: EntityRef, parent: EntityRef): void;
}

export type OperationHandler<I = unknown, O = unknown> = (
  ctx: OperationContext,
  input: I,
) => O | Promise<O>;

/** The capability stub — the ONLY way code outside the scope reaches it. */
export interface ScopeStub {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  invoke<O = unknown, I = unknown>(operation: string, input?: I): Promise<O>;
}

/**
 * Observers a caller may attach when minting a stub (#458). Harness-level, not
 * module-level: module code never sees these — they exist so the HTTP layer
 * around an operation can react to what the operation did without the module
 * carrying a new surface.
 */
export interface ScopeStubOptions {
  /**
   * Fired after an invoke through this stub COMMITS having enqueued platform
   * requests via `ctx.requestPlatform`, with how many. A vertical's request
   * handler uses this to flag its response `x-substrat-platform-request`
   * (`PLATFORM_REQUEST_HEADER`) so the router kicks an immediate drain of this
   * scope (#381) — p50 provisioning latency drops from sweep-cadence to seconds.
   * Never fired for a rolled-back operation: an intent that did not survive its
   * transaction is not a signal. Purely advisory — a missed callback costs one
   * sweep interval, nothing more.
   */
  onPlatformRequests?: (count: number) => void;
}

export interface SqlMigration {
  /** Ordered, unique per module, e.g. '0001-init'. Journaled per (module, version). */
  version: string;
  sql: string;
}

/**
 * The deployed migration frontier — what "up to date" means for THIS host build
 * (kernel-design §5.3, #49). `total` counts the registered (module, version)
 * pairs, which is exactly the number `scope.schemaVersion` counts toward, so
 * "which scopes are behind" is a directory comparison and never a fan-out
 * (§5.4). In a multi-deployment fleet each deployment has its own frontier —
 * this describes the modules registered on this host, nothing more.
 */
export interface MigrationFrontier {
  total: number;
}

/**
 * What one deliberate migration attempt did (`migrateScope`, the sweep's retry
 * affordance — #49).
 *
 * A structured result, NOT a throw, and deliberately so: the wake paths
 * (`getScope`, `invoke`) must keep rejecting so a half-migrated scope fails
 * closed on every operation (#50's near-regression), but the sweep is not a
 * request — a failure is a state it reports and backs off from, not an
 * exception. `noop` means this host had nothing pending for the scope: either
 * it is at the frontier already, or the scope's modules live in a different
 * deployment (the control plane sweeping a fleet it does not run) — in both
 * cases no state was touched, so a foreign host can never clear a failure it
 * knows nothing about.
 */
export type MigrateScopeOutcome =
  | { status: 'migrated'; schemaVersion: string }
  | { status: 'noop' }
  | { status: 'failed'; failure: { version: string; error: string } };

/**
 * How a module (engine or vertical) joins a host: manifest + migrations +
 * operations in one registration. Migrations apply lazily per scope, inside
 * the scope's serialization domain, journaled in `_substrat_migrations`
 * (design doc §5.3 in miniature). Operations are the module's default
 * bindings (K-16); in-scope functions need no registration — they are plain
 * exports called by other modules' handlers.
 */
/**
 * Event consumers run as ordinary in-scope operations under a system actor,
 * delivered at-least-once (kernel delivery journal); handlers must be
 * idempotent. Ordering is guaranteed only within (scope, module) — K-11.
 */
export type ConsumerHandler = (ctx: OperationContext, event: DomainEvent) => void | Promise<void>;

/**
 * An **executor**: out-of-band host code that effects, outside a scope, what a module
 * asked for inside one (K-22 §4.2; D-18's triage rule — effects on the outside world
 * are connectors).
 *
 * Why this rather than an in-scope capability: some effects are not scope-local.
 * Membership tuples are tenant-wide and live in the directory, so an in-scope write
 * would be a cross-DO write inside a scope transaction — two serialization domains,
 * no coordinator, and an orphaned membership if the scope transaction rolls back
 * after the directory write lands.
 *
 * The connector has no such hazard: the module's `ctx.emit` commits WITH its domain
 * write, so a rollback leaves no event and nothing to effect. The executor then runs
 * at-least-once from the outbox — so handlers must be idempotent, exactly as
 * consumers must.
 *
 * It receives `HostAdmin`, not `ctx`: it acts with platform authority, which is
 * precisely what module code must never hold. Admin writes it makes are stamped with
 * the causing event's id (`causedBy`), so the split trail joins.
 */
export type ExecutorHandler = (admin: HostAdmin, event: DomainEvent) => void | Promise<void>;

/**
 * How hard the host tries before it gives up on one delivery (#100).
 *
 * Defaults suit a directory write. A connector making an outbound HTTP call
 * wants a longer tail — that is the whole reason this is per-executor rather
 * than a host-wide constant.
 */
export interface ExecutorRetryPolicy {
  /** Total attempts including the first. Reaching it dead-letters. Default 5. */
  maxAttempts?: number;
  /** First backoff step; doubles per attempt. Default 1000ms. `0` retries at once. */
  baseDelayMs?: number;
  /** Ceiling on the doubling. Default 300_000ms (5 min). */
  maxDelayMs?: number;
}

/**
 * What one drain pass did. `retrying` and `deadLettered` are the numbers a
 * health surface reports; a caller that ignores them learns nothing, which is
 * the failure mode the old silent path had.
 */
export interface ExecutorDrainReport {
  attempted: number;
  delivered: number;
  /** Failed, still under `maxAttempts` — scheduled for a later pass. */
  retrying: number;
  /** Failed at `maxAttempts` — terminal, and the row keeps the last error. */
  deadLettered: number;
}

/**
 * A module's recurring-work declarations, as `registeredSchedules` reports them
 * (#383): the module id the sweep runs `runDueSchedules` against, plus the declared
 * schedules. No vertical: a vertical's runtime serves only its own scopes, and the
 * module-less control-plane host registers nothing, so the sweep enumerates active
 * scopes once and runs each registration on each — no cross-vertical reach exists to
 * filter out.
 */
export interface ScheduleRegistration {
  moduleId: ModuleId;
  schedules: ScheduleSpec[];
}

/**
 * What `runDueSchedules` did for one scope in one pass (#383). A schedule inside its
 * cadence window is `skipped`; a due one is `fired` (its operation ran) or `failed`
 * (the operation threw — recorded, never allowed to stop the others).
 */
export interface ScheduleRunReport {
  fired: number;
  skipped: number;
  failed: number;
  /** Per-schedule failures on this scope: the operation name and the error. */
  errors: { operation: string; error: string }[];
}

/**
 * The web-standard fetch surface, structurally typed.
 *
 * Declared rather than imported: the kernel depends on no platform typings, and
 * `RequestInit`/`Response` come from DOM lib in Node and from workers-types in
 * Workers. Structural typing means both satisfy this without either being
 * required — the same reason `crypto` and `TextEncoder` are declared locally.
 */
export interface FetchLike {
  (input: string, init?: ConnectorRequestInit): Promise<ConnectorResponse>;
}
export interface ConnectorRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * `Uint8Array` as well as `string` because a real provider upload is binary:
   * Scrive's `setfile` is `multipart/form-data`, whose body is a byte sequence a
   * string cannot carry without corrupting the file. Web `fetch` accepts both, so
   * this only widens the declared surface — the adapter passes it straight
   * through.
   */
  body?: string | Uint8Array;
  signal?: unknown;
}
export interface ConnectorResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /**
   * The raw bytes — for provider responses that are a file, not JSON. Scrive's
   * sealed signed PDF (`documents/{id}/files/main`) comes back as `application/pdf`,
   * which `text()` would corrupt. Web `Response` already has this, so declaring it
   * only widens the structural surface the adapter passes straight through.
   */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * A connection with its credential opened, plus egress bound to it.
 *
 * `fetch` is bound to the connection rather than sitting on the context because
 * health has to land on the right row by construction. An ambient
 * `ctx.fetch` would need the runtime to guess which connection a call belonged
 * to, and it would guess wrong the first time a connector talked to two.
 */
export interface ConnectorConnection extends OpenConnection {
  /**
   * Sanctioned egress: a timeout, and success/failure recorded against THIS
   * connection.
   *
   * The connector is handed its `fetch` rather than importing one — the same
   * move `ctx.sql` makes for module code, and for the same reason. Egress
   * policy, timeouts and health become properties of the seam instead of
   * conventions a connector author has to remember. Module code still cannot
   * reach any of this: boundary-lint R3 bans `fetch` outright, and a connector
   * is host code.
   */
  fetch(input: string, init?: ConnectorRequestInit): Promise<ConnectorResponse>;
}

/**
 * What a connector sees. Strictly more than an executor: an executor effects
 * something in the DIRECTORY, a connector effects something in the OUTSIDE
 * WORLD, and only the second needs a per-tenant credential and egress.
 */
export interface ConnectorContext {
  readonly admin: HostAdmin;
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  /** The scope's vertical — half the key a connection is stored under. */
  readonly vertical: string;
  /**
   * The live connection for this provider, opened.
   *
   * Resolved as (this event's tenant, this scope's vertical, provider), so a
   * connector cannot reach a credential another vertical connected even by
   * accident — the tenant and vertical are ambient, not arguments. Throws when
   * there is none: a connector that runs without a credential would otherwise
   * fail later, further from the cause.
   */
  connection(provider: string): Promise<ConnectorConnection>;
}

export type ConnectorHandler = (ctx: ConnectorContext, event: DomainEvent) => void | Promise<void>;

/** Tuning for one connector's egress. */
export interface ConnectorOptions extends ExecutorRetryPolicy {
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
}

/** A delivery that exhausted its attempts. The evidence, not a silent drop. */
export interface ExecutorDeadLetter {
  eventId: string;
  executorId: string;
  eventType: string;
  attempts: number;
  error: string;
  lastAttemptAt: string;
}

/**
 * Retry defaults (#100). Tuned for the directory write the first executor does;
 * a connector making an outbound call should raise `maxAttempts` explicitly,
 * which is why the policy is per-executor rather than a host constant.
 */
export function resolveRetryPolicy(retry?: ExecutorRetryPolicy): Required<ExecutorRetryPolicy> {
  return {
    maxAttempts: retry?.maxAttempts ?? 5,
    baseDelayMs: retry?.baseDelayMs ?? 1_000,
    maxDelayMs: retry?.maxDelayMs ?? 300_000,
  };
}

/**
 * When attempt `attempts` should next be tried: exponential, capped, jittered.
 *
 * Jitter is ±20% and is skipped entirely at zero delay, so a test setting
 * `baseDelayMs: 0` gets deterministic immediate retries rather than a race. It
 * matters at real delays because every scope in a fleet retries a downed
 * provider on the same schedule otherwise.
 */
export function backoffAt(
  attempts: number,
  retry: Required<ExecutorRetryPolicy>,
  from: Date,
): string {
  const raw = Math.min(retry.baseDelayMs * 2 ** (attempts - 1), retry.maxDelayMs);
  const jittered = raw === 0 ? 0 : raw * (0.8 + Math.random() * 0.4);
  return new Date(from.getTime() + jittered).toISOString();
}

/**
 * A named, manifest-wired pre-condition on an operation (K-17; engine-protocol
 * §6, open question 11). One module CONTRIBUTES a predicate under a name; a
 * (usually different) module's manifest WIRES it to an operation via
 * `guards: [{ before, predicate, config }]`. The kernel runs it inside the
 * guarded operation's own transaction, immediately before the handler:
 *
 *   throw  → the operation is BLOCKED and the transaction rolls back (fail closed)
 *   return → the handler runs
 *
 * `config` is the manifest's config object, opaque to the kernel and parsed by
 * the predicate itself; `input` is the (already structured-cloned) operation
 * input. A predicate is a READ: it must not mutate — it is a gate, not a hook.
 * Star topology holds — the guarded engine knows nothing of the guarding one.
 */
export type GuardPredicate = (
  ctx: OperationContext,
  config: Record<string, unknown>,
  input: unknown,
) => void | Promise<void>;

export interface ModuleRegistration {
  manifest: ModuleManifest;
  migrations?: SqlMigration[];
  operations?: Record<string, OperationHandler<never, unknown>>;
  /** eventType → handler; the types must appear in manifest.events.consumes. */
  consumers?: Record<string, ConsumerHandler>;
  /**
   * Named guard predicates this module contributes to the host — the code half
   * of `manifest.guards`. Names are module-namespaced like operations
   * ('protocol/all-signed'). Predicate names are global: two modules may not
   * contribute the same name.
   */
  predicates?: Record<string, GuardPredicate>;
}

/**
 * Admin surface for enforcement input (design doc §4; control-plane.md §4.4).
 *
 * Every mutation is a control-plane action: it takes a `PlatformActorId` — the
 * authenticated staff subject, typed distinctly from a tenant `PrincipalId` so
 * the compiler refuses to confuse them — and writes an append-only audit row
 * stamped platform-side (actor, action, target, before/after, timestamp). The
 * actor is never a principal in any tenant, and the record is never supplied by
 * the caller. This is the one surface that must not be retrofitted (K-20): a
 * surface that can act without a durable record of who acted is worse than none.
 *
 * Locally the actor is a dev stub (control-plane.md §6); real staff auth (SSO,
 * MFA) gates EXPOSING this surface, not building it — D-16 cashed in.
 *
 * The whole surface is ASYNCHRONOUS (every method returns a Promise) because a
 * durable/remote control plane — e.g. a Cloudflare Durable Object — cannot be
 * backed synchronously: reads may cross an RPC boundary and writes must await a
 * durable record before returning. The second adapter surfaced this (D-14); a
 * synchronous admin interface could not be honoured by anything but an in-memory
 * store, so the contract is async everywhere. (`registerModule`/`defineOperation`
 * stay sync — they are code-time bookkeeping, not control-plane state.)
 */
export interface HostAdmin {
  defineRole(actor: PlatformActorId, tenantId: TenantId, role: RoleDefinition): Promise<void>;
  /**
   * Every role the directory holds, ordered by (tenantId, key).
   *
   * Roles were writable and not enumerable: `defineRole` has existed since the
   * permission model shipped, and nothing could ask what roles exist. That makes
   * the console's half of the permission checkpoint unbuildable — CI diffs the
   * roles declared in CODE, and this is the only way to see what a live
   * deployment actually holds, which is not the same question.
   *
   * Directory-local, unlike grants: `_substrat_roles` sits beside the tenant
   * registry, so this is a read. A grant is a tuple in the scope's own database
   * and needs §5.4's admin-query RPC — the two are not the same size of problem.
   */
  listRoles(actor: PlatformActorId, filter?: RoleFilter): Promise<TenantRole[]>;
  // ^ pages over (tenant_id, role_key); the cursor is `${tenantId}|${roleKey}`.
  assignRole(actor: PlatformActorId, assignment: RoleAssignment): Promise<void>;
  /**
   * Revoke a role assignment — the inverse of `assignRole`, same `RoleAssignment`
   * shape. Tombstones the role tuple (K-21, never DELETE), so the checker stops
   * resolving it and the assignment stays visible to audit; a later `assignRole`
   * of the same (principal, role, node) reactivates it. Idempotent: unassigning a
   * role that was never assigned (or already revoked) is a silent no-op. Takes a
   * `PlatformActorId` like every admin mutation — the caller's own authority to do
   * this is decided above the kernel (e.g. the dashboard's manage-members check).
   */
  unassignRole(actor: PlatformActorId, assignment: RoleAssignment): Promise<void>;
  grant(actor: PlatformActorId, grant: CapabilityGrant): Promise<void>;
  /** Grant to an organization (portal customers); members reach it via membership tuples. */
  /**
   * Grant a permission to a CONNECTION (#97) — how a connector is allowed to
   * write back into a scope.
   *
   * Deliberately the same shape as every other grant: tuples, tombstoned on
   * revoke (K-21), visible to `listRoles`-style reads and to the permission
   * diff. A separate "allowed operations" list on the connection was the
   * alternative and was rejected — two mechanisms for one gate is worse than
   * either, and only one of them would have shown up in a review.
   */
  grantToConnection(actor: PlatformActorId, grant: ConnectionGrant): Promise<void>;
  /**
   * Grant a permission to a MODULE's system principal (#383) — how a scheduled
   * operation is allowed to act on a scope without impersonating a person.
   *
   * The scheduler analogue of `grantToConnection`, and the same shape for the same
   * reason: one grant mechanism, tuples tombstoned on revoke (K-21), visible to the
   * permission diff. It is what makes `ctx.check` resolve for a schedule — the gate
   * stays `ctx.check`, not a bypass. Projected at scope provisioning from the
   * module's declared `schedules[].permissions`; a per-tenant "scheduling off" is a
   * revoke of this grant, nothing more.
   */
  grantToSystem(actor: PlatformActorId, grant: SystemGrant): Promise<void>;

  grantToOrg(
    actor: PlatformActorId,
    orgId: OrgId,
    permission: PermissionKey,
    node: Node,
    entity?: EntityRef,
  ): Promise<void>;
  addMember(
    actor: PlatformActorId,
    tenantId: TenantId,
    principal: PrincipalId,
    orgId: OrgId,
  ): Promise<void>;
  /**
   * Revoke a membership (K-21). **Tombstones, never deletes**: the tuple keeps its
   * row, gains a `revokedAt`, and the permission walk skips it. Deletion would
   * destroy the audit property K-4 rests on — a tuple that once granted access is
   * evidence of why an access was allowed — and D-32's operated compliance product
   * has to produce exactly that evidence.
   *
   * Idempotent: revoking an already-revoked or never-existing membership is a
   * no-op, and a no-op is not audited. Re-adding via `addMember` clears the
   * tombstone (they are a member again); the add/revoke history lives in the admin
   * log, which is append-only.
   */
  removeMember(
    actor: PlatformActorId,
    tenantId: TenantId,
    principal: PrincipalId,
    orgId: OrgId,
  ): Promise<void>;
  /**
   * The members of an org. Live members only unless `includeRevoked` — the
   * revoked rows are the evidence view, not the roster.
   *
   * Answering "who has access to this org" at all is new: membership was
   * write-only before this (#34).
   */
  listMembers(
    actor: PlatformActorId,
    tenantId: TenantId,
    orgId: OrgId,
    options?: { includeRevoked?: boolean },
  ): Promise<OrgMembership[]>;

  // -- organizations (K-22) --------------------------------------------------

  /**
   * Register an org. Idempotent on the id — re-creating is a no-op, not an error
   * (as `createTenant`). Slugs are unique within the tenant; a collision from a
   * DIFFERENT id fails closed rather than silently doing nothing.
   *
   * Membership and `grantToOrg` both refuse an org that does not exist here. That
   * refusal is the point of the record: before it, `addMember(…, 'acme')` and
   * `addMember(…, 'Acme')` silently addressed two different orgs and a typo in a
   * grant reached a phantom nothing would ever resolve to.
   */
  createOrg(actor: PlatformActorId, input: CreateOrgInput): Promise<void>;
  listOrgs(actor: PlatformActorId, tenantId: TenantId): Promise<Org[]>;
  getOrg(actor: PlatformActorId, tenantId: TenantId, orgId: OrgId): Promise<Org | undefined>;

  // -- vertical + version registry (#31) --------------------------------------

  /**
   * Register a vertical. Idempotent on the slug; a conflicting re-registration
   * (different source) throws rather than silently rebinding what a scope runs.
   */
  registerVertical(actor: PlatformActorId, input: RegisterVerticalInput): Promise<void>;
  /** Ordered by slug; `page.cursor` is a slug. Unset limit = everything (pagination.ts). */
  listVerticals(actor: PlatformActorId, page?: ListPage): Promise<Vertical[]>;

  /**
   * Publish a version. It lands **pending** — a push is not a deploy — with ONE
   * exception: a **private** vertical's version (owned by a tenant, not `listed`)
   * lands **admitted**, noted `AUTO_ADMISSION_NOTE`. Its blast radius is the owning
   * tenant alone, and the sandbox contract — not a staff read of an opaque digest —
   * is what protects the platform, so staff admission there gated nothing dev/staging
   * didn't already concede. Staff review holds where the audience widens: a listed
   * vertical's pushes land pending, and `setVerticalListed` refuses an auto-admitted
   * prod version.
   *
   * The digests are what promotion compares. `boundary-lint` and the migration and
   * permission diffs are the admission gates, and binding a scope is a separate step
   * (`bindScopeVersion`), so the two human checkpoints fire where the blast radius is
   * rather than where the typing was.
   */
  publishVersion(actor: PlatformActorId, input: PublishVersionInput): Promise<void>;
  /** Ordered by id (ULID = publish order), `asc` unless `page.order` says otherwise. */
  listVersions(
    actor: PlatformActorId,
    verticalSlug: string,
    page?: ListPage,
  ): Promise<VerticalVersion[]>;

  /**
   * Admit a pending version — the gates passed. Idempotent on an already-admitted one,
   * EXCEPT an auto-admitted one (`AUTO_ADMISSION_NOTE`), which it upgrades to a manual
   * vouch by clearing the note — the recorded human decision `setVerticalListed` requires.
   */
  admitVersion(actor: PlatformActorId, versionId: string): Promise<void>;
  /** Reject a pending version, with the reason. Rejected is terminal: publish a new one. */
  rejectVersion(actor: PlatformActorId, versionId: string, note: string): Promise<void>;
  /**
   * Publish/unpublish a vertical to the PUBLIC marketplace (marketplace-publish.md §5) — the
   * staff admission of a publish request. Flips the registry `listed` flag; `availableCatalog`
   * then offers it to every tenant (a private vertical shows only to its owner). Staff-only,
   * idempotent, audited. Distinct from `admitVersion` (servable) and prod promotion.
   *
   * **Refuses `listed: true` while the prod channel points at an auto-admitted version**
   * (`AUTO_ADMISSION_NOTE`): listing is the moment other tenants start trusting this code,
   * so the version they would install must carry a real staff vouch — `admitVersion` it
   * first (which clears the note), then list.
   */
  setVerticalListed(actor: PlatformActorId, slug: string, listed: boolean): Promise<void>;
  /**
   * A builder REQUESTS that their vertical be published (marketplace-publish.md §5) — records
   * a pending request for staff to review, without listing it. Ownership is checked at the
   * control-plane edge (the owning tenant); this records the request + timestamp. Idempotent
   * (re-requesting refreshes the timestamp). `setVerticalListed` resolves it either way.
   */
  requestPublish(actor: PlatformActorId, slug: string): Promise<void>;

  /**
   * Block (or unblock) NEW installs of a vertical — the staff kill-switch for one
   * that should take no more instances. Orthogonal to `setVerticalListed`
   * (visibility): a blocked vertical is hidden from the install catalog and
   * provisioning an instance of it is refused, for everyone including its owner.
   * Existing scopes keep running untouched — this gates provisioning, not serving.
   * Staff-only, idempotent, audited.
   */
  setVerticalInstallsBlocked(actor: PlatformActorId, slug: string, blocked: boolean): Promise<void>;

  /**
   * Grant (or revoke) the TENANT-PROVISIONER capability (#412) — whether this
   * vertical's scopes may enqueue `provision-tenant` / `set-entitlements` intents
   * that the platform executes with its own authority. A directory-backed grant
   * rather than deployment config, so granting a manager is an audited staff
   * action, not an env edit + redeploy. Read at drain time by the platform-intent
   * handlers; flipping it never touches running scopes. Staff-only, idempotent,
   * audited.
   */
  setVerticalTenantProvisioner(actor: PlatformActorId, slug: string, granted: boolean): Promise<void>;

  /**
   * Delete a vertical from the registry — its row, its versions, its channels.
   *
   * **Refuses while any scope is still bound to it** (`scopes.vertical`), because a
   * deleted registry row would strand those scopes' version pins and routing. Delete
   * or rebind the scopes first; the refusal names the count. Deployed dispatch
   * scripts are NOT reaped here — they become orphans for the cleanup script (#248),
   * so a mistaken delete never destroys a deployment that scopes may still need
   * while the refusal above is being raced. Staff-only, audited.
   */
  deleteVertical(actor: PlatformActorId, slug: string): Promise<void>;

  /**
   * Promote a version to a channel (#31 step 2) — the moment a change reaches
   * anyone, and therefore where §4's two human checkpoints belong.
   *
   * **Refuses when a digest differs and the change is not acknowledged.** The
   * migration and permission diffs are a merge-time convention today: CI renders
   * them and a human is expected to look, but nothing ties that looking to the
   * moment of exposure. Here it is tied — and the acknowledgement is recorded, so
   * "someone reviewed it" becomes evidence rather than a claim.
   *
   * Only admitted versions may be promoted, for the same reason they are the only
   * ones bindable.
   */
  promoteVersion(
    actor: PlatformActorId,
    verticalSlug: string,
    channel: ChannelName,
    versionId: string,
    acknowledge?: PromotionAcknowledgement,
  ): Promise<void>;
  /** Ordered by channel name; `page.cursor` is a channel name. */
  listChannels(
    actor: PlatformActorId,
    verticalSlug: string,
    page?: ListPage,
  ): Promise<VerticalChannel[]>;

  /**
   * The promotion timeline (append-only, newest first) — every pointer move
   * `promoteVersion` ever made for the vertical, optionally narrowed to one channel.
   * Rollback UIs pick a target from it, and each entry's `at` is the instant a PITR
   * restore would rewind the data to (preview-and-snapshots.md §7).
   */
  listChannelHistory(
    actor: PlatformActorId,
    verticalSlug: string,
    channel?: ChannelName,
    page?: ListPage,
  ): Promise<ChannelHistoryEntry[]>;
  // ^ newest first is the shipped order, so `page.order` DEFAULTS to 'desc' here;
  //   the cursor is an entry id.

  /**
   * Point a scope at a version.
   *
   * **Refuses anything not admitted.** That refusal is the registry's reason to
   * exist: without it "push lands pending" is a convention, and a convention is what
   * D-30's lockstep-upgrade argument says we cannot afford to rely on.
   *
   * `opts.snapshot` opts into fork-before-promote (preview-and-snapshots.md §4): when
   * the incoming version's `migration_digest` differs from the scope's current bound
   * version's, an `archive` snapshot of the pre-migration data is captured first, so a
   * bad upgrade has a rollback point. Gated on the digest change (a code-only rebind
   * snapshots nothing) and opt-in until retention/GC ships.
   */
  bindScopeVersion(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    versionId: string,
    opts?: { snapshot?: boolean },
  ): Promise<void>;

  // -- the stable serving script (#286) ---------------------------------------
  //
  // One script per vertical serves in place: a Durable Object namespace belongs to
  // its script, so re-uploading new code under an unchanged name is what carries
  // scope data across a version update — the per-version scripts stay as the push
  // archive (admission review + the bundle store promote/backout read from). The
  // registry records the serving state; the UPLOAD orchestration lives at the
  // control-plane API where the platform's deploy credential is injected.

  /** What the serving script currently runs, or null before the first in-place serve. */
  verticalServing(actor: PlatformActorId, verticalSlug: string): Promise<VerticalServingState | null>;
  /**
   * Record a successful in-place serve: the script name, the version it now runs,
   * and the DO-class/migration-tag base the NEXT upload diffs against. Written only
   * AFTER the upload succeeded — a failed serve leaves `servingVersionId` trailing
   * the prod channel, which is the visible, retryable state. Audited.
   */
  setVerticalServing(
    actor: PlatformActorId,
    verticalSlug: string,
    state: VerticalServingState,
  ): Promise<void>;
  /**
   * The pushed DeployManifest (JSON) of one version — what a serve rebuilds upload
   * metadata from. Null for a version pushed before manifests were retained; such a
   * version can be bound per-version but never served in place.
   */
  versionManifest(actor: PlatformActorId, verticalSlug: string, versionId: string): Promise<string | null>;
  /**
   * Point a scope's ROUTING at the serving script its data now lives in. Per-scope
   * truth, deliberately not derived from the vertical: rerouting a scope whose DOs
   * still sit in a per-version script would resolve empty storage. Set at provision
   * (a scope born on the serving script) or by adopt-serving (a legacy scope whose
   * data was exported → restored into the serving script). `null` reverts to
   * per-version dispatch — the adopt path's own backout. Audited.
   */
  setScopeServingRef(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    servingRef: string | null,
  ): Promise<void>;

  /**
   * The PITR bookmarks a CO-LOCATED scope recorded before its migration passes
   * (#286) — the rewind points a backout offers. For a dispatch vertical the route
   * reads them through the vertical's `/internal/bookmarks` instead; this is the
   * bare-host/co-located fallback. Hosts without PITR (the SQLite adapter) return
   * an empty list — there is nothing to offer, not an error.
   */
  scopeMigrationBookmarks(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]>;
  /**
   * #286's backout: PITR-rewind a scope to a pre-migration bookmark — schema AND
   * data, discarding every write since. Audited (destructive by design). The scope
   * DO enforces the freshness window (24h unless `force`). `localApply: false`
   * audits without touching this host's own namespace — the route sets it when the
   * rewind is delegated to a dispatch vertical's `/internal/rewind`, whose DO
   * actually holds the data. Hosts without PITR throw.
   */
  rewindScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    bookmark: string,
    opts?: { force?: boolean; localApply?: boolean },
  ): Promise<{ rewindingTo: string }>;

  // -- the hostname map (K-26; control-plane.md §4.7) -------------------------

  /**
   * Bind a hostname to a scope's surface. Lands `pending` — a custom domain is DNS
   * validation and certificate issuance, not a string somebody sets, so the states
   * it passes through are §4.2's business.
   *
   * Exactly one hostname per (scope, surface) may be canonical; binding a second
   * canonical demotes the first, because "which one do certs and redirects use" has
   * to have one answer.
   */
  bindHostname(actor: PlatformActorId, input: BindHostnameInput): Promise<void>;
  setHostnameStatus(
    actor: PlatformActorId,
    hostname: string,
    status: HostnameStatus,
    note?: string,
  ): Promise<void>;
  /**
   * Record the outcome of a Cloudflare-for-SaaS issuance step (§4.7) — status plus the
   * CF custom-hostname id and the DNS records the tenant must publish. This is what the
   * control-plane's issuance path (bind of a custom domain) and the reconcile poll write
   * through; a plain status flip stays `setHostnameStatus`. The `customHostnameId` is
   * written on create and left untouched (`undefined`) on later polls, so the handle a
   * poll needs is never lost.
   */
  setHostnameIssuance(
    actor: PlatformActorId,
    hostname: string,
    fields: {
      status: HostnameStatus;
      note?: string | null;
      customHostnameId?: string | null;
      validationRecords: DnsRecord[];
    },
  ): Promise<void>;
  /**
   * Remove a hostname binding — the inverse of `bindHostname`.
   *
   * A hard DELETE, not a tombstone, and deliberately so: a hostname row is
   * routing config, not access evidence — `deleteSnapshot` already hard-deletes
   * a reaped fork's rows via the same path, and the bind/unbind history lives in
   * the append-only admin log (K-21 protects tuples, not the route table).
   * Idempotent: unbinding an unknown hostname is a silent no-op, not an error —
   * so a cleanup pass can re-run over a partial failure.
   */
  unbindHostname(actor: PlatformActorId, hostname: string): Promise<void>;
  /** Ordered by hostname; the cursor is a hostname. */
  listHostnames(
    actor: PlatformActorId,
    filter?: { tenantId?: TenantId; scopeId?: ScopeId; status?: HostnameStatus } & ListPage,
  ): Promise<HostnameBinding[]>;

  /**
   * Resolve a hostname for the router — the per-request read path.
   *
   * Takes NO actor and is not logged, for the same reason `resolveIdentity` does
   * not: this runs on every request, by a machine, before any staff member is
   * involved. K-24's access log records who *read the directory*, and a router
   * dispatching traffic is not that.
   *
   * Returns only `active` bindings. It does **not** re-check tenant or scope
   * suspension: `getScope` already fails closed there (§7), and a second
   * enforcement point is a second thing that can disagree.
   */
  resolveHostname(hostname: string): Promise<RouteTarget | undefined>;

  // -- tenant registry (control-plane.md §4.1) -------------------------------

  /**
   * Persist a tenant. Idempotent on the id — re-creating an existing tenant is a
   * no-op, not an error (control-plane.md §4.1). `status` starts `active` and
   * `createdAt` is stamped host-side. This is what replaces "a tenant is a ULID
   * nobody used before" with a real record.
   */
  createTenant(actor: PlatformActorId, input: CreateTenantInput): Promise<void>;
  /**
   * Transition a tenant's status. `suspended` fails `getScope` closed for every
   * scope under the tenant (K-3's path) — the containment lever for non-payment
   * or an incident, reversible without deleting anything. `deleting` (§4.8) does
   * the same read-closed containment but marks the tenant for reap: entering it
   * stamps `deletingAt`, leaving it (an un-delete back to `active`) clears it, so
   * the grace-window sweep can age the tenant off that timestamp. `reaped` is
   * terminal and NOT reachable here — it is only ever reached via `reapTenant`.
   */
  setTenantStatus(
    actor: PlatformActorId,
    tenantId: TenantId,
    status: TenantStatus,
  ): Promise<void>;
  /**
   * Rename a tenant's DISPLAY name. Never the slug: registry ids
   * (`<tenantSlug>/<name>`) and pinned workspaces are keyed on it, so the slug is
   * immutable here by omission — renaming display must not orphan a vertical.
   */
  setTenantName(actor: PlatformActorId, tenantId: TenantId, name: string): Promise<void>;
  /**
   * deleting → reaped. The terminal tenant reap (control-plane.md §4.8), the
   * tenant-level analogue of `reapScope`: clear the tenant's PII/config directory
   * rows (identities + identity pools, membership tuples, roles, entitlements,
   * orgs) and flip the `tenants` row to `reaped`, KEEPING that row as a tombstone
   * (burned slug + audit history) and `_substrat_admin_log` whole (the compliance
   * witness — never swept). Irreversible: the PII is gone, so `reaped` never
   * returns to `active`, and only a `deleting` tenant may be reaped (an illegal
   * source status fails closed).
   *
   * DIRECTORY-SIDE ONLY, deliberately: the tenant's scopes hold the domain bytes,
   * and wiping those runs ABOVE the kernel (a hosted scope's DO is CP-less, reached
   * via the vertical's `deleteScope`). The caller — the reap route and the
   * grace-window sweep — reaps every scope first (archive-if-needed → `reapScope`),
   * then calls this to clear the directory. Idempotent: re-running after a partial
   * failure converges (the DELETEs and the status flip are all set-to-empty).
   */
  reapTenant(actor: PlatformActorId, tenantId: TenantId): Promise<void>;
  /**
   * The tenant registry — the directory's inventory (control-plane.md §4.5 console
   * item 1). Ordered by tenant id (ULID = chronological); the cursor is a tenant id.
   */
  listTenants(actor: PlatformActorId, page?: ListPage): Promise<Tenant[]>;
  getTenant(actor: PlatformActorId, tenantId: TenantId): Promise<Tenant | undefined>;

  // -- the scope directory, read side (control-plane.md §3.2/§4.5) -----------
  // §3.2 calls the directory "the ONLY complete inventory of tenants and scopes,
  // and the input to reconciliation, migration sweeps, billing, and ops". Every
  // one of those needs to ENUMERATE, and until now nothing could: the write side
  // was complete and the read side did not exist. These two methods are that
  // sentence becoming true.
  //
  // Every read below takes an ACTOR, and records into the staff access log
  // (K-24). That is the point of the parameter: a read the log cannot attribute
  // is unrepresentable, which is the same property the write side has had since
  // K-20. Machine paths — `resolveIdentity`, called by the auth adapter before
  // there IS an actor — deliberately take none and are not logged.
  //
  // The separate log is why: conflating reads with §4.4's mutation trail would
  // make that trail's "every row is an effect" property false, and would force
  // one retention policy onto two things that need different ones.

  /** The scope inventory. Ordered by scope_id (ULID = chronological); cursor = scope id. */
  listScopes(actor: PlatformActorId, filter?: ScopeFilter): Promise<Scope[]>;
  /**
   * The tenant-store ledger (#301): every platform-minted per-tenant store, optionally
   * narrowed by tenant and/or vertical. The deploy path reads `{ vertical }` to derive
   * the D1 bindings that must ride every serving-script upload (a re-deploy must never
   * drop a tenant's store binding); the console reads it as inventory.
   */
  listTenantStores(
    actor: PlatformActorId,
    filter?: { tenantId?: TenantId; vertical?: string },
  ): Promise<TenantStoreRecord[]>;
  /**
   * The blob-store ledger (#473) — the per-tenant-bucket twin of `listTenantStores`,
   * with the same two consumers: the deploy path derives the `r2_bucket` bindings that
   * must ride every serving-script upload, and the console reads it as inventory.
   */
  listBlobStores(
    actor: PlatformActorId,
    filter?: { tenantId?: TenantId; vertical?: string },
  ): Promise<BlobStoreRecord[]>;
  /**
   * One scope's directory record. Cross-checks the (tenantId, scopeId) pair and
   * returns undefined on a mismatch rather than another tenant's scope (K-3) —
   * the same fail-closed rule `ScopeHost.getScope` applies when minting a stub.
   *
   * Distinct from `ScopeHost.getScope`, which mints a capability stub for a
   * principal and grants no read of the record. This returns the record and
   * grants no execution.
   */
  getScopeRecord(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<Scope | undefined>;

  // -- scope data introspection (kernel-design §5.4's admin-query RPC) --------
  // A read-only window into a scope's OWN database — the console/dashboard "Data"
  // view. §5.4 named this seam ("a grant is a tuple in the scope's own database and
  // needs an admin-query RPC"); these two methods are it, deliberately narrow.
  //
  // Read-only and table-shaped ON PURPOSE. There is no user-supplied SQL: the caller
  // picks a table from the live schema and a bounded page. So there is no write path
  // to forge the spine (module rules §"never write _substrat_*") and no injection
  // surface — the table name is validated against `listScopeTables`, never
  // interpolated blind. Reads of the `_substrat_*` spine are allowed (projections
  // already read it); they are flagged `system` so the UI can set them apart.
  //
  // Both take an ACTOR and record to the K-24 access log, like every directory read,
  // and both cross-check (tenantId, scopeId) and FAIL CLOSED on a mismatch (K-3) —
  // a confused-deputy scope id resolves to nothing, never another tenant's database.

  /** Every table in the scope's database, with row counts; system tables flagged. */
  listScopeTables(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeTable[]>;
  /**
   * A bounded page of rows from one table of the scope's database. The table name is
   * validated against the live schema (an unknown one throws, never a blind query);
   * `limit` is clamped to the contract ceiling and `offset` pages. Rows are positional
   * arrays aligned to `columns`.
   */
  readScopeTable(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    input: ReadScopeTableInput,
  ): Promise<ScopeTablePage>;

  /**
   * One read-only SQL statement against the scope's database — the console the two
   * table-shaped reads deliberately weren't (#219). User SQL DOES reach the DB here,
   * so read-only-ness is enforced per statement instead of by construction: the
   * kernel's `assertReadOnlyQuery` textual gate (shared, so both adapters reject the
   * same statements) plus the adapter's authoritative backstop (better-sqlite3's
   * `prepare().readonly`; a rolled-back transaction on the DO). Results are capped at
   * SCOPE_QUERY_ROW_MAX rows (`truncated` set, never an error). Same actor + K-24
   * access log (the statement itself is the logged argument) and the same K-3
   * (tenantId, scopeId) cross-check, failing closed on a mismatch. Writes stay
   * impossible, not just forbidden — editing rows would forge the spine.
   */
  queryScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    input: QueryScopeInput,
  ): Promise<ScopeQueryResult>;

  /**
   * A COMPLETE dump of the scope's database — every table (the vertical's own AND the
   * `_substrat_*` spine), its DDL, and every row. This is the read side of the
   * preview/snapshot primitive (docs/design/preview-and-snapshots.md §3): the source a
   * fork copies into a new scope, or a governed `substrat scope pull` writes to a file.
   *
   * Unlike `readScopeTable` — bounded and blob-as-null, deliberately NOT a dump — this
   * exfiltrates the whole scope, so it is the more privileged read: same `PlatformActorId`
   * and K-24 access log, same (tenantId, scopeId) K-3 cross-check that fails closed on a
   * mismatch. It drops only SQLite's own `sqlite_*` internals (auto-managed, un-recreatable);
   * the spine is kept because a fork must carry the event/migration state to be faithful.
   */
  exportScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeDump>;

  // -- scope lifecycle (control-plane.md §4.2) -------------------------------
  // The §3.3 transitions that existed only on paper. Each fails closed on an
  // illegal transition, is audited, and (for suspend/archive) makes getScope
  // fail closed for that scope. `provisionScope` is the entry transition and
  // lives on ScopeHost (it is async — it applies migrations).

  /**
   * provisioning → active. The vertical's confirmation that a scope exists (K-31).
   *
   * `provisionScope` writes the directory row as `provisioning`, and nothing may use
   * it until this runs — `getScope` fails closed on any non-active scope, so a row
   * whose vertical never provisioned is inert rather than misleading.
   *
   * Deliberately a separate call rather than a flag on `provisionScope`: the two
   * happen against DIFFERENT systems, and the gap between them is a real state that
   * something has to be able to observe and retry.
   */
  activateScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;

  /** active → suspended. Reversible containment (incident, dispute). */
  suspendScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;
  /** suspended → active. */
  unsuspendScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;
  /** active|suspended → archived. Stops the active-scope meter (§9). */
  archiveScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;
  /**
   * archived → active. A RESTORE, never a flag flip (control-plane.md §4.2):
   * §9's meter can only charge on "active scope" if un-archiving is a deliberate,
   * audited act. Jurisdiction is untouched — it is fixed at provisioning (K-7).
   */
  unarchiveScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;

  /**
   * archived → reaped. The terminal reap (control-plane.md §4.4): wipe the scope DO's
   * storage — Cloudflare never garbage-collects a Durable Object, so an archived app's
   * bytes persist forever until this runs — while KEEPING the directory row as a
   * tombstone (audit history + burned slug, §4.4). Unlike `unarchiveScope` this is
   * IRREVERSIBLE: the bytes are gone, so `reaped` never returns to `active`, and only
   * an `archived` scope may be reaped (an illegal source status fails closed). Unlike
   * `deleteSnapshot` it reaps a PRIMARY scope, not a fork, and does not delete the row.
   *
   * The CP-less byte-wipe (a hosted scope's DO lives in the vertical's own deployment)
   * is orchestrated by the caller via the vertical's `deleteScope` before this; the
   * adapter half wipes any co-located storage and flips the status.
   */
  reapScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;

  // -- entitlements (control-plane.md §4.3) ----------------------------------
  // What finally makes `manifest.entitlementKey` mean something (D-20). An
  // entitlement is a per-tenant SKU flag; a module whose key the tenant does not
  // hold does not load for that tenant — its operations do not resolve, exactly
  // as if it had never been registered. Granting one is the point of the console.
  // Widened by #33 to express a plan: expiry (enforced here, fail-closed at the
  // gate), quota and tier (expression only — the builder portal counts, D-33).

  /**
   * Turn a SKU flag on for a tenant, optionally carrying plan fields. Idempotent
   * and audited only when something changed; a re-grant with different fields is
   * an UPDATE (renewal, tier change) audited with before/after. Omitted plan
   * fields preserve the row's current values — explicit null clears (see
   * `entitlementGrantInput`).
   */
  grantEntitlement(
    actor: PlatformActorId,
    tenantId: TenantId,
    entitlementKey: string,
    plan?: EntitlementGrantInput,
  ): Promise<void>;
  /** Turn it off. A tenant's scopes lose access to that module's operations. */
  revokeEntitlement(
    actor: PlatformActorId,
    tenantId: TenantId,
    entitlementKey: string,
  ): Promise<void>;
  /**
   * The tenant's grants with their plan fields (control-plane.md §5 meter 2).
   * Includes expired rows — gate-dead but visible, so a lapsed trial can be
   * renewed rather than looking never-granted.
   */
  listEntitlements(actor: PlatformActorId, tenantId: TenantId): Promise<EntitlementGrant[]>;

  // -- identity (D-16; control-plane.md §6) ----------------------------------
  // The neutral seam an auth adapter maps into. An external identity
  // (provider + externalId — Better Auth, an OIDC issuer, …) binds to a
  // principal and its home tenant/scope. The kernel never learns HOW a caller
  // authenticated, only WHO they are; the mechanism stays a swappable edge
  // adapter. Authentication only — authorization remains roles/grants.

  /**
   * Bind an external identity to a principal + home node. Audited.
   *
   * Keyed `(tenantId, provider, externalId)` — **not** `(provider, externalId)`.
   * kernel-design §4.3: with one auth pool per white-label tenant, an external subject
   * id is unique only *within* its pool, so a globally-keyed mapping is a cross-tenant
   * identity bleed. It is also what lets one staff login belong to several tenants: one
   * external id, one row per tenant.
   *
   * Idempotent when the key already maps to the SAME principal. A key already bound to a
   * DIFFERENT principal **throws** — it means two subjects collided, and silently
   * ignoring it would resolve the second person as the first.
   */
  // -- the integrations hub (#101; design/connections.md §3) ------------------

  /**
   * Store a tenant's authorization for one provider, held by one vertical.
   *
   * The credential is sealed by the host's `SecretBox` before it touches the
   * directory, and the admin-log row carries **metadata only** — provider,
   * label, scopes. That is structural, not careful: `_substrat_admin_log` is
   * append-only, so a secret written into it could never be removed.
   *
   * Takes a `PlatformActorId` today. Connecting a provider is really a tenant
   * admin's act, and routing it through a platform actor is the same defect
   * D-31 named for `addMember` — so this is a deliberate deferral, recorded in
   * connections.md §3.5, not an answer. No console flow should be built on this
   * signature until the question is settled together with membership's.
   */
  createConnection(actor: PlatformActorId, input: CreateConnectionInput): Promise<void>;

  /** Metadata only — never the credential, at any privilege level. */
  listConnections(actor: PlatformActorId, filter?: ConnectionFilter): Promise<Connection[]>;

  /** Replace the sealed credential — the OAuth refresh path. */
  updateConnectionSecret(
    actor: PlatformActorId,
    id: ConnectionId,
    secret: ConnectionSecret,
    expiresAt?: string,
  ): Promise<void>;

  /**
   * Withdraw a connection. Tombstones like K-21 rather than deleting: a
   * credential that once had access is evidence of why an access was allowed.
   * Terminal — a replacement is a new connection, which is why the uniqueness
   * constraint ignores revoked rows.
   */
  revokeConnection(actor: PlatformActorId, id: ConnectionId): Promise<void>;

  /**
   * Open the credential for one (tenant, vertical, provider[, account]) — the
   * connector's read, and the only path in the system that yields plaintext.
   *
   * **Takes no actor and is not audited**, the same exemption `resolveHostname`
   * and `resolveIdentity` hold and for the same reason: it is a machine read on
   * the request path, and an audit row per outbound HTTP call would drown the
   * log that matters. What *is* recorded is health — `recordConnectionUse` below
   * — which is the signal an operator can actually act on.
   *
   * A provider that supports several external accounts per tenant (GitHub's
   * namespaces) may hold several live connections; `externalAccountRef` selects
   * among them. Omitted, the single live connection is returned — and when more
   * than one is live the read **throws** rather than picking one arbitrarily,
   * because acting against the wrong tenant account is worse than failing.
   */
  openConnection(
    tenantId: TenantId,
    vertical: string,
    provider: string,
    externalAccountRef?: string,
  ): Promise<OpenConnection | undefined>;

  /**
   * Record that a connection worked, or did not (§3.7). Written by the connector
   * runtime; read by a console. Not audited — it is telemetry about a machine
   * read, not a control-plane mutation.
   */
  recordConnectionUse(id: ConnectionId, outcome: { ok: true } | { ok: false; error: string }): Promise<void>;

  /**
   * Durable, connection-scoped state a connector keeps for itself — the home a
   * connector's bookkeeping never had.
   *
   * The load-bearing use is **dispatch idempotency**. A connector runs from the
   * outbox at-least-once, so a redelivery must not repeat an outward effect —
   * and it cannot record "already did this" in the scope, because a connector
   * runs *inside* the scope's dispatch and re-entering the scope actor
   * deadlocks. This lives in the DIRECTORY instead, which the connector reaches
   * through `ctx.admin` without touching the scope: before it creates a document
   * at the provider it checks for prior state under a deterministic key, and
   * skips if it is there.
   *
   * `value` is arbitrary JSON, opaque to the kernel — a `{ documentId, … }` map
   * the connector interprets. NOT audited: this is high-frequency machine state,
   * one write per dispatch, the same class as `recordConnectionUse`. Rows die
   * with the connection (revoke cascades).
   */
  putConnectorState(id: ConnectionId, key: string, value: unknown): Promise<void>;
  getConnectorState(id: ConnectionId, key: string): Promise<unknown | undefined>;
  /**
   * Every state row for a connection, optionally narrowed to keys under a
   * `prefix`, ordered by key.
   *
   * `getConnectorState` answers "did I already do THIS one" from a deterministic
   * key — the dispatch path. This answers "what is still outstanding" without
   * knowing the keys up front, which is what a **poll driver** needs: a connector
   * records one row per dispatch under `<provider>:dispatch:<id>`, and a
   * scheduled sweep enumerates them (`prefix = '<provider>:dispatch:'`) to
   * reconcile each against the provider. Without it a sweep would have to be told
   * every id it might reconcile — which defeats the point of a sweep.
   *
   * A read of directory-local machine state, like get/put; not audited.
   */
  listConnectorState(
    id: ConnectionId,
    prefix?: string,
  ): Promise<{ key: string; value: unknown }[]>;

  linkIdentity(actor: PlatformActorId, input: IdentityLink): Promise<void>;

  /**
   * Remove a principal's identity link(s) in a tenant — the inverse of `linkIdentity`,
   * keyed by principal (not external id) so a caller who removed a member can sever
   * their login from the team without knowing their external subject. After this,
   * `listIdentityTenants` no longer returns the tenant for that person and
   * `resolveIdentity` no longer resolves — so the team disappears from their switcher.
   * A DELETE, not a tombstone: the identity map is current operational state (the audit
   * is the admin log), and re-inviting must be able to re-link a fresh principal.
   * Idempotent: unlinking a principal with no link is a silent no-op.
   */
  unlinkIdentity(actor: PlatformActorId, tenantId: TenantId, principal: PrincipalId): Promise<void>;

  /**
   * Register an identity pool and its topology (K-23). A provider must be registered
   * before it may link: an unregistered pool has not said whether the same
   * `externalId` in two tenants is one human or two, and the kernel will not guess.
   * Idempotent on an identical registration; a conflicting re-registration throws,
   * since changing a live pool's topology silently reinterprets every row it owns.
   */
  registerIdentityPool(actor: PlatformActorId, pool: IdentityPool): Promise<void>;
  getIdentityPool(actor: PlatformActorId, provider: string): Promise<IdentityPool | undefined>;

  /**
   * Which tenants this login exists in — the cross-tenant question, kept distinct
   * from resolution because they have different safety conditions.
   *
   * **Central pools only.** On a tenant-bound pool the same `externalId` in another
   * tenant is a different person, so enumerating would hand one person another's
   * tenant list; this throws there rather than returning the single obvious answer,
   * because asking at all is a category error the caller should see.
   */
  listIdentityTenants(
    actor: PlatformActorId,
    provider: string,
    externalId: string,
  ): Promise<TenantId[]>;

  /**
   * Every identity link in one tenant — the projection read (#406). This is what the
   * platform gathers (authoritatively, never from a caller's body) to deliver a
   * tenant's links WITH provisioning/reconcile, the same trust line entitlements ride
   * (#310), so a CP-less vertical resolves `(provider, externalId) → principal` from
   * its own storage at request time. A staff read of the directory, so it is
   * access-logged (K-24) — unlike `resolveIdentity`, which is the per-request machine
   * path and records nothing.
   */
  listIdentityLinks(actor: PlatformActorId, tenantId: TenantId): Promise<IdentityLink[]>;

  /**
   * Resolve an external identity within a tenant — the auth adapter's read path.
   *
   * The tenant is an INPUT: the caller knows which pool the credential came from (its
   * hostname, or the org claim on a pool-scoped token). It is not derived from the
   * identity, because across per-tenant pools the same `externalId` legitimately names
   * different people.
   */
  resolveIdentity(
    tenantId: TenantId,
    provider: string,
    externalId: string,
  ): Promise<ResolvedIdentity | undefined>;

  /**
   * The append-only admin audit trail, oldest first by default (ULID order is
   * chronological). Read path for the console history and the permission-diff
   * human checkpoint (control-plane.md §4.5) — where the interesting column is
   * `before`/`after`: a redefined role captures its old and new shape there, and
   * that diff IS the checkpoint.
   */
  auditLog(actor: PlatformActorId, filter?: AuditLogFilter): Promise<AdminLogEntry[]>;

  /**
   * The staff access log (K-24) — who READ the directory, when, and how much came
   * back. Reading it is itself recorded: who examined the record of who looked is
   * the question an incident asks second.
   */
  accessLog(actor: PlatformActorId, filter?: AccessLogFilter): Promise<AccessLogEntry[]>;

  /**
   * Prune access-log rows already shipped to Tier 2, oldest first, up to `limit`.
   *
   * **Only drained rows.** Pruning on age alone would destroy evidence while calling
   * itself a retention policy — the failure K-21 rejected for tuples, one layer up.
   * Nothing drains yet, so today this prunes nothing and the log grows: a stated
   * limitation, not a policy, and the reason `drainedAt` ships before the sink.
   */
  pruneAccessLog(actor: PlatformActorId, limit: number): Promise<number>;
}

export interface ProvisionScopeInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  /**
   * Unique within the tenant; the console's human handle for the scope, shown as
   * `{tenant.slug}/{scope.slug}`. Optional and defaulted to the lowercased
   * scopeId — a ULID lowercases into a valid slug, so the default is structurally
   * valid and unique by construction. A caller that means something by the name
   * supplies one; the default is a placeholder, not a convention.
   */
  slug?: string;
  /** Vertical vocabulary ('brf', 'filial'). The kernel never branches on it. Defaults to 'scope'. */
  kind?: string;
  /** Display name. Defaults to the slug. */
  name?: string;
  /** Which vertical's deployment executes this scope. Defaults to null. */
  vertical?: string | null;
  storageShape?: StorageShape;
  jurisdiction?: Jurisdiction;
  /**
   * Fork provenance (preview-and-snapshots.md §3): the scope this one was copied
   * FROM, and WHEN. `importScope` sets both from the dump; a normal provision leaves
   * them null. Recorded on the directory row — the kernel never branches on them.
   */
  forkedFrom?: ScopeId;
  forkedAt?: string;
  /**
   * Retention horizon (preview-and-snapshots.md §3): when the GC sweep may reap this
   * scope. Only meaningful on forks — the reaper refuses non-forks regardless. Unset =
   * retained until deliberately deleted.
   */
  expiresAt?: string;
}

/** What `provisionTenantStore` needs to mint (or idempotently re-resolve) a per-tenant
 *  relational store (#301). Keyed by (tenant, vertical, binding) — the same tenant can hold
 *  one store per declared `tenantStoreNeed.binding`, and two verticals never share one. */
export interface TenantStoreProvisionInput {
  tenantId: TenantId;
  /** The vertical the store belongs to — its `tenantStoreNeed` binding is scoped to it. */
  vertical: string;
  /** The declared `tenantStoreNeed.binding` this store satisfies (SCREAMING_SNAKE). */
  binding: string;
}

/**
 * A live per-tenant relational store the vertical reached through the host (#301) — the
 * thing `openTenantStore` hands back. Deliberately the same `query`/`exec` VOCABULARY as
 * `ScopedSql`, so a vertical's own-store code reads like its scope-DB code — but **async**,
 * because the store is only reachable asynchronously on Cloudflare (a `D1Database` binding
 * in the worker, the D1 HTTP API from the control plane), and a contract only the SQLite
 * adapter could satisfy would be no contract at all. Plus a `native` escape hatch for a
 * library (e.g. Better Auth) that wants the raw driver.
 *
 * `native` is `unknown` at the contract on purpose: a `better-sqlite3` `Database` on the
 * pure adapter, a `D1Database` on Cloudflare (in the worker — the control plane's HTTP-query
 * store has no in-process driver and carries `null`). The vertical narrows it in its own
 * runtime-specific harness — exactly the node/worker split a hosted vertical already has —
 * which is what lets one vertical run unchanged against D1 in prod and a `.sqlite` file locally.
 */
export interface TenantRelationalStore {
  query<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  exec(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** The underlying driver, for a library that needs it. Adapter-typed; `unknown` here. */
  readonly native: unknown;
}

/**
 * One row of the tenant-store ledger (#301): the platform-minted per-tenant store
 * satisfying a vertical's declared `tenantStoreNeed`, keyed (tenant, vertical, binding).
 * The ledger is what makes provisioning idempotent, tells the deploy path which D1
 * bindings must ride every serving-script upload (a re-deploy must never drop a tenant's
 * store), and tells a future reap what to tear down.
 */
export interface TenantStoreRecord {
  tenantId: TenantId;
  vertical: string;
  binding: string;
  kind: 'relational';
  ref: string;
  createdAt: string;
}

/** What `provisionBlobStore` needs to mint (or idempotently re-resolve) a per-tenant
 *  blob store (#473). Keyed by (tenant, vertical, binding), exactly like tenant stores. */
export interface BlobStoreProvisionInput {
  tenantId: TenantId;
  /** The vertical the store belongs to — its `blobStoreNeed` binding is scoped to it. */
  vertical: string;
  /** The declared `blobStoreNeed.binding` this store satisfies (SCREAMING_SNAKE). */
  binding: string;
}

/**
 * A live per-tenant blob store (#473) — the byte side of the attachment surface. The
 * contract is async and byte-shaped (Uint8Array + web-standard types only) because the
 * store is only reachable asynchronously on Cloudflare (an `R2Bucket` binding); the pure
 * adapter backs it with a per-tenant directory and resolves immediately.
 *
 * Keys are PLATFORM-DERIVED (`attachmentBlobKey`), never caller-supplied strings — the
 * per-scope prefix inside a per-tenant store is constructed in kernel/adapter code, which
 * is what turns "scope/<id>/ is a convention" into "cross-scope keys are unwritable".
 */
export interface TenantBlobStore {
  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix` — the GC/ops walk. */
  list(prefix: string): Promise<string[]>;
}

/**
 * One row of the blob-store ledger (#473) — same idempotency/deploy/reap roles as
 * {@link TenantStoreRecord}: a retried provision re-resolves the same `ref`, the deploy
 * path derives which `r2_bucket` bindings must ride every serving-script upload, and a
 * tenant reap knows what to tear down.
 */
export interface BlobStoreRecord {
  tenantId: TenantId;
  vertical: string;
  binding: string;
  kind: 'blob';
  ref: string;
  createdAt: string;
}

/**
 * The blob key an attachment's bytes live under inside the per-tenant store (#473).
 * Scope-prefixed by construction: every key this platform ever writes for a scope sits
 * under `scope/<scopeId>/`, and the attachment id (a fresh ULID per upload) makes keys
 * write-once — the two properties the attachment integrity story rests on. Exported so
 * both adapters (and an ops GC walk) derive the same key; module and route code never do.
 */
export function attachmentBlobKey(scopeId: string, attachmentId: string): string {
  return `scope/${scopeId}/att/${attachmentId}`;
}

/** Input to `ScopeAttachments.upload` (#473). Bytes ride here — NOT through
 *  `ScopeStub.invoke`, whose structured-clone pipe and per-scope serialization are
 *  exactly the wrong path for megabytes of JPEG (the issue's point). */
export interface AttachmentUploadInput {
  /** The owning entity — must be a declared `attachmentTargets` entityType. */
  entity: EntityRef;
  filename: string;
  contentType: string;
  visibility: Visibility;
  body: Uint8Array;
}

/** An opened attachment: the metadata fact plus the bytes it witnesses. */
export interface OpenedAttachment {
  record: AttachmentRecord;
  body: Uint8Array;
  contentType: string;
}

/**
 * The attachment surface a host mints per (principal, scope) — `attachmentTargets`
 * finally consumed (#473). Every method is gated INSIDE the platform by the declared
 * target's permission, checked as the ambient principal with the owning entity as the
 * per-entity ref (so entity-narrowed grants resolve): `readPermission` for list/open,
 * `writePermission` (default: the read key) for upload/remove. The metadata fact lands in
 * `_substrat_attachments` inside the scope's own database — under scope serialization,
 * with an `attachment.added`/`attachment.removed` spine event in the same transaction —
 * while bytes go straight to the per-tenant blob store, never through the scope pipe.
 */
export interface ScopeAttachments {
  upload(input: AttachmentUploadInput): Promise<AttachmentRecord>;
  /** Records for one entity, newest first. Gated by the target's readPermission. */
  list(entity: EntityRef): Promise<AttachmentRecord[]>;
  /** Record + bytes, or null for an id this scope does not know. Gated per entity. */
  open(attachmentId: string): Promise<OpenedAttachment | null>;
  /** Delete row (and event) first, then bytes; returns the removed record, null if unknown. */
  remove(attachmentId: string): Promise<AttachmentRecord | null>;
}

/**
 * Narrow `listRoles` (control-plane.md §4.5 console item 4 — the permission
 * diff's runtime half).
 */
export interface RoleFilter extends ListPage {
  tenantId?: TenantId;
  /**
   * A module id, or 'vertical'. Both mean "declared in code" — see
   * `roleDefinition.source`. Filtering for operator-created roles is not
   * possible until something can create one.
   */
  source?: string;
}

/** Narrow `listScopes` (control-plane.md §4.5 console items 1 and 6). */
export interface ScopeFilter extends ListPage {
  tenantId?: TenantId;
  /** One status or any of several — the console's All / Suspended / Archived tabs. */
  status?: ScopeStatus | ScopeStatus[];
  vertical?: string;
}

/**
 * Narrow the admin audit trail (control-plane.md §4.4/§4.5). Every field is a
 * conjunctive AND; omitting all of them reads the whole log, which is why `limit`
 * exists — the table is append-only and only grows.
 */
export interface AccessLogFilter extends ListPage {
  actor?: PlatformActorId;
  tenantId?: TenantId;
  method?: string;
}

export interface AuditLogFilter {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  actor?: PlatformActorId;
  /** One action or any of several. */
  action?: AdminAction | AdminAction[];
  /** Inclusive lower / exclusive upper bound on `at` (ISO 8601). */
  since?: string;
  until?: string;
  /**
   * Page size. Unset means unbounded — kept as the default because the read is
   * `AdminLogEntry[]`, and a silent cap would let a caller mistake a truncated
   * page for the whole log. The console always passes one. (The log is never
   * swept — it is the compliance witness, control-plane.md §4.4/§4.8 — so the
   * bound against dumping an ever-growing table lives on the HTTP read surface,
   * `GET /admin-log`, which DEFAULTS a page rather than leaving it unbounded.)
   */
  limit?: number;
  /**
   * Page anchor: the `id` of the last entry of the previous page. Entries are
   * returned strictly after it in `asc` order, strictly before it in `desc` —
   * ULID order is chronological, so the cursor is the entry id itself and needs
   * no separate encoding. There is no `nextCursor`: it is `entries.at(-1)?.id`.
   */
  cursor?: string;
  /**
   * Default 'asc' — oldest first, preserving the ordering the log shipped with.
   * The console reads 'desc'.
   */
  order?: 'asc' | 'desc';
}

export interface ScopeHost {
  /**
   * Mint a capability stub for a principal. Validates the (tenantId, scopeId)
   * pair against the directory — a mismatched pair fails closed (K-3), it never
   * resolves to another tenant's scope. `options` attaches harness-level
   * observers (`ScopeStubOptions`); they carry no authority and change nothing
   * about what the stub may do.
   */
  getScope(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ScopeStub>;

  /**
   * The entry scope-lifecycle transition (control-plane.md §4.2): idempotent,
   * journaled, audited. Requires an existing ACTIVE tenant — a scope with no
   * tenant record is the "tenant is an FK string" hole §4.1 closes, so it fails
   * closed. Jurisdiction is fixed here forever (K-7).
   */
  provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void>;

  /**
   * Mint (or idempotently re-resolve) a **per-tenant relational store** and return the
   * platform-minted handle (#301). The platform — never the vertical — does this, because
   * on Cloudflare it holds the credential that creates a D1 (D-34); the vertical only ever
   * OPENS what it is handed (`openTenantStore`). Idempotent: called again for the same
   * (tenant, vertical, binding) it returns the existing store's handle rather than minting
   * a second one, so a retried provision cannot orphan a database.
   *
   * The returned `handle.ref` is opaque — a D1 `database_id` on Cloudflare, a per-tenant
   * `.sqlite` path token on the pure adapter — and is what closes the ownership gap a
   * bundle-chosen id left open (self-serve-deploy.md §4): the id is minted here, not declared.
   */
  provisionTenantStore(
    actor: PlatformActorId,
    input: TenantStoreProvisionInput,
  ): Promise<TenantStoreHandle>;

  /**
   * Open a per-tenant relational store the platform minted (#301) for reads/writes — the
   * request-time and provision-time reach the vertical uses (e.g. to run its OWN store
   * migrations against a freshly-handed store before the provision callback returns,
   * preserving the K-31 fail-closed/idempotent/retry ready-gate). Takes the opaque handle
   * from `provisionTenantStore`; never parses `ref` in vertical code.
   */
  openTenantStore(handle: TenantStoreHandle): TenantRelationalStore;

  /**
   * Mint (or idempotently re-resolve) a **per-tenant blob store** (#473) — the byte home
   * for the attachment surface. Same ownership story as `provisionTenantStore`: the
   * platform holds the credential that creates an R2 bucket (D-34), the builder declares
   * only the NEED (`runtimeNeeds.blobStores`), and the returned `handle.ref` is opaque —
   * an R2 bucket name on Cloudflare, a per-tenant directory token on the pure adapter.
   * Idempotent on (tenant, vertical, binding) via the blob-store ledger.
   */
  provisionBlobStore(
    actor: PlatformActorId,
    input: BlobStoreProvisionInput,
  ): Promise<BlobStoreHandle>;

  /**
   * Mint the attachment surface for a principal on a scope (#473) — the runtime consumer
   * of the manifests' `attachmentTargets`. Same fail-closed (tenantId, scopeId) gate and
   * lifecycle checks as `getScope`; the returned surface carries the ambient principal, so
   * every read is `check(target.readPermission, entity)` — proof path included — before a
   * single byte is served, and every mutation checks the target's write key the same way.
   *
   * Deliberately NOT on `ScopeStub`: bytes must never ride the structured-clone invoke
   * pipe through the scope's strict serialization. Metadata facts go inside the scope
   * (serialized, transactional, spine event included); bytes go to the per-tenant blob
   * store the platform minted. Throws when no blob store is configured/provisioned for
   * the scope's vertical rather than pretending — the K-31 fail-closed posture.
   */
  attachments(
    principal: PrincipalId,
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScopeAttachments>;

  /**
   * Provision a NEW scope and load a `ScopeDump` into it — the write side of
   * `exportScope` and the fork primitive (docs/design/preview-and-snapshots.md §3):
   * a preview/snapshot is a fresh scope carrying a copy of another's data.
   *
   * The new scope's schema, rows, AND migration frontier come from the dump verbatim
   * (drop-then-replay) — NOT from running the vertical's migrations. A fork must be a
   * faithful copy at the *source's* frontier, which is the whole point: you can then
   * bind a different version and roll ITS migrations forward on the copy, forward-only
   * law intact (§4). Provisions → loads → activates, so the result is a ready scope.
   *
   * Same `PlatformActorId` and audit as `provisionScope`, and it inherits its
   * fail-closed tenant gate (the dump's own `tenantId`/`scopeId` are provenance, never
   * the authority — `input` says where the copy lands).
   */
  importScope(
    actor: PlatformActorId,
    input: ProvisionScopeInput,
    dump: ScopeDump,
  ): Promise<void>;

  /**
   * Load a `ScopeDump` into an EXISTING scope in place — the restore/backout half of
   * `exportScope` (preview-and-snapshots.md §8). Same drop-then-replay as a fork: the
   * dump's schema, rows AND migration frontier replace the scope's wholesale, so a
   * restore rewinds data faithfully and the forward-only migration law still holds on
   * the next bind (newer migrations roll forward from the dump's frontier).
   *
   * Refuses an unknown scope — restore never creates one; that is `importScope`. The
   * dump's own `tenantId`/`scopeId` are provenance, never the authority: the caller
   * says where it lands. Audited as `restoreScope` with the dump's provenance.
   */
  restoreScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    dump: ScopeDump,
  ): Promise<void>;

  /**
   * Snapshot a scope — fork its current data into a new scope and return that scope's
   * id. A thin composition of `exportScope` + `importScope` (preview-and-snapshots.md
   * §3): the new scope is `kind: 'archive'` by default, carries fork provenance
   * (`forkedFrom`/`forkedAt`), and is bound to the SOURCE's current version so it is a
   * runnable copy at the same frontier — a true "the scope as it was", not loose data.
   *
   * This is the primitive behind a manual "Snapshot" and behind `bindScopeVersion`'s
   * `snapshot` option (the automatic fork-before-promote). It provisions a scope in the
   * same tenant + jurisdiction as the source.
   */
  snapshotScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    opts?: { kind?: string; expiresAt?: string },
  ): Promise<ScopeId>;

  /**
   * Reap a fork — delete its storage AND its directory row (preview-and-snapshots.md
   * §3/§9). The one sanctioned hard delete on the platform, and deliberately narrow:
   * it REFUSES any scope whose `forkedFrom` is null. A fork is an ephemeral copy —
   * its deletion reclaims storage and PII without touching spine history; every
   * primary scope keeps the platform's tombstone-only rule (`archiveScope` et al).
   *
   * Removes, in order: the scope's hostname bindings (a reaped preview URL must stop
   * resolving), the directory row, and the scope's own storage (the DO's SQLite / the
   * adapter's file). Audited as `deleteSnapshot` with the fork's provenance in the
   * entry, so the log records what was reaped and where it came from.
   */
  deleteSnapshot(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<void>;

  /** Enforcement-input writes: roles, assignments, grants, membership. */
  readonly admin: HostAdmin;

  /** Register a module: validates the manifest, applies migrations lazily per scope. */
  registerModule(registration: ModuleRegistration): void;

  /**
   * Register an executor for an event type (K-22 §4.2). Host code, not module code:
   * `id` names the delivery target in the kernel's at-least-once journal, the same
   * way a module id does for a consumer, so an executor is redelivered until it
   * succeeds and never runs twice for one event once it has.
   *
   * Executors are dispatched **inline after commit**, with the outbox as the
   * durability and retry backstop. The contract stays eventually consistent — that
   * is what makes it correct under crash — but the common case completes inside the
   * originating request, so "requested but not yet effected" is a rare-case fallback
   * rather than the normal experience.
   *
   * **A failing handler never fails the operation** (#100). The operation already
   * committed; the delivery did not. Those are different facts, and reporting the
   * second as the first told a caller their work had been rolled back when it had
   * not. A failure is retried with backoff, dead-lettered at `maxAttempts`, and
   * surfaced through `drainDue`/`executorDeadLetters` — never thrown at whoever happened
   * to be holding the request.
   */
  registerExecutor(
    id: string,
    eventType: string,
    handler: ExecutorHandler,
    retry?: ExecutorRetryPolicy,
  ): void;

  /**
   * A scope stub whose authority is a CONNECTION rather than a person (#97).
   *
   * This is the inbound half of the connector seam: the path by which a
   * provider's callback, or a poll of a provider's state, writes back into a
   * scope. `getScope` demands a `PrincipalId` and a provider is not one, which
   * is why a connector could dispatch a document and then not record that it
   * had — and why an at-least-once retry would send a second copy.
   *
   * **Authority is inherited, not re-declared.** A connection is keyed
   * (tenant, vertical, provider), so this refuses any scope outside that
   * tenant, and any scope not running that vertical. What the connection may
   * then DO is an ordinary permission check against `connection:<id>` grants —
   * one enforcement path, one place to read, one way to revoke.
   *
   * `ctx.principal` on the resulting stub carries the connection id so the type
   * holds, but it is **not a person**: an operation invoked this way should read
   * the event actor (`{ connection }`), and a module that attributes domain
   * data to `ctx.principal` will be recording a connector.
   */
  getConnectorScope(connectionId: ConnectionId, scopeId: ScopeId): Promise<ScopeStub>;

  /**
   * The attachment surface for a CONNECTION on a scope (#476) — the connector's
   * door to `attachmentTargets`, the mirror of `getConnectorScope` for bytes.
   *
   * A connector runs sanctioned egress (it holds the provider credential), so it
   * is the only code that can fetch a provider artifact — the sealed signed PDF a
   * signing flow leaves at the provider, a document a webhook references. Landing
   * those bytes is exactly what `attachments()` does, but that surface is minted
   * per `PrincipalId` and a connection is not a person; and bytes cannot ride
   * `getConnectorScope`'s `invoke` (the structured-clone pipe #473 exists to
   * bypass). This is the missing seam: the same `ScopeAttachments` surface, but
   * every gate checked as the connection.
   *
   * **Same inheritance and enforcement as `getConnectorScope`.** Refuses a scope
   * outside the connection's tenant or not running its vertical; every
   * upload/remove is gated by the target's `writePermission` and every read by its
   * `readPermission`, checked against `connection:<id>` grants — so a connection
   * lands an attachment only where it was granted the write key (it appears in the
   * permission diff like any grant). `createdBy` on the record is the connection,
   * not a laundered principal. Throws when no blob store is provisioned for the
   * scope's vertical, exactly like `attachments`.
   */
  getConnectorAttachments(
    connectionId: ConnectionId,
    scopeId: ScopeId,
  ): Promise<ScopeAttachments>;

  /**
   * A scope stub whose authority is a MODULE acting on a timer (#383) — the
   * scheduler's door, the mirror of `getConnectorScope`.
   *
   * This is how a declared schedule invokes an operation on a scope without
   * signing in as a person. `getScope` demands a `PrincipalId`; a schedule is not
   * one, and modelling it as a human is exactly the attribution laundering #97
   * refused — after a night's run the audit log could not tell the scheduler from
   * an admin who sat down at 03:00.
   *
   * **Authority is inherited, not re-declared.** The stub refuses any scope not
   * running `moduleId`'s vertical, and any scope that is not `active`. What it may
   * then DO is an ordinary permission check against `system:<moduleId>` grants —
   * one enforcement path, `ctx.check` stays the single gate, no bypass. Events it
   * emits are stamped `{ system: moduleId }`. `ctx.principal` carries the module id
   * so the type holds, but it is **not a person**.
   */
  getSystemScope(moduleId: ModuleId, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeStub>;

  /**
   * The recurring-work declarations of every module registered on this host (#383)
   * — each module's id, the vertical it belongs to, and its `schedules`. Sync like
   * `migrationFrontier`: code-time bookkeeping derived from the registered
   * manifests, not directory state. The platform sweep reads this to discover what
   * to run, then enumerates each vertical's live scopes.
   */
  registeredSchedules(): ScheduleRegistration[];

  /**
   * Run every schedule that is DUE for this scope (#383) — the recurring-work
   * driver, the fleet-maintenance sibling of `drainDue`.
   *
   * Opens the scope once, and for each of `moduleId`'s declared schedules whose
   * cadence has elapsed since its last run (kernel-tracked spine state), invokes
   * the operation through the system door with its declared `input`, then records
   * the run. Idempotent and safe when nothing is due: a schedule inside its cadence
   * window is skipped, not re-run. Takes no actor — this is maintenance, the same
   * class as `drainDue`/`migrateScope`; the invocation itself is attributed to the
   * system actor. A single schedule's failure is reported, never thrown, so one bad
   * operation cannot stop the others on the scope.
   */
  runDueSchedules(moduleId: ModuleId, tenantId: TenantId, scopeId: ScopeId): Promise<ScheduleRunReport>;

  /**
   * Register a connector — an executor that also gets a per-tenant credential
   * and sanctioned egress (#101, design/connections.md §4.1).
   *
   * Rides the same hardened dispatch, journal and retry policy as
   * `registerExecutor`; the difference is only what the handler is handed. Kept
   * as a second registration rather than widening `ExecutorHandler` because the
   * two really are different capabilities, and a membership executor should not
   * be handed the machinery to call the internet.
   */
  registerConnector(
    id: string,
    eventType: string,
    handler: ConnectorHandler,
    options?: ConnectorOptions,
  ): void;

  /**
   * Run every executor delivery that is due for this scope — the retry driver.
   *
   * Inline dispatch after an operation covers the common case, but a delivery
   * that failed has no way back on its own: before this existed, retry happened
   * only if someone happened to invoke another operation on the same scope, so a
   * quiet scope could hold a failed effect forever with nothing reporting it.
   *
   * Call it from whatever scheduling the deployment has — a cron trigger, a
   * Durable Object alarm, a dev-server timer. Idempotent and safe to call when
   * nothing is due.
   */
  drainDue(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDrainReport>;

  /**
   * The deployed migration frontier for the modules registered on this host —
   * the number a scope's `schemaVersion` must reach to be current (§5.3, #49).
   * Sync like `registerModule`: it is code-time bookkeeping, not directory state.
   */
  migrationFrontier(): MigrationFrontier;

  /**
   * Attempt a scope's pending migrations NOW — the reconciliation sweep's wake +
   * retry affordance (§5.3, #49).
   *
   * Distinct from the lazy wake in three deliberate ways. It takes no principal
   * (this is fleet maintenance, the same class as `drainDue` — no actor, not
   * audited; the outcome lands in the directory's migration-state projection
   * either way). It returns a structured outcome instead of throwing, because
   * for a sweep a failed migration is state to report and back off from — the
   * request paths keep their rejection so operations still fail closed. And it
   * MUST defeat any per-instance memoisation of a failed attempt (the
   * Cloudflare ScopeDO caches its migration promise, so a plain re-wake would
   * return the cached rejection forever): a call here is always a fresh
   * attempt of whatever is still pending.
   *
   * Gates: the (tenantId, scopeId) pair is cross-checked and fails closed on a
   * mismatch (K-3). Allowed on `active` AND `provisioning` scopes — a scope
   * stuck in provisioning because its migration failed is precisely a sweep
   * target — refused for `suspended`/`archived`, which are deliberate states
   * the sweep must not disturb.
   */
  migrateScope(tenantId: TenantId, scopeId: ScopeId): Promise<MigrateScopeOutcome>;

  /**
   * Executor deliveries that exhausted their attempts, oldest first — the evidence a
   * dead-letter is a decision rather than a disappearance.
   */
  executorDeadLetters(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDeadLetter[]>;

  /**
   * The scope's PENDING platform intents (platform-intents.md) — rows a vertical enqueued via
   * `ctx.requestPlatform` awaiting the platform's drain. Fleet maintenance, no actor (the same
   * class as `drainDue`). The platform reads these, executes each with `HostAdmin` authority, and
   * journals the outcome via `settlePlatformRequest` — the read-here/effect-there executor shape.
   */
  listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]>;

  /**
   * Journal a platform-request outcome after the coordinator ran it: `done`, `failed` (terminal),
   * or `pending` (transient — retried on a later drain). `result` persists across retries (a
   * value written on an earlier pass survives an omitted one), carrying handler output such as a
   * minted sibling scope id for two-phase idempotency.
   */
  settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: { status: PlatformRequestStatus; result?: unknown; lastError?: string | null },
  ): Promise<void>;

  /** Bare operation registration (tests, glue). Names are module-namespaced: 'workorder/create'. */
  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void;

  close(): Promise<void>;
}
