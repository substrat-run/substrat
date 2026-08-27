import type {
  AdminAction,
  ListPage,
  Connection,
  ConnectionFilter,
  ConnectionId,
  ConnectionGrant,
  ConnectionGrantRecord,
  ConnectionSecret,
  CreateConnectionInput,
  OpenConnection,
  ProjectedConnectionGrant,
  ProjectedConnectionKey,
  AccessLogEntry,
  BindHostnameInput,
  AdminLogEntry,
  OpsFailureEntry,
  CapabilityGrant,
  CreateTenantInput,
  Decision,
  Instant,
  DomainEvent,
  DomainEventInput,
  PlatformRequestInput,
  PlatformRequestId,
  PlatformRequest,
  PlatformRequestFilter,
  PlatformRequestStatus,
  PlatformRequestFailure,
  EntitlementGrant,
  EntitlementGrantInput,
  EntitlementView,
  MeterReading,
  EntityRef,
  IdentityLink,
  IdentityPool,
  Impersonation,
  ImpersonationRequest,
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
  DirectoryDump,
  PrincipalId,
  ResolvedIdentity,
  RoleAssignment,
  RoleDefinition,
  QueryScopeInput,
  ReadScopeTableInput,
  Scope,
  ScopeDump,
  SubjectShredReceipt,
  ScopeQueryResult,
  ScopeId,
  ScopeStatus,
  ScopeTable,
  DenialFilter,
  DenialSummary,
  PermissionDenial,
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
  Page,
  CountedPage,
} from '@substrat-run/contracts';
import type { SealedSecret } from './secret-box.js';
import type { SearchHit, SearchOptions } from './search-index.js';
import type { EntityVersion } from './entity-version.js';

/**
 * What a caller asks a paged read for (#811).
 *
 * `filters` is a plain record because the DECLARATION is what constrains it: an
 * undeclared key is refused by `listQuery` rather than typed away here, so the
 * refusal names the column and lists the ones that exist — which a structural
 * type could not do for a hand-written manifest.
 */
