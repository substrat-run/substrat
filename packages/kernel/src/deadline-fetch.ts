/**
 * A connector call's time bounds (#2518).
 *
 * A connection's `fetch` used to hand the runtime one `AbortSignal.timeout(timeoutMs)`, which
 * bounds the whole exchange: the headers, and a streamed response body (#2498) still being read.
 * A provider file therefore had to arrive in full within `timeoutMs`, however fast its bytes were
 * flowing, and a large file on a slow link could never land. {@link deadlineFetch} splits the
 * two:
 *
 * - **The call** is bounded by `timeoutMs`, as before: the time to the response headers, and the
 *   time to read a buffered body (`text()`, `json()`, `arrayBuffer()`), which is unchanged. It
 *   stays armed until the body is actually READ as a stream: looking at `body`, or taking it and
 *   never reading, releases nothing, so a body nobody reads is still cut at `timeoutMs`.
 * - **A streamed body** (`ConnectorResponse.body`) is, from its first read, bounded by an IDLE
 *   window instead: it errors when the provider sends no byte for {@link STREAM_IDLE_TIMEOUT_MS}
 *   (an empty chunk is not a byte). A transfer that keeps moving keeps going; one that stalls is
 *   cut. And by an absolute cap, {@link STREAM_MAX_DURATION_MS}, so even a steady trickle, or a
 *   stream abandoned between reads, ends.
 *
 * All of them fail with a `TimeoutError`, which `settleConnectionUse` reads as the host's clock
 * running out whichever bound it was.
 */
import type { ByteStream, ByteStreamReader } from './byte-stream.js';
import type { ExtractionTimers } from './attachment-extractor.js';
import type { ConnectorResponse, FetchLike } from './scope-host.js';

/**
 * How long a streamed response body may go without a byte before it errors. 30 s, the default
 * `timeoutMs` of a connector call: a provider that has been silent for as long as a whole call
 * may take has stalled, and a slower link than that is still delivering within it. The window
 * runs only while the stream waits on the provider: a consumer that is slow to take the next
 * chunk (a store writing the last one) does not spend it.
 */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * The most a streamed body may take from its first read to its end, however steadily it flows:
 * 10 minutes. Finite because a hosted run lives under the platform's wall limits and a trickle
 * that never stops would otherwise hold a connection (and a run) for ever; generous because the
 * idle window, not this, is what cuts a stalled transfer. At the 10 minutes a steady 1 MB/s
 * link still moves about 600 MB.
 */
export const STREAM_MAX_DURATION_MS = 10 * 60_000;

/**
 * How many empty chunks in a row a stream may deliver before it is treated as making no progress.
 * Generous: a real source sends a few at most. It is a count, not a time, because a source that
 * answers only with empty chunks answers in microtasks and no timer would ever get to run.
 */
const MAX_CONSECUTIVE_EMPTY_READS = 1_000;

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;
declare const AbortController: new () => { readonly signal: unknown; abort(reason?: unknown): void };
declare const DOMException: new (message: string, name: string) => Error;
declare const ReadableStream: new (
  source: {
    start(controller: { error(reason: unknown): void }): void;
    pull(controller: { enqueue(chunk: Uint8Array): void; close(): void; error(reason: unknown): void }): Promise<void>;
    cancel(reason?: unknown): Promise<void>;
  },
  strategy?: { highWaterMark?: number },
) => ByteStream;

/** The runtime's timers, called bare — workerd throws `Illegal invocation` on `obj.setTimeout(…)`. */
const RUNTIME_TIMERS: ExtractionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface DeadlineOptions {
  /** The idle window of a streamed body. Default {@link STREAM_IDLE_TIMEOUT_MS}. */
  idleMs?: number;
  /** The absolute cap on a streamed body's duration. Default {@link STREAM_MAX_DURATION_MS}. */
  maxStreamMs?: number;
  /** The timers every bound runs on: the runtime's by default, a test's on a clock it moves itself. */
  timers?: ExtractionTimers;
}

