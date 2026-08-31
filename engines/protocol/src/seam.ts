/**
 * The engine seam (#771) for engine-protocol — the NAME, and nothing else.
 *
 * `returns(schema, surface, value)` and `columnsOf(schema)` live in
 * `@substrat-run/contracts` (#970), where the prose explaining what they are for
 * lives with them; this file used to be a byte-identical copy of that
 * implementation, differing only in the name below.
 *
 * This engine is the sharper case for having them at all: a signature attests to a
 * hash over the stored rows, and a row that quietly changed shape is a row whose
 * hash no longer says what the signatory was shown. So every published shape — the
 * template, the instance, each response, signature and request, and the composites
 * the operations answer with — is parsed on its way OUT by the schema `schemas.ts`
 * publishes, and every read names its columns.
 */
import { engineSeam } from '@substrat-run/contracts';

/** How this engine names itself in a seam failure. */
export const { columnsOf, returns } = engineSeam('engine-protocol');
