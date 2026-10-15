/**
 * The engine seam (#771) for engine-assistant — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in `@substrat-run/contracts`
 * (#970); an engine supplies only the name it answers under.
 *
 * What is specific here: a stored `body` is parsed back through the stream protocol's own
 * schema before it reaches a client, and a stored `state` decides what a tool call may do
 * next. A row that drifted would otherwise reach a screen as a half-formed event, or let a
 * gated write through a state the engine thinks it cannot be in.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-assistant');
