import { DurableObject } from 'cloudflare:workers';

/**
 * The store: one SQLite-backed object per (tenant, vertical, scope, binding), as a
 * scope store is. It holds no real driver. `read` answers a payload of the asked size,
 * after the asked delay. The delay stands for the time a real driver takes to answer
 * (a cold start, a graph walk); it is the experiment's input, not a platform constant.
 */
export class StoreObject extends DurableObject {
  inFlight = 0;

  /** How many reads are waiting on their delay now. The gate probe waits for one. */
  pending() {
    return this.inFlight;
  }

  async read(input) {
    const bytes = Math.max(0, Math.min(Number(input?.bytes ?? 0), 8 * 1024 * 1024));
    const delayMs = Math.max(0, Number(input?.delayMs ?? 0));
    if (delayMs > 0) {
      this.inFlight += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } finally {
        this.inFlight -= 1;
      }
    }
    return { payload: 'x'.repeat(bytes) };
  }
}

export default {
  fetch() {
    return new Response('the store is reached only through its object', { status: 404 });
  },
};
