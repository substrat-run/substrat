/**
 * The engine seam (#771) for engine-notifications — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in `@substrat-run/contracts`
 * (#970). Every value this engine hands a caller goes out through `returns`, so a stored row
 * that no longer matches the published shape throws instead of reaching a screen as wrong data.
 * The paged delivery list is the kernel's `ctx.page`, which names no star; the digest's read of
 * its held items names its columns with `columnsOf` and parses each row the same way, because
 * what it reads is mailed.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-notifications');
