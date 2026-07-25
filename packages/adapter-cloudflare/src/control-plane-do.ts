import { DurableObject } from 'cloudflare:workers';
import type {
  AdminLogEntry,
  RoleDefinition,
  ScopeStatus,
  Tenant,
  TenantStatus,
} from '@substrat-run/contracts';

/**
 * The durable directory (control-plane.md §4). One singleton DO, backed by its
 * own SQLite, is the WHOLE directory: the tenant registry, scope lifecycle,
 * roles, tenant-level relation tuples, entitlements, identities, and the admin
 * audit log. The coordinator (`CloudflareScopeHost`) is a stateless async router
 * that `await`s RPCs to here — nothing directory-shaped lives in the Worker
 * isolate anymore. A ScopeDO's permission checker reads `getRole`/`tenantTuples`
 * from here for the tenant-level rows it cannot reach locally.
 *
 * Every method is synchronous DO SQL; the RPC layer makes them awaitable. The
 * fail-closed cases THROW plain `Error`s (never a ZodError — the coordinator does
 * all the Zod parsing before calling in), so the message survives the RPC hop.
 * Effect methods return what the coordinator needs for the audit entry to spare
 * it a read round-trip.
 *
 * Tuple placement follows the pure adapter's checker verbatim (§4.2): scope +
 * entity tuples in the ScopeDO, tenant tuples + roles here.
 */

interface TupleRow {
  subject: string;
  relation: string;
  object: string;
  expires_at: string | null;
}

