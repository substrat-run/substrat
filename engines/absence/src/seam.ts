/**
 * The engine seam (#771) for engine-absence — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970), where the prose explaining what they are for
 * lives with them; this file used to be a byte-identical copy of that
 * implementation, differing only in the name below.
 *
 * What is specific to this engine is the reach of "parse always": it covers the
 * ledger fold. A balance is the sum of every `delta` in the ledger, so a `delta`
 * that drifted is the one value here that would otherwise cross as a *number
 * nobody questions*: wrong on a screen, never a throw. Every read here is one row,
 * one subject's ledger, one page (#811), or one date window, so the parsed set is
 * bounded by the caller's own window.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-absence');
