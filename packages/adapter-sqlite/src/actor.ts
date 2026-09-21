import { AsyncLocalStorage } from 'node:async_hooks';

/** The actor tasks the current async context is running inside, innermost last. */
interface HeldTask {
  readonly actor: ScopeActor;
  /** Cleared when the task settles, so a promise it left running does not inherit it. */
  live: boolean;
}
const held = new AsyncLocalStorage<readonly HeldTask[]>();

/**
 * Per-scope actor: strict serialization (K-6). One operation runs to
 * completion before the next starts — the conservative semantics both
 * adapters can honor (the DO over-delivers via input gates; we deliver
 * exactly this).
 */
export class ScopeActor {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      const task: HeldTask = { actor: this, live: true };
      try {
        return await held.run([...(held.getStore() ?? []), task], op);
      } finally {
        task.live = false;
      }
    });
    // The chain must survive failures; callers still see the rejection.
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** True when the caller is itself running inside one of this actor's tasks. */
  holds(): boolean {
    return (held.getStore() ?? []).some((t) => t.actor === this && t.live);
  }

  /**
   * A turn of this actor, re-entrant (#1666 review): from outside, an ordinary
   * `enqueue`; from INSIDE one of this actor's tasks, the op runs in that task
   * rather than queueing behind it — which would wait on itself and never return.
   * The re-entrant op is part of the enclosing task, so it shares whatever
   * transaction that task holds open: the caller's own unit, not a stranger's.
   */
  turn<T>(op: () => Promise<T> | T): Promise<T> {
    return this.holds() ? Promise.resolve().then(op) : this.enqueue(op);
  }
}
