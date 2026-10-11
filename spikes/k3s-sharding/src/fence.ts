/**
 * The lease/fence layer, as a wrapper around any `ScopeHost` (#1638 Q2).
 *
 * Every stub the host mints — `getScope`, `getImpersonatedScope`, `getSystemScope`, and any
 * other method that resolves to one, through `attributed()` too — invokes only while this
 * process holds the scope's lease, and acknowledges only if it STILL holds it when the
 * invocation returns:
 *
 *   admit(scope)        before: hold a lease that is valid now, or throw `NotHolder`
 *   invoke(…)           the host's own transaction, unchanged
 *   stillHeld(scope)    after: past `validUntil`, the result is withheld (`Fenced`)
 *
 * The second check is the fence. A holder can be frozen between the first check and the
 * commit — a GC pause, a stopped node — and wake after the control plane has handed the
 * scope on. Its commit then lands on a copy nobody serves any more; what must not happen is
 * that a caller is TOLD it succeeded. The caller retries under its idempotency key and the
 * new holder applies it once. `test/kill.test.ts` is that case.
 *
 * Only the operation path is fenced. The lifecycle and directory methods (`provisionScope`,
 * `admin.*`, snapshots) pass through untouched: they belong to the control plane, and making
 * that a service every shard calls is question 5, outside this spike.
 */
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { NotHolder } from './lease-client.js';

export interface ScopeGuard {
  /** Resolves when this process may write `scope` now; throws {@link NotHolder} otherwise. */
  admit(scope: string): Promise<void>;
  /** Whether a write that has just finished may be acknowledged. */
  stillHeld(scope: string): boolean;
}

/** The invocation finished after this process's lease ran out: its result is not an acknowledgement. */
export class Fenced extends Error {
  constructor(readonly scope: string) {
    super(`lease on ${scope} ran out during the invocation; not acknowledged`);
  }
}

/** Test seams around the invocation, so a fault can land between the two checks. */
export interface FenceHooks {
  beforeInvoke?(scope: string, operation: string, input: unknown): Promise<void>;
  afterInvoke?(scope: string, operation: string, input: unknown): Promise<void>;
}

function isStub(v: unknown): v is ScopeStub {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ScopeStub).invoke === 'function' &&
    typeof (v as ScopeStub).scopeId === 'string'
  );
}

function fenceStub(stub: ScopeStub, guard: ScopeGuard, hooks: FenceHooks): ScopeStub {
  const invoke: ScopeStub['invoke'] = async (operation, input, options) => {
    const scope = stub.scopeId;
    await guard.admit(scope);
    await hooks.beforeInvoke?.(scope, operation, input);
    const out = await stub.invoke(operation, input, options);
    await hooks.afterInvoke?.(scope, operation, input);
    if (!guard.stillHeld(scope)) throw new Fenced(scope);
    return out as never;
  };
  return new Proxy(stub, {
    get: (target, prop, receiver) => (prop === 'invoke' ? invoke : Reflect.get(target, prop, receiver)),
  });
}

export function fenceScopeHost(host: ScopeHost, guard: ScopeGuard, hooks: FenceHooks = {}): ScopeHost {
  return new Proxy(host, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (prop === 'attributed') return fenceScopeHost(out as ScopeHost, guard, hooks);
        if (out instanceof Promise) return out.then((v: unknown) => (isStub(v) ? fenceStub(v, guard, hooks) : v));
        return out;
      };
    },
  });
}
