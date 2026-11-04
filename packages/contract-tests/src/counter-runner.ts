import { z } from 'zod';
import {
  scopeStoreObjectName,
  mergeDumpPages,
  storeCommitStageInput,
  storeDiscardStageInput,
  storeEraseInput,
  storeExportPageInput,
  storeStagePageInput,
  STORE_STAGE_MAX_AGE_MS,
  type ScopeDumpTable,
  type StoreResponse,
} from '@substrat-run/contracts';
import { storeDumpPages, type ScopeStoreAddress, type ScopeStoreRunner } from '@substrat-run/kernel';

const incrementInput = z
  .object({ by: z.number().int().nonnegative().optional(), subjectId: z.string().min(1).optional() })
  .optional();
/** One row of the export: who contributed (`null` for nobody in particular), and how much. */
const counterRow = z.tuple([z.string().min(1).nullable(), z.number().int().nonnegative()]);

export const invalidStoreInput = (message: string): StoreResponse => ({
  error: { code: 'validation_failed', status: 400, body: { message } },
});

/** A stage the object does not hold, or one it will not take again: 409 `stage_refused` (D-69). */
export const stageRefused = (message: string): StoreResponse => ({
  error: { code: 'stage_refused', status: 409, body: { message } },
});

/** The object an address names: the same string the hosted path signs. */
export const objectNameOf = (address: ScopeStoreAddress): string =>
  scopeStoreObjectName(address.tenantId, address.vertical, address.scopeId, address.binding);

const COUNTER_DDL = 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)';
const COUNTER_COLUMNS = ['subject', 'n'];

const totalOf = (object: ReadonlyMap<string | null, number> | undefined): number =>
  [...(object?.values() ?? [])].reduce((sum, n) => sum + n, 0);

/** What a stage holds, as the counter measures it: the sum of its rows' counts. */
const stagedTotalOf = (pages: readonly ScopeDumpTable[][]): number =>
  pages
    .flat()
    .filter((table) => table.name === 'counter')
    .flatMap((table) => table.rows)
    .reduce<number>((sum, row) => sum + (typeof row[1] === 'number' ? row[1] : 0), 0);

