import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@substrat-run/contracts';
import { verifiedStream, type ConnectorContext, type FetchLike, type IncrementalSha256, type SizedByteStream } from '@substrat-run/kernel';
import { UPLOAD_CHUNK_BYTES, microsoft365FilesConnector, type Microsoft365FilesRequested } from '../src/index.js';
import { APP_ID, DRIVE, FakeDrive, GRAPH, LOGIN } from './fake-drive.js';

/**
 * The write dispatch reads each attachment as a stream (#2514). A stream error means the bytes so far
 * are an unverified prefix (the platform's `STREAMED_ATTACHMENT_UNVERIFIED`), so the dispatch must
 * never commit a file from them: up to 4 MB nothing is sent before the stream has ended, and above
 * that the committing range waits for the end and a refusal cancels the session. Driven through a
 * stand-in dispatch context, so each read can be made to refuse at a chosen byte.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const UPLOAD = 'https://upload.example/';

/** The refusal an attachment stream errors with; the dispatch must throw it as it came. */
const refusal = () =>
  new Error(
    'attachment a: failed its integrity check. The bytes delivered before this error are a prefix of an unverified file: discard them, and undo anything written from them.',
  );

const byteAt = (i: number) => (i * 31 + 7) % 251;
/** Bytes `from`..`from + n` of every file here. */
const bytesFrom = (from: number, n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = byteAt(from + i);
  return out;
};
const fileOf = (size: number) => bytesFrom(0, size);

interface Flow {
  pulled: number;
}

/**
 * `size` bytes in pieces of `piece`, each made only when asked for. `refuseAt` errors the stream
 * once that many bytes were handed on; at `size` it errors in place of the end, after every byte.
 */
function source(size: number, piece: number, flow: Flow, refuseAt?: number): SizedByteStream {
  let at = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (refuseAt !== undefined && at >= refuseAt) return controller.error(refusal());
        if (at === size) return controller.close();
        const n = Math.min(piece, size - at, refuseAt === undefined ? Infinity : refuseAt - at);
        const chunk = bytesFrom(at, n);
        at += n;
        flow.pulled += n;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, length: size };
}

/** One bound folder, a stand-in dispatch context, and the attachment `a` of `size` bytes. */
function harness(size: number, opts: { piece?: number; refuse?: (open: number) => number | undefined; fetch?: (drive: FakeDrive) => FetchLike } = {}) {
  const drive = new FakeDrive();
  const general = drive.mkdir('root', 'General');
  const state = new Map<string, unknown>([
    [
      'microsoft365:binding:01SCOPE',
      { scopeId: '01SCOPE', tenantId: '01TENANT', vertical: 'docs', operation: 'docs/land', permission: 'docs:land', folder: 'General', driveId: DRIVE, folderItemId: general, boundAt: '' },
    ],
  ]);
  const flow: Flow = { pulled: 0 };
  let opens = 0;
  const fetch = opts.fetch?.(drive) ?? drive.fetch;
  const ctx = {
    admin: {
      getConnectorState: async (_id: string, key: string) => state.get(key),
      putConnectorState: async (_id: string, key: string, value: unknown) => void state.set(key, value),
    },
    tenantId: '01TENANT',
    scopeId: '01SCOPE',
    vertical: 'docs',
    connection: async () => ({
      id: '01CONN',
      provider: 'microsoft365',
      secret: { tenantId: 't', clientId: APP_ID, senders: 'office@acme.example', siteUrl: 'https://acme.sharepoint.com/sites/Team', clientSecret: 's' },
      fetch,
      openAttachment: async () => {
        throw new Error('the buffered open was asked');
      },
      openAttachmentStream: async (id: string) => {
        opens += 1;
        return {
          record: { id, filename: 'a.bin', size, contentType: 'application/octet-stream' },
          body: source(size, opts.piece ?? MiB, flow, opts.refuse?.(opens)),
          contentType: 'application/octet-stream',
        };
      },
    }),
  } as unknown as ConnectorContext;
  const run = () =>
    microsoft365FilesConnector({ fetch, loginBase: LOGIN, graphBase: GRAPH })(ctx, {
      id: '01EVENT',
      type: 'microsoft365.channel-files-requested',
      payload: { files: [{ attachmentId: 'a', size }], conflict: 'fail' } satisfies Microsoft365FilesRequested,
    } as unknown as DomainEvent);
  const ledger = () => state.get('microsoft365:write:01EVENT');
  const uploads = () => drive.calls.filter((c) => c.url.startsWith(UPLOAD) && c.method === 'PUT');
  /** A range that would make Graph commit the item: the one ending at the last byte. */
  const committing = () => uploads().filter((c) => c.headers['content-range']?.endsWith(`-${size - 1}/${size}`));
  return { drive, general, flow, run, ledger, uploads, committing, opens: () => opens };
}

