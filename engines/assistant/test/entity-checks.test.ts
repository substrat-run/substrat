/**
 * This engine checks at the node only, assessed rather than left silent.
 *
 * The claim is read off the declared operation surface: the plan `planEntityCheckCoverage`
 * derives is empty. That is exact rather than lexical, and goes red when an operation
 * DECLARES a narrowed check. The second assertion inside the suite is the easy one to leave
 * out: every operation still says what it checks, because an operation with no check at all
 * also produces an empty plan.
 */
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);
