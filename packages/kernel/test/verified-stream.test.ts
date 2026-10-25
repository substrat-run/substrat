import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attachmentRecord, type AttachmentRecord } from '@substrat-run/contracts';
import {
  VERIFIED_STREAM_CHUNK_MAX_BYTES,
  bytesStream,
  openAttachmentByteStream,
  runtimeSha256,
  verifiedStream,
  type ByteStream,
  type ByteStreamRead,
  type IncrementalSha256,
  type TenantBlobStore,
} from '../src/index.js';

/**
 * The read half of streamed attachments (#2514): stored bytes on their way out, held to the record
 * that witnesses them as they pass. What matters most is what a consumer sees when the bytes are
 * wrong: the chunk that completes the record's size is held back until the digest matches, so a
 * consumer can never have received all `size` bytes of a file that did not verify.
 */

const CHUNK = 64 * 1024;
const chunkOf = (i: number): Uint8Array => new Uint8Array(CHUNK).fill(i % 251);

interface Flow {
  produced: number;
  consumed: number;
  maxLead: number;
  cancelled: unknown[];
}

/** `chunks` chunks (or the given ones), each made only when asked for, measuring the lead over `flow.consumed`. */
function producer(chunks: number | Uint8Array[]) {
  const flow: Flow = { produced: 0, consumed: 0, maxLead: 0, cancelled: [] };
  const list = typeof chunks === 'number' ? Array.from({ length: chunks }, (_, i) => chunkOf(i)) : chunks;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i === list.length) return controller.close();
        const chunk = list[i++]!;
        flow.produced += chunk.byteLength;
        flow.maxLead = Math.max(flow.maxLead, flow.produced - flow.consumed);
        controller.enqueue(chunk);
      },
      cancel(reason) {
        flow.cancelled.push(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { flow, stream, bytes: list };
}

const sha256Of = (chunks: Uint8Array[]): string => {
  const hash = createHash('sha256');
  for (const c of chunks) hash.update(c);
  return hash.digest('hex');
};

const nodeSha256 = (): IncrementalSha256 => {
  const hash = createHash('sha256');
  return { update: (chunk) => void hash.update(chunk), hex: async () => hash.digest('hex') };
};

/**
 * Read a stream, stopping once `stopAt` bytes have arrived when given: the consumer that counts to the
 * size it was told and never reads the end. Slow (a macrotask per chunk) when it counts into a flow.
 */
async function read(stream: ByteStream, opts: { flow?: Flow; stopAt?: number } = {}) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (opts.stopAt !== undefined && size >= opts.stopAt) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.byteLength;
      if (opts.flow) {
        opts.flow.consumed = size;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return { ok: true as const, size, sha256: sha256Of(chunks), chunks };
  } catch (error) {
    return { ok: false as const, size, error: (error as Error).message, chunks };
  }
}

