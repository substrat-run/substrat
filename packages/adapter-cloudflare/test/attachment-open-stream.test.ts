import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { attachmentBlobKey, knownLengthStream, ulid, webCryptoSecretBox, type ByteStream } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from './test-host.js';
import { workerdSha256, type R2BlobStores } from '../src/r2.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * A streamed attachment open on workerd (#2514): the read gate is asked in the scope's DO before the
 * bucket is touched, and the object is then read from R2 as the consumer reads it, checked against
 * the record's size and sha256 as it passes.
 *
 * Two buckets. The real one (miniflare's R2) proves the bytes and the integrity failures end to end.
 * The bound is proved on a stand-in whose `get` makes the object one 1 MiB chunk at a time, only when
 * asked for, and measures how far it has got ahead of the consumer: a step that collected the object
 * would drain it while the consumer has read nothing, and the lead would be all of it. That one is
 * 144 MiB, more than the 128 MB a Worker may hold, and costs no R2 I/O, so it stays in the suite's
 * time budget: R2's own read path is not this change's, and the real-bucket cases cover it at 8 MiB.
 */
describe('streamed attachment open (cloudflare host)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const PERM_READ = permissionKey.parse('perm:read');
  const PERM_USE = permissionKey.parse('perm:use');

  const MiB = 1024 * 1024;
  const chunkOf = (i: number): Uint8Array => new Uint8Array(MiB).fill(i % 251);
  const flow = { gets: 0, produced: 0, consumed: 0, maxLead: 0, cancelled: 0 };

  const producer = (chunks: number): ReadableStream<Uint8Array> => {
    let i = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (i === chunks) return controller.close();
          const chunk = chunkOf(i++);
          flow.produced += chunk.byteLength;
          flow.maxLead = Math.max(flow.maxLead, flow.produced - flow.consumed);
          controller.enqueue(chunk);
        },
        cancel() {
          flow.cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
  };

  /** The real bucket, with every `get` counted. */
  const realBucket = () => ({
    put: (key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView, options?: R2PutOptions) =>
      env.STREAM_BUCKET.put(key, value, options),
    get: async (key: string) => {
      flow.gets++;
      return env.STREAM_BUCKET.get(key);
    },
    delete: (key: string) => env.STREAM_BUCKET.delete(key),
    list: (options?: R2ListOptions) => env.STREAM_BUCKET.list(options),
  });

  /**
   * No storage at all: a put reads its stream to the end and keeps only the size, and a get makes the
   * object again from `producer`, so the bytes it serves are the bytes that were put.
   */
  const generatingBucket = () => {
    const sizes = new Map<string, number>();
    return {
      put: async (key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView) => {
        if (!(value instanceof ReadableStream)) throw new Error('the generating bucket takes streams only');
        const reader = value.getReader();
        let size = 0;
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
        }
        sizes.set(key, size);
      },
      get: async (key: string) => {
        flow.gets++;
        const size = sizes.get(key);
        if (size === undefined) return null;
        return { body: producer(size / MiB), size, httpMetadata: { contentType: 'application/pdf' }, arrayBuffer: () => { throw new Error('never buffered'); } };
      },
      delete: async (key: string) => void sizes.delete(key),
      list: async () => ({ objects: [...sizes.keys()].map((key) => ({ key })), truncated: false }),
    };
  };

  const fakeR2: R2BlobStores = { create: async (name) => name, remove: async () => {} };

  const world = async (makeBucket: () => unknown) => {
    Object.assign(flow, { gets: 0, produced: 0, consumed: 0, maxLead: 0, cancelled: 0 });
    // One bucket for the world: the host resolves it on every door.
    const bucket = makeBucket();
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      blobStores: fakeR2,
      attachmentBuckets: () => bucket,
      attachmentExtractors: [],
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(permMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor = principalId.parse(ulid());
    const reader = principalId.parse(ulid());
    const outsider = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'viewer', permissions: [PERM_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: reader, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    return { host, t, s, editor, reader, outsider };
  };

  /** Land `chunks` MiB as the editor; the record, with the bucket's counters reset. */
  const landed = async (w: Awaited<ReturnType<typeof world>>, chunks: number) => {
    const att = await w.host.attachments(w.editor, w.t, w.s);
    const record = await att.upload({
      entity: { entityType: 'item', entityId: 'i1' },
      filename: 'drawing-set.pdf',
      contentType: 'application/pdf',
      visibility: 'internal',
      body: { stream: producer(chunks), length: chunks * MiB },
    });
    Object.assign(flow, { gets: 0, produced: 0, consumed: 0, maxLead: 0, cancelled: 0 });
    return record;
  };

  /**
   * Read to the end, slowly when counting: a macrotask each time another MiB has been read. Per MiB
   * rather than per chunk, because the fixed-length stream hands its bytes on in small pieces, and a
   * timer for each would spend a minute waiting without making the reader any slower per MiB.
   */
  async function read(stream: ByteStream, count = false) {
    const reader = stream.getReader();
    const digest = workerdSha256();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { ok: true as const, size, sha256: await digest.hex() };
        const before = size;
        size += value!.byteLength;
        await digest.update(value!);
        if (count) {
          flow.consumed = size;
          if (Math.floor(size / MiB) > Math.floor(before / MiB)) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      return { ok: false as const, size, error: (error as Error).message };
    }
  }

  it('streams a 144 MiB object to a slow reader without holding it, verified at the end', async () => {
    const w = await world(generatingBucket);
    const record = await landed(w, 144);
    const opened = await (await w.host.attachments(w.reader, w.t, w.s)).openStream(record.id);
    expect(opened!.body.length).toBe(144 * MiB);
    // Read as the route sends it: through the runtime's fixed-length stream.
    const out = await read(knownLengthStream(opened!.body), true);
    expect(out).toEqual({ ok: true, size: 144 * MiB, sha256: record.sha256 });
    // A handful of chunks in flight between the bucket and the reader, out of 144.
    expect(flow.maxLead).toBeLessThanOrEqual(8 * MiB);
  }, 120_000);

  it('real R2: the bytes, the record and the content type the upload stored', async () => {
    const w = await world(realBucket);
    const record = await landed(w, 8);
    const opened = await (await w.host.attachments(w.reader, w.t, w.s)).openStream(record.id);
    expect(opened!.record).toEqual(record);
    expect(opened!.contentType).toBe('application/pdf');
    expect(await read(knownLengthStream(opened!.body))).toEqual({ ok: true, size: 8 * MiB, sha256: record.sha256 });
    expect(flow.gets).toBe(1);
  }, 30_000);

  it('a refused read touches the bucket zero times', async () => {
    const w = await world(realBucket);
    const record = await landed(w, 1);
    await expect((await w.host.attachments(w.outsider, w.t, w.s)).openStream(record.id)).rejects.toThrow(/denied|perm:read/i);
    expect(flow.gets).toBe(0);
  });

  it('an id the scope does not know is null, and touches the bucket zero times', async () => {
    const w = await world(realBucket);
    expect(await (await w.host.attachments(w.reader, w.t, w.s)).openStream(ulid())).toBeNull();
    expect(flow.gets).toBe(0);
  });

  it('real R2: bytes replaced at the same size error the stream before its last chunk, also through a fixed-length stream', async () => {
    const w = await world(realBucket);
    const record = await landed(w, 4);
    await env.STREAM_BUCKET.put(attachmentBlobKey(w.s, record.id), new Uint8Array(4 * MiB).fill(9));
    const att = await w.host.attachments(w.reader, w.t, w.s);
    const direct = await read((await att.openStream(record.id))!.body.stream);
    expect(direct).toMatchObject({ ok: false, error: expect.stringMatching(/do not match the recorded sha256/) });
    expect(direct.size).toBeLessThan(4 * MiB);
    // As the route sends it: the fixed-length stream is short, so its reader errors too, never a whole file.
    const sent = await read(knownLengthStream((await att.openStream(record.id))!.body));
    expect(sent.ok).toBe(false);
    expect(sent.size).toBeLessThan(4 * MiB);
  }, 30_000);

  it('real R2: an object that is not the recorded size is refused before a byte is handed on', async () => {
    const w = await world(realBucket);
    const record = await landed(w, 2);
    await env.STREAM_BUCKET.put(attachmentBlobKey(w.s, record.id), new Uint8Array(MiB));
    await expect((await w.host.attachments(w.reader, w.t, w.s)).openStream(record.id)).rejects.toThrow(
      new RegExp(`attachment ${record.id}: the stored object is ${MiB} bytes; its record says ${2 * MiB}`),
    );
  });

  it('a reader that cancels cancels the object it was reading', async () => {
    const w = await world(generatingBucket);
    const record = await landed(w, 16);
    const opened = await (await w.host.attachments(w.reader, w.t, w.s)).openStream(record.id);
    const reader = opened!.body.stream.getReader();
    await reader.read();
    await reader.cancel('done early');
    expect(flow.cancelled).toBe(1);
    expect(flow.produced).toBeLessThan(16 * MiB);
  });
});
