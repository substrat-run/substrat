/**
 * vitest-pool-workers re-patches the worker's module graph between test FILES
 * (even with `singleWorker: true`), which invalidates live Durable Objects: the
 * first stub call of the next file can throw
 *
 *   "…/test/worker.ts changed, invalidating this Durable Object.
 *    Please retry the `DurableObjectStub#fetch()` call."
 *
 * That error is transient by contract — its own message says retry — but a
 * contract assertion should never be the thing absorbing it. Each DO-touching
 * test file calls this once in a `beforeAll`: touch the directory singleton,
 * re-getting the stub each attempt (the stub is invalidated along with the
 * object), until the call lands. Anything OTHER than the invalidation error is
 * re-thrown — this must never mask a real failure.
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
