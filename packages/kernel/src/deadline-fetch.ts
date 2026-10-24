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

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;
declare const AbortController: new () => { readonly signal: unknown; abort(reason?: unknown): void };
declare const DOMException: new (message: string, name: string) => Error;
declare const ReadableStream: new (
  source: {
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
    const onUpstreamAbort = (): void => controller.abort(upstream?.reason);
    if (upstream?.aborted) controller.abort(upstream.reason);
    else upstream?.addEventListener?.('abort', onUpstreamAbort, { once: true });
    const total = timers.setTimeout(() => {
      timedOut ??= timeoutError('The operation was aborted due to timeout');
      controller.abort(timedOut);
    }, timeoutMs);
    // Not held against the process: `AbortSignal.timeout`'s timer was not either.
    (total as { unref?: () => void } | null)?.unref?.();
    const releaseTotal = (): void => timers.clearTimeout(total);
    /** The call is over: its deadline and its hold on the caller's signal go. Idempotent. */
    const finish = (): void => {
      releaseTotal();
      upstream?.removeEventListener?.('abort', onUpstreamAbort);
    };
    let res: ConnectorResponse;
    try {
      res = await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (err) {
      finish();
      // A runtime may reject an aborted fetch with a generic abort rather than the reason.
      throw timedOut ?? err;
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
          });
          return guarded;
        }
        if (typeof value !== 'function') return value;
        // Called on the response itself, never the proxy: a native method refuses any other receiver.
        if (BUFFERED_READS.has(prop)) {
          return async (...args: unknown[]) => {
            try {
              return await (value as (...a: unknown[]) => unknown).apply(target, args);
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
}

/**
 * `body`, passed through chunk by chunk. The native reader is taken on the FIRST pull, not here,
 * so a stream that is only looked at, or taken and never read, leaves the native body unlocked
 * and the call's deadline in force. From the first read: the stream errors when the provider is
 * silent for `idleMs` (empty chunks are not bytes and do not reset the window) or when `maxStreamMs`
 * has passed in all. Pull-driven with no queue of its own, so the idle window runs only while a
 * read waits on the provider. Whichever bound ends it cancels the source reader and aborts the
 * call, which releases the connection: nothing is left reading, and nothing buffered.
 */
function guardedBody(body: ByteStream, o: GuardOptions): ByteStream {
  let reader: ByteStreamReader | undefined;
  let capHandle: unknown;
  /** Set once a bound or a failure has ended the stream; a later pull answers it. */
  let ended: unknown;
  let over = false;
  const stop = async (err: unknown): Promise<void> => {
    if (over) return;
    over = true;
    ended = err;
    o.timers.clearTimeout(capHandle);
    o.abortCall(err);
    o.finish();
    await reader?.cancel(err).catch(() => {});
    try {
      reader?.releaseLock();
    } catch {
      // a read the cancel has not yet settled: the lock goes with the stream
    }
  };
  let expired: Promise<never> | undefined;
  const begin = (): ByteStreamReader => {
    // The first read: the call's deadline hands over to the idle window and the absolute cap.
    o.releaseTotal();
    expired = new Promise<never>((_, reject) => {
      capHandle = o.timers.setTimeout(() => {
        const err = timeoutError('The transfer exceeded its maximum duration');
        // Rejects a read that is waiting; with none waiting, the stop alone ends an abandoned stream.
        reject(err);
        void stop(err);
      }, o.maxStreamMs);
    });
    expired.catch(() => {});
    return body.getReader();
  };
  return new ReadableStream(
    {
      async pull(controller) {
        if (over) {
          controller.error(ended);
          return;
        }
        reader ??= begin();
        let handle: unknown;
        const stalled = new Promise<never>((_, reject) => {
          handle = o.timers.setTimeout(
            () => reject(timeoutError(`The response body stalled: no bytes for ${o.idleMs} ms`)),
            o.idleMs,
          );
        });
        try {
          for (;;) {
            const read = reader.read();
            // If a bound wins, the read settles later (cancelled): that is not a second failure.
            read.catch(() => {});
            const { done, value } = await Promise.race([read, stalled, expired!]);
            if (done) {
              over = true;
              o.timers.clearTimeout(capHandle);
              o.finish();
              controller.close();
              return;
            }
            if (!value) throw new Error('the byte stream yielded a read with neither a chunk nor its end');
            // An empty chunk carries nothing: it is read past under the same window, not counted as progress.
            if (value.byteLength === 0) continue;
            controller.enqueue(value);
            return;
          }
        } catch (err) {
          controller.error(err);
          await stop(err);
        } finally {
          o.timers.clearTimeout(handle);
        }
      },
      cancel: (reason) => stop(reason),
    },
    { highWaterMark: 0 },
  );
}
