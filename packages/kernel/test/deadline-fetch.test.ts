import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_MAX_DURATION_MS,
  deadlineFetch,
  globalFetch,
  settleConnectionUse,
  type ByteStream,
  type ConnectorResponse,
  type FetchLike,
} from '../src/index.js';

/**
 * A connector call's bounds (#2518): `timeoutMs` over the call up to the headers and any buffered
 * read, and an IDLE window over a streamed body. Most cases run on a clock the test moves itself,
 * so the boundary is exact (49 ms of silence passes, 50 ms does not) and no case waits on a real
 * timer; the last block drives a real `fetch` against a real server, where the timers are the
 * runtime's own.
 */

/** Timers on a clock `advance` moves; a due timer fires in order of when it is due. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number): unknown {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(handle: unknown): void {
        pending.delete(handle as number);
      },
    },
    get pending() {
      return pending.size;
    },
    /** Move the clock, firing each due timer and letting its consequences settle before the next. */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/** Let promise continuations and stream plumbing run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const CHUNK = new Uint8Array([1, 2, 3, 4]);
const IDLE = 50;
const TOTAL = 100;

/**
 * A provider whose body the test feeds by hand. The response is a real web `Response` over a
 * stream, so the guard is exercised on the runtime's own types; `cancelled` and `signal` show
 * what the call let go of.
 */
function provider() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const seen: { signal?: AbortSignal; cancelled?: unknown } = {};
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      seen.cancelled = reason ?? 'cancelled';
    },
  });
  const fetch: FetchLike = async (_input, init) => {
    seen.signal = init?.signal as AbortSignal;
    return new Response(body) as unknown as ConnectorResponse;
  };
  return { fetch, seen, send: (chunk = CHUNK) => {
      try {
        controller.enqueue(chunk);
      } catch {
        // the call let go of the stream: a provider writing to it afterwards is not heard
      }
    },
    end: () => controller.close() };
}

const bodyOf = (res: ConnectorResponse): ByteStream => res.body as ByteStream;

