/**
 * Manyfold's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 *
 * The `declared` kind since #865's tail: this vertical now HAS a declared
 * operation surface (`src/operations.ts`), so the claim is read off it by
 * `planEntityCheckCoverage` rather than grepped out of `module.ts`. Exact where
 * the tripwire was lexical — and the grant half of the argument keeps its own
 * assertion next door, because that is the part a declaration cannot state.
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { manyfoldOperations } from '../src/operations.js';

export const conformance = declareNodeOnly({
  subject: 'manyfold',
  operations: manyfoldOperations,
  because:
    'Twenty-one operations, every check at the node — the editorial model working as designed. ' +
    'Authority here is a ROLE over the whole workspace, and a document’s lifecycle gates who may ' +
    'act on it by its STATE rather than by who was granted that particular document. The strong ' +
    'half: `ENTITY_GRANTS` is empty, so a narrowed check would resolve against nothing and deny ' +
    'every caller. A per-site editorial boundary is the change that breaks both halves at once — ' +
    'it needs a grant shape in §4 of `PERMISSIONS.md` as well as narrowed checks here.',
});
