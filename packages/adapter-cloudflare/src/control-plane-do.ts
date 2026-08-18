import { DurableObject } from 'cloudflare:workers';
import { OPS_FAILURE_RETENTION_DAYS } from '@substrat-run/kernel';
import { splitSqlStatements } from './scope-do.js';
import type {
  AdminLogEntry,
  ListPage,
  OpsFailureEntry,
  RoleDefinition,
  ScopeDumpTable,
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
  deleting_at: string | null;
  provisioned_by_tenant: string | null;
}

/** An entitlement grant as stored (#33) — nulls = the pre-widening boolean flag. */
export interface EntitlementRow {
  entitlement_key: string;
  expires_at: string | null;
  quota: number | null;
  plan: string | null;
  granted_at: string | null;
  granted_by: string | null;
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

/** A connection grant as the DO records it (#592) — the gather source for delivery. */
export interface ConnectionGrantDoRow {
  connection_id: string;
  tenant_id: string;
  vertical: string;
  permission: string;
  scope_id: string | null;
  expires_at: string | null;
  granted_by: string;
  granted_at: string;
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
  forked_from: string | null;
  forked_at: string | null;
  expires_at: string | null;
  /** The dispatch script this scope's data lives in (#286); null = per-version dispatch. */
  serving_ref: string | null;
  /** When the scope last entered `archived` (§4.4); null if never archived. */
  archived_at: string | null;
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
  /** Cloudflare-for-SaaS custom-hostname id (§4.7); null for a platform hostname. */
  custom_hostname_id: string | null;
  /** DNS records to publish, as a JSON array of dnsRecord; null/empty for a platform hostname. */
  validation_records: string | null;
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
  /** Published to the public marketplace (0/1); set on insert, never touched by a re-push. */
  listed: number;
  /** A builder's pending publish request (ISO timestamp, or null). */
  publish_requested_at: string | null;
  /** New installs blocked (0/1) — the staff kill-switch; gates provisioning, not serving. */
  installs_blocked: number;
  /** Tenant-provisioner capability (0/1, #412) — staff grant; never touched by a re-push. */
  tenant_provisioner: number;
  /** Email-sender capability (0/1, #303) — staff grant; never touched by a re-push. */
  email_sender: number;
  /** The stable serving script's name (#286); null = no serving script yet. */
  serving_ref: string | null;
  /** The version whose bundle the serving script currently runs (may trail prod). */
  serving_version_id: string | null;
  /** DO classes the serving script declares, as a JSON array — the in-place delta base. */
  serving_do_classes: string | null;
  /** The serving script's current DO-migration tag (`v1`, `v2`, …). */
  serving_migration_tag: string | null;
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
  /** The pushed DeployManifest (JSON) — promote/backout rebuild upload metadata from it. */
  manifest_json: string | null;
  /** Push provenance (`versionOrigin` JSON) — null for a pre-tracking push. */
  origin_json: string | null;
  created_at: string;
}

export interface ChannelRow {
  vertical_slug: string;
  channel: string;
  version_id: string;
  updated_at: string;
}

export interface ChannelHistoryRow {
  id: string;
  vertical_slug: string;
  channel: string;
  version_id: string;
  from_version_id: string | null;
  actor: string;
  at: string;
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

/** One ops-failure row, fully stamped by the coordinator (`id`/`at` included). */
export interface OpsFailureRow {
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

/** The ops-failures filter, flattened for the RPC hop (#559). */
export interface OpsFailureQuery {
  tenantId?: string;
  scopeId?: string;
  vertical?: string;
  operation?: string;
  reference?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
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
  -- The ';' in this comment is a deliberate tripwire; the DDL must go through
  -- splitSqlStatements, and a naive split(';') fails the directory at construction.
  CREATE TABLE IF NOT EXISTS tenants (
    tenant_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    -- When the tenant last entered the deleting state; NULL otherwise. The
    -- grace-window reap sweep ages a tenant off this (§4.8), mirroring archived_at.
    deleting_at TEXT,
    -- Provenance (#412): the tenant that provisioned this one via a manager vertical,
    -- or NULL for a direct staff create. A FK to another tenants row.
    provisioned_by_tenant TEXT REFERENCES tenants(tenant_id)
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
    forked_from TEXT,
    forked_at TEXT,
    expires_at TEXT,
    -- When the scope last entered the archived state (§4.4). Drives the reap sweep's age
    -- filter (archived longer than N days); null for scopes that never archived. Stamped
    -- by transitionScope on the edge into archived, cleared on unarchive.
    archived_at TEXT,
    -- The scope's data lives in THIS dispatch script (#286). NULL = legacy per-version
    -- dispatch (the bound version's own script). Set at provision once the vertical has
    -- a serving script, or by adopt-serving when a legacy scope's data is moved over.
    serving_ref TEXT,
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
    created_at    TEXT NOT NULL,
    -- Cloudflare-for-SaaS issuance (§4.7): the custom-hostname id CF returns, and the
    -- DNS records the tenant must publish (JSON array of dnsRecord). NULL for a platform
    -- hostname (it rides the wildcard cert) and for a custom domain still pending.
    custom_hostname_id  TEXT,
    validation_records  TEXT
  );
  CREATE INDEX IF NOT EXISTS hostnames_scope ON hostnames (scope_id, surface);
  -- The reconcile sweep polls every hostname mid-issuance (pending/verifying) — an
  -- index keeps that pass from scanning the whole map as the fleet grows.
  CREATE INDEX IF NOT EXISTS hostnames_status ON hostnames (status);
  -- Per-tenant relational stores (#301), one row per (tenant, vertical, binding) -- the
  -- platform-minted per-tenant store a vertical declared as a tenantStoreNeed. ref is
  -- the opaque store handle (a D1 database_id here, a .sqlite path token on the pure
  -- adapter). The row is the idempotency + reap ledger, and what the deploy path reads
  -- to re-derive the serving script's tenant-store D1 bindings on every upload -- a
  -- retried provision re-resolves the SAME ref rather than minting a second database,
  -- and the platform knows what to tear down when a tenant is reaped.
  CREATE TABLE IF NOT EXISTS tenant_stores (
    tenant_id  TEXT NOT NULL,
    vertical   TEXT NOT NULL,
    binding    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    ref        TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, vertical, binding)
  );
  -- Per-tenant blob stores (#473) -- the tenant_stores twin for attachment bytes. ref is
  -- an R2 bucket name (buckets are addressed by name; there is no separate id). Same
  -- idempotency + deploy-rederive + reap ledger roles.
  CREATE TABLE IF NOT EXISTS blob_stores (
    tenant_id  TEXT NOT NULL,
    vertical   TEXT NOT NULL,
    binding    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    ref        TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, vertical, binding)
  );
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
    -- Published to the public marketplace (marketplace-publish.md §2). Own column: set on
    -- insert, updated by the publish action, never clobbered by a re-push refresh.
    listed       INTEGER NOT NULL DEFAULT 0,
    -- A builder's pending publish request (marketplace-publish.md §5): ISO timestamp, awaiting
    -- staff review. NULL = none / resolved.
    publish_requested_at TEXT,
    -- New installs BLOCKED (staff kill-switch). 1 = hidden from the install catalog and
    -- provisioning refuses, for everyone including the owner. Gates provisioning, not serving.
    installs_blocked INTEGER NOT NULL DEFAULT 0,
    -- Tenant-provisioner capability (#412). 1 = this vertical's scopes may enqueue
    -- provision-tenant / set-entitlements intents the platform executes. A staff grant,
    -- never set on insert or touched by a re-push refresh.
    tenant_provisioner INTEGER NOT NULL DEFAULT 0,
    -- Email-sender capability (#303). 1 = this vertical's scopes may relay transactional
    -- mail through the control plane. A staff grant, never set on insert or by a re-push.
    email_sender INTEGER NOT NULL DEFAULT 0,
    -- The ONE stable serving script (#286) and what it currently runs. serving_ref is
    -- the script name every new scope's data DO lives in; serving_version_id is the
    -- version whose bundle was last uploaded onto it (may trail the prod channel if a
    -- serve-upload failed and awaits retry). serving_do_classes (JSON array) and
    -- serving_migration_tag are what the NEXT in-place upload diffs its DO-class
    -- migrations against — directory-recorded so no deploy ever guesses Cloudflare state.
    serving_ref TEXT,
    serving_version_id TEXT,
    serving_do_classes TEXT,
    serving_migration_tag TEXT,
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
    -- The full DeployManifest as pushed (JSON). What promote/backout rebuild the
    -- serving upload's metadata from — the archive script stores the module BYTES,
    -- this stores the shape (entry, compat, doClasses, bindings). NULL = pre-#286 push.
    manifest_json     TEXT,
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
  -- The promotion timeline (append-only). The channel row remembers only where it
  -- points now; this remembers every move. "at" is the PITR anchor a data rollback
  -- would rewind to (preview-and-snapshots.md §7).
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
  -- #33 widens the SKU flag into a plan: expires_at is enforced at the gate
  -- (lazy-at-read); quota/plan are expression the builder portal consumes;
  -- granted_at/granted_by NULL only on rows born before the widening.
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
  -- One LIVE connection per (tenant, vertical, provider, account). COALESCEd so
  -- providers that never set an external_account_ref keep singleton semantics,
  -- while a multi-namespace provider (GitHub) holds one live connection PER
  -- account — the Vercel git-namespace shape.
  CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connections_live_account
    ON _substrat_connections (tenant_id, vertical, provider, COALESCE(external_account_ref, ''))
    WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS _substrat_connection_secrets (
    connection_id TEXT PRIMARY KEY,
    key_id        TEXT NOT NULL,
    ciphertext    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  -- Each connection's SEALING keypair (#687, design/signature-contact-carrier.md).
  -- The PUBLIC half is projected into scopes so module code can seal a value TO this
  -- connector before emitting it; the private half is sealed under the host SecretBox
  -- exactly as the credential is, and never leaves the directory. Keyed
  -- (connection_id, key_id) — a MAP from day one even holding one member, because
  -- widening a single-key column into a set later is a migration against live
  -- connections and starting with the map is free (D-4).
  CREATE TABLE IF NOT EXISTS _substrat_connection_keys (
    connection_id   TEXT NOT NULL,
    key_id          TEXT NOT NULL,
    public_key      TEXT NOT NULL,
    wrapped_key_id  TEXT NOT NULL,
    wrapped_private TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    retired_at      TEXT,
    PRIMARY KEY (connection_id, key_id)
  );
  -- The CURRENT key a new seal uses. Partial-unique rather than a column on the
  -- connection: rotation retires a row and inserts a new current one, and old
  -- ciphertext stays openable because its own key_id row is still here.
  CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connection_keys_current
    ON _substrat_connection_keys (connection_id) WHERE retired_at IS NULL;
  -- Connection grants as the directory records them (#592) — the durable half of
  -- grantToConnection, written alongside the enforcement tuple. The tuple lives
  -- where it is checked (the scope's own DO); this row is what provision/reconcile
  -- gather FROM, so a scope provisioned after the grant holds the same grants as
  -- one provisioned before it. Tombstoned by revokeConnection's cascade (K-21).
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
  -- Per-subject encryption keys (#37). In the DIRECTORY, never in the scope DO whose rows
  -- they protect: these keys seal PII inside platform-retained COPIES of a scope, so a key
  -- kept beside its ciphertext would be restored by the same dump that restores the
  -- ciphertext, and every erasure a restore rolled past would silently reverse itself.
  -- wrapped_dek is sealed by the host SecretBox, so the directory holds no raw key either.
  -- A shred clears the key and stamps shredded_at, KEEPING the row as the tombstone that
  -- stops a later export from minting the same subject a working key again.
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
  -- Operational failures (#559) - what the platform could NOT do, and why. NOT the
  -- admin log (that is the never-swept compliance witness of successful mutations)
  -- but retention-bounded telemetry, pruned on write after OPS_FAILURE_RETENTION_DAYS.
  -- reference holds the upstream provider's trace handle (Cloudflare's
  -- "internal error - reference <id>") so a CI error line resolves to a row here.
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
  'forked_from TEXT',
  'forked_at TEXT',
  'expires_at TEXT',
  'serving_ref TEXT',
  'archived_at TEXT',
] as const;

export class ControlPlaneDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    for (const stmt of splitSqlStatements(DIRECTORY_DDL)) {
      this.sql.exec(stmt);
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
    // The pre-account-aware live-uniqueness index: superseded by
    // _substrat_connections_live_account (in the DDL above), which adds the
    // external-account leg so one tenant can hold the same provider under
    // several accounts. Existing rows always satisfy the wider key.
    this.sql.exec('DROP INDEX IF EXISTS _substrat_connections_live');
    for (const ddl of SCOPE_COLUMNS_ADDED) {
      this.addColumn('scopes', ddl);
    }
    // §4.8's grace-window timestamp on tenants (mirrors scopes' archived_at).
    this.addColumn('tenants', 'deleting_at TEXT');
    // #412 provenance: the manager tenant that provisioned this one (NULL = direct staff).
    this.addColumn('tenants', 'provisioned_by_tenant TEXT REFERENCES tenants(tenant_id)');
    // §4.7 custom-hostname issuance: CF's hostname id + the DNS records to publish (JSON).
    this.addColumn('hostnames', 'custom_hostname_id TEXT');
    this.addColumn('hostnames', 'validation_records TEXT');
    // K-21's tombstone on tenant-level tuples (membership lives here).
    this.addColumn('_substrat_tenant_tuples', 'revoked_at TEXT');
    this.addColumn('_substrat_admin_log', 'caused_by TEXT');
    // builder-plane.md: which tenant owns a vertical (NULL = platform-owned).
    this.addColumn('verticals', 'owner_tenant TEXT');
    // The vertical's declared env-spec (moduleManifest.envSpec) as JSON, for config forms.
    this.addColumn('verticals', 'env_spec TEXT');
    // marketplace-publish.md §3: registry-driven install metadata (one JSON blob).
    this.addColumn('verticals', 'install_spec TEXT');
    this.addColumn('verticals', 'listed INTEGER NOT NULL DEFAULT 0');
    this.addColumn('verticals', 'publish_requested_at TEXT');
    this.addColumn('verticals', 'installs_blocked INTEGER NOT NULL DEFAULT 0');
    // #412: the tenant-provisioner capability — a staff grant on the registry row.
    this.addColumn('verticals', 'tenant_provisioner INTEGER NOT NULL DEFAULT 0');
    // #303: the email-sender capability — a staff grant on the registry row.
    this.addColumn('verticals', 'email_sender INTEGER NOT NULL DEFAULT 0');
    this.addColumn('verticals', 'serving_ref TEXT');
    this.addColumn('verticals', 'serving_version_id TEXT');
    this.addColumn('verticals', 'serving_do_classes TEXT');
    this.addColumn('verticals', 'serving_migration_tag TEXT');
    this.addColumn('vertical_versions', 'manifest_json TEXT');
    // Push provenance (git CI vs a terminal), as pushed-alongside JSON. NULL = pushed
    // before origin tracking, or by an old CLI.
    this.addColumn('vertical_versions', 'origin_json TEXT');
    // #33: the SKU flag learns to express a plan. All nullable — a legacy row
    // reads as a perpetual boolean flag, exactly its pre-widening semantics.
    this.addColumn('_substrat_entitlements', 'expires_at TEXT');
    this.addColumn('_substrat_entitlements', 'quota INTEGER');
    this.addColumn('_substrat_entitlements', 'plan TEXT');
    this.addColumn('_substrat_entitlements', 'granted_at TEXT');
    this.addColumn('_substrat_entitlements', 'granted_by TEXT');
    this.sql.exec("UPDATE scopes SET slug = lower(scope_id) WHERE slug IS NULL");
    this.sql.exec("UPDATE scopes SET kind = 'scope' WHERE kind IS NULL");
    this.sql.exec('UPDATE scopes SET name = slug WHERE name IS NULL');
    // After the backfill: a UNIQUE index over NULL slugs would permit the
    // duplicates it exists to forbid (SQLite treats NULLs as distinct).
    //
    // PARTIAL on the live statuses: an `archived` scope (a deleted app) and a `reaped`
    // one keep their directory row as a tombstone but release their name (§4.4), so a new
    // scope must be able to reclaim the slug while the tombstone survives — the same
    // predicate `provisionScope`'s slug pre-check uses. A full index would let the
    // tombstone block the reuse the contract intends. DROP-then-create migrates a
    // directory DO carrying the old full index across a deploy.
    this.sql.exec('DROP INDEX IF EXISTS scopes_tenant_slug');
    this.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS scopes_tenant_slug ON scopes (tenant_id, slug) " +
        "WHERE status NOT IN ('archived', 'reaped')",
    );
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug ON tenants (slug)');
    this.sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS orgs_tenant_slug ON orgs (tenant_id, slug)',
    );
  }

  // -- disaster recovery (#40) -----------------------------------------------

  /**
   * A COMPLETE dump of the directory — the read half of the platform's own backup
   * (control-plane.md §4.9). Structurally identical to `ScopeDO.exportDump`, and for
   * the same reasons: no `.backup()` on DO SQLite, so this is the logical row-dump,
   * consistent because a DO is single-threaded (no concurrent writer to tear it).
   *
   * The whole database, including `_substrat_admin_log` and `_substrat_access_log`: a
   * directory restored without its audit spine is a platform that cannot say what it
   * did before the restore, which is the opposite of what a recovery is for.
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
      const cursor = this.sql.exec(`SELECT * FROM "${name}"`);
      const columns = cursor.columnNames;
      const rows = Array.from(cursor.raw(), (row) => row as unknown[]);
      return { name, ddl: sql, columns, rows };
    });
  }

  /**
   * Replace the directory with a dump — the break-glass write half (#40).
   *
   * Drop-then-replay in one transaction, exactly as `ScopeDO.importDump` does it, with
   * `defer_foreign_keys` for the same two hazards: the dump is ordered by table NAME
   * (which says nothing about foreign keys — `scopes` references `tenants`), and the
   * DROPs themselves perform an implicit DELETE that a populated child table would
   * refuse. Deferral holds every check to commit, by which point the old rows are gone
   * and the new ones are all in.
   *
   * Then the schema is re-asserted, and that is not belt-and-braces: a copy taken
   * before a directory migration carries the OLD shape, so replaying it verbatim would
   * silently roll the platform's schema backwards and the first read of a newer column
   * would fail with a bare `no such column`. `DIRECTORY_DDL` is all IF NOT EXISTS and
   * `ensureDirectoryColumns` is attempt-and-tolerate, so together they carry a restored
   * older directory forward to the running code's shape — the same contract a cold
   * start gets.
   */
  async importDump(tables: ScopeDumpTable[]): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.sql.exec('PRAGMA defer_foreign_keys = ON');
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
    // Outside the transaction, like the constructor's own path: these are idempotent
    // schema assertions, and an ALTER that has to be tolerated (duplicate column) must
    // not take the restore's data down with it.
    for (const stmt of splitSqlStatements(DIRECTORY_DDL)) this.sql.exec(stmt);
    this.ensureDirectoryColumns();
  }

  // -- tenant registry (control-plane.md §4.1) --------------------------------

  private mapTenant(r: TenantRow): Tenant {
    return {
      id: r.tenant_id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      createdAt: r.created_at,
      deletingAt: r.deleting_at ?? null,
      provisionedByTenant: r.provisioned_by_tenant ?? null,
    } as Tenant;
  }

  private readTenant(tenantId: string): Tenant | undefined {
    const row = this.sql
      .exec('SELECT * FROM tenants WHERE tenant_id = ?', tenantId)
      .toArray()[0] as TenantRow | undefined;
    return row ? this.mapTenant(row) : undefined;
  }

  /** Idempotent on the id; return the new tenant, or null if it already existed. */
  createTenant(
    id: string,
    slug: string,
    name: string,
    createdAt: string,
    provisionedByTenant: string | null = null,
  ): Tenant | null {
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
      `INSERT INTO tenants (tenant_id, slug, name, status, created_at, provisioned_by_tenant)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      id,
      slug,
      name,
      createdAt,
      provisionedByTenant,
    );
    return this.readTenant(id) ?? null;
  }

  /** Throw if absent; else UPDATE and return the previous status. */
  setTenantStatus(tenantId: string, status: TenantStatus): string {
    const before = this.readTenant(tenantId);
    if (!before) throw new Error(`unknown tenant: ${tenantId}`);
    // `reaped` is terminal and destroys data — unreachable here, only ever set by
    // reapTenant, so a plain status flip cannot forge a tombstone over live data
    // (§4.8, the tenant analogue of reapScope's archived-only gate).
    if (status === 'reaped') {
      throw new Error(
        `tenant ${tenantId} cannot be set to 'reaped' via setTenantStatus — reap goes through reapTenant (control-plane.md §4.8)`,
      );
    }
    // Stamp/clear deleting_at so the grace-window sweep can age tenants (§4.8):
    // entering `deleting` stamps, leaving it (an un-delete) clears — the same shape
    // transitionScope uses for archived_at.
    if (status === 'deleting') {
      this.sql.exec(
        'UPDATE tenants SET status = ?, deleting_at = ? WHERE tenant_id = ?',
        status,
        new Date().toISOString(),
        tenantId,
      );
    } else {
      this.sql.exec(
        'UPDATE tenants SET status = ?, deleting_at = NULL WHERE tenant_id = ?',
        status,
        tenantId,
      );
    }
    return before.status;
  }

  /**
   * The terminal tenant reap (§4.8), the tenant analogue of reapScope. The caller
   * has already reaped every scope's storage above the DO; this clears the tenant's
   * directory-side PII/config rows and flips the row to a `reaped` tombstone. Only a
   * `deleting` tenant may be reaped — an illegal source fails closed. Returns the
   * previous status (for the audit before/after). Idempotent: set-to-empty DELETEs
   * plus the status flip converge on a re-run after a partial failure.
   */
  reapTenant(tenantId: string): string {
    const before = this.readTenant(tenantId);
    if (!before) throw new Error(`unknown tenant: ${tenantId}`);
    if (before.status !== 'deleting') {
      throw new Error(
        `tenant ${tenantId} is ${before.status}, not deleting — only a deleting tenant may be reaped`,
      );
    }
    // KEPT as the tombstone: the `tenants` row itself and `_substrat_admin_log` (the
    // compliance witness — never swept). Scope rows were already reaped individually.
    for (const table of [
      '_substrat_identities', // PII: external subjects/emails bound to principals
      '_substrat_identity_pools', // the tenant's IdP topology declarations
      '_substrat_tenant_tuples', // membership + tenant-level grants
      '_substrat_roles', // operator-defined roles
      '_substrat_entitlements', // per-tenant SKU flags
      'orgs', // K-22 org records
    ]) {
      this.sql.exec(`DELETE FROM ${table} WHERE tenant_id = ?`, tenantId);
    }
    this.sql.exec(
      "UPDATE tenants SET status = 'reaped', deleting_at = NULL WHERE tenant_id = ?",
      tenantId,
    );
    return before.status;
  }

  /** Rename the DISPLAY name (never the slug); throw if absent; return the previous name. */
  setTenantName(tenantId: string, name: string): string {
    const before = this.readTenant(tenantId);
    if (!before) throw new Error(`unknown tenant: ${tenantId}`);
    this.sql.exec('UPDATE tenants SET name = ? WHERE tenant_id = ?', name, tenantId);
    return before.name;
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.readTenant(tenantId);
  }

  listTenants(page?: ListPage): Tenant[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const tail = keysetTail(where, params, 'tenant_id', page);
    const sql =
      'SELECT * FROM tenants' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + tail;
    return (this.sql.exec(sql, ...params).toArray() as unknown as TenantRow[]).map((r) =>
      this.mapTenant(r),
    );
  }

  // -- per-tenant relational stores (#301) ------------------------------------
  // The ledger only: minting the actual database (a live D1 create) is the
  // coordinator's job — it holds the platform's Cloudflare credential, this DO
  // never has (the same split secretBox uses for keys).

  getTenantStore(
    tenantId: string,
    vertical: string,
    binding: string,
  ): { kind: string; ref: string } | undefined {
    return this.sql
      .exec(
        'SELECT kind, ref FROM tenant_stores WHERE tenant_id = ? AND vertical = ? AND binding = ?',
        tenantId,
        vertical,
        binding,
      )
      .toArray()[0] as { kind: string; ref: string } | undefined;
  }

  /**
   * Record a minted store — FIRST WRITER WINS. The DO is the serialization point two
   * concurrent provisions race through: `INSERT OR IGNORE` then read back, so both
   * callers converge on one canonical row and the loser can tear its orphan mint down.
   * Fails closed on an unknown/non-active tenant, exactly as provisionScope does.
   */
  putTenantStore(row: {
    tenantId: string;
    vertical: string;
    binding: string;
    kind: string;
    ref: string;
    createdAt: string;
  }): { kind: string; ref: string } {
    const tenantRow = this.sql
      .exec('SELECT status FROM tenants WHERE tenant_id = ?', row.tenantId)
      .toArray()[0] as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision tenant store under unknown tenant: ${row.tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision tenant store under non-active tenant (status: ${tenantRow.status}): ${row.tenantId}`,
      );
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO tenant_stores (tenant_id, vertical, binding, kind, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.tenantId,
      row.vertical,
      row.binding,
      row.kind,
      row.ref,
      row.createdAt,
    );
    const stored = this.getTenantStore(row.tenantId, row.vertical, row.binding);
    if (!stored) throw new Error(`tenant store write did not land for tenant ${row.tenantId}`);
    return stored;
  }

  listTenantStores(filter: { tenantId?: string; vertical?: string }): {
    tenant_id: string;
    vertical: string;
    binding: string;
    kind: string;
    ref: string;
    created_at: string;
  }[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.vertical) {
      where.push('vertical = ?');
      params.push(filter.vertical);
    }
    return this.sql
      .exec(
        'SELECT * FROM tenant_stores' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ' ORDER BY tenant_id, vertical, binding',
        ...params,
      )
      .toArray() as unknown as {
      tenant_id: string;
      vertical: string;
      binding: string;
      kind: string;
      ref: string;
      created_at: string;
    }[];
  }

  // -- per-tenant blob stores (#473) ------------------------------------------
  // Ledger only, exactly like tenant_stores above: minting the actual bucket (a live
  // R2 create) is the coordinator's job — it holds the platform's credential.

  getBlobStore(
    tenantId: string,
    vertical: string,
    binding: string,
  ): { kind: string; ref: string } | undefined {
    return this.sql
      .exec(
        'SELECT kind, ref FROM blob_stores WHERE tenant_id = ? AND vertical = ? AND binding = ?',
        tenantId,
        vertical,
        binding,
      )
      .toArray()[0] as { kind: string; ref: string } | undefined;
  }

  /** Record a minted blob store — FIRST WRITER WINS, same race protocol as
   *  putTenantStore: INSERT OR IGNORE then read back; the loser tears its orphan down. */
  putBlobStore(row: {
    tenantId: string;
    vertical: string;
    binding: string;
    kind: string;
    ref: string;
    createdAt: string;
  }): { kind: string; ref: string } {
    const tenantRow = this.sql
      .exec('SELECT status FROM tenants WHERE tenant_id = ?', row.tenantId)
      .toArray()[0] as { status: string } | undefined;
    if (!tenantRow) {
      throw new Error(`cannot provision blob store under unknown tenant: ${row.tenantId}`);
    }
    if (tenantRow.status !== 'active') {
      throw new Error(
        `cannot provision blob store under non-active tenant (status: ${tenantRow.status}): ${row.tenantId}`,
      );
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO blob_stores (tenant_id, vertical, binding, kind, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.tenantId,
      row.vertical,
      row.binding,
      row.kind,
      row.ref,
      row.createdAt,
    );
    const stored = this.getBlobStore(row.tenantId, row.vertical, row.binding);
    if (!stored) throw new Error(`blob store write did not land for tenant ${row.tenantId}`);
    return stored;
  }

  listBlobStores(filter: { tenantId?: string; vertical?: string }): {
    tenant_id: string;
    vertical: string;
    binding: string;
    kind: string;
    ref: string;
    created_at: string;
  }[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.vertical) {
      where.push('vertical = ?');
      params.push(filter.vertical);
    }
    return this.sql
      .exec(
        'SELECT * FROM blob_stores' +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ' ORDER BY tenant_id, vertical, binding',
        ...params,
      )
      .toArray() as unknown as {
      tenant_id: string;
      vertical: string;
      binding: string;
      kind: string;
      ref: string;
      created_at: string;
    }[];
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
      forkedFrom: string | null;
      forkedAt: string | null;
      expiresAt: string | null;
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
      // An `archived` scope (a deleted app) has released its name — and `reaped` is past
      // archived, so it too has released it — both excluded so the slug can be reclaimed.
      const slugOwner = this.sql
        .exec(
          "SELECT scope_id FROM scopes WHERE tenant_id = ? AND slug = ? AND status NOT IN ('archived', 'reaped')",
          tenantId,
          record.slug,
        )
        .toArray()[0] as { scope_id: string } | undefined;
      if (slugOwner) {
        throw new Error(
          `scope slug '${record.slug}' already taken under tenant ${tenantId} ` +
            `by ${slugOwner.scope_id} (slugs are unique within a tenant)`,
        );
      }
      // A scope born while its vertical serves in place (#286) is born ON the serving
      // script — provisioning dispatches there — so its routing points there from row
      // one. Sub-selected at insert: per-scope truth that later serves can't disturb.
      //
      // EXCEPTION (#527): a PREVIEW must NOT inherit the serving script. A preview forks
      // into — and binds — a specific (usually not-yet-serving) version's per-version
      // dispatch script, which is where `orchestratedPreview` restores its data. Inheriting
      // `serving_ref` would make `readHostname`'s `COALESCE(s.serving_ref, vv.deployment_ref)`
      // route the preview to the PROD serving script (prod code, and a fresh/empty DO in
      // that script) instead of the version it just bound — reporting success while serving
      // someone else's build. A null slug matches no `verticals` row, so the scalar
      // sub-select yields NULL and routing falls through to the bound version's ref.
      const inheritServingSlug = record.kind === 'preview' ? null : record.vertical;
      this.sql.exec(
        `INSERT INTO scopes
           (scope_id, tenant_id, parent_scope_id, slug, kind, name, vertical,
            storage_shape, jurisdiction, status, forked_from, forked_at, expires_at,
            serving_ref, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?,
                 (SELECT serving_ref FROM verticals WHERE slug = ?), ?)`,
        scopeId,
        tenantId,
        record.slug,
        record.kind,
        record.name,
        record.vertical,
        record.storageShape,
        record.jurisdiction,
        record.forkedFrom,
        record.forkedAt,
        record.expiresAt,
        inheritServingSlug,
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

  listScopes(
    filter: {
      tenantId?: string;
      status?: string[];
      vertical?: string;
    } & ListPage,
  ): ScopeRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
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
    const tail = keysetTail(where, params, 'scope_id', filter);
    const sql =
      'SELECT * FROM scopes' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + tail;
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
    // Stamp/clear archived_at so the reap sweep can age scopes. Entering `archived`
    // records when; `unarchive` (→ active, a restore per §4.2) clears it so a later
    // re-archive dates from the new event. `reaped` keeps it — it is terminal history.
    if (to === 'archived') {
      this.sql.exec(
        'UPDATE scopes SET status = ?, archived_at = ? WHERE scope_id = ?',
        to,
        new Date().toISOString(),
        scopeId,
      );
    } else if (to === 'active') {
      this.sql.exec(
        'UPDATE scopes SET status = ?, archived_at = NULL WHERE scope_id = ?',
        to,
        scopeId,
      );
    } else {
      this.sql.exec('UPDATE scopes SET status = ? WHERE scope_id = ?', to, scopeId);
    }
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
  listRoles(filter: { tenantId?: string; source?: string } & ListPage): RoleRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    const order = (filter.order ?? 'asc') === 'desc' ? 'DESC' : 'ASC';
    if (filter.cursor) {
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
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
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

  readHostname(
    hostname: string,
  ): (HostnameRow & { deployment_ref: string | null; outbound_json: string | null }) | undefined {
    // Join the scope's dispatch script, so the router resolves it in the same one
    // directory read (orchestration.md §5.4). A scope whose data lives in the stable
    // serving script (#286) routes THERE — per-scope truth, because rerouting a scope
    // whose Durable Objects sit in a per-version script would resolve empty storage.
    // Falls back to the bound version's own script (legacy per-version dispatch); LEFT
    // joins: a scope with neither resolves with deployment_ref = null.
    //
    // `outbound_json` is the declared outbound surface of the CODE THIS DISPATCH RUNS
    // (#303, D-46): the serving script executes the registry's serving version, so when
    // serving_ref wins the list comes from THAT version's manifest, not the scope's
    // bound one (the two can skew mid-promote — the policy must follow the bundle).
    // The per-version fallback runs the bound version's bundle, so it reads vv's.
    // json_extract keeps the hot path from parsing whole manifests in JS: SQLite hands
    // back just the `outbound` array as JSON text, or NULL for a pre-#303 manifest —
    // which the egress worker treats as unenforced-but-metered.
    return this.sql
      .exec(
        `SELECT h.*, COALESCE(s.serving_ref, vv.deployment_ref) AS deployment_ref,
                s.status AS scope_status,
                CASE WHEN s.serving_ref IS NOT NULL
                     THEN json_extract(sv.manifest_json, '$.outbound')
                     ELSE json_extract(vv.manifest_json, '$.outbound') END AS outbound_json
           FROM hostnames h
           LEFT JOIN scopes s ON s.scope_id = h.scope_id
           LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
           LEFT JOIN verticals vr ON vr.slug = s.vertical
           LEFT JOIN vertical_versions sv ON sv.id = vr.serving_version_id
          WHERE h.hostname = ?`,
        hostname,
      )
      .toArray()[0] as unknown as
      | (HostnameRow & { deployment_ref: string | null; outbound_json: string | null })
      | undefined;
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
    // INSERT OR REPLACE resets issuance columns to NULL — a (re)bind starts a fresh
    // lifecycle, so any prior CF hostname id / DNS records must not linger onto the new
    // one. `pending` is the birth state; issuance moves it from there.
    this.sql.exec(
      `INSERT OR REPLACE INTO hostnames
         (hostname, tenant_id, scope_id, vertical_slug, surface, region,
          status, status_note, canonical, created_at, custom_hostname_id, validation_records)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL)`,
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

  /**
   * Record the result of a Cloudflare-for-SaaS issuance step (§4.7) — the status the
   * poll resolved to, plus the CF hostname id and the DNS records to publish. The CF id
   * is written once (on create) and preserved on later reconciles (poll passes leave it
   * `undefined`); the DNS records and status are refreshed each pass. This is the only
   * writer that moves a hostname off `pending` into `verifying`/`active`/`failed` for a
   * custom domain.
   */
  setHostnameIssuance(
    hostname: string,
    fields: {
      status: string;
      note: string | null;
      customHostnameId?: string | null;
      validationRecords: string | null;
    },
  ): void {
    if (fields.customHostnameId !== undefined) {
      this.sql.exec(
        `UPDATE hostnames
            SET status = ?, status_note = ?, custom_hostname_id = ?, validation_records = ?
          WHERE hostname = ?`,
        fields.status, fields.note, fields.customHostnameId, fields.validationRecords, hostname,
      );
    } else {
      this.sql.exec(
        `UPDATE hostnames SET status = ?, status_note = ?, validation_records = ? WHERE hostname = ?`,
        fields.status, fields.note, fields.validationRecords, hostname,
      );
    }
  }

  deleteHostname(hostname: string): void {
    this.sql.exec('DELETE FROM hostnames WHERE hostname = ?', hostname);
  }

  listHostnames(
    filter: { tenantId?: string; scopeId?: string; status?: string; verticalSlug?: string } & ListPage,
  ): HostnameRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId); }
    if (filter.scopeId) { where.push('scope_id = ?'); params.push(filter.scopeId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.verticalSlug) { where.push('vertical_slug = ?'); params.push(filter.verticalSlug); }
    const tail = keysetTail(where, params, 'hostname', filter);
    let sql = 'SELECT * FROM hostnames';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += tail;
    return this.sql.exec(sql, ...params).toArray() as unknown as HostnameRow[];
  }

  // -- vertical + version registry (#31) --------------------------------------

  readVertical(slug: string): VerticalRow | undefined {
    return this.sql
      .exec('SELECT * FROM verticals WHERE slug = ?', slug)
      .toArray()[0] as unknown as VerticalRow | undefined;
  }

  insertVertical(slug: string, name: string, source: string, ownerTenant: string | null, envSpec: string | null, installSpec: string | null, listed: number, createdAt: string): void {
    this.sql.exec(
      'INSERT INTO verticals (slug, name, source, owner_tenant, env_spec, install_spec, listed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      slug, name, source, ownerTenant, envSpec, installSpec, listed, createdAt,
    );
  }

  /** Refresh a vertical's declared env-spec + install-spec (both evolve with the manifest).
   *  `listed` rides along ONLY for builtin re-seeds (null ⇒ leave it alone): a pushed
   *  vertical's `listed` is the staff publish decision, never touched by a re-push. */
  updateVerticalManifestMeta(slug: string, envSpec: string | null, installSpec: string | null, listed?: number | null): void {
    this.sql.exec('UPDATE verticals SET env_spec = ?, install_spec = ? WHERE slug = ?', envSpec, installSpec, slug);
    if (listed !== null && listed !== undefined) {
      this.sql.exec('UPDATE verticals SET listed = ? WHERE slug = ?', listed, slug);
    }
  }

  /** Publish/unpublish a vertical to the public marketplace + resolve any pending request. */
  updateVerticalListed(slug: string, listed: number): void {
    this.sql.exec('UPDATE verticals SET listed = ?, publish_requested_at = NULL WHERE slug = ?', listed, slug);
  }

  /** Record a builder's pending publish request (marketplace-publish.md §5). */
  updateVerticalPublishRequest(slug: string, requestedAt: string): void {
    this.sql.exec('UPDATE verticals SET publish_requested_at = ? WHERE slug = ?', requestedAt, slug);
  }

  /** Block/unblock new installs of a vertical (staff kill-switch). */
  updateVerticalInstallsBlocked(slug: string, blocked: number): void {
    this.sql.exec('UPDATE verticals SET installs_blocked = ? WHERE slug = ?', blocked, slug);
  }

  /** Grant/revoke the tenant-provisioner capability (#412, staff grant). */
  updateVerticalTenantProvisioner(slug: string, granted: number): void {
    this.sql.exec('UPDATE verticals SET tenant_provisioner = ? WHERE slug = ?', granted, slug);
  }

  /** Grant/revoke the email-sender capability (#303, staff grant). */
  updateVerticalEmailSender(slug: string, granted: number): void {
    this.sql.exec('UPDATE verticals SET email_sender = ? WHERE slug = ?', granted, slug);
  }

  /**
   * How many scopes a vertical still backs, split by liveness — deleteVertical's refusal
   * reads this. `reaped` rows are excluded outright: a reaped scope is terminal history
   * and must never pin a registry row forever. `archived` counts separately: it can still
   * be restored (unarchiveScope), so it blocks, but the refusal names reap/restore as the
   * remaining step — the app was already deleted.
   */
  countScopesForVertical(slug: string): { live: number; archived: number } {
    const r = this.sql
      .exec(
        'SELECT ' +
          "COUNT(*) FILTER (WHERE status NOT IN ('archived', 'reaped')) AS live, " +
          "COUNT(*) FILTER (WHERE status = 'archived') AS archived " +
          'FROM scopes WHERE vertical = ?',
        slug,
      )
      .toArray()[0] as unknown as { live: number; archived: number } | undefined;
    return { live: r?.live ?? 0, archived: r?.archived ?? 0 };
  }

  /**
   * Remove a vertical's registry presence: channels, versions, the row. The bound-scope
   * refusal lives host-side (the audited seam), not here — this is the storage verb.
   */
  deleteVertical(slug: string): void {
    this.sql.exec('DELETE FROM vertical_channels WHERE vertical_slug = ?', slug);
    this.sql.exec('DELETE FROM vertical_channel_history WHERE vertical_slug = ?', slug);
    this.sql.exec('DELETE FROM vertical_versions WHERE vertical_slug = ?', slug);
    this.sql.exec('DELETE FROM verticals WHERE slug = ?', slug);
  }

  listVerticals(page?: ListPage): VerticalRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const tail = keysetTail(where, params, 'slug', page);
    const sql =
      'SELECT * FROM verticals' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + tail;
    return this.sql.exec(sql, ...params).toArray() as unknown as VerticalRow[];
  }

  readVersion(id: string): VersionRow | undefined {
    return this.sql
      .exec('SELECT * FROM vertical_versions WHERE id = ?', id)
      .toArray()[0] as unknown as VersionRow | undefined;
  }

  insertVersion(v: {
    id: string; verticalSlug: string; version: string; manifestDigest: string;
    permissionDigest: string; migrationDigest: string; deploymentRef: string | null;
    admission: string; admissionNote: string | null; manifestJson: string | null;
    originJson: string | null;
    createdAt: string;
  }): void {
    this.sql.exec(
      `INSERT INTO vertical_versions
         (id, vertical_slug, version, manifest_digest, permission_digest,
          migration_digest, deployment_ref, admission, admission_note, manifest_json,
          origin_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.id, v.verticalSlug, v.version, v.manifestDigest, v.permissionDigest,
      v.migrationDigest, v.deploymentRef, v.admission, v.admissionNote, v.manifestJson,
      v.originJson, v.createdAt,
    );
  }

  /** Record what the serving script now runs — written only after a successful
   *  in-place upload, so a failed serve leaves the trailing state visible. */
  setVerticalServing(
    slug: string,
    s: { ref: string; versionId: string; doClassesJson: string; migrationTag: string },
  ): void {
    this.sql.exec(
      `UPDATE verticals SET serving_ref = ?, serving_version_id = ?,
              serving_do_classes = ?, serving_migration_tag = ? WHERE slug = ?`,
      s.ref, s.versionId, s.doClassesJson, s.migrationTag, slug,
    );
  }

  /** Point a scope's routing at the serving script its data now lives in (#286). */
  setScopeServingRef(scopeId: string, servingRef: string | null): void {
    this.sql.exec('UPDATE scopes SET serving_ref = ? WHERE scope_id = ?', servingRef, scopeId);
  }

  /** Move a fork's GC deadline forward, or pin it (`null`) — preview-and-snapshots.md §9. */
  setScopeExpiresAt(scopeId: string, expiresAt: string | null): void {
    this.sql.exec('UPDATE scopes SET expires_at = ? WHERE scope_id = ?', expiresAt, scopeId);
  }

  listVersions(verticalSlug: string, page?: ListPage): VersionRow[] {
    const where: string[] = ['vertical_slug = ?'];
    const params: (string | number)[] = [verticalSlug];
    const tail = keysetTail(where, params, 'id', page);
    return this.sql
      .exec(`SELECT * FROM vertical_versions WHERE ${where.join(' AND ')}${tail}`, ...params)
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

  /**
   * Remove a reaped fork's directory presence: hostname bindings + the scope row
   * (preview-and-snapshots.md §9). The coordinator's deleteSnapshot calls this AFTER
   * wiping the scope DO's storage — the fork-only refusal lives there, not here.
   */
  deleteScopeDirectory(scopeId: string): void {
    this.sql.exec('DELETE FROM hostnames WHERE scope_id = ?', scopeId);
    this.sql.exec('DELETE FROM scopes WHERE scope_id = ?', scopeId);
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

  listChannels(verticalSlug: string, page?: ListPage): ChannelRow[] {
    const where: string[] = ['vertical_slug = ?'];
    const params: (string | number)[] = [verticalSlug];
    const tail = keysetTail(where, params, 'channel', page);
    return this.sql
      .exec(`SELECT * FROM vertical_channels WHERE ${where.join(' AND ')}${tail}`, ...params)
      .toArray() as unknown as ChannelRow[];
  }

  insertChannelHistory(h: ChannelHistoryRow): void {
    this.sql.exec(
      `INSERT INTO vertical_channel_history
         (id, vertical_slug, channel, version_id, from_version_id, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      h.id, h.vertical_slug, h.channel, h.version_id, h.from_version_id, h.actor, h.at,
    );
  }

  listChannelHistory(verticalSlug: string, channel?: string, page?: ListPage): ChannelHistoryRow[] {
    const where: string[] = ['vertical_slug = ?'];
    const params: (string | number)[] = [verticalSlug];
    if (channel) {
      where.push('channel = ?');
      params.push(channel);
    }
    // Newest first is the shipped order, so 'desc' is the DEFAULT here.
    const tail = keysetTail(where, params, 'id', page, 'desc');
    return this.sql
      .exec(`SELECT * FROM vertical_channel_history WHERE ${where.join(' AND ')}${tail}`, ...params)
      .toArray() as unknown as ChannelHistoryRow[];
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
  // #33: the flag carries plan fields. The PATCH merge (omitted preserves, null
  // clears) lives HERE so there is exactly one implementation per adapter; the
  // host audits from the before/after this returns.

  private readEntitlement(tenantId: string, key: string): EntitlementRow | null {
    return (
      (this.sql
        .exec(
          `SELECT entitlement_key, expires_at, quota, plan, granted_at, granted_by
           FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?`,
          tenantId,
          key,
        )
        .toArray()[0] as unknown as EntitlementRow | undefined) ?? null
    );
  }

  /**
   * Upsert; returns before/after for the host's audit row, `changed: false` when
   * the merged result equals what the row already carried (not audited upstream).
   */
  grantEntitlement(
    tenantId: string,
    key: string,
    input: { expiresAt?: string | null; quota?: number | null; plan?: string | null },
    actor: string,
  ): { changed: boolean; before: EntitlementRow | null; after: EntitlementRow } {
    const existing = this.readEntitlement(tenantId, key);
    const next = {
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : (existing?.expires_at ?? null),
      quota: input.quota !== undefined ? input.quota : (existing?.quota ?? null),
      plan: input.plan !== undefined ? input.plan : (existing?.plan ?? null),
    };
    if (
      existing &&
      existing.expires_at === next.expiresAt &&
      existing.quota === next.quota &&
      existing.plan === next.plan
    ) {
      return { changed: false, before: existing, after: existing };
    }
    // granted_at/granted_by restamp on every effective change: a renewal is a
    // new grant act, and the full history is the admin log.
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO _substrat_entitlements
         (tenant_id, entitlement_key, expires_at, quota, plan, granted_at, granted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, entitlement_key) DO UPDATE SET
         expires_at = excluded.expires_at,
         quota = excluded.quota,
         plan = excluded.plan,
         granted_at = excluded.granted_at,
         granted_by = excluded.granted_by`,
      tenantId,
      key,
      next.expiresAt,
      next.quota,
      next.plan,
      now,
      actor,
    );
    return {
      changed: true,
      before: existing,
      after: {
        entitlement_key: key,
        expires_at: next.expiresAt,
        quota: next.quota,
        plan: next.plan,
        granted_at: now,
        granted_by: actor,
      },
    };
  }

  /** DELETE; returns the removed row (the host's audit `before`), null if none. */
  revokeEntitlement(tenantId: string, key: string): EntitlementRow | null {
    const existing = this.readEntitlement(tenantId, key);
    if (!existing) return null;
    this.sql.exec(
      'DELETE FROM _substrat_entitlements WHERE tenant_id = ? AND entitlement_key = ?',
      tenantId,
      key,
    );
    return existing;
  }

  tenantHoldsEntitlement(tenantId: string, key: string): boolean {
    // An expired grant fails closed, exactly as if revoked (#33) — evaluated
    // lazily at check time like tuple expiry; the row survives for renewal.
    return (
      this.sql
        .exec(
          `SELECT 1 FROM _substrat_entitlements
           WHERE tenant_id = ? AND entitlement_key = ?
             AND (expires_at IS NULL OR expires_at > ?)`,
          tenantId,
          key,
          new Date().toISOString(),
        )
        .toArray()[0] !== undefined
    );
  }

  listEntitlements(tenantId: string): EntitlementRow[] {
    return this.sql
      .exec(
        `SELECT entitlement_key, expires_at, quota, plan, granted_at, granted_by
         FROM _substrat_entitlements WHERE tenant_id = ? ORDER BY entitlement_key`,
        tenantId,
      )
      .toArray() as unknown as EntitlementRow[];
  }

  /**
   * The rows §5's meters are folded from (#38) — tenants, their scopes' statuses, and
   * the entitlement store, optionally narrowed to one tenant.
   *
   * Three projections, not three tables: only the columns the fold reads cross the RPC
   * boundary, so metering the fleet does not copy every scope record into the caller.
   * The arithmetic itself is `foldMeterReading` in the kernel — the billable rule is one
   * definition shared with the SQLite adapter, never a second `GROUP BY` in a second
   * dialect.
   */
  meterRows(tenantId?: string): {
    tenants: { tenant_id: string; slug: string; status: string }[];
    scopes: { tenant_id: string; status: string }[];
    entitlements: { tenant_id: string; entitlement_key: string; plan: string | null; expires_at: string | null }[];
  } {
    const where = tenantId ? ' WHERE tenant_id = ?' : '';
    const args = tenantId ? [tenantId] : [];
    return {
      tenants: this.sql
        .exec(`SELECT tenant_id, slug, status FROM tenants${where}`, ...args)
        .toArray() as unknown as { tenant_id: string; slug: string; status: string }[],
      scopes: this.sql
        .exec(`SELECT tenant_id, status FROM scopes${where}`, ...args)
        .toArray() as unknown as { tenant_id: string; status: string }[],
      entitlements: this.sql
        .exec(`SELECT tenant_id, entitlement_key, plan, expires_at FROM _substrat_entitlements${where}`, ...args)
        .toArray() as unknown as {
        tenant_id: string;
        entitlement_key: string;
        plan: string | null;
        expires_at: string | null;
      }[],
    };
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
    // Live-uniqueness is per ACCOUNT (COALESCEd like the index): a provider
    // without account refs stays a singleton; a multi-namespace provider may
    // hold one live connection per external account.
    const live = this.sql
      .exec(
        `SELECT id FROM _substrat_connections
         WHERE tenant_id = ? AND vertical = ? AND provider = ?
           AND COALESCE(external_account_ref, '') = COALESCE(?, '') AND revoked_at IS NULL`,
        row.tenantId,
        row.vertical,
        row.provider,
        row.externalAccountRef,
      )
      .toArray()[0] as unknown as { id: string } | undefined;
    if (live) {
      const account = row.externalAccountRef ? ` under account '${row.externalAccountRef}'` : '';
      throw new Error(
        `tenant ${row.tenantId} already has a live '${row.provider}' connection ` +
          `for vertical '${row.vertical}'${account} — revoke it before connecting another`,
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

  /** This connection's key rows — every one, current and retired (#687). */
  readConnectionKeys(connectionId: string): {
    key_id: string;
    public_key: string;
    wrapped_key_id: string;
    wrapped_private: string;
    retired_at: string | null;
  }[] {
    return this.sql
      .exec(
        `SELECT key_id, public_key, wrapped_key_id, wrapped_private, retired_at
         FROM _substrat_connection_keys WHERE connection_id = ?`,
        connectionId,
      )
      .toArray() as unknown as {
      key_id: string;
      public_key: string;
      wrapped_key_id: string;
      wrapped_private: string;
      retired_at: string | null;
    }[];
  }

  /**
   * Insert a minted keypair, returning the CURRENT key after the write (#687).
   *
   * Returns rather than voids because minting races: two provisions of the same
   * tenant can ask at once, and the loser must adopt the winner's key — a second
   * current key would orphan whatever the first already sealed. `OR IGNORE`
   * against the partial-unique index makes losing silent, and the re-read makes
   * it correct.
   */
  insertConnectionKey(row: {
    connectionId: string;
    keyId: string;
    publicKey: string;
    wrappedKeyId: string;
    wrappedPrivate: string;
    createdAt: string;
  }): { key_id: string; public_key: string } | undefined {
    this.sql.exec(
      `INSERT OR IGNORE INTO _substrat_connection_keys
         (connection_id, key_id, public_key, wrapped_key_id, wrapped_private, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      row.connectionId,
      row.keyId,
      row.publicKey,
      row.wrappedKeyId,
      row.wrappedPrivate,
      row.createdAt,
    );
    return this.sql
      .exec(
        `SELECT key_id, public_key FROM _substrat_connection_keys
         WHERE connection_id = ? AND retired_at IS NULL`,
        row.connectionId,
      )
      .toArray()[0] as unknown as { key_id: string; public_key: string } | undefined;
  }

  listConnections(filter: {
    tenantId?: string;
    vertical?: string;
    provider?: string;
    externalAccountRef?: string;
    includeRevoked?: boolean;
  }): ConnectionDoRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.tenantId) (where.push('tenant_id = ?'), params.push(filter.tenantId));
    if (filter.vertical) (where.push('vertical = ?'), params.push(filter.vertical));
    if (filter.provider) (where.push('provider = ?'), params.push(filter.provider));
    if (filter.externalAccountRef)
      (where.push('external_account_ref = ?'), params.push(filter.externalAccountRef));
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

  /** The live connection for a triple (narrowed to one account when given), plus its sealed blob — the connector read. */
  readLiveConnection(
    tenantId: string,
    vertical: string,
    provider: string,
    externalAccountRef?: string,
  ): (ConnectionDoRow & { key_id: string; ciphertext: string }) | undefined {
    const rows = this.sql
      .exec(
        `SELECT c.*, s.key_id, s.ciphertext
         FROM _substrat_connections c
         JOIN _substrat_connection_secrets s ON s.connection_id = c.id
         WHERE c.tenant_id = ? AND c.vertical = ? AND c.provider = ? AND c.revoked_at IS NULL
         ${externalAccountRef === undefined ? '' : 'AND c.external_account_ref = ?'}
         LIMIT 2`,
        ...(externalAccountRef === undefined
          ? [tenantId, vertical, provider]
          : [tenantId, vertical, provider, externalAccountRef]),
      )
      .toArray() as unknown as (ConnectionDoRow & { key_id: string; ciphertext: string })[];
    // Several live accounts and no selector: failing beats acting against an
    // arbitrary one of the tenant's provider accounts (scope-host.ts).
    if (rows.length > 1) {
      throw new Error(
        `tenant ${tenantId} has multiple live '${provider}' connections for vertical ` +
          `'${vertical}' — pass externalAccountRef to select one`,
      );
    }
    return rows[0];
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
    // #592: its grants tombstone (K-21 — evidence, not roster). Absent from the
    // next gather, so no later provision/reconcile delivers them again.
    this.sql.exec(
      `UPDATE _substrat_connection_grants SET revoked_at = ?
       WHERE connection_id = ? AND revoked_at IS NULL`,
      at,
      id,
    );
    return true;
  }

  /**
   * Record a connection grant directory-side (#592) — written by `grantToConnection`
   * alongside the enforcement tuple, upserting in place on re-grant (the unique
   * (connection, permission, target) index). This row is what provision/reconcile
   * gather FROM; the tuple stays the only thing the permission checker reads.
   */
  recordConnectionGrant(row: {
    connectionId: string;
    tenantId: string;
    vertical: string;
    permission: string;
    scopeId: string | null;
    expiresAt: string | null;
    grantedBy: string;
    grantedAt: string;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO _substrat_connection_grants
         (connection_id, tenant_id, vertical, permission, scope_id, expires_at,
          granted_by, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      row.connectionId,
      row.tenantId,
      row.vertical,
      row.permission,
      row.scopeId,
      row.expiresAt,
      row.grantedBy,
      row.grantedAt,
    );
  }

  /** The tenant's LIVE connection grants (#592) — the provision/reconcile gather read. */
  listConnectionGrants(tenantId: string): ConnectionGrantDoRow[] {
    return this.sql
      .exec(
        `SELECT * FROM _substrat_connection_grants
         WHERE tenant_id = ? AND revoked_at IS NULL
         ORDER BY connection_id, permission`,
        tenantId,
      )
      .toArray() as unknown as ConnectionGrantDoRow[];
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

  /**
   * ALL of a tenant's identity links — the read behind identity-link projection
   * (#406), symmetric with `dumpTenantTuples` above. No tombstones to carry:
   * `unlinkIdentity` hard-deletes (the admin log is the audit), so the projection
   * is a full replace and a removed link is simply absent from the next snapshot.
   * Not on the request hot path — this runs on the admin write path, projecting
   * into a tenant's scopes, and at provision/reconcile gathering.
   */
  dumpTenantIdentities(
    tenantId: string,
  ): { provider: string; external_id: string; principal_id: string; scope_id: string | null }[] {
    return this.sql
      .exec(
        `SELECT provider, external_id, principal_id, scope_id FROM _substrat_identities
         WHERE tenant_id = ?`,
        tenantId,
      )
      .toArray() as unknown as {
      provider: string;
      external_id: string;
      principal_id: string;
      scope_id: string | null;
    }[];
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
    drained?: boolean;
  } & ListPage): AccessLogRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.actor) { where.push('actor = ?'); params.push(query.actor); }
    if (query.tenantId) { where.push('tenant_id = ?'); params.push(query.tenantId); }
    if (query.method) { where.push('method = ?'); params.push(query.method); }
    if (query.drained !== undefined) {
      where.push(query.drained ? 'drained_at IS NOT NULL' : 'drained_at IS NULL');
    }
    // Cursor + order mirror auditLog: the id is a ULID, so it IS the cursor.
    const tail = keysetTail(where, params, 'id', query);
    let sql = 'SELECT * FROM _substrat_access_log';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += tail;
    return this.sql.exec(sql, ...params).toArray() as unknown as AccessLogRow[];
  }

  /**
   * Stamp `drained_at` on undrained rows up to `upToId`. The `IS NULL` guard makes a
   * retried shipment idempotent — it re-stamps nothing and returns 0 (K-24).
   */
  markAccessLogDrained(upToId: string, drainedAt: string): number {
    const doomed = (
      this.sql
        .exec(
          'SELECT id FROM _substrat_access_log WHERE id <= ? AND drained_at IS NULL',
          upToId,
        )
        .toArray() as unknown as { id: string }[]
    ).map((r) => r.id);
    for (const id of doomed) {
      this.sql.exec('UPDATE _substrat_access_log SET drained_at = ? WHERE id = ?', drainedAt, id);
    }
    return doomed.length;
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

  // -- per-subject keys (#37) -------------------------------------------------
  // The three row operations `createSubjectKeys` needs. The crypto is the kernel's; what
  // lives here is storage, which is the only part that differs between adapters.

  readSubjectKey(
    scopeId: string,
    subjectId: string,
  ): { keyId: string | null; wrappedDek: string | null; shreddedAt: string | null } | undefined {
    const row = (
      this.sql
        .exec(
          'SELECT key_id, wrapped_dek, shredded_at FROM _substrat_subject_keys WHERE scope_id = ? AND subject_id = ?',
          scopeId,
          subjectId,
        )
        .toArray() as unknown as {
        key_id: string | null;
        wrapped_dek: string | null;
        shredded_at: string | null;
      }[]
    )[0];
    return row
      ? { keyId: row.key_id, wrappedDek: row.wrapped_dek, shreddedAt: row.shredded_at }
      : undefined;
  }

  /**
   * `OR IGNORE`, not `OR REPLACE`: two exports of the same subject can race to mint, and
   * the loser must not overwrite the winner — a replaced key orphans everything the first
   * one already sealed.
   */
  insertSubjectKey(input: {
    scopeId: string;
    subjectId: string;
    tenantId: string;
    keyId: string;
    wrappedDek: string;
    createdAt: string;
  }): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO _substrat_subject_keys
         (scope_id, subject_id, tenant_id, key_id, wrapped_dek, created_at, shredded_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      input.scopeId,
      input.subjectId,
      input.tenantId,
      input.keyId,
      input.wrappedDek,
      input.createdAt,
    );
  }

  /**
   * Clear the key, keep the row, stamp the time. Upserted rather than updated so that
   * shredding a subject who was never exported still leaves the tombstone — otherwise a
   * LATER export mints them a fresh key and the erasure quietly undoes itself.
   */
  tombstoneSubjectKey(input: {
    scopeId: string;
    subjectId: string;
    tenantId: string;
    at: string;
  }): { existed: boolean } {
    const existing = (
      this.sql
        .exec(
          'SELECT wrapped_dek FROM _substrat_subject_keys WHERE scope_id = ? AND subject_id = ?',
          input.scopeId,
          input.subjectId,
        )
        .toArray() as unknown as { wrapped_dek: string | null }[]
    )[0];
    this.sql.exec(
      `INSERT INTO _substrat_subject_keys
         (scope_id, subject_id, tenant_id, key_id, wrapped_dek, created_at, shredded_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (scope_id, subject_id)
         DO UPDATE SET key_id = NULL, wrapped_dek = NULL, shredded_at = ?`,
      input.scopeId,
      input.subjectId,
      input.tenantId,
      input.at,
      input.at,
      input.at,
    );
    return { existed: existing?.wrapped_dek != null };
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

  recordOpsFailure(row: OpsFailureRow): void {
    this.sql.exec(
      `INSERT INTO _substrat_ops_failures
         (id, actor, operation, stage, tenant_id, scope_id, vertical, status, message, reference, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.actor,
      row.operation,
      row.stage,
      row.tenant_id,
      row.scope_id,
      row.vertical,
      row.status,
      row.message,
      row.reference,
      row.at,
    );
    // Prune-on-write (#559): the retention lives HERE, not in a cron — every insert
    // pays for its own housekeeping, so the table stays bounded even on a deployment
    // whose scheduled pass is broken (the exact circumstance this table records).
    const horizon = new Date(Date.now() - OPS_FAILURE_RETENTION_DAYS * 86_400_000).toISOString();
    this.sql.exec('DELETE FROM _substrat_ops_failures WHERE at < ?', horizon);
  }

  listOpsFailures(query: OpsFailureQuery): OpsFailureEntry[] {
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
    if (query.vertical) {
      where.push('vertical = ?');
      params.push(query.vertical);
    }
    if (query.operation) {
      where.push('operation = ?');
      params.push(query.operation);
    }
    if (query.reference) {
      where.push('reference = ?');
      params.push(query.reference);
    }
    if (query.since) {
      where.push('at >= ?');
      params.push(query.since);
    }
    if (query.until) {
      where.push('at < ?');
      params.push(query.until);
    }
    // Default DESC, unlike the audit log: an operator asks "what broke lately".
    const order = (query.order ?? 'desc') === 'desc' ? 'DESC' : 'ASC';
    if (query.cursor) {
      // ULID order is chronological, so the entry id IS the cursor.
      where.push(order === 'DESC' ? 'id < ?' : 'id > ?');
      params.push(query.cursor);
    }
    let sql =
      'SELECT * FROM _substrat_ops_failures' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id ${order}`;
    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    const rows = this.sql.exec(sql, ...params).toArray() as unknown as OpsFailureRow[];
    return rows.map((r) => ({
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
    })) as OpsFailureEntry[];
  }
}
