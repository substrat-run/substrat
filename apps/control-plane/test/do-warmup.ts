/**
 * vitest-pool-workers re-patches the worker's module graph between test FILES
 * (even with `singleWorker: true`), which invalidates live Durable Objects: the
 * first stub call of the next file can throw
 *
 *   "…/src/worker.ts changed, invalidating this Durable Object.
 *    Please retry the `DurableObjectStub#fetch()` call."
 *
 * The config's `retry: 2` absorbs that inside a test, but NOT inside a
 * `beforeAll` — a suite that seeds through the DO there fails before any test
 * runs. Same shape as packages/adapter-cloudflare/test/do-warmup.ts: touch the
 * directory singleton, re-getting the stub each attempt (the stub is
 * invalidated along with the object), until the call lands. Anything OTHER
 * than the invalidation error is re-thrown — this must never mask a real
 * failure.
 */
export async function warmControlPlane(ns: DurableObjectNamespace): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const stub = ns.get(ns.idFromName('control-plane')) as unknown as {
      listScopes(filter: object): Promise<unknown>;
    };
    try {
      await stub.listScopes({});
      return;
    } catch (err) {
      const transient =
        err instanceof Error && err.message.includes('invalidating this Durable Object');
      if (!transient || attempt >= 2) throw err;
    }
  }
}
