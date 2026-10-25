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

import { CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES } from '@substrat-run/contracts';

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

/**
 * Bytes a connector already holds, in the shape a connector upload takes (#2538): the buffer itself
 * up to {@link CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES}, and above it a {@link SizedByteStream} of the
 * same bytes, which the platform sends by the streamed route instead of refusing. It does not shrink
 * what the connector holds; it keeps a file the connector could fetch landing end to end. The stream
 * is one-shot: read it once, and call this again for another upload of the same bytes.
 */
export function connectorUploadBody(bytes: Uint8Array): ByteBody {
  if (bytes.byteLength <= CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES) return bytes;
  return bytesStream(bytes);
}

/**
 * Bytes already held, as a one-shot {@link SizedByteStream} handed out 1 MiB at a time. It saves no
 * memory, since the buffer is held; it lets a buffer go where a seam takes a stream. Each chunk is a
 * copy, not a view of `bytes`, so a consumer that takes a chunk's buffer cannot detach the rest.
 */
export function bytesStream(bytes: Uint8Array): SizedByteStream {
  const CHUNK = 1024 * 1024;
  let at = 0;
  const stream = new ReadableStream(
    {
      async pull(controller) {
        if (at >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, Math.min(at + CHUNK, bytes.byteLength)));
        at += CHUNK;
      },
      async cancel() {},
    },
    { highWaterMark: 0 },
  );
  return { stream, length: bytes.byteLength };
}

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

/**
 * The largest chunk a {@link verifiedStream} hands on, and so the most it holds back at its end. A
 * source chunk larger than this is handed on in pieces of this size.
 */
export const VERIFIED_STREAM_CHUNK_MAX_BYTES = 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Stored bytes on their way out, held to the record that witnesses them (#2514): its `size` and its
 * `sha256`, both checked as the bytes pass rather than before the first one, so nothing is held whole.
 *
 * **What a consumer sees when the bytes are wrong.** The digest is known only after the last byte, so
 * the chunk that completes the declared size is held back until the source has ended and the digest
 * matches. A mismatch, a source that ends short, or one that carries more errors the stream instead,
 * and that last chunk is never handed on. So a consumer can never have received all `size` bytes of a
 * file that did not verify. One that counts to `size` and stops reading is as safe as one that reads to
 * the end. What it may have received before the error is a prefix, and it is told so by the error.
 *
 * The held-back chunk is at most {@link VERIFIED_STREAM_CHUNK_MAX_BYTES}: a source chunk larger than
 * that is handed on in copies of that size, so the wait never holds more than one such piece beside the
 * source chunk it came from. A source chunk within the cap is handed on as the source gave it.
 *
 * Throws before reading anything when the stream's length is not the record's `size`, or the record
 * carries no sha256 to verify against, so a file is never handed on as verified when it could not be.
 */
export function verifiedStream(
  body: SizedByteStream,
  expected: { readonly size: number; readonly sha256: string },
  digest: IncrementalSha256,
): SizedByteStream {
  assertDeclaredLength(body.length);
  if (body.length !== expected.size) {
    throw new Error(`the stored object is ${body.length} bytes; its record says ${expected.size}`);
  }
  if (!SHA256_HEX.test(expected.sha256)) {
    throw new Error('the record carries no sha256 to verify the bytes against');
  }
  const length = body.length;
  const reader = body.stream.getReader();
  let rest: Uint8Array | undefined;
  let delivered = 0;

  /** The next non-empty piece of the source, at most the cap, or `null` at its end. */
  const nextPiece = async (): Promise<Uint8Array | null> => {
    while (!rest || rest.byteLength === 0) {
      const { done, value } = await reader.read();
      if (done) return null;
      if (!value) throw new Error('the byte stream yielded a read with neither a chunk nor its end');
      rest = value;
    }
    if (rest.byteLength <= VERIFIED_STREAM_CHUNK_MAX_BYTES) {
      const piece = rest;
      rest = undefined;
      return piece;
    }
    // A copy, not a view: a consumer may take the piece's buffer, which would take the rest with it.
    const piece = rest.slice(0, VERIFIED_STREAM_CHUNK_MAX_BYTES);
    rest = rest.subarray(VERIFIED_STREAM_CHUNK_MAX_BYTES);
    return piece;
  };

  const stream = new ReadableStream(
    {
      async pull(controller) {
        try {
          const piece = delivered < length ? await nextPiece() : null;
          if (delivered < length) {
            if (!piece) throw new Error(`the stored object ended after ${delivered} bytes; its record says ${length}`);
            if (delivered + piece.byteLength > length) {
              throw new Error(`the stored object carried more than the ${length} bytes its record says`);
            }
            await digest.update(piece);
            delivered += piece.byteLength;
            if (delivered < length) {
              controller.enqueue(piece);
              return;
            }
          }
          // The last bytes: handed on only once the source has ended and the digest matches.
          if (await nextPiece()) throw new Error(`the stored object carried more than the ${length} bytes its record says`);
          if ((await digest.hex()) !== expected.sha256) throw new Error('the bytes do not match the recorded sha256');
          if (piece) controller.enqueue(piece);
          controller.close();
        } catch (err) {
          controller.error(err);
          await reader.cancel(err).catch(() => {});
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return { stream, length };
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
