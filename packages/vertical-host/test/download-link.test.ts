/**
 * The download-link route (#3139): what it answers for each thing the host says, that the secret
 * never reaches a response body or the invocation log, and that a secret of the wrong shape costs
 * the host nothing. What a link reads, and as whom, is `downloadLinkContractSuite`'s, on both adapters.
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_LINK_PATH_PREFIX,
  DOWNLOAD_LINK_SECRET_PREFIX,
  scopeId,
  substratError,
  tenantId,
  type AttachmentRecord,
} from '@substrat-run/contracts';
import { DOWNLOAD_LINK_GONE, bytesStream, openAttachmentByteStream, ulid, type TenantBlobStore } from '@substrat-run/kernel';
import {
  DOWNLOAD_LINK_LOG_PREFIX,
  DOWNLOAD_LINK_LOG_SECRET_PREFIX,
  mountDownloadLinkRedeem,
  redactUploadLinkSecret,
} from '../src/index.js';

const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };
const SECRET = DOWNLOAD_LINK_SECRET_PREFIX + 'A'.repeat(43);
const BYTES = new TextEncoder().encode('the recording');
const record = {
  id: 'att-1',
  entity: { entityType: 'item', entityId: 'i1' },
  filename: 'clip.mp3',
  contentType: 'audio/mpeg',
  visibility: 'internal',
  createdBy: 'p1',
  createdAt: '2026-11-13T00:00:00.000Z',
  size: BYTES.byteLength,
  sha256: createHash('sha256').update(BYTES).digest('hex'),
} as AttachmentRecord;
const store: TenantBlobStore = {
  put: async () => {},
  get: async () => null,
  getStream: async () => ({ stream: bytesStream(BYTES).stream, size: BYTES.byteLength }),
  getRangeStream: async (_k, { offset, length }) => ({ stream: bytesStream(BYTES.slice(offset, offset + length)).stream, size: BYTES.byteLength }),
  delete: async () => {},
  list: async () => [],
};
const sha256 = () => {
  const hash = createHash('sha256');
  return { update: (chunk: Uint8Array) => void hash.update(chunk), hex: async () => hash.digest('hex') };
};

/** A route over a host whose `openDownloadLink` serves `att-1`, or throws `fails`. */
function route(fails?: unknown) {
  const openDownloadLink = vi.fn(async (_t: unknown, _s: unknown, _secret: string, id: string, options?: { range?: never }) => {
    if (fails) throw fails;
    return id === record.id ? openAttachmentByteStream(store, 'k', record, sha256, options?.range) : null;
  });
  const app = new Hono();
  mountDownloadLinkRedeem(app, { host: () => ({ openDownloadLink }), node: () => node });
  const get = (secret = SECRET, headers: Record<string, string> = {}) =>
    app.request(`${DOWNLOAD_LINK_PATH_PREFIX}/${record.id}/${secret}`, { headers });
  return { get, openDownloadLink };
}

describe('mountDownloadLinkRedeem', () => {
  it('serves the file the link names, in the routed scope, seekable', async () => {
    const { get, openDownloadLink } = route();
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('the recording');
    expect(openDownloadLink).toHaveBeenCalledWith(node.tenantId, node.scopeId, SECRET, record.id, undefined);
    const ranged = await get(SECRET, { Range: 'bytes=4-' });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('recording');
    expect(ranged.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a secret of the wrong shape 404 without asking the host', async () => {
    const { get, openDownloadLink } = route();
    expect((await get('nonsense')).status).toBe(404);
    expect(openDownloadLink).not.toHaveBeenCalled();
  });

  it.each([
    ['an expired or revoked link', substratError('conflict', 'gone', { reason: DOWNLOAD_LINK_GONE }), 410],
    ['a minter who can no longer read the file', substratError('permission_denied', 'no'), 403],
    ['an unknown link', substratError('not_found', 'no'), 404],
  ])('answers %s with %i, and no body carries the secret', async (_label, err, status) => {
    const res = await route(err).get();
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.text()).not.toContain(SECRET);
  });

  it('answers a file removed since the mint with 404', async () => {
    const app = new Hono();
    mountDownloadLinkRedeem(app, { host: () => ({ openDownloadLink: async () => null }), node: () => node });
    expect((await app.request(`${DOWNLOAD_LINK_PATH_PREFIX}/${record.id}/${SECRET}`)).status).toBe(404);
  });
});

describe('the invocation log, for a download link', () => {
  it('names the same path and secret prefix the contracts mint', () => {
    expect(DOWNLOAD_LINK_LOG_PREFIX).toBe(DOWNLOAD_LINK_PATH_PREFIX);
    expect(DOWNLOAD_LINK_LOG_SECRET_PREFIX).toBe(DOWNLOAD_LINK_SECRET_PREFIX);
  });

  it.each([
    [`/api/attachment-downloads/att-1/${SECRET}`, '/api/attachment-downloads/att-1/[redacted]'],
    ['/api/attachment-downloads/att-1/whatever', '/api/attachment-downloads/att-1/[redacted]'],
    [`/files/${SECRET}/raw`, '/files/[redacted]/raw'],
    ['/api/attachments/att-1', '/api/attachments/att-1'],
  ])('redacts %s', (path, logged) => {
    expect(redactUploadLinkSecret(path)).toBe(logged);
  });
});