interface TenantRow {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

/** The raw role row; `permissions` is a JSON blob in a TEXT column. */
/** A connection row as the DO stores it (#101). Never carries the credential. */
export interface ConnectionDoRow {
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

export interface RoleRow {
  tenant_id: string;
  role_key: string;
  permissions: string;
  source: string;
}

/** The raw directory row; the coordinator maps it through the `scope` contract. */
export interface ScopeRow {
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
  created_at: string;
}

export interface HostnameRow {
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
}

export interface VerticalRow {
  slug: string;
  name: string;
  source: string;
  owner_tenant: string | null;
  /** The vertical's declared env-spec, as a JSON string (or null). */
  env_spec: string | null;
  /** Registry-driven install (marketplace-publish.md): {entitlements, ownerGrants, provides,
   *  requires} as one JSON string (or null). */
  install_spec: string | null;
  created_at: string;
}

export interface VersionRow {
  id: string;
  vertical_slug: string;
  version: string;
  manifest_digest: string;
  permission_digest: string;
  migration_digest: string;
  deployment_ref: string | null;
  admission: string;
  admission_note: string | null;
  created_at: string;
}

export interface ChannelRow {
  vertical_slug: string;
  channel: string;
  version_id: string;
  updated_at: string;
}

export interface OrgRow {
  org_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface AccessLogRow {
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

/** The audit filter, flattened for the RPC hop (`action` always an array or absent). */
export interface AuditLogQuery {
  tenantId?: string;
  scopeId?: string;
  actor?: string;
  action?: string[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** The shape the coordinator hands `recordAdmin`; before/after are arbitrary JSON. */
export interface AdminEntryInput {
  id: string;
  actor: string;
  action: string;
  /** Null for platform-level actions that target no tenant (K-23). */
  tenantId: string | null;
  /** The event that caused this action, when one did (K-22 §4.2). */
  causedBy?: string | null;
  scopeId: string | null;
  vertical: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

const DIRECTORY_DDL = `
  CREATE TABLE IF NOT EXISTS tenants (
    tenant_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  -- slug/kind/name/vertical are nullable here but required (except vertical) by
  -- the scope contract — the column set must match whether the table was created
  -- fresh or ALTERed up (see ensureDirectoryColumns), and SQLite cannot ADD a NOT
  -- NULL column to a populated table. Zod is the enforcement point on read.
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
    -- Last FAILED migration attempt (§5.3). All null / 0 = healthy. Written on the
    -- failure path so a scope that fails closed stops rendering as active, and
    -- cleared on the next success. See ScopeDO.applyPendingMigrations.
    -- (No semicolons in this comment — see the NOTE below.)
    migration_failed_version TEXT,
    migration_error TEXT,
    migration_attempts INTEGER NOT NULL DEFAULT 0,
    migration_last_attempt_at TEXT,
    created_at TEXT NOT NULL
  );
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
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS hostnames_scope ON hostnames (scope_id, surface);
  CREATE TABLE IF NOT EXISTS verticals (
    slug         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    source       TEXT NOT NULL,
    owner_tenant TEXT,
    -- The vertical's declared env-spec (moduleManifest.envSpec) as JSON — a host/console
    -- renders a config form from it for any registered vertical. NULL = declares none.
    env_spec     TEXT,
    -- Registry-driven install (marketplace-publish.md §3): {entitlements, ownerGrants,
    -- provides, requires} as one JSON blob. NULL = none declared.
    install_spec TEXT,
    created_at   TEXT NOT NULL
  );
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
    created_at        TEXT NOT NULL,
    UNIQUE (vertical_slug, version)
  );
  CREATE TABLE IF NOT EXISTS vertical_channels (
    vertical_slug TEXT NOT NULL,
    channel       TEXT NOT NULL,
    version_id    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (vertical_slug, channel)
  );
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
    -- K-21: revocation TOMBSTONES. The row stays and the walk skips it, because a
    -- tuple that once granted access is evidence of why an access was allowed
    -- (K-4) and D-32's compliance product must produce that evidence.
    -- (No semicolons in this comment — see the NOTE below.)
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
  CREATE TABLE IF NOT EXISTS _substrat_entitlements (
    tenant_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    PRIMARY KEY (tenant_id, entitlement_key)
  );
  CREATE TABLE IF NOT EXISTS _substrat_identity_pools (
    provider   TEXT PRIMARY KEY,
    topology   TEXT NOT NULL,
    tenant_id  TEXT,
    created_at TEXT NOT NULL
  );
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
  CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connections_live
    ON _substrat_connections (tenant_id, vertical, provider)
    WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS _substrat_connection_secrets (
    connection_id TEXT PRIMARY KEY,
    key_id        TEXT NOT NULL,
    ciphertext    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS _substrat_access_log (
    id           TEXT PRIMARY KEY,
    actor        TEXT NOT NULL,
    method       TEXT NOT NULL,
    tenant_id    TEXT,
    scope_id     TEXT,
    params       TEXT,
    result_count INTEGER NOT NULL,
    drained_at   TEXT,
    at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _substrat_access_log_actor ON _substrat_access_log (actor, id);
  CREATE INDEX IF NOT EXISTS _substrat_access_log_tenant ON _substrat_access_log (tenant_id, id);
  CREATE TABLE IF NOT EXISTS _substrat_admin_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    -- Nullable for platform-level actions that target no tenant (K-23).
    tenant_id TEXT,
    scope_id TEXT,
    vertical TEXT,
    before TEXT,
    after TEXT,
    -- The event that caused this action, when one did (K-22 §4.2) — the join
    -- between the connector seam's emit half and its effect half.
    caused_by TEXT,
    at TEXT NOT NULL
  );
  -- Read-path indexes for the console (control-plane.md §4.5). The admin log is
  -- append-only and only grows, so every filter it offers needs one.
  -- NOTE: keep every comment in this DDL free of semicolons. The constructor
  -- splits this string on the statement separator, and a semicolon inside a
  -- comment strands a comment-only fragment that execs as "no statement".
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_tenant ON _substrat_admin_log (tenant_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_scope ON _substrat_admin_log (scope_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_actor ON _substrat_admin_log (actor, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_action ON _substrat_admin_log (action, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_at ON _substrat_admin_log (at);
  CREATE INDEX IF NOT EXISTS scopes_tenant ON scopes (tenant_id, scope_id);
`;

/** The scope columns added after the directory's first shape shipped. */
const SCOPE_COLUMNS_ADDED = [
  'parent_scope_id TEXT',
  'slug TEXT',
  'kind TEXT',
  'name TEXT',
  'vertical TEXT',
  'vertical_version_id TEXT',
  'migration_failed_version TEXT',
  'migration_error TEXT',
  'migration_attempts INTEGER NOT NULL DEFAULT 0',
  'migration_last_attempt_at TEXT',
] as const;

export class ControlPlaneDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    for (const stmt of DIRECTORY_DDL.split(';')) {
      const s = stmt.trim();
      if (s) this.sql.exec(s);
    }
    this.ensureDirectoryColumns();
  }

  /**
   * The directory's own migration path (control-plane.md §7). A singleton DO that
   * was created before the scope record grew its naming columns keeps its storage
   * across a deploy, so the DDL above — all `IF NOT EXISTS` — would leave it on
   * the old shape. ALTER the columns in, backfill to the same defaults
   * `resolveScopeRecord` applies, then add the uniqueness the contract claims.
   *
   * The ALTER is attempted-and-tolerated rather than guarded by a column probe:
   * DO SQLite restricts PRAGMA, so `table_info` is not reliably available here
   * (the pure adapter, which has it, probes instead). A duplicate column is the
   * expected steady state on every cold start after the first — anything else
   * rethrows.
   */
  /** Attempt-and-tolerate ALTER — DO SQLite restricts PRAGMA, so no column probe. */
  private addColumn(table: string, ddl: string): void {
    try {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }

  /**
   * Rebuild `_substrat_identities` when it still carries the pre-K-22 global key
   * (§4.3: a globally-keyed identity mapping is a cross-tenant identity bleed). A
   * PRIMARY KEY cannot be ALTERed, so this is create-copy-drop-rename.
   *
   * Detected from `sqlite_master.sql`, which works here as well as in the pure
   * adapter — DO SQLite restricts PRAGMA, so this is the one detection strategy both
   * adapters can share. Rows already carry `tenant_id`, so the copy is lossless.
   */
  private ensureIdentityKey(): void {
    const row = this.sql
      .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", '_substrat_identities')
      .toArray()[0] as unknown as { sql: string } | undefined;
    if (!row || row.sql.includes('PRIMARY KEY (tenant_id, provider, external_id)')) return;
    for (const stmt of [
      `CREATE TABLE _substrat_identities_new (
         provider     TEXT NOT NULL,
         external_id  TEXT NOT NULL,
         principal_id TEXT NOT NULL,
         tenant_id    TEXT NOT NULL,
         scope_id     TEXT,
         created_at   TEXT NOT NULL,
         PRIMARY KEY (tenant_id, provider, external_id)
       )`,
      `INSERT OR IGNORE INTO _substrat_identities_new
         (provider, external_id, principal_id, tenant_id, scope_id, created_at)
         SELECT provider, external_id, principal_id, tenant_id, scope_id, created_at
         FROM _substrat_identities`,
      'DROP TABLE _substrat_identities',
      'ALTER TABLE _substrat_identities_new RENAME TO _substrat_identities',
    ]) {
      this.sql.exec(stmt);
    }
  }

  /**
   * Drop the admin log's `tenant_id NOT NULL` (K-23) — same create-copy-drop-rename
   * as the identity key, detected the same way. Rows copy verbatim.
   */
  private ensureAdminLogTenantNullable(): void {
    const row = this.sql
      .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", '_substrat_admin_log')
      .toArray()[0] as unknown as { sql: string } | undefined;
    if (!row || !/tenant_id TEXT NOT NULL/.test(row.sql)) return;
    for (const stmt of [
      `CREATE TABLE _substrat_admin_log_new (
         id TEXT PRIMARY KEY,
         actor TEXT NOT NULL,
         action TEXT NOT NULL,
         tenant_id TEXT,
         scope_id TEXT,
         vertical TEXT,
         before TEXT,
         after TEXT,
         at TEXT NOT NULL
       )`,
      `INSERT INTO _substrat_admin_log_new
         SELECT id, actor, action, tenant_id, scope_id, vertical, before, after, at
         FROM _substrat_admin_log`,
      'DROP TABLE _substrat_admin_log',
      'ALTER TABLE _substrat_admin_log_new RENAME TO _substrat_admin_log',
    ]) {
      this.sql.exec(stmt);
    }
  }

  private ensureDirectoryColumns(): void {
    this.ensureIdentityKey();
    this.ensureAdminLogTenantNullable();
    for (const ddl of SCOPE_COLUMNS_ADDED) {
      this.addColumn('scopes', ddl);
    }
    // K-21's tombstone on tenant-level tuples (membership lives here).
    this.addColumn('_substrat_tenant_tuples', 'revoked_at TEXT');
    this.addColumn('_substrat_admin_log', 'caused_by TEXT');
    // builder-plane.md: which tenant owns a vertical (NULL = platform-owned).
    this.addColumn('verticals', 'owner_tenant TEXT');
    // The vertical's declared env-spec (moduleManifest.envSpec) as JSON, for config forms.
    this.addColumn('verticals', 'env_spec TEXT');
    // marketplace-publish.md §3: registry-driven install metadata (one JSON blob).
    this.addColumn('verticals', 'install_spec TEXT');
    this.sql.exec("UPDATE scopes SET slug = lower(scope_id) WHERE slug IS NULL");
    this.sql.exec("UPDATE scopes SET kind = 'scope' WHERE kind IS NULL");
    this.sql.exec('UPDATE scopes SET name = slug WHERE name IS NULL');
    // After the backfill: a UNIQUE index over NULL slugs would permit the
    // duplicates it exists to forbid (SQLite treats NULLs as distinct).
    this.sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS scopes_tenant_slug ON scopes (tenant_id, slug)',
    );
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug ON tenants (slug)');
    this.sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS orgs_tenant_slug ON orgs (tenant_id, slug)',
    );
  }

  // -- tenant registry (control-plane.md §4.1) --------------------------------

  private mapTenant(r: TenantRow): Tenant {
    return {
      id: r.tenant_id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      createdAt: r.created_at,
    } as Tenant;
  }

  private readTenant(tenantId: string): Tenant | undefined {
    const row = this.sql
      .exec('SELECT * FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as TenantRow | undefined;
    return row ? this.mapTenant(row) : undefined;
  }

  /** Idempotent on the id; return the new tenant, or null if it already existed. */
  createTenant(id: string, slug: string, name: string, createdAt: string): Tenant | null {
    if (this.readTenant(id)) return null; // idempotent — nothing created
    // Checked explicitly rather than left to `INSERT OR IGNORE` + the
    // `tenants_slug` UNIQUE index: OR IGNORE would swallow a collision from a
    // DIFFERENT id and report the create as idempotent, silently not creating the
    // tenant the caller asked for. Fail closed instead.
    const slugOwner = this.sql
      .exec('SELECT tenant_id FROM tenants WHERE slug = ?', slug)
      .toArray()[0] as { tenant_id: string } | undefined;
    if (slugOwner) {
      throw new Error(`tenant slug '${slug}' already taken by ${slugOwner.tenant_id} (slugs are unique)`);
    }
    this.sql.exec(
      `INSERT INTO tenants (tenant_id, slug, name, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
      id,
      slug,
      name,
      createdAt,
    );
    return this.readTenant(id) ?? null;
  }

  /** Throw if absent; else UPDATE and return the previous status. */
  setTenantStatus(tenantId: string, status: TenantStatus): string {
    const before = this.readTenant(tenantId);
    if (!before) throw new Error(`unknown tenant: ${tenantId}`);
    this.sql.exec('UPDATE tenants SET status = ? WHERE tenant_id = ?', status, tenantId);
    return before.status;
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.readTenant(tenantId);
  }

  listTenants(): Tenant[] {
    return (
      this.sql.exec('SELECT * FROM tenants ORDER BY tenant_id').toArray() as unknown as TenantRow[]
    ).map((r) => this.mapTenant(r));
  }

  // -- scope lifecycle (control-plane.md §4.1/§4.2) ---------------------------

  /**
   * Mandatory active tenant: a scope with no tenant record is the "tenant is an
   * FK string" hole the registry closes — fail closed. INSERT OR IGNORE the
   * scope with status 'active'; return whether it was newly created.
   */
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
  ): boolean {
    const tenantRow = this.sql
      .exec('SELECT status FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision scope under unknown tenant: ${tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision scope under non-active tenant (status: ${tenantRow.status}): ${tenantId}`,
      );
    }
    // Idempotency is on the scope_id (§3.3: idempotent and journaled — safe to
    // re-run), so an existing scope short-circuits before the slug check:
    // re-provisioning must not collide with itself.
    const existed =
      this.sql.exec('SELECT 1 FROM scopes WHERE scope_id = ?', scopeId).toArray()[0] !== undefined;
    if (!existed) {
      // An `archived` scope (a deleted app) has released its name — excluded so the slug
      // can be reclaimed by a new scope.
      const slugOwner = this.sql
        .exec("SELECT scope_id FROM scopes WHERE tenant_id = ? AND slug = ? AND status != 'archived'", tenantId, record.slug)
        .toArray()[0] as { scope_id: string } | undefined;
      if (slugOwner) {
        throw new Error(
          `scope slug '${record.slug}' already taken under tenant ${tenantId} ` +
            `by ${slugOwner.scope_id} (slugs are unique within a tenant)`,
        );
      }
      this.sql.exec(
        `INSERT INTO scopes
           (scope_id, tenant_id, parent_scope_id, slug, kind, name, vertical,
            storage_shape, jurisdiction, status, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
        scopeId,
        tenantId,
        record.slug,
        record.kind,
        record.name,
        record.vertical,
        record.storageShape,
        record.jurisdiction,
        createdAt,
      );
    }
    return !existed;
  }

  /**
   * The scope's migration state, projected into the directory so the fleet
   * question ("which scopes are behind?") is answerable from the index alone —
   * §5.4's "fleet questions never fan out". Written by the coordinator after the
   * ScopeDO reports what it applied.
   *
   * Written on the FAILURE path too (#32): projecting only on success is what let
   * a half-migrated scope keep a stale `schema_version` and render as healthy.
   * `failure` null clears the columns, so `migration_attempts` counts *consecutive*
   * failures — what the reconciliation sweep's backoff (#49) needs.
   */
  setMigrationState(
    scopeId: string,
    schemaVersion: string,
    failure: { version: string; error: string } | null,
  ): void {
    if (!failure) {
      this.sql.exec(
        `UPDATE scopes SET schema_version = ?, migration_failed_version = NULL,
           migration_error = NULL, migration_attempts = 0, migration_last_attempt_at = NULL
         WHERE scope_id = ?`,
        schemaVersion,
        scopeId,
      );
      return;
    }
    this.sql.exec(
      `UPDATE scopes SET schema_version = ?, migration_failed_version = ?,
         migration_error = ?, migration_attempts = migration_attempts + 1,
         migration_last_attempt_at = ?
       WHERE scope_id = ?`,
      schemaVersion,
      failure.version,
      failure.error,
      new Date().toISOString(),
      scopeId,
    );
  }

  listScopes(filter: {
    tenantId?: string;
    status?: string[];
    vertical?: string;
  }): ScopeRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.status) {
      // An empty array means "no status is acceptable" — match nothing, rather
      // than degenerating into an unfiltered read of the whole fleet.
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.vertical) {
      where.push('vertical = ?');
      params.push(filter.vertical);
    }
    const sql =
      'SELECT * FROM scopes' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY scope_id';
    return this.sql.exec(sql, ...params).toArray() as unknown as ScopeRow[];
  }

  /** Cross-checks the pair (K-3): a scope under a DIFFERENT tenant reads as absent. */
  getScopeRecord(tenantId: string, scopeId: string): ScopeRow | undefined {
    const row = this.sql
      .exec('SELECT * FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as ScopeRow | undefined;
    if (!row || row.tenant_id !== tenantId) return undefined;
    return row;
  }

  /**
   * The getScope gate (control-plane.md §4.1/§4.2): validate the scope belongs
   * to the tenant and both records are active, or throw the fail-closed reason.
   */
  validateScopeAccess(tenantId: string, scopeId: string): void {
    const row = this.sql
      .exec('SELECT tenant_id, status FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as { tenant_id: string; status: string } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    const tenantRow = this.sql
      .exec('SELECT status FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`scope has no tenant record: (${tenantId}, ${scopeId})`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(`tenant not active (status: ${tenantRow.status}): ${tenantId}`);
    }
    if (row.status !== 'active') {
      // A scope stuck in provisioning because its migrations failed must say so.
      // Reporting only "not active" is true and useless: it sends an operator looking
      // for a missing activation when the cause is a broken migration, which is
      // already recorded on this very row.
      const failure = this.sql
        .exec(
          'SELECT migration_failed_version, migration_error FROM scopes WHERE scope_id = ?',
          scopeId,
        )
        .toArray()[0] as
        | { migration_failed_version: string | null; migration_error: string | null }
        | undefined;
      if (failure?.migration_failed_version) {
        throw new Error(
          `migration failed for ${failure.migration_failed_version} — scope fails closed: ` +
            `${failure.migration_error ?? 'unknown error'}`,
        );
      }
      throw new Error(`scope not active (status: ${row.status}): ${scopeId}`);
    }
  }

  /**
   * Validate ownership, enforce the legal transition graph (fail closed on an
   * illegal one), flip the status. Returns the previous status AND the scope's
   * vertical — both for the audit entry, sparing the coordinator a read
   * round-trip. `action` rides along only to name the illegal-transition message.
   */
  transitionScope(
    tenantId: string,
    scopeId: string,
    from: string[],
    to: ScopeStatus,
    action: string,
  ): { status: string; vertical: string | null } {
    const row = this.sql
      .exec('SELECT tenant_id, status, vertical FROM scopes WHERE scope_id = ?', scopeId)
      .toArray()[0] as { tenant_id: string; status: string; vertical: string | null } | undefined;
    if (!row || row.tenant_id !== tenantId) {
      throw new Error(`unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    if (!from.includes(row.status)) {
      throw new Error(
        `illegal scope transition for ${action}: ${row.status} → ${to} ` +
          `(allowed from: ${from.join('|')})`,
      );
    }
    this.sql.exec('UPDATE scopes SET status = ? WHERE scope_id = ?', to, scopeId);
    return { status: row.status, vertical: row.vertical };
  }

  // -- roles (checker rule 1) -------------------------------------------------

  /** INSERT OR REPLACE; return the previous role (for the audit `before`) or null. */
  defineRole(tenantId: string, role: RoleDefinition): RoleDefinition | null {
    const before = this.getRole(tenantId, role.key) ?? null;
    this.sql.exec(
      `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source)
       VALUES (?, ?, ?, ?)`,
      tenantId,
      role.key,
      JSON.stringify(role.permissions),
      String(role.source),
    );
    return before;
  }

  /** Raw rows; the coordinator parses them through the `tenantRole` contract. */
  listRoles(filter: { tenantId?: string; source?: string }): RoleRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    const sql =
      'SELECT tenant_id, role_key, permissions, source FROM _substrat_roles' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY tenant_id, role_key';
    return this.sql.exec(sql, ...params).toArray() as unknown as RoleRow[];
  }

  getRole(tenantId: string, key: string): RoleDefinition | undefined {
    const row = this.sql
      .exec(
        'SELECT role_key, permissions, source FROM _substrat_roles WHERE tenant_id = ? AND role_key = ?',
        tenantId,
        key,
      )
      .toArray()[0] as { role_key: string; permissions: string; source: string } | undefined;
    if (!row) return undefined;
    return {
      key: row.role_key,
      permissions: JSON.parse(row.permissions),
      source: row.source,
    } as RoleDefinition;
  }

  // -- tenant-level tuples (checker rules 1, 2, 4) ----------------------------

  writeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    expiresAt: string | null,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO _substrat_tenant_tuples
         (tenant_id, subject, relation, object, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      tenantId,
      subject,
      relation,
      object,
      expiresAt,
    );
  }

  // -- the hostname map (K-26) ------------------------------------------------

  readHostname(hostname: string): (HostnameRow & { deployment_ref: string | null }) | undefined {
    // Join the scope's bound version's deployment_ref, so the router resolves the
    // dispatch script in the same one directory read (orchestration.md §5.4). LEFT
    // joins: a scope with no bound version resolves with deployment_ref = null.
    return this.sql
      .exec(
        `SELECT h.*, vv.deployment_ref AS deployment_ref, s.status AS scope_status
           FROM hostnames h
           LEFT JOIN scopes s ON s.scope_id = h.scope_id
           LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
          WHERE h.hostname = ?`,
        hostname,
      )
      .toArray()[0] as unknown as (HostnameRow & { deployment_ref: string | null }) | undefined;
  }

  /** Demote any current canonical for this surface — exactly one may hold it. */
  demoteCanonical(scopeId: string, surface: string): void {
    this.sql.exec(
      'UPDATE hostnames SET canonical = 0 WHERE scope_id = ? AND surface = ?',
      scopeId, surface,
    );
  }

  upsertHostname(h: {
    hostname: string; tenantId: string; scopeId: string; verticalSlug: string | null;
    surface: string; region: string | null; canonical: boolean; createdAt: string;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO hostnames
         (hostname, tenant_id, scope_id, vertical_slug, surface, region,
          status, status_note, canonical, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      h.hostname, h.tenantId, h.scopeId, h.verticalSlug, h.surface, h.region,
      h.canonical ? 1 : 0, h.createdAt,
    );
  }

  setHostnameStatus(hostname: string, status: string, note: string | null): void {
    this.sql.exec(
      'UPDATE hostnames SET status = ?, status_note = ? WHERE hostname = ?',
      status, note, hostname,
    );
  }

  listHostnames(filter: { tenantId?: string; scopeId?: string }): HostnameRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId); }
    if (filter.scopeId) { where.push('scope_id = ?'); params.push(filter.scopeId); }
    let sql = 'SELECT * FROM hostnames';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY hostname';
    return this.sql.exec(sql, ...params).toArray() as unknown as HostnameRow[];
  }

