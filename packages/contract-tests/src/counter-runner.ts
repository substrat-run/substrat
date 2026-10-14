import { z } from 'zod';
import { scopeStoreObjectName, storeEraseInput, storeImportInput, type StoreResponse } from '@substrat-run/contracts';
import type { ScopeStoreAddress, ScopeStoreRunner } from '@substrat-run/kernel';

const incrementInput = z.object({ by: z.number().int().optional() }).optional();
const counterCell = z.number().int();

export const invalidStoreInput = (message: string): StoreResponse => ({
  error: { code: 'validation_failed', status: 400, body: { message } },
});

/** The object an address names: the same string the hosted path signs. */
export const objectNameOf = (address: ScopeStoreAddress): string =>
  scopeStoreObjectName(address.tenantId, address.vertical, address.scopeId, address.binding);

/**
 * The trivial kind (#2213, RFC §7): one integer per address, in the process. The
 * reference runner both contract suites use, and the one the runner suite holds to
 * the contract on itself. Its catalog is `read` and `increment` (`{ by? }`).
 *
 * The objects live on the runner, not in `start`, so a stop and a start serve the same
 * ones, as a kind's repositories outlive its process.
 */
export function counterScopeStoreRunner(): ScopeStoreRunner {
  const objects = new Map<string, number>();
  const erased = new Map<string, Set<string>>();
  return {
    kind: 'counter',
    async start() {},
    async stop() {},
    async invoke(address, request) {
      const id = objectNameOf(address);
      const current = objects.get(id) ?? 0;
      switch (request.operation) {
        case 'read':
          return { result: current };
        case 'increment': {
          const input = incrementInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('increment takes { by? }, an integer');
          const next = current + (input.data?.by ?? 1);
          objects.set(id, next);
          return { result: next };
        }
        case 'substrat.size':
          return { result: { bytes: current } };
        case 'substrat.wipe':
          objects.delete(id);
          return { result: {} };
        case 'substrat.erase': {
          const input = storeEraseInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.erase takes { subjectId }');
          const subjects = erased.get(id) ?? new Set<string>();
          const already = subjects.has(input.data.subjectId);
          subjects.add(input.data.subjectId);
          erased.set(id, subjects);
          return { result: { erased: already ? 0 : 1 } };
        }
        case 'substrat.export':
          return {
            result: {
              tables: [{ name: 'counter', ddl: 'CREATE TABLE counter (n INTEGER NOT NULL)', columns: ['n'], rows: [[current]] }],
            },
          };
        case 'substrat.import': {
          const input = storeImportInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.import takes { tables }');
          // The whole object is replaced: no counter table is an empty object.
          const table = input.data.tables.find((one) => one.name === 'counter');
          const cell = counterCell.safeParse(table?.rows[0]?.[0] ?? 0);
          if (!cell.success) return invalidStoreInput('the counter table holds one integer');
          objects.set(id, cell.data);
          return { result: { tables: input.data.tables.length } };
        }
        default:
          return { error: { code: 'unknown_operation', status: 400 } };
      }
    },
  };
}
