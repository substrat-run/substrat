import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { SERVICE_TOKEN_HEADER } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';
import { createReviewApi } from '../src/reviews.js';
import { validateReviewArchive } from '../src/review-archive.js';
import { pruneReviews, readReview, receiveReview } from '../src/review-store.js';

const bucket = (env as unknown as { REVIEW_SOURCES: R2Bucket }).REVIEW_SOURCES;
const actor = () => platformActorId.parse(ulid());
const BLOCK = 512;

function octal(block: Uint8Array, at: number, width: number, n: number): void {
  block.set(new TextEncoder().encode(n.toString(8).padStart(width - 1, '0')), at);
}

function tar(entries: { path: string; bytes?: Uint8Array; type?: number; declaredSize?: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const body = entry.bytes ?? new Uint8Array(0);
    const h = new Uint8Array(BLOCK);
    h.set(new TextEncoder().encode(entry.path), 0);
    octal(h, 100, 8, 0o644);
    octal(h, 108, 8, 0);
    octal(h, 116, 8, 0);
    octal(h, 124, 12, entry.declaredSize ?? body.length);
    octal(h, 136, 12, 0);
    h.fill(32, 148, 156);
    h[156] = entry.type ?? 48;
    h.set(new TextEncoder().encode('ustar'), 257);
    h.set(new TextEncoder().encode('00'), 263);
    octal(h, 148, 7, h.reduce((a, b) => a + b, 0));
    h[155] = 32;
    parts.push(h, body, new Uint8Array((BLOCK - body.length % BLOCK) % BLOCK));
  }
  parts.push(new Uint8Array(2 * BLOCK));
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

async function archive(entries: { path: string; bytes?: Uint8Array; type?: number; declaredSize?: number }[] = [{ path: 'src/main.ts' }]) {
  const gzip = new Blob([tar(entries)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gzip).arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { file: new File([bytes], 'source.tar.gz', { type: 'application/gzip' }), sha256 };
}

function paxRecord(key: string, value: string): Uint8Array {
  const suffix = `${key}=${value}\n`;
  let length = new TextEncoder().encode(suffix).length + 2;
  for (;;) {
    const bytes = new TextEncoder().encode(`${length} ${suffix}`);
    if (bytes.length === length) return bytes;
    length = bytes.length;
  }
}

const pax = (bytes: Uint8Array) => ({ path: 'PaxHeaders/000000', type: 120, bytes });
const regular = (path = 'PaxFiles/000000') => ({ path });

describe('phase-0 review intake', () => {
  it('does not admit the platform service actor as the person who uploaded source', async () => {
    const response = await SELF.fetch('http://localhost/api/reviews', {
      headers: { [SERVICE_TOKEN_HEADER]: (env as unknown as { SERVICE_TOKEN: string }).SERVICE_TOKEN },
    });
    expect(response.status).toBe(401);
  });
  it('stores immutable received receipts and confines reads to the initiating person', async () => {
    const a = actor();
    const b = actor();
    const src = await archive();
    const base = await archive([{ path: 'base.ts' }]);
    const app = createReviewApi({
      bucket: () => bucket,
      authenticate: async (request) => request.headers.get('x-test-person') === 'a' ? a
        : request.headers.get('x-test-person') === 'b' ? b : null,
    });
    const form = () => {
      const f = new FormData();
      f.set('source', src.file);
      f.set('sourceSha256', src.sha256);
      f.set('base', base.file);
      f.set('baseSha256', base.sha256);
      return f;
    };
    const post = () => app.request('http://test/reviews', { method: 'POST', headers: { 'x-test-person': 'a' }, body: form() });
    expect((await app.request('http://test/reviews', { method: 'POST', body: form() })).status).toBe(401);
    const first = await post();
    expect(first.status).toBe(201);
    const receipt = await first.json() as { id: string; state: string; findings: unknown[]; sourceSha256: string; baseSha256: string };
    expect(receipt).toMatchObject({ state: 'received', findings: [], sourceSha256: src.sha256, baseSha256: base.sha256 });
    const second = await post();
    expect(((await second.json()) as { id: string }).id).not.toBe(receipt.id);
    expect((await app.request(`http://test/reviews/${receipt.id}`, { headers: { 'x-test-person': 'b' } })).status).toBe(404);
    const listed = await app.request('http://test/reviews', { headers: { 'x-test-person': 'b' } });
    expect((await listed.json() as { entries: unknown[] }).entries).toEqual([]);
    expect((await bucket.get(`archives/${receipt.id}/source.tar.gz`))?.size).toBe(src.file.size);
    expect((await bucket.get(`archives/${receipt.id}/base.tar.gz`))?.size).toBe(base.file.size);
  });

  it('refuses an absent binding without affecting authentication', async () => {
    const a = actor();
    const app = createReviewApi({ bucket: () => undefined, authenticate: async (r) => r.headers.has('x-test-person') ? a : null });
    expect((await app.request('http://test/reviews')).status).toBe(401);
    const response = await app.request('http://test/reviews', { headers: { 'x-test-person': 'yes' } });
    expect(response.status).toBe(501);
    expect(await response.text()).toContain('review source storage is not configured');
  });

  it('rejects an archive with a link, a colliding path, traversal or a mismatched digest', async () => {
    const a = actor();
    for (const entries of [
      [{ path: 'src/link', type: 50 }],
      [{ path: 'A.ts' }, { path: 'a.ts' }],
      [{ path: '../outside.ts' }],
    ]) {
      const src = await archive(entries);
      await expect(receiveReview(bucket, a, { source: src.file, sourceSha256: src.sha256 })).rejects.toThrow();
    }
    const src = await archive();
    await expect(receiveReview(bucket, a, { source: src.file, sourceSha256: '0'.repeat(64) })).rejects.toThrow(/digest/);
  });

  it('accepts a single PAX path for a repository long-named document', async () => {
    const path = 'docs/decisions/K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md';
    const src = await archive([pax(paxRecord('path', path)), regular()]);
    await expect(validateReviewArchive(src.file, src.sha256)).resolves.toBeUndefined();
  });

  it('rejects every unsupported PAX override and malformed extension', async () => {
    const longPath = 'docs/' + 'a'.repeat(120);
    const invalid = [
      ...['linkpath', 'size', 'uid', 'gid', 'mtime', 'charset', 'hdrcharset', 'SCHILY.xattr', 'GNU.sparse', 'LIBARCHIVE.xattr']
        .map((key) => [key, [pax(paxRecord(key, 'value')), regular()]] as const),
      ['global header', [{ path: 'PaxHeaders/global', type: 103, bytes: paxRecord('path', longPath) }, regular()]],
      ['duplicate path records', [pax(new Uint8Array([...paxRecord('path', 'one'), ...paxRecord('path', 'two')])), regular()]],
      ['extra trailing newline', [pax(new Uint8Array([...paxRecord('path', 'one'), 10])), regular()]],
      ['wrong length', [pax(new TextEncoder().encode('99 path=one\n')), regular()]],
      ['invalid UTF-8', [pax(new Uint8Array([49, 49, 32, 112, 97, 116, 104, 61, 255, 10])), regular()]],
      ['NUL', [pax(paxRecord('path', 'bad\0name')), regular()]],
      ['oversized PAX', [pax(new Uint8Array(1025)), regular()]],
      ['repeated x', [pax(paxRecord('path', longPath)), pax(paxRecord('path', longPath)), regular()]],
      ['orphan x', [pax(paxRecord('path', longPath))]],
      ['x followed by link', [pax(paxRecord('path', longPath)), { ...regular(), type: 50 }]],
      ['absolute path', [pax(paxRecord('path', '/tmp/outside')), regular()]],
      ['parent traversal', [pax(paxRecord('path', '../outside')), regular()]],
      ['drive path', [pax(paxRecord('path', 'C:/outside')), regular()]],
      ['backslash path', [pax(paxRecord('path', 'a\\b')), regular()]],
      ['PAX case collision', [pax(paxRecord('path', 'A.ts')), regular(), { path: 'a.ts' }]],
      ['PAX Unicode normalization collision', [pax(paxRecord('path', 'é.ts')), regular(), pax(paxRecord('path', 'e\u0301.ts')), regular('PaxFiles/000001')]],
      ['file parent collision', [{ path: 'a' }, { path: 'a/b' }]],
      ['file child collision', [{ path: 'a/b' }, { path: 'a' }]],
    ] as const;
    for (const [label, entries] of invalid) {
      const src = await archive([...entries]);
      await expect(validateReviewArchive(src.file, src.sha256), label).rejects.toThrow();
    }
  });

  it('refuses the compressed and per-file size bounds before storing anything', async () => {
    const a = actor();
    const oversized = { size: 32 * 1024 * 1024 + 1, stream: () => { throw new Error('must not read'); } } as unknown as File;
    await expect(receiveReview(bucket, a, { source: oversized, sourceSha256: '0'.repeat(64) })).rejects.toThrow(/compressed size/);
    const declared = await archive([{ path: 'large.bin', declaredSize: 16 * 1024 * 1024 + 1 }]);
    await expect(receiveReview(bucket, a, { source: declared.file, sourceSha256: declared.sha256 })).rejects.toThrow(/file exceeds/);
  });

  it('expires the record and all its archive bytes after 30 days', async () => {
    const a = actor();
    const src = await archive();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const receipt = await receiveReview(bucket, a, { source: src.file, sourceSha256: src.sha256 }, now);
    expect(await readReview(bucket, a, receipt.id, new Date('2026-02-01T00:00:00.000Z'))).toBeNull();
    await pruneReviews(bucket, new Date('2026-02-01T00:00:00.000Z'));
    expect(await bucket.get(`archives/${receipt.id}/source.tar.gz`)).toBeNull();
  });
});
