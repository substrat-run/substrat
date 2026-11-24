// The shape of the platform entry the uploader puts in front of every vertical
// (tools/platform-entry-emit.mts): everything the vertical exports is re-exported as it is, and
// only the default export's fetch is wrapped. The real wrapper verifies the wire envelope (K-58);
// this one stamps the request and counts the pass, so a run can see which calls came through it.
import * as vertical from './vertical.mjs';
export * from './vertical.mjs';

export default {
  async fetch(request, env, ctx) {
    await env.SCOPE.get(env.SCOPE.idFromName('__gate')).bump('gate-passes');
    const stamped = new Request(request);
    stamped.headers.set('x-spike-gate', 'passed');
    return vertical.default.fetch(stamped, env, ctx);
  },
};
