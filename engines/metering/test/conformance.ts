/**
 * Metering's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 *
 * The `declared` kind since #865's tail: this engine now HAS a declared
 * operation surface, so the claim is read off it by `planEntityCheckCoverage`
 * rather than grepped out of `index.ts`. Exact where the tripwire was lexical.
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { meteringOperations } from '../src/operations.js';

export const conformance = declareNodeOnly({
  subject: 'engine-metering',
  operations: meteringOperations,
  because:
    'Metering counts what a scope consumed. A meter is scope-level configuration, `record` is ' +
    'machine-driven ingest, and a period closes for the scope as a whole — none of the eight ' +
    'operations has a per-entity reader. A principal entitled to see one meter and not another ' +
    'is a reporting concern in the vertical above, expressed by what it queries rather than by ' +
    "narrowing the engine's own checks. What would change that is a per-SUBJECT read — and a " +
    "subject is an opaque ref into the vertical's own noun, so that edge, and the walk along " +
    'it, belong to the vertical rather than here.',
});
