/**
 * Manyfold checks at the node only — assessed under #865, and provably so.
 *
 * Every check across `author`, `review`, `publish`, `read`, `admin` and
 * `manage-sites` is at the node. That is the editorial model working as
 * designed: authority here is a ROLE over the whole workspace — an author
 * authors, a publisher publishes — and a document's lifecycle gates who may act
 * on it by its *state*, not by who was granted that particular document.
 *
 * ## Two halves, and neither is enough alone
 *
 * The first is the DECLARATION (`src/operations.ts`, landed for #865's tail).
 * The plan `planEntityCheckCoverage` derives from it is empty, which is exact
 * rather than lexical: the tripwire this replaces read the module's source for a
 * two-argument `ctx.check` and would have missed one assembled through a helper.
 * `declaredNodeOnlySuite` also asserts that every operation still says what it
 * checks — an ungated operation produces an empty plan too, so emptiness alone
 * cannot tell "checks at the node" from "checks nothing".
 *
 * The second is the GRANT half, and no declaration can state it: `ENTITY_GRANTS`
 * in `src/provision.ts` is `[]`. A narrowed check answers against a narrowed
 * grant; a vertical that mints none has nothing for one to resolve, so an entity
 * check here would deny every caller. The empty list and the node checks are two
 * statements of one fact, and the assertion below holds them together.
 *
 * A per-site editorial boundary — author on this site, not that one — is the
 * change that would break both at once: it needs a grant shape in §4 of
 * `PERMISSIONS.md` AND narrowed checks. Both halves would go red here.
 */
import { describe, expect, it } from 'vitest';
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { ENTITY_GRANTS } from '../src/provision.js';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);

describe('checks at the node only: manyfold, the grant half', () => {
  it('mints no entity-narrowed grant, so a narrowed check would resolve against nothing', () => {
    expect(ENTITY_GRANTS).toEqual([]);
  });
});