  // -- vertical + version registry (#31) --------------------------------------

  readVertical(slug: string): VerticalRow | undefined {
    return this.sql
      .exec('SELECT * FROM verticals WHERE slug = ?', slug)
      .toArray()[0] as unknown as VerticalRow | undefined;
  }

  insertVertical(slug: string, name: string, source: string, ownerTenant: string | null, envSpec: string | null, installSpec: string | null, createdAt: string): void {
    this.sql.exec(
      'INSERT INTO verticals (slug, name, source, owner_tenant, env_spec, install_spec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      slug, name, source, ownerTenant, envSpec, installSpec, createdAt,
    );
  }

  /** Refresh a vertical's declared env-spec + install-spec (both evolve with the manifest). */
  updateVerticalManifestMeta(slug: string, envSpec: string | null, installSpec: string | null): void {
    this.sql.exec('UPDATE verticals SET env_spec = ?, install_spec = ? WHERE slug = ?', envSpec, installSpec, slug);
  }

  listVerticals(): VerticalRow[] {
    return this.sql.exec('SELECT * FROM verticals ORDER BY slug').toArray() as unknown as VerticalRow[];
  }

  readVersion(id: string): VersionRow | undefined {
    return this.sql
      .exec('SELECT * FROM vertical_versions WHERE id = ?', id)
      .toArray()[0] as unknown as VersionRow | undefined;
  }