describe('a streamed refusal never commits a file (#2514)', () => {
  it('over 4 MB: refused mid-way, the session is cancelled and nothing lands', async () => {
    const size = 10 * MiB;
    const h = harness(size, { refuse: () => 5 * MiB });
    const err = await h.run().catch((e: unknown) => e);
    expect((err as Error).message).toContain('discard them');
    expect(h.uploads().length).toBeGreaterThan(0); // chunks went before the refusal
    expect(h.committing()).toEqual([]);
    expect(h.drive.calls.some((c) => c.method === 'DELETE' && c.url.startsWith(UPLOAD))).toBe(true);
    expect(h.drive.openSessions()).toBe(0);
    expect(h.drive.childrenNamed(h.general)).toEqual([]);
    expect(h.ledger()).toMatchObject({ status: 'pending', files: [] });
  });

  it('over 4 MB: every byte handed on and then refused still commits nothing (the end is waited for)', async () => {
    const size = 10 * MiB;
    const h = harness(size, { refuse: () => size });
    await expect(h.run()).rejects.toThrow(/discard them/);
    expect(h.flow.pulled).toBe(size);
    expect(h.committing()).toEqual([]);
    expect(h.drive.openSessions()).toBe(0);
    expect(h.drive.childrenNamed(h.general)).toEqual([]);
  });

  it('up to 4 MB: refused mid-way, nothing is sent to Graph at all', async () => {
    const h = harness(3 * MiB, { piece: 256 * KiB, refuse: () => 2 * MiB });
    await expect(h.run()).rejects.toThrow(/discard them/);
    expect(h.drive.graphCalls().filter((c) => c.method === 'PUT')).toEqual([]);
    expect(h.drive.childrenNamed(h.general)).toEqual([]);
    expect(h.ledger()).toMatchObject({ status: 'pending', files: [] });
  });

  it('the kernel’s own verified stream, over bytes that do not match their record, commits nothing', async () => {
    const size = 6 * MiB;
    const flow: Flow = { pulled: 0 };
    const sha256 = (): IncrementalSha256 => {
      const hash = createHash('sha256');
      return { update: (c) => void hash.update(c), hex: async () => hash.digest('hex') };
    };
    const drive = new FakeDrive();
    const general = drive.mkdir('root', 'General');
    const state = new Map<string, unknown>([
      ['microsoft365:binding:01SCOPE', { scopeId: '01SCOPE', folder: 'General', driveId: DRIVE, folderItemId: general, boundAt: '' }],
    ]);
    const ctx = {
      admin: { getConnectorState: async (_: string, k: string) => state.get(k), putConnectorState: async (_: string, k: string, v: unknown) => void state.set(k, v) },
      scopeId: '01SCOPE',
      connection: async () => ({
        id: '01CONN',
        secret: { tenantId: 't', clientId: APP_ID, senders: 'office@acme.example', siteUrl: 'https://acme.sharepoint.com/sites/Team', clientSecret: 's' },
        fetch: drive.fetch,
        openAttachmentStream: async (id: string) => {
          // The record names other bytes of the same size: the digest disagrees at the end.
          const record = { id, filename: 'a.bin', size, contentType: 'application/octet-stream', sha256: createHash('sha256').update(new Uint8Array(size)).digest('hex') };
          return { record, body: verifiedStream(source(size, MiB, flow), record, sha256()), contentType: record.contentType };
        },
      }),
    } as unknown as ConnectorContext;
    const run = microsoft365FilesConnector({ fetch: drive.fetch, loginBase: LOGIN, graphBase: GRAPH })(ctx, {
      id: '01EVENT',
      payload: { files: [{ attachmentId: 'a', size }], conflict: 'fail' },
    } as unknown as DomainEvent);
    await expect(run).rejects.toThrow();
    expect(drive.calls.filter((c) => c.url.startsWith(UPLOAD) && c.headers['content-range']?.endsWith(`/${size}`) && c.headers['content-range']?.includes(`-${size - 1}/`))).toEqual([]);
    expect(drive.openSessions()).toBe(0);
    expect(drive.childrenNamed(general)).toEqual([]);
  });

  it('the twin: a stream that ends at its length lands whole', async () => {
    const size = 10 * MiB;
    const h = harness(size);
    await h.run();
    expect(h.drive.childrenNamed(h.general)).toEqual(['a.bin']);
    expect(h.committing()).toHaveLength(1);
    expect(h.ledger()).toMatchObject({ status: 'done' });
  });
});

