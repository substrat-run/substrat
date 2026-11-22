/**
 * One connection's share of a platform sweep pass (#3324).
 *
 * A connector sweeper is handed the pass's own `fetch`, so every byte a connection downloads is
 * held, for as long as the connector holds it, in the memory of the isolate running the pass. One
 * connection whose sync read more than that isolate holds reset it, and with it every phase still
 * to run, on every pass for three days. {@link budgetedFetch} gives each connection a share it
 * cannot exceed:
 *
 * - **bytes**: the response bodies a connection's sweep reads, counted as they arrive. The count
 *   is taken chunk by chunk while the body streams, so a response is never read past the budget:
 *   the read errors at the chunk that crosses it, and a response whose declared length would cross
 *   it is refused before a byte is read. A connector that buffers (`text()`, `json()`,
 *   `arrayBuffer()`) is read the same way underneath.
 * - **time**: once the share's wall time has passed, the next call and the next chunk are refused.
 *   A call already waiting on its provider is bounded by the connector's own timeout (#2518).
 *
 * Both end the sweep with a {@link SweepBudgetSpent}, which the pass records as that connection's
 * failed sweep and steps over. Whatever the sweep landed before it is kept; a connector that walks
 * a cursor resumes from it on the next pass.
 */
import type { ByteStream, ByteStreamReader } from './byte-stream.js';
import type { ConnectorResponse, FetchLike } from './connector-transport.js';

/**
 * The most response bytes one connection's sweep may read in one pass: 64 MiB. Under half the
 * 128 MB a Worker isolate holds, so a connection that spends its whole share leaves the pass room
 * to finish; far above what a healthy incremental poll reads (a page of JSON is kilobytes).
 */
export const CONNECTOR_SWEEP_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The most wall time one connection's sweep may take in one pass: 10 minutes. Above the longest
 * healthy sweep seen in production (about 9 minutes, a store walking its catalogue), and inside
 * the 15 minutes a scheduled invocation lives.
 */
export const CONNECTOR_SWEEP_MAX_MS = 10 * 60_000;

/** A connection's sweep reached the end of its share of the pass. */
export class SweepBudgetSpent extends Error {
  override readonly name = 'SweepBudgetSpent';
}

export interface SweepBudget {
  /** Response bytes the sweep may read in all. */
  maxBytes: number;
  /** Wall time the sweep may take, from the wrapper's creation. */
  maxMs: number;
  /** The pass's clock, in epoch ms. */
  clock: () => number;
}

declare const TextDecoder: new () => { decode(input: Uint8Array): string };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const ReadableStream: new (
  source: {
    pull(controller: { enqueue(chunk: Uint8Array): void; close(): void; error(reason: unknown): void }): Promise<void>;
    cancel(reason?: unknown): Promise<void>;
  },
  strategy: { highWaterMark: number },
) => ByteStream;

const MIB = 1024 * 1024;
const mib = (bytes: number) => (bytes < MIB ? `${bytes} bytes` : `${Math.round((bytes / MIB) * 10) / 10} MiB`);

/** `fetch` held to `budget`: see the file header. One wrapper per connection per pass. */
export function budgetedFetch(fetch: FetchLike, budget: SweepBudget): FetchLike {
  const deadline = budget.clock() + budget.maxMs;
  let used = 0;
  const bytesSpent = () =>
    new SweepBudgetSpent(`this connection's sweep read more than its ${mib(budget.maxBytes)} of response bodies for one pass`);
  const timeSpent = () =>
    new SweepBudgetSpent(`this connection's sweep ran past its ${Math.round(budget.maxMs / 60_000)} minutes for one pass`);
  const check = () => {
    if (used > budget.maxBytes) throw bytesSpent();
    if (budget.clock() >= deadline) throw timeSpent();
  };
  const charge = (n: number) => {
    used += n;
    check();
  };
  return async (input, init) => {
    check();
    const res = await fetch(input, init);
    // A declared length is the transfer's size only when nothing decodes it on the way (gzip, br).
    const declared = res.headers?.get('content-encoding') ? Number.NaN : Number(res.headers?.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && used + declared > budget.maxBytes) {
      await res.body?.getReader().cancel(bytesSpent()).catch(() => {});
      throw bytesSpent();
    }
    return counted(res, charge);
  };
}

/** `res`, its body read once through `charge`, however the connector reads it. */
function counted(res: ConnectorResponse, charge: (n: number) => void): ConnectorResponse {
  const body = res.body;
  if (!body) {
    // A hand-built stand-in with no stream (every runtime response has one): its own read, charged
    // once it returns. It may implement only the reads its connector makes, so each is its own.
    const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;
    return {
      ok: res.ok,
      status: res.status,
      ...(res.headers ? { headers: res.headers } : {}),
      body,
      text: async () => {
        const t = await res.text();
        charge(utf8(t));
        return t;
      },
      json: async () => {
        const v = await res.json();
        charge(utf8(JSON.stringify(v) ?? ''));
        return v;
      },
      arrayBuffer: async () => {
        const b = await res.arrayBuffer();
        charge(b.byteLength);
        return b;
      },
    };
  }
  let stream: ByteStream | undefined;
  const bytes = async (): Promise<Uint8Array> => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        charge(value.byteLength);
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (err) {
      await reader.cancel(err).catch(() => {});
      throw err;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  };
  const text = async () => new TextDecoder().decode(await bytes());
  return {
    ok: res.ok,
    status: res.status,
    ...(res.headers ? { headers: res.headers } : {}),
    text,
    json: async () => JSON.parse(await text()) as unknown,
    arrayBuffer: async () => {
      const b = await bytes();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    get body() {
      stream ??= countedStream(body, charge);
      return stream;
    },
  };
}

/** `body`, passed through chunk by chunk with each chunk charged before it is handed on. */
function countedStream(body: ByteStream, charge: (n: number) => void): ByteStream {
  let reader: ByteStreamReader | undefined;
  return new ReadableStream(
    {
      async pull(controller) {
        reader ??= body.getReader();
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (!value) return;
          charge(value.byteLength);
          controller.enqueue(value);
        } catch (err) {
          await reader.cancel(err).catch(() => {});
          controller.error(err);
        }
      },
      cancel: async (reason) => {
        await reader?.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}