  insertVersion(v: {
    id: string; verticalSlug: string; version: string; manifestDigest: string;
    permissionDigest: string; migrationDigest: string; deploymentRef: string | null;
    createdAt: string;
  }): void {
    this.sql.exec(
      `INSERT INTO vertical_versions
         (id, vertical_slug, version, manifest_digest, permission_digest,
          migration_digest, deployment_ref, admission, admission_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
      v.id, v.verticalSlug, v.version, v.manifestDigest, v.permissionDigest,
      v.migrationDigest, v.deploymentRef, v.createdAt,
    );
  }

  listVersions(verticalSlug: string): VersionRow[] {
    return this.sql
      .exec('SELECT * FROM vertical_versions WHERE vertical_slug = ? ORDER BY id', verticalSlug)
      .toArray() as unknown as VersionRow[];
  }

  setAdmission(id: string, admission: string, note: string | null): void {
    this.sql.exec(
      'UPDATE vertical_versions SET admission = ?, admission_note = ? WHERE id = ?',
      admission, note, id,
    );
  }

  bindScopeVersion(scopeId: string, versionId: string, verticalSlug: string): void {
    this.sql.exec(
      'UPDATE scopes SET vertical_version_id = ?, vertical = ? WHERE scope_id = ?',
      versionId, verticalSlug, scopeId,
    );
  }

  readChannel(verticalSlug: string, channel: string): ChannelRow | undefined {
    return this.sql
      .exec(
        'SELECT * FROM vertical_channels WHERE vertical_slug = ? AND channel = ?',
        verticalSlug, channel,
      )
      .toArray()[0] as unknown as ChannelRow | undefined;
  }

  setChannel(verticalSlug: string, channel: string, versionId: string, updatedAt: string): void {
    this.sql.exec(
      `INSERT INTO vertical_channels (vertical_slug, channel, version_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (vertical_slug, channel) DO UPDATE SET version_id = ?, updated_at = ?`,
      verticalSlug, channel, versionId, updatedAt, versionId, updatedAt,
    );
  }

  listChannels(verticalSlug: string): ChannelRow[] {
    return this.sql
      .exec('SELECT * FROM vertical_channels WHERE vertical_slug = ? ORDER BY channel', verticalSlug)
      .toArray() as unknown as ChannelRow[];
  }

  // -- organizations (K-22) ---------------------------------------------------

  readOrg(tenantId: string, orgId: string): OrgRow | undefined {
    return this.sql
      .exec('SELECT * FROM orgs WHERE tenant_id = ? AND org_id = ?', tenantId, orgId)
      .toArray()[0] as unknown as OrgRow | undefined;
  }

  /** Returns false when the org already exists (idempotent); throws on slug collision. */
  createOrg(orgId: string, tenantId: string, slug: string, name: string, createdAt: string): boolean {
    if (this.readOrg(tenantId, orgId)) return false;
    const slugOwner = this.sql
      .exec('SELECT org_id FROM orgs WHERE tenant_id = ? AND slug = ?', tenantId, slug)
      .toArray()[0] as unknown as { org_id: string } | undefined;
    if (slugOwner) {
      throw new Error(
        `org slug '${slug}' already taken by ${slugOwner.org_id} (slugs are unique per tenant)`,
      );
    }
    this.sql.exec(
      'INSERT INTO orgs (org_id, tenant_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)',
      orgId,
      tenantId,
      slug,
      name,
      createdAt,
    );
    return true;
  }

  listOrgs(tenantId: string): OrgRow[] {
    return this.sql
      .exec('SELECT * FROM orgs WHERE tenant_id = ? ORDER BY slug', tenantId)
      .toArray() as unknown as OrgRow[];
  }

  /**
   * Tombstone a membership (K-21), never DELETE. Guarded on `revoked_at IS NULL`
   * so a repeat revoke neither moves the timestamp nor produces a second audit
   * row. Returns whether it changed, so the coordinator can skip the audit write.
   */
  revokeMember(tenantId: string, subject: string, object: string, at: string): boolean {
    return this.revokeTenantTuple(tenantId, subject, 'member', object, at);
  }

  /** Tombstone any tenant tuple by its exact (subject, relation, object). Returns
   *  whether a live row changed, so a repeat revoke is a silent no-op. */
  revokeTenantTuple(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    at: string,
  ): boolean {
    const before = this.sql
      .exec(
        `SELECT 1 FROM _substrat_tenant_tuples
         WHERE tenant_id = ? AND subject = ? AND relation = ? AND object = ?
           AND revoked_at IS NULL`,
        tenantId,
        subject,
        relation,
        object,
      )
      .toArray();
    if (before.length === 0) return false;
    this.sql.exec(
      `UPDATE _substrat_tenant_tuples SET revoked_at = ?
       WHERE tenant_id = ? AND subject = ? AND relation = ? AND object = ?
         AND revoked_at IS NULL`,
      at,
      tenantId,
      subject,
      relation,
      object,
    );
    return true;
  }

  /** Members of an org. Live only unless `includeRevoked` — revoked rows are evidence. */
  listMembers(
    tenantId: string,
    object: string,
    includeRevoked: boolean,
  ): { subject: string; revoked_at: string | null }[] {
    return this.sql
      .exec(
        `SELECT subject, revoked_at FROM _substrat_tenant_tuples
         WHERE tenant_id = ? AND relation = 'member' AND object = ?
         ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
         ORDER BY subject`,
        tenantId,
        object,
      )
      .toArray() as unknown as { subject: string; revoked_at: string | null }[];
  }

  tenantTuples(tenantId: string, subject: string, relationPrefix: string): TupleRow[] {
    return this.sql
      .exec(
        `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tenant_tuples
         WHERE tenant_id = ? AND subject = ? AND relation LIKE ?`,
        tenantId,
        subject,
        `${relationPrefix}%`,
      )
      .toArray() as unknown as TupleRow[];
  }

  /**
   * ALL of a tenant's tenant-level tuples — the read behind scope-local projection
   * (docs/design/scope-local-permissions.md). Includes tombstoned rows so the
   * projection mirrors the directory exactly and the checker's own `live()` filter
   * drops them identically. Not on the request hot path — this runs on the admin
   * write path, projecting into a tenant's scopes.
   */
  dumpTenantTuples(tenantId: string): TupleRow[] {
    return this.sql
      .exec(
        `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tenant_tuples
         WHERE tenant_id = ?`,
        tenantId,
      )
      .toArray() as unknown as TupleRow[];
  }

  // -- entitlements (control-plane.md §4.3) -----------------------------------

  /** INSERT OR IGNORE; return whether it changed (idempotent). */
  grantEntitlement(tenantId: string, key: string): boolean {
    if (this.tenantHoldsEntitlement(tenantId, key)) return false;
    this.sql.exec(
      `INSERT OR IGNORE INTO _substrat_entitlements (tenant_id, entitlement_key)
       VALUES (?, ?)`,
      tenantId,
      key,
    );
    return true;
  }

  /** DELETE; return whether it changed (idempotent). */
  revokeEntitlement(tenantId: string, key: string): boolean {
    if (!this.tenantHoldsEntitlement(tenantId, key)) return false;
    this.sql.exec(
      'DELETE FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
      tenantId,
      key,
    );
    return true;
  }

  tenantHoldsEntitlement(tenantId: string, key: string): boolean {
    return (
      this.sql
        .exec(
          'SELECT 1 FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
          tenantId,
          key,
        )
        .toArray()[0] !== undefined
    );
  }

  listEntitlements(tenantId: string): string[] {
    return (
      this.sql
        .exec(
          'SELECT entitlement_key FROM _substrat_entitlements WHERE tenant_id = ? ORDER BY entitlement_key',
          tenantId,
        )
        .toArray() as unknown as { entitlement_key: string }[]
    ).map((r) => r.entitlement_key);
  }

  // -- identity pools (K-23) --------------------------------------------------

  readPool(provider: string): { provider: string; topology: string; tenant_id: string | null } | undefined {
    return this.sql
      .exec('SELECT provider, topology, tenant_id FROM _substrat_identity_pools WHERE provider = ?', provider)
      .toArray()[0] as unknown as
      | { provider: string; topology: string; tenant_id: string | null }
      | undefined;
  }

  /** Returns false when an identical registration already exists; throws on a conflicting one. */
  registerIdentityPool(
    provider: string,
    topology: string,
    tenantId: string | null,
    createdAt: string,
  ): boolean {
    const existing = this.readPool(provider);
    if (existing) {
      if (existing.topology === topology && existing.tenant_id === tenantId) return false;
      throw new Error(
        `identity pool '${provider}' is already registered as ${existing.topology}` +
          `${existing.tenant_id ? ` for tenant ${existing.tenant_id}` : ''}`,
      );
    }
    this.sql.exec(
      'INSERT INTO _substrat_identity_pools (provider, topology, tenant_id, created_at) VALUES (?, ?, ?, ?)',
      provider,
      topology,
      tenantId,
      createdAt,
    );
    return true;
  }

  identityTenants(provider: string, externalId: string): string[] {
    return (
      this.sql
        .exec(
          'SELECT tenant_id FROM _substrat_identities WHERE provider = ? AND external_id = ? ORDER BY tenant_id',
          provider,
          externalId,
        )
        .toArray() as unknown as { tenant_id: string }[]
    ).map((r) => r.tenant_id);
  }

  // -- identities (D-16; control-plane.md §6) ---------------------------------

  /**
   * Bind an identity within a tenant. Returns false when the key already maps to the
   * SAME principal (idempotent, unaudited); throws when it maps to a DIFFERENT one.
   *
   * Read before write: `INSERT OR IGNORE` alone cannot tell those two apart, and
   * silently ignoring a genuine collision resolves one person as another.
   */
  // -- the integrations hub (#101) -------------------------------------------
  //
  // The DO owns the rows; the coordinator owns the SecretBox, so ciphertext
  // arrives already sealed and leaves still sealed. This DO has never seen a
  // plaintext credential and cannot.

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
  }): void {
    const live = this.sql
      .exec(
        `SELECT id FROM _substrat_connections
         WHERE tenant_id = ? AND vertical = ? AND provider = ? AND revoked_at IS NULL`,
        row.tenantId,
        row.vertical,
        row.provider,
      )
      .toArray()[0] as unknown as { id: string } | undefined;
    if (live) {
      throw new Error(
        `tenant ${row.tenantId} already has a live '${row.provider}' connection ` +
          `for vertical '${row.vertical}' — revoke it before connecting another`,
      );
    }
    this.sql.exec(
      `INSERT INTO _substrat_connections
         (id, tenant_id, vertical, provider, label, status, external_account_ref,
          scopes, expires_at, last_ok_at, last_error, last_error_at,
          created_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
      row.id,
      row.tenantId,
      row.vertical,
      row.provider,
      row.label,
      row.externalAccountRef,
      row.scopes,
      row.expiresAt,
      row.createdBy,
      row.createdAt,
    );
    this.sql.exec(
      `INSERT INTO _substrat_connection_secrets (connection_id, key_id, ciphertext, updated_at)
       VALUES (?, ?, ?, ?)`,
      row.id,
      row.keyId,
      row.ciphertext,
      row.createdAt,
    );
  }

  listConnections(filter: {
    tenantId?: string;
    vertical?: string;
    provider?: string;
    includeRevoked?: boolean;
  }): ConnectionDoRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) (where.push('tenant_id = ?'), params.push(filter.tenantId));
    if (filter.vertical) (where.push('vertical = ?'), params.push(filter.vertical));
    if (filter.provider) (where.push('provider = ?'), params.push(filter.provider));
    if (!filter.includeRevoked) where.push('revoked_at IS NULL');
    return this.sql
      .exec(
        `SELECT * FROM _substrat_connections
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY tenant_id, vertical, provider`,
        ...params,
      )
      .toArray() as unknown as ConnectionDoRow[];
  }

