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

const pad = (n: number) => String(n).padStart(4, '0');

/** `0001-create`, then `0002-row` … `0120-row`: one tiny write each, so every row has a real `rowsChanged`. */
export const MANY_MIGRATIONS_VERSIONS: readonly string[] = [
  `${pad(1)}-create`,
  ...Array.from({ length: MANY_MIGRATIONS_COUNT - 1 }, (_, i) => `${pad(i + 2)}-row`),
];

export const manyMigrationsMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: MANY_MIGRATIONS_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'many-migrations',
  }),
  migrations: MANY_MIGRATIONS_VERSIONS.map((version, i) => ({
    version,
    sql: i === 0 ? 'CREATE TABLE mm_log (n INTEGER PRIMARY KEY);' : `INSERT INTO mm_log (n) VALUES (${i});`,
  })),
  ...testOperations({}),
};