describe('memory: over 4 MB the dispatch holds one session chunk, not the file', () => {
  it('the source is never more than a chunk and a piece ahead of what Graph received', async () => {
    const size = 20 * MiB;
    let received = 0;
    let maxLead = 0;
    const h = harness(size, {
      fetch: (drive) => async (input, init) => {
        if (input.startsWith(UPLOAD) && init?.method === 'PUT') {
          maxLead = Math.max(maxLead, h.flow.pulled - received);
          received += (init.body as Uint8Array).byteLength;
        }
        return drive.fetch(input, init);
      },
    });
    await h.run();
    expect(received).toBe(size);
    // A dispatch that collected the file first would lead by all 20 MiB.
    expect(maxLead).toBeLessThanOrEqual(UPLOAD_CHUNK_BYTES + MiB);
  });

  it('keeps about one chunk in memory for a file near the cap (the GC pattern of #2551)', async () => {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const size = 48 * MiB;
    const buffers = () => process.memoryUsage().arrayBuffers;
    let before = 0;
    let peak = 0;
    let received = 0;
    // A sink in place of the drive's upload URL, so what Graph keeps is not counted as ours.
    const h = harness(size, {
      fetch: (drive) => async (input, init) => {
        if (!(input.startsWith(UPLOAD) && init?.method === 'PUT')) return drive.fetch(input, init);
        received += (init.body as Uint8Array).byteLength;
        gc();
        await new Promise((resolve) => setTimeout(resolve, 0));
        peak = Math.max(peak, buffers() - before);
        const done = received === size;
        return new Response(JSON.stringify(done ? { id: 'item-1', name: 'a.bin' } : { nextExpectedRanges: [`${received}-`] }), {
          status: done ? 201 : 202,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Awaited<ReturnType<FetchLike>>;
      },
    });
    for (let i = 0; i < 3; i++) gc();
    before = buffers();
    await h.run();
    expect(received).toBe(size);
    // The steady state is one 3.2 MiB chunk and a 1 MiB piece. The bound is the repo's 40 MiB (#2576);
    // a dispatch that held the file would leave 48 MiB live.
    expect(peak).toBeLessThan(40 * MiB);
  }, 60_000);
});

describe('adopting on a redelivery reads the bytes again only when it has to', () => {
  /** A delivery whose upload committed and whose answer was lost: the redelivery meets its own file. */
  const lost = (h: ReturnType<typeof harness>, size: number) =>
    h.drive.lostAnswers.push({
      when: (c) => (size > 4 * MiB ? c.url.startsWith(UPLOAD) && c.headers['content-range']?.endsWith(`-${size - 1}/${size}`) === true : c.method === 'PUT'),
      once: true,
    });

  it.each([1 * MiB, 6 * MiB])("compares the app and the size before opening the stream: a person's file is not read for (%i bytes)", async (size) => {
    const h = harness(size);
    h.drive.put(h.general, 'a.bin', fileOf(size)); // same name, same size, same bytes, put by a person
    await expect(h.run()).rejects.toThrow(/exists/);
    const first = h.opens();
    await expect(h.run()).rejects.toThrow(/exists/);
    // The redelivery read the file once, for the upload: the conflict did not open it again.
    expect(h.opens() - first).toBe(1);
    expect(h.ledger()).toMatchObject({ status: 'pending', files: [] });
  });

  it("compares the size before opening the stream: the app's own file at another size is not read for", async () => {
    const size = 1 * MiB;
    const h = harness(size);
    lost(h, size);
    h.drive.misreportedSize.set('a.bin', size + 1);
    await expect(h.run()).rejects.toThrow();
    const first = h.opens();
    await expect(h.run()).rejects.toThrow(/exists/);
    expect(h.opens() - first).toBe(1);
  });

  it.each([1 * MiB, 6 * MiB])('the twin: its own file at its size is hashed from a fresh stream and adopted (%i bytes)', async (size) => {
    const h = harness(size);
    lost(h, size);
    await expect(h.run()).rejects.toThrow();
    const first = h.opens();
    await h.run();
    expect(h.opens() - first).toBe(2); // the upload's read, and the hash's
    expect(h.drive.childrenNamed(h.general)).toEqual(['a.bin']);
    expect(h.ledger()).toMatchObject({ status: 'done', files: [expect.objectContaining({ attachmentId: 'a' })] });
  });

  it.each([1 * MiB, 6 * MiB])('a refusal while the hash is folded adopts nothing and leaves the existing item untouched (%i bytes)', async (size) => {
    // The third read is the redelivery's hash read; it refuses half-way.
    const h = harness(size, { piece: 64 * KiB, refuse: (open) => (open === 3 ? size / 2 : undefined) });
    lost(h, size);
    await expect(h.run()).rejects.toThrow();
    const stored = h.drive.text(h.general, 'a.bin');
    await expect(h.run()).rejects.toThrow(/discard them/);
    expect(h.opens()).toBe(3);
    expect(h.drive.childrenNamed(h.general)).toEqual(['a.bin']);
    expect(h.drive.text(h.general, 'a.bin')).toBe(stored);
    expect(h.drive.calls.filter((c) => c.method === 'DELETE' && !c.url.startsWith(UPLOAD))).toEqual([]);
    expect(h.ledger()).toMatchObject({ status: 'pending', files: [] });
  });
});