  readConnection(id: string): ConnectionDoRow | undefined {
    return this.sql.exec('SELECT * FROM _substrat_connections WHERE id = ?', id).toArray()[0] as
      | unknown
      | undefined as ConnectionDoRow | undefined;
  }

  /** The live connection for a triple, plus its sealed blob — the connector read. */
  readLiveConnection(
    tenantId: string,
    vertical: string,
    provider: string,
  ): (ConnectionDoRow & { key_id: string; ciphertext: string }) | undefined {
    return this.sql
      .exec(
        `SELECT c.*, s.key_id, s.ciphertext
         FROM _substrat_connections c
         JOIN _substrat_connection_secrets s ON s.connection_id = c.id
         WHERE c.tenant_id = ? AND c.vertical = ? AND c.provider = ? AND c.revoked_at IS NULL`,
        tenantId,
        vertical,
        provider,
      )
      .toArray()[0] as unknown as
      | (ConnectionDoRow & { key_id: string; ciphertext: string })
      | undefined;
  }

  updateConnectionSecret(
    id: string,
    keyId: string,
    ciphertext: string,
    expiresAt: string | null,
    at: string,
  ): void {
    this.sql.exec(
      `UPDATE _substrat_connection_secrets
       SET key_id = ?, ciphertext = ?, updated_at = ? WHERE connection_id = ?`,
      keyId,
      ciphertext,
      at,
      id,
    );
    this.sql.exec(
      `UPDATE _substrat_connections
       SET status = 'active', expires_at = ?, last_error = NULL, last_error_at = NULL
       WHERE id = ?`,
      expiresAt,
      id,
    );
  }

