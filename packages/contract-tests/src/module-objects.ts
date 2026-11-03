/**
 * #2820: a module whose own migration declares invariants as SQLite objects: a partial unique index
 * (at most one lead per `who`) and an append-only trigger, both of which a restore puts back. A
 * host may migrate it into every scope it holds, so it declares nothing a restore leaves out: the
 * suite plants a trigger that writes into the dump instead. `moduleObjectsContractSuite` drives it.
 */
import { moduleManifest } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const moduleObjectsMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/module-objects',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'module-objects',
  }),
  migrations: [
    {
      version: '0001-create',
      sql: `
        CREATE TABLE mo_ledger (id TEXT PRIMARY KEY, who TEXT NOT NULL, lead INTEGER NOT NULL);
        CREATE TABLE mo_counter (n INTEGER NOT NULL);
        INSERT INTO mo_counter (n) VALUES (0);
        CREATE UNIQUE INDEX mo_one_lead ON mo_ledger (who) WHERE lead = 1;
        CREATE TRIGGER mo_no_update BEFORE UPDATE ON mo_ledger BEGIN SELECT RAISE(ABORT, 'mo_ledger is append-only'); END;`,
    },
  ],
  ...testOperations({
    'mo/insert': ((ctx, input: { id: string; who: string; lead: number }) => {
      ctx.sql.exec('INSERT INTO mo_ledger (id, who, lead) VALUES (?, ?, ?)', [input.id, input.who, input.lead]);
    }) as OperationHandler<never, unknown>,
    'mo/demote': ((ctx, input: { id: string }) => {
      ctx.sql.exec('UPDATE mo_ledger SET lead = 0 WHERE id = ?', [input.id]);
    }) as OperationHandler<never, unknown>,
    'mo/count': ((ctx) => ctx.sql.query<{ n: number }>('SELECT n FROM mo_counter')[0]?.n) as OperationHandler<never, unknown>,
  }),
};