describe('a streamed body is bounded by idleness', () => {
  it('a slow-but-steady body completes though the transfer outlasts timeoutMs', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const reader = bodyOf(res).getReader();
    let received = 0;
    // Ten chunks, 40 ms apart: 400 ms in all, four times the call's timeout, never 50 ms of silence.
    for (let i = 0; i < 10; i++) {
      const read = reader.read();
      await settle(); // the window is running before the silence starts
      await clock.advance(40);
      p.send();
      const { done, value } = await read;
      expect(done).toBe(false);
      received += value!.byteLength;
    }
    const last = reader.read();
    p.end();
    expect((await last).done).toBe(true);
    expect(received).toBe(40);
    expect(p.seen.signal?.aborted).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('a stalled body errors with a TimeoutError, cancels its source and aborts the call', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const reader = bodyOf(res).getReader();
    const first = reader.read();
    p.send();
    expect((await first).done).toBe(false);

    const stalled = reader.read();
    const outcome = stalled.then(
      () => undefined,
      (err: unknown) => err,
    );
    await settle(); // the read has reached the provider, and the window is running
    await clock.advance(IDLE);
    const err = (await outcome) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TimeoutError');
    // Neutral: it names the window, never the provider, the URL or the connection.
    expect(err.message).toBe(`The response body stalled: no bytes for ${IDLE} ms`);
    // The connection is released and nothing is left reading it.
    expect(p.seen.cancelled).toBe(err);
    expect(p.seen.signal?.aborted).toBe(true);
    expect(p.seen.signal?.reason).toBe(err);
    expect(clock.pending).toBe(0);
    // A later read answers the same error rather than a hang or a clean end.
    await expect(reader.read()).rejects.toBe(err);
  });

  it('holds exactly at the window: 49 ms of silence passes, 50 ms does not', async () => {
    for (const [silence, fails] of [
      [IDLE - 1, false],
      [IDLE, true],
    ] as const) {
      const clock = manualTimers();
      const p = provider();
      const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
      const read = bodyOf(res).getReader().read();
      const outcome = read.then(
        (r) => r,
        (err: unknown) => err,
      );
      await settle();
      await clock.advance(silence);
      if (!fails) p.send();
      const settled = await outcome;
      if (fails) expect((settled as Error).name).toBe('TimeoutError');
      else expect((settled as { done: boolean }).done).toBe(false);
    }
  });

  it('does not spend the window on a consumer that is slow to take the next chunk', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const reader = bodyOf(res).getReader();
    const first = reader.read();
    p.send();
    await first;
    // The store is writing the last chunk: no read is outstanding, so nothing is waiting on the provider.
    await clock.advance(IDLE * 20);
    const next = reader.read();
    p.send();
    expect((await next).done).toBe(false);
  });

  it('a consumer that cancels releases the source and the call', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const reader = bodyOf(res).getReader();
    const read = reader.read();
    p.send();
    await read;
    await reader.cancel('upload refused');
    expect(p.seen.cancelled).toBe('upload refused');
    expect(p.seen.signal?.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('taking the body releases the call deadline: a body is not cut at timeoutMs', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    expect(clock.pending).toBe(1); // the call's deadline, until the body is taken
    const reader = bodyOf(res).getReader();
    const read = reader.read();
    await settle();
    await clock.advance(IDLE - 1);
    p.send();
    await read;
    expect(p.seen.signal?.aborted).toBe(false);
    // Past timeoutMs: the deadline that would have cut the transfer is gone.
    await clock.advance(TOTAL * 3);
    expect(p.seen.signal?.aborted).toBe(false);
  });

  it('the default window is the 30 s a call is given', () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('the call and a buffered read keep timeoutMs', () => {
  /** A fetch whose headers arrive when the test says, and whose text() waits on its own signal. */
  function slowBuffered(opts: { headersAfter: () => Promise<void> }) {
    const seen: { signal?: AbortSignal } = {};
    const fetch: FetchLike = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      seen.signal = signal;
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      await Promise.race([opts.headersAfter(), aborted]);
      return {
        ok: true,
        status: 200,
        text: () => Promise.race([new Promise<string>(() => {}), aborted]),
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.race([new Promise<ArrayBuffer>(() => {}), aborted]),
      };
    };
    return { fetch, seen };
  }

  it('a call whose headers never arrive errors at timeoutMs with a TimeoutError', async () => {
    const clock = manualTimers();
    const p = slowBuffered({ headersAfter: () => new Promise(() => {}) });
    const outcome = deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/x').then(
      () => undefined,
      (err: unknown) => err,
    );
    await clock.advance(TOTAL - 1);
    expect(p.seen.signal?.aborted).toBe(false);
    await clock.advance(1);
    const err = (await outcome) as Error;
    expect(err.name).toBe('TimeoutError');
    expect(p.seen.signal?.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('a buffered read of a body that trickles is still cut at timeoutMs', async () => {
    const clock = manualTimers();
    const p = slowBuffered({ headersAfter: () => Promise.resolve() });
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/x');
    const outcome = res.arrayBuffer().then(
      () => undefined,
      (err: unknown) => err,
    );
    // Well past the idle window: a buffered read is judged by the call's deadline, not by idleness.
    await clock.advance(TOTAL - 1);
    expect(p.seen.signal?.aborted).toBe(false);
    await clock.advance(1);
    expect(((await outcome) as Error).name).toBe('TimeoutError');
  });

  it('a buffered read that finishes in time releases the deadline', async () => {
    const clock = manualTimers();
    const fetch: FetchLike = async () => new Response(JSON.stringify({ ok: true })) as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x');
    expect(clock.pending).toBe(1);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(clock.pending).toBe(0);
  });

  it('a fetch that rejects releases the deadline and rethrows its own error', async () => {
    const clock = manualTimers();
    const boom = new Error('connection refused');
    const fetch: FetchLike = async () => {
      throw boom;
    };
    await expect(deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x')).rejects.toBe(boom);
    expect(clock.pending).toBe(0);
  });

  it('a response with no body stays a response with no body', async () => {
    const clock = manualTimers();
    const fetch: FetchLike = async () => ({ ok: true, status: 204, text: async () => '', json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) });
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x');
    expect(res.body).toBeUndefined();
    const web = await deadlineFetch(async () => new Response(null, { status: 204 }) as unknown as ConnectorResponse, TOTAL, {
      timers: clock.timers,
    })('https://provider.example/x');
    expect(web.body).toBeNull();
  });

  it('a signal in init aborts the call, so a wrapper around a wrapper is bounded by the outer one', async () => {
    const clock = manualTimers();
    const p = slowBuffered({ headersAfter: () => new Promise(() => {}) });
    // The outer bound is the shorter; it must reach the runtime through the inner wrapper.
    const inner = deadlineFetch(p.fetch, TOTAL * 10, { timers: clock.timers });
    const outer = deadlineFetch(inner, TOTAL, { timers: clock.timers });
    const outcome = outer('https://provider.example/x').then(
      () => undefined,
      (err: unknown) => err,
    );
    await clock.advance(TOTAL);
    expect(((await outcome) as Error).name).toBe('TimeoutError');
    expect(p.seen.signal?.aborted).toBe(true);
  });

  it('both bounds end in the error the health line already reads as a timeout', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const read = bodyOf(res).getReader().read();
    const outcome = read.then(
      () => undefined,
      (err: unknown) => err,
    );
    await settle();
    await clock.advance(IDLE);
    const settled = settleConnectionUse('scrive', 1, { error: await outcome });
    expect(settled.timedOut).toBe(true);
  });
});

describe('a body that is looked at, abandoned or padded (#2518 review)', () => {
  const MAX = 200;

  it('taking the body and never reading it is still cut at timeoutMs, and leaves the native body unlocked', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    expect(res.body).toBeTruthy();
    await clock.advance(TOTAL - 1);
    expect(p.seen.signal?.aborted).toBe(false);
    await clock.advance(1);
    expect(p.seen.signal?.aborted).toBe(true);
    expect((p.seen.signal?.reason as Error).name).toBe('TimeoutError');
  });

  it('a truthiness check on the body leaves it readable: res.text() still works', async () => {
    const clock = manualTimers();
    const fetch: FetchLike = async () => new Response('hello') as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x');
    if (!res.body) throw new Error('expected a body');
    expect(await res.text()).toBe('hello');
    expect(clock.pending).toBe(0);
  });

  it('a response with a null body releases the call deadline at once', async () => {
    const clock = manualTimers();
    const fetch: FetchLike = async () => new Response(null, { status: 204 }) as unknown as ConnectorResponse;
    await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x');
    expect(clock.pending).toBe(0);
  });

  it('empty chunks are not progress: they do not extend the idle window', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const read = bodyOf(res).getReader().read();
    const outcome = read.then(
      (r) => r,
      (err: unknown) => err,
    );
    await settle();
    await clock.advance(IDLE - 10);
    p.send(new Uint8Array(0));
    await settle();
    await clock.advance(10);
    expect(((await outcome) as Error).name).toBe('TimeoutError');
  });

  it('a non-empty chunk after empty ones is still delivered', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    const read = bodyOf(res).getReader().read();
    p.send(new Uint8Array(0));
    p.send(new Uint8Array(0));
    p.send();
    const { done, value } = await read;
    expect(done).toBe(false);
    expect(value?.byteLength).toBe(CHUNK.byteLength);
  });

  it('an absolute cap ends a steady trickle that never goes idle', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, maxStreamMs: MAX, timers: clock.timers })(
      'https://provider.example/file',
    );
    const reader = bodyOf(res).getReader();
    let failure: Error | undefined;
    for (let i = 0; i < 10 && !failure; i++) {
      const read = reader.read().catch((err: Error) => {
        failure = err;
      });
      await settle();
      await clock.advance(40); // 40 ms apart: never 50 ms of silence
      p.send();
      await read;
    }
    expect(failure?.name).toBe('TimeoutError');
    expect(failure?.message).toBe('The transfer exceeded its maximum duration');
    expect(p.seen.signal?.aborted).toBe(true);
    expect(p.seen.cancelled).toBeDefined();
    expect(clock.pending).toBe(0);
  });

  it('a steady transfer below the cap still passes', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, maxStreamMs: MAX, timers: clock.timers })(
      'https://provider.example/file',
    );
    const reader = bodyOf(res).getReader();
    for (let i = 0; i < 4; i++) {
      const read = reader.read();
      await settle();
      await clock.advance(40); // 160 ms in all, under the 200 ms cap
      p.send();
      expect((await read).done).toBe(false);
    }
    const last = reader.read();
    p.end();
    expect((await last).done).toBe(true);
    expect(p.seen.signal?.aborted).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('a stream abandoned between reads, never cancelled, ends at the cap and lets go of the source', async () => {
    const clock = manualTimers();
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { idleMs: IDLE, maxStreamMs: MAX, timers: clock.timers })(
      'https://provider.example/file',
    );
    const reader = bodyOf(res).getReader();
    const first = reader.read();
    p.send();
    await first;
    // The consumer walks away: no read outstanding, nothing waiting on the provider.
    await clock.advance(MAX);
    expect(p.seen.signal?.aborted).toBe(true);
    expect(p.seen.cancelled).toBeDefined();
    await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the default cap is finite, no longer than ten minutes, and is the one applied', async () => {
    expect(STREAM_MAX_DURATION_MS).toBeGreaterThan(0);
    expect(STREAM_MAX_DURATION_MS).toBeLessThanOrEqual(10 * 60_000);
    const clock = manualTimers();
    const p = provider();
    // No options: the defaults. A consumer that read once and walked away ends at the default cap.
    const res = await deadlineFetch(p.fetch, TOTAL, { timers: clock.timers })('https://provider.example/file');
    const reader = bodyOf(res).getReader();
    const first = reader.read();
    p.send();
    await first;
    await clock.advance(STREAM_MAX_DURATION_MS - 1);
    expect(p.seen.signal?.aborted).toBe(false);
    await clock.advance(1);
    expect(p.seen.signal?.aborted).toBe(true);
    await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError', message: 'The transfer exceeded its maximum duration' });
  });

  it('a reader that cannot be taken leaves no cap timer armed', async () => {
    const clock = manualTimers();
    const fetch: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
        body: {
          getReader() {
            throw new TypeError('The stream is locked');
          },
        },
      }) as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/file');
    await expect(bodyOf(res).getReader().read()).rejects.toThrow('The stream is locked');
    expect(clock.pending).toBe(0);
  });

  it("lets go of the caller's signal when the call's own deadline fires", async () => {
    const clock = manualTimers();
    const counts = { added: 0, removed: 0 };
    const signal = {
      aborted: false,
      addEventListener: () => void counts.added++,
      removeEventListener: () => void counts.removed++,
    };
    const p = provider();
    await deadlineFetch(p.fetch, TOTAL, { timers: clock.timers })('https://provider.example/file', { signal });
    await clock.advance(TOTAL);
    expect(p.seen.signal?.aborted).toBe(true);
    expect(counts).toEqual({ added: 1, removed: 1 });
  });

  it('none of its timers hold a process open', async () => {
    const unrefs: string[] = [];
    let n = 0;
    const timers = {
      setTimeout: (fn: () => void) => {
        void fn;
        const id = n++;
        return { unref: () => void unrefs.push(String(id)) };
      },
      clearTimeout: () => {},
    };
    const p = provider();
    const res = await deadlineFetch(p.fetch, TOTAL, { timers })('https://provider.example/file');
    const read = bodyOf(res).getReader().read();
    p.send();
    await read;
    // The call's deadline, the cap and the idle window.
    expect(unrefs).toHaveLength(3);
  });

  it("lets go of the caller's signal when the call is over", async () => {
    const clock = manualTimers();
    const counts = { added: 0, removed: 0 };
    const signal = {
      aborted: false,
      addEventListener: () => void counts.added++,
      removeEventListener: () => void counts.removed++,
    };
    const fetch: FetchLike = async () => new Response('{}') as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x', { signal });
    expect(counts).toEqual({ added: 1, removed: 0 });
    await res.json();
    expect(counts).toEqual({ added: 1, removed: 1 });
  });
});

