import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { attachmentBlobKey, ulid, webCryptoSecretBox, type SizedByteStream } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from './test-host.js';
import type { R2BlobStores } from '../src/r2.js';
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

  async function sha256Of(chunks: number): Promise<string> {
    const digest = new crypto.DigestStream('SHA-256');
    const writer = digest.getWriter();
    for (let i = 0; i < chunks; i++) await writer.write(chunkOf(i));
    await writer.close();
    return [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * The real bucket, with each streamed put counted as it reaches it. The stream the host hands
   * over is known-length; once it passes the counter it is not, so it is given its length again
   * (`declared`), as the host did.
   */
  const countingBucket = (declared: () => number) => ({
    put: (key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView, options?: R2PutOptions) => {
      if (!(value instanceof ReadableStream)) return env.STREAM_BUCKET.put(key, value, options);
      const counted = value.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            flow.reached += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
      return env.STREAM_BUCKET.put(key, counted.pipeThrough(new FixedLengthStream(declared())), options);
    },
    get: (key: string) => env.STREAM_BUCKET.get(key),
    head: (key: string) => env.STREAM_BUCKET.head(key),
    delete: (key: string) => env.STREAM_BUCKET.delete(key),
    list: (options?: R2ListOptions) => env.STREAM_BUCKET.list(options),
  });

  const fakeR2: R2BlobStores = { create: async (name) => name, remove: async () => {} };

  const world = async (declared: () => number) => {
    Object.assign(flow, { produced: 0, reached: 0, maxLead: 0 });
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      blobStores: fakeR2,
      attachmentBuckets: () => countingBucket(declared),
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
    const { host, t, s, editor } = await world(() => CHUNKS * MiB);
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
  });

  it('the positive twin: a buffer of the same bytes gets the same witness, through the same bucket', async () => {
    const CHUNKS = 4;
    const { host, t, s, editor } = await world(() => CHUNKS * MiB);
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
    const { host, t, s, editor } = await world(() => 2 * MiB);
    const att = await host.attachments(editor, t, s);
    await expect(att.upload(upload({ stream: producer(3), length: 2 * MiB }))).rejects.toThrow();
    expect(await att.list(item)).toEqual([]);
    expect(await objectsUnder(s)).toEqual([]);
  });

  // The local R2 simulator logs an uncaught "Network connection lost" from its own service when
  // the stream it is reading errors. It is that service's, not this worker's: the rejection setup
  // file does not count it, and it is logged with the bucket put going straight to R2 too.
  it('a stream ending short of what it declared lands no object and no row', async () => {
    const { host, t, s, editor } = await world(() => 2 * MiB);
    const att = await host.attachments(editor, t, s);
    await expect(att.upload(upload({ stream: producer(1), length: 2 * MiB }))).rejects.toThrow();
    expect(await att.list(item)).toEqual([]);
    expect(await objectsUnder(s)).toEqual([]);
  });

  it('a refused write lands the object first, then deletes it', async () => {
    const { host, t, s, reader } = await world(() => 2 * MiB);
    const att = await host.attachments(reader, t, s);
    await expect(att.upload(upload({ stream: producer(2), length: 2 * MiB }))).rejects.toThrow();
    expect(flow.reached).toBe(2 * MiB);
    expect(await objectsUnder(s)).toEqual([]);
  });
});