describe('verifiedStream (#2514)', () => {
  it('hands on bytes that match their record, one chunk in flight at a time', async () => {
    const { flow, stream, bytes } = producer(32);
    const expected = { size: 32 * CHUNK, sha256: sha256Of(bytes) };
    const out = await read(verifiedStream({ stream, length: expected.size }, expected, nodeSha256()).stream, { flow });
    expect(out).toMatchObject({ ok: true, size: expected.size, sha256: expected.sha256 });
    // A relay that queued the body would lead by all of it.
    expect(flow.maxLead).toBeLessThanOrEqual(2 * CHUNK);
  });

  it('a digest mismatch errors the stream before its last chunk, so the consumer never has every byte', async () => {
    const { stream, bytes } = producer(8);
    const wrong = { size: 8 * CHUNK, sha256: sha256Of([new Uint8Array(1)]) };
    const out = await read(verifiedStream({ stream, length: wrong.size }, wrong, nodeSha256()).stream);
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ error: expect.stringMatching(/do not match the recorded sha256/) });
    // Everything but the held-back last chunk, and never the whole file.
    expect(out.size).toBe(7 * CHUNK);
    expect(out.size).toBeLessThan(wrong.size);
    expect(bytes.length).toBe(8);
  });

  it('a consumer that counts to the size and stops cannot take a mismatched file as complete', async () => {
    const { stream } = producer(4);
    const wrong = { size: 4 * CHUNK, sha256: sha256Of([new Uint8Array(1)]) };
    const out = await read(verifiedStream({ stream, length: wrong.size }, wrong, nodeSha256()).stream, {
      stopAt: wrong.size,
    });
    // It meets the error before its count is reached: there is no successful read of `size` bytes.
    expect(out).toMatchObject({ ok: false, size: 3 * CHUNK });
  });

  it('its positive twin: the same counting consumer, on matching bytes, gets every byte', async () => {
    const { stream, bytes } = producer(4);
    const right = { size: 4 * CHUNK, sha256: sha256Of(bytes) };
    const out = await read(verifiedStream({ stream, length: right.size }, right, nodeSha256()).stream, {
      stopAt: right.size,
    });
    expect(out).toMatchObject({ ok: true, size: right.size, sha256: right.sha256 });
  });

  it('a stored object that ends short of its record errors, the consumer short of the size', async () => {
    const { stream, bytes } = producer(2);
    const expected = { size: 3 * CHUNK, sha256: sha256Of(bytes) };
    const out = await read(verifiedStream({ stream, length: expected.size }, expected, nodeSha256()).stream);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/ended after 131072 bytes; its record says 196608/) });
  });

  it('a stored object that carries more than its record errors before the last chunk', async () => {
    const { stream, bytes } = producer(3);
    const expected = { size: 2 * CHUNK, sha256: sha256Of(bytes.slice(0, 2)) };
    const out = await read(verifiedStream({ stream, length: expected.size }, expected, nodeSha256()).stream);
    expect(out).toMatchObject({ ok: false, size: CHUNK, error: expect.stringMatching(/more than the 131072 bytes/) });
  });

  it('a length that is not the record size is refused before a byte is read', () => {
    const { flow, stream } = producer(2);
    expect(() => verifiedStream({ stream, length: 2 * CHUNK }, { size: CHUNK, sha256: 'a'.repeat(64) }, nodeSha256())).toThrow(
      /131072 bytes; its record says 65536/,
    );
    expect(flow.produced).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['upper-case', 'A'.repeat(64)],
    ['short', 'a'.repeat(63)],
  ])('a record whose sha256 is %s is refused before a byte is read, never handed on as verified', (_name, sha256) => {
    const { flow, stream } = producer(1);
    expect(() => verifiedStream({ stream, length: CHUNK }, { size: CHUNK, sha256 }, nodeSha256())).toThrow(
      /no sha256 to verify/,
    );
    expect(flow.produced).toBe(0);
  });

  it('a source chunk larger than the cap is handed on in pieces of the cap, the bytes intact', async () => {
    const huge = new Uint8Array(5 * VERIFIED_STREAM_CHUNK_MAX_BYTES + 123).map((_, i) => i % 253);
    const { stream } = producer([huge]);
    const expected = { size: huge.byteLength, sha256: sha256Of([huge]) };
    const out = await read(verifiedStream({ stream, length: expected.size }, expected, nodeSha256()).stream);
    expect(out).toMatchObject({ ok: true, size: expected.size, sha256: expected.sha256 });
    expect(Math.max(...out.chunks.map((c) => c.byteLength))).toBe(VERIFIED_STREAM_CHUNK_MAX_BYTES);
    expect(out.chunks).toHaveLength(6);
  });

  it('so what is held back at the end is at most the cap, even when the source sent one huge chunk', async () => {
    const huge = new Uint8Array(4 * VERIFIED_STREAM_CHUNK_MAX_BYTES);
    const { stream } = producer([huge]);
    const wrong = { size: huge.byteLength, sha256: sha256Of([new Uint8Array(1)]) };
    const out = await read(verifiedStream({ stream, length: wrong.size }, wrong, nodeSha256()).stream);
    expect(out).toMatchObject({ ok: false, size: 3 * VERIFIED_STREAM_CHUNK_MAX_BYTES });
  });

  it('a consumer that cancels cancels the stored object it was reading', async () => {
    const { flow, stream, bytes } = producer(8);
    const expected = { size: 8 * CHUNK, sha256: sha256Of(bytes) };
    const reader = verifiedStream({ stream, length: expected.size }, expected, nodeSha256()).stream.getReader();
    await reader.read();
    await reader.cancel('no longer needed');
    expect(flow.cancelled).toEqual(['no longer needed']);
    expect(flow.produced).toBeLessThan(expected.size);
  });

  it('an error releases the stored object too', async () => {
    const { flow, stream } = producer(3);
    const wrong = { size: 2 * CHUNK, sha256: 'a'.repeat(64) };
    await read(verifiedStream({ stream, length: wrong.size }, wrong, nodeSha256()).stream);
    expect(flow.cancelled).toHaveLength(1);
  });

  it('an empty file verifies against the digest of nothing, and its mismatch errors', async () => {
    const empty = { size: 0, sha256: sha256Of([]) };
    expect(await read(verifiedStream({ stream: producer(0).stream, length: 0 }, empty, nodeSha256()).stream)).toMatchObject({
      ok: true,
      size: 0,
    });
    const wrong = { size: 0, sha256: 'a'.repeat(64) };
    expect(await read(verifiedStream({ stream: producer(0).stream, length: 0 }, wrong, nodeSha256()).stream)).toMatchObject({
      ok: false,
    });
  });

  it('a source read that carries neither a chunk nor its end errors the stream rather than hanging it', async () => {
    const reads: ByteStreamRead[] = [{ done: false }, { done: true }];
    const source: ByteStream = {
      getReader: () => ({ read: async () => reads.shift()!, cancel: async () => {}, releaseLock: () => {} }),
    };
    const out = await read(verifiedStream({ stream: source, length: 1 }, { size: 1, sha256: 'a'.repeat(64) }, nodeSha256()).stream);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/neither a chunk nor its end/) });
  });
});

