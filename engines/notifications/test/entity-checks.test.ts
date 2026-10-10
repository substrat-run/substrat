/**
 * This engine checks at the node only — read off its declared surface, so an operation that
 * starts to narrow turns this red (see `conformance.ts`).
 */
import { declaredNodeOnlySuite } from '@substrat-run/contract-tests';
import { conformance } from './conformance.js';

declaredNodeOnlySuite(conformance.subject, conformance.operations, conformance.because);
