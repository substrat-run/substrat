import { fromWireFailure, toWireFailure, type WireFailure } from '@substrat-run/contracts';

/**
 * A Durable Object method's answer with its failure carried as DATA (#113).
 *
 * workerd delivers a throw across the DO boundary as its message alone: `name` is folded into
 * the text and every own property dropped, so a `substratError` raised in a DO reaches the
 * coordinator with its code gone. A returned record crosses intact, so the DO returns the
 * failure (`toWireFailure`) and the coordinator rethrows it, rebuilt with its code
 * (`unwrapReply`). The same envelope `invoke` and the capability verbs answer with.
 *
 * ControlPlaneDO answers through one `reply(method, args)` over `REPLIED_METHODS`. The ScopeDO
 * has a `…Reply` sibling per verb instead, because its old methods flatten their throw
 * (`toRpcError`) and the sibling has to reach the body underneath.
 */
export type DoReply<T> = { value: T; failure?: undefined } | { failure: WireFailure };

/** Run `fn` DO-side and answer its outcome as a `DoReply`. */
export async function replyOf<T>(fn: () => T | Promise<T>): Promise<DoReply<T>> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { failure: toWireFailure(err) };
  }
}

/** Coordinator-side: rethrow a reply's failure, rebuilt with its code; else its value. */
export function unwrapReply<T>(reply: DoReply<T>): T {
  if (reply.failure) throw fromWireFailure(reply.failure);
  return reply.value as T;
}
