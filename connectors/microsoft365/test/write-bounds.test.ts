import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@substrat-run/contracts';
import { bytesStream, type ConnectorContext } from '@substrat-run/kernel';
import { MAX_EVENT_BYTES, MAX_FILE_BYTES, microsoft365FilesConnector, type Microsoft365FilesRequested } from '../src/index.js';
import { APP_ID, DRIVE, FakeDrive, GRAPH, LOGIN } from './fake-drive.js';

/**
 * What one write delivery holds (#2101 r1): one attachment's bytes at a time, and nothing at all
 * when the declared sizes are over a cap. Driven through a stand-in dispatch context, so every
 * attachment read is visible in order beside the Graph calls.
 */
function harness(sizes: Record<string, number>, opts: { actual?: Record<string, number> } = {}) {
  const drive = new FakeDrive();
  const general = drive.mkdir('root', 'General');
  const state = new Map<string, unknown>([
    [
      'microsoft365:binding:01SCOPE',
      { scopeId: '01SCOPE', tenantId: '01TENANT', vertical: 'docs', operation: 'docs/land', permission: 'docs:land', folder: 'General', driveId: DRIVE, folderItemId: general, boundAt: '' },
    ],
  ]);
  const log: string[] = [];
  const fetch: typeof drive.fetch = async (input, init) => {
    const session = /:\/([^:]+):\/createUploadSession$/.exec(input);
    if (session) log.push(`session:${decodeURIComponent(session[1]!)}`);
    return drive.fetch(input, init);
  };
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
      openAttachmentStream: async (id: string) => {
        log.push(`open:${id}`);
        const size = opts.actual?.[id] ?? sizes[id]!;
        return {
          record: { id, filename: `${id}.bin`, size, contentType: 'application/octet-stream' },
          body: bytesStream(new Uint8Array(size).fill(1)),
          contentType: 'application/octet-stream',
        };
      },
    }),
  } as unknown as ConnectorContext;
  const run = (payload: Microsoft365FilesRequested) =>
    microsoft365FilesConnector({ fetch, loginBase: LOGIN, graphBase: GRAPH })(ctx, {
      id: '01EVENT',
      type: 'microsoft365.channel-files-requested',
      payload,
    } as unknown as DomainEvent);
  return { drive, general, log, state, run };
}

describe('a write delivery holds one file at a time', () => {
  it('reads, uploads and records each file before reading the next', async () => {
    const mb = 1024 * 1024;
    const sizes = { a: 30 * mb, b: 30 * mb, c: 30 * mb };
    const h = harness(sizes);
    await h.run({ files: Object.entries(sizes).map(([attachmentId, size]) => ({ attachmentId, size })), conflict: 'fail' });
    // Each 30 MB file is one upload session, and the next file is read only after it.
    expect(h.log).toEqual(['open:a', 'session:a.bin', 'open:b', 'session:b.bin', 'open:c', 'session:c.bin']);
    expect(h.drive.childrenNamed(h.general)).toEqual(['a.bin', 'b.bin', 'c.bin']);
  });

  it('refuses an event over the total cap before reading anything', async () => {
    const h = harness({ a: MAX_FILE_BYTES, b: MAX_FILE_BYTES, c: 1 });
    expect(MAX_FILE_BYTES * 2 + 1).toBeGreaterThan(MAX_EVENT_BYTES);
    await expect(
      h.run({ files: ['a', 'b', 'c'].map((attachmentId) => ({ attachmentId, size: attachmentId === 'c' ? 1 : MAX_FILE_BYTES })), conflict: 'fail' }),
    ).rejects.toThrow(/most one event may move/);
    expect(h.log).toEqual([]);
    expect(h.drive.calls).toEqual([]);
  });

  it('admits an event at exactly the total cap (the positive twin)', async () => {
    const h = harness({ a: MAX_FILE_BYTES, b: MAX_EVENT_BYTES - MAX_FILE_BYTES });
    await h.run({ files: [{ attachmentId: 'a', size: MAX_FILE_BYTES }, { attachmentId: 'b', size: MAX_EVENT_BYTES - MAX_FILE_BYTES }], conflict: 'fail' });
    expect(h.drive.childrenNamed(h.general)).toEqual(['a.bin', 'b.bin']);
  });

  it('refuses an event naming one attachment twice, before reading anything', async () => {
    const h = harness({ a: 10 });
    await expect(
      h.run({ files: [{ attachmentId: 'a', size: 10, name: 'a.pdf' }, { attachmentId: 'a', size: 10, name: 'b.pdf' }], conflict: 'fail' }),
    ).rejects.toThrow(/named more than once/);
    expect(h.log).toEqual([]);
    expect(h.drive.calls).toEqual([]);
  });

  it('refuses a file whose attachment is not the size the event declared', async () => {
    const h = harness({ a: 10 }, { actual: { a: 11 } });
    await expect(h.run({ files: [{ attachmentId: 'a', size: 10 }], conflict: 'fail' })).rejects.toThrow(/not the 10 bytes/);
    expect(h.drive.graphCalls().filter((c) => c.method === 'PUT')).toEqual([]);
  });
});