export interface PageParams {
  /** Defaulted to `LIST_PAGE_DEFAULT` and capped at `LIST_PAGE_MAX` by `ctx.page`. */
  readonly limit?: number;
  /** One of the declared `sortable` columns. Defaults to the first. */
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly filters?: Readonly<Record<string, unknown>>;
  /** Also count the filtered set — the declaration's `total`, passed through. */
  readonly total?: boolean;
}

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
  /**
   * The staff session this invocation is running under (K-42, #868) — or `null`, which
   * is the ordinary case and what every operation should be written for.
   *
   * `ctx.principal` is who the operation is acting AS, and it is what every permission
   * check resolves against, so a handler needs to do nothing differently to be
   * impersonatable. This is the second actor: who is really at the keyboard.
   *
   * **Read-only, and read-only in two senses.** Module code cannot set it (it is stamped
   * by the door that minted the stub, like the event `actor`), and it cannot suppress it
   * — the same record lands on every event the session writes whether the handler looks
   * at it or not. What a vertical legitimately does with it is tell the truth on screen:
   * a "you are viewing as Anna, as Markus" banner, or a refusal of its own on the one
   * operation it considers off-limits even to a write-enabled session.
   *
   * ```ts
   * if (ctx.impersonation) return { ...view, viewingAs: ctx.impersonation.principal };
   * ```
   *
   * A read-only session (the default) has already refused `emit`, `requestPlatform`,
   * `grant`, `revoke` and `link` before a handler could reach this, so branching on
   * `readOnly` to decide whether to write is unnecessary — the kernel decided.
   */
  readonly impersonation: Impersonation | null;
  readonly sql: ScopedSql;
  /**
   * The operation's instant (#812) — the ONLY clock module code may read.
   *
   * Module code has no other one: `new Date()` and `Date.now()` are R6
   * violations, the same way `node:*` is an R2 one. Reaching for the wall clock
   * directly is how 95 call sites came to stamp rows the kernel could not see,
   * and how anything genuinely time-dependent — an absence window, a metering
   * period, a booking hold — became untestable except against real time.
   *
   * **Stable for the whole invocation.** Every call within one operation returns
   * the same instant, so two rows written in one transaction cannot disagree
   * about when they were written, and an event agrees with the row it describes.
   * That is a promise about the value, not an optimisation: it is what lets a
   * frozen clock make a scenario deterministic rather than merely slower.
   *
   * Read at the top of the operation, not lazily — the host stamps it when the
   * context is built, so the value is the instant the operation BEGAN, not the
   * instant a particular line ran.
   *
   * ```ts
   * const now = ctx.now();
   * ctx.sql.exec('INSERT INTO shop_carts (id, owner, created_at) VALUES (?, ?, ?)', [id, owner, now]);
   * ```
   *
   * Injectable host-side (`clock` on the host options, the same seam as `fetch`),
   * which is what a frozen-clock test and a deterministic replay both need.
   */
  now(): Instant;
  /** Envelope is stamped kernel-side (id, occurredAt, tenant, scope, actor); input is validated. */
  emit(event: DomainEventInput): void;
  /**
   * Enqueue a PLATFORM INTENT (docs/architecture/platform-intents.md) — how a sandbox-clean vertical asks
   * the platform to perform a privileged action (e.g. provision a sibling scope) without an upward
   * call. Writes a durable row into this scope's `_substrat_platform_requests` spine, atomic with
   * the operation; the platform pulls and executes it later, knowing the tenant inherently (it reads
   * this scope's DO). Call it AFTER the vertical's own permission check — authorization is the
   * vertical's, isolation is the platform's. Origin fields (id, requestedAt, requestedBy) are
   * stamped kernel-side; returns the new request id so the caller can report/track it. Throws if the
   * scope already holds `MAX_PENDING_PLATFORM_REQUESTS` pending intents (backpressure).
   */
  requestPlatform(request: PlatformRequestInput): PlatformRequestId;
  /**
   * Read back the intents THIS scope enqueued (#618) — the outcome half of `requestPlatform`.
   *
   * The write has always been a first-class kernel verb and the read was nothing: a vertical
   * could ask the platform to do something and then had no supported way to learn whether it
   * happened. Rule 3 permits a projection read of `_substrat_*`, but a hand-rolled `SELECT`
   * against the spine is a private schema a vertical should not be pinned to — this is the
   * stable shape, returning the same `PlatformRequest` the platform settles.
   *
   * The point is what an app can then TELL A USER: a contract whose signature request settled
   * `failed` can say so on its own screen, instead of showing a document that appears to be out
   * for signature and is not. Synchronous and scope-local (it is this scope's own table);
   * newest first, `limit` defaulting to `DEFAULT_PLATFORM_REQUEST_HISTORY_LIMIT`.
   *
   * Read-only by construction: the kernel owns every write to this table (rule 3 forbids module
   * code writing `_substrat_*`), so an intent's status is only ever the platform's answer.
   */
  platformRequests(filter?: PlatformRequestFilter): PlatformRequest[];
  /**
   * This entity's version (#901) — the ULID of the last event about it, or
   * `null` if nothing has ever been emitted about it.
   *
   * There is no version column anywhere, and there is deliberately not going to
   * be one: `_substrat_outbox` has recorded `entity_type` and `entity_id`
   * against a monotonic ULID since it was written, so every mutation that
   * followed the fat-event rule already versioned the thing it touched. See
   * `entity-version.ts` for why the alternative — a `_version` column bumped by
   * an emitted trigger — was rejected despite working.
   *
   * ```ts
   * const before = ctx.versionOf({ entityType: 'customer', entityId: id });
   * // …mutate, emit…
   * ctx.versionOf({ entityType: 'customer', entityId: id }) !== before  // true
   * ```
   *
   * **Conservative, by construction.** ANY event about the entity moves this,
   * including one that changed nothing the caller read. A precondition built on
   * it can refuse a write that would have been safe; it cannot admit one that
   * would not. That is the correct direction to fail, and it is a real
   * difference from a per-row counter.
   *
   * Rule 3 permits a projection read of `_substrat_*`, so a vertical *could*
   * hand-roll this `SELECT`. It should not: the spine's schema is private and a
   * vertical pinned to it is pinned to a table the kernel may re-shape. Same
   * reasoning as `platformRequests`.
   *
   * **Checks no permission** — nothing on `ctx` does. A version is not a read of
   * the entity, but it is evidence the entity exists, so an operation that hands
   * one to an untrusted caller does its own `assertAllowed` first.
   */
  versionOf(entity: EntityRef): EntityVersion | null;
  /** Node-level check; pass `entity` for per-entity checks (portal access, §4.2 rule 3). */
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
  /**
   * Find entities of one type by what a person typed (#827) — the read a picker
   * over 40 000 customers needs and `ctx.sql` cannot express without every
   * vertical hand-rolling an index.
   *
   * Answers from the FTS5 index the kernel derives from `manifest.searchables`,
   * maintained by triggers, so it sees a row the same transaction wrote. Returns
   * **ids and ranks only** — the row shape is the module's own, so hydrate the
   * hits through the read path that already exists rather than growing a second
   * answer to "what is a customer".
   *
   * ```ts
   * const hits = ctx.search('customer', term, { limit: 10 });
   * const rows = ctx.sql.query(
   *   `SELECT * FROM callout_customers WHERE id IN (${hits.map(() => '?').join(',')})`,
   *   hits.map((h) => h.id),
   * );
   * ```
   *
   * **This does not check permission** — nothing on `ctx` does. The operation's
   * own `assertAllowed` still comes first, and an entity-narrowed vertical has to
   * filter the hits it hydrates: a ranked top-N filtered afterwards returns FEWER
   * than N, so over-fetch deliberately rather than discovering it at a customer
   * whose picker looks half-empty.
   *
   * Throws `SearchTermTooShort` for a term below the index's floor and
   * `NotSearchable` for an entity type no module declared — never an empty array
   * standing in for a misconfiguration.
   */
  search(entityType: string, term: string, options?: SearchOptions): SearchHit[];
  /**
   * Read one PAGE of a declared entity (#811, K-18) — the kernel-composed half of
   * a paged read.
   *
   * Composes the `WHERE` from the operation's declared `filterable` columns, the
   * `ORDER BY` from the caller's choice among `sortable`, the keyset comparison,
   * the `LIMIT`, and — when the declaration asks for a total — the `COUNT` over
   * that same `WHERE`. It reads the indexes it also provisioned, so a declared
   * filter is an indexed one rather than a table scan waiting for a big tenant.
   *
   * Returns **rows**, wrapped in a page. The projection stays the module's: map
   * with `mapPage` to keep the cursor and total while re-shaping the entries.
   *
   * ```ts
   * const page = ctx.page<OrderRow>('workorder', {
   *   limit, cursor: input.cursor, sort: input.sort, filters: { status: input.status },
   * });
   * return mapPage(page, toWorkOrder);
   * ```
   *
   * **This does not check permission** — nothing on `ctx` does, and a paged read
   * is not an exception. The operation's own `assertAllowed` still comes first.
   * A read that filters per ROW after the fact (a portal walk) cannot use this at
   * all: a page of 20 filtered down to 3 is not a page, and the honest shape is an
   * over-fetch loop the handler owns.
   *
   * Throws `NotListable` for an entity no operation declared `paged.over` on,
   * `SortNotDeclared` for a `?sort=` outside the vocabulary, and
   * `FilterNotDeclared` for a filter outside it — never a silently-ignored
   * parameter, which is how a caller comes to believe a filter is applied.
   */
  page<T>(entityType: string, params: PageParams): Page<T> | CountedPage<T>;
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
   * Seal a value TO a connector, so it can ride the spine without being IN the
   * spine (#687, design/signature-contact-carrier.md Option E).
   *
   * The problem this solves is narrow and had no other answer. A vertical
   * sometimes has to hand a connector something the platform must not keep — how
   * a signatory is reached, so a document that starts has somebody to go to —
   * and every channel from a scope to a connector is a spine row: the outbox,
   * the platform-request payload. Both are kernel rows a vertical may neither
   * write nor erase (rule 3), so anything a hosted vertical emits in plaintext
   * stays plaintext in copies it cannot reach. Encrypting in-scope does not help
   * by itself — a symmetric key would have to travel the same rows as the value.
   *
   * What works is that the CONNECTION holds a keypair whose public half is
   * projected down. Seal here, put the cell on the event, and the connector opens
   * it at egress with a private half that never left the directory. Nothing
   * re-enters the scope actor, so the fat-event rule survives intact: the
   * consumer still needs no cross-module read, it just cannot read one field.
   *
   * `provider` is what module code knows ('scrive'), never a connection id —
   * connection identity is the host's business, and an engine that learned it
   * would be naming infrastructure it is not allowed to see.
   *
   * **Fails closed and legibly.** Throws `ConnectionSealingKeyUnavailableError`
   * when no key for that provider has been projected into this scope. Returning
   * an unsealed value, or silently dropping the field, would emit a request that
   * reaches nobody — which is exactly the invisible failure this carrier exists
   * to end (§7 point 2).
   *
   * Awaiting this BEFORE `ctx.emit` is what keeps `emit` synchronous: an
   * operation is `async`, Web Crypto is not, and D-28 stays untouched.
   */
  sealToConnection(provider: string, plaintext: string): Promise<SealedSecret>;
  /**
   * Record a relation tuple child→parent (K-16) — the write path for the
   * permission evaluator's entity-edge rule (design doc §4.2 rule 3). The
   * relation must be declared in some registered module's `entityRelations`.
   * Idempotent.
   */
  link(child: EntityRef, parent: EntityRef): void;
  /**
   * Narrow a permission the CALLER ALREADY HOLDS onto one entity — how an app
   * expresses user-initiated sharing.
   *
   * Every entity-narrowed grant in the fleet used to be made at seed time
   * through `HostAdmin.grant`, which is a platform actor's verb. An app where a
   * person shares their own record with someone therefore had no supported
   * mechanism: the alternative is a membership table consulted by hand in every
   * handler, which is the forgotten-WHERE-clause failure this platform exists to
   * remove.
   *
   * Non-escalating by construction:
   *
   * - `entity` is REQUIRED — module code can never write a scope- or
   *   tenant-wide grant, only narrow one onto a thing.
   * - The caller's own decision on that entity is re-checked, so an operation
   *   can only hand out what it was itself given. Delegation, never elevation.
   *
   * Transactional with the operation: a grant made by an operation that then
   * throws never happened, the same as its rows and its events.
   */
  grant(principal: PrincipalId, permission: PermissionKey, entity: EntityRef): Promise<void>;
  /** Withdraw a grant this caller could have made. Same guardrails. */
  revoke(principal: PrincipalId, permission: PermissionKey, entity: EntityRef): Promise<void>;
  /**
   * Run `fn` as a SUB-TRANSACTION of this operation (#770,
   * docs/rfc/sub-transactions.md) — the boundary that makes catching an
   * engine error safe.
   *
   * A vertical composes engine in-scope functions inside one scope transaction,
   * and without this the adapter rolls back only when the whole handler throws.
   * So a vertical that did the reasonable thing — catch a `completeWorkOrder`
   * failure, fall back to a manual path — committed the engine's partial writes,
   * which are exactly the ones its invariants were protecting.
   *
   * Inside `atomic`, a throw discards everything `fn` wrote — rows, events,
   * links, grants and platform intents alike — and the ORIGINAL error is
   * rethrown unwrapped. The caller's own writes, before and after, survive, and
   * the operation still commits once.
   *
   * Two things it deliberately does not promise:
   *
   * - **The commit is provisional.** If the operation later throws, a succeeded
   *   `atomic`'s writes are discarded with everything else. This narrows what a
   *   CAUGHT error destroys; it never promotes writes past the operation's own
   *   commit.
   * - **Not every storage failure is recoverable.** Ordinary constraint
   *   violations are; conditions that abort the enclosing transaction outright
   *   (`SQLITE_FULL`, `SQLITE_BUSY`, an explicit `ON CONFLICT ROLLBACK`) are not.
   *
   * Nests. Sub-transactions must not INTERLEAVE, though — starting two
   * concurrently (`Promise.all`) throws rather than crossing savepoint frames.
   *
   * Outside `ctx.atomic`, catching an engine error remains forbidden: the writes
   * are still there, and on a host whose transactions poison on error (Postgres)
   * the operation is already unrecoverable.
   */
  atomic<T>(fn: () => T | Promise<T>): Promise<T>;
}

