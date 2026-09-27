import { SWITCH_HOLDS_NAME } from '../src/host.js';

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
  await warmDurableObject(() =>
    (ns.get(ns.idFromName('control-plane')) as unknown as { listScopes(filter: object): Promise<unknown> }).listScopes(
      {},
    ),
  );
}

/**
 * The same absorb, for any one call on any Durable Object (#1819): a suite whose first call
 * lands on a singleton other than the directory warms that one too. `touch` must re-get its
 * stub each time it is called, because the stub is invalidated along with the object.
 */
export async function warmDurableObject(touch: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await touch();
      return;
    } catch (err) {
      const transient = err instanceof Error && err.message.includes('invalidating this Durable Object');
      if (!transient || attempt >= 2) throw err;
    }
  }
}

/**
 * #1819: every schedule pass that finds a module on reads the deployment's hold object, which is
 * a singleton in the scope namespace and so lives across test files. A file whose passes assert
 * `errors: []` absorbs the reload on it up front; the pass would otherwise report the reload as
 * an unreadable hold (and fail open, correctly).
 */
export function warmSwitchHolds(ns: DurableObjectNamespace): Promise<void> {
  return warmDurableObject(() =>
    (ns.get(ns.idFromName(SWITCH_HOLDS_NAME)) as unknown as { switchHoldsAll(): Promise<unknown> }).switchHoldsAll(),
  );
}
