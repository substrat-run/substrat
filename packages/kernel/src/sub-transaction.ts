/**
 * `ctx.atomic` — the engine-seam sub-transaction (#770,
 * docs/design/sub-transactions.md).
 *
 * A vertical composes engine in-scope functions inside ONE scope transaction,
 * and the adapter rolls back only if the whole handler throws. So a vertical
 * that catches an engine error is sitting on that engine's partial writes and
 * commits them. `ctx.atomic(fn)` is the boundary that was missing: if `fn`
 * throws, everything it wrote is discarded and the original error is rethrown;
 * the caller's own writes survive and the operation still commits once.
 *
 * **Every semantic lives here, not in the adapters** (§3 of the design note).
 * A scope host supplies exactly one method — `runSub(depth, fn)` — and the
 * kernel owns the depth stack, the restore of the two in-memory tallies below,
 * the interleaving guard, and the unwrapped rethrow. Duplicating that per host
 * is what rots when someone writes a third adapter over Postgres or Kubernetes
 * (#123), and §4.1's failure mode is silent: a well-formed event carrying an
 * authorization for work that was discarded.
 *
 * `runSub` is CLOSURE-shaped on purpose. The obvious `enter`/`rollback`/
 * `release` triple cannot work: the Durable Object primitive IS a closure
 * (`storage.transaction(async () => …)`) and decomposing it would mean holding
 * a manually-resolved promise open across the runtime's I/O gates. A closure
 * wraps savepoints trivially; the reverse is not true.
 */
import type { EventAuthorization } from '@substrat-run/contracts';

/**
 * The one thing a scope host supplies. `depth` is 1-based and increases with
 * nesting — a SQL host names its savepoint from it; the DO host ignores it,
 * because the runtime owns that stack itself.
 *
 * Contract: run `fn` inside a nested transaction. On success its writes join the
 * enclosing transaction (still provisional — an outer failure discards them
 * too). On a throw, discard everything `fn` wrote and rethrow **the original
 * error, unwrapped**.
 */
export type RunSub = <T>(depth: number, fn: () => Promise<T>) => Promise<T>;

/**
 * Per-invoke state that lives in JavaScript rather than in the database, and so
 * does not roll back with the storage transaction. Both are append-only during
 * an operation, which is why a mark/restore is enough.
 */
export interface AtomicMarks {
  /**
   * The K-34 accumulator of checks that passed in this operation; `ctx.emit`
   * snapshots it onto every event's `authorization`. Without the restore, a
   * check that passed inside a rolled-back sub-transaction would still appear
   * on a LATER event — the audit spine attributing a permission check to an
   * event whose operation discarded the thing it authorized.
   */
  passed: EventAuthorization[];
  /**
   * The #458 per-invoke `ctx.requestPlatform` tally behind `onPlatformRequests`
   * (the router's immediate-drain kick, #381). Absent for consumer dispatch.
   * `ScopeStubOptions` promises it never fires for a rolled-back operation; the
   * restore is what keeps that true at this boundary too.
   */
  signals?: { platformRequests: number };
}

/**
 * Build the `atomic` verb for one operation context. Called by the adapter while
 * assembling `OperationContext`, with its own `runSub` and that invoke's marks.
 */
export function createAtomic(
  runSub: RunSub,
  marks: AtomicMarks,
): <T>(fn: () => T | Promise<T>) => Promise<T> {
  // The nesting stack. Tokens rather than a counter so an INTERLEAVED pair (two
  // atomics started concurrently, e.g. via Promise.all) is detectable: correct
  // nesting always unwinds in reverse order, interleaving does not. Interleaved
  // sub-transactions would share or cross savepoint frames and silently discard
  // a sibling's writes, so this fails loudly instead.
  const stack: object[] = [];

  const unwind = (token: object): void => {
    const top = stack.pop();
    if (top !== token) {
      stack.length = 0;
      throw new Error(
        'ctx.atomic(…) calls overlapped — sub-transactions must nest, not interleave. ' +
          'Do not start two atomics concurrently (Promise.all); await each one.',
      );
    }
  };

  return async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const passedMark = marks.passed.length;
    const platformRequestMark = marks.signals?.platformRequests ?? 0;
    const token = {};
    stack.push(token);
    const depth = stack.length;

    let result: T;
    try {
      result = await runSub(depth, async () => await fn());
    } catch (err) {
      // The storage rolled back; restore what it could not reach.
      marks.passed.length = passedMark;
      if (marks.signals) marks.signals.platformRequests = platformRequestMark;
      unwind(token);
      throw err;
    }
    unwind(token);
    return result;
  };
}
