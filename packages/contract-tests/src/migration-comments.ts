/**
 * #2068, Codex #2084 r5: a module's migrations with comments in their DDL, run to completion on
 * every adapter. SQLite stores a `CREATE TABLE` as written and a later `ALTER TABLE … DROP COLUMN`
 * rewrites that stored text; workerd's SQLite fails the rewrite ("incomplete input") when the
 * dropped column is the last one and line comments come before it. The kernel executes migrations
 * comment-blanked (`executableSqlStatements`), so the stored text carries none and the drop runs.
 * The twin: `--` and `/*` inside string literals are data, not comments, and arrive intact.
 */
import { moduleManifest } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationHandler } from '@substrat-run/kernel';

export const commentedDdlMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/commented-ddl',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'commented-ddl',
  }),
  migrations: [
    {
      version: '0001-create',
      sql: `
        -- The module's run log. Every column documented in place, as authored DDL tends to be.
        CREATE TABLE cm_runs (
          id TEXT PRIMARY KEY, -- one row per run
          /* what the run was asked to do; free text */
          note TEXT DEFAULT '-- not a comment; /* nor this */',
          -- when it finished, or NULL (its answer came back
          -- too late). Dropped by 0002.
          finished_at TEXT
        );
        INSERT INTO cm_runs (id, note) VALUES ('r1', 'keep -- this; and /* that */ too');`,
    },
    {
      version: '0002-drop-last',
      sql: '-- the last column goes\nALTER TABLE cm_runs DROP COLUMN finished_at;',
    },
  ],
  operations: {
    'commented-ddl/read': ((ctx) => ({
      columns: ctx.sql.query<{ name: string }>("SELECT name FROM pragma_table_info('cm_runs')").map((r) => r.name),
      noteDefault: ctx.sql.query<{ d: string }>("SELECT dflt_value AS d FROM pragma_table_info('cm_runs') WHERE name = 'note'")[0]?.d,
      rows: ctx.sql.query('SELECT id, note FROM cm_runs ORDER BY id'),
      stored: ctx.sql.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'cm_runs'")[0]?.sql,
    })) as OperationHandler<never, unknown>,
  },
};
