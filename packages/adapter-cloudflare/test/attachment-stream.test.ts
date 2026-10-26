import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { attachmentBlobKey, ulid, webCryptoSecretBox, type SizedByteStream } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from './test-host.js';
import { r2TenantBlobStore, workerdSha256, type R2BlobStores } from '../src/r2.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * A streamed attachment upload on workerd, into a REAL R2 bucket (#2498).
 *
 * The body is 144 MiB, more than the 128 MB a Worker may hold, made one 1 MiB chunk at a time
 * and only when asked for. It reaches R2 through the host's own path: the attachment surface,
 * `putAttachmentBytes` hashing it with workerd's `DigestStream` as it passes, and the R2 store
 * putting it as a `FixedLengthStream`, which R2 requires (a stream of unknown length is refused).
 *
 * The bound is measured by the producer: each time it is asked for a chunk it records how far
 * it has got ahead of what has reached the bucket. A step that collected the body would drain it
 * while the bucket has read nothing, and the lead would be all 144 MiB.
 */
describe('streamed attachment upload (cloudflare host, real R2)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const PERM_READ = permissionKey.parse('perm:read');
  const PERM_USE = permissionKey.parse('perm:use');

  const MiB = 1024 * 1024;
  const chunkOf = (i: number): Uint8Array => new Uint8Array(MiB).fill(i % 251);
  const flow = { produced: 0, reached: 0, maxLead: 0 };

  const producer = (chunks: number): ReadableStream<Uint8Array> => {
    let i = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (i === chunks) return controller.close();
          const chunk = chunkOf(i++);
          flow.produced += chunk.byteLength;
          flow.maxLead = Math.max(flow.maxLead, flow.produced - flow.reached);
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
  };

  /** The sha256 of the generated body, through the same running digest the host uses. */
  async function sha256Of(chunks: number): Promise<string> {
    const digest = workerdSha256();
    for (let i = 0; i < chunks; i++) await digest.update(chunkOf(i));
    return digest.hex();
  }

  /**
   * The real bucket, with each streamed put counted as it leaves the store. The store's own
   * stream goes to R2 as it is (a `tee` keeps a known length, and R2 judges it), so a store that
   * handed R2 a stream of unknown length is refused here exactly as in production. The other half
   * of the tee is read as it arrives and counted, which is what the producer's lead is measured
   * against.
   */
  const countingBucket = () => ({
    put: async (key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView, options?: R2PutOptions) => {
      if (!(value instanceof ReadableStream)) return env.STREAM_BUCKET.put(key, value, options);
      const [toBucket, toCount] = value.tee();
      const counting = (async () => {
        const reader = toCount.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) return;
          flow.reached += chunk.byteLength;
        }
      })();
      const [put] = await Promise.all([env.STREAM_BUCKET.put(key, toBucket, options), counting]);
      return put;
    },
    get: (key: string) => env.STREAM_BUCKET.get(key),
    head: (key: string) => env.STREAM_BUCKET.head(key),
    delete: (key: string) => env.STREAM_BUCKET.delete(key),
    list: (options?: R2ListOptions) => env.STREAM_BUCKET.list(options),
  });

  const fakeR2: R2BlobStores = { create: async (name) => name, remove: async () => {} };

  const world = async () => {
    Object.assign(flow, { produced: 0, reached: 0, maxLead: 0 });
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      blobStores: fakeR2,
      attachmentBuckets: () => countingBucket(),
      attachmentExtractors: [],
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(permMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor = principalId.parse(ulid());
    const reader = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'viewer', permissions: [PERM_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: reader, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    return { host, t, s, editor, reader };
  };

  const item = { entityType: 'item', entityId: 'i1' };
  const upload = (body: Uint8Array | SizedByteStream) => ({
    entity: item,
    filename: 'drawing-set.pdf',
    contentType: 'application/pdf',
    visibility: 'internal' as const,
    body,
  });

  /** Every object R2 holds under the scope's prefix. */
  const objectsUnder = async (s: string) =>
    (await env.STREAM_BUCKET.list({ prefix: `scope/${s}/` })).objects.map((o) => o.key);

  it('lands a 144 MiB body as it is read, witnessed by sha256 and size, never held whole', async () => {
    const CHUNKS = 144;
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    const rec = await att.upload(upload({ stream: producer(CHUNKS), length: CHUNKS * MiB }));

    expect(rec.size).toBe(CHUNKS * MiB);
    expect(rec.sha256).toBe(await sha256Of(CHUNKS));
    expect(flow.reached).toBe(CHUNKS * MiB);
    // A handful of chunks in flight between the producer and the bucket, out of 144.
    expect(flow.maxLead).toBeLessThanOrEqual(8 * MiB);

    const head = await env.STREAM_BUCKET.head(attachmentBlobKey(s, rec.id));
    expect(head?.size).toBe(CHUNKS * MiB);
    expect(head?.httpMetadata?.contentType).toBe('application/pdf');
    expect((await att.list(item)).map((r) => r.id)).toEqual([rec.id]);
    // Moving and hashing 144 MiB through the local R2 takes seconds, past the 5 s default on a
    // loaded CI runner; the time is the body's size, not a hang, so it gets its own allowance.
  }, 120_000);

  it('the positive twin: a buffer of the same bytes gets the same witness, through the same bucket', async () => {
    const CHUNKS = 4;
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    const whole = new Uint8Array(CHUNKS * MiB);
    for (let i = 0; i < CHUNKS; i++) whole.set(chunkOf(i), i * MiB);
    const buffered = await att.upload(upload(whole));
    const streamed = await att.upload(upload({ stream: producer(CHUNKS), length: CHUNKS * MiB }));
    expect(buffered.sha256).toBe(await sha256Of(CHUNKS));
    expect(streamed.sha256).toBe(buffered.sha256);
    expect(streamed.size).toBe(buffered.size);
    const opened = await att.open(streamed.id);
    expect(opened!.body.byteLength).toBe(CHUNKS * MiB);
  });

  it('a stream carrying more than it declared lands no object and no row', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    await expect(att.upload(upload({ stream: producer(3), length: 2 * MiB }))).rejects.toThrow();
    expect(await att.list(item)).toEqual([]);
    expect(await objectsUnder(s)).toEqual([]);
  });

  // The local R2 simulator logs an uncaught "Network connection lost" from its own service when
  // the stream it is reading errors. It is that service's, not this worker's: the rejection setup
  // file does not count it, and it is logged with the bucket put going straight to R2 too.
  it('a stream ending short of what it declared lands no object and no row', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    await expect(att.upload(upload({ stream: producer(1), length: 2 * MiB }))).rejects.toThrow();
    expect(await att.list(item)).toEqual([]);
    expect(await objectsUnder(s)).toEqual([]);
  });

  it('a caller who may not write is refused before the first byte is read (#2516)', async () => {
    const { host, t, s, reader } = await world();
    const att = await host.attachments(reader, t, s);
    await expect(att.upload(upload({ stream: producer(2), length: 2 * MiB }))).rejects.toThrow();
    // Nothing was pulled from the producer or reached the bucket: no object to delete.
    expect(flow.produced).toBe(0);
    expect(flow.reached).toBe(0);
    expect(await att.list(item)).toEqual([]);
    expect(await objectsUnder(s)).toEqual([]);
  });

  it('its twin: a caller who may write is let through and the object lands first, as before', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    const rec = await att.upload(upload({ stream: producer(2), length: 2 * MiB }));
    expect(flow.reached).toBe(2 * MiB);
    expect(await objectsUnder(s)).toEqual([attachmentBlobKey(s, rec.id)]);
  });

  it('a refused buffered write still lands its object and then deletes it (the pre-check is for streams)', async () => {
    const { host, t, s, reader } = await world();
    const att = await host.attachments(reader, t, s);
    await expect(att.upload(upload(new Uint8Array(MiB)))).rejects.toThrow();
    expect(await objectsUnder(s)).toEqual([]);
  });

  it("the R2 store gives R2 a stream of the declared length, with no wrapper restoring it", async () => {
    const store = r2TenantBlobStore(env.STREAM_BUCKET);
    const key = `direct/${ulid()}`;
    await store.put(key, { stream: producer(3), length: 3 * MiB }, { contentType: 'application/pdf' });
    expect((await env.STREAM_BUCKET.head(key))?.size).toBe(3 * MiB);
  });

  it('why the store converts it: R2 refuses a stream that does not know its length', async () => {
    await expect(env.STREAM_BUCKET.put(`direct/${ulid()}`, producer(1))).rejects.toThrow(/known length/);
  });
});
