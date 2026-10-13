import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleStoreCall, type StoreCallCaller } from '../../router/src/store-calls.js';

/**
 * The router's scope-store entrypoint, with the dispatch namespace stood in
 * for by one service binding.
 *
 * `handleStoreCall` is the production function: it refuses another scope,
 * signs the object name, and chooses the script. Miniflare's local dispatch
 * namespace does not host a user worker, so `get` here checks that script
 * name and fetches the store the suite bound.
 */
export class ScopeStoreCalls extends WorkerEntrypoint<{ STORE_HMAC_KEY: string; STORE: Fetcher }> {
  invoke(caller: StoreCallCaller, request: unknown) {
    return handleStoreCall(
      {
        STORE_HMAC_KEY: this.env.STORE_HMAC_KEY,
        DISPATCH: {
          get: (scriptName) => ({
            fetch: (req) => {
              if (scriptName !== 'substrat-store-ontomate-docs') {
                return Promise.resolve(new Response('wrong script', { status: 500 }));
              }
              return this.env.STORE.fetch(req);
            },
          }),
        },
      },
      caller,
      request,
    );
  }
}
