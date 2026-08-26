/**
 * This engine checks at the node only — assessed under #865, not left silent.
 *
 * The assessment used to be a `nodeOnlySuite` tripwire over `index.ts`, because
 * this engine had no declared operation surface for the kit to read. It has one
 * now (`src/operations.ts`), so the claim is the STRONGER kind: the plan
 * `planEntityCheckCoverage` derives from the declaration is empty. That is exact
 * rather than lexical, and it goes red when an operation DECLARES a narrowed
 * check rather than when someone happens to spell one on a single line.
 *
 * The second assertion is the one easy to leave out: every operation still says
 * what it checks. An operation with no check at all also produces an empty plan,
 * so emptiness alone cannot tell "checks at the node" from "checks nothing".
 */
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);