export interface CounterRunnerOptions {
  /** The clock a stage's age is read from, in ms. A test moves it; it defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The trivial driver (#2213, RFC §7): a counter per address, in the process. The
 * reference runner both contract suites use, and the one the runner suite holds to
 * the contract on itself.
 *
 * Its catalog is `read` (the total) and `increment` (`{ by?, subjectId? }`, `by` never
 * negative). Each increment is kept against the subject it names, so the object holds
 * personal data the way a real driver does: `substrat.erase` removes that subject's part
 * and answers `{ erased: 1 }` only if there was one, so a repeat, or a subject that
 * never wrote, answers 0. A wipe or a commit replaces everything, subjects included.
 * `substrat.size` reports the total, and what its stage holds, as `bytes`: a stand-in for
 * storage, never negative.
 *
 * Its dump moves in pages (D-69), one table of rows cut by `maxBytes` with the kernel's own page
 * accounting (UTF-8 bytes, the table heading, always one row), so the contract is shown on a driver
 * written in TypeScript as well as on one in Python. The revision counts every change to what the
 * dump holds: an increment, a commit, a wipe, and an erase that erased something. A stage unused for
 * longer than `STORE_STAGE_MAX_AGE_MS` is dropped no later than the next call to its object, by the
 * injectable clock, so the driver needs no timer. A wipe and an erase drop every stage. A commit
 * answers the count of distinct tables, and asked again for the stage last committed it answers the
 * same count and changes nothing; only a wipe ends that memory, and a stage id that was committed is
 * not taken again. A stage the object does not hold is refused with 409 `stage_refused`. It takes
 * only rows of its `counter` table and refuses any other table or a negative count when they are
 * staged. Its pages have no row limit of their own, so it never refuses a row it gave.
 *
 * The objects live on the runner, not in `start`, so a stop and a start serve the same
 * ones, as a driver's repositories outlive its process.
 */
export function counterScopeStoreRunner(options: CounterRunnerOptions = {}): ScopeStoreRunner {
  const now = options.now ?? Date.now;
  const objects = new Map<string, Map<string | null, number>>();
  const revisions = new Map<string, number>();
  const stages = new Map<string, { stageId: string; pages: ScopeDumpTable[][]; touchedAt: number }>();
  const committed = new Map<string, { stageId: string; tables: number }>();
  const wrote = (id: string) => revisions.set(id, (revisions.get(id) ?? 0) + 1);
  return {
    driver: 'counter',
    async start() {},
    async stop() {},
    async invoke(address, request) {
      const id = objectNameOf(address);
      // An abandoned stage is dropped by the next call to its object: no timer.
      const held = stages.get(id);
      if (held && now() - held.touchedAt > STORE_STAGE_MAX_AGE_MS) stages.delete(id);
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
          wrote(id);
          return { result: totalOf(next) };
        }
        case 'substrat.size':
          return { result: { bytes: totalOf(object) + stagedTotalOf(stages.get(id)?.pages ?? []) } };
        case 'substrat.wipe':
          objects.delete(id);
          stages.delete(id);
          committed.delete(id);
          wrote(id);
          return { result: {} };
        case 'substrat.erase': {
          const input = storeEraseInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.erase takes { subjectId }');
          const erased = object?.delete(input.data.subjectId) ? 1 : 0;
          // A stage may hold the subject: a restore racing this erase fails at its commit. What was last
          // committed is still committed, so a lost commit answer can be retried across the erase.
          stages.delete(id);
          if (erased) wrote(id);
          return { result: { erased } };
        }
        case 'substrat.export-page': {
          const input = storeExportPageInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.export-page takes { cursor, maxBytes }');
          const rows = [...(object ?? [])].map(([subject, n]) => [subject, n]);
          const start = input.data.cursor === null ? 0 : Number(input.data.cursor);
          if (!Number.isInteger(start) || start < 0) return invalidStoreInput('substrat.export-page: the cursor is not one this store gave');
          const [first] = storeDumpPages(
            [{ name: 'counter', ddl: COUNTER_DDL, columns: COUNTER_COLUMNS, rows: rows.slice(start) }],
            input.data.maxBytes,
          );
          const page = first![0]!;
          const end = start + page.rows.length;
          return {
            result: {
              tables: [page],
              next: end < rows.length ? String(end) : null,
              revision: String(revisions.get(id) ?? 0),
            },
          };
        }
        case 'substrat.stage-page': {
          const input = storeStagePageInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.stage-page takes { stageId, seq, tables }');
          const { stageId, seq, tables } = input.data;
          if (committed.get(id)?.stageId === stageId) return stageRefused(`stage ${stageId} was committed, and an id is not used again`);
          // Only counter rows come in, so a staged count is never negative and size is never wrong.
          const foreign = tables.find((one) => one.name !== 'counter');
          if (foreign) return invalidStoreInput(`a counter store has one table, counter, not ${foreign.name}`);
          if (!z.array(counterRow).safeParse(tables.flatMap((one) => one.rows)).success) {
            return invalidStoreInput('a counter row is [subject or null, a non-negative integer]');
          }
          // Page 0 of a new stage drops any other.
          if (seq === 0 && stages.get(id)?.stageId !== stageId) stages.set(id, { stageId, pages: [], touchedAt: now() });
          const stage = stages.get(id);
          if (stage?.stageId !== stageId) return stageRefused(`no stage ${stageId} to add page ${seq} to`);
          stage.touchedAt = now();
          if (seq < stage.pages.length) return { result: { staged: false } };
          if (seq > stage.pages.length) return invalidStoreInput(`stage ${stageId} holds ${stage.pages.length} pages, not ${seq}`);
          stage.pages.push(tables);
          return { result: { staged: true } };
        }
        case 'substrat.commit-stage': {
          const input = storeCommitStageInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.commit-stage takes { stageId }');
          const stage = stages.get(id);
          if (stage?.stageId !== input.data.stageId) {
            // The stage last committed answers again with the same count, and changes nothing.
            const last = committed.get(id);
            if (last?.stageId === input.data.stageId) return { result: { tables: last.tables } };
            return stageRefused(`no stage ${input.data.stageId} to commit`);
          }
          const tables = mergeDumpPages(stage.pages);
          // The whole object is replaced: no counter table is an empty object.
          const rows = z.array(counterRow).safeParse(tables.find((one) => one.name === 'counter')?.rows ?? []);
          if (!rows.success) return invalidStoreInput('a counter row is [subject or null, a non-negative integer]');
          // A dump names each row key once: a repeated subject is refused, never folded or dropped.
          const next = new Map(rows.data);
          if (next.size !== rows.data.length) return invalidStoreInput('a counter table names each subject once');
          objects.set(id, next);
          stages.delete(id);
          committed.set(id, { stageId: input.data.stageId, tables: tables.length });
          wrote(id);
          return { result: { tables: tables.length } };
        }
        case 'substrat.discard-stage': {
          const input = storeDiscardStageInput.safeParse(request.input);
          if (!input.success) return invalidStoreInput('substrat.discard-stage takes { stageId }');
          const dropped = stages.get(id)?.stageId === input.data.stageId;
          if (dropped) stages.delete(id);
          return { result: { discarded: dropped } };
        }
        default:
          return { error: { code: 'unknown_operation', status: 400 } };
      }
    },
  };
}