/** The slice of `AbortSignal` read from a caller's `init.signal`, which the kernel types as `unknown`. */
interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(type: 'abort', listener: () => void, options?: { once: boolean }): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

/** The error every bound ends in. Neutral: it names neither the provider nor the URL. */
const timeoutError = (message: string): Error => new DOMException(message, 'TimeoutError');

/** The three reads that buffer the whole body; the call's total deadline covers them. */
const BUFFERED_READS = new Set<PropertyKey>(['text', 'json', 'arrayBuffer']);

/**
 * `fetchImpl`, with `timeoutMs` on the call and an idle window plus an absolute cap on a streamed
 * body (see the module header). The signal it hands the runtime is its own; a `signal` in `init`
 * aborts it, so wrapping a `fetch` that is itself wrapped (a connector's timeout around a host's)
 * lets the outer bound reach the runtime.
 */
export function deadlineFetch(fetchImpl: FetchLike, timeoutMs: number, options: DeadlineOptions = {}): FetchLike {
  const idleMs = options.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const maxStreamMs = options.maxStreamMs ?? STREAM_MAX_DURATION_MS;
  const timers = options.timers ?? RUNTIME_TIMERS;
  return async (input, init) => {
    const controller = new AbortController();
    let timedOut: Error | undefined;
    const upstream = init?.signal as AbortSignalLike | undefined;
    // The caller's own abort ends the call: its deadline is released, so it cannot fire later and
    // pass a cancel off as a timeout.
    const onUpstreamAbort = (): void => {
      releaseTotal();
      controller.abort(upstream?.reason);
    };
    if (upstream?.aborted) controller.abort(upstream.reason);
    else upstream?.addEventListener?.('abort', onUpstreamAbort, { once: true });
    const total = timers.setTimeout(() => {
      timedOut ??= timeoutError('The operation was aborted due to timeout');
      controller.abort(timedOut);
      finish();
    }, timeoutMs);
    // Not held against the process: `AbortSignal.timeout`'s timer was not either.
    unref(total);
    const releaseTotal = (): void => timers.clearTimeout(total);
    /** The call is over: its deadline and its hold on the caller's signal go. Idempotent. */
    function finish(): void {
      releaseTotal();
      upstream?.removeEventListener?.('abort', onUpstreamAbort);
    }
    /**
     * What a failed read reports. A runtime may fail a read the call's deadline aborted with a
     * generic abort rather than the reason; that one is the deadline's `TimeoutError`. Any other
     * failure (a caller's cancel, a network error) keeps its own class.
     */
    const reported = (err: unknown): unknown =>
      timedOut && (err as { name?: unknown } | null)?.name === 'AbortError' ? timedOut : err;
    let res: ConnectorResponse;
    try {
      res = await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (err) {
      finish();
      throw reported(err);
    }
    // A response that has no body at all (`null`, as on a web `Response`) has nothing to bound.
    // A stand-in with no `body` field (`undefined`) may still be read buffered, so it keeps the deadline.
    if (res.body === null) finish();
    let guarded: ByteStream | undefined;
    return new Proxy(res, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'body') {
          if (!value) return value;
          // Looking at the body takes nothing: the native stream stays unlocked and the call's
          // deadline stays armed until the first read of the stream handed out here.
          guarded ??= guardedBody(value as ByteStream, {
            idleMs,
            maxStreamMs,
            timers,
            releaseTotal,
            finish,
            abortCall: (reason) => controller.abort(reason),
            reported,
          });
          return guarded;
        }
        if (typeof value !== 'function') return value;
        // Called on the response itself, never the proxy: a native method refuses any other receiver.
        if (BUFFERED_READS.has(prop)) {
          return async (...args: unknown[]) => {
            try {
              return await (value as (...a: unknown[]) => unknown).apply(target, args);
            } catch (err) {
              // A runtime may fail a read the call's deadline aborted with a generic abort.
              throw reported(err);
            } finally {
              finish();
            }
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  };
}

interface GuardOptions {
  idleMs: number;
  maxStreamMs: number;
  timers: ExtractionTimers;
  /** The call's deadline, released by the first read: the idle window and the cap take over. */
  releaseTotal(): void;
  /** The stream is over (end, error, cancel): the call's last hold goes. */
  finish(): void;
  abortCall(reason: unknown): void;
  /** What a failed read reports: the call's deadline's error for a runtime's generic abort, else the failure itself. */
  reported(err: unknown): unknown;
}

/** A timer that does not hold a Node process open, where the runtime lets it say so. */
function unref(handle: unknown): void {
  (handle as { unref?: () => void } | null)?.unref?.();
}

/**
 * `body`, passed through chunk by chunk. The native reader is taken on the FIRST pull, not here,
 * so a stream that is only looked at, or taken and never read, leaves the native body unlocked
 * and the call's deadline in force. From the first read: the stream errors when the provider is
 * silent for `idleMs` (empty chunks are not bytes and do not reset the window) or when `maxStreamMs`
 * has passed in all. Pull-driven with no queue of its own, so the idle window runs only while a
 * read waits on the provider. Whichever bound ends it cancels the source reader, aborts the call
 * (which releases the connection) and errors the stream: nothing is left reading, nothing buffered.
 *
 * The bounds are TIMERS that end the stream, never promises raced against each read: a promise
 * that outlives a read keeps a reaction for every race it was in, and through it the chunk the
 * race resolved with. Nothing long-lived here holds a chunk once it has been delivered.
 */
function guardedBody(body: ByteStream, o: GuardOptions): ByteStream {
  let reader: ByteStreamReader | undefined;
  let ctl: { error(reason: unknown): void } | undefined;
  let capHandle: unknown;
  let over = false;
  /** End the stream with `err`, once: error it, let go of the call, cancel the source. */
  const stop = async (err: unknown): Promise<void> => {
    if (over) return;
    over = true;
    o.timers.clearTimeout(capHandle);
    try {
      ctl?.error(err);
    } catch {
      // already closed or errored
    }
    o.abortCall(err);
    o.finish();
    await reader?.cancel(err).catch(() => {});
    try {
      reader?.releaseLock();
    } catch {
      // a read the cancel has not yet settled: the lock goes with the stream
    }
  };
  /** The first read: the call's deadline hands over to the idle window and the absolute cap. */
  const begin = (): ByteStreamReader => {
    o.releaseTotal();
    capHandle = o.timers.setTimeout(
      () => void stop(timeoutError('The transfer exceeded its maximum duration')),
      o.maxStreamMs,
    );
    unref(capHandle);
    return body.getReader();
  };
  return new ReadableStream(
    {
      start(controller) {
        ctl = controller;
      },
      async pull(controller) {
        if (over) return;
        let idle: unknown;
        let empties = 0;
        try {
          reader ??= begin();
          idle = o.timers.setTimeout(
            () => void stop(timeoutError(`The response body stalled: no bytes for ${o.idleMs} ms`)),
            o.idleMs,
          );
          unref(idle);
          for (;;) {
            const { done, value } = await reader.read();
            // A bound (or the consumer) ended the stream while this read waited: it has answered.
            if (over) return;
            if (done) {
              over = true;
              o.timers.clearTimeout(capHandle);
              o.finish();
              controller.close();
              return;
            }
            if (!value) throw new Error('the byte stream yielded a read with neither a chunk nor its end');
            // An empty chunk carries nothing: it is read past under the same window, not counted as progress.
            // A source that answers only with empty chunks, all in microtasks, would never let a timer
            // run, so the run of them is itself bounded.
            if (value.byteLength === 0) {
              if (++empties > MAX_CONSECUTIVE_EMPTY_READS) {
                throw timeoutError('The response body made no progress');
              }
              continue;
            }
            controller.enqueue(value);
            return;
          }
        } catch (err) {
          // A runtime may end a read the call's deadline aborted with a generic abort.
          await stop(o.reported(err));
        } finally {
          o.timers.clearTimeout(idle);
        }
      },
      cancel: (reason) => stop(reason),
    },
    { highWaterMark: 0 },
  );
}
