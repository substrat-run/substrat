/**
 * Graph notes checks at the node only: its operations are permission gates in front of the
 * scope store, and the notes are not entities of this vertical. The suite holds every operation
 * to a declared check, since an ungated operation would leave the plan just as empty.
 */
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);
