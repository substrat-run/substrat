import { afterEach } from 'vitest';
import { NON_PROBLEM_REFUSAL } from '../../src/errors.js';

/**
 * Every test in this package is a witness that the control plane answers a failure as a
 * problem document (#113). The API logs `NON_PROBLEM_REFUSAL` when it answers a status of
 * 400 or more with any other media type; this fails the test in which that happened, naming
 * the route and the status, so a hand-rolled `c.json({ error }, 404)` goes red in the first
 * test that reaches it rather than in a client.
 *
 * A test that replaces `console.warn` outright (a `mockImplementation`) silences this for its
 * own duration. That is the one gap, and it is a test choosing not to watch.
 */
const fired: unknown[] = [];

const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (args[0] === NON_PROBLEM_REFUSAL) fired.push(args[1]);
  warn(...args);
};

/** Hand over what the tripwire saw in this test, and clear it — for the test of the tripwire itself. */
export function takeNonProblemRefusals(): unknown[] {
  return fired.splice(0);
}

// No `beforeEach` clearing: a refusal answered in a `beforeAll` must fail the file's first
// test, not be wiped before it runs.
afterEach(() => {
  const seen = takeNonProblemRefusals();
  if (seen.length > 0) {
    throw new Error(
      `the control plane answered a failure that is not a problem document (#113): ${JSON.stringify(seen)}. ` +
        'Answer it through refuse/refuseStatus/problem in src/api.ts.',
    );
  }
});
