import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-invoicing's entity (#697/#707).
 *
 * ## Why this engine needs it MORE than the others
 *
 * Every demo vertical composes invoicing — callout, handlebar, meridian's
 * siblings, rally, shop — and none could declare an operation returning an
 * invoice basis without transcribing this engine's shape into the vertical. That
 * is the cost the model's notation decision (#680) exists to avoid, and it was
 * the first wall a forward-built vertical hit.
 *
 * ## Composed by EVENT, not by call
 *
 * This engine exports no in-scope functions: its whole surface is
 * `consumers` — `workorder.completed`, `commerce.order-placed`,
 * `timesheet.period-closed`. A vertical composes it by *emitting*, and reads the
 * result. So what a vertical needs from here is not a callable API but exactly
 * this: the entity name, and the row shape it can declare a return against.
 *
 * ## One entity, two tables
 *
 * `underlag` is what the platform points at — attachments hang off it
 * (`attachmentTargets`), and it is what a vertical's operation returns. Lines
 * are rows this engine owns and totals; they are never the subject of an
 * `EntityRef`, and their shape is exported as `underlagLine` for a vertical that
 * renders them.
 *
 * It declares no `parents`: an underlag's customer is an opaque `EntityRef` into
 * whatever the vertical calls its customer, so only the vertical knows the edge.
 */
export const invoicingEntities = defineEntities({
  underlag: {
    table: 'invoicing_underlag',
    fields: z.object({
      id: z.string(),
      number: z.number(),
      /** The customer ref, entity-agnostic: whatever the vertical calls one. */
      customer_type: z.string(),
      customer_id: z.string(),
      status: z.enum(['open', 'exported']),
      created_at: z.string(),
      exported_at: z.string().nullable(),
    }),
  },
});

/** The invoice basis, for a vertical declaring an operation that returns one. */
export const underlagRow = invoicingEntities.underlag.fields;

/**
 * A line on an invoice basis. A row this engine owns, not an entity — exported
 * because a vertical that renders or returns lines needs the shape, and
 * retyping it in the vertical is what this exists to prevent.
 *
 * Lives in `invoicing_lines`, which migration 0002 rebuilt: the journal creates
 * `invoicing_lines_new`, copies, drops the original and renames. Append-only
 * journals do that, and it is why `journalColumns` has to follow `RENAME TO`.
 */
export const underlagLine = z.object({
  id: z.string(),
  underlag_id: z.string(),
  /** The delivery that produced this line — `workorder`/`order`/`timesheet` + its id. */
  document_type: z.string(),
  document_id: z.string(),
  /** What the line itself is — `time`/`material`. NULL where the producer supplies none. */
  source_type: z.string().nullable(),
  source_id: z.string().nullable(),
  article: z.string(),
  description: z.string(),
  qty: z.string(),
  unit: z.string(),
  unit_price_amount: z.string(),
  currency: z.string(),
  line_total_amount: z.string(),
  created_at: z.string(),
});
