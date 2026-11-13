/**
 * The declared claim, executed: every operation here checks at the node, and the day one
 * narrows to an entity this goes red until `conformance.ts` says how it is covered.
 */
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);
