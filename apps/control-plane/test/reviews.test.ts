import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { platformActorId, tenantId, type TenantId } from '@substrat-run/contracts';
import { SERVICE_TOKEN_HEADER } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';
import { createReviewApi, MAX_KEPT_REVIEWS_PER_TENANT, MAX_REVIEWS_IN_PROGRESS_PER_TENANT } from '../src/reviews.js';
import { validateReviewArchive } from '../src/review-archive.js';
import { pruneReviews, readReview, receiveReview, ReviewCollisionError, writeReviewResult } from '../src/review-store.js';
import { archive, archiveRaw, BLOCK, octal, tar } from './review-fixtures.js';

const bucket = (env as unknown as { REVIEW_SOURCES: R2Bucket }).REVIEW_SOURCES;
const actor = () => platformActorId.parse(ulid());
function rechecksum(block: Uint8Array): void {
  block.fill(32, 148, 156);
  octal(block, 148, 8, block.reduce((a, b) => a + b, 0));
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

  it('preserves an existing object when a generated review key collides', async () => {
    const src = await archive();
    for (const prefix of ['archives/', 'records/']) {
      let collided = '';
      const collidingBucket = new Proxy(bucket, {
        get(target, property) {
          if (property === 'put') return async (key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) => {
            if (!collided && key.startsWith(prefix)) {
              collided = key;
              await target.put(key, 'existing review object');
            }
            return target.put(key, value, options);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as R2Bucket;
      await expect(receiveReview(collidingBucket, actor(), { source: src.file, sourceSha256: src.sha256 })).rejects.toBeInstanceOf(ReviewCollisionError);
      expect(await (await bucket.get(collided))?.text()).toBe('existing review object');
      if (prefix === 'records/') {
        const id = collided.slice('records/'.length, -'.json'.length);
        expect(await bucket.get(`archives/${id}/source.tar.gz`)).toBeNull();
      }
    }
  });

  it('limits live review receipts for one person', async () => {
    const person = actor();
    const src = await archive();
    for (let n = 0; n < 20; n++) await receiveReview(bucket, person, { source: src.file, sourceSha256: src.sha256 });
    const app = createReviewApi({ bucket: () => bucket, authenticate: async () => person });
    const response = await app.request('http://test/reviews', { method: 'POST', body: new FormData() });
    expect(response.status).toBe(429);
  });

  it('refuses a second upload while the same person has one in flight', async () => {
    const person = actor();
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const begun = new Promise<void>((resolve) => { entered = resolve; });
    const delayedBucket = new Proxy(bucket, {
      get(target, property) {
        if (property === 'list') return async (options: R2ListOptions) => {
          entered();
          await hold;
          return target.list(options);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const app = createReviewApi({ bucket: () => delayedBucket, authenticate: async () => person });
    const post = () => app.request('http://test/reviews', { method: 'POST', body: new FormData() });
    const first = post();
    await begun;
    expect((await post()).status).toBe(429);
    release();
    expect((await first).status).toBe(400);
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

  it('keeps a leading or interior UTF-8 BOM distinct from the plain path', async () => {
    for (const path of ['\uFEFFa.txt', 'a\uFEFF.txt']) {
      const src = await archive([{ path }, { path: 'a.txt' }]);
      await expect(validateReviewArchive(src.file, src.sha256), path).resolves.toBeUndefined();
    }
  });

  it.each([
    ['DEL', '\u007f'], ['C1 NEL', '\u0085'], ['C1 CSI', '\u009b'], ['bidi override', '\u202e'],
    ['bidi isolate', '\u2066'], ['line separator', '\u2028'], ['paragraph separator', '\u2029'],
  ])('refuses a path holding %s, in the header and in a PAX record', async (_label, char) => {
    for (const entries of [[{ path: `src/a${char}b.ts` }], [pax(paxRecord('path', `src/a${char}b.ts`)), regular()]]) {
      const src = await archive(entries);
      await expect(validateReviewArchive(src.file, src.sha256)).rejects.toThrow(/portable relative path/);
    }
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
      ['directories only', [{ path: 'empty/', type: 53 }]],
    ] as const;
    for (const [label, entries] of invalid) {
      const src = await archive([...entries]);
      await expect(validateReviewArchive(src.file, src.sha256), label).rejects.toThrow();
    }
  });

  it('rejects hidden bytes and malformed fields in USTAR and PAX headers', async () => {
    const hidden = (at: number) => (h: Uint8Array) => { h[at] = 0; h[at + 1] = 88; };
    const cases: Array<[string, (h: Uint8Array) => void, boolean?]> = [
      ['name', hidden(1)], ['mode', hidden(101)], ['uid', hidden(109)],
      ['gid', hidden(117)], ['size', hidden(125)], ['mtime', hidden(137)],
      ['linkname', hidden(157)], ['magic', hidden(257)], ['version', hidden(263)],
      ['uname', hidden(265)], ['gname', hidden(297)],
      ['devmajor', hidden(329)], ['devminor', hidden(337)],
      ['prefix', hidden(345)], ['reserved padding', (h) => { h[500] = 88; }],
      ['checksum tail', (h) => { h[155] = 88; }],
      ['size non-octal', (h) => { h[124] = 88; }],
      ['size trailing space', (h) => { h[134] = 32; }],
      ['PAX header name', hidden(1), true],
    ];
    for (const [label, change, extended] of cases) {
      const raw = tar(extended ? [pax(paxRecord('path', 'long/path')), regular()] : [{ path: 'src/main.ts' }]);
      const header = raw.subarray(0, BLOCK);
      change(header);
      rechecksum(header);
      if (label === 'checksum tail') header[155] = 88;
      const src = await archiveRaw(raw);
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

describe('a builder review', () => {
  const tenantA = tenantId.parse(ulid());
  const tenantB = tenantId.parse(ulid());
  const tenantFull = tenantId.parse(ulid());
  const owners: Record<string, TenantId> = { 'acme/garden': tenantA, 'beta/garden': tenantB, 'full/garden': tenantFull };
  const builders = {
    a1: { actor: actor(), tenantId: tenantA, tenantSlug: 'acme' },
    a2: { actor: actor(), tenantId: tenantA, tenantSlug: 'acme' },
    b: { actor: actor(), tenantId: tenantB, tenantSlug: 'beta' },
    full: { actor: actor(), tenantId: tenantFull, tenantSlug: 'full' },
  };
  const builderApp = (store: R2Bucket = bucket) => createReviewApi({
    bucket: () => store,
    authenticate: async () => null,
    authenticateBuilder: async (r) => builders[r.headers.get('x-test-builder') as keyof typeof builders] ?? null,
    ownerOf: async (_actor, slug) => owners[slug],
    entitled: async (tenant) => tenant !== tenantB || reviewsForB,
  });
  let reviewsForB = true;
  const upload = async (who: keyof typeof builders, slug?: string, store?: R2Bucket) => {
    const src = await archive();
    const form = new FormData();
    form.set('source', src.file);
    form.set('sourceSha256', src.sha256);
    if (slug !== undefined) form.set('slug', slug);
    return builderApp(store).request('http://test/reviews', { method: 'POST', headers: { 'x-test-builder': who }, body: form });
  };
  const get = (who: keyof typeof builders, path: string) => builderApp().request(`http://test${path}`, { headers: { 'x-test-builder': who } });

  it('is recorded under its tenant for a vertical the tenant owns, read by that tenant only, and refused for any other vertical', async () => {
    const created = await upload('a1', 'garden');
    expect(created.status).toBe(201);
    const record = await created.json() as { id: string; tenantId: string; vertical: string; actor?: string };
    expect(record).toMatchObject({ tenantId: tenantA, vertical: 'acme/garden', state: 'received' });
    expect(record.actor).toBeUndefined();

    expect((await get('a2', `/reviews/${record.id}`)).status).toBe(200);
    expect((await (await get('a2', '/reviews')).json() as { entries: Array<{ id: string }> }).entries.map((e) => e.id)).toContain(record.id);
    expect((await get('b', `/reviews/${record.id}`)).status).toBe(404);
    expect((await (await get('b', '/reviews')).json() as { entries: unknown[] }).entries).toEqual([]);

    for (const [slug, status] of [['beta/garden', 403], ['orchard', 403], [undefined, 400]] as const) {
      const refused = await upload('a1', slug);
      expect(refused.status, String(slug)).toBe(status);
      expect(refused.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('starts none for a workspace without the review entitlement, and still reads its own', async () => {
    const kept = await upload('b', 'garden');
    expect(kept.status).toBe(201);
    reviewsForB = false;
    try {
      const refused = await upload('b', 'garden');
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain('`review` entitlement');
      expect((await get('b', `/reviews/${((await kept.json()) as { id: string }).id}`)).status).toBe(200);
    } finally {
      reviewsForB = true;
    }
  });

  it('bounds a workspace by reviews in progress, then by reviews kept, whichever member starts them', async () => {
    const src = await archive();
    const receive = () =>
      receiveReview(bucket, actor(), { source: src.file, sourceSha256: src.sha256, tenant: { tenantId: tenantFull, vertical: 'full/garden' } });
    const at = new Date().toISOString();
    const finish = (id: string) =>
      writeReviewResult(bucket, id, {
        state: 'skipped', reason: 'test', gates: [], findings: [], checkedClean: [], notApplicable: [], notSent: [], deleted: [],
        fullTree: true, model: null, runner: { version: 'test' }, usage: null, dropped: 0, parseFailures: 0,
        startedAt: at, finishedAt: at, checklistDigest: 'd', pluginVersion: 'p',
      });
    const inProgress = [];
    for (let n = 0; n < MAX_REVIEWS_IN_PROGRESS_PER_TENANT; n++) inProgress.push(await receive());
    expect((await upload('full', 'garden')).status).toBe(429);
    // A finished review frees its slot…
    await finish(inProgress[0]!.id);
    expect((await upload('full', 'garden')).status).toBe(201);
    // …and still counts toward what the workspace may keep in the retention window.
    for (const r of inProgress.slice(1)) await finish(r.id);
    // The in-progress ones plus the one just admitted are kept; fill the window to its bound.
    for (let kept = MAX_REVIEWS_IN_PROGRESS_PER_TENANT + 1; kept < MAX_KEPT_REVIEWS_PER_TENANT; kept++) await finish((await receive()).id);
    const refused = await upload('full', 'garden');
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain(`${MAX_KEPT_REVIEWS_PER_TENANT} reviews per workspace in 30 days`);
  });
});
