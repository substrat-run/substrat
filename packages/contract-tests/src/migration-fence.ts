/**
 * #115: two modules whose second migration drops their table — one undeclared, one declaring the
 * loss with `discards`. On a scope where the table is empty both apply, which is every scope in
 * the kit; `migrationFenceContractSuite` gives the table rows by restoring a dump from before the
 * drop, and that is where the two part company.
 */
import { moduleManifest } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationHandler, SqlMigration } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

const fenceModule = (id: string, key: string, table: string, drop: Omit<SqlMigration, 'version' | 'sql'>): ModuleRegistration => ({
  manifest: moduleManifest.parse({
    id,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: key,
  }),
  migrations: [
    { version: '0001-create', sql: `CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL);` },
    { version: '0002-drop', sql: `DROP TABLE ${table};`, ...drop },
  ],
  ...testOperations({
    [`${key}/tables`]: ((ctx) =>
      ctx.sql.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).map((r) => r.name)) as OperationHandler<
      never,
      unknown
    >,
  }),
});

export const FENCE_UNDECLARED = { id: '@test/fence-undeclared', key: 'fence-undeclared', table: 'fu_notes' } as const;
export const FENCE_DECLARED = { id: '@test/fence-declared', key: 'fence-declared', table: 'fd_notes' } as const;

export const fenceUndeclaredMod = fenceModule(FENCE_UNDECLARED.id, FENCE_UNDECLARED.key, FENCE_UNDECLARED.table, {});
export const fenceDeclaredMod = fenceModule(FENCE_DECLARED.id, FENCE_DECLARED.key, FENCE_DECLARED.table, {
  discards: { [FENCE_DECLARED.table]: 'contract fixture: the notes this table held are retired' },
});
