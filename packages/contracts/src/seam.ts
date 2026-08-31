/**
 * The engine seam, PARSED rather than asserted (#771).
 *
 * "Parse, don't trust" was enforced in one direction only. Operation inputs go
 * through Zod at the boundary; return values crossing the engine seam were
 * trusted because TypeScript said so — and TypeScript is not there at runtime.
 * The failure that lets through is precise: a vertical compiled against engine
 * 0.3, running against engine 0.4, whose row shape moved. The vertical reads a
 * field that is now `null`, or misses one that appeared, and the first symptom is
 * wrong data on a screen rather than a throw.
 *
 * This file is the two halves of closing that:
 *
 * - `returns(schema, surface, value)` — every published shape is parsed on the way
 *   OUT, by the same schema a composing vertical declares its `output` with. An
 *   engine's public surfaces (D-28) evolve additively *by review*; this makes a
 *   row that stopped matching the published shape a throw at the seam.
 * - `columnsOf(schema)` — the SELECT list is DERIVED from the published schema, so
 *   a read asks for exactly the columns the seam promises. `SELECT *` pinned the
 *   public return shape to whatever the physical table currently held: a column
 *   added upstream leaked through the seam, and a column renamed became a missing
 *   field nothing noticed.
 *
 * ## Decisions (#771 open questions 1 and 2)
 *
 * **Parse always** — including on bulk reads. The boring answer, taken because no
 * benchmark says otherwise and the alternative (dev-only validation) makes the
 * check absent exactly where the version skew lives: in production, against an
 * engine nobody in this repo deployed. Every read behind this helper is either one
 * row or one page (#811), so the parsed set is bounded by construction.
 *
 * **A helper, not a convention.** One call site per surface, one spelling, and a
 * shape `boundary-lint` can plausibly be taught to require of an exported in-scope
 * function later — a convention repeated in seven engines is a habit, and habits
 * are what the checkpoints in this repo exist to replace. Which is also why the
 * helper lives HERE (#970) rather than as a per-engine copy: four engines had
 * byte-identical copies of it, differing only in the name they put in the message,
 * so "the seam" was itself the convention it was meant to replace.
 */
import { substratError, validationIssuesFrom } from './errors.js';
import type { z } from 'zod';

/**
 * The two seam helpers, bound to the name one engine answers under.
 *
 * The engine name is the ONLY thing that differed between the copies, so it is
 * the only thing an engine supplies:
 *
 * ```ts
 * const { columnsOf, returns } = engineSeam('engine-workorder');
 * ```
 *
 * Bound once at module scope rather than threaded through every call, so a read
 * site stays `returns(workOrder, 'getWorkOrder', row)` — the surface it publishes
 * and nothing else.
 */
export function engineSeam(engine: string): {
  returns: <T>(schema: z.ZodType<T>, surface: string, value: unknown) => T;
  columnsOf: (schema: { readonly shape: Readonly<Record<string, unknown>> }) => string;
} {
  return {
    /**
     * Parse a value on its way ACROSS the seam, or refuse to publish it.
     *
     * The throw is `internal`, deliberately, and not `validation_failed`: the
     * caller's input was already parsed and is not what went wrong — the engine's
     * own stored row no longer matches the shape the engine publishes.
     * `validation_failed` is a 400 blaming the caller for a fault on this side,
     * and `toProblem` drops `internal`'s detail from the response body, so the
     * drift is logged rather than handed to a client that can do nothing with it.
     */
    returns<T>(schema: z.ZodType<T>, surface: string, value: unknown): T {
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      const issues = validationIssuesFrom(result.error)
        .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
        .join('; ');
      throw substratError(
        'internal',
        `${engine}: ${surface} does not match the shape this engine publishes — ${issues}`,
      );
    },

    /**
     * The SELECT list a schema describes: `'id, order_id, technician, …'`.
     *
     * Derived rather than transcribed, for the same reason the manifest's `lists`
     * are derived from the operations' own `paged.over` — two descriptions of one
     * column set is how they come to disagree. A column dropped from the table is
     * then a SQL error naming it, and a column added to the table is simply never
     * read.
     *
     * Structurally typed (`{ shape }`) rather than taking a `z.ZodObject`, so it
     * accepts both the published schemas and the entity registry's row schema
     * without either widening to `any`.
     */
    columnsOf(schema: { readonly shape: Readonly<Record<string, unknown>> }): string {
      const names = Object.keys(schema.shape);
      for (const name of names) {
        // These are code-defined identifiers, never input — the check is here so
        // that stays true of a schema key somebody adds later.
        if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
          throw new Error(`${engine}: ${name} is not a column name`);
        }
      }
      return names.join(', ');
    },
  };
}
