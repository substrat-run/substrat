/**
 * Callout's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { calloutOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'callout',
  operations: calloutOperations,
  // No `inputs` at all. `callout/timeline` needed `{ entityType: 'workorder' }`
  // until #890, and that entry was doing two jobs badly: supplying a constant the
  // schema could state, and silently choosing WHICH of the operation's types got
  // driven. It declares `entityFrom` now, so the kit reads both admissible types
  // off the schema and drives the pair over each — a work order and a protocol.
  //
  // `callout/portal-orders` is absent rather than uncovered: it declares
  // `narrows`, so it claims no single entity check for this suite to honour.
  // Its per-row proof walk is what the scenario's portal-isolation beat proves.
  uncovered: {},
});
