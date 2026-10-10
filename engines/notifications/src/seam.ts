/**
 * The engine seam (#771) for engine-notifications — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` lives in `@substrat-run/contracts` (#970). Every value
 * this engine hands a caller goes out through it, so a stored row that no longer matches the
 * published shape throws instead of reaching a screen as wrong data. No `columnsOf`: the
 * engine's one row-returning read is the kernel's `ctx.page`, which names no star either.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { returns } = engineSeam('engine-notifications');
