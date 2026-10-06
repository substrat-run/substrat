/**
 * Every index on the directory's `_substrat_admin_log`, as ONE script both adapters build from
 * (#2064). The table is created by each adapter's directory schema, and it is REBUILT on a
 * legacy directory (K-23's `tenant_id` made nullable, `ensureAdminLogTenantNullable`). A
 * rebuild drops every index on the table it replaces, so this script runs twice: in the schema,
 * and again inside the rebuild's own transaction, after the rename. An index added to the log
 * goes here, never into one adapter's DDL, or the next legacy rebuild drops it silently.
 *
 * - The first five are the console's read-path indexes (control-plane.md §4.5). The log is
 *   append-only and only grows, so every filter it offers needs one, and the trailing id
 *   makes each a covering index for the ORDER BY.
 * - `_substrat_admin_log_operation` (#2064) finds an audited change's rows by operation id
 *   rather than by scanning the log. It is partial, so rows that pair nothing cost nothing.
 *
 * A literal with no comments and no interpolation, because `lint:spine-ddl` inlines it as
 * written and the hosted DDL is split on semicolons.
 */
export const ADMIN_LOG_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_tenant ON _substrat_admin_log (tenant_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_scope ON _substrat_admin_log (scope_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_actor ON _substrat_admin_log (actor, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_action ON _substrat_admin_log (action, id);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_at ON _substrat_admin_log (at);
  CREATE INDEX IF NOT EXISTS _substrat_admin_log_operation
    ON _substrat_admin_log (json_extract(after, '$.operationId'))
    WHERE json_extract(after, '$.operationId') IS NOT NULL;
`;

/** `ADMIN_LOG_INDEXES_SQL` one statement at a time, for a host that executes them singly. */
export const ADMIN_LOG_INDEX_DDL: readonly string[] = ADMIN_LOG_INDEXES_SQL.split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement !== '');
