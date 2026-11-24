/**
 * The egress worker, reduced to its store half (`apps/vertical-egress/src/worker.ts`).
 * A fetch of `store.substrat.internal` is handed to the router's `StoreCalls` with the
 * caller the dispatch was made for. On Workers for Platforms that caller arrives as the
 * `OUTBOUND_POLICY` dispatch parameter; miniflare has no dispatch parameters, so it is a
 * fixed binding here. Anything else is refused: this spike reaches nothing outside.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== 'store.substrat.internal') {
      return new Response('egress: not a store call', { status: 403 });
    }
    const outcome = await env.STORE_CALLS.invoke(env.OUTBOUND_POLICY, await request.json());
    return Response.json(outcome.ok ? outcome.body : { error: { status: outcome.status, message: outcome.message } }, {
      status: outcome.status,
    });
  },
};
