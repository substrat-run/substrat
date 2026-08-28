/**
 * The engine seam, PARSED rather than asserted (#771) — engine-protocol's copy
 * of `engines/workorder/src/seam.ts`, which is the reference.
 *
 * "Parse, don't trust" was enforced in one direction only. Operation inputs go
 * through Zod at the boundary; return values crossing the engine seam were
 * trusted because TypeScript said so — and TypeScript is not there at runtime.
 * The failure that lets through is precise: a vertical compiled against engine
 * 0.3, running against engine 0.4, whose row shape moved. The vertical reads a
 * field that is now `null`, or misses one that appeared, and the first symptom is
 * wrong data on a screen rather than a throw.
 *
 * This engine is the sharper case: a signature attests to a hash over the stored
 * rows, and a row that quietly changed shape is a row whose hash no longer says
 * what the signatory was shown. So every published shape — the template, the
 * instance, each response, signature and request, and the composites the
 * operations answer with — is parsed on its way OUT by the schema `schemas.ts`
 * publishes, and every read names its columns.
 *
 * - `returns(schema, surface, value)` — every published shape is parsed on the way
 *   out, by the same schema a composing vertical declares its `output` with.
 * - `columnsOf(schema)` — the SELECT list is DERIVED from the published schema, so
 *   a read asks for exactly the columns the seam promises. `SELECT *` pinned the
 *   public return shape to whatever the physical table currently held.
 *
 * ## Decisions (#771 open questions 1 and 2), as taken for workorder
 *
 * **Parse always** — including on bulk reads. Dev-only validation is absent
 * exactly where the version skew lives: in production, against an engine nobody
 * in this repo deployed. Every read here is one row, one instance's history, or
 * one page (#811), so the parsed set is bounded by construction.
 *
 * **A helper, not a convention.** One call site per surface, one spelling, and a
 * shape `boundary-lint` can plausibly be taught to require of an exported in-scope
 * function later.
 */
import { substratError, validationIssuesFrom, z } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
const ENGINE = 'engine-protocol';

/**
 * Parse a value on its way ACROSS the seam, or refuse to publish it.
 *
 * The throw is `internal`, deliberately, and not `validation_failed`: the caller's
 * input was already parsed and is not what went wrong — the engine's own stored
 * row no longer matches the shape the engine publishes. `validation_failed` is a
 * 400 blaming the caller for a fault on this side, and `toProblem` drops
 * `internal`'s detail from the response body, so the drift is logged rather than
 * handed to a client that can do nothing with it.
 */
export function returns<T>(schema: z.ZodType<T>, surface: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = validationIssuesFrom(result.error)
    .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
    .join('; ');
  throw substratError(
    'internal',
    `${ENGINE}: ${surface} does not match the shape this engine publishes — ${issues}`,
  );
}

/**
 * The SELECT list a schema describes: `'id, key, version, …'`.
 *
 * Derived rather than transcribed, for the same reason the manifest's `lists` are
 * derived from the operations' own `paged.over` — two descriptions of one column
 * set is how they come to disagree. A column dropped from the table is then a SQL
 * error naming it, and a column added to the table is simply never read.
 *
 * Structurally typed (`{ shape }`) rather than taking a `z.ZodObject`, so it
 * accepts both the published schemas and the entity registry's row schema without
 * either widening to `any`.
 */
export function columnsOf(schema: { readonly shape: Readonly<Record<string, unknown>> }): string {
  const names = Object.keys(schema.shape);
  for (const name of names) {
    // These are code-defined identifiers, never input — the check is here so that
    // stays true of a schema key somebody adds later.
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`${ENGINE}: ${name} is not a column name`);
    }
  }
  return names.join(', ');
}
