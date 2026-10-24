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
 *   time to read a buffered body (`text()`, `json()`, `arrayBuffer()`), which is unchanged.
 * - **A streamed body** (`ConnectorResponse.body`) is bounded by an IDLE window instead: once the
 *   body is taken as a stream the total deadline is released, and the stream errors only when the
 *   provider sends no byte for {@link STREAM_IDLE_TIMEOUT_MS}. A transfer that keeps moving keeps
 *   going; one that stalls is cut.
 *
 * Both fail with the same error, a `TimeoutError`, which `settleConnectionUse` reads as the
 * host's clock running out whichever of the two it was.
 */
import type { ByteStream } from './byte-stream.js';
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
  /** The timers both bounds run on: the runtime's by default, a test's on a clock it moves itself. */
  timers?: ExtractionTimers;
}

/** The slice of `AbortSignal` read from a caller's `init.signal`, which the kernel types as `unknown`. */
interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(type: 'abort', listener: () => void, options?: { once: boolean }): void;
}

/** The error both bounds end in. Neutral: it names neither the provider nor the URL. */
const timeoutError = (message: string): Error => new DOMException(message, 'TimeoutError');

/** The three reads that buffer the whole body; the call's total deadline covers them. */
const BUFFERED_READS = new Set<PropertyKey>(['text', 'json', 'arrayBuffer']);

/**
 * `fetchImpl`, with `timeoutMs` on the call and an idle window on a streamed body (see the
 * module header). The signal it hands the runtime is its own; a `signal` in `init` aborts it, so
 * wrapping a `fetch` that is itself wrapped (a connector's timeout around a host's) lets the outer
 * bound reach the runtime.
 */
export function deadlineFetch(fetchImpl: FetchLike, timeoutMs: number, options: DeadlineOptions = {}): FetchLike {
  const idleMs = options.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const timers = options.timers ?? RUNTIME_TIMERS;
  return async (input, init) => {
    const controller = new AbortController();
    let timedOut: Error | undefined;
    const abortWith = (err: Error): void => {
      timedOut ??= err;
      controller.abort(err);
    };
    const upstream = init?.signal as AbortSignalLike | undefined;
    if (upstream?.aborted) controller.abort(upstream.reason);
    else upstream?.addEventListener?.('abort', () => controller.abort(upstream.reason), { once: true });
    const total = timers.setTimeout(
      () => abortWith(timeoutError('The operation was aborted due to timeout')),
      timeoutMs,
    );
    // Not held against the process: `AbortSignal.timeout`'s timer was not either.
    (total as { unref?: () => void } | null)?.unref?.();
    const releaseTotal = (): void => timers.clearTimeout(total);
    let res: ConnectorResponse;
    try {
      res = await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (err) {
      releaseTotal();
      // A runtime may reject an aborted fetch with a generic abort rather than the reason.
      throw timedOut ?? err;
    }
    let guarded: ByteStream | null | undefined;
    return new Proxy(res, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'body') {
          if (!value) return value;
          if (guarded === undefined) {
            releaseTotal();
            guarded = guardIdle(value as ByteStream, idleMs, timers, (reason) => controller.abort(reason));
          }
          return guarded;
        }
        if (typeof value !== 'function') return value;
        // Called on the response itself, never the proxy: a native method refuses any other receiver.
        if (BUFFERED_READS.has(prop)) {
          return async (...args: unknown[]) => {
            try {
              return await (value as (...a: unknown[]) => unknown).apply(target, args);
            } finally {
              releaseTotal();
            }
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  };
}

/**
 * `body`, passed through chunk by chunk and errored when the provider is silent for `idleMs`.
 * Pull-driven with no queue of its own, so the window runs only while a read waits on the
 * provider. A stall (or a failure) cancels the source reader and aborts the call, which releases
 * the connection: nothing is left reading, and nothing buffered.
 */
function guardIdle(
  body: ByteStream,
  idleMs: number,
  timers: ExtractionTimers,
  abortCall: (reason: unknown) => void,
): ByteStream {
  const reader = body.getReader();
  const stop = async (err: unknown): Promise<void> => {
    abortCall(err);
    await reader.cancel(err).catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // a read the cancel has not yet settled: the lock goes with the stream
    }
  };
  return new ReadableStream(
    {
      async pull(controller) {
        let handle: unknown;
        const stalled = new Promise<never>((_, reject) => {
          handle = timers.setTimeout(
            () => reject(timeoutError(`The response body stalled: no bytes for ${idleMs} ms`)),
            idleMs,
          );
        });
        const read = reader.read();
        // If the window wins, the read settles later (cancelled): that outcome is not a second failure.
        read.catch(() => {});
        try {
          const { done, value } = await Promise.race([read, stalled]);
          if (done) {
            controller.close();
            return;
          }
          if (!value) throw new Error('the byte stream yielded a read with neither a chunk nor its end');
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
          await stop(err);
        } finally {
          timers.clearTimeout(handle);
        }
      },
      cancel: (reason) => stop(reason),
    },
    { highWaterMark: 0 },
  );
}
