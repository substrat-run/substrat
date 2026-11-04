// Hands every request to the spike's supervisor in the dispatch namespace, unchanged.
export default {
  fetch(request, env) {
    return env.DISPATCH.get('substrat-spike-store-facets').fetch(request);
  },
};
