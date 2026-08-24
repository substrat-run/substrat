/**
 * Handlebar's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { handlebarOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'handlebar',
  operations: handlebarOperations,
  // `bike-shop/timeline` needed `{ entityType: 'workorder' }` here until #890.
  // With `entityFrom` the kit reads the admissible types off the schema, so the
  // pair is driven over a repair AND over a condition report — the second of
  // which this fixture's hand-written entry had quietly excluded.
  uncovered: {},
});
