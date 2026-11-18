/**
 * The Bolagsverket connector as its own Worker script (docs/rfc/connector-scripts.md, phase 1).
 *
 * Deployed into the vertical dispatch namespace as `substrat-connector-bolagsverket`, so the router
 * dispatches it with an outbound policy and every provider call leaves through the egress worker.
 * It declares no binding at all (`wrangler.jsonc`): no storage, no secret, no service. What it
 * needs arrives in the call, and nothing outlives the call.
 */
import { globalFetch } from '@substrat-run/kernel';
import { serveBolagsverketCall } from './remote.js';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request): Promise<Response> {
    let body: unknown = null;
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        return json({ error: 'a connector call is a JSON body' }, 400);
      }
    }
    const answer = await serveBolagsverketCall(new URL(request.url).pathname, request.method, body, globalFetch);
    return json(answer.body, answer.status);
  },
};
