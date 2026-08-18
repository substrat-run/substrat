/**
 * The composite shapes this engine PUBLISHES — what its read operations answer
 * with, as opposed to the rows in `entities.ts`.
 *
 * A file of their own for the mechanical reason `engine-protocol`'s leaves have
 * one: `index.ts` re-exports `operations.ts` so the declared surface is reachable
 * from the package root, so a schema `operations.ts` declares against cannot
 * live in `index.ts` without a require cycle.
 *
 * Each is asserted against the type the handler actually returns, in BOTH
 * directions, exactly as `engine-protocol`'s rows are. Typing the handlers from
 * these schemas instead was tried and rejected: it is not a check, because a
 * schema that drops a field the handler still returns goes on compiling — an
 * object with extra properties is assignable to a narrower type. It caught a
 * retyped field and missed a missing one. A schema narrower than the projection
 * publishes a contract that omits real data, which is what a UI lane would then
 * fork on.
 */
import { z } from '@substrat-run/contracts';
import { underlagLine, underlagRow } from './entities.js';
import type { UnderlagDetail, UnderlagListRow } from './index.js';

/**
 * A basis in a list, with its total computed across the lines.
 *
 * `total` is not a column — it is summed per row on read, which is why it is
 * declared here rather than in the entity registry. A field the table does not
 * have has no business in the shape that describes the table.
 */
export const underlagListRow = underlagRow.extend({ total: z.string() });

/** One basis with its lines and total — the detail read. */
export const underlagDetail = z.object({
  underlag: underlagRow,
  lines: z.array(underlagLine),
  total: z.string(),
});

// -- the assertions ---------------------------------------------------------
// `A extends B ? B extends A ? true : never : never` is `true` only when the two
// are the same shape. A schema that gains, loses or retypes a field against the
// projection stops compiling here.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _listRow: Exact<z.infer<typeof underlagListRow>, UnderlagListRow> = true;
const _detail: Exact<z.infer<typeof underlagDetail>, UnderlagDetail> = true;
void _listRow;
void _detail;
