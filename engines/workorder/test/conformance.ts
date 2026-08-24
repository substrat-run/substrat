/**
 * Workorder's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { workorderOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'engine-workorder',
  operations: workorderOperations,
  // Nothing to supply: the one narrowed operation takes an order id and nothing
  // else the schema requires, so the kit builds the whole input itself.
  uncovered: {},
});
