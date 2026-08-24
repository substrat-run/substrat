/**
 * Manyfold checks at the node only — assessed under #865, and provably so.
 *
 * Twenty-five checks across `author`, `review`, `publish`, `read`, `admin` and
 * `manage-sites`, every one at the node. That is the editorial model working as
 * designed: authority here is a ROLE over the whole workspace — an author
 * authors, a publisher publishes — and a document's lifecycle gates who may act
 * on it by its *state*, not by who was granted that particular document.
 *
 * ## The strong half of this assessment
 *
 * `ENTITY_GRANTS` in `src/provision.ts` is `[]`, and that is not a coincidence
 * to be re-derived by reading handlers. A narrowed check answers against a
 * narrowed grant; a vertical that mints none has nothing for a narrowed check to
 * resolve, so an entity check here would deny every caller. The empty list and
 * the twenty-five node checks are two statements of one fact, and the assertion
 * below holds them together.
 *
 * A per-site editorial boundary — author on this site, not that one — is the
 * change that would break both at once: it needs a grant shape in §4 of
 * `PERMISSIONS.md` AND narrowed checks. Both halves would go red here.
 */
import { describe, expect, it } from 'vitest';
import { nodeOnlySuite } from '@substrat-run/contract-tests';
import { ENTITY_GRANTS } from '../src/provision.js';
import { conformance } from './conformance.js';

nodeOnlySuite(conformance.subject, conformance);

describe('checks at the node only: manyfold, the grant half', () => {
  it('mints no entity-narrowed grant, so a narrowed check would resolve against nothing', () => {
    expect(ENTITY_GRANTS).toEqual([]);
  });
});