describe('against a real fetch and a real server', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    const open = servers.splice(0);
    for (const s of open) s.closeAllConnections();
    await Promise.all(open.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
  }

  async function drain(stream: ByteStream): Promise<number> {
    const reader = stream.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return size;
      size += value!.byteLength;
    }
  }

  it('a body trickling for longer than timeoutMs completes; the same body read buffered is cut', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(10, 1));
        if (++sent === 10) {
          clearInterval(timer);
          res.end();
        }
      }, 40);
    });
    // 10 chunks 40 ms apart is ~400 ms: over timeoutMs (250), never 300 ms of silence.
    const streamed = await deadlineFetch(globalFetch, 250, { idleMs: 300 })(url);
    expect(await drain(bodyOf(streamed))).toBe(100);
    const buffered = await deadlineFetch(globalFetch, 250, { idleMs: 300 })(url);
    await expect(buffered.arrayBuffer()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a body that goes quiet mid-transfer errors after the idle window', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(10, 1)); // then nothing, and the connection stays open
    });
    const res = await deadlineFetch(globalFetch, 5_000, { idleMs: 150 })(url);
    const started = Date.now();
    await expect(drain(bodyOf(res))).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the caller's abort and other failures keep their own class (#2518 review)", () => {
  /** A provider whose body errors when the call is aborted, as a runtime's does. */
  function abortable() {
    const seen: { signal?: AbortSignal } = {};
    const fetch: FetchLike = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      seen.signal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const fail = () => controller.error(signal.reason);
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        },
      });
      return new Response(body) as unknown as ConnectorResponse;
    };
    return { fetch, seen };
  }

  it("a caller's abort, then a first read, is the caller's AbortError, even after the call's deadline would have fired", async () => {
    const clock = manualTimers();
    const p = abortable();
    const caller = new AbortController();
    const res = await deadlineFetch(p.fetch, TOTAL, { timers: clock.timers })('https://provider.example/file', {
      signal: caller.signal,
    });
    caller.abort();
    // The deadline was released by the abort: it cannot fire later and rename the cancel.
    expect(clock.pending).toBe(0);
    await clock.advance(TOTAL * 3);
    const err = await bodyOf(res).getReader().read().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.name).toBe('AbortError');
  });

  it("a caller's abort, then a buffered read, is the caller's AbortError", async () => {
    const clock = manualTimers();
    const p = abortable();
    const caller = new AbortController();
    const res = await deadlineFetch(p.fetch, TOTAL, { timers: clock.timers })('https://provider.example/file', {
      signal: caller.signal,
    });
    caller.abort();
    await clock.advance(TOTAL * 3);
    await expect(res.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('after the call\'s deadline fired, an unrelated failure keeps its own class', async () => {
    const clock = manualTimers();
    const network = new TypeError('connection reset');
    const fetch: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          throw network;
        },
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/x');
    await clock.advance(TOTAL); // the deadline fires first
    await expect(res.text()).rejects.toBe(network);
  });

  it('a source that answers only with empty chunks is cut, though no timer can run', async () => {
    const clock = manualTimers();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(0));
      },
    });
    const fetch: FetchLike = async () => new Response(body) as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { idleMs: IDLE, timers: clock.timers })('https://provider.example/file');
    // No clock movement at all: only the count can end it.
    const err = await bodyOf(res).getReader().read().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.name).toBe('TimeoutError');
    expect(err?.message).toBe('The response body made no progress');
    expect(pulls).toBeLessThan(1_100);
    await settle();
    expect(clock.pending).toBe(0);
  });

  it('a few empty chunks in a run are fine', async () => {
    const clock = manualTimers();
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ < 500) controller.enqueue(new Uint8Array(0));
        else {
          controller.enqueue(CHUNK);
          controller.close();
        }
      },
    });
    const fetch: FetchLike = async () => new Response(body) as unknown as ConnectorResponse;
    const res = await deadlineFetch(fetch, TOTAL, { timers: clock.timers })('https://provider.example/file');
    const { value } = await bodyOf(res).getReader().read();
    expect(value?.byteLength).toBe(CHUNK.byteLength);
  });
});

