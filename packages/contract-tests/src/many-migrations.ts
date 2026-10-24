/**
 * #2553: a module whose migrations alone outnumber the read that used to cap the applied-migrations
 * list at 100 rows. The cap stopped the list silently, so the next fixture module anyone added
 * pushed the shared scope past it and broke the case reading `appliedAt` back (#1236) with nothing
 * to say why. Every scope in the kit migrates this module, so that case now runs over more than
 * 100 rows on every adapter, and `manyMigrationsContractSuite` reads them all back by name.
 */
import { moduleManifest } from '@substrat-run/contracts';
import type { ModuleRegistration } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const MANY_MIGRATIONS_MODULE_ID = '@test/many-migrations';

/** Past the old cap on its own, whatever else a scope carries. */
export const MANY_MIGRATIONS_COUNT = 120;

/** The module `manyMigrationsContractSuite`'s dedicated scope carries: more than twice the old cap. */
export const OVER_CAP_MIGRATIONS_MODULE_ID = '@test/over-cap-migrations';
export const OVER_CAP_MIGRATIONS_COUNT = 260;

const pad = (n: number) => String(n).padStart(4, '0');

/** `0001-create`, then `0002-row` … `NNNN-row`: one tiny write each, so every row has a real `rowsChanged`. */
const versionsOf = (count: number): readonly string[] => [
  `${pad(1)}-create`,
  ...Array.from({ length: count - 1 }, (_, i) => `${pad(i + 2)}-row`),
];

export const MANY_MIGRATIONS_VERSIONS: readonly string[] = versionsOf(MANY_MIGRATIONS_COUNT);
export const OVER_CAP_MIGRATIONS_VERSIONS: readonly string[] = versionsOf(OVER_CAP_MIGRATIONS_COUNT);

function migrationsMod(id: string, entitlementKey: string, table: string, versions: readonly string[]): ModuleRegistration {
  return {
    manifest: moduleManifest.parse({
      id,
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey,
    }),
    migrations: versions.map((version, i) => ({
      version,
      sql: i === 0 ? `CREATE TABLE ${table} (n INTEGER PRIMARY KEY);` : `INSERT INTO ${table} (n) VALUES (${i});`,
    })),
    ...testOperations({}),
  };
}

export const manyMigrationsMod: ModuleRegistration = migrationsMod(
  MANY_MIGRATIONS_MODULE_ID,
  'many-migrations',
  'mm_log',
  MANY_MIGRATIONS_VERSIONS,
);

/**
 * Not in `contractTestModules`: only `manyMigrationsContractSuite` registers it, on its own host,
 * so the 260 migrations cost every other scope in the kit nothing.
 */
export const overCapMigrationsMod: ModuleRegistration = migrationsMod(
  OVER_CAP_MIGRATIONS_MODULE_ID,
  'over-cap-migrations',
  'oc_log',
  OVER_CAP_MIGRATIONS_VERSIONS,
);
