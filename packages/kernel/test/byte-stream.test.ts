import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES } from '@substrat-run/contracts';
import {
  attachmentSha256,
  connectorUploadBody,
  fetchLikeOf,
  globalFetch,
  isSizedByteStream,
  knownLengthInit,
  knownLengthStream,
  putAttachmentBytes,
  type ByteStream,
  type ByteStreamRead,
  type FetchLike,
  type IncrementalSha256,
  type TenantBlobStore,
} from '../src/index.js';
import { witnessedStream } from '../src/byte-stream.js';

/**
 * The kernel's half of streamed bodies (#2498): a sized stream is held to its declared length,
 * hashed and counted as it passes, and handed to the runtime's `fetch` at that length. Every
 * bound below is measured by the producer, each time it is asked for a chunk, against what the
 * consumer has read so far: a step that collected the body first would drain the producer while
 * the consumer has read nothing, and the lead would be the whole body.
 */

const CHUNK = 64 * 1024;
const chunkOf = (i: number): Uint8Array => new Uint8Array(CHUNK).fill(i % 251);

interface Flow {
  produced: number;
  consumed: number;
  maxLead: number;
}

/** `chunks` chunks, each made only when asked for, measuring the lead over `flow.consumed`. */
function producer(chunks: number) {
  const flow: Flow = { produced: 0, consumed: 0, maxLead: 0 };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i === chunks) return controller.close();
        const chunk = chunkOf(i++);
        flow.produced += chunk.byteLength;
        flow.maxLead = Math.max(flow.maxLead, flow.produced - flow.consumed);
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { flow, stream };
}

/**
 * Read a stream to its end, counting into `flow`; the bytes' sha256 and size. With a `flow` the
 * reader is slow, yielding a macrotask after each chunk as a network sink would, so a step that
 * pulls ahead of its reader (an unbounded queue) builds a lead the bound can see. In memory with
 * no yield, an eager producer and its reader keep pace and no queue ever forms.
 */