  /**
   * Tombstone the connection and DELETE the sealed blob.
   *
   * The row is evidence that a grant existed (K-21); the usable credential would
   * only be a liability. Returns false when already revoked, so the caller can
   * skip an audit row for a no-op.
   */
  revokeConnection(id: string, at: string): boolean {
    const row = this.readConnection(id);
    if (!row) throw new Error(`connection not found: ${id}`);
    if (row.revoked_at) return false;
    this.sql.exec(
      `UPDATE _substrat_connections SET status = 'revoked', revoked_at = ? WHERE id = ?`,
      at,
      id,
    );
    this.sql.exec('DELETE FROM _substrat_connection_secrets WHERE connection_id = ?', id);
    // Connector state dies with the connection — its private bookkeeping.
    this.sql.exec('DELETE FROM _substrat_connector_state WHERE connection_id = ?', id);
    return true;
  }

  recordConnectionUse(id: string, error: string | null, at: string): void {
    if (error === null) {
      this.sql.exec(
        `UPDATE _substrat_connections
         SET last_ok_at = ?, last_error = NULL, last_error_at = NULL,
             status = CASE WHEN status = 'error' THEN 'active' ELSE status END
         WHERE id = ?`,
        at,
        id,
      );
      return;
    }
    this.sql.exec(
      `UPDATE _substrat_connections
       SET last_error = ?, last_error_at = ?,
           status = CASE WHEN status = 'revoked' THEN status ELSE 'error' END
       WHERE id = ?`,
      error.slice(0, 2000),
      at,
      id,
    );
  }