describe('runtimeSha256 (#2514)', () => {
  it('is undefined where the runtime has no running digest (Node)', () => {
    expect((globalThis.crypto as unknown as { DigestStream?: unknown }).DigestStream).toBeUndefined();
    expect(runtimeSha256()).toBeUndefined();
  });

  it("uses the runtime's DigestStream where it has one, and gives the digest a buffer gets", async () => {
    // A stand-in for workerd's `crypto.DigestStream`, over Node's hash: what is tested is the wiring.
    class DigestStream {
      private readonly hash = createHash('sha256');
      readonly digest: Promise<ArrayBuffer>;
      private resolve!: (b: ArrayBuffer) => void;
      constructor(algorithm: string) {
        expect(algorithm).toBe('SHA-256');
        this.digest = new Promise((r) => (this.resolve = r));
      }
      getWriter() {
        return {
          write: async (c: Uint8Array) => void this.hash.update(c),
          close: async () => {
            const d = this.hash.digest();
            this.resolve(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
          },
        };
      }
    }
    const crypto = globalThis.crypto as unknown as { DigestStream?: unknown };
    crypto.DigestStream = DigestStream;
    try {
      const digest = runtimeSha256()!();
      await digest.update(new TextEncoder().encode('%PDF'));
      await digest.update(new TextEncoder().encode('-1.4'));
      expect(await digest.hex()).toBe(createHash('sha256').update('%PDF-1.4').digest('hex'));
    } finally {
      delete crypto.DigestStream;
    }
  });
});

describe('bytesStream', () => {
  it('hands a held buffer on 1 MiB at a time, each chunk a copy, so taking one detaches nothing else', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 5).map((_, i) => i % 255);
    const { stream, length } = bytesStream(bytes);
    expect(length).toBe(bytes.byteLength);
    const out = await read(stream);
    expect(out.chunks.map((c) => c.byteLength)).toEqual([1024 * 1024, 1024 * 1024, 5]);
    expect(out.chunks.every((c) => c.buffer !== bytes.buffer)).toBe(true);
    // Taking the first chunk's buffer leaves the source whole.
    const taken = out.chunks[0]!.buffer as ArrayBuffer;
    structuredClone(taken, { transfer: [taken] });
    expect(bytes.byteLength).toBe(2 * 1024 * 1024 + 5);
    expect(out).toMatchObject({ ok: true, sha256: sha256Of([bytes]) });
  });
});

