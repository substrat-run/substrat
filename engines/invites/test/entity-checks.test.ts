/**
 * This engine checks at the node only — assessed under #865, not left silent.
 *
 * The assessment used to be a `nodeOnlySuite` tripwire over `index.ts`, because
 * this engine had no declared operation surface for the kit to read. It has one
 * now (`src/operations.ts`), so the claim is the STRONGER kind: the plan
 * `planEntityCheckCoverage` derives from the declaration is empty, which is
 * exact rather than lexical, and it goes red the moment an operation declares a
 * narrowed check instead of the moment someone happens to write `ctx.check(k,
 * ref)` on one line.
 *
 * The second thing it asserts is the one easy to leave out: every operation
 * still says what it checks. An operation with NO check also produces an empty
 * plan, so emptiness alone cannot tell "checks at the node" from "checks
 * nothing". `invites/accept` genuinely checks nothing and declares `narrows`
 * with the reason, which is how the exception stays visible.
 */
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);
