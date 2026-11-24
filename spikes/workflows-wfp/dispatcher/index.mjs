// /<script>/<route>?… → that script in the namespace, as /<route>?…, after the spike's token.
// Only the spike's own three scripts are reachable.
const SCRIPTS = new Set(['substrat-spike-wf-acme', 'substrat-spike-wf-acme-v2', 'substrat-spike-wf-acme-clash']);

export default {
  async fetch(request, env) {
    if (!env.SPIKE_TOKEN || request.headers.get('x-spike-token') !== env.SPIKE_TOKEN) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    const [, script, ...rest] = url.pathname.split('/');
    if (!SCRIPTS.has(script)) return new Response('unknown script', { status: 404 });
    url.pathname = `/${rest.join('/')}`;
    return env.DISPATCH.get(script).fetch(new Request(url, request));
  },
};