describe('a streamed body is not retained once delivered (#2498, #2518)', () => {
  it('reads many large chunks through the guard and keeps about one in memory', async () => {
    // Node's `gc`, without a flag on the command line.
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const MB = 1024 * 1024;
    const CHUNKS = 120;
    let made = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (made === CHUNKS) return controller.close();
          made++;
          controller.enqueue(new Uint8Array(MB).fill(made % 251));
        },
      },
      { highWaterMark: 0 },
    );
    const fetch: FetchLike = async () => new Response(source) as unknown as ConnectorResponse;
    const buffers = () => process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 3; i++) gc();
    const before = buffers();
    // Real timers, the runtime's own: the bounds are armed for every read, as in production.
    const res = await deadlineFetch(fetch, 60_000)('https://provider.example/file');
    const reader = bodyOf(res).getReader();
    let read = 0;
    let peak = 0;
    for (let n = 1; ; n++) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value!.byteLength;
      // Dropped: nothing here keeps it. Measured WHILE the stream is live, every 10 chunks: a chunk
      // kept alive per read is unreachable again once the stream ends, so only a mid-stream sample sees it.
      if (n % 10 === 0) {
        gc();
        await settle();
        peak = Math.max(peak, buffers() - before);
      }
    }
    expect(read).toBe(CHUNKS * MB);
    // The last chunks are not collected until a collection runs, so the end reading follows one, as
    // the mid-stream samples do (#2576: 11.5 MB unforced on a loaded runner).
    for (let i = 0; i < 3; i++) gc();
    await settle();
    // 120 MB went through. A chunk kept alive per read would leave ~120 MB at both readings; one chunk is about 1.
    expect(Math.max(peak, buffers() - before)).toBeLessThan(10 * MB);
  });
});
