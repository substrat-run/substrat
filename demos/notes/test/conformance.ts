/**
 * Notes' entity-check claim, in the one place both the test and the trust page read it.
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { notesOperations } from '../spec/model.js';

export const conformance = declareNodeOnly({
  subject: 'notes',
  operations: notesOperations,
  because:
    'Two operations, both checked at the node. The notepad is shared by everyone who holds a ' +
    'role here, so there is no note that is one person’s and no entity to narrow to. Who holds ' +
    'a role is the part that matters, and it is decided in the app this plugin takes its people ' +
    'from: `test/people.test.ts` holds that. No entity grant shape is declared, so a narrowed ' +
    'check would resolve against nothing and deny every caller.',
});