  putConnectorState(id: string, key: string, value: string, at: string): void {
    this.sql.exec(
      `INSERT INTO _substrat_connector_state (connection_id, state_key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (connection_id, state_key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      id,
      key,
      value,
      at,
    );
  }

  getConnectorState(id: string, key: string): string | undefined {
    const row = this.sql
      .exec(
        'SELECT value FROM _substrat_connector_state WHERE connection_id = ? AND state_key = ?',
        id,
        key,
      )
      .toArray()[0] as unknown as { value: string } | undefined;
    return row?.value;
  }

  listConnectorState(id: string, prefix?: string): { key: string; value: string }[] {
    const rows = this.sql
      .exec(
        'SELECT state_key, value FROM _substrat_connector_state WHERE connection_id = ? ORDER BY state_key',
        id,
      )
      .toArray() as unknown as { state_key: string; value: string }[];
    // Prefix filter in JS on the coordinator side — the per-connection key space
    // is small, and it avoids LIKE/GLOB escaping on caller-supplied prefixes.
    return rows
      .filter((r) => !prefix || r.state_key.startsWith(prefix))
      .map((r) => ({ key: r.state_key, value: r.value }));
  }

  linkIdentity(
    provider: string,
    externalId: string,
    principal: string,
    tenantId: string,
    scopeId: string | null,
    createdAt: string,
  ): boolean {
    const existing = this.sql
      .exec(
        `SELECT principal_id FROM _substrat_identities
         WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
        tenantId,
        provider,
        externalId,
      )
      .toArray()[0] as unknown as { principal_id: string } | undefined;
    if (existing) {
      if (existing.principal_id === principal) return false;
      throw new Error(
        `identity ${provider}:${externalId} in tenant ${tenantId} is already bound to ${existing.principal_id}`,
      );
    }
    this.sql.exec(
      `INSERT INTO _substrat_identities
         (provider, external_id, principal_id, tenant_id, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      provider,
      externalId,
      principal,
      tenantId,
      scopeId,
      createdAt,
    );
    return true;
  }

  /** Remove a principal's identity link(s) in a tenant. Returns whether a row was
   *  deleted so a no-op stays silent (idempotent). */
  unlinkIdentity(tenantId: string, principal: string): boolean {
    const before = this.sql
      .exec(
        `SELECT 1 FROM _substrat_identities WHERE tenant_id = ? AND principal_id = ?`,
        tenantId,
        principal,
      )
      .toArray();
    if (before.length === 0) return false;
    this.sql.exec(
      `DELETE FROM _substrat_identities WHERE tenant_id = ? AND principal_id = ?`,
      tenantId,
      principal,
    );
    return true;
  }

  resolveIdentity(
    tenantId: string,
    provider: string,
    externalId: string,
  ): { principal: string; scopeId: string | null } | undefined {
    const row = this.sql
      .exec(
        `SELECT principal_id, scope_id FROM _substrat_identities
         WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
        tenantId,
        provider,
        externalId,
      )
      .toArray()[0] as unknown as { principal_id: string; scope_id: string | null } | undefined;
    if (!row) return undefined;
    return { principal: row.principal_id, scopeId: row.scope_id };
  }

