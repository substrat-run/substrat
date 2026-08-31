/**
 * The engine seam (#771) for engine-invoicing — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970), where the prose explaining what they are for
 * lives with them; an engine supplies only the name it answers under.
 *
 * What is specific to this engine is what a drifted row costs. An invoice basis
 * is a financial artifact: `line_total_amount` and `currency` are folded into the
 * total this engine emits on `invoicing.underlag-exported`, so a summand that
 * moved crosses as a NUMBER an accounting connector then invoices — wrong money
 * on a real document, never a throw. And `status` is the immutable-after-export
 * invariant itself, read to decide whether a basis may still change.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-invoicing');
