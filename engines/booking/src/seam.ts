/**
 * The engine seam (#771) for engine-booking — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970), where the prose explaining what they are for
 * lives with them; this file used to be a byte-identical copy of that
 * implementation, differing only in the name below.
 *
 * What is specific to this engine is the reach of "parse always": it covers the
 * bulk reads and the computed `availability` fold too. Every read here is one row,
 * one reservation's roster, one page (#811), or one resource's calendar window, so
 * the parsed set is bounded by the caller's own window.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-booking');
