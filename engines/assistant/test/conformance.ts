/**
 * The assistant's entity-check claim, in the one place both the test and the trust page read
 * it (#866).
 *
 * The `declared` kind: this engine has a declared operation surface, so the claim is read off
 * it by `planEntityCheckCoverage` rather than grepped out of `index.ts`.
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { assistantOperations } from '../src/operations.js';

export const conformance = declareNodeOnly({
  subject: 'engine-assistant',
  operations: assistantOperations,
  because:
    "A thread is its owner's, and that is a comparison of principals the handlers make " +
    '(a stranger is told the thread does not exist), not a per-entity grant somebody else could ' +
    'hold: no operation narrows to a record another principal has a grant on. `assistant:audit` ' +
    "widens a READ to every thread in the scope and never a write. The host's keys " +
    '(`assistant:run`) are scope-level by design, because a run is addressed by the thread it ' +
    'was handed and fenced by its lease, not by who is asking. What would change this is a ' +
    'thread shared with a second principal (a human agent joining), whose access would be a ' +
    "per-thread grant; that belongs with the participants work, and this assessment goes red " +
    'the day an operation declares one.',
});
