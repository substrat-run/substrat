/**
 * Invoicing's entity-check claim, in the one place both the test and the trust
 * page read it (#866).
 *
 * This is the `declared` kind rather than the `asserted` one: invoicing HAS a
 * declared operation set, so the claim is read off the declaration by
 * `planEntityCheckCoverage` instead of grepped out of the source. Exact where a
 * tripwire is lexical.
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { invoicingOperations } from '../src/operations.js';

export const conformance = declareNodeOnly({
  subject: 'engine-invoicing',
  operations: invoicingOperations,
  because:
    'Invoicing is composed BY EVENT (CLAUDE.md): the vertical emits, the engine consumes, and ' +
    'the engine is the only writer of its rows. Its three operations — `list`, `get`, `export` — ' +
    "are office reads and an office action over the scope's own invoice bases. There is no " +
    'per-recipient view of an underlag to narrow to, and no caller who should hold ' +
    '`invoicing:read` for one basis and not another; a portal customer sees work orders, not ' +
    'invoice bases.',
});