  // -- admin audit log (control-plane.md §4.4) --------------------------------

  /** Append one audit row. before/after are arbitrary JSON, stringified here. */
  /** Staff READS (K-24). Separate table, separate lifetime — see control-plane.md §4.6. */
  recordAccess(entry: {
    id: string;
    actor: string;
    method: string;
    tenantId: string | null;
    scopeId: string | null;
    params: string | null;
    resultCount: number;
    at: string;
  }): void {
    this.sql.exec(
      `INSERT INTO _substrat_access_log
         (id, actor, method, tenant_id, scope_id, params, result_count, drained_at, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      entry.id,
      entry.actor,
      entry.method,
      entry.tenantId,
      entry.scopeId,
      entry.params,
      entry.resultCount,
      entry.at,
    );
  }

  accessLog(query: {
    actor?: string;
    tenantId?: string;
    method?: string;
    limit?: number;
  }): AccessLogRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.actor) { where.push('actor = ?'); params.push(query.actor); }
    if (query.tenantId) { where.push('tenant_id = ?'); params.push(query.tenantId); }
    if (query.method) { where.push('method = ?'); params.push(query.method); }
    let sql = 'SELECT * FROM _substrat_access_log';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY id';
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(query.limit); }
    return this.sql.exec(sql, ...params).toArray() as unknown as AccessLogRow[];
  }

  /** ONLY drained rows. Age alone is not a licence to delete evidence (K-24). */
  pruneAccessLog(limit: number): number {
    const doomed = (
      this.sql
        .exec(
          'SELECT id FROM _substrat_access_log WHERE drained_at IS NOT NULL ORDER BY id LIMIT ?',
          limit,
        )
        .toArray() as unknown as { id: string }[]
    ).map((r) => r.id);
    for (const id of doomed) {
      this.sql.exec('DELETE FROM _substrat_access_log WHERE id = ?', id);
    }
    return doomed.length;
  }

  recordAdmin(entry: AdminEntryInput): void {
    this.sql.exec(
      `INSERT INTO _substrat_admin_log
         (id, actor, action, tenant_id, scope_id, vertical, before, after, caused_by, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.actor,
      entry.action,
      entry.tenantId,
      entry.scopeId,
      entry.vertical,
      entry.before == null ? null : JSON.stringify(entry.before),
      entry.after == null ? null : JSON.stringify(entry.after),
      entry.causedBy ?? null,
      entry.at,
    );
  }

  auditLog(query: AuditLogQuery): AdminLogEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.tenantId) {
      where.push('tenant_id = ?');
      params.push(query.tenantId);
    }
    if (query.scopeId) {
      where.push('scope_id = ?');
      params.push(query.scopeId);
    }
    if (query.actor) {
      where.push('actor = ?');
      params.push(query.actor);
    }
    if (query.action) {
      if (query.action.length === 0) return []; // no action is acceptable — match nothing
      where.push(`action IN (${query.action.map(() => '?').join(', ')})`);
      params.push(...query.action);
    }
    if (query.since) {
      where.push('at >= ?');
      params.push(query.since);
    }
    if (query.until) {
      where.push('at < ?');
      params.push(query.until);
    }
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    if (query.cursor) {
      // ULID order is chronological, so the entry id IS the cursor.
      where.push(order === 'DESC' ? 'id < ?' : 'id > ?');
      params.push(query.cursor);
    }
    let sql =
      'SELECT * FROM _substrat_admin_log' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id ${order}`;
    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    const rows = this.sql.exec(sql, ...params).toArray() as unknown as AdminLogRow[];
    return rows.map(
      (r) =>
        ({
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
        }) as AdminLogEntry,
    );
  }
}
