/**
 * Bytes as a stream (#2498, `docs/rfc/file-bearing-sources.md` §6).
 *
 * The byte seams between a provider, a connector and the attachment store each took the whole
 * body as one buffer, so the largest file a connector could land was whatever the worker had
 * memory for. Each seam now also takes a {@link SizedByteStream}: a stream, plus the length its
 * producer declares. The length is declared rather than counted because the stores need it
 * before the first byte (R2 refuses a stream of unknown length), and it is enforced on the way
 * through: a stream that carries more or fewer bytes than it declared errors instead of landing.
 *
 * Structural, for the reason `FetchLike` is: the kernel depends on no platform typings, and a
 * web `ReadableStream<Uint8Array>` from Node, workerd or a browser satisfies {@link ByteStream}
 * without either being required.
 */

/** One read from a {@link ByteStreamReader}: a chunk, or the end. */
export interface ByteStreamRead {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

/** The reader a {@link ByteStream} hands out — the slice of `ReadableStreamDefaultReader` used here. */
export interface ByteStreamReader {
  read(): Promise<ByteStreamRead>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** A web `ReadableStream<Uint8Array>`, structurally. */
export interface ByteStream {
  getReader(): ByteStreamReader;
}

/** A byte stream with the length its producer declares. */
export interface SizedByteStream {
  readonly stream: ByteStream;
  readonly length: number;
}

/** A body a byte seam takes: the whole buffer, as before, or a sized stream. */
export type ByteBody = Uint8Array | SizedByteStream;

/** Is `body` a sized stream rather than a buffer? */
export function isSizedByteStream(body: unknown): body is SizedByteStream {
  return (
    typeof body === 'object' &&
    body !== null &&
    !ArrayBuffer.isView(body) &&
    typeof (body as { stream?: { getReader?: unknown } }).stream?.getReader === 'function' &&
    typeof (body as { length?: unknown }).length === 'number'
  );
}

/**
 * A running SHA-256, fed one chunk at a time. The kernel holds no implementation: Web Crypto has
 * no incremental digest and a hand-rolled one is not an option, so each adapter passes its
 * runtime's own (workerd's `crypto.DigestStream`, Node's `createHash`).
 */
export interface IncrementalSha256 {
  update(chunk: Uint8Array): void | Promise<void>;
  /** The lowercase hex digest of everything fed so far. Called once, after the last chunk. */
  hex(): Promise<string>;
}

/** What a witnessed stream's bytes were, once they have all passed. */
export interface StreamWitness {
  readonly sha256: string;
  readonly size: number;
}

/** A sized stream that hashes and counts its bytes as its reader takes them. */
export interface WitnessedStream {
  readonly body: SizedByteStream;
  /**
   * The bytes' sha256 and size. Throws until the stream has been read to its end, so a store
   * that answered without consuming the body cannot have a record written for bytes it never saw.
   */
  witness(): StreamWitness;
}

interface StreamController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason: unknown): void;
}

declare const ReadableStream: new (
  source: { pull(controller: StreamController): Promise<void>; cancel(reason?: unknown): Promise<void> },
  strategy?: { highWaterMark?: number },
) => ByteStream;

/** Refuse a declared length no stream can have. */
function assertDeclaredLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`a byte stream's declared length must be a non-negative integer, not ${length}`);
  }
}

/**
 * A new stream that passes `source` through chunk by chunk, holding it to `length`. Pull-driven
 * with no queue of its own (`highWaterMark: 0`), so a chunk is read from the source only when the
 * consumer asks for one: at most one chunk is in flight, whatever the body's size.
 */
function relay(
  source: ByteStream,
  length: number,
  onChunk?: (chunk: Uint8Array) => void | Promise<void>,
  onEnd?: () => void | Promise<void>,
): ByteStream {
  assertDeclaredLength(length);
  const reader = source.getReader();
  let size = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (size !== length) {
              throw new Error(`the byte stream ended after ${size} bytes; it declared ${length}`);
            }
            await onEnd?.();
            controller.close();
            return;
          }
          // A read that neither ends nor carries a chunk is a broken source: answering it by
          // returning would leave the consumer's read waiting for a pull that never comes.
          if (!value) throw new Error('the byte stream yielded a read with neither a chunk nor its end');
          size += value.byteLength;
          if (size > length) {
            throw new Error(`the byte stream carried more than the ${length} bytes it declared`);
          }
          await onChunk?.(value);
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
          await reader.cancel(err).catch(() => {});
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/**
 * Hash and count `body` while it flows to wherever it is going. The digest is fed each chunk
 * before the chunk moves on, and the final digest is taken before the stream reports its end, so
 * once the consumer has read to the end — a store's `put` has resolved — {@link
 * WitnessedStream.witness} answers.
 */
export function witnessedStream(body: SizedByteStream, digest: IncrementalSha256): WitnessedStream {
  let witnessed: StreamWitness | undefined;
  const stream = relay(
    body.stream,
    body.length,
    (chunk) => digest.update(chunk),
    async () => {
      witnessed = { sha256: await digest.hex(), size: body.length };
    },
  );
  return {
    body: { stream, length: body.length },
    witness: () => {
      if (!witnessed) throw new Error('the byte stream was not read to its end, so its bytes are unwitnessed');
      return witnessed;
    },
  };
}

/** The runtime's fixed-length stream, where it has one (workerd). */
type FixedLengthStreamCtor = new (length: number) => { readable: unknown; writable: unknown };

/** The runtime's own `FixedLengthStream`, where it has one (workerd). */
function fixedLengthStream(): FixedLengthStreamCtor | undefined {
  return (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
}

/**
 * `body` as a stream of known length that the runtime takes, held to its declared length: a
 * stream that carries more or fewer bytes errors whatever reads it. On workerd that is a
 * `FixedLengthStream`, which a `fetch` sends with a `Content-Length` rather than chunked and
 * which R2's `put` accepts (it refuses a stream of unknown length); the runtime enforces the
 * length there, so a web stream is piped straight in. Elsewhere it is the stream passed through
 * a relay that enforces the length.
 */
export function knownLengthStream(body: SizedByteStream): ByteStream {
  const Fixed = fixedLengthStream();
  if (!Fixed) return relay(body.stream, body.length);
  assertDeclaredLength(body.length);
  const piped = body.stream as unknown as { pipeThrough?: (pair: unknown) => ByteStream };
  const source = typeof piped.pipeThrough === 'function' ? piped : (relay(body.stream, body.length) as unknown as typeof piped);
  return source.pipeThrough!(new Fixed(body.length));
}

/**
 * A request init whose body is a sized stream, as the runtime's `fetch` takes it: the body
 * as {@link knownLengthStream}, and off workerd the `Content-Length` header and `duplex: 'half'`
 * a streamed request body needs there. `fetchLikeOf` sends through it, so a `FetchLike` does not
 * call this itself: a runtime `fetch` becomes one by `fetchLikeOf`. A caller that holds a
 * runtime `fetch` it does not make a `FetchLike` (the platform's vertical client) does.
 */
export function knownLengthInit<Init extends { headers?: Record<string, string>; body: SizedByteStream }>(
  init: Init,
): Omit<Init, 'body'> & { body: ByteStream; headers: Record<string, string>; duplex?: 'half' } {
  const length = init.body.length;
  const onWorkerd = fixedLengthStream() !== undefined;
  return {
    ...init,
    body: knownLengthStream(init.body),
    headers: { ...init.headers, ...(onWorkerd ? {} : { 'content-length': String(length) }) },
    ...(onWorkerd ? {} : { duplex: 'half' as const }),
  };
}
