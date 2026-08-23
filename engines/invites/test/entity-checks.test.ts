/**
 * This engine checks at the node only — assessed under #865, not left silent.
 *
 * Three operations, three node checks: `send`, `read`, `revoke`. An invitation
 * is an administrative act about the SCOPE — who may join it — so the authority
 * to send one, see the pending list, or revoke one is authority over the scope's
 * membership rather than over any one invite. There is no principal who should
 * hold `invites:revoke` for one invitation and not the next.
 *
 * The case that would change this is a vertical wanting "revoke only what you
 * sent". That is a policy about the inviter, and it belongs to whichever
 * vertical wants it — the engine would express it as a narrowed check and this
 * file would go red, which is the arrangement working.
 *
 * See `nodeOnlySuite`'s header for exactly how much this proves. It is a
 * tripwire, not the conformance kit; this engine has no declared operation
 * surface for the kit to read, and building one is filed separately.
 */
import { nodeOnlySuite } from '@substrat-run/contract-tests';

nodeOnlySuite('engine-invites', {
  sources: [new URL('../src/index.ts', import.meta.url).pathname],
});