async function drain(stream: ByteStream, flow?: Flow) {
  const reader = stream.getReader();
  const hash = createHash('sha256');
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    hash.update(value);
    if (flow) {
      flow.consumed = size;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { sha256: hash.digest('hex'), size };
}

const expected = (chunks: number) => {
  const hash = createHash('sha256');
  for (let i = 0; i < chunks; i++) hash.update(chunkOf(i));
  return { sha256: hash.digest('hex'), size: chunks * CHUNK };
};

/** The fields of the record an upload makes, as an adapter hands them over. */
const FIELDS = {
  id: 'att1',
  entity: { entityType: 'doc', entityId: 'd1' },
  filename: 'drawing-set.pdf',
  contentType: 'application/pdf',
  visibility: 'internal' as const,
  createdBy: 'p1',
  createdAt: '2026-10-23T00:00:00.000Z',
};

const nodeSha256 = (): IncrementalSha256 => {
  const hash = createHash('sha256');
  return { update: (chunk) => void hash.update(chunk), hex: async () => hash.digest('hex') };
};

/** A blob store over a Map that reads a streamed put chunk by chunk, counting into `flow`. */
function memoryStore(flow?: Flow) {
  const objects = new Map<string, { size: number; sha256: string; streamed: boolean }>();
  const deleted: string[] = [];
  const store: TenantBlobStore = {
    put: async (key, body) => {
      if (isSizedByteStream(body)) objects.set(key, { ...(await drain(body.stream, flow)), streamed: true });
      else objects.set(key, { size: body.byteLength, sha256: await attachmentSha256(body), streamed: false });
    },
    get: async () => null,
    delete: async (key) => {
      deleted.push(key);
      objects.delete(key);
    },
    list: async () => [...objects.keys()],
  };
  return { store, objects, deleted };
}

describe('witnessedStream (#2498)', () => {
  it('hashes and counts the bytes as they pass, the same witness a buffer gets', async () => {
    const { flow, stream } = producer(32);
    const witnessed = witnessedStream({ stream, length: 32 * CHUNK }, nodeSha256());
    const read = await drain(witnessed.body.stream, flow);
    expect(read).toEqual(expected(32));
    expect(witnessed.witness()).toEqual(expected(32));
    // One chunk in flight at a time: a relay that queued the body would lead by all of it.
    expect(flow.maxLead).toBeLessThanOrEqual(2 * CHUNK);
  });

  it('its witness is refused until the stream has been read to its end', async () => {
    const { stream } = producer(2);
    const witnessed = witnessedStream({ stream, length: 2 * CHUNK }, nodeSha256());
    expect(() => witnessed.witness()).toThrow(/not read to its end/);
    const reader = witnessed.body.stream.getReader();
    await reader.read();
    expect(() => witnessed.witness()).toThrow(/not read to its end/);
  });

  it('a stream that ends short of its declared length errors at the end', async () => {
    const { stream } = producer(2);
    const witnessed = witnessedStream({ stream, length: 3 * CHUNK }, nodeSha256());
    await expect(drain(witnessed.body.stream)).rejects.toThrow(/ended after 131072 bytes; it declared 196608/);
    expect(() => witnessed.witness()).toThrow();
  });

  it('a stream that carries more than it declared errors at the first byte over', async () => {
    const { stream } = producer(3);
    const witnessed = witnessedStream({ stream, length: 2 * CHUNK }, nodeSha256());
    await expect(drain(witnessed.body.stream)).rejects.toThrow(/more than the 131072 bytes it declared/);
  });

  it('a source read that carries neither a chunk nor its end errors the stream rather than hanging it', async () => {
    // Structural, as ByteStream allows: one read with no value, then a byte.
    const reads: ByteStreamRead[] = [{ done: false }, { done: false, value: new Uint8Array(1) }, { done: true }];
    const source: ByteStream = {
      getReader: () => ({ read: async () => reads.shift()!, cancel: async () => {}, releaseLock: () => {} }),
    };
    const reader = knownLengthStream({ stream: source, length: 1 }).getReader();
    const outcome = await Promise.race([
      reader.read().then(() => 'read', (e: unknown) => (e as Error).message),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1_000)),
    ]);
    expect(outcome).toMatch(/neither a chunk nor its end/);
  });

  it('a declared length no stream can have is refused before a byte is read', () => {
    const { stream } = producer(1);
    expect(() => witnessedStream({ stream, length: -1 }, nodeSha256())).toThrow(/non-negative integer/);
    expect(() => witnessedStream({ stream, length: 1.5 }, nodeSha256())).toThrow(/non-negative integer/);
  });
});

describe('isSizedByteStream', () => {
  it('tells a sized stream from a buffer and from a string', () => {
    expect(isSizedByteStream(new Uint8Array(4))).toBe(false);
    expect(isSizedByteStream('text')).toBe(false);
    expect(isSizedByteStream({ stream: producer(0).stream })).toBe(false);
    expect(isSizedByteStream({ stream: producer(0).stream, length: 0 })).toBe(true);
  });
});

