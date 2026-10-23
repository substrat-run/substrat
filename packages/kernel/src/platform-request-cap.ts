/**
 * The refusal behind `MAX_PENDING_PLATFORM_REQUESTS` (#2506), written once for both adapters.
 *
 * `ctx.requestPlatform` refuses once a scope already holds the cap's worth of `pending` intents.
 * That refusal used to be a bare `Error` at each adapter, which left a caller no way to tell
 * "the queue is full, wait for the drain" from a fault in its own work. The purge pass is that
 * caller: a batch can hold more entities than the queue has room for, and the ones that hit the
 * cap are not failures — they are due again once the drain has run (`runPurgePass`).
 *
 * The class changes nothing a caller could see on the wire: it is still an `Error` named `Error`
 * with the message it always had, so a `catch` written against the old shape keeps matching.
 */
import { MAX_PENDING_PLATFORM_REQUESTS } from '@substrat-run/contracts';

/** `ctx.requestPlatform` found the scope's queue full: `pending` intents already wait for the drain. */
export class PlatformRequestBackpressureError extends Error {
  constructor(readonly pending: number) {
    super(`too many pending platform requests (${pending}); retry once some have drained`);
  }
}

/** Refuse a `ctx.requestPlatform` the scope has no room for, given how many intents it holds `pending`. */
export function assertPlatformRequestRoom(pending: number): void {
  if (pending >= MAX_PENDING_PLATFORM_REQUESTS) throw new PlatformRequestBackpressureError(pending);
}
