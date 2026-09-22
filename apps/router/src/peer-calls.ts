import { WorkerEntrypoint } from 'cloudflare:workers';
import { handlePeerCall, type Env, type PeerCallOutcome } from './worker.js';

/**
 * The peer transport's entrypoint (#1706) — how one vertical's call reaches another's door.
 *
 * **Why a named entrypoint rather than a route.** A dispatched vertical has no service
 * binding (`control-plane-api/src/deploy.ts` refuses one at push) and no way to address this
 * class; only the egress worker, whose wrangler config names it, can reach it. Over the
 * router's PUBLIC `fetch` the same call would be indistinguishable from a request off the
 * internet — which is exactly why the caller's identity does not travel in the request. It
 * travels as the dispatch parameters the router set when it dispatched the caller, which the
 * caller cannot touch.
 *
 * So the identity is as strong as the `x-substrat-tenant` every vertical already trusts, and
 * rests on the same two facts: a dispatched script is reachable only through a dispatcher,
 * and the router strips every inbound `x-substrat-*` before asserting its own.
 *
 * Three lines, deliberately: everything it decides is `handlePeerCall`, which the router's
 * node tests can reach without importing the workers runtime.
 */
export class PeerCalls extends WorkerEntrypoint<Env> {
  invoke(caller: unknown, request: unknown): Promise<PeerCallOutcome> {
    return handlePeerCall(this.env, caller, request);
  }
}
