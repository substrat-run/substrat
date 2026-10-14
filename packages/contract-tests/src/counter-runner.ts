import { z } from 'zod';
import { storeEraseInput, storeImportInput, type StoreResponse } from '@substrat-run/contracts';
import type { ScopeStoreAddress, ScopeStoreRunner } from '@substrat-run/kernel';

const incrementInput = z.object({ by: z.number().int().optional() }).optional();
const failWipeInput = z.boolean().optional();
const counterCell = z.number().int();

const invalid = (message: string): StoreResponse => ({
  error: { code: 'validation_failed', status: 400, body: { message } },
});

/**
 * The trivial kind (#2213, RFC §7): one integer per address, in the process. The
 * reference runner both contract suites use, and the one the runner suite holds to
 * the contract on itself.
 *
 * Kind operations: `read`, `increment` (`{ by? }`). The rest are instrumentation a host
 * suite reads back: `address` (what the host handed in), `erased` (the subjects erased
 * here), `wiped` (every address wiped), `fail-wipe` (`true` makes each later
 * `substrat.wipe` answer 503, until `false`).
 *
 * The objects live on the runner, not in `start`, so a stop and a start serve the same
 * ones, as a kind's repositories outlive its process.
 */
export function counterScopeStoreRunner(): ScopeStoreRunner {
  const objects = new Map<string, number>();
  const erased = new Map<string, Set<string>>();
  const wiped = new Set<string>();
  let failWipe = false;
  const key = (address: ScopeStoreAddress) =>
    `${address.tenantId}/${address.vertical}/${address.scopeId}/${address.binding}`;
  return {
    kind: 'counter',
    async start() {},
    async stop() {},
    async invoke(address, request) {
      const id = key(address);
      const current = objects.get(id) ?? 0;
      switch (request.operation) {
        case 'read':
          return { result: current };
        case 'address': {
          const { tenantId, vertical, scopeId, binding } = address;
          return { result: { tenantId, vertical, scopeId, binding } };
        }
        case 'increment': {
          const input = incrementInput.safeParse(request.input);
          if (!input.success) return invalid('increment takes { by? }, an integer');
          const next = current + (input.data?.by ?? 1);
          objects.set(id, next);
          return { result: next };
        }
        case 'fail-wipe': {
          const input = failWipeInput.safeParse(request.input);
          if (!input.success) return invalid('fail-wipe takes a boolean');
          failWipe = input.data === true;
          return { result: failWipe };
        }
        case 'wiped':
          return { result: [...wiped] };
        case 'erased':
          return { result: [...(erased.get(id) ?? [])] };
        case 'substrat.size':
          return { result: { bytes: current } };
        case 'substrat.wipe':
          if (failWipe) return { error: { code: 'unavailable', status: 503 } };
          objects.delete(id);
          wiped.add(id);
          return { result: {} };
        case 'substrat.erase': {
          const input = storeEraseInput.safeParse(request.input);
          if (!input.success) return invalid('substrat.erase takes { subjectId }');
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
          if (!input.success) return invalid('substrat.import takes { tables }');
          // The whole object is replaced: no counter table is an empty object.
          const table = input.data.tables.find((one) => one.name === 'counter');
          const cell = counterCell.safeParse(table?.rows[0]?.[0] ?? 0);
          if (!cell.success) return invalid('the counter table holds one integer');
          objects.set(id, cell.data);
          return { result: { tables: input.data.tables.length } };
        }
        default:
          return { error: { code: 'unknown_operation', status: 400 } };
      }
    },
  };
}
