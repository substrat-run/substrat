/**
 * A request-scoped store call, run on workerd (#2245).
 *
 * The invocation log installs the observer through `globalThis`, and
 * `observeStoreCall` reads it when the vertical passed none. A call with no
 * request is not logged and does not throw. `nodejs_als` is what makes the
 * storage work here; the uploader sets that flag on every vertical.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  setStoreCallObserverResolver,
  type StoreCallLine,
} from '../../../packages/kernel/src/invocation-line.ts';
import { observeStoreCall } from '../../../packages/kernel/src/scope-store.ts';

interface Heard {
  calls: StoreCallLine[];
}

const records = new AsyncLocalStorage<Heard>();

setStoreCallObserverResolver(() => {
  const record = records.getStore();
  if (!record) return undefined;
  return (report) => {
    record.calls.push(report);
  };
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/bare') {
      await observeStoreCall('GRAPH', 'bare', async () => 1);
      return Response.json({ threw: false });
    }
    const heard: Heard = { calls: [] };
    const explicit: StoreCallLine[] = [];
    await records.run(heard, async () => {
      await observeStoreCall('GRAPH', 'read', async () => 1);
      await observeStoreCall('GRAPH', 'named', async () => 1, (report) => {
        explicit.push(report);
      });
    });
    return Response.json({ calls: heard.calls, explicit });
  },
};
