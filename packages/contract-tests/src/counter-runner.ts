import { z } from 'zod';
import { scopeStoreObjectName, storeEraseInput, storeImportInput, type StoreResponse } from '@substrat-run/contracts';
import type { ScopeStoreAddress, ScopeStoreRunner } from '@substrat-run/kernel';

const incrementInput = z
  .object({ by: z.number().int().nonnegative().optional(), subjectId: z.string().min(1).optional() })
  .optional();
/** One row of the export: who contributed (`null` for nobody in particular), and how much. */
const counterRow = z.tuple([z.string().min(1).nullable(), z.number().int().nonnegative()]);

export const invalidStoreInput = (message: string): StoreResponse => ({
  error: { code: 'validation_failed', status: 400, body: { message } },
});

/** The object an address names: the same string the hosted path signs. */
export const objectNameOf = (address: ScopeStoreAddress): string =>
  scopeStoreObjectName(address.tenantId, address.vertical, address.scopeId, address.binding);

const totalOf = (object: ReadonlyMap<string | null, number> | undefined): number =>
  [...(object?.values() ?? [])].reduce((sum, n) => sum + n, 0);

/**
 * The trivial driver (#2213, RFC §7): a counter per address, in the process. The
 * reference runner both contract suites use, and the one the runner suite holds to
 * the contract on itself.
 *
 * Its catalog is `read` (the total) and `increment` (`{ by?, subjectId? }`, `by` never
 * negative). Each increment is kept against the subject it names, so the object holds
 * personal data the way a real driver does: `substrat.erase` removes that subject's part
 * and answers `{ erased: 1 }` only if there was one, so a repeat, or a subject that
 * never wrote, answers 0. A wipe or an import replaces everything, subjects included.
 * `substrat.size` reports the total as `bytes`: a stand-in for storage, never negative.
 *
 * The objects live on the runner, not in `start`, so a stop and a start serve the same
 * ones, as a driver's repositories outlive its process.
 */
export function counterScopeStoreRunner(): ScopeStoreRunner {
  const objects = new Map<string, Map<string | null, number>>();
  return {
    driver: 'counter',
    async start() {},
    async stop() {},
    async invoke(address, request) {
      const id = objectNameOf(address);
      const object = objects.get(id);
      switch (request.operation) {
        case 'read':
          return { result: totalOf(object) };
        case 'increment': {
          const input = incrementInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('increment takes { by?, subjectId? }, by a non-negative integer');
          const subject = input.data?.subjectId ?? null;
          const next = object ?? new Map<string | null, number>();
          next.set(subject, (next.get(subject) ?? 0) + (input.data?.by ?? 1));
          objects.set(id, next);
          return { result: totalOf(next) };
        }
        case 'substrat.size':
          return { result: { bytes: totalOf(object) } };
        case 'substrat.wipe':
          objects.delete(id);
          return { result: {} };
        case 'substrat.erase': {
          const input = storeEraseInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.erase takes { subjectId }');
          return { result: { erased: object?.delete(input.data.subjectId) ? 1 : 0 } };
        }
        case 'substrat.export':
          return {
            result: {
              tables: [
                {
                  name: 'counter',
                  ddl: 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)',
                  columns: ['subject', 'n'],
                  rows: [...(object ?? [])].map(([subject, n]) => [subject, n]),
                },
              ],
            },
          };
        case 'substrat.import': {
          const input = storeImportInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.import takes { tables }');
          // The whole object is replaced: no counter table is an empty object.
          const rows = z.array(counterRow).safeParse(input.data.tables.find((one) => one.name === 'counter')?.rows ?? []);
          if (!rows.success) return invalidStoreInput('a counter row is [subject or null, a non-negative integer]');
          // A dump names each row key once: a repeated subject is refused, never folded or dropped.
          const next = new Map(rows.data);
          if (next.size !== rows.data.length) return invalidStoreInput('a counter table names each subject once');
          objects.set(id, next);
          return { result: { tables: input.data.tables.length } };
        }
        default:
          return { error: { code: 'unknown_operation', status: 400 } };
      }
    },
  };
}
