/**
 * Invites' entity-check claim, in the one place both the test and the trust page
 * read it (#866).
 *
 * The `declared` kind since #865's tail: this engine now HAS a declared
 * operation surface, so the claim is read off it by `planEntityCheckCoverage`
 * rather than grepped out of `index.ts`. Exact where the tripwire was lexical.
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { invitesOperations } from '../src/operations.js';

export const conformance = declareNodeOnly({
  subject: 'engine-invites',
  operations: invitesOperations,
  because:
    'Three checked operations, three node checks: `send`, `list`, `revoke`. An invitation is an ' +
    'administrative act about the SCOPE — who may join it — so the authority to send one, see ' +
    'the pending list, or revoke one is authority over membership rather than over any single ' +
    'invite. The case that would change this is a vertical wanting "revoke only what you sent", ' +
    'which is a policy about the inviter and belongs to whichever vertical wants it. The fourth, ' +
    '`accept`, checks nothing and declares `narrows` to say so: the recipient holds nothing yet, ' +
    'and the invitation itself is the authority.',
});
