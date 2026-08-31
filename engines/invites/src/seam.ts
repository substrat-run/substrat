/**
 * The engine seam (#771) for engine-invites — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970), where the prose explaining what they are for
 * lives with them; an engine supplies only the name it answers under.
 *
 * What is specific to this engine is what the seam must NOT publish. The stored
 * row carries `identifier_hash`, and the whole non-enumerability property depends
 * on it never leaving — so the published schema is the row minus the hash, and
 * `columnsOf` derives the SELECT list from THAT. The exclusion is then a fact
 * about the read rather than a column list somebody remembered to keep in step:
 * `SELECT *` here would have leaked the hash on the first read that forgot.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-invites');
