/**
 * The engine seam (#771) for engine-metering — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970), where the prose explaining what they are for
 * lives with them; an engine supplies only the name it answers under.
 *
 * What is specific to this engine is that almost everything it publishes is a
 * number a bill is computed from. `qty` is summed by `aggregateMeter` into a
 * period line, and a line is what the vertical prices and hands to invoicing — so
 * a drifted summand is not a rendering bug, it is a wrong invoice with no throw
 * anywhere. `occurred_at` is the other one: every window here is a string
 * comparison over ISO instants, so an instant in a shape the engine never
 * promised sorts into or out of a window silently, and the close that freezes it
 * is immutable afterwards.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-metering');