export type OperationHandler<I = unknown, O = unknown> = (
  ctx: OperationContext,
  input: I,
) => O | Promise<O>;

/**
 * The per-invocation transport channel: what the caller requires to be true
 * before the operation runs, and the transport facts it needs back (#129, #116).
 *
 * A separate parameter rather than fields on the input, because these are facts
 * about the REQUEST and not about the domain. A handler's declared input is what
 * the operation MEANS, and threading a retry token or an entity tag through it
 * would make every in-process caller state something it does not have.
 * `mountOperations` reads them off headers; a test, a seed or a schedule omits
 * them entirely.
 *
 * Per INVOCATION rather than on `ScopeStubOptions`, where `onPlatformRequests`
 * lives, and the difference is not stylistic. A stub is minted by the vertical's
 * own `resolveStub`, so anything hung off it requires that vertical to cooperate;
 * `If-Match` and the `ETag` are wholly the mount's business and must work with no
 * change to a vertical at all. They are also genuinely per-call — one stub serves
 * one request, but nothing in the contract says so.
 *
 * Deliberately one bag rather than a parameter per concern. `If-Match` and
 * `Idempotency-Key` are ONE precondition pass at one point in the invoke — before
 * the guards, inside the transaction — which is what #116's note asked of
 * whichever landed first. #129 built the bag; #116 declared into it and added no
 * second interception point.
 */
export interface InvokeOptions {
  /**
   * The version the caller believes it is writing over, verbatim from `If-Match`
   * (quoted, and possibly a list — `ifMatchAdmits` owns the parsing).
   *
   * Honoured only by an operation that DECLARES `concurrency`. Sending it to one
   * that does not is an error rather than a no-op: a caller who believes it is
   * protected and is not is the failure this whole mechanism exists to prevent,
   * and silence is exactly how that belief survives.
   */
  readonly ifMatch?: string;
  /**
   * Called after a guarded operation COMMITS, with the entity's version as it
   * stands at commit — the `ETag` the transport hands back.
   *
   * Read after the handler and inside the same transaction, so the tag describes
   * the row as the caller's own write left it rather than as the caller found it.
   * A client that echoed back what it sent would loop on its own stale value.
   *
   * Never called for a rolled-back operation, and never for an operation that
   * declares no `concurrency`: a version that did not survive its transaction is
   * not a tag anyone may hold, and an operation that opted out must not pay for a
   * spine read on every invocation.
   */
  readonly onEntityVersion?: (version: string | null) => void;
  /**
   * The client's retry token, verbatim from `Idempotency-Key` (#116).
   *
   * Honoured by every operation on an unsafe method — there is no declaration to
   * make, because a retried write creating a second entity is a hazard on all of
   * them. The exception is an operation that declared `idempotency: false`, whose
   * response must not be recorded; sending a key to one is an error rather than a
   * no-op, for the same reason an unhonoured `If-Match` is.
   *
   * A first request under a key runs, and its return value is recorded inside the
   * operation's own transaction. A second request under the same key returns that
   * recording without running the handler. A second request under the same key
   * with a DIFFERENT input is refused — a key names one request, and serving the
   * first one's response to a second one would be a lie a client acts on.
   */
  readonly idempotencyKey?: string;
  /**
   * Called when this invocation was answered from a recording rather than run.
   *
   * The transport sets `Idempotency-Replayed` from it. Advisory: a caller that
   * ignores this is not wrong about anything, it simply cannot tell a retry from
   * a first request — which is enough of a debugging cost to be worth a callback.
   */
  readonly onIdempotentReplay?: () => void;
}

/** The capability stub — the ONLY way code outside the scope reaches it. */
export interface ScopeStub {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  invoke<O = unknown, I = unknown>(
    operation: string,
    input?: I,
    options?: InvokeOptions,
  ): Promise<O>;
}

/**
 * A stub whose authority is a principal, held by somebody who is not them (K-42, #868).
 *
 * An ordinary `ScopeStub` in every way that matters — same `invoke`, same serialization,
 * same permission path — plus the session record, so the caller that opened it can show
 * a countdown, refuse to reuse a dead one, and report what it opened. The record is the
 * KERNEL's (`stampImpersonation`), not the caller's: `expiresAt` here is the same value
 * `assertImpersonationLive` enforces on every invoke, so a console rendering it is
 * rendering the truth rather than its own guess at it.
 */
