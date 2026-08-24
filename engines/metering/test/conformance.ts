/**
 * Metering's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 */
import { assertNodeOnly } from '@substrat-run/contract-tests/conformance';

export const conformance = assertNodeOnly({
  subject: 'engine-metering',
  sources: [new URL('../src/index.ts', import.meta.url).pathname],
  because:
    'Metering counts what a scope consumed. A meter is scope-level configuration, `record` is ' +
    'machine-driven ingest, and a period closes for the scope as a whole — none of the eight ' +
    'checks has a per-entity reader. A principal entitled to see one meter and not another is a ' +
    'reporting concern in the vertical above, expressed by what it queries rather than by ' +
    "narrowing the engine's own checks.",
});