describe('openAttachmentByteStream (#2514)', () => {
  const recordOf = (bytes: Uint8Array[], size = bytes.reduce((n, c) => n + c.byteLength, 0)): AttachmentRecord =>
    attachmentRecord.parse({
      id: 'att1',
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'drawing-set.pdf',
      contentType: 'application/pdf',
      visibility: 'internal',
      createdBy: 'p1',
      createdAt: '2026-10-25T00:00:00.000Z',
      size,
      sha256: sha256Of(bytes),
    });

  /** A store holding one object; `getStream` only when asked, counting every call. */
  function storeOf(object: { bytes: Uint8Array[]; size?: number; contentType?: string } | null, streams = true) {
    const calls = { get: 0, getStream: 0 };
    let source: ReturnType<typeof producer> | undefined;
    const store: TenantBlobStore = {
      put: async () => {},
      get: async () => {
        calls.get++;
        if (!object) return null;
        const body = new Uint8Array(Buffer.concat(object.bytes));
        return object.contentType ? { body, contentType: object.contentType } : { body };
      },
      delete: async () => {},
      list: async () => [],
      ...(streams
        ? {
            getStream: async () => {
              calls.getStream++;
              if (!object) return null;
              source = producer(object.bytes);
              const size = object.size ?? object.bytes.reduce((n, c) => n + c.byteLength, 0);
              return { stream: source.stream, size, ...(object.contentType ? { contentType: object.contentType } : {}) };
            },
          }
        : {}),
    };
    return { store, calls, source: () => source };
  }

  it('streams the stored object, verified, with the stored content type', async () => {
    const bytes = producer(16).bytes;
    const { store, calls } = storeOf({ bytes, contentType: 'application/pdf' });
    const opened = await openAttachmentByteStream(store, 'k', recordOf(bytes), nodeSha256);
    expect(opened.body.length).toBe(16 * CHUNK);
    expect(opened.contentType).toBe('application/pdf');
    expect(await read(opened.body.stream)).toMatchObject({ ok: true, sha256: sha256Of(bytes) });
    expect(calls).toEqual({ get: 0, getStream: 1 });
  });

  it('an object whose stored size is not the record size is refused before a byte is read, and let go', async () => {
    const bytes = producer(4).bytes;
    const { store, source } = storeOf({ bytes, size: 3 * CHUNK });
    await expect(openAttachmentByteStream(store, 'k', recordOf(bytes), nodeSha256)).rejects.toThrow(
      /attachment att1: the stored object is 196608 bytes; its record says 262144/,
    );
    expect(source()!.flow.produced).toBe(0);
    expect(source()!.flow.cancelled).toHaveLength(1);
  });

  it('a missing object is the same integrity error a buffered open throws', async () => {
    const { store } = storeOf(null);
    await expect(openAttachmentByteStream(store, 'k', recordOf([new Uint8Array(1)]), nodeSha256)).rejects.toThrow(
      /bytes missing from the blob store/,
    );
  });

  it('a store without getStream is read with get and handed on the same way, verified', async () => {
    const bytes = producer(3).bytes;
    const { store, calls } = storeOf({ bytes }, false);
    const opened = await openAttachmentByteStream(store, 'k', recordOf(bytes), nodeSha256);
    expect(opened.contentType).toBe('application/pdf');
    expect(await read(opened.body.stream)).toMatchObject({ ok: true, size: 3 * CHUNK });
    expect(calls).toEqual({ get: 1, getStream: 0 });
    const tampered = storeOf({ bytes: [new Uint8Array(3 * CHUNK)] }, false);
    const bad = await openAttachmentByteStream(tampered.store, 'k', recordOf(bytes), nodeSha256);
    expect(await read(bad.body.stream)).toMatchObject({ ok: false, error: expect.stringMatching(/do not match/) });
  });
});
