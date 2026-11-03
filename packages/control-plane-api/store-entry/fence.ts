/**
 * The fence a store object keeps against what a deletion path leaves in flight (D-70). Both entries
 * run this: the TypeScript entry imports it, and the Python entry reaches it through the verifier
 * module, so there is one rule and one place it can be wrong.
 *
 * Unbinding a scope's hostnames stops new requests, and only that. A call already past the router, or
 * one signed a moment ago and still on its way, arrives whenever it arrives, and its envelope stays
 * fresh for a minute. A write landing after the wipe would recreate the object, with nothing left to
 * reach it. So the object itself holds the answer, as the scope object does (`_substrat_reaped`): the
 * check is made where the write would land, after the signature, whenever the call was signed, by
 * any router of any age, in front of any driver.
 *
 * `close` is the first step of `substrat.fence`: the mark goes down, durably, and the calls already
 * inside the driver are waited out, until each one's `fetch` has returned. The driver's wipe runs next
 * and may `deleteAll()`, so the mark is written again after it (`reassert`, in the entry's `finally`).
 *
 * A driver's work after its `fetch` returned is not waited for: `ctx.waitUntil`, a task nobody awaits, a
 * body still streaming. The entry cannot see any of it, so it could write after the wipe. A driver does
 * all its writing before it answers. That is a rule of the contract, held by the review of a release
 * (D-70, D-63).
 * A crash between the two loses the mark with the wipe's answer: the platform asks again
 * and the whole sequence runs again, wiping whatever landed in the gap.
 *
 * Who it stops: a `caller` call of any kind, and a platform call that would write (`stage-page`,
 * `commit-stage`), since a fenced object belongs to a scope on its way out. That is what closes the
 * restore that commits between a reap's wipe and its status flip. The platform's reads, an erase, a
 * discard and a wipe still go through; none of them can put a row back. An alarm is the driver's own
 * timer and could write too, so it stops as well.
 *
 * What it does not stop: a driver that reaches for the key itself. The driver runs with this
 * object's `ctx`, as `entry.ts` says, so it can delete the mark. Keeping it out of reach would need
 * the check outside the driver's script (#2830). A mark deleted by accident holds until the instance
 * is evicted, since `leave` writes it back after every platform call on a fenced object.
 */
import {
  STORE_FENCE_DRAINING_CODE,
  STORE_FENCE_OPERATION,
  STORE_FENCED_CODE,
  type ScopeStoreEnvelope,
} from '@substrat-run/contracts/scope-store-envelope';
import { STORE_FENCE_KEY } from './names.js';
import type { StoreCallRefusal } from './verify.js';

/** How long a fence waits for the calls inside the object, ms. Under the platform's 60 s deadline on one call. */
const STORE_FENCE_DRAIN_MS = 30_000;

/** The platform operations a fenced object refuses: the two that write. */
const WRITES = new Set(['substrat.stage-page', 'substrat.commit-stage']);

const FENCED: StoreCallRefusal = {
  ok: false,
  status: 410,
  message: JSON.stringify({
    error: { code: STORE_FENCED_CODE, status: 410, body: { message: 'the scope this store belongs to is being deleted' } },
  }),
  contentType: 'application/json',
};

const DRAINING: StoreCallRefusal = {
  ok: false,
  status: 503,
  message: JSON.stringify({ error: { code: STORE_FENCE_DRAINING_CODE, status: 503 } }),
  contentType: 'application/json',
};

const PASSED = { ok: true } as const;

/** The part of a Durable Object's storage the fence uses. */
export interface FenceStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export class StoreObjectFence {
  readonly #storage: FenceStorage;
  readonly #drainMs: number;
  /** One instance per object, and every write of the mark goes through it, so once read this is the truth. */
  #fenced: boolean | undefined;
  #inside = 0;
  readonly #waiting = new Set<() => void>();

  constructor(storage: FenceStorage, drainMs: number) {
    this.#storage = storage;
    this.#drainMs = drainMs;
  }

  async #load(): Promise<void> {
    if (this.#fenced !== undefined) return;
    const stored = await this.#storage.get(STORE_FENCE_KEY);
    // A `close` may have run while the read was out, and it wins.
    this.#fenced = this.#fenced === true || stored !== undefined;
  }

  /**
   * Whether a call may go to the driver. Admitted, it counts as inside until `leave`. Nothing awaits
   * between the check and the count, or a `close` could find the object empty with this call on its way in.
   */
  async admit(envelope: Pick<ScopeStoreEnvelope, 'aud' | 'op'>): Promise<typeof PASSED | StoreCallRefusal> {
    await this.#load();
    if (this.#fenced === true && (envelope.aud !== 'platform' || WRITES.has(envelope.op))) return FENCED;
    this.#inside += 1;
    return PASSED;
  }

  /** Whether the driver's alarm may run: never on a fenced object. Admitted, it counts as inside until `leave`. */
  async admitAlarm(): Promise<boolean> {
    await this.#load();
    if (this.#fenced === true) return false;
    this.#inside += 1;
    return true;
  }

  /** An admitted call is done. On a fenced object the mark is written again, whatever that call's driver did. */
  async leave(): Promise<void> {
    this.#inside -= 1;
    if (this.#inside === 0) {
      for (const drained of this.#waiting) drained();
      this.#waiting.clear();
    }
    if (this.#fenced === true) await this.reassert();
  }

  /** Mark the object, durably, then wait out what is inside it. Past the wait it answers 503, and the mark stays. */
  async close(): Promise<typeof PASSED | StoreCallRefusal> {
    this.#fenced = true;
    await this.reassert();
    return (await this.#drained()) ? PASSED : DRAINING;
  }

  /** Write the mark, after a step that may have taken it with everything else. */
  async reassert(): Promise<void> {
    await this.#storage.put(STORE_FENCE_KEY, true);
  }

  #drained(): Promise<boolean> {
    if (this.#inside === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const drained = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#waiting.delete(drained);
        resolve(false);
      }, this.#drainMs);
      this.#waiting.add(drained);
    });
  }
}

/** One fence per object instance. A function, so the Python entry need not construct a JavaScript class. */
export function storeObjectFence(storage: FenceStorage, drainMs: number = STORE_FENCE_DRAIN_MS): StoreObjectFence {
  return new StoreObjectFence(storage, drainMs);
}

/** The body a driver gets for a fence: the signed call, as the `substrat.wipe` it answers. */
export function storeFenceWipeBody(body: ArrayBuffer): ArrayBuffer {
  const call = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  return new TextEncoder().encode(JSON.stringify({ ...call, operation: 'substrat.wipe' })).buffer as ArrayBuffer;
}

/**
 * A verified call, through the fence, to the driver. `forward` hands a body to the driver. The Python
 * entry runs the same steps in its own `fetch`, since a coroutine does not cross as a callback here.
 */
export async function callThroughFence<R>(
  fence: StoreObjectFence,
  call: { readonly envelope: Pick<ScopeStoreEnvelope, 'aud' | 'op'>; readonly body: ArrayBuffer },
  forward: (body: ArrayBuffer) => Promise<R>,
): Promise<R | StoreCallRefusal> {
  if (call.envelope.op === STORE_FENCE_OPERATION) {
    const closed = await fence.close();
    if (!closed.ok) return closed;
    try {
      return await forward(storeFenceWipeBody(call.body));
    } finally {
      await fence.reassert();
    }
  }
  const admitted = await fence.admit(call.envelope);
  if (!admitted.ok) return admitted;
  try {
    return await forward(call.body);
  } finally {
    await fence.leave();
  }
}
