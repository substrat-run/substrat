/**
 * Invites' entity-check claim, in the one place both the test and the trust page
 * read it (#866).
 */
import { assertNodeOnly } from '@substrat-run/contract-tests/conformance';

export const conformance = assertNodeOnly({
  subject: 'engine-invites',
  sources: [new URL('../src/index.ts', import.meta.url).pathname],
  because:
    'Three operations, three node checks: `send`, `read`, `revoke`. An invitation is an ' +
    'administrative act about the SCOPE — who may join it — so the authority to send one, see ' +
    'the pending list, or revoke one is authority over membership rather than over any single ' +
    'invite. The case that would change this is a vertical wanting "revoke only what you sent", ' +
    'which is a policy about the inviter and belongs to whichever vertical wants it.',
});
