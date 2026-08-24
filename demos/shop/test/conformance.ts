/**
 * Shop's entity-check claim, in the one place both the test and the trust page
 * read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { shopOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'shop',
  operations: shopOperations,
  // Nothing supplied and nothing uncovered: the one driven operation takes an
  // order id the kit already provides.
  //
  // Shop's other three narrowed checks are absent rather than uncovered, and the
  // distinction is the finding #892 carried forward. Two are per-row walks inside
  // a list, so they declare `narrows` and claim no single entity check. The third
  // is `shop/checkout`, which opens on the NODE gate `cart:checkout` and then
  // narrows `order:read` to the customer being billed — a shape this kit
  // structurally cannot reach, since the probe holds nothing scope-wide and is
  // refused on the first line before the narrowed check is ever evaluated. Shop
  // declares its opening gate, which is true; the narrowed second check is the
  // kit's open limit, tracked on #890.
  uncovered: {},
});
