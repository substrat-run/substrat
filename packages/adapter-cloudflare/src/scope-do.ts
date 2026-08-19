import { DurableObject } from 'cloudflare:workers';
import {
  ATTACHMENT_ADDED,
  ATTACHMENT_REMOVED,
  attachmentRecord,
  type AttachmentRecord,
  domainEvent,
  domainEventInput,
  eventId,
  instant,
  objectRef,
  toWireFailure,
  type WireFailure,
  grantRefFromProof,
  principalId,
  platformRequestInput,
  platformRequestId,
  MAX_PENDING_PLATFORM_REQUESTS,
  type DomainEvent,
  type DomainEventInput,
  type PlatformRequestInput,
  type PlatformRequestId,
  type PlatformRequest,
  type PlatformRequestFilter,
  platformRequest,
  type EntitlementView,
  type EntityRef,
  type EventAuthorization,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type ScopeDumpTable,
  type ScopeQueryResult,
  type ScopeTable,
  type ScopeTablePage,
  type TenantId,
  SCOPE_TABLE_PAGE_MAX,
  SCOPE_QUERY_ROW_MAX,
} from '@substrat-run/contracts';
import {
  ulid,
  assertAllowed,
  ConnectionSealingKeyUnavailableError,
  noSealingKeyMessage,
  sealTo,
  assertReadOnlyQuery,
  entitlementDenial,
  platformRequestHistoryQuery,
  PermissionDenied,
  type ConsumerHandler,
  type GuardPredicate,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PermissionChecker,
  type SqlMigration,
  createAtomic,
  type RunSub,
} from '@substrat-run/kernel';
import type { CheckSubject, ModuleId } from '@substrat-run/contracts';
import { OperationQueue } from './serialization.js';
import { doScopedSql } from './sql.js';
import { createDoTupleChecker, createLocalControlPlaneReader, type ControlPlaneReader } from './checker.js';

/**
 * `defineScopeDO` — one Durable Object per scope, the CF analogue of a single
 * `SqliteScopeHost` scope runtime (D-14). It closes over a CODE-TIME module set
 * (a DO cannot receive handler closures over RPC), builds the kernel spine in
 * its own SQLite, and runs each operation inside `ctx.storage.transaction` — the
 * async transaction API that commits on success and rolls back on a throw even
 * across an `await` (verified in workerd), the direct analogue of the pure
 * adapter's `BEGIN IMMEDIATE … COMMIT/ROLLBACK`.
 *
 * The coordinator (`CloudflareScopeHost`) owns the directory, the entitlement
 * gate, and audit; the DO owns per-scope execution: migrations, guards,
 * handlers, emits, the outbox→consumer dispatch loop, entity links, and local
 * permission evaluation (scope tuples here, tenant tuples via ControlPlaneDO).
 */

export interface ScopeDoEnv {
  /**
   * The shared directory DO — the source of tenant-level tuples + roles for a
   * scope whose `permission_source` is still 'control-plane'. Optional: a scope
   * that has been projected (or a CP-less vertical, docs/architecture/scope-local-
   * permissions.md) evaluates permissions locally and needs no binding.
   */
  CONTROL_PLANE?: DurableObjectNamespace;
}

interface RegisteredModule {
  id: string;
  migrations: SqlMigration[];
  consumers: { eventType: string; handler: ConsumerHandler }[];
}

