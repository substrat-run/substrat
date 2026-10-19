/**
 * The entity-check claim, in the one place both the test and the trust page read it (#866).
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { notificationsOperations } from '../src/operations.js';

export const conformance = declareNodeOnly({
  subject: 'engine-notifications',
  operations: notificationsOperations,
  because:
    'Five operations, five node checks. Three act on the CALLER\'s own preferences under ' +
    '`notifications:self` and take no principal as input, so there is no other record a grant ' +
    'could narrow them to; the fourth reads the scope\'s delivery log under `notifications:read`, ' +
    'which is an administrator\'s view of the scope rather than of any one entity; the fifth sends ' +
    'the digests that are due under `notifications:send-digests`, the digest schedule\'s key, which ' +
    'acts on the whole scope by design. The case that would change this is a delivery log narrowed ' +
    'to the entity a mail was about, which would be a per-entity walk over `about` and is not offered.',
});