export interface ImpersonatedScope extends ScopeStub {
  readonly impersonation: Impersonation;
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
  /**
   * Connector deliveries a CP-less host turned into `connector:<provider>` platform
   * intents instead of running (#574 phase 3). Counted separately from `delivered`
   * because the effect has not happened yet — the platform's drain owns it now. A
   * harness treats a non-zero count like `ScopeStubOptions.onPlatformRequests`: flag
   * the response so the router kicks an immediate drain.
   */
  routedToPlatform?: number;
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

/**
 * The host's clock (#812) — what `ctx.now()` reads.
 *
 * Injectable for the same reason `FetchLike` is: the thing outside the process
 * that a test cannot otherwise control. A host given no clock reads the wall
 * clock, which is every production path; a test hands in a frozen or scripted
 * one and gets a scenario that asserts the interesting case instead of avoiding
 * it.
 *
 * Returns an `Instant` rather than a number so there is exactly one timestamp
 * format on the way in, and the host never has to guess whether it was handed
 * seconds or milliseconds.
 */
export interface Clock {
  (): Instant;
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
 * A connection opened INSIDE a dispatch (#711) — `ctx.connection(provider)`.
 *
 * Strictly more than a `ConnectorConnection`, and the difference is a scope. A
 * dispatch happens *for* one scope, which is ambient in the context, so a
 * connection opened there can reach that scope's attachments. A connection
 * reopened top-level — a probe of a candidate credential, a poll driver
 * rebuilding egress from the directory — has no such scope, and the type says so
 * rather than handing out a method that would have to throw.
 */
export interface ScopedConnectorConnection extends ConnectorConnection {
  /**
   * Read ONE attachment's bytes from the scope this delivery is for (#711) — the
   * outbound mirror of `getConnectorAttachments`, which is the return path's door.
   *
   * A signing connector sends a document. Until this existed it could only send a
   * document it RENDERED ITSELF, because `create` had no way to be handed the
   * vertical's own file: the bytes were in the attachment store, and the store was
   * unreachable from inside a dispatch. So a Swedish counterparty was asked to sign
   * a page of identifiers with BankID rather than the contract.
   *
   * **On the connection, for the same reason `fetch` is.** The read is authorized as
   * a connection, and the only connection it can correctly be authorized as is the
   * one the handler opened — this object. An ambient "the provider this connector is
   * registered under" would be a second name for the same thing, and two names for
   * one fact is how they come to disagree: `registerScriveConnector({ id: 'scrive-eu' })`
   * opens its credential as `'scrive'` and would have read as `'scrive-eu'`, so the
   * egress half kept working while the document half failed on every contract.
   * Handing the door to whoever holds the credential makes that unrepresentable.
   *
   * **Why not `getConnectorAttachments` from in here.** On the pure adapter a
   * connector runs INSIDE the scope's actor task, and every verb of that surface
   * re-enqueues on the same actor — the nested task waits on the task holding it,
   * and the invoke never returns. (Pinned in `connector-reads.test.ts`.) The adapter
   * builds this read to suit where it is running: reentrant when the caller already
   * holds the actor, ordinary and serialized when it does not.
   *
   * **Reads only, and only by id.** No `list`, deliberately. A connector that
   * SEARCHES for the document to send has to have a rule for picking among several
   * — and the return path lands the sealed signed copy on the same entity, so a
   * wrong rule mails the counterparty their own signed contract to sign again.
   * Naming the id makes that unrepresentable: the caller says which bytes, the
   * event carries it, and nothing has to be disambiguated. Writes stay top-level
   * (`getConnectorAttachments().upload`), where a spine event and its consumers
   * have a transaction to live in.
   *
   * Gated by the target's `readPermission` checked against this connection's
   * `connection:<id>` grants. `null` for an id the scope does not know — a caller
   * falls back rather than failing a dispatch over a missing file.
   */
  openAttachment(attachmentId: string): Promise<OpenedAttachment | null>;
  /**
   * What this connection may do in the scope this delivery is for (#726 gap 1) —
   * `connectionGrantsInScope`, narrowed to this connection.
   *
   * Here so a connector can check its own preconditions at the top of a dispatch and
   * fail saying which grant is missing, instead of discovering it three calls later as
   * a refusal the drain then captions as the provider's (#841). A connector that needs
   * a standing grant for its RETURN path — where there is no delivered event to carry
   * authority — can say so on the way out, which is the only moment it is cheap to fix.
   *
   * Deliberately the permission keys and nothing else: a connector asks whether it may
   * act, never who granted it or when. Both are the operator's question, and both are
   * on the drawer that already renders them.
   */
  grants(): Promise<PermissionKey[]>;
  /**
   * Open a cell the scope sealed TO this connection (#687) — the egress half of
   * `ctx.sealToConnection`.
   *
   * **Here rather than on `ConnectorConnection`, and the probe path is why.** A
   * connection rebuilt top-level may have no directory row at all — the credential
   * probe builds one from a candidate secret and a zero id — so it holds no
   * keypair and could only ever throw. A sealed cell arrives on a delivered event,
   * which is to say inside a dispatch, which is exactly the shape that has one.
   *
   * **On the connection, for the same reason `fetch` and `openAttachment` are.**
   * The private half belongs to one connection, and the only connection it can
   * correctly be is the one this handler opened. An ambient `ctx.unseal` would
   * have to guess, and it would guess wrong the first time a tenant held two
   * credentials for one provider.
   *
   * Key material never crosses this seam: the adapter holds the keyId-indexed map
   * and picks by the cell's own `keyId`, so a connector cannot mislay a private
   * key it never had. Throws `SealedKeyUnavailableError` when the named key is not
   * held — which after a rotation-as-erasure (D-5) is the correct and permanent
   * answer, not a mystery. A scope restored from backup can resurrect a pending
   * request whose key is gone, and that delivery should dead-letter saying so.
   */
  unseal(sealed: SealedSecret): Promise<string>;
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
  connection(provider: string): Promise<ScopedConnectorConnection>;
}

export type ConnectorHandler = (ctx: ConnectorContext, event: DomainEvent) => void | Promise<void>;

/** Tuning for one connector's egress. */
export interface ConnectorOptions extends ExecutorRetryPolicy {
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /**
   * The provider slug this connector operates (#574 phase 3) — the routing key a
   * CP-less host uses when it cannot run the handler itself: the delivery becomes a
   * `connector:<provider>` platform intent, and the platform's drain dispatches it to
   * the handler registered for that same slug. Defaults to the registration id, which
   * for the shipped connectors is already the provider name ('scrive'). Irrelevant on
   * a host that reaches the connection directory (self-host, the control plane): there
   * the handler runs in-process and this key is never consulted.
   */
  provider?: string;
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

/**
 * What an engine exports so a VERTICAL can consume its events with types (#696):
 * event type → payload shape, plus any sets of events that report the same fact
 * by different routes.
 *
 * ```ts
 * export type ProtocolEvents = {
 *   events: {
 *     'protocol.signed': ProtocolSignedPayload;
 *     'protocol.countersigned': ProtocolCountersignedPayload;
 *   };
 *   completionGroups: { signature: 'protocol.signed' | 'protocol.countersigned' };
 * };
 * ```
 *
 * TYPES ONLY — nothing here exists at runtime. The runtime contract is still the
 * fat payload and **the consumer's own Zod parse**: importing a producer's
 * validator is what turns version skew into a crash instead of a tolerated
 * absence. These types are for the compiler, not the boundary.
 *
 * VERTICAL-FACING ONLY. An engine consuming a sibling's event must NOT reach for
 * this — R1 (star topology) forbids the import, and the defensive parse is what
 * lets it ride out #128's dual-emit window. `engine-invoicing` consuming
 * `workorder.completed` with its own Zod view is the correct shape and stays so.
 */
export type EventContract = {
  readonly events: Record<string, unknown>;
  /**
   * group name → the union of event types in it. A consumer that handles one
   * member must handle all: completion often rides on whichever event happens
   * to arrive LAST, so handling a subset silently strands the entity.
   */
  readonly completionGroups?: Record<string, string>;
};

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;

type AllEvents<C extends readonly EventContract[]> = UnionToIntersection<C[number]['events']>;

/** Every event type the declared engines emit. */
export type EventTypeOf<C extends readonly EventContract[]> = keyof AllEvents<C> & string;

/** The payload an engine declares for one of its event types. */
export type EventPayloadOf<C extends readonly EventContract[], K extends EventTypeOf<C>> = AllEvents<C>[K];

/**
 * A consumer whose `event.payload` is the producer's declared shape rather than
 * `unknown`. Same two-argument signature as `ConsumerHandler`, so this is purely
 * a narrowing.
 */
export type TypedConsumerHandler<P> = (
  ctx: OperationContext,
  event: Omit<DomainEvent, 'payload'> & { payload: P },
) => void | Promise<void>;

type AllGroups<C extends readonly EventContract[]> = UnionToIntersection<
  Extract<C[number], { completionGroups: Record<string, string> }>['completionGroups']
>;

/**
 * Every member of any completion group already partly handled.
 * The `[…] extends [never]` bracketing is load-bearing — a naked `extends never`
 * distributes and silently yields `never` for every group, disabling the check.
 */
type RequiredCompanions<C extends readonly EventContract[], Handled extends string> = {
  [G in keyof AllGroups<C>]: [Extract<AllGroups<C>[G] & string, Handled>] extends [never]
    ? never
    : AllGroups<C>[G] & string;
}[keyof AllGroups<C>];

type MissingCompanions<C extends readonly EventContract[], Handled extends string> = Exclude<
  RequiredCompanions<C, Handled>,
  Handled
>;

/**
 * `unknown` when every completion group is fully handled; otherwise DEMANDS the
 * missing members, so the compiler names the event that was missed.
 */
type Completeness<C extends readonly EventContract[], Handled extends string> = [
  MissingCompanions<C, Handled>,
] extends [never]
  ? unknown
  : { readonly [M in MissingCompanions<C, Handled>]: TypedConsumerHandler<never> };

/** eventType → typed handler, for the engines a vertical declares. */
export type TypedConsumers<C extends readonly EventContract[]> = {
  readonly [K in EventTypeOf<C>]?: TypedConsumerHandler<EventPayloadOf<C, K>>;
};

/**
 * The consumer map, typed against the engines a module composes (#696).
 *
 * With no declared engines this is exactly what it always was — an untyped
 * `Record<string, ConsumerHandler>` — so every existing module keeps compiling
 * unchanged. Declare engines and three things become compile errors: an event
 * type no declared engine emits, a payload field the producer does not send,
 * and a completion group handled only in part.
 */
export type ConsumersOf<C extends readonly EventContract[]> = [C] extends [readonly []]
  ? Record<string, ConsumerHandler>
  : TypedConsumers<C>;

/**
 * Inference site for the completeness check.
 *
 * `ModuleRegistration` is an interface, so it cannot see WHICH event keys a
 * module wrote — and completeness is a question about exactly that. This helper
 * captures them:
 *
 * ```ts
 * consumers: consumersFor<[ProtocolEvents]>()({
 *   'protocol.signed': async (ctx, event) => { … },
 *   'protocol.countersigned': async (ctx, event) => { … },
 * })
 * ```
 *
 * Omit the second and it does not compile: *Property '"protocol.countersigned"'
 * is missing*.
 */
type ConsumerMap<C extends readonly EventContract[], H> = {
  readonly [K in keyof H]: K extends EventTypeOf<C> ? TypedConsumerHandler<EventPayloadOf<C, K>> : never;
};

export function consumersFor<const C extends readonly EventContract[]>() {
  return <const H extends ConsumerMap<C, H>>(handlers: H & Completeness<C, keyof H & string>): H => handlers;
}

export interface ModuleRegistration<C extends readonly EventContract[] = []> {
  manifest: ModuleManifest;
  migrations?: SqlMigration[];
  operations?: Record<string, OperationHandler<never, unknown>>;
  /**
   * name → the schema the host parses an invocation's input against, BEFORE the
   * guards and the handler see it (#893).
   *
   * Derived from the declared operation surface — `operationInputsOf(ops)` — and
   * never written a second time. A module that declares its operations gets the
   * parse by handing the same object over:
   *
   * ```ts
   * operations: { 'rally/book': bookOp, … },
   * operationInputs: operationInputsOf(rallyOperations),
   * ```
   *
   * **This is where "parse, don't trust" is kept, rather than in 85 handlers.**
   * `OperationShape.input` calls itself *"the SAME Zod object the handler
   * parses"* and across the fleet it mostly was not — rally declared 32 inputs
   * and parsed 2. One place that cannot be forgotten beats a rule every new
   * operation has to remember, which is the same argument `mountOperations`
   * already makes for the page trio.
   *
   * A name here that no operation binds is an error: it is a schema enforcing
   * nothing, and it reads as coverage. A bound operation with no entry is
   * allowed and means what it always meant — nothing was declared to parse.
   *
   * Typed structurally rather than as `z.ZodType` so the kernel keeps its single
   * dependency and no zod version is pinned by the scope-host contract. The
   * shape is the whole surface the host uses: throw to refuse, return the value
   * to accept.
   */
  operationInputs?: Record<string, { parse(value: unknown): unknown }>;
  /**
   * name → the entity whose version this operation's `If-Match` is compared
   * against, and the input field carrying its id (#129).
   *
   * Derived from the declared operation surface — `operationConcurrencyOf(ops)` —
   * and never written a second time, exactly as `operationInputs` is:
   *
   * ```ts
   * operations: { 'callout/update-customer': updateCustomerOp, … },
   * operationInputs: operationInputsOf(calloutOperations),
   * operationConcurrency: operationConcurrencyOf(calloutOperations),
   * ```
   *
   * **The host compares, not the handler.** A precondition a handler evaluates is
   * a precondition a handler can forget, and the one that is forgotten is
   * indistinguishable from one that passed. Here the comparison happens between
   * `BEGIN` and the guards for every caller and every transport, or the operation
   * does not claim to have it.
   *
   * A name here that no operation binds is an error, for the same reason it is on
   * `operationInputs`: it reads as coverage while enforcing nothing.
   */
  operationConcurrency?: Record<string, { entity: string; idFrom: string }>;
  /**
   * The operations that declared `idempotency: false` (#116) — the ones whose
   * response must not be recorded, and which therefore refuse an
   * `Idempotency-Key` instead of honouring it.
   *
   * Derived like the two above, and never written a second time:
   *
   * ```ts
   * operationIdempotencyOptOuts: operationIdempotencyOptOutsOf(calloutOperations),
   * ```
   *
   * A list of refusals rather than a list of participants, because that is what
   * the declaration is. Absent means every operation honours a key, which is the
   * default and the reason there is nothing to remember.
   */
  operationIdempotencyOptOuts?: readonly string[];
  /**
   * eventType → handler; the types must appear in manifest.events.consumes.
   *
   * Untyped by default. A vertical that declares the engines it composes —
   * `ModuleRegistration<[ProtocolEvents]>` — gets typed payloads, rejection of
   * event types nobody emits, and (via `consumersFor`) rejection of a
   * half-handled completion group. See `EventContract` (#696).
   */
  consumers?: ConsumersOf<C>;
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
   * The tenant's connection grants as the DIRECTORY records them (#592) — what
   * `grantToConnection` wrote alongside each enforcement tuple. This is the gather
   * source for provision/reconcile delivery (the platform materializes tenant-wide
   * rows per scope, the same authoritative channel as `listEntitlements` /
   * `listIdentityLinks`), and the readable answer to "what may this connection
   * invoke". Returns LIVE rows only — a grant whose connection was revoked is
   * tombstoned by the revoke cascade and absent here.
   */
  listConnectionGrants(actor: PlatformActorId, tenantId: TenantId): Promise<ConnectionGrantRecord[]>;
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
   * One version by id — the read almost every caller actually wanted.
   *
   * Before this existed, "the version with this id" was spelled as an unpaginated
   * `listVersions(slug)` followed by `.find()`: every version a vertical had ever
   * published, each carrying its stored manifest, pulled across the adapter boundary to
   * keep one. That cost grows once per push and lands on the paths least able to afford
   * it — the deploy handler's own read-back, and the router's per-request resolution of
   * which script serves a scope.
   *
   * `verticalSlug` preserves what the old `.find()`-inside-a-slug's-list spelling gave
   * for free: pass it and a version belonging to a DIFFERENT vertical reads as absent
   * rather than being returned across the lineage boundary. Fail closed, like `getScope`.
   */
  getVersion(
    actor: PlatformActorId,
    versionId: string,
    verticalSlug?: string,
  ): Promise<VerticalVersion | undefined>;

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
   * Grant (or revoke) the EMAIL-SENDER capability (#303) — whether this vertical's
   * scopes may POST to the control plane's `/internal/email/send` relay and have
   * transactional mail (password-reset, verification, invites) sent on their behalf.
   * A directory-backed staff grant rather than deployment config: outbound is a
   * platform concern (a hosted dispatch script cannot bind `send_email` and the §4
   * sandbox refuses it), so the platform holds the Email Sending credential and this
   * flag decides who the relay will send for. Read by the relay handler on every send;
   * flipping it never touches running scopes. Staff-only, idempotent, audited.
   */
  setVerticalEmailSender(actor: PlatformActorId, slug: string, granted: boolean): Promise<void>;

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
   * Move a fork's GC deadline (preview-and-snapshots.md §9). The reap sweep deletes any
   * fork whose `expiresAt` has passed, so a long-lived preview reused across many CI
   * pushes must have its deadline pushed forward on each reuse — otherwise it dies 72h
   * after its FIRST creation regardless of activity. `null` pins the fork until it is
   * deliberately deleted (the "absent = pinned" the snapshot body already models). Audited.
   */
  setScopeExpiresAt(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    expiresAt: string | null,
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
  /**
   * Ordered by hostname; the cursor is a hostname.
   *
   * `verticalSlug` narrows to the bindings of one vertical. It exists because the
   * alternative callers reached for was reading the WHOLE fleet's bindings and
   * filtering in JS — which makes an unrelated tenant's hostname row part of the
   * blast radius of a question about your own, and grows without bound as the fleet
   * does. A caller that wants one vertical's hostnames asks for them.
   */
  listHostnames(
    actor: PlatformActorId,
    filter?: {
      tenantId?: TenantId;
      scopeId?: ScopeId;
      status?: HostnameStatus;
      verticalSlug?: string;
    } & ListPage,
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
   * preview/snapshot primitive (docs/architecture/preview-and-snapshots.md §3): the source a
   * fork copies into a new scope, or a governed `substrat scope pull` writes to a file.
   *
   * Unlike `readScopeTable` — bounded and blob-as-null, deliberately NOT a dump — this
   * exfiltrates the whole scope, so it is the more privileged read: same `PlatformActorId`
   * and K-24 access log, same (tenantId, scopeId) K-3 cross-check that fails closed on a
   * mismatch. It drops only SQLite's own `sqlite_*` internals (auto-managed, un-recreatable);
   * the spine is kept because a fork must carry the event/migration state to be faithful.
   */
  exportScope(actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeDump>;

  // -- the denial log (K-35, #867) -------------------------------------------
  // The third of the platform's three logs, and the last to get a reader. The admin
  // log holds staff MUTATIONS and the K-24 access log staff READS; these are the
  // refusals — every enforced `assertAllowed` that threw, recorded in the scope's own
  // database because a denial rolls its operation back and so cannot be written inside
  // the transaction it is evidence of.
  //
  // Read like any other `HostAdmin` surface: a `PlatformActorId`, a K-24 access-log
  // entry, and the (tenantId, scopeId) K-3 cross-check that fails closed on a mismatch.
  // The §7 bound holds unchanged — directory metadata and denial rows, never tenant
  // business data.
  //
  // Two reads rather than one, because K-35 named the reason up front: the volume is
  // attacker-influenceable, so the raw list alone is a surface a prober can flood off
  // the screen. `summarizeDenials` is the view that survives that, and it is also where
  // the window's own floor is reported — these rows drain rather than expire, so what
  // is held is a storage bound and not a retention promise.

  /**
   * A bounded page of raw denial rows, newest first. Narrow with `actor` (who was
   * refused), `permission` (which key), `operation`, and a `since`/`until` window.
   */
  listDenials(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: DenialFilter,
  ): Promise<PermissionDenial[]>;

  /**
   * The same log bucketed per (actor, permission) — K-35's "first occurrence + count
   * per actor/key/window" — busiest first, with the filtered totals and the unfiltered
   * window facts beside them. This is the view an operator opens first: "who has been
   * probing for access they don't hold" is a question about counts, not about rows.
   */
  summarizeDenials(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: DenialFilter,
  ): Promise<DenialSummary>;

  // -- directory disaster recovery (control-plane.md §4.9, #40) ---------------
  // Every method above reads or writes ONE tenant's world. These two are the only
  // pair whose subject is the platform's own database — the mapping that makes all
  // the others addressable, and the one thing no per-scope recovery can rebuild.

  /**
   * A COMPLETE dump of the directory itself: tenants, scopes, hostnames, verticals,
   * entitlements, identities, and the audit spine. The platform-level analogue of
   * `exportScope`, and audited the same way (K-24 access log) — it exfiltrates every
   * tenant at once, so it is the single most privileged read a host offers.
   *
   * Deliberately NOT a substitute for per-scope PITR, which is better at what it does
   * (~30 days, continuous, per scope). This answers the different question: the
   * directory is one Durable Object, and if it is deleted or corrupted outright there
   * is nothing to point PITR at. See `restoreDirectory` for the write half.
   */
  exportDirectory(actor: PlatformActorId): Promise<DirectoryDump>;

  /**
   * Replace the directory with a dump — break-glass, and the only write in `HostAdmin`
   * whose blast radius is every tenant at once.
   *
   * It is a REPLACE, not a merge: the dump's contents become the directory, and
   * anything created since the copy was taken is gone. That is the honest semantic for
   * a recovery (a merge would silently interleave two histories of the same tenant),
   * and it is why the route in front of this refuses a directory that still has
   * tenants unless the caller explicitly says to overwrite.
   *
   * Audited as `restoreDirectory` in the admin log that the restore itself just
   * replaced — so the first entry after a restored history is the restore.
   */
  restoreDirectory(actor: PlatformActorId, dump: DirectoryDump): Promise<void>;

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
   *
   * Refuses (fail closed) while the scope still holds a bound hostname — a serving app
   * always does, so the wipe cannot land on one that is still online; unbind it first.
   * `force` is the deliberate-teardown bypass (tenant reap §4.8, retention sweeps §4.4),
   * where releasing every name is the point; interactive per-scope reap never sets it.
   *
   * `backupRef` names the recoverable copy the caller stored before calling (#493) and is
   * carried into the admin-log entry. The reap itself neither takes nor verifies the
   * backup: taking it needs the scope's BYTES, which for a hosted scope live in the
   * vertical's own deployment and are only reachable above this seam — the same reason
   * the byte-wipe is orchestrated by the caller. What this parameter buys is that the
   * audit trail answers "was there a copy, and where" from the reap entry itself, instead
   * of an operator correlating two timestamps. Absent ⇒ no copy was taken.
   */
  reapScope(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    opts?: { force?: boolean; backupRef?: string },
  ): Promise<void>;

  // -- subject erasure (#37, master-plan §5.3) --------------------------------
  // `piiClass` has been enforced at the type level since the contracts package existed —
  // an event that carries PII cannot be declared without a `subjectId`, on the stated
  // grounds that "crypto-shredding must be able to key the erasure". These three methods
  // are that erasure. They divide the problem the way the STORES divide:
  //
  //   Tier 1 is mutable, so erasing there is redaction — an UPDATE that nulls the payload
  //   and keeps the envelope (the pseudonymous key and the fact that something happened
  //   at a time, which §5.3 keeps deliberately).
  //
  //   A platform-retained COPY is not mutable — a backup we cannot rewrite is the whole
  //   point of having it — so erasing there is cryptographic: the copy was sealed under a
  //   per-subject key at the moment it left, and destroying that key is what reaches
  //   backwards into every copy already taken.
  //
  // The keys live in the DIRECTORY, never in the scope database whose rows they protect.
  // That separation IS the guarantee (master-plan.md:316 — "GDPR erasure claims are only
  // as credible as the key store's independence"): a key restored by the same dump that
  // restores its ciphertext would quietly un-do every erasure a restore rolled past.

  /**
   * Seal payloads for the subjects that own them, on the way OUT to a platform-retained
   * copy. Batched — one call per dump, not one per row — and positional: result `i`
   * corresponds to `items[i]`.
   *
   * A `null` result means REFUSED, not failed: the subject is tombstoned by a prior shred,
   * and minting a fresh key for them would resurrect readability the erasure was supposed
   * to end. The caller writes `null` into the copy, which is the same shape a live
   * redaction leaves — so a restored backup and a live scope agree about what is gone.
   *
   * Keys are minted on first use, so a subject who has never been exported has no key and
   * costs nothing. Access-logged (K-24) like every directory read that touches subject data.
   */
  sealSubjectPayloads(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    items: readonly { subjectId: string; plaintext: string }[],
  ): Promise<(SealedSecret | null)[]>;

  /**
   * The inverse, on the way back IN from a platform-retained copy. Positional like `seal`.
   *
   * `null` means the key is gone — the subject was shredded between the copy being taken
   * and this restore — and the caller restores a null payload. This is where the erasure
   * actually bites: the bytes were always there in the backup, and after the shred nothing
   * can turn them back into a person.
   */
  openSubjectPayloads(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    items: readonly { subjectId: string; sealed: SealedSecret }[],
  ): Promise<(string | null)[]>;

  /**
   * Erase one data subject from a scope: redact the spine payloads keyed to them, then
   * destroy their key and tombstone the id.
   *
   * **That order is load-bearing.** Both halves are idempotent and a crash between them
   * self-heals on retry, so the tiebreak is which half-done state harms the person: a run
   * that died after redacting leaves ciphertext in a backup nobody can read without the
   * key; one that died after destroying the key first would leave their PII sitting in the
   * live operational database while the audit log claims they were erased. Redact what is
   * reachable, then destroy what makes the unreachable unreadable.
   *
   * Audited as `shredSubject` with the receipt as `after`, and access-logged: this both
   * mutates and destroys evidence, so it is the rare action that belongs in both logs.
   *
   * What it does NOT reach is written down rather than implied — vertical-owned PII in a
   * vertical's own table, copies already handed to a customer, and the PITR window (see
   * kernel-design.md's answer to open question 17). A mechanism whose limits are
   * undocumented gets oversold by someone who was not in the room.
   */
  shredSubject(
    actor: PlatformActorId,
    tenantId: TenantId,
    scopeId: ScopeId,
    subjectId: string,
  ): Promise<SubjectShredReceipt>;

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
  /**
   * Meters 1 and 2 as one reading (#38; control-plane.md §5) — tenants and active
   * scopes, plus the entitlement store grouped by SKU and tier. Fleet-wide, or
   * narrowed to one tenant with `{ tenantId }`.
   *
   * An AGGREGATE, not a list, and that is the whole point: both numbers are already
   * derivable by walking `listScopes` + `listEntitlements` per tenant, but doing it
   * that way is N+1 round trips against the directory and — worse — re-derives the
   * billable rule in every caller. Two rules live here instead, once (see
   * `meterReading`): a scope is billable only if its TENANT is active too (a cascade
   * suspension is an outage, not revenue), and expiry is evaluated at the reading's
   * instant so a lapsed grant reads as lapsed rather than as never-granted.
   *
   * Computes nothing that needs a data pipeline. Meters 3 and 4 are absent because
   * they are uncomputable by construction, not because this is a first slice — the
   * per-scope outbox has no cross-tenant fan-in, and reads emit nothing at all.
   *
   * Nothing is stored: a reading is recomputed per call. D-30 is meter, do not bill,
   * and a persisted running total is the first half of a billing ledger.
   */
  readMeters(actor: PlatformActorId, filter?: { tenantId?: TenantId }): Promise<MeterReading>;

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
   * Whether this host was built with a `SecretBox` — i.e. whether it can store a
   * credential at all (#603).
   *
   * A synchronous property, not a probe: the answer is fixed when the host is
   * constructed and needs no round trip. It exists so a caller can refuse BEFORE
   * doing work that only makes sense if the result can be stored — the connection
   * relay asks the provider to verify a candidate credential, and asking on a
   * host that could never keep the answer spends a real outbound call, and hands
   * the plaintext to the provider, to reach the same failure one step later.
   *
   * `false` does not disable the writes below; they still fail closed with a
   * `SecretBoxUnconfiguredError`. This is the readable form of the same fact, so
   * a transport can answer "this deployment cannot do that" (503) instead of
   * letting a boot-time misconfiguration surface as an unexplained 500.
   */
  readonly canStoreSecrets: boolean;

  /**
   * Store a tenant's authorization for one provider, held by one vertical.
   *
   * The credential is sealed by the host's `SecretBox` before it touches the
   * directory, and the admin-log row carries **metadata only** — provider,
   * label, scopes. That is structural, not careful: `_substrat_admin_log` is
   * append-only, so a secret written into it could never be removed.
   *
   * Takes a `PlatformActorId`, but connecting a provider is really a tenant
   * admin's act — §3.5 settled that the authority ORIGINATES in-scope (option B)
   * and the effecting caller here is host code holding platform authority
   * legitimately (an OAuth callback, the connection relay). Attribution rides in
   * `input.createdBy` — the authorizing principal, recorded on the connection
   * and in the audit row — never laundered into the actor (§3.5.1).
   */
  createConnection(actor: PlatformActorId, input: CreateConnectionInput): Promise<void>;

  /**
   * This connection's PUBLIC sealing key (#687) — what the platform gathers and
   * projects into a scope so module code can `ctx.sealToConnection` to it.
   *
   * **Mints on first ask, idempotently.** Not a separate "create key" verb,
   * because the alternative is a fleet where connections made before this
   * existed can never receive a sealed value: Egeryds' Scrive credential is
   * years of real contracts old, and re-connecting it to acquire a keypair is
   * not a migration anyone should have to run. Asking is the back-fill.
   *
   * The private half is sealed under the host's `SecretBox` and stored beside
   * the credential, in a **keyId-indexed** set from day one — even holding
   * exactly one member (D-4: widening a single-key column into a set later is a
   * migration against live connections; starting with the map is free).
   *
   * Unaudited, like `resolveIdentity`: it is a machine read on a delivery path
   * that returns a public key, and an audit row per provision would say nothing
   * a reader could act on. Every USE of the private half is already attributable
   * — it happens inside a connector dispatch, against a named connection.
   */
  connectionSealingKey(id: ConnectionId): Promise<ProjectedConnectionKey>;

  /**
   * Every live connection's public sealing key for one (tenant, vertical) — the
   * gather the platform projects with provision and reconcile.
   *
   * Minting is idempotent per connection, so this doubles as the back-fill for a
   * tenant whose connections all predate the keypair.
   */
  connectionSealingKeys(tenantId: TenantId, vertical: string): Promise<ProjectedConnectionKey[]>;

  /** Metadata only — never the credential, at any privilege level. */
  listConnections(actor: PlatformActorId, filter?: ConnectionFilter): Promise<Connection[]>;

  /**
   * Replace the sealed credential — the OAuth refresh path, and the connection
   * relay's rotation (connections.md §3.5.2). `opts.rotatedBy` names the tenant
   * principal whose permission-checked act authorized the rotation, recorded in
   * the audit metadata — the rotate-side analogue of `createdBy` on create
   * (§3.5.1). Omitted ⇒ the effecting actor stands alone, the platform-driven
   * refresh path.
   */
  updateConnectionSecret(
    actor: PlatformActorId,
    id: ConnectionId,
    secret: ConnectionSecret,
    expiresAt?: string,
    opts?: { rotatedBy?: string },
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
   * Record one operational failure (#559) — a deploy, restore, or provision that the
   * PLATFORM could not complete. Deliberately not `recordAdmin`: the audit spine
   * answers "who changed what", and a failure changed nothing. The row gives the
   * upstream trace reference (Cloudflare's `internal error; reference = <id>`) a
   * durable, queryable home; before this its only record was a vertical script's
   * short-retention observability logs.
   *
   * MUST NOT throw in normal operation: the adapters bound the row's size and prune
   * old rows on write, and the transport calls this from failure paths — a recorder
   * that fails must never mask the failure it was recording (callers still guard).
   */
  recordOpsFailure(entry: OpsFailureInput): Promise<void>;

  /**
   * The recorded operational failures, newest first by default — the console's
   * failures view and the "what does this `reference = <id>` belong to" lookup.
   * Retention-bounded (unlike the never-swept admin log), so an empty read means
   * "nothing recent", never "nothing ever".
   */
  listOpsFailures(actor: PlatformActorId, filter?: OpsFailureFilter): Promise<OpsFailureEntry[]>;

  /**
   * The staff access log (K-24) — who READ the directory, when, and how much came
   * back. Reading it is itself recorded: who examined the record of who looked is
   * the question an incident asks second.
   */
  accessLog(actor: PlatformActorId, filter?: AccessLogFilter): Promise<AccessLogEntry[]>;

  /**
   * Stamp `drainedAt` on every not-yet-drained access row up to and including
   * `upToId`, marking them shipped to Tier 2. Returns how many rows moved.
   *
   * **Called only AFTER the sink confirms the write.** The stamp is what licenses
   * `pruneAccessLog` to delete a row, so stamping first and shipping second would
   * turn one failed upload into permanently deleted evidence. Ship, confirm, stamp,
   * prune — in that order (`sweepAccessLog`).
   *
   * `upToId` rather than a list of ids because the id is a ULID and the log is
   * append-only: "everything up to here" is exactly the batch that was read, and
   * rows written during the shipment sort strictly after it. The `drainedAt IS NULL`
   * guard makes a re-run idempotent — a retried pass re-stamps nothing and returns 0.
   */
  markAccessLogDrained(
    actor: PlatformActorId,
    upToId: string,
    drainedAt: string,
  ): Promise<number>;

  /**
   * Prune access-log rows already shipped to Tier 2, oldest first, up to `limit`.
   *
   * **Only drained rows.** Pruning on age alone would destroy evidence while calling
   * itself a retention policy — the failure K-21 rejected for tuples, one layer up.
   * A deployment that configures no sink drains nothing, so this prunes nothing and
   * the window stays unbounded — still a stated limitation rather than a policy, but
   * now one the operator opts out of rather than one the platform imposes.
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

/**
 * The §4.3 entitlement-gate denial, worded identically wherever the gate lives — the
 * coordinator against the shared CP, a scope DO against its projection, the SQLite
 * adapter against its directory.
 *
 * It names BOTH sides (#691). The required key alone reads as "buy the SKU", which sent
 * the 2026-08-15 Egeryds lockout down the wrong path for half a day: the tenant held four
 * keys, just under a workspace-prefixed name the manifest could never match. Required-vs-held
 * IS the diagnosis, so the message that reports the denial should carry it — a key that is
 * *nearly* right (prefixed, misspelled, expired) is invisible until you can see both lists.
 *
 * `held` is every key projected for the tenant, expired ones included and marked: a lapsed
 * grant denies exactly like an absent one, and "you have it, it ran out" is a different fix
 * from "you never had it".
 *
 * **Its code is `not_found`** at all three throw sites (#113). Not an oversight and not
 * `forbidden`: the taxonomy's `not_found` row already covers "exists, and must read as
 * absent" for K-3's cross-tenant case, and every vertical had independently arrived at a
 * 404 here for the same reason — *"a 403 would confirm the feature exists"*
 * ([`todo/routes.ts`](../../../demos/todo/src/routes.ts)). Naming the code once is what
 * retires those hand-written patterns.
 */
export function entitlementDenial(
  operation: string,
  requiredKey: string,
  held: readonly { key: string; expired: boolean }[],
): string {
  const inventory =
    held.length === 0
      ? 'none'
      : held.map((h) => (h.expired ? `${h.key} (expired)` : h.key)).join(', ');
  return `operation not entitled: ${operation} — tenant does not hold '${requiredKey}'; holds: ${inventory}`;
}

/**
 * Read a hostname row's stored `validation_records` — the DNS records Cloudflare
 * returned while a custom hostname was being issued.
 *
 * Tolerant on purpose, and the tolerance is the point. This column is the only part
 * of a hostname row that is not written by this platform: it is whatever the issuance
 * API handed back, stored verbatim. A bare `JSON.parse` here made one unparseable blob
 * anywhere in the fleet into a `SyntaxError` — which is not a `ZodError`, so the
 * control-plane's error mapper did not recognise it and answered a blank 500. That took
 * out every `listHostnames` that crossed the bad row, including the one on the deploy
 * path, so a cert-validation detail for one domain could stop unrelated verticals from
 * shipping.
 *
 * Cert-validation records are display data — the console renders them so an operator can
 * copy a CNAME. Nothing routes on them. So an unreadable blob degrades to "no records to
 * show" for that one hostname, and every other row in the page still maps. Both adapters
 * call this so neither can be the lenient one.
 */
export function parseValidationRecords(raw: string | null | undefined): DnsRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DnsRecord[]) : [];
  } catch {
    // Malformed beyond reading. The row still describes a real binding; only its
    // copy-this-CNAME hint is lost, and `substrat hostnames verify` re-polls issuance
    // and rewrites the column with whatever the API says now.
    return [];
  }
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
  /**
   * Narrow by drain state: `false` selects rows not yet shipped to Tier 2, `true`
   * those already shipped. Omitted reads both.
   *
   * This exists for the drain itself — "the oldest rows that have not left yet" is
   * the only query it needs, and expressing it here keeps the sweep on the audited
   * `accessLog` seam rather than giving it a private read path into the table.
   */
  drained?: boolean;
}

/**
 * How long a recorded operational failure is kept (#559). Telemetry, not evidence:
 * unlike the never-swept admin log, the ops-failures table self-prunes on write in
 * every adapter, so it can never grow without bound and needs no cron wiring or
 * operator decision. 90 days comfortably outlives any incident follow-up (a
 * Cloudflare ticket round-trip) while keeping directory storage flat.
 */
export const OPS_FAILURE_RETENTION_DAYS = 90;

/**
 * What a failure path hands `recordOpsFailure`. `id`/`at` are stamped by the
 * adapter (ULID + now), everything else by the transport at the catch site.
 */
export interface OpsFailureInput {
  actor: PlatformActorId;
  /** Semantic where the route knows it (`deploy.upload`), `METHOD /route/:path` otherwise. */
  operation: string;
  stage?: string | null;
  tenantId?: TenantId | null;
  scopeId?: ScopeId | null;
  vertical?: string | null;
  /** The HTTP status the failure was answered with (or carried from upstream). */
  status?: number | null;
  message: string;
  /** The upstream provider's trace reference, when the message carried one. */
  reference?: string | null;
}

/** Filter for `listOpsFailures` — cursor/order/limit exactly as `AuditLogFilter`. */
export interface OpsFailureFilter {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  vertical?: string;
  operation?: string;
  /** Exact match — the lookup a CI log's `reference = <id>` line lands on. */
  reference?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  /** Default 'desc' — an operator asks "what broke lately", not "what broke first". */
  order?: 'asc' | 'desc';
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
   * Mint a stub that ACTS AS a principal on behalf of a staff actor (K-42, #868) — the
   * supported way to see what a customer sees, and the fourth door beside `getScope`,
   * `getConnectorScope` and `getSystemScope`.
   *
   * Every gate `getScope` applies applies here first: the (tenant, scope) pair is
   * validated against the directory, a non-active tenant or scope fails closed, pending
   * migrations run. What this adds is the second actor.
   *
   * **Permission evaluation is the impersonated principal's, and only theirs.** That is
   * the point — a session resolving the staff actor's authority would show what staff
   * can see, which is what the customer's screenshot already showed. The narrowing that
   * keeps this safe is not a smaller permission set, it is:
   *
   * - **Read-only unless the caller opted in** (`writes: true` on the request). A
   *   read-only session refuses `ctx.emit`, `ctx.requestPlatform`, `ctx.grant`,
   *   `ctx.revoke` and `ctx.link` outright, and rolls its transaction back regardless —
   *   two layers, the second authoritative, the same arrangement `assertReadOnlyQuery`
   *   uses in front of the SQL console.
   * - **Time-boxed**, checked on EVERY invoke rather than once at the door, so a held
   *   stub goes dead on its own rather than living as long as the process.
   * - **Announced before it exists.** The `impersonate` admin-log entry is written
   *   BEFORE this returns, so a session that then crashes still left the record that it
   *   began — K-33's failure ordering, for K-33's reason.
   *
   * Refuses a request whose `reason` is missing or trivial, and one whose `ttlMinutes`
   * exceeds `IMPERSONATION_MAX_TTL_MINUTES`. Neither is a formality: they are the two
   * fields that turn a standing back door into a bounded, attributable act.
   */
  getImpersonatedScope(
    request: ImpersonationRequest,
    tenantId: TenantId,
    scopeId: ScopeId,
    options?: ScopeStubOptions,
  ): Promise<ImpersonatedScope>;

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
   * `exportScope` and the fork primitive (docs/architecture/preview-and-snapshots.md §3):
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
    /**
     * Build the surface for ONE delivery (#726 remedy B). When set, `open` is admitted
     * by ownership of the entity this event names — resolved against the scope's own
     * spine, never taken on the caller's word — instead of by a standing grant. Absent
     * (the return path, a poll driver) the ordinary permission check applies.
     */
    forEvent?: { eventId: string },
  ): Promise<ScopeAttachments>;

  /**
   * What this scope's own tuples say a connection may do (#726 gap 1).
   *
   * Every other authority in the model is inspectable from where the vertical sits:
   * the permission surface is diffed at promote, role tuples are readable from the
   * scope, entitlements and identity links are projected and read back locally. A
   * connection's grants were the exception — writable from the platform, readable only
   * with staff access to the control plane — and they are the authority behind the one
   * actor that is not a person. #716 found `protocol:attach` missing from the demo
   * Scrive connection after months of silently failing the sealed-copy landing; nothing
   * in the deployment could have answered the question that would have caught it.
   *
   * **The scope's own answer, not the directory's.** These are the delivered
   * `connection:<id>` / `granted:<perm>` tuples — the same rows the permission checker
   * reads, so what this returns is what would actually be enforced here, including a
   * scope whose delivery is behind the directory. The directory's view is a different
   * fact and lives on `HostAdmin`; a caller asking "may this connection act HERE" wants
   * this one.
   *
   * Live grants only: revoked tuples are tombstoned rather than deleted (K-21) and
   * expired ones are past their `expires_at`, and neither would be enforced, so neither
   * is reported.
   */
  connectionGrantsInScope(
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ProjectedConnectionGrant[]>;

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
   * Execute ONE connector delivery with this host's directory, credentials and egress —
   * the platform half of #574 phase 3. A CP-less host routes each connector delivery
   * onto the platform-requests surface as a `connector:<provider>` intent; the
   * platform's drain calls this to run the same handler a self-host would have run
   * in-process, against the SAME `ConnectorContext` shape (ambient tenant/vertical, the
   * opened connection, sanctioned egress). No journal here: the intent row IS the
   * journal — the drain settles it done/pending from this call's outcome, and
   * at-least-once still requires the handler's own idempotency (the dispatch ledger).
   * Fleet maintenance, no actor, same class as `drainDue`. Fails closed on a host that
   * cannot reach the connection directory.
   */
  dispatchConnector(
    tenantId: TenantId,
    scopeId: ScopeId,
    handler: ConnectorHandler,
    event: DomainEvent,
    options?: { timeoutMs?: number },
  ): Promise<void>;

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
   * The scope's intent JOURNAL — every intent in whatever state it settled, newest first (#618).
   *
   * `listPlatformRequests` answers the drain's question and so returns only `pending`; that made
   * a settled intent unreadable from anywhere but the scope's own spine table, which is how a
   * connector's full `last_error` ("HTTP 409 Authentication to sign for participant #1 requires
   * valid personal number field") ended up retained, correct, and reachable only by hand-written
   * SQL. This is the read that surfaces it: `kind` narrows to one intent family
   * (`connector:scrive`), `status` to one outcome, `limit` to a recency window.
   *
   * Fleet maintenance, no actor — same class as the pending read it complements.
   */
  listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]>;

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
    outcome: {
      status: PlatformRequestStatus;
      result?: unknown;
      lastError?: string | null;
      /** WHO refused (#841). Omitted by a caller too old to attribute — stored as NULL. */
      failure?: PlatformRequestFailure | null;
    },
  ): Promise<void>;

  /** Bare operation registration (tests, glue). Names are module-namespaced: 'workorder/create'. */
  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void;

  close(): Promise<void>;
}
