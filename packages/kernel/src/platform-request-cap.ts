/**
 * The refusal behind `MAX_PENDING_PLATFORM_REQUESTS` (#2506), written once for the adapters.
 *
 * `ctx.requestPlatform` refuses once a scope already holds the cap's worth of `pending` intents.
 * The refusal used to be an `Error` like any other, which left a caller no way to tell "the queue
 * is full, wait for the drain" from a fault in its own work. The purge pass is that caller: a batch
 * can hold more entities than the queue has room for, and a purge that meets the cap after the
 * pass has already got past its head is not a failure — it is due again on the next pass — and
 * nor is one at the head when the tick's earlier purge passes filled the queue (#2517); see
 * `runPurgePass` for both.
 *
 * It is still a plain `Error`, with the message it always had, and nothing about it is visible on
 * the wire. What marks it is membership of a set only this module can add to: not a class or a
 * property, so module code cannot forge one, and nothing here is public surface beyond the assert
 * itself. It can replay one: a purge may rethrow a genuine refusal it caught from
 * `ctx.requestPlatform`, even one kept from an earlier call. Past the head, that defers the
 * module's own purge for one pass (the entity is the head of the next pass). At the head, it is
 * deferred only while a purge pass ahead of it in the same tick committed requests, which is the
 * same bound a genuine refusal there has (`runPurgePass`): the purges ahead keep their progress,
 * and the head runs on the first tick they enqueue nothing. Either way a replay delays only the
 * replaying module's own purge: a deferred pass enqueues nothing, so it defers no pass behind it,
 * and nothing else reads the refusal. So it is not guarded against.
 */
import { MAX_PENDING_PLATFORM_REQUESTS } from '@substrat-run/contracts';

const refusals = new WeakSet<object>();

/**
 * Refuse a request for a platform intent the scope has no room for, given how many it holds
 * `pending`. `retry` finishes the message; the module-facing `ctx.requestPlatform` keeps the
 * default, and the executor's routing says what its delivery will do instead.
 */
export function assertPlatformRequestRoom(pending: number, retry = 'retry once some have drained'): void {
  if (pending < MAX_PENDING_PLATFORM_REQUESTS) return;
  const refusal = new Error(`too many pending platform requests (${pending}); ${retry}`);
  refusals.add(refusal);
  throw refusal;
}

/** Whether `err` is a refusal `assertPlatformRequestRoom` threw, as opposed to any error that merely reads like one. */
export function isPlatformRequestRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && refusals.has(err);
}
