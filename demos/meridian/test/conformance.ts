/**
 * Meridian's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { meridianOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'meridian',
  operations: meridianOperations,
  // Only what each schema REQUIRES beyond the id the kit supplies. These need
  // to be plausible, not domain-valid: case 1 asserts "was not denied", and a
  // business refusal on a fresh employee is not a permission answer.
  inputs: {
    'hr/request-leave': {
      leaveTypeKey: 'vacation',
      startDate: '2031-06-01',
      endDate: '2031-06-05',
      days: '5',
    },
    'hr/log-time': { workDate: '2031-06-01', hours: '8' },
    'hr/submit-expense': {
      description: 'Conformance',
      amount: '100',
      currency: 'SEK',
      category: 'travel',
    },
  },
  // Four of Meridian's thirteen narrowed checks are absent rather than uncovered,
  // and `operations.ts` says why rather than leaving it to be inferred.
  // `hr/list-leave-types` and `hr/list-projects` narrow only when the caller
  // supplies the optional `employeeId` and check the node otherwise, which
  // `{ key, entity, idFrom }` cannot state — so they declare the bare key, the
  // safe understatement, and claim no entity check. The two `protocol:*` checks
  // inside `hr/issue-employment-contract` are a second authority the declaration
  // has no room to record at all (#890).
  uncovered: {},
});
