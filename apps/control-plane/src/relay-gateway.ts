import { WorkerEntrypoint } from 'cloudflare:workers';
import { relayGatewayRequest } from './relay-caller.js';
import worker from './worker.js';

/**
 * The relay, as reached by the egress worker (see `relay-caller.ts`).
 *
 * **Why a named entrypoint rather than the public origin.** A dispatched vertical has no
 * service binding (`control-plane-api/src/deploy.ts` refuses one at push), so only the egress
 * worker, whose wrangler config names this class, can reach it — which is what lets the caller
 * it attaches be believed. Same reasoning as the router's `PeerCalls` (#1706).
 *
 * Short on purpose: what it decides is `relayGatewayRequest`, and the routes are the worker's
 * own, served exactly as a public request would be once the caller is attached.
 */
export class RelayGateway extends WorkerEntrypoint<Parameters<typeof worker.fetch>[1]> {
  override fetch(request: Request): Response | Promise<Response> {
    const served = relayGatewayRequest(request);
    return served instanceof Response ? served : worker.fetch(served, this.env);
  }
}