describe('putAttachmentBytes (#2498)', () => {
  it('a stream reaches the store as it is read, and the witness is what the store read', async () => {
    const { flow, stream } = producer(64);
    const { store, objects } = memoryStore(flow);
    const record = await putAttachmentBytes(store, 'k', FIELDS, { stream, length: 64 * CHUNK }, nodeSha256);
    expect(record).toEqual({ ...FIELDS, ...expected(64) });
    expect(objects.get('k')).toEqual({ ...expected(64), streamed: true });
    expect(flow.maxLead).toBeLessThanOrEqual(2 * CHUNK);
  });

  it('the positive twin: a buffer is hashed, then written whole, as before', async () => {
    const { store, objects } = memoryStore();
    const body = new TextEncoder().encode('the sealed pdf bytes');
    const record = await putAttachmentBytes(store, 'k', FIELDS, body, nodeSha256);
    expect(record).toEqual({ ...FIELDS, sha256: await attachmentSha256(body), size: body.byteLength });
    expect(objects.get('k')?.streamed).toBe(false);
  });

  it('a store that answers without reading the stream has the object deleted and the write refused', async () => {
    const { store, deleted } = memoryStore();
    store.put = async () => {};
    const { stream } = producer(2);
    await expect(
      putAttachmentBytes(store, 'k', FIELDS, { stream, length: 2 * CHUNK }, nodeSha256),
    ).rejects.toThrow(/not read to its end/);
    expect(deleted).toEqual(['k']);
  });

  it('a store that committed the bytes and then rejected has the object deleted', async () => {
    const { store, objects, deleted } = memoryStore();
    const put = store.put;
    store.put = async (key, body, opts) => {
      await put(key, body, opts);
      throw new Error('connection lost after commit');
    };
    const { stream } = producer(2);
    await expect(
      putAttachmentBytes(store, 'k', FIELDS, { stream, length: 2 * CHUNK }, nodeSha256),
    ).rejects.toThrow(/after commit/);
    expect(deleted).toEqual(['k']);
    expect(objects.has('k')).toBe(false);
  });

  it('fields a record cannot have are refused before a byte is read', async () => {
    const { flow, stream } = producer(2);
    const { store, objects } = memoryStore(flow);
    await expect(
      putAttachmentBytes(store, 'k', { ...FIELDS, filename: '' }, { stream, length: 2 * CHUNK }, nodeSha256),
    ).rejects.toThrow();
    expect(flow.produced).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('a stream carrying another length than it declared is refused by the store write', async () => {
    const { store } = memoryStore();
    const { stream } = producer(3);
    await expect(
      putAttachmentBytes(store, 'k', FIELDS, { stream, length: 2 * CHUNK }, nodeSha256),
    ).rejects.toThrow(/more than/);
  });
});

describe('knownLengthStream and knownLengthInit (#2498)', () => {
  afterEach(() => {
    delete (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream;
  });

  it('off workerd: the stream held to its length, half-duplex, with the length as Content-Length', async () => {
    const { stream } = producer(2);
    const sent = knownLengthInit({ method: 'PUT', headers: { 'x-a': 'b' }, body: { stream, length: 2 * CHUNK } });
    expect(sent.method).toBe('PUT');
    expect(sent.headers).toEqual({ 'x-a': 'b', 'content-length': String(2 * CHUNK) });
    expect(sent.duplex).toBe('half');
    expect(await drain(sent.body)).toEqual(expected(2));
    await expect(drain(knownLengthStream({ stream: producer(3).stream, length: 2 * CHUNK }))).rejects.toThrow(/more than/);
  });

  it("on workerd: piped through the runtime's FixedLengthStream at the declared length", async () => {
    const lengths: number[] = [];
    (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream<Uint8Array, Uint8Array> {
      constructor(length: number) {
        super();
        lengths.push(length);
      }
    };
    const { stream } = producer(2);
    const sent = knownLengthInit({ headers: { 'x-a': 'b' }, body: { stream, length: 2 * CHUNK } });
    expect(lengths).toEqual([2 * CHUNK]);
    expect(sent.headers).toEqual({ 'x-a': 'b' });
    expect(sent.duplex).toBeUndefined();
    expect(await drain(sent.body)).toEqual(expected(2));
  });
});

describe('globalFetch with a sized stream body (#2498)', () => {
  /** A server that reads each request body as it arrives and reports what it saw. */
  async function server() {
    const seen: { headers: IncomingHttpHeaders; size: number; sha256: string }[] = [];
    const srv = createServer((req, res) => {
      const hash = createHash('sha256');
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        hash.update(chunk);
      });
      req.on('end', () => {
        seen.push({ headers: req.headers, size, sha256: hash.digest('hex') });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/upload`;
    return { url, seen, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
  }

  it('sends the stream at its declared length, not chunked, every byte intact', async () => {
    const s = await server();
    try {
      const { stream } = producer(64);
      const res = await globalFetch(s.url, { method: 'PUT', headers: { 'x-a': 'b' }, body: { stream, length: 64 * CHUNK } });
      expect(res.ok).toBe(true);
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0]!.headers['content-length']).toBe(String(64 * CHUNK));
      expect(s.seen[0]!.headers['transfer-encoding']).toBeUndefined();
      expect(s.seen[0]!.headers['x-a']).toBe('b');
      expect({ sha256: s.seen[0]!.sha256, size: s.seen[0]!.size }).toEqual(expected(64));
      // The response's body is there as a stream, the seam's `ConnectorResponse.body`.
      expect(res.body).toBeTruthy();
      expect(await drain(res.body!)).toEqual({ sha256: createHash('sha256').update('ok').digest('hex'), size: 2 });
    } finally {
      await s.close();
    }
  });

  it('any runtime fetch made a FetchLike by fetchLikeOf sends it the same way, not as "[object Object]"', async () => {
    const s = await server();
    try {
      const bound = globalThis.fetch.bind(globalThis);
      await fetchLikeOf(bound)(s.url, { method: 'PUT', body: { stream: producer(8).stream, length: 8 * CHUNK } });
      // The twin: the same fetch cast to a FetchLike and handed the sized body as it is.
      await (bound as unknown as FetchLike)(s.url, { method: 'PUT', body: { stream: producer(1).stream, length: CHUNK } });
      expect(s.seen[0]!.headers['content-length']).toBe(String(8 * CHUNK));
      expect({ sha256: s.seen[0]!.sha256, size: s.seen[0]!.size }).toEqual(expected(8));
      expect(s.seen[1]!.size).toBe('[object Object]'.length);
    } finally {
      await s.close();
    }
  });

  it("fetchLikeOf keeps the caller's signal when it converts a sized body: the connection's timeout rides on it", async () => {
    const signal = AbortSignal.abort(new Error('the caller gave up'));
    const handed: unknown[] = [];
    const recording = fetchLikeOf(async (_input: string, init?: { signal?: unknown }) => {
      handed.push(init?.signal);
      return { ok: true, status: 200 } as never;
    });
    await recording('https://provider.invalid/upload', { method: 'PUT', signal, body: { stream: producer(1).stream, length: CHUNK } });
    expect(handed).toEqual([signal]);
    // And a real fetch, handed it through the conversion, is cancelled by it.
    const real = fetchLikeOf(globalThis.fetch.bind(globalThis));
    await expect(
      real('http://127.0.0.1:9/upload', { method: 'PUT', signal, body: { stream: producer(1).stream, length: CHUNK } }),
    ).rejects.toThrow(/gave up/);
  });

  it("a compressed response's body stream carries the decoded bytes, which its Content-Length does not count", async () => {
    const plain = new Uint8Array(64 * 1024).fill(7);
    const zipped = gzipSync(plain);
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(zipped.byteLength) });
      res.end(zipped);
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
      const res = await globalFetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/file`);
      expect(res.headers?.get('content-length')).toBe(String(zipped.byteLength));
      const read = await drain(res.body!);
      // What the doc on `ConnectorResponse.body` warns of: the stream is the file, decoded.
      expect(read.size).toBe(plain.byteLength);
      expect(read.size).not.toBe(zipped.byteLength);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('the positive twin: a string or byte body goes to the runtime untouched', async () => {
    const s = await server();
    try {
      const bytes = new TextEncoder().encode('plain bytes');
      await globalFetch(s.url, { method: 'POST', body: 'a string body' });
      await globalFetch(s.url, { method: 'POST', body: bytes });
      expect(s.seen.map((r) => r.size)).toEqual([13, 11]);
    } finally {
      await s.close();
    }
  });
});

describe('connectorUploadBody (#2538)', () => {
  const BOUND = CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES;

  it('keeps a buffer at or under the buffered bound as the buffer itself', () => {
    const at = new Uint8Array(BOUND);
    // Identity by `===`: a failing `toBe` would try to diff 16 MiB of numbers.
    expect(connectorUploadBody(at) === at).toBe(true);
  });

  it('hands a buffer over the bound as a sized stream carrying exactly its bytes', async () => {
    const bytes = new Uint8Array(BOUND + 5).map((_, i) => i % 251);
    const body = connectorUploadBody(bytes);
    expect(isSizedByteStream(body)).toBe(true);
    if (!isSizedByteStream(body)) return;
    expect(body.length).toBe(bytes.byteLength);
    const reader = body.stream.getReader();
    const hash = createHash('sha256');
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value!.byteLength;
      hash.update(value!);
    }
    expect(size).toBe(bytes.byteLength);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
