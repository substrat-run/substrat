/**
 * The engine seam (#771) for engine-workorder — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970). Four engines carried byte-identical copies of
 * the implementation, differing only in the name each put into a seam failure —
 * so the seam had itself become the kind of convention-repeated-in-seven-engines
 * that it was written to replace. The prose explaining what the two helpers are
 * FOR, and why parsing is unconditional, lives with them in
 * `packages/contracts/src/seam.ts`; this engine's reference conversion is the
 * call sites in `index.ts`.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-workorder');
