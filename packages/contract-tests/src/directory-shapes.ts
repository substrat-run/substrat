/**
 * Every shape a directory table has had (#1912), as `directoryRestoreSuite` feeds them to a
 * restore. Read off the history of `DIRECTORY_DDL` (`adapter-cloudflare/src/control-plane-do.ts`)
 * and of the pure adapter's `applyDirectorySchema`, which built the same column sets within days
 * of each other, plus one of its own (#1173's scopes): one entry per distinct column set a
 * `CREATE TABLE` ever produced, with the date, commit and PR that introduced it, the DDL as SQLite stored it (comments dropped) and the columns in
 * the order a dump lists them. A directory created on that day and never migrated dumps exactly
 * that; one migrated forward by `ensureDirectoryColumns` dumps the ALTERed-up shapes below.
 *
 * Every `NOT NULL` column without a default is present in each table's first shape, and every
 * later column is nullable or defaulted, so each of these loads by column name into today's table.
 * The spine's own shapes are #1911's, and not listed here.
 */
export interface DirectoryShape {
  table: string;
  since: string;
  ddl: string;
  columns: string[];
}

/** Each table as a `CREATE TABLE` built it, oldest first. */
export const CREATED_SHAPES: readonly DirectoryShape[] = [
  {
    table: "tenants",
    since: "2026-07-15 ffe3be118",
    ddl: "CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)",
    columns: ["tenant_id", "slug", "name", "status", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-15 ffe3be118",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "storage_shape", "jurisdiction", "status", "schema_version", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-17 6a2f02d3f",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-18 82251c2b2 #32",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "created_at"],
  },
  {
    table: "orgs",
    since: "2026-07-19 79ebc10ce",
    ddl: "CREATE TABLE orgs (org_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)",
    columns: ["org_id", "tenant_id", "slug", "name", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-19 d135831f7",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', vertical_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "vertical_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-07-19 d135831f7",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "created_at"],
  },
  {
    table: "vertical_versions",
    since: "2026-07-19 d135831f7",
    ddl: "CREATE TABLE vertical_versions (id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, version TEXT NOT NULL, manifest_digest TEXT NOT NULL, permission_digest TEXT NOT NULL, migration_digest TEXT NOT NULL, deployment_ref TEXT, admission TEXT NOT NULL, admission_note TEXT, created_at TEXT NOT NULL, UNIQUE (vertical_slug, version))",
    columns: ["id", "vertical_slug", "version", "manifest_digest", "permission_digest", "migration_digest", "deployment_ref", "admission", "admission_note", "created_at"],
  },
  {
    table: "vertical_channels",
    since: "2026-07-19 c5a565bc4",
    ddl: "CREATE TABLE vertical_channels (vertical_slug TEXT NOT NULL, channel TEXT NOT NULL, version_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (vertical_slug, channel))",
    columns: ["vertical_slug", "channel", "version_id", "updated_at"],
  },
  {
    table: "hostnames",
    since: "2026-07-19 053afb1f9",
    ddl: "CREATE TABLE hostnames (hostname TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope_id TEXT NOT NULL, vertical_slug TEXT, surface TEXT NOT NULL, region TEXT, status TEXT NOT NULL, status_note TEXT, canonical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
    columns: ["hostname", "tenant_id", "scope_id", "vertical_slug", "surface", "region", "status", "status_note", "canonical", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-07-23 73c0cdb64 #185",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-07-24 6a7768aa2 #223",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "env_spec", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-07-25 1022c15e3 #225",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, install_spec TEXT, listed INTEGER NOT NULL DEFAULT 0, publish_requested_at TEXT, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "env_spec", "install_spec", "listed", "publish_requested_at", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-25 673aede20 #231",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', vertical_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, forked_from TEXT, forked_at TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "vertical_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "forked_from", "forked_at", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-25 1c6723ea4 #234",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', vertical_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, forked_from TEXT, forked_at TEXT, expires_at TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "vertical_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "forked_from", "forked_at", "expires_at", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-07-26 ec89a88b1 #252",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, install_spec TEXT, listed INTEGER NOT NULL DEFAULT 0, publish_requested_at TEXT, installs_blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "env_spec", "install_spec", "listed", "publish_requested_at", "installs_blocked", "created_at"],
  },
  {
    table: "vertical_channel_history",
    since: "2026-07-26 398388244 #263",
    ddl: "CREATE TABLE vertical_channel_history (id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, channel TEXT NOT NULL, version_id TEXT NOT NULL, from_version_id TEXT, actor TEXT NOT NULL, at TEXT NOT NULL)",
    columns: ["id", "vertical_slug", "channel", "version_id", "from_version_id", "actor", "at"],
  },
  {
    table: "scopes",
    since: "2026-07-27 bc6d0fa65 #287",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', vertical_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, forked_from TEXT, forked_at TEXT, expires_at TEXT, serving_ref TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "vertical_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "forked_from", "forked_at", "expires_at", "serving_ref", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-07-27 bc6d0fa65 #287",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, install_spec TEXT, listed INTEGER NOT NULL DEFAULT 0, publish_requested_at TEXT, installs_blocked INTEGER NOT NULL DEFAULT 0, serving_ref TEXT, serving_version_id TEXT, serving_do_classes TEXT, serving_migration_tag TEXT, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "env_spec", "install_spec", "listed", "publish_requested_at", "installs_blocked", "serving_ref", "serving_version_id", "serving_do_classes", "serving_migration_tag", "created_at"],
  },
  {
    table: "vertical_versions",
    since: "2026-07-27 bc6d0fa65 #287",
    ddl: "CREATE TABLE vertical_versions (id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, version TEXT NOT NULL, manifest_digest TEXT NOT NULL, permission_digest TEXT NOT NULL, migration_digest TEXT NOT NULL, deployment_ref TEXT, admission TEXT NOT NULL, admission_note TEXT, manifest_json TEXT, created_at TEXT NOT NULL, UNIQUE (vertical_slug, version))",
    columns: ["id", "vertical_slug", "version", "manifest_digest", "permission_digest", "migration_digest", "deployment_ref", "admission", "admission_note", "manifest_json", "created_at"],
  },
  {
    table: "scopes",
    since: "2026-07-28 e612b9844 #317",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', vertical_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, forked_from TEXT, forked_at TEXT, expires_at TEXT, archived_at TEXT, serving_ref TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "vertical_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "forked_from", "forked_at", "expires_at", "archived_at", "serving_ref", "created_at"],
  },
  {
    table: "tenants",
    since: "2026-07-28 f0df69a42 #320",
    ddl: "CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, deleting_at TEXT)",
    columns: ["tenant_id", "slug", "name", "status", "created_at", "deleting_at"],
  },
  {
    table: "hostnames",
    since: "2026-07-29 2bdd22b24 #323",
    ddl: "CREATE TABLE hostnames (hostname TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope_id TEXT NOT NULL, vertical_slug TEXT, surface TEXT NOT NULL, region TEXT, status TEXT NOT NULL, status_note TEXT, canonical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, custom_hostname_id TEXT, validation_records TEXT)",
    columns: ["hostname", "tenant_id", "scope_id", "vertical_slug", "surface", "region", "status", "status_note", "canonical", "created_at", "custom_hostname_id", "validation_records"],
  },
  {
    table: "tenant_stores",
    since: "2026-08-02 ab637f022 #409",
    ddl: "CREATE TABLE tenant_stores (tenant_id TEXT NOT NULL, vertical TEXT NOT NULL, binding TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, vertical, binding))",
    columns: ["tenant_id", "vertical", "binding", "kind", "ref", "created_at"],
  },
  {
    table: "verticals",
    since: "2026-08-03 5afb162e0 #452",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, install_spec TEXT, listed INTEGER NOT NULL DEFAULT 0, publish_requested_at TEXT, installs_blocked INTEGER NOT NULL DEFAULT 0, tenant_provisioner INTEGER NOT NULL DEFAULT 0, serving_ref TEXT, serving_version_id TEXT, serving_do_classes TEXT, serving_migration_tag TEXT, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "env_spec", "install_spec", "listed", "publish_requested_at", "installs_blocked", "tenant_provisioner", "serving_ref", "serving_version_id", "serving_do_classes", "serving_migration_tag", "created_at"],
  },
  {
    table: "blob_stores",
    since: "2026-08-03 d222905e8 #478",
    ddl: "CREATE TABLE blob_stores (tenant_id TEXT NOT NULL, vertical TEXT NOT NULL, binding TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, vertical, binding))",
    columns: ["tenant_id", "vertical", "binding", "kind", "ref", "created_at"],
  },
  {
    table: "tenants",
    since: "2026-08-04 846af2401 #503",
    ddl: "CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, deleting_at TEXT, provisioned_by_tenant TEXT REFERENCES tenants(tenant_id))",
    columns: ["tenant_id", "slug", "name", "status", "created_at", "deleting_at", "provisioned_by_tenant"],
  },
  {
    table: "verticals",
    since: "2026-08-05 3fcf34b9d #511",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, install_spec TEXT, listed INTEGER NOT NULL DEFAULT 0, publish_requested_at TEXT, installs_blocked INTEGER NOT NULL DEFAULT 0, tenant_provisioner INTEGER NOT NULL DEFAULT 0, email_sender INTEGER NOT NULL DEFAULT 0, serving_ref TEXT, serving_version_id TEXT, serving_do_classes TEXT, serving_migration_tag TEXT, created_at TEXT NOT NULL)",
    columns: ["slug", "name", "source", "owner_tenant", "env_spec", "install_spec", "listed", "publish_requested_at", "installs_blocked", "tenant_provisioner", "email_sender", "serving_ref", "serving_version_id", "serving_do_classes", "serving_migration_tag", "created_at"],
  },
  {
    // The pure adapter's `CREATE TABLE` only: the Durable Object's never gained this column in
    // its DDL, and adds it by ALTER instead (the ALTERed-up scopes shape below).
    table: "scopes",
    since: "2026-09-01 db5a3da57 #1173",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', vertical_version_id TEXT, provisioned_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, forked_from TEXT, forked_at TEXT, expires_at TEXT, serving_ref TEXT, archived_at TEXT, created_at TEXT NOT NULL)",
    columns: ["scope_id", "tenant_id", "parent_scope_id", "slug", "kind", "name", "vertical", "storage_shape", "jurisdiction", "status", "schema_version", "vertical_version_id", "provisioned_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "forked_from", "forked_at", "expires_at", "serving_ref", "archived_at", "created_at"],
  },
  {
    table: "vertical_versions",
    since: "2026-09-25 3a3338dbb #1790",
    ddl: "CREATE TABLE vertical_versions (id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, version TEXT NOT NULL, manifest_digest TEXT NOT NULL, permission_digest TEXT NOT NULL, migration_digest TEXT NOT NULL, deployment_ref TEXT, admission TEXT NOT NULL, admission_note TEXT, manifest_json TEXT, migration_count INTEGER, migrations_split INTEGER, created_at TEXT NOT NULL, UNIQUE (vertical_slug, version))",
    columns: ["id", "vertical_slug", "version", "manifest_digest", "permission_digest", "migration_digest", "deployment_ref", "admission", "admission_note", "manifest_json", "migration_count", "migrations_split", "created_at"],
  },
];

/**
 * Each table a directory created on its first day holds after `ensureDirectoryColumns` has
 * ALTERed it forward: the first shape, with every later column appended in the order the Durable
 * Object's pass adds them. SQLite appends each `ADD COLUMN` to the stored DDL, so the column order
 * differs from a table created today, which a load by position would get wrong.
 */
export const ALTERED_SHAPES: readonly DirectoryShape[] = [
  {
    table: "scopes",
    since: "created 2026-07-15, ALTERed forward by ensureDirectoryColumns",
    ddl: "CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, storage_shape TEXT NOT NULL DEFAULT 'A', jurisdiction TEXT, status TEXT NOT NULL DEFAULT 'active', schema_version TEXT NOT NULL DEFAULT '0', created_at TEXT NOT NULL, parent_scope_id TEXT, slug TEXT, kind TEXT, name TEXT, vertical TEXT, vertical_version_id TEXT, provisioned_version_id TEXT, migration_failed_version TEXT, migration_error TEXT, migration_attempts INTEGER NOT NULL DEFAULT 0, migration_last_attempt_at TEXT, forked_from TEXT, forked_at TEXT, expires_at TEXT, serving_ref TEXT, archived_at TEXT)",
    columns: ["scope_id", "tenant_id", "storage_shape", "jurisdiction", "status", "schema_version", "created_at", "parent_scope_id", "slug", "kind", "name", "vertical", "vertical_version_id", "provisioned_version_id", "migration_failed_version", "migration_error", "migration_attempts", "migration_last_attempt_at", "forked_from", "forked_at", "expires_at", "serving_ref", "archived_at"],
  },
  {
    table: "tenants",
    since: "created 2026-07-15, ALTERed forward by ensureDirectoryColumns",
    ddl: "CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, deleting_at TEXT, provisioned_by_tenant TEXT REFERENCES tenants(tenant_id))",
    columns: ["tenant_id", "slug", "name", "status", "created_at", "deleting_at", "provisioned_by_tenant"],
  },
  {
    table: "hostnames",
    since: "created 2026-07-19, ALTERed forward by ensureDirectoryColumns",
    ddl: "CREATE TABLE hostnames (hostname TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope_id TEXT NOT NULL, vertical_slug TEXT, surface TEXT NOT NULL, region TEXT, status TEXT NOT NULL, status_note TEXT, canonical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, custom_hostname_id TEXT, validation_records TEXT)",
    columns: ["hostname", "tenant_id", "scope_id", "vertical_slug", "surface", "region", "status", "status_note", "canonical", "created_at", "custom_hostname_id", "validation_records"],
  },
  {
    table: "verticals",
    since: "created 2026-07-19, ALTERed forward by ensureDirectoryColumns",
    ddl: "CREATE TABLE verticals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, owner_tenant TEXT, env_spec TEXT, install_spec TEXT, listed INTEGER NOT NULL DEFAULT 0, publish_requested_at TEXT, installs_blocked INTEGER NOT NULL DEFAULT 0, tenant_provisioner INTEGER NOT NULL DEFAULT 0, email_sender INTEGER NOT NULL DEFAULT 0, serving_ref TEXT, serving_version_id TEXT, serving_do_classes TEXT, serving_migration_tag TEXT)",
    columns: ["slug", "name", "source", "created_at", "owner_tenant", "env_spec", "install_spec", "listed", "publish_requested_at", "installs_blocked", "tenant_provisioner", "email_sender", "serving_ref", "serving_version_id", "serving_do_classes", "serving_migration_tag"],
  },
  {
    table: "vertical_versions",
    since: "created 2026-07-19, ALTERed forward by ensureDirectoryColumns",
    ddl: "CREATE TABLE vertical_versions (id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, version TEXT NOT NULL, manifest_digest TEXT NOT NULL, permission_digest TEXT NOT NULL, migration_digest TEXT NOT NULL, deployment_ref TEXT, admission TEXT NOT NULL, admission_note TEXT, created_at TEXT NOT NULL, manifest_json TEXT, origin_json TEXT, migration_count INTEGER, migrations_split INTEGER, UNIQUE (vertical_slug, version))",
    columns: ["id", "vertical_slug", "version", "manifest_digest", "permission_digest", "migration_digest", "deployment_ref", "admission", "admission_note", "created_at", "manifest_json", "origin_json", "migration_count", "migrations_split"],
  },
];
