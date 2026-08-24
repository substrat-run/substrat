/**
 * Rally's entity-check claim, in the one place both the test and the trust page
 * read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { rallyOperations } from '../src/operations.js';

/**
 * A member the reservation-facing cases can add to a booking.
 *
 * Held in the object the kit is handed rather than passed by value: `inputs` is
 * read when the suite is COLLECTED, which is before `beforeAll` has run, so a
 * plain string would still be empty. The kit spreads this object per case, at
 * run time, by which point the id is in it — and the emitter, which only asks
 * whether a field was supplied at all, is satisfied by the placeholder.
 */
export const spareMember: Record<string, unknown> = { memberId: '' };

export const conformance = declareEntityChecks({
  subject: 'rally',
  operations: rallyOperations,
  // Only what each schema REQUIRES beyond the id the kit supplies. These need to
  // be plausible, not domain-valid: case 1 asserts "was not denied", and a
  // business refusal on a fresh hold is not a permission answer.
  inputs: {
    'rally/add-player': spareMember,
    'rally/open-up': { spots: 2, levelMin: 'C', levelMax: 'B' },
    // The handler is entity-agnostic and the declaration cannot yet say so
    // (#890), so the type it is driven with is supplied here — the same
    // constant every call site passes.
    'rally/timeline': { entityType: 'member' },
  },
  uncovered: {
    'rally/cancel-subscription':
      "declares 'resolved' (the member is read off the subscription row) — the entity id is not in the input, so the harness cannot reach the entity",
  },
});
