/**
 * #115: two modules whose second migration drops their table — one undeclared, one declaring the
 * loss with `discards`. On a scope where the table is empty both apply, which is every scope in
 * the kit; `migrationFenceContractSuite` gives the table rows by restoring a dump from before the
 * drop, and that is where the two part company.
 */
import { moduleManifest } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationHandler, SqlMigration } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

const fenceModule = (id: string, key: string, table: string, migrations: SqlMigration[]): ModuleRegistration => ({
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
  migrations,
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

const createAndDrop = (table: string, drop: Omit<SqlMigration, 'version' | 'sql'>): SqlMigration[] => [
  { version: '0001-create', sql: `CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL);` },
  { version: '0002-drop', sql: `DROP TABLE ${table};`, ...drop },
];

export const fenceUndeclaredMod = fenceModule(FENCE_UNDECLARED.id, FENCE_UNDECLARED.key, FENCE_UNDECLARED.table, createAndDrop(FENCE_UNDECLARED.table, {}));
export const fenceDeclaredMod = fenceModule(
  FENCE_DECLARED.id,
  FENCE_DECLARED.key,
  FENCE_DECLARED.table,
  createAndDrop(FENCE_DECLARED.table, { discards: { [FENCE_DECLARED.table]: 'contract fixture: the notes this table held are retired' } }),
);

/**
 * #115 r1: a table as wide as a Durable Object allows (100 columns), so the fence's measuring query
 * meets the DO's 100-column result limit on the host that enforces it. `0002` loses nothing and
 * must apply; `0003` drops the last column, past the first measuring scan.
 */
export const FENCE_WIDE = { id: '@test/fence-wide', key: 'fence-wide', table: 'fw_wide', columns: 100 } as const;
export const FENCE_WIDE_COLUMNS = ['id', ...Array.from({ length: FENCE_WIDE.columns - 1 }, (_, i) => `c${i + 1}`)];
export const fenceWideDdl = `CREATE TABLE ${FENCE_WIDE.table} (id TEXT PRIMARY KEY, ${FENCE_WIDE_COLUMNS.slice(1)
  .map((c) => `${c} TEXT`)
  .join(', ')})`;
export const fenceWideMod = fenceModule(FENCE_WIDE.id, FENCE_WIDE.key, FENCE_WIDE.table, [
  { version: '0001-create', sql: `${fenceWideDdl};` },
  { version: '0002-touch', sql: `UPDATE ${FENCE_WIDE.table} SET c1 = c1;` },
  { version: '0003-drop-last', sql: `ALTER TABLE ${FENCE_WIDE.table} DROP COLUMN c${FENCE_WIDE.columns - 1};` },
]);

/**
 * #115 r2: a dropped name reused by a rename, then renamed again. `0002` drops `<p>_b`, renames
 * `<p>_a` onto that name and on to `<p>_c`. Declared as `<p>_b`'s loss it applies; declared as
 * `<p>_a`'s — the remedy a rename credited to the dropped table would name — it is refused, since
 * `<p>_a`'s rows are all in `<p>_c` and `<p>_b`'s are the ones gone.
 */
const reusedName = (p: string, discard: string): SqlMigration[] => [
  { version: '0001-create', sql: `CREATE TABLE ${p}_b (id TEXT, x TEXT); CREATE TABLE ${p}_a (id TEXT, x TEXT);` },
  {
    version: '0002-replace',
    sql: `DROP TABLE ${p}_b; ALTER TABLE ${p}_a RENAME TO ${p}_b; ALTER TABLE ${p}_b RENAME TO ${p}_c;`,
    discards: { [`${p}_${discard}`]: 'contract fixture: the staging copy is replaced' },
  },
];
export const FENCE_REUSED_RIGHT = { id: '@test/fence-reused-right', key: 'fence-reused-right', table: 'frr_c', prefix: 'frr' } as const;
export const FENCE_REUSED_WRONG = { id: '@test/fence-reused-wrong', key: 'fence-reused-wrong', table: 'frw_c', prefix: 'frw' } as const;
export const fenceReusedRightMod = fenceModule(FENCE_REUSED_RIGHT.id, FENCE_REUSED_RIGHT.key, FENCE_REUSED_RIGHT.table, reusedName('frr', 'b'));
export const fenceReusedWrongMod = fenceModule(FENCE_REUSED_WRONG.id, FENCE_REUSED_WRONG.key, FENCE_REUSED_WRONG.table, reusedName('frw', 'a'));