interface DeclaredGuard {
  predicate: string;
  config: Record<string, unknown>;
  declaredBy: string;
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

const KERNEL_DDL = `
  -- The ';' in this comment is a deliberate tripwire; the DDL must go through
  -- splitSqlStatements, and a naive split(';') fails every scope at construction.
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
    -- NULL on rows written before the field existed -- honestly unrecorded, not empty.
    authorization TEXT,
    drained_at TEXT
  );
  -- platform-intents.md: durable intents a vertical enqueues (ctx.requestPlatform) for the platform
  -- to drain and execute with HostAdmin authority -- the sandbox-clean way a vertical asks for a
  -- privileged action. Written by the kernel (spine), settled by the platform drain.
  CREATE TABLE IF NOT EXISTS _substrat_platform_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    result TEXT,
    requested_at TEXT NOT NULL,
    settled_at TEXT
  );
  -- K-35: refused permission checks. A denial rolls its operation back, so it is
  -- recorded here OUTSIDE that transaction, on the deny path -- the one event where an
  -- actor's intent and the permission model visibly disagree, witnessed by no other log.
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
  -- #383: recurring-schedule bookkeeping. One row per schedule operation that has
  -- run on this scope, so the platform sweep can tell what is due. Spine (kernel-
  -- written), never a module migration.
  CREATE TABLE IF NOT EXISTS _substrat_schedule_state (
    schedule_op TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_status TEXT
  );
  CREATE TABLE IF NOT EXISTS _substrat_migrations (
    module_id TEXT NOT NULL,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module_id, version)
  );
  -- #286: the PITR bookmark taken immediately BEFORE a migration pass runs on a
  -- scope that already holds data -- the precise rewind point a backout restores
  -- to. Rows live in the same storage they describe, so a rewind erases the rows
  -- taken after its target, which is exactly right. "pending" names what was about
  -- to apply (module@version list, JSON) for the deployments UI.
  CREATE TABLE IF NOT EXISTS _substrat_migration_bookmarks (
    bookmark TEXT PRIMARY KEY,
    taken_at TEXT NOT NULL,
    pending TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _substrat_tuples (
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    -- K-21: revocation tombstones rather than deletes -- the row stays, the walk
    -- skips it, and it remains readable as evidence.
    revoked_at TEXT,
    PRIMARY KEY (subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    -- Terminal row: when it was delivered (or dead-lettered). Retrying row: when
    -- it was last ATTEMPTED. The column predates retry state (#100) and is NOT
    -- NULL, so it carries both readings rather than forcing a rebuild.
    delivered_at TEXT NOT NULL,
    error TEXT,
    -- Retry state, executors only (#100). Consumers leave the defaults.
    --   next_attempt_at IS NOT NULL  -> pending, due at that time
    --   next_attempt_at IS NULL      -> terminal: error IS NULL delivered, else dead
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    PRIMARY KEY (event_id, consumer_module)
  );
  -- Scope-local permissions (docs/architecture/scope-local-permissions.md): the
  -- tenant-level tuples + role definitions PROJECTED into this scope, so the
  -- checker evaluates permissions from local storage instead of reading the shared
  -- control-plane DO per request. Empty until a scope is projected (Phase 2) — until
  -- then permission_source stays 'control-plane' and the RPC path is used.
  CREATE TABLE IF NOT EXISTS _substrat_tenant_tuples (
    tenant_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    relation TEXT NOT NULL,
    object TEXT NOT NULL,
    expires_at TEXT,
    -- K-21 tombstone, mirroring _substrat_tuples: the row stays, the walk skips it.
    revoked_at TEXT,
    PRIMARY KEY (tenant_id, subject, relation, object)
  );
  CREATE TABLE IF NOT EXISTS _substrat_roles (
    tenant_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    permissions TEXT NOT NULL,
    source TEXT NOT NULL,
    -- A removed role tombstones rather than deletes — a tombstoned role reads as
    -- absent (grants nothing) but stays as evidence.
    revoked_at TEXT,
    PRIMARY KEY (tenant_id, role_key)
  );
  -- Small scope-local key/value store. Today: 'permission_source' ∈
  -- {'control-plane','local'} — which reader the checker uses (default 'control-plane').
  CREATE TABLE IF NOT EXISTS _substrat_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- The tenant's entitlements PROJECTED into this scope (#304), so a hosted vertical
  -- reads plan/quota/expiry at request time from local storage instead of a forbidden
  -- control-plane binding — the same projection-on-write model as roles/tuples above,
  -- settling kernel open-question 5 (cache = the projection, invalidated by the fan-out).
  -- No audit columns (granted_at/granted_by stay control-plane-side) and no tombstone:
  -- applyProjection full-replaces, so a revoked grant is simply absent from the next
  -- snapshot. Empty until projected — a console-managed scope reads over RPC instead.
  CREATE TABLE IF NOT EXISTS _substrat_entitlements (
    tenant_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    expires_at TEXT,
    quota INTEGER,
    plan TEXT,
    PRIMARY KEY (tenant_id, entitlement_key)
  );
  -- The tenant's identity links PROJECTED into this scope (#406), so a CP-less
  -- vertical's auth adapter resolves (provider, externalId) → principal from local
  -- storage at request time instead of a static map compiled into the bundle — the
  -- same projection-on-write model as entitlements above. Keyed like the directory's
  -- _substrat_identities (K-22: tenant-scoped, never global). No audit columns
  -- (created_at and the link/unlink trail stay control-plane-side) and no tombstone:
  -- applyProjection full-replaces, so an unlinked identity is simply absent from the
  -- next snapshot — absence resolves to nothing, which is the fail-closed direction.
  CREATE TABLE IF NOT EXISTS _substrat_identity_links (
    tenant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    scope_id TEXT,
    PRIMARY KEY (tenant_id, provider, external_id)
  );

  -- Each live connection's PUBLIC sealing key, PROJECTED into this scope (#687), so
  -- module code can seal a value TO a connector before emitting it — the one channel
  -- a CP-less vertical has for handing a connector something the spine must not hold
  -- in the clear. Same projection-on-write model as entitlements and identity links
  -- above, and the same full-replace: a revoked connection's key is simply absent
  -- from the next snapshot, and absence makes sealToConnection refuse, which is the
  -- fail-closed direction.
  --
  -- **Only ever the public half.** Projecting a secret key into a scope is exactly the
  -- failure kernel-design §13.1 names — a key restored by the same dump that restores
  -- its ciphertext reverses every erasure the restore rolled past. The private half
  -- stays in the directory; this row lets the scope WRITE to a connector, never read.
  CREATE TABLE IF NOT EXISTS _substrat_connection_keys (
    tenant_id     TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    provider      TEXT NOT NULL,
    key_id        TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    PRIMARY KEY (tenant_id, connection_id)
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

/**
 * Workers RPC carries a plain `Error`'s MESSAGE faithfully and nothing else. A custom
 * subclass (e.g. Zod's `ZodError`, whose `message` is a getter over its issues) arrives
 * on the coordinator side as just its class name, so re-wrap any non-plain error as a
 * plain `Error` before it crosses — the message (which for a ZodError includes the
 * failing path/detail) survives, and contract matchers assert on it.
 *
 * **`name` is NOT a second channel, and this was measured, not assumed** (#113 phase 2,
 * `test/error-taxonomy.test.ts`). Setting `name` on the rewrapped error does not deliver
 * a `name` on the far side: workerd folds it into the message as `"<name>: <message>"`
 * and resets `name` to `'Error'`. So carrying the error taxonomy's code this way would
 * rewrite every error message on the Cloudflare path — `permission denied: perm:use`
 * becomes `PermissionDenied: permission denied: perm:use` — for every log line, every
 * vertical's `onError`, and every UI string.
 *
 * The consequence, stated so it is not re-derived: across THIS boundary a throw carries
 * its message and nothing more. Structure has to travel as a VALUE, which is the
 * discriminated `{ ok, error }` envelope the error-model RFC names as §3's successor.
 * In-process — the SQLite adapter, a handler in the same isolate — the real class
 * arrives and `errorCodeOf` reads it directly.
 */
function toRpcError(err: unknown): Error {
  if (err instanceof Error) {
    return err.constructor === Error ? err : new Error(err.message);
  }
  return new Error(String(err));
}

/** The check subject for an attachment gate (#476): the connection when the connector door
 *  set one, else the principal — mirrors the invoke path's subject selection. */
function attachSubject(principal: PrincipalId, connectionId?: string): CheckSubject {
  return connectionId ? { kind: 'connection', id: connectionId } : { kind: 'principal', id: principal };
}

/** The platform spine (`_substrat_*`) and SQLite internals — the UI groups these apart. */
function isSystemTable(name: string): boolean {
  return name.startsWith('_substrat') || name.startsWith('sqlite_');
}

/** A raw `_substrat_platform_requests` row as stored — snake_case, JSON columns still strings.
 *  The coordinator maps it to the `PlatformRequest` contract shape. */
export interface PlatformRequestRawRow {
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

/**
 * A stored row → the `PlatformRequest` contract shape (JSON columns parsed). The coordinator
 * maps the RPC's raw rows the same way in `host.ts`; this copy exists because `ctx.platformRequests`
 * (#618) answers INSIDE the DO, where the row never crosses an RPC boundary at all.
 */
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

/** SQLite cell → a JSON-safe value: bigints stringify, blobs (ArrayBuffer) read as null. */
function cellToJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) return null;
  return v;
}

/**
 * Split a SQL blob (a migration, the kernel/directory DDL) into its statements,
 * honouring SQL syntax.
 *
 * The DO's `SqlStorage.exec` runs one statement per call, so a multi-statement
 * blob is split on `;`. A naive `sql.split(';')` breaks the moment a `;` appears inside a
 * `--`/`/* *​/` comment or a string literal — it truncates the statement and the DO
 * reports "incomplete input". The SQLite adapter never hit this because
 * better-sqlite3's `exec` takes the whole blob; this is what made a migration that
 * passed on SQLite fail only on Durable Objects (the divergence this fix closes).
 *
 * So this is a small SQL-aware scanner: it skips line and block comments, copies
 * string literals through verbatim (including the `''` escape), and splits only on
 * a top-level `;`. Comments are dropped from the emitted statements — which also
 * means a trailing comment can never become a comment-only "statement" that
 * `exec` rejects. Blank fragments are skipped.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i += 1; // line comment → end of line
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2; // block comment → past the closing */
      continue;
    }
    if (c === "'") {
      cur += c;
      i += 1;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += sql[i + 1]; // '' is an escaped quote, still inside the string
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function defineScopeDO(
  modules: ModuleRegistration[],
  bareOps: Record<string, OperationHandler<never, unknown>>,
): new (ctx: DurableObjectState, env: ScopeDoEnv) => DurableObject {
  return class ScopeDO extends DurableObject<ScopeDoEnv> {
    private readonly sql: SqlStorage;
    private readonly queue = new OperationQueue();
    private readonly operations = new Map<string, OperationHandler<never, unknown>>();
    private readonly modules = new Map<string, RegisteredModule>();
    private readonly guards = new Map<string, DeclaredGuard[]>();
    private readonly predicates = new Map<string, { module: string; handler: GuardPredicate }>();
    private readonly withdrawn = new Map<string, string>();
    private readonly relations = new Map<string, Set<string>>();
    /** entityType → the declared attachment gate (#473): read key + write key (default: read). */
    private readonly attachmentTargets = new Map<string, { read: PermissionKey; write: PermissionKey }>();
    private readonly checker: PermissionChecker;
    private readonly systemPrincipal: PrincipalId = principalId.parse(ulid());
    private readonly applied = new Set<string>();
    private migrationPromise?: Promise<boolean>;
    /** Latch: the applied count is reported to the directory once per DO instance. */
    private schemaVersionReported = false;
    /** The migration that failed on this instance, read back by `migrationFailure`. */
    private lastFailure: { version: string; error: string } | null = null;
    /** Passes of `applyPendingMigrations` that had work to do — see `migrationAttemptsOnInstance`. */
    private migrationRuns = 0;

    constructor(ctx: DurableObjectState, env: ScopeDoEnv) {
      super(ctx, env);
      this.sql = ctx.storage.sql;
      for (const stmt of splitSqlStatements(KERNEL_DDL)) {
        this.sql.exec(stmt);
      }
      // KERNEL_DDL is all IF NOT EXISTS, so a scope DO created before K-21 keeps
      // the old shape. Attempt-and-tolerate: DO SQLite restricts PRAGMA, so there
      // is no column probe, and a duplicate is the steady state after the first
      // cold start (same argument as ControlPlaneDO.addColumn).
      for (const alter of [
        'ALTER TABLE _substrat_tuples ADD COLUMN revoked_at TEXT',
        // Executor retry state (#100). The defaults read as "terminal", which is
        // right for every row already there: each is a completed delivery or a
        // consumer dead-letter.
        'ALTER TABLE _substrat_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE _substrat_deliveries ADD COLUMN next_attempt_at TEXT',
        // K-34: the authorization column on a scope DO created before it existed. Nullable,
        // so legacy outbox rows read as "unrecorded". (_substrat_denials is a new table,
        // covered by KERNEL_DDL's IF NOT EXISTS with no ALTER.)
        'ALTER TABLE _substrat_outbox ADD COLUMN authorization TEXT',
      ]) {
        try {
          this.sql.exec(alter);
        } catch (err) {
          if (!/duplicate column name/i.test((err as Error).message)) throw err;
        }
      }

      for (const registration of modules) this.registerModule(registration);
      for (const [name, handler] of Object.entries(bareOps)) this.defineOperation(name, handler);

      // Which migrations have already run (a warm DO wakes with rows here).
      for (const row of this.sql
        .exec('SELECT module_id, version FROM _substrat_migrations')
        .toArray() as unknown as { module_id: string; version: string }[]) {
        this.applied.add(`${row.module_id}@${row.version}`);
      }

      const controlPlane = this.controlPlaneReader();
      this.checker = createDoTupleChecker({ scopeSql: this.sql, controlPlane });
    }

    // -- module registration (port of SqliteScopeHost.registerModule) ---------

    private registerModule(registration: ModuleRegistration): void {
      const manifest = registration.manifest;
      this.modules.set(manifest.id, {
        id: manifest.id,
        migrations: registration.migrations ?? [],
        consumers: Object.entries(registration.consumers ?? {}).map(([eventType, handler]) => ({
          eventType,
          handler,
        })),
      });
      for (const [name, handler] of Object.entries(registration.predicates ?? {})) {
        this.predicates.set(name, { module: manifest.id, handler });
      }
      for (const guard of manifest.guards ?? []) {
        const forOperation = this.guards.get(guard.before) ?? [];
        forOperation.push({ predicate: guard.predicate, config: guard.config, declaredBy: manifest.id });
        this.guards.set(guard.before, forOperation);
      }
      for (const rel of manifest.entityRelations ?? []) {
        const parents = this.relations.get(rel.entityType) ?? new Set<string>();
        parents.add(rel.parentType);
        this.relations.set(rel.entityType, parents);
      }
      // Attachment targets (#473): entityType → the gate the attachment surface enforces.
      // Re-declaring with the same gate is idempotent; a different gate is refused —
      // ambiguous authority must not depend on registration order (mirror of the pure
      // adapter, which validates the same way).
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
      for (const name of manifest.withdraws ?? []) {
        this.withdrawn.set(name, manifest.id);
        this.operations.delete(name);
      }
      for (const [name, handler] of Object.entries(registration.operations ?? {})) {
        this.defineOperation(name, handler);
      }
    }

    private defineOperation(name: string, handler: OperationHandler<never, unknown>): void {
      if (this.withdrawn.has(name)) return; // withdrawn by another manifest — never binds
      this.operations.set(name, handler);
    }

    // -- RPC surface ----------------------------------------------------------

    /**
     * Trigger lazy migration (the coordinator calls this at provision time).
     * Returns the applied-migration count if this call applied any, else null —
     * the coordinator projects the count into the directory's `schema_version`
     * and skips the write when nothing changed.
     *
     * `ensureMigrations` memoises its promise, so every later call on a warm DO
     * resolves to the SAME `true` without applying anything. Reporting on each of
     * those would bill a control-plane RPC per stub mint to store a number that
     * has not moved — hence the once-per-instance latch.
     */
    async migrate(): Promise<number | null> {
      const applied = await this.ensureMigrations();
      if (!applied || this.schemaVersionReported) return null;
      this.schemaVersionReported = true;
      return this.applied.size;
    }

    /**
     * A FRESH migration attempt — the reconciliation sweep's retry affordance
     * (kernel-design §5.3, #49).
     *
     * `ensureMigrations` memoises its promise, and a REJECTED promise stays
     * assigned: every later `migrate()` on a warm instance returns the same
     * cached rejection without re-attempting (deliberate on the success path —
     * see `migrate` — but it means a sweep that "wakes" a failed scope through
     * the ordinary door retries nothing). This clears the latch and re-runs
     * `applyPendingMigrations`: already-journaled versions are skipped by the
     * `applied` set and the in-transaction re-check, so a concurrent or repeated
     * retry can never double-apply — the worst case is a redundant no-op pass.
     *
     * Same return contract as `migrate()`: the applied count when this call
     * applied any, else null; a still-failing migration rejects (and refreshes
     * `lastFailure` for the coordinator's read).
     */
    async retryMigrations(): Promise<number | null> {
      this.migrationPromise = undefined;
      this.lastFailure = null;
      // The reported latch is NOT reset: a successful retry returns the fresh
      // count below, and the coordinator records it on this same call.
      const applied = await this.ensureMigrations();
      return applied ? this.applied.size : null;
    }

    /**
     * How many times THIS instance has actually executed a migration pass —
     * the observable that distinguishes a fresh attempt from the memoised
     * rejection. The directory's `attempts` counter cannot: the coordinator
     * increments it whenever `migrate()` rejects, cached or not. Test/diagnostic
     * surface; the sweep itself never reads it.
     */
    migrationAttemptsOnInstance(): number {
      return this.migrationRuns;
    }

    /**
     * The last failed migration attempt on this instance, with the count that did
     * land before it. The coordinator reads this on `migrate()`'s rejection path to
     * record what failed (#32) — an extra RPC only when a scope is already broken.
     *
     * Instance state, not storage: `ensureMigrations` memoises its promise, so a
     * failed instance keeps returning the same rejection and this stays in step
     * with it. A restarted DO re-attempts and repopulates.
     */
    migrationFailure(): { version: string; error: string; applied: number } | null {
      return this.lastFailure ? { ...this.lastFailure, applied: this.applied.size } : null;
    }

    /**
     * The PITR bookmarks this scope recorded before migration passes (#286),
     * newest first — what a backout UI offers as rewind points. Rows taken after
     * a rewind's target no longer exist post-rewind, by construction (they live
     * in the storage the rewind restores).
     */
    migrationBookmarks(limit = 20): { bookmark: string; takenAt: string; pending: string[] }[] {
      return this.sql
        .exec(
          `SELECT bookmark, taken_at, pending FROM _substrat_migration_bookmarks
            ORDER BY taken_at DESC LIMIT ?`,
          limit,
        )
        .toArray()
        .map((r) => ({
          bookmark: r.bookmark as string,
          takenAt: r.taken_at as string,
          pending: JSON.parse((r.pending as string) ?? '[]') as string[],
        }));
    }

    /**
     * Rewind this scope's ENTIRE storage — schema and data — to a bookmark (#286's
     * backout). The honest caveat travels in the refusals: PITR restores everything,
     * so every write since the bookmark is discarded. Without `force` the bookmark
     * must be one this scope recorded before a migration and younger than 24h — the
     * first-hours backout window where "nothing happened since" is plausible; later
     * regret belongs to #278's considered restore path. `force` admits any bookmark
     * Cloudflare still holds (30 days), for a staff `getBookmarkForTime` flow.
     *
     * The restore completes on restart: the DO aborts shortly after answering, and
     * the next request finds the storage as it was at the bookmark.
     */
    async rewindToBookmark(
      bookmark: string,
      opts?: { force?: boolean },
    ): Promise<{ rewindingTo: string }> {
      const storage = this.ctx.storage as unknown as {
        onNextSessionRestoreBookmark?: (b: string) => Promise<string>;
      };
      if (typeof storage.onNextSessionRestoreBookmark !== 'function') {
        throw new Error('point-in-time rewind is not available on this host (PITR is production-plane only)');
      }
      const row = this.sql
        .exec('SELECT taken_at FROM _substrat_migration_bookmarks WHERE bookmark = ?', bookmark)
        .toArray()[0] as { taken_at: string } | undefined;
      if (!opts?.force) {
        if (!row) {
          throw new Error(
            'unknown bookmark — not one this scope recorded before a migration (force admits any bookmark Cloudflare holds)',
          );
        }
        const ageMs = Date.now() - Date.parse(row.taken_at);
        if (ageMs > 24 * 60 * 60 * 1000) {
          throw new Error(
            `bookmark is ${Math.round(ageMs / 3_600_000)}h old — rewinding discards EVERY write since; ` +
              `use the backup restore path (#278), or force if the loss is intended`,
          );
        }
      }
      const confirmed = await storage.onNextSessionRestoreBookmark(bookmark);
      // Answer first, then restart to complete the restore — an immediate abort
      // would take the RPC response down with it.
      setTimeout(() => this.ctx.abort(), 100);
      return { rewindingTo: confirmed ?? bookmark };
    }

    /** Admin scope-tuple write (role assignment / grant scoped to this scope). */
    async writeTuple(
      subject: string,
      relation: string,
      object: string,
      expiresAt: string | null,
    ): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?)`,
          subject,
          relation,
          object,
          expiresAt,
        );
      });
    }

    /** Tombstone a scope tuple (K-21) — the row stays, the walk skips it. Returns
     *  whether anything changed so a repeat revoke is a silent no-op. */
    async revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean> {
      return this.queue.enqueue(() => {
        const before = this.sql
          .exec(
            `SELECT 1 FROM _substrat_tuples
             WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
            subject,
            relation,
            object,
          )
          .toArray();
        if (before.length === 0) return false;
        this.sql.exec(
          `UPDATE _substrat_tuples SET revoked_at = ?
           WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
          at,
          subject,
          relation,
          object,
        );
        return true;
      });
    }

    async invoke(
      operation: string,
      input: unknown,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      /**
       * Set when the caller is a CONNECTION rather than a person (#97). The
       * coordinator has already checked that the connection is live and matches
       * this scope's tenant and vertical; the DO uses it for the permission
       * subject and the event actor, so those two can never disagree.
       */
      connectionId?: string,
      /**
       * The SKU the operation's module requires (#304), passed by the coordinator from its
       * `operationEntitlement` map. Enforced HERE only for a scope-local (hosted) scope,
       * where the control plane is unreachable by the sandbox contract and the projected
       * entitlements are the source of truth. A console-managed scope is gated on the
       * coordinator against the shared CP, so this is left undefined / a no-op there.
       */
      requiredEntitlement?: string,
      /**
       * Set when the caller is a MODULE acting on a timer (#383) — the scheduler's
       * subject. Like `connectionId` it is not a person: the DO uses it for the
       * permission subject (`system:<moduleId>` grants) and the event actor
       * (`{ system: <moduleId> }`), and `ctx.check` resolves it normally — no
       * override bypass. Mutually exclusive with `connectionId`.
       */
      systemModuleId?: string,
      /**
       * #113 phase 3: return failures as a VALUE instead of throwing them.
       *
       * Opt-in, and that is what makes it safe to deploy. A coordinator running new
       * code sets it; a ScopeDO instance still running OLD code simply ignores an extra
       * argument and throws exactly as it always did, which the coordinator still
       * handles. The reverse skew — old coordinator, new DO — cannot silently swallow
       * an error either, because without this flag the DO throws. No flag day, and no
       * window where a failure reads as a success.
       */
      failureEnvelope?: boolean,
    ): Promise<{ result: unknown; platformRequests: number; failure?: WireFailure }> {
      if (!failureEnvelope) {
        // Legacy path, byte-for-byte what it was: rewrapped so a non-plain error (a
        // ZodError, whose `message` is a getter) still arrives with its message.
        try {
          return await this.invokeOrThrow(
            operation,
            input,
            principal,
            tenantId,
            scopeId,
            connectionId,
            requiredEntitlement,
            systemModuleId,
          );
        } catch (err) {
          throw toRpcError(err);
        }
      }
      try {
        return await this.invokeOrThrow(
          operation,
          input,
          principal,
          tenantId,
          scopeId,
          connectionId,
          requiredEntitlement,
          systemModuleId,
        );
      } catch (err) {
        // The ONE place the error keeps its structure: flattened here, rebuilt by the
        // coordinator. `toRpcError` is not applied — that exists to make a throw
        // survivable, and this is not a throw.
        return { result: undefined, platformRequests: 0, failure: toWireFailure(err) };
      }
    }

    /** The operation path itself. Throws; `invoke` decides how that reaches the caller. */
    async invokeOrThrow(
      operation: string,
      input: unknown,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
      requiredEntitlement?: string,
      systemModuleId?: string,
    ): Promise<{ result: unknown; platformRequests: number }> {
      await this.ensureMigrations();
      const handler = this.operations.get(operation);
      if (!handler) throw new Error(`unknown operation: ${operation}`);
      // #304 entitlement gate, scope-local path: fail closed on the projected view exactly as
      // the coordinator fails closed against the CP. Only active once entitlements have been
      // projected (the `entitlements_enforced` marker) — before that the scope trusts upstream,
      // exactly as it did pre-#304, so a not-yet-back-filled scope is never wrongly denied.
      if (requiredEntitlement && this.permissionSource() === 'local' && this.entitlementsEnforced()) {
        const held = this.sql
          .exec(
            `SELECT 1 FROM _substrat_entitlements
             WHERE tenant_id = ? AND entitlement_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
            tenantId,
            requiredEntitlement,
            new Date().toISOString(),
          )
          .toArray()[0];
        if (!held) {
          // The whole projected set, so the denial names required AND held (#691).
          // Only read on the failure path — the hot path stays the single lookup above.
          const now = new Date().toISOString();
          const all = this.sql
            .exec(
              `SELECT entitlement_key, expires_at FROM _substrat_entitlements
               WHERE tenant_id = ? ORDER BY entitlement_key`,
              tenantId,
            )
            .toArray() as { entitlement_key: string; expires_at: string | null }[];
          throw new Error(
            entitlementDenial(
              operation,
              requiredEntitlement,
              all.map((r) => ({
                key: r.entitlement_key,
                expired: r.expires_at !== null && r.expires_at <= now,
              })),
            ),
          );
        }
      }
      return this.queue.enqueue(async () => {
        let result: unknown;
        // #458: how many platform intents THIS invoke enqueued. Counted inside the
        // transaction, reported only after commit — a rolled-back intent is no signal.
        // The envelope return (below) is the DO↔coordinator wire for it; both sides
        // live in this package and deploy as one script, so the shape never skews.
        const signals = { platformRequests: 0 };
        // The async transaction is the K-4 boundary: guards + handler + emits
        // commit together, or a throw (from either) rolls domain writes AND
        // emitted events back as one — verified across `await` in workerd.
        try {
          await this.ctx.storage.transaction(async () => {
            const ctx = this.operationContext(
              principal,
              tenantId,
              scopeId,
              undefined,
              connectionId,
              systemModuleId,
              signals,
            );
            await this.runGuards(operation, ctx, input);
            result = await (handler as OperationHandler<unknown, unknown>)(ctx, input);
          });
        } catch (err) {
          // K-35: the transaction has rolled back; record a refused check now, as its own
          // write (outside that transaction), so the denial survives the rollback.
          if (err instanceof PermissionDenied) {
            this.recordDenial(
              systemModuleId
                ? { kind: 'system', id: systemModuleId as ModuleId }
                : connectionId
                  ? { kind: 'connection', id: connectionId }
                  : { kind: 'principal', id: principal },
              tenantId,
              operation,
              err,
            );
          }
          // The ORIGINAL error, deliberately: `invoke` flattens it for the envelope
          // (which keeps its code and extensions) or rewraps it for the legacy throw
          // path. Collapsing it here would lose the structure before either can look.
          throw err;
        }
        // Post-commit: drain the outbox to consumers, each delivery its own txn.
        await this.dispatch(tenantId, scopeId);
        return { result, platformRequests: signals.platformRequests };
      });
    }

    // -- attachments (#473): the metadata half of the attachment surface --------
    // The coordinator (worker) holds the bytes and the per-tenant R2 binding; this
    // DO holds the permission gate and the metadata fact, under the same per-scope
    // serialization and transactional (row + spine event) semantics as an invoke.
    // Bytes never cross this boundary — only the small record does.

    private attachmentGate(entityType: string): { read: PermissionKey; write: PermissionKey } {
      const gate = this.attachmentTargets.get(entityType);
      if (!gate) {
        throw new Error(
          `no registered module declares '${entityType}' in attachmentTargets — attachments ` +
            `bind only to declared entity types`,
        );
      }
      return gate;
    }

    private attachmentRow(attachmentId: string): AttachmentRecord | null {
      const row = this.sql
        .exec('SELECT * FROM _substrat_attachments WHERE id = ?', attachmentId)
        .toArray()[0] as
        | {
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
        | undefined;
      if (!row) return null;
      return attachmentRecord.parse({
        id: row.id,
        entity: { entityType: row.entity_type, entityId: row.entity_id },
        filename: row.filename,
        contentType: row.content_type,
        size: Number(row.size),
        sha256: row.sha256,
        visibility: row.visibility,
        createdBy: row.created_by,
        createdAt: row.created_at,
      });
    }

    /** Record an uploaded attachment: write gate + row + `attachment.added`, one txn. */
    async attachmentAdd(
      record: AttachmentRecord,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      // #476: when set, the gate is checked as this CONNECTION (not `principal`, which is
      // then only the ctx.principal placeholder the connector door passes).
      connectionId?: string,
    ): Promise<AttachmentRecord> {
      await this.ensureMigrations();
      const parsed = attachmentRecord.parse(record);
      const gate = this.attachmentGate(parsed.entity.entityType);
      return this.queue.enqueue(async () => {
        try {
          await this.ctx.storage.transaction(async () => {
            const ctx = this.operationContext(principal, tenantId, scopeId, undefined, connectionId);
            assertAllowed(await ctx.check(gate.write, parsed.entity));
            this.sql.exec(
              `INSERT INTO _substrat_attachments
                 (id, entity_type, entity_id, filename, content_type, size, sha256,
                  visibility, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              parsed.id,
              parsed.entity.entityType,
              parsed.entity.entityId,
              parsed.filename,
              parsed.contentType,
              parsed.size,
              parsed.sha256,
              parsed.visibility,
              parsed.createdBy,
              parsed.createdAt,
            );
            ctx.emit({
              type: ATTACHMENT_ADDED,
              schemaVersion: 1,
              entity: parsed.entity,
              piiClass: 'none',
              payload: { attachment: parsed },
            });
          });
        } catch (err) {
          if (err instanceof PermissionDenied) {
            this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.upload', err);
          }
          throw toRpcError(err);
        }
        await this.dispatch(tenantId, scopeId);
        return parsed;
      });
    }

    /** Records for one entity, newest first — read gate first. */
    async attachmentList(
      entity: EntityRef,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
    ): Promise<AttachmentRecord[]> {
      await this.ensureMigrations();
      const gate = this.attachmentGate(entity.entityType);
      try {
        const ctx = this.operationContext(principal, tenantId, scopeId, undefined, connectionId);
        assertAllowed(await ctx.check(gate.read, entity));
      } catch (err) {
        if (err instanceof PermissionDenied) {
          this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.list', err);
        }
        throw toRpcError(err);
      }
      const rows = this.sql
        .exec(
          `SELECT id FROM _substrat_attachments WHERE entity_type = ? AND entity_id = ?
           ORDER BY id DESC`,
          entity.entityType,
          entity.entityId,
        )
        .toArray() as unknown as { id: string }[];
      return rows.map((r) => this.attachmentRow(r.id)).filter((r): r is AttachmentRecord => r !== null);
    }

    /**
     * Authorize one attachment (`read` before bytes are served, `write` before a remove is
     * attempted elsewhere) and return its record — null for an id this scope does not know.
     */
    async attachmentAuthorize(
      attachmentId: string,
      mode: 'read' | 'write',
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
    ): Promise<AttachmentRecord | null> {
      await this.ensureMigrations();
      const record = this.attachmentRow(attachmentId);
      if (!record) return null;
      const gate = this.attachmentGate(record.entity.entityType);
      try {
        const ctx = this.operationContext(principal, tenantId, scopeId, undefined, connectionId);
        assertAllowed(await ctx.check(mode === 'read' ? gate.read : gate.write, record.entity));
      } catch (err) {
        if (err instanceof PermissionDenied) {
          this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.open', err);
        }
        throw toRpcError(err);
      }
      return record;
    }

    /** Remove an attachment's metadata fact: write gate + delete + `attachment.removed`. */
    async attachmentRemove(
      attachmentId: string,
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      connectionId?: string,
    ): Promise<AttachmentRecord | null> {
      await this.ensureMigrations();
      return this.queue.enqueue(async () => {
        const record = this.attachmentRow(attachmentId);
        if (!record) return null;
        const gate = this.attachmentGate(record.entity.entityType);
        try {
          await this.ctx.storage.transaction(async () => {
            const ctx = this.operationContext(principal, tenantId, scopeId, undefined, connectionId);
            assertAllowed(await ctx.check(gate.write, record.entity));
            this.sql.exec('DELETE FROM _substrat_attachments WHERE id = ?', attachmentId);
            ctx.emit({
              type: ATTACHMENT_REMOVED,
              schemaVersion: 1,
              entity: record.entity,
              piiClass: 'none',
              payload: { attachment: record },
            });
          });
        } catch (err) {
          if (err instanceof PermissionDenied) {
            this.recordDenial(attachSubject(principal, connectionId), tenantId, 'attachments.remove', err);
          }
          throw toRpcError(err);
        }
        await this.dispatch(tenantId, scopeId);
        return record;
      });
    }

    /**
     * Whether this scope holds a live `system:<moduleId>` grant (#383) — the switch
     * that decides if a module's schedules run here at all. Absent on a foreign
     * vertical's scope, or after a per-tenant revoke, so the sweep skips it quietly.
     */
    async hasSystemGrant(moduleId: string): Promise<boolean> {
      const now = new Date().toISOString();
      const row = this.sql
        .exec(
          `SELECT 1 FROM _substrat_tuples
            WHERE subject = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
            LIMIT 1`,
          `system:${moduleId}`,
          now,
        )
        .toArray()[0];
      return row !== undefined;
    }

    /** The last time a schedule's operation ran on this scope (#383), or null. */
    async scheduleLastRun(operation: string): Promise<string | null> {
      const row = this.sql
        .exec(
          `SELECT last_run_at FROM _substrat_schedule_state WHERE schedule_op = ?`,
          operation,
        )
        .toArray()[0] as { last_run_at: string | null } | undefined;
      return row?.last_run_at ?? null;
    }

    /** Record a schedule run's timestamp + outcome (#383). Spine, kernel-written. */
    async recordScheduleRun(operation: string, at: string, status: 'ok' | 'failed'): Promise<void> {
      this.sql.exec(
        `INSERT INTO _substrat_schedule_state (schedule_op, last_run_at, last_status)
           VALUES (?, ?, ?)
         ON CONFLICT(schedule_op) DO UPDATE SET last_run_at = excluded.last_run_at,
                                                last_status = excluded.last_status`,
        operation,
        at,
        status,
      );
    }

    // -- guards (K-17) --------------------------------------------------------

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
          throw new Error(
            `unknown guard predicate: '${guard.predicate}' — declared by ${guard.declaredBy} ` +
              `before '${operation}'; no registered module contributes it (operation blocked)`,
          );
        }
        await predicate.handler(ctx, guard.config, input);
      }
    }

    // -- migrations (port of applyPendingMigrations) --------------------------

    private ensureMigrations(): Promise<boolean> {
      if (!this.migrationPromise) this.migrationPromise = this.applyPendingMigrations();
      return this.migrationPromise;
    }

    /** Resolves true if this call applied at least one migration. */
    private async applyPendingMigrations(): Promise<boolean> {
      const pending: { moduleId: string; migration: SqlMigration }[] = [];
      for (const mod of this.modules.values()) {
        for (const migration of mod.migrations) {
          if (!this.applied.has(`${mod.id}@${migration.version}`)) {
            pending.push({ moduleId: mod.id, migration });
          }
        }
      }
      if (pending.length === 0) return false;
      this.migrationRuns += 1;
      await this.queue.enqueue(async () => {
        // #286: bookmark the instant before an UPGRADE migrates live data — the
        // backout's rewind point. Skipped on first provision (`applied` empty: an
        // empty scope has nothing to rewind to) and where PITR does not exist
        // (local dev, miniflare — the API is production-plane only). Taken inside
        // the queue so no writer can slip between the bookmark and the migration,
        // and committed immediately: if the migration below FAILS, the bookmark
        // row is precisely what survives to back out to.
        const storage = this.ctx.storage as unknown as {
          getCurrentBookmark?: () => Promise<string>;
        };
        if (this.applied.size > 0 && typeof storage.getCurrentBookmark === 'function') {
          try {
            const bookmark = await storage.getCurrentBookmark();
            this.sql.exec(
              `INSERT OR IGNORE INTO _substrat_migration_bookmarks (bookmark, taken_at, pending)
               VALUES (?, ?, ?)`,
              bookmark,
              new Date().toISOString(),
              JSON.stringify(pending.map((p) => `${p.moduleId}@${p.migration.version}`)),
            );
          } catch {
            // A failed bookmark must not block the migration: the scope would fail
            // closed over a safety net, which protects nothing. The backup path
            // (#278) remains the fallback rewind point.
          }
        }
        for (const { moduleId, migration } of pending) {
          const key = `${moduleId}@${migration.version}`;
          if (this.applied.has(key)) continue;
          try {
            await this.ctx.storage.transaction(async () => {
              const already = this.sql
                .exec(
                  'SELECT 1 FROM _substrat_migrations WHERE module_id = ? AND version = ?',
                  moduleId,
                  migration.version,
                )
                .toArray()[0];
              if (!already) {
                for (const stmt of splitSqlStatements(migration.sql)) {
                  this.sql.exec(stmt);
                }
                this.sql.exec(
                  'INSERT INTO _substrat_migrations (module_id, version, applied_at) VALUES (?, ?, ?)',
                  moduleId,
                  migration.version,
                  new Date().toISOString(),
                );
              }
            });
          } catch (err) {
            // Retained so the coordinator can project it into the directory without
            // re-parsing the thrown message. The throw stays: `invoke` awaits
            // `ensureMigrations` on every operation and relies on the rejection to
            // fail closed, so resolving here would serve a half-migrated schema.
            this.lastFailure = { version: key, error: (err as Error).message };
            throw new Error(
              `migration failed for ${key} — scope fails closed: ${(err as Error).message}`,
            );
          }
          this.applied.add(key);
        }
      });
      return true;
    }

    /**
     * Events of `eventType` this delivery target has not yet consumed (K-22 §4.2).
     *
     * Executors run on the COORDINATOR, not here: they act through `HostAdmin`,
     * which is outside this DO. So the drain is a read here, the effect happens
     * there, and `recordExecutorAttempt` journals it afterwards — claiming before
     * running would make delivery at-most-once and lose an effect on any crash in
     * between.
     *
     * "Not yet consumed" means never attempted, or retrying and now due (#100).
     * Terminal rows — delivered or dead-lettered — are excluded by the join.
     */
    pendingExecutorEvents(deliveryId: string, eventType: string): DomainEvent[] {
      const rows = this.sql
        .exec(
          `SELECT o.* FROM _substrat_outbox o
           LEFT JOIN _substrat_deliveries d
             ON d.event_id = o.id AND d.consumer_module = ?
           WHERE o.type = ?
             AND (d.event_id IS NULL
                  OR (d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?))
           ORDER BY o.id`,
          deliveryId,
          eventType,
          new Date().toISOString(),
        )
        .toArray() as unknown as OutboxRow[];
      return rows.map((r) => this.parseOutboxRow(r));
    }

    /**
     * Journal one executor attempt (#100). `error` null means delivered;
     * `nextAttemptAt` null means terminal — so a failed attempt with no next time
     * is a dead letter.
     *
     * Written AFTER the effect, so a crash mid-effect retries rather than silently
     * marking success. The coordinator computes the backoff because it owns the
     * per-executor policy; the DO owns the state.
     */
    recordExecutorAttempt(
      eventId: string,
      deliveryId: string,
      error: string | null,
      nextAttemptAt: string | null,
    ): number {
      const prior = (
        this.sql
          .exec(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
            eventId,
            deliveryId,
          )
          .toArray() as unknown as { attempts: number }[]
      )[0];
      const attempts = (prior?.attempts ?? 0) + 1;
      this.sql.exec(
        `INSERT INTO _substrat_deliveries
           (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, consumer_module) DO UPDATE SET
           delivered_at = excluded.delivered_at,
           error = excluded.error,
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at`,
        eventId,
        deliveryId,
        new Date().toISOString(),
        error,
        attempts,
        nextAttemptAt,
      );
      return attempts;
    }

    /** How many attempts this delivery has already had — the backoff input. */
    executorAttempts(eventId: string, deliveryId: string): number {
      const row = (
        this.sql
          .exec(
            'SELECT attempts FROM _substrat_deliveries WHERE event_id = ? AND consumer_module = ?',
            eventId,
            deliveryId,
          )
          .toArray() as unknown as { attempts: number }[]
      )[0];
      return row?.attempts ?? 0;
    }

    /**
     * Pending platform intents (platform-intents.md) — rows a vertical enqueued via
     * `ctx.requestPlatform` awaiting the platform's drain. Read here; executed on the coordinator
     * with HostAdmin authority (the DO cannot provision); `settlePlatformRequest` journals the
     * outcome afterwards, exactly the executor-drain shape (read here, effect there).
     */
    pendingPlatformRequests(): PlatformRequestRawRow[] {
      return this.sql
        .exec(
          `SELECT id, kind, payload, requested_by, status, attempts, last_error, result, requested_at, settled_at
             FROM _substrat_platform_requests WHERE status = 'pending' ORDER BY id`,
        )
        .toArray() as unknown as PlatformRequestRawRow[];
    }

    /**
     * The intent JOURNAL, newest first (#618) — every intent whatever became of it, where
     * `pendingPlatformRequests` deliberately returns only the drainable ones. A settled row keeps
     * its `last_error` verbatim, and this is the only RPC that hands that back: before it, the full
     * text of a connector's refusal was reachable only through the read-only SQL console with
     * system tables toggled on. The filter/ordering come from the kernel so the DO, the host and
     * `ctx.platformRequests` cannot disagree about what "newest 50 of this kind" means.
     */
    platformRequestHistory(filter?: PlatformRequestFilter): PlatformRequestRawRow[] {
      const q = platformRequestHistoryQuery(filter);
      return this.sql
        .exec(q.sql, ...q.params)
        .toArray() as unknown as PlatformRequestRawRow[];
    }

    /**
     * Journal a platform-request outcome after the coordinator ran it. `status`: 'done' (succeeded),
     * 'failed' (terminal — unknown kind or given up), or 'pending' (transient failure, will retry).
     * `result` is COALESCE'd so a value written on an earlier pass (e.g. a minted sibling scope id,
     * for two-phase idempotency) survives a null on retry. `attempts` bumps each settle; `settled_at`
     * is set only on a terminal outcome.
     */
    settlePlatformRequest(
      id: string,
      status: 'pending' | 'done' | 'failed',
      result: string | null,
      lastError: string | null,
    ): void {
      this.sql.exec(
        `UPDATE _substrat_platform_requests
           SET status = ?, result = COALESCE(?, result), last_error = ?,
               attempts = attempts + 1, settled_at = ?
         WHERE id = ?`,
        status,
        result,
        lastError,
        status === 'pending' ? null : new Date().toISOString(),
        id,
      );
    }

    /**
     * Turn one connector delivery into a `connector:<provider>` platform intent (#574
     * phase 3) — the CP-less host's substitute for running the handler it cannot run.
     * One verb, not two, so the intent insert and the delivery journal commit together:
     * everything here is synchronous SQL in a single RPC, so a crash leaves either both
     * writes or neither, never an intent without its journal row (which would re-route
     * the event on the next drain). Backpressure throws BEFORE any write — the caller
     * records a failed attempt and the delivery retries on its own backoff, exactly as
     * a throwing handler would.
     */
    routeExecutorEventToPlatform(
      eventId: string,
      deliveryId: string,
      kind: string,
      payload: string,
      requestedBy: string,
    ): PlatformRequestId {
      const pending = Number(
        (
          this.sql
            .exec(`SELECT COUNT(*) AS c FROM _substrat_platform_requests WHERE status = 'pending'`)
            .toArray()[0] as { c: number }
        ).c,
      );
      if (pending >= MAX_PENDING_PLATFORM_REQUESTS) {
        throw new Error(
          `too many pending platform requests (${pending}); the delivery retries once some have drained`,
        );
      }
      const id = platformRequestId.parse(ulid());
      this.sql.exec(
        `INSERT INTO _substrat_platform_requests
           (id, kind, payload, requested_by, status, attempts, requested_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
        id,
        kind,
        payload,
        requestedBy,
        instant.parse(new Date().toISOString()),
      );
      this.recordExecutorAttempt(eventId, deliveryId, null, null);
      return id;
    }

    /** Executor deliveries that exhausted their attempts. */
    executorDeadLetters(): {
      eventId: string;
      executorId: string;
      eventType: string;
      attempts: number;
      error: string;
      lastAttemptAt: string;
    }[] {
      const rows = this.sql
        .exec(
          `SELECT d.event_id, d.consumer_module, d.attempts, d.error, d.delivered_at, o.type
           FROM _substrat_deliveries d
           JOIN _substrat_outbox o ON o.id = d.event_id
           WHERE d.consumer_module LIKE 'executor:%'
             AND d.error IS NOT NULL
             AND d.next_attempt_at IS NULL
           ORDER BY d.event_id`,
        )
        .toArray() as unknown as {
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

    // -- read-only introspection (kernel-design §5.4's admin-query RPC) --------
    // The console/dashboard "Data" view reaches THIS scope's own SQLite. Read-only
    // and table-shaped: no caller SQL, only a table name validated against the live
    // schema plus a bounded page, so nothing here can write the spine or inject.
    // Authorization + the (tenantId, scopeId) K-3 cross-check happen on the
    // coordinator BEFORE this RPC is reached (host.ts admin.listScopeTables).

    /** Every table in this scope's DB, with row counts; spine/internal tables flagged. */
    introspectTables(): ScopeTable[] {
      const names = (
        this.sql
          .exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
          .toArray() as unknown as { name: string }[]
      ).map((r) => r.name);
      return names.map((name) => ({
        name,
        rowCount: Number(
          (this.sql.exec(`SELECT COUNT(*) AS c FROM "${name}"`).toArray()[0] as { c: number }).c,
        ),
        system: isSystemTable(name),
      }));
    }

    /** A bounded page of one table. Unknown table names throw — never queried blind. */
    introspectTable(table: string, limit: number, offset: number): ScopeTablePage {
      const known = new Set(
        (
          this.sql
            .exec(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .toArray() as unknown as { name: string }[]
        ).map((r) => r.name),
      );
      if (!known.has(table)) throw new Error(`unknown table '${table}'`);
      const l = Math.min(Math.max(1, limit), SCOPE_TABLE_PAGE_MAX);
      const o = Math.max(0, offset);
      const cursor = this.sql.exec(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, l, o);
      const columns = cursor.columnNames;
      const rows = Array.from(cursor.raw(), (row) => (row as unknown[]).map(cellToJson));
      const rowCount = Number(
        (this.sql.exec(`SELECT COUNT(*) AS c FROM "${table}"`).toArray()[0] as { c: number }).c,
      );
      return { table, columns, rows, rowCount, limit: l, offset: o };
    }

    /**
     * One read-only SQL statement against this scope's DB — the console (#219). User
     * SQL reaches `exec` here, so read-only-ness is enforced in two layers: the
     * kernel's shared textual gate (single statement, read verbs only — the same
     * rejections as the pure adapter), and, because DO `exec` has no read-only flag
     * (no sqlite3_stmt_readonly analogue), a transaction that ALWAYS rolls back — a
     * statement the gate misclassified still cannot persist a write. Rows are capped
     * at SCOPE_QUERY_ROW_MAX with `truncated` set, never an error.
     */
    async introspectQuery(sql: string): Promise<ScopeQueryResult> {
      const stmt = assertReadOnlyQuery(sql);
      let result: ScopeQueryResult | undefined;
      const rollback = new Error('read-only console rollback');
      try {
        await this.ctx.storage.transaction(async () => {
          const cursor = this.sql.exec(stmt);
          const columns = cursor.columnNames;
          const rows: unknown[][] = [];
          let truncated = false;
          for (const row of cursor.raw()) {
            if (rows.length >= SCOPE_QUERY_ROW_MAX) {
              truncated = true;
              break;
            }
            rows.push((row as unknown[]).map(cellToJson));
          }
          result = { columns, rows, truncated };
          // Thrown on success too: the transaction must never commit.
          throw rollback;
        });
      } catch (e) {
        if (e !== rollback) throw toRpcError(e);
      }
      return result!;
    }

    /**
     * A COMPLETE dump of this scope's DB (preview-and-snapshots.md §3) — every table
     * (incl. the `_substrat_*` spine), its DDL, and every row. No `.backup()` on DO
     * SQLite, so this is the logical row-dump; safe because the DO is single-threaded
     * (a consistent snapshot, no concurrent writer). The coordinator wraps these tables
     * with the scope's identity after the K-3 check (host.ts admin.exportScope).
     */
    exportDump(): ScopeDumpTable[] {
      const defs = this.sql
        .exec(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
            ORDER BY name`,
        )
        .toArray() as unknown as { name: string; sql: string }[];
      return defs.map(({ name, sql }) => {
        // Raw positional rows, cells as-is (blobs kept as bytes, not nulled like a UI
        // read) so the dump reloads faithfully. The name is from the live schema.
        const cursor = this.sql.exec(`SELECT * FROM "${name}"`);
        const columns = cursor.columnNames;
        const rows = Array.from(cursor.raw(), (row) => row as unknown[]);
        return { name, ddl: sql, columns, rows };
      });
    }

    /**
     * Load a dump into this (freshly-provisioned) scope — the write half of the fork
     * (host.ts importScope). Drop-then-replay: the dump's schema is authoritative, so
     * the provisioning schema is wiped and rebuilt from the dump verbatim.
     *
     * `destScopeId` is the scope being written INTO. A dump carries scope-level tuples
     * naming the scope it was captured from, so restoring one anywhere else needs them
     * re-pointed — see `rewriteScopeTuples`.
     */
    async importDump(tables: ScopeDumpTable[], destScopeId?: ScopeId): Promise<void> {
      // The WHOLE drop-then-replay runs under deferred foreign keys, in one transaction.
      //
      // Two distinct FK hazards, and both need the deferral — the second is why it cannot
      // wrap the inserts alone:
      //
      //  - Replay order. A dump is ordered by table NAME, which says nothing about foreign
      //    keys: a vertical whose child sorts before its parent (`crm_bank_accounts` before
      //    `crm_vendors`) would fail on its first insert.
      //  - THE DROPS. `DROP TABLE` performs an implicit `DELETE FROM`, so dropping a parent
      //    while a child table still holds rows raises `FOREIGN KEY constraint failed`
      //    before any replacement row exists. This bites only when the TARGET already has
      //    data, which is why it survived the first fix: an empty scope drops cleanly, and
      //    a populated one — the case that matters, since restore exists to overwrite real
      //    data — does not.
      //
      // Deferral holds every check until commit, by which point the old rows are gone and
      // the new ones are all in. It also covers what a topological sort cannot express: FK
      // cycles, and self-referencing rows within a single table.
      await this.ctx.storage.transaction(async () => {
        this.sql.exec('PRAGMA defer_foreign_keys = ON');
        // Real tables only; `sqlite_*` internals are auto-managed and un-droppable.
        const existing = this.sql
          .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
          .toArray() as unknown as { name: string }[];
        for (const { name } of existing) this.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
        for (const t of tables) this.sql.exec(t.ddl);
        for (const t of tables) {
          if (t.rows.length === 0) continue;
          const cols = t.columns.map((c) => `"${c}"`).join(', ');
          const placeholders = t.columns.map(() => '?').join(', ');
          const insert = `INSERT INTO "${t.name}" (${cols}) VALUES (${placeholders})`;
          for (const row of t.rows) this.sql.exec(insert, ...(row as unknown[]));
        }
      });
      // Re-assert the kernel spine (#321). A dump captured from a WORLD that stores some
      // `_substrat_*` tables ELSEWHERE carries only a subset — an `@substrat-run/adapter-
      // sqlite` scope file, for instance, keeps `_substrat_roles`/`_substrat_tenant_tuples`
      // in its DIRECTORY database, so its per-scope dump omits them. Replaying such a dump
      // verbatim would leave this DO missing those spine tables, and the very next
      // permission check would raise a bare `no such table: _substrat_roles`. KERNEL_DDL is
      // all IF NOT EXISTS, so this recreates only what the dump did not carry (empty), and
      // never disturbs a table the dump DID bring. Roles land empty here and are re-projected
      // by the restore's repair leg (host.projectRolesLocal) — the spine's job is only to
      // exist so the checker can read it.
      for (const stmt of splitSqlStatements(KERNEL_DDL)) this.sql.exec(stmt);
      // Re-point the restored grants at THIS scope (after the spine exists, so a dump
      // that carried no tuples table still finds one here).
      if (destScopeId) this.rewriteScopeTuples(destScopeId);
      // The frontier arrived with the dump — refresh the in-memory applied set so a
      // later migrate() builds on the imported state, not the provisioning state.
      this.applied.clear();
      for (const row of this.sql
        .exec('SELECT module_id, version FROM _substrat_migrations')
        .toArray() as unknown as { module_id: string; version: string }[]) {
        this.applied.add(`${row.module_id}@${row.version}`);
      }
    }

    /**
     * Re-point scope-level tuples at the scope they now live in.
     *
     * Scope-level grants are written as `object = scope:<scopeId>` (the owner grant, every
     * role assignment). A dump carries the id of the scope it was captured FROM, so a fork,
     * a restore into a different scope, or #286's migration onto a stable script name all
     * land rows that name a scope this deployment may not even have. Nothing errors — the
     * rows insert fine — but the proof walk never matches them, so `/me` reports a role
     * while every `ctx.check` denies, which is the least debuggable shape this can fail in.
     *
     * Entity-level grants (`object = customer:<id>`) are untouched: those ids travel with
     * the dump and stay valid. Restoring ACROSS TENANTS would need the same treatment for
     * `_substrat_tenant_tuples`, which this does not attempt — a cross-tenant restore is a
     * governed copy, not a repair.
     *
     * `UPDATE OR REPLACE` because (subject, relation, object) is the primary key: if the
     * dump already held a tuple for the destination scope, the rewritten row collapses
     * onto it instead of failing the whole restore.
     */
    private rewriteScopeTuples(destScopeId: ScopeId): void {
      this.sql.exec(
        `UPDATE OR REPLACE _substrat_tuples
            SET object = ?
          WHERE object LIKE 'scope:%' AND object <> ?`,
        `scope:${destScopeId}`,
        `scope:${destScopeId}`,
      );
    }

    /**
     * Wipe this scope's storage — the reap half of deleteSnapshot (preview-and-
     * snapshots.md §9). The fork-only refusal lives on the coordinator (which holds
     * the directory record); this DO just deletes its own bytes. After deleteAll the
     * instance is inert; a stray re-open would rebuild an empty kernel schema, which
     * the directory no longer points at.
     */
    async destroyStorage(): Promise<void> {
      await this.ctx.storage.deleteAll();
      this.applied.clear();
    }

    /**
     * Redact one data subject's payloads from the spine (#37) — the Tier-1 half of an
     * erasure, which is an ordinary UPDATE because Tier 1 is mutable. The crypto half
     * (destroying the key that seals platform-retained copies) is the directory's.
     *
     * The payload goes; the envelope stays — id, type, entity, occurredAt and the
     * pseudonymous subject id. That is master-plan §5.3 held exactly: "pseudonymous keys
     * and transaction facts remain". A timeline still shows that something happened, to
     * what, and when; it no longer shows who, or what was said about them.
     *
     * This is the one sanctioned write that mutates the outbox. It is kernel code, not
     * module code, and an erasure request is precisely the case the append-only rule has
     * to yield to — the alternative is telling a data subject that the spine's convenience
     * outranks their Article 17 right.
     */
    async redactSubject(subjectId: string): Promise<number> {
      const doomed = (
        this.sql
          .exec(
            `SELECT id FROM _substrat_outbox
              WHERE subject_id = ? AND pii_class != 'none' AND payload IS NOT NULL`,
            subjectId,
          )
          .toArray() as unknown as { id: string }[]
      ).map((r) => r.id);
      for (const id of doomed) {
        this.sql.exec('UPDATE _substrat_outbox SET payload = NULL WHERE id = ?', id);
      }
      return doomed.length;
    }

    // -- event dispatch (port of dispatch) ------------------------------------

    private async dispatch(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
      for (let round = 0; round < 50; round++) {
        let deliveredAny = false;
        for (const mod of this.modules.values()) {
          for (const consumer of mod.consumers) {
            const rows = this.sql
              .exec(
                `SELECT * FROM _substrat_outbox o
                 WHERE o.type = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM _substrat_deliveries d
                     WHERE d.event_id = o.id AND d.consumer_module = ?
                   )
                 ORDER BY o.id`,
                consumer.eventType,
                mod.id,
              )
              .toArray() as unknown as OutboxRow[];
            for (const row of rows) {
              const event = this.parseOutboxRow(row);
              try {
                await this.ctx.storage.transaction(async () => {
                  const ctx = this.operationContext(this.systemPrincipal, tenantId, scopeId, {
                    system: mod.id,
                  });
                  await consumer.handler(ctx, event);
                  this.sql.exec(
                    `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at)
                     VALUES (?, ?, ?)`,
                    event.id,
                    mod.id,
                    new Date().toISOString(),
                  );
                });
                deliveredAny = true;
              } catch (err) {
                // Dead-letter (v0): journal the failure so one poison event
                // can't wedge the loop. Written outside the rolled-back txn.
                this.sql.exec(
                  `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error)
                   VALUES (?, ?, ?, ?)`,
                  event.id,
                  mod.id,
                  new Date().toISOString(),
                  String(err),
                );
              }
            }
          }
        }
        if (!deliveredAny) return;
      }
    }

    /**
     * K-35: record a refused check into the scope's denial log. Called from the invoke
     * catch after the storage transaction has rolled back, so this write is its own and
     * survives — the whole point, since the denial is the write the operation could not make.
     */
    private recordDenial(
      subject: CheckSubject,
      tenantId: TenantId,
      operation: string,
      err: PermissionDenied,
    ): void {
      // Only an ENFORCED denial (assertAllowed, which attaches the checked permission +
      // node) is recorded. A module's own hand-thrown `new PermissionDenied('…')` carries
      // no permission key and is left to the module.
      if (!err.permission || !err.node) return;
      const actor =
        subject.kind === 'system'
          ? { system: subject.id }
          : subject.kind === 'connection'
            ? { connection: subject.id }
            : (subject.id as PrincipalId);
      this.sql.exec(
        `INSERT INTO _substrat_denials
           (id, actor, permission, tenant_id, scope_id, operation, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

    // -- operation context (port of operationContext) -------------------------

    private operationContext(
      principal: PrincipalId,
      tenantId: TenantId,
      scopeId: ScopeId,
      systemActor?: { system: string },
      connectionId?: string,
      systemModuleId?: string,
      /** #458: per-invoke tally of `ctx.requestPlatform` calls; absent for consumer dispatch. */
      signals?: { platformRequests: number },
    ): OperationContext {
      const checker = this.checker;
      const relations = this.relations;
      const sql = this.sql;
      // The permission subject and the derived event actor for a NON-override caller
      // (#383/#97): a scheduled module, a connection, or a person. `systemActor` (the
      // override, used only by consumer dispatch) stays a separate bypass path below.
      const subject: CheckSubject = systemModuleId
        ? { kind: 'system', id: systemModuleId as ModuleId }
        : connectionId
          ? { kind: 'connection', id: connectionId }
          : { kind: 'principal', id: principal };
      const derivedActor =
        subject.kind === 'system'
          ? { system: subject.id }
          : subject.kind === 'connection'
            ? { connection: subject.id }
            : principal;
      // #304: entitlement reads pick the same local-vs-RPC reader the permission checker
      // uses (projected scope → local table; console-managed → CP over RPC), resolved per
      // call so a scope that flips to 'local' is picked up without rebuilding the context.
      const entitlementReader = () => this.controlPlaneReader();
      // K-34: the checks that passed in THIS operation (a fresh context is built per
      // invoke, so this does not leak across operations). `emit` snapshots it; a
      // system/override actor is unconditionally allowed, so its checks are not recorded.
      const passed: EventAuthorization[] = [];

      /**
       * The scope host's half of `ctx.atomic` (#770) — everything else is the
       * kernel's (`createAtomic`).
       *
       * The DO runtime FORBIDS `SAVEPOINT` through `sql.exec` outright ("please
       * use the state.storage.transaction() or state.storage.transactionSync()
       * APIs"), so this is not the pure adapter's mechanism spelled differently:
       * it is the nested async transaction, which workerd rolls back correctly
       * even across an `await`. `depth` is therefore unused here — the runtime
       * owns that stack itself. It is exactly this asymmetry that makes `RunSub`
       * closure-shaped rather than an enter/rollback/release triple.
       */
      const runSub: RunSub = (_depth, fn) => this.ctx.storage.transaction(fn);

      // Lifted so `grant` reuses the SAME check the operation itself passes —
      // a delegation check that could differ from the operation's would be a
      // second opinion about what the caller holds.
      const runCheck = async (permission: PermissionKey, entity?: EntityRef) => {
        if (systemActor) {
          return {
            allowed: true as const,
            proof: [
              {
                subject: objectRef.parse(
                  `system:${systemActor.system.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
                ),
                relation: `granted:${permission}`,
                object: objectRef.parse(`scope:${scopeId}`),
              },
            ],
          };
        }
        const decision = await checker.check(subject, permission, { tenantId, scopeId }, entity);
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
        tenantId,
        scopeId,
        principal,
        sql: doScopedSql(sql),
        emit: (event: DomainEventInput) => {
          const parsed = domainEventInput.parse(event);
          const full = domainEvent.parse({
            ...parsed,
            id: eventId.parse(ulid()),
            occurredAt: instant.parse(new Date().toISOString()),
            tenantId,
            scopeId,
            actor: systemActor ?? derivedActor,
            ...(passed.length ? { authorization: passed.map((p) => ({ ...p })) } : {}),
          });
          sql.exec(
            `INSERT INTO _substrat_outbox
               (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
                entity_type, entity_id, pii_class, subject_id, authorization, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          const pending = Number(
            (
              sql
                .exec(`SELECT COUNT(*) AS c FROM _substrat_platform_requests WHERE status = 'pending'`)
                .toArray()[0] as { c: number }
            ).c,
          );
          if (pending >= MAX_PENDING_PLATFORM_REQUESTS) {
            throw new Error(`too many pending platform requests (${pending}); retry once some have drained`);
          }
          const id = platformRequestId.parse(ulid());
          const requestedBy = systemActor ?? derivedActor;
          sql.exec(
            `INSERT INTO _substrat_platform_requests
               (id, kind, payload, requested_by, status, attempts, requested_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
            id,
            input.kind,
            JSON.stringify(input.payload ?? null),
            JSON.stringify(requestedBy),
            instant.parse(new Date().toISOString()),
          );
          if (signals) signals.platformRequests += 1;
          return id;
        },
        // The read half of `requestPlatform` (#618) — this scope's own journal, so no tenancy
        // predicate is needed or possible: the DO IS the scope.
        platformRequests: (filter?: PlatformRequestFilter): PlatformRequest[] => {
          const q = platformRequestHistoryQuery(filter);
          return (sql.exec(q.sql, ...q.params).toArray() as unknown as PlatformRequestRawRow[]).map(
            rowToPlatformRequest,
          );
        },
        check: runCheck,
        /**
         * Delegate a permission this caller holds onto one entity — see the
         * kernel's `OperationContext.grant` for why the verb exists.
         *
         * Same two guardrails as the pure adapter: entity-narrowed only, and
         * re-checked against the caller's own decision so it delegates rather
         * than elevates.
         */
        grant: async (principal: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
          const held = await runCheck(permission, entity);
          if (!held.allowed) {
            throw new PermissionDenied(
              `cannot grant '${permission}' on ${entity.entityType}:${entity.entityId} — ` +
                'the caller does not hold it there (a grant delegates, it never elevates)',
            );
          }
          sql.exec(
            `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)`,
            `principal:${principal}`,
            `granted:${permission}`,
            `${entity.entityType}:${entity.entityId}`,
          );
        },
        revoke: async (principal: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
          const held = await runCheck(permission, entity);
          if (!held.allowed) {
            throw new PermissionDenied(
              `cannot revoke '${permission}' on ${entity.entityType}:${entity.entityId} — ` +
                'the caller does not hold it there',
            );
          }
          sql.exec(
            `DELETE FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?`,
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
          sql.exec(
            `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object)
             VALUES (?, 'parent', ?)`,
            `${child.entityType}:${child.entityId}`,
            `${parent.entityType}:${parent.entityId}`,
          );
        },
        entitlement: async (key: string): Promise<EntitlementView | null> => {
          const held = await entitlementReader().listEntitlements(tenantId);
          return held.find((e) => e.key === key) ?? null;
        },
        entitlements: (): Promise<EntitlementView[]> => entitlementReader().listEntitlements(tenantId),
        // #687: seal a value to the connector that will receive it. Reads the PROJECTED
        // public key — the only half a scope ever holds — so a hosted vertical needs no
        // control-plane binding for this, exactly as it needs none for entitlements.
        //
        // Refuses rather than degrades when nothing is projected. A silently contactless
        // request is today's invisible failure in a new hat: the document starts at the
        // provider and reaches nobody, and nothing in the system says so.
        sealToConnection: async (provider: string, plaintext: string) => {
          const row = this.sql
            .exec(
              `SELECT key_id, public_key FROM _substrat_connection_keys
               WHERE tenant_id = ? AND provider = ?`,
              tenantId,
              provider,
            )
            .toArray()[0] as unknown as { key_id: string; public_key: string } | undefined;
          if (!row) {
            throw new ConnectionSealingKeyUnavailableError(
              provider,
              noSealingKeyMessage(provider, scopeId),
            );
          }
          return sealTo({ keyId: row.key_id, publicKey: row.public_key }, plaintext);
        },
      };
    }

    /** True once this scope has had entitlements projected at least once (#304) — the switch
     *  from trust-upstream to strict fail-closed entitlement enforcement on the local path. */
    private entitlementsEnforced(): boolean {
      const row = this.sql
        .exec(`SELECT value FROM _substrat_meta WHERE key = 'entitlements_enforced'`)
        .toArray()[0] as { value: string } | undefined;
      return row?.value === '1';
    }

    /** 'local' once this scope has been projected, else 'control-plane' (default). */
    private permissionSource(): 'local' | 'control-plane' {
      const row = this.sql
        .exec(`SELECT value FROM _substrat_meta WHERE key = 'permission_source'`)
        .toArray()[0] as { value: string } | undefined;
      return row?.value === 'local' ? 'local' : 'control-plane';
    }

    /**
     * The checker's tenant-tuple/role reader. Chosen **per call** (the source can
     * flip at runtime, and the checker holds this wrapper for the DO's lifetime):
     * a projected scope — or one with no `CONTROL_PLANE` binding to read — evaluates
     * from LOCAL storage (scope-local permissions); otherwise it reads the shared
     * directory DO over RPC (the pre-projection behaviour). Reading the marker is a
     * cheap local indexed lookup.
     */
    private controlPlaneReader(): ControlPlaneReader {
      const pick = (): ControlPlaneReader => {
        const ns = this.env.CONTROL_PLANE;
        if (this.permissionSource() === 'local' || !ns) {
          return createLocalControlPlaneReader(this.sql);
        }
        const stub = ns.get(ns.idFromName('control-plane')) as unknown as ControlPlaneReader;
        // The CP DO's `listEntitlements` returns raw rows (all keys, incl. expired) — a
        // different shape than the reader's view, so it is reached through a raw cast and
        // filtered/mapped here. Expiry is applied at read, matching the local reader.
        const rawStub = stub as unknown as {
          listEntitlements(tenantId: string): Promise<
            { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[]
          >;
        };
        return {
          tenantTuples: (tenantId, subject, relationPrefix) =>
            stub.tenantTuples(tenantId, subject, relationPrefix),
          getRole: (tenantId, key) => stub.getRole(tenantId, key),
          listEntitlements: async (tenantId): Promise<EntitlementView[]> => {
            const now = new Date().toISOString();
            return (await rawStub.listEntitlements(tenantId))
              .filter((r) => r.expires_at === null || r.expires_at > now)
              .map((r) => ({
                key: r.entitlement_key,
                plan: r.plan,
                quota: r.quota,
                expiresAt: r.expires_at as EntitlementView['expiresAt'],
              }));
          },
        };
      };
      return {
        tenantTuples: (tenantId, subject, relationPrefix) => pick().tenantTuples(tenantId, subject, relationPrefix),
        getRole: (tenantId, key) => pick().getRole(tenantId, key),
        listEntitlements: (tenantId) => pick().listEntitlements(tenantId),
      };
    }

    // -- scope-local permission projection (docs/architecture/scope-local-permissions.md) --
    // The write side of the local reader: the coordinator fans role/tuple changes
    // into a scope's own storage (Phase 2), then flips the source to 'local'. Public
    // RPC methods so `CloudflareScopeHost` (and the projection sweep) can call them.

    /** Project (upsert) a role definition into this scope. */
    async projectRole(tenantId: string, role: { key: string; permissions: string[]; source: string }): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source, revoked_at)
           VALUES (?, ?, ?, ?, NULL)`,
          tenantId,
          role.key,
          JSON.stringify(role.permissions),
          role.source,
        );
      });
    }

    /** Tombstone a projected role — it stops granting but stays as evidence (K-21). */
    async revokeProjectedRole(tenantId: string, key: string, revokedAt: string): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `UPDATE _substrat_roles SET revoked_at = ? WHERE tenant_id = ? AND role_key = ?`,
          revokedAt,
          tenantId,
          key,
        );
      });
    }

    /** Project (upsert) a tenant-level tuple into this scope. `revokedAt` tombstones it. */
    async projectTenantTuple(
      tenantId: string,
      subject: string,
      relation: string,
      object: string,
      expiresAt: string | null,
      revokedAt: string | null = null,
    ): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_tenant_tuples
             (tenant_id, subject, relation, object, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          tenantId,
          subject,
          relation,
          object,
          expiresAt,
          revokedAt,
        );
      });
    }

    /** Flip which reader the checker uses. 'local' makes projections authoritative. */
    async setPermissionSource(source: 'local' | 'control-plane'): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('permission_source', ?)`,
          source,
        );
      });
    }

    /**
     * Replace this scope's projected view of a tenant's roles + tenant-level tuples
     * with a fresh snapshot, and make it authoritative (source = 'local'). A full
     * replace so it converges regardless of prior state — the coordinator's fan-out
     * and the reconciliation sweep both call it (scope-local-permissions.md Phase 2).
     * One enqueued unit, so no half-applied projection is ever visible to a check.
     */
    async applyProjection(
      tenantId: string,
      roles: { role_key: string; permissions: string; source: string }[],
      tuples: { subject: string; relation: string; object: string; expires_at: string | null; revoked_at: string | null }[],
      /** The tenant's entitlements (#304) — projected alongside roles/tuples so a hosted
       *  vertical reads them locally. **Preserve-on-undefined**: omitting it (a role-only
       *  re-projection like the restore repair) leaves the projected entitlements untouched,
       *  while passing a list — even `[]` — full-replaces them. This keeps pre-#304 callers
       *  from silently wiping a scope's entitlements. */
      entitlements?: { entitlement_key: string; expires_at: string | null; quota: number | null; plan: string | null }[],
      /** Scope-level tuples (e.g. the owner's role grant at provision) upserted into
       *  `_substrat_tuples` in this SAME transaction, additively (#332). Preserve-on-undefined:
       *  omitting it leaves existing scope tuples untouched, so a role-only re-projection keeps
       *  the owner grant. Passing them here (rather than a follow-up `writeTuple`) is what makes
       *  provision atomic — the grant and the enforcement flip land together or not at all. */
      scopeTuples?: { subject: string; relation: string; object: string; expires_at: string | null }[],
      /** The tenant's identity links (#406) — projected alongside the rest so a CP-less
       *  vertical's auth adapter resolves logins locally. Same preserve-on-undefined
       *  convention as `entitlements`: omitting it (a role-only re-projection like the
       *  restore repair) leaves projected links untouched; passing a list — even `[]` —
       *  full-replaces them, which is how an unlink reaches the scope. */
      identities?: { provider: string; external_id: string; principal_id: string; scope_id: string | null }[],
      /** Live connections' PUBLIC sealing keys (#687) — projected alongside the rest so a
       *  CP-less vertical can seal a value to a connector before emitting it. Same
       *  preserve-on-undefined convention as `entitlements` and `identities`: omitting it
       *  (a role-only re-projection like the restore repair) leaves projected keys
       *  untouched; passing a list — even `[]` — full-replaces them, which is how a
       *  revoked connection stops being sealable to. */
      connectionKeys?: { connection_id: string; provider: string; key_id: string; public_key: string }[],
    ): Promise<void> {
      await this.queue.enqueue(() => {
        this.sql.exec(`DELETE FROM _substrat_roles WHERE tenant_id = ?`, tenantId);
        for (const r of roles) {
          this.sql.exec(
            `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source, revoked_at)
             VALUES (?, ?, ?, ?, NULL)`,
            tenantId,
            r.role_key,
            r.permissions,
            r.source,
          );
        }
        this.sql.exec(`DELETE FROM _substrat_tenant_tuples WHERE tenant_id = ?`, tenantId);
        for (const t of tuples) {
          this.sql.exec(
            `INSERT OR REPLACE INTO _substrat_tenant_tuples
               (tenant_id, subject, relation, object, expires_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            tenantId,
            t.subject,
            t.relation,
            t.object,
            t.expires_at,
            t.revoked_at,
          );
        }
        if (entitlements !== undefined) {
          this.sql.exec(`DELETE FROM _substrat_entitlements WHERE tenant_id = ?`, tenantId);
          for (const e of entitlements) {
            this.sql.exec(
              `INSERT OR REPLACE INTO _substrat_entitlements
                 (tenant_id, entitlement_key, expires_at, quota, plan)
               VALUES (?, ?, ?, ?, ?)`,
              tenantId,
              e.entitlement_key,
              e.expires_at,
              e.quota,
              e.plan,
            );
          }
          // #304: once a scope has been projected WITH entitlements even once, its gate
          // switches from trust-upstream to strict fail-closed (a missing/expired key
          // denies). Left unset, a scope provisioned before #304 keeps trusting upstream
          // until a projection (fanOut / reconcile / re-provision) back-fills it — so the
          // enforcement flip is per-scope and never strands an un-back-filled scope.
          this.sql.exec(
            `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('entitlements_enforced', '1')`,
          );
        }
        // #406: identity links ride the same snapshot. Full replace, so an unlink is
        // durable against every later projection — unlike the compiled-in map this
        // replaces, where a version rollback silently resurrected a removed login.
        if (identities !== undefined) {
          this.sql.exec(`DELETE FROM _substrat_identity_links WHERE tenant_id = ?`, tenantId);
          for (const i of identities) {
            this.sql.exec(
              `INSERT OR REPLACE INTO _substrat_identity_links
                 (tenant_id, provider, external_id, principal_id, scope_id)
               VALUES (?, ?, ?, ?, ?)`,
              tenantId,
              i.provider,
              i.external_id,
              i.principal_id,
              i.scope_id,
            );
          }
        }
        // #687: connection sealing keys ride the same snapshot. Full replace, so a
        // revoked connection's key stops being projected and `sealToConnection` starts
        // refusing — the same fail-closed direction an unlinked identity takes.
        if (connectionKeys !== undefined) {
          this.sql.exec(`DELETE FROM _substrat_connection_keys WHERE tenant_id = ?`, tenantId);
          for (const k of connectionKeys) {
            this.sql.exec(
              `INSERT OR REPLACE INTO _substrat_connection_keys
                 (tenant_id, connection_id, provider, key_id, public_key)
               VALUES (?, ?, ?, ?, ?)`,
              tenantId,
              k.connection_id,
              k.provider,
              k.key_id,
              k.public_key,
            );
          }
        }
        // #332: scope-level grants (the owner's role tuple at provision) are written in the
        // SAME enqueued unit as the projection and the enforcement flip below. Additive upsert
        // — NOT a full replace — so existing scope tuples are preserved. This is what keeps a
        // scope from ever being left "roles projected, permission_source=local, zero tuples" by
        // a write that lands the projection but drops before a follow-up owner grant.
        for (const st of scopeTuples ?? []) {
          this.sql.exec(
            `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at)
             VALUES (?, ?, ?, ?, NULL)`,
            st.subject,
            st.relation,
            st.object,
            st.expires_at,
          );
        }
        // #332: only switch on strict local enforcement when SOMEONE actually holds a role.
        // A projection that leaves role definitions but no live principal→role grant would make
        // every check fail closed — a scope serving nothing but denials, unfixable from inside.
        // Leave `permission_source` as-is instead; a reconcile that restores the owner grant
        // re-runs this and flips safely. (A CP-less vertical uses the local reader regardless of
        // this flag, so the owner grant is written above in the same unit — this guard is the
        // belt to that suspenders, and it protects the CP-backed flip outright.)
        if (roles.length > 0 && !this.hasLiveRoleGrant(tenantId)) return;
        this.sql.exec(
          `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('permission_source', 'local')`,
        );
      });
    }

    /**
     * Resolve an external identity from this scope's projected links (#406) — the
     * CP-less auth adapter's read path, the local equivalent of the control plane's
     * `resolveIdentity`. A miss is `undefined`, which the caller must treat as an
     * unknown login (deny): an un-projected or stale-empty scope can only ever
     * refuse a legitimate login, never admit a revoked one.
     */
    async resolveProjectedIdentity(
      tenantId: string,
      provider: string,
      externalId: string,
    ): Promise<{ principal: string; scopeId: string | null } | undefined> {
      const row = this.sql
        .exec(
          `SELECT principal_id, scope_id FROM _substrat_identity_links
           WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
          tenantId,
          provider,
          externalId,
        )
        .toArray()[0] as unknown as { principal_id: string; scope_id: string | null } | undefined;
      if (!row) return undefined;
      return { principal: row.principal_id, scopeId: row.scope_id };
    }

    /** True if any live (non-revoked, unexpired) principal→role grant exists for this tenant,
     *  at scope OR tenant level — the precondition for switching on strict local enforcement so a
     *  projection never enables fail-closed evaluation against an empty tuple table (#332). */
    private hasLiveRoleGrant(tenantId: string): boolean {
      const now = new Date().toISOString();
      const scope = this.sql
        .exec(
          `SELECT 1 FROM _substrat_tuples
           WHERE relation LIKE 'role:%' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
           LIMIT 1`,
          now,
        )
        .toArray();
      if (scope.length > 0) return true;
      return (
        this.sql
          .exec(
            `SELECT 1 FROM _substrat_tenant_tuples
             WHERE tenant_id = ? AND relation LIKE 'role:%' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
             LIMIT 1`,
            tenantId,
            now,
          )
          .toArray().length > 0
      );
    }
  };
}
