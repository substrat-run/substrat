/**
 * Absence's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { dataSubjectId } from '@substrat-run/contracts';
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { ulid } from '@substrat-run/kernel';
import { absenceOperations } from '../src/operations.js';

export const conformance = declareEntityChecks({
  subject: 'engine-absence',
  operations: absenceOperations,
  // The vertical's noun, named by the HARNESS because the engine has none of its
  // own (#896). Which type is deliberately not absence's business: an engine
  // promising to honour whatever ref it is handed should not care which one a
  // test picked, and if it does care, that is the finding.
  refEntityType: 'employee',
  // Only what each schema REQUIRES beyond the subject ref. Plausible, not
  // domain-valid: case 1 asserts "was not denied", and a business refusal is
  // not a permission answer.
  inputs: {
    'absence/request': {
      // The erasure key rides beside the ref inside `subject`; the kit writes
      // the ref at `subject.ref` and keeps this sibling.
      subject: { dataSubjectId: dataSubjectId.parse(ulid()) },
      leaveTypeKey: 'vacation',
      startDate: '2031-05-04',
      endDate: '2031-05-08',
      days: '5',
    },
    'absence/balance': { leaveTypeKey: 'vacation' },
    'absence/availability': { from: '2031-05-01', to: '2031-05-31' },
  },
  // Two of absence's six narrowed checks are absent rather than uncovered, and
  // `operations.ts` says why: `cancel` has a second authority whose ref is read
  // off the stored request, and `list-requests` narrows only when the caller
  // passes a subject. Both declare node keys rather than claiming a narrowing a
  // caller does not get.
  uncovered: {},
});
