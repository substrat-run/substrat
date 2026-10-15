import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleStoreCall, type StoreCallCaller, type StoreCallOutcome } from './store-calls.js';
import type { Env } from './worker.js';

/**
 * The scope-store transport's entrypoint (#2207). Only the egress worker binds
 * it. The caller is the dispatch parameters, which a vertical cannot change.
 */
export class ScopeStoreCalls extends WorkerEntrypoint<Env> {
  invoke(caller: StoreCallCaller, request: unknown): Promise<StoreCallOutcome> {
    const dispatch = this.env.DISPATCH;
    return handleStoreCall(
      {
        STORE_CALLER_KEY: this.env.STORE_CALLER_KEY,
        DISPATCH: dispatch
          ? { get: (scriptName) => ({ fetch: (req) => dispatch.get(scriptName).fetch(req) }) }
          : undefined,
      },
      caller,
      request,
    );
  }
}
