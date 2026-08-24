/**
 * Booking's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { bookingOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'engine-booking',
  operations: bookingOperations,
  // Only what each schema REQUIRES beyond `reservationId`. These need to be
  // plausible, not domain-valid: case 1 asserts "was not denied", and a
  // business refusal on a fresh hold is not a permission answer.
  inputs: {
    'booking/join': { partyRef: '01JPARTY0000000000000000000' },
    'booking/leave': { participantId: '01JPARTICIPANT00000000000000' },
    'booking/open': { fillTarget: 4 },
  },
  uncovered: {},
});
