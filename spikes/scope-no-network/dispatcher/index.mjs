// Checks the spike token, then hands the request to `?script=plain|supervisor` in the namespace. The
// token keeps a probe that takes a host parameter from being anyone's proxy while the spike is up.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    // A header, or `?token=` for a WebSocket client, which cannot set one.
    const token = request.headers.get('x-spike-token') ?? url.searchParams.get('token');
    if (!env.SPIKE_TOKEN || token !== env.SPIKE_TOKEN) return new Response('token', { status: 401 });
    const script = url.searchParams.get('script');
    if (script !== 'plain' && script !== 'supervisor') return new Response('script=plain|supervisor', { status: 400 });
    return env.DISPATCH.get(`substrat-spike-scope-net-${script}`).fetch(request);
  },
};
