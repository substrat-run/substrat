import { describe, it, expect } from 'vitest';
import { platformActorId, type AccessLogEntry, type ScopeDump } from '@substrat-run/contracts';
import {
  createR2AccessLogSink,
  createR2BackupStore,
  pruneAccessLogBatches,
  pruneScopeBackups,
} from '../src/r2-backups.js';

/**
 * The R2 half of the scope-backup seam (#493). Driven against a fake bucket rather than
 * live R2: what is worth pinning here is the store's own logic — the key scheme a scope's
 * copies are listed by, the paginated walk, and the metadata a listing answers from
 * without fetching megabytes of dump.
 */

interface StoredObject {
  key: string;
  body: string;
  customMetadata?: Record<string, string>;
}

/** A fake `R2Bucket` with a settable page size, so the cursor walk is actually exercised. */
function fakeBucket(pageSize = 100) {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    bucket: {
      put: async (
        key: string,
        value: string,
        options?: { customMetadata?: Record<string, string> },
      ) => {
        objects.set(key, { key, body: value, ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}) });
      },
      get: async (key: string) => {
        const o = objects.get(key);
        return o ? { text: async () => o.body } : null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async (opts?: { prefix?: string; cursor?: string; include?: string[] }) => {
        const all = [...objects.values()]
          .filter((o) => (opts?.prefix ? o.key.startsWith(opts.prefix) : true))
          .sort((a, b) => (a.key < b.key ? -1 : 1));
        const from = opts?.cursor ? Number(opts.cursor) : 0;
        const slice = all.slice(from, from + pageSize);
        const next = from + pageSize;
        return {
          objects: slice.map((o) => ({
            key: o.key,
            size: o.body.length,
            // Mirrors R2: custom metadata only comes back when it was asked for.
            ...(opts?.include?.includes('customMetadata') && o.customMetadata
              ? { customMetadata: o.customMetadata }
              : {}),
          })),
          truncated: next < all.length,
          cursor: next < all.length ? String(next) : undefined,
        };
      },
    },
  };
}

const dumpAt = (capturedAt: string, tenantId = 'ten1', scopeId = 'sc1'): ScopeDump => ({
  tenantId,
  scopeId,
  capturedAt,
  tables: [
    {
      name: 'customers',
      ddl: 'CREATE TABLE customers (id TEXT, email TEXT)',
      columns: ['id', 'email'],
      rows: [['c1', 'anna@example.com']],
    },
  ],
});

describe('r2 scope-backup store (#493)', () => {
  it('round-trips a dump and reports its metadata without reading the body back', async () => {
    const { bucket, objects } = fakeBucket();
    const store = createR2BackupStore(bucket);

    const meta = await store.put({ vertical: 'demo-vert', dump: dumpAt('2026-08-06T10:00:00.000Z') });
    expect(meta).toMatchObject({
      tenantId: 'ten1',
      scopeId: 'sc1',
      vertical: 'demo-vert',
      capturedAt: '2026-08-06T10:00:00.000Z',
      tables: 1,
    });
    expect(meta.size).toBeGreaterThan(0);

    // The key scheme is what makes a scope's copies one prefix list — and it keeps
    // capturedAt last so the ISO ordering IS the chronological ordering.
    expect([...objects.keys()]).toEqual(['scopes/ten1/sc1/2026-08-06T10:00:00.000Z.json']);

    const got = await store.get({ tenantId: 'ten1', scopeId: 'sc1', capturedAt: '2026-08-06T10:00:00.000Z' });
    // Full fidelity: the row comes back exactly as stored, unmasked — a backup that
    // cannot restore the real values is not a backup.
    expect(got!.tables[0]!.rows[0]).toEqual(['c1', 'anna@example.com']);
  });

  it('lists a scope’s copies newest-first, walking every page, and never leaks another scope’s', async () => {
    // Page size 2 against 3 copies: the cursor walk must run, or the oldest goes missing
    // exactly when an operator is looking for the last good copy.
    const { bucket } = fakeBucket(2);
    const store = createR2BackupStore(bucket);
    for (const at of ['2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z', '2026-08-02T00:00:00.000Z']) {
      await store.put({ vertical: 'demo-vert', dump: dumpAt(at) });
    }
    // A different scope under the same tenant, and a same-id scope under another tenant —
    // both must stay out of the listing (the prefix is the isolation).
    await store.put({ vertical: 'demo-vert', dump: dumpAt('2026-08-04T00:00:00.000Z', 'ten1', 'sc2') });
    await store.put({ vertical: 'demo-vert', dump: dumpAt('2026-08-05T00:00:00.000Z', 'ten2', 'sc1') });

    const listed = await store.list({ tenantId: 'ten1', scopeId: 'sc1' });
    expect(listed.map((b) => b.capturedAt)).toEqual([
      '2026-08-03T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
    expect(listed.every((b) => b.tables === 1 && b.vertical === 'demo-vert')).toBe(true);
  });

  it('still lists an object written without custom metadata — the key is the fallback address', async () => {
    const { bucket } = fakeBucket();
    // A manual upload, or an object from before the metadata existed. It must not vanish
    // from the listing: a backup an operator cannot SEE is one they will not rely on.
    await bucket.put('scopes/ten1/sc1/2026-07-01T00:00:00.000Z.json', JSON.stringify(dumpAt('2026-07-01T00:00:00.000Z')));
    const store = createR2BackupStore(bucket);

    const listed = await store.list({ tenantId: 'ten1', scopeId: 'sc1' });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ capturedAt: '2026-07-01T00:00:00.000Z', vertical: null, tables: 0 });
  });

  it('returns null for a copy that is not held, and throws on one that is not a dump', async () => {
    const { bucket } = fakeBucket();
    const store = createR2BackupStore(bucket);
    expect(await store.get({ tenantId: 'ten1', scopeId: 'sc1', capturedAt: '2026-01-01T00:00:00.000Z' })).toBeNull();

    // A corrupted object fails HERE, loudly, rather than at the restore that trusted it.
    await bucket.put('scopes/ten1/sc1/2026-01-02T00:00:00.000Z.json', JSON.stringify({ nope: true }));
    await expect(
      store.get({ tenantId: 'ten1', scopeId: 'sc1', capturedAt: '2026-01-02T00:00:00.000Z' }),
    ).rejects.toThrow();
  });
});

/**
 * The R2 half of the access-log sink (K-24, control-plane.md §4.4) — the Tier 2 that
 * makes the log's retention window closable. What is worth pinning is the line format
 * (a truncated object must still parse up to its last newline), the self-describing key,
 * and the refusal to claim a write that never happened.
 */
describe('r2 access-log sink (K-24)', () => {
  // Hand-built ULIDs: 26 chars of Crockford base32 (no I/L/O/U), ordered by their tail
  // so the batch below is chronological the way a real drain's read would be.
  const ulidLike = (tail: string): string => `01J${'0'.repeat(23 - tail.length)}${tail}`;
  const actor = platformActorId.parse(ulidLike('ACTR'));

  const entry = (id: string, at: string): AccessLogEntry => ({
    id,
    actor,
    method: 'listTenants',
    tenantId: null,
    scopeId: null,
    params: null,
    resultCount: 3,
    drainedAt: null,
    at,
  });

  it('writes one JSON object per line, keyed by the batch it holds', async () => {
    const { bucket, objects } = fakeBucket();
    const sink = createR2AccessLogSink(bucket);

    const batch = [
      entry(ulidLike('1'), '2026-08-01T00:00:00.000Z'),
      entry(ulidLike('2'), '2026-08-01T00:05:00.000Z'),
    ];
    const { ref } = await sink.ship(batch);

    // The key is the batch's own id range — which is also its time range, since a ULID
    // sorts chronologically. "Which file holds this row" needs no manifest.
    expect(ref).toBe(`access-log/${ulidLike('1')}-${ulidLike('2')}.ndjson`);

    const stored = objects.get(ref)!;
    // Trailing newline included: every line is complete, so a truncated object still
    // parses up to its last one. A single JSON array would have to be whole to read.
    expect(stored.body.endsWith('\n')).toBe(true);
    const lines = stored.body.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l) as AccessLogEntry)).toEqual(batch);

    // The span is mirrored into metadata so a listing answers "what covers August"
    // without fetching a single object.
    expect(stored.customMetadata).toMatchObject({
      firstId: batch[0]!.id,
      lastId: batch[1]!.id,
      rows: '2',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-01T00:05:00.000Z',
    });
  });

  it('re-shipping the same batch overwrites in place rather than duplicating', async () => {
    const { bucket, objects } = fakeBucket();
    const sink = createR2AccessLogSink(bucket);
    const batch = [entry(ulidLike('1'), '2026-08-01T00:00:00.000Z')];

    const first = await sink.ship(batch);
    const second = await sink.ship(batch);

    // Idempotent by key: a retried pass (the sweep stamps only AFTER ship resolves, so
    // a crash in between means the next tick ships the same rows) leaves one object.
    expect(second.ref).toBe(first.ref);
    expect([...objects.keys()]).toHaveLength(1);
  });

  it('refuses an empty batch instead of returning a ref to nothing', async () => {
    const { bucket, objects } = fakeBucket();
    const sink = createR2AccessLogSink(bucket);
    // The stamp that licenses deletion is taken on the strength of this ref. Returning
    // one for an object that was never written would be the lie that loses evidence.
    await expect(sink.ship([])).rejects.toThrow(/empty batch/);
    expect([...objects.keys()]).toHaveLength(0);
  });
});

/**
 * The stored-copy lifecycle rule (#557). What is worth pinning: the cutoff is exact and
 * age comes from the copy's own address (so metadata-less objects still age out), each
 * prune stays inside its own prefix, and anything undatable is KEPT — deleting what
 * cannot be dated is not retention.
 */
describe('stored-copy retention (#557)', () => {
  const NOW = () => new Date('2026-08-08T00:00:00.000Z');

  it('drops scope copies older than the window and keeps the rest', async () => {
    const { bucket, objects } = fakeBucket(2); // page size 2: the walk must paginate
    const store = createR2BackupStore(bucket);
    for (const at of [
      '2026-05-01T00:00:00.000Z', // stale
      '2026-07-08T23:59:59.000Z', // stale by a second at a 30-day window
      '2026-07-09T00:00:01.000Z', // fresh by a second
      '2026-08-07T00:00:00.000Z', // fresh
    ]) {
      await store.put({ vertical: 'demo-vert', dump: dumpAt(at) });
    }
    await store.put({ vertical: 'demo-vert', dump: dumpAt('2026-01-01T00:00:00.000Z', 'ten2', 'sc9') });

    expect(await pruneScopeBackups(bucket, { olderThanDays: 30, now: NOW })).toBe(3);
    // Age is per copy, across every tenant and scope — ten2's January copy went too.
    expect(await store.list({ tenantId: 'ten1', scopeId: 'sc1' })).toHaveLength(2);
    expect(await store.list({ tenantId: 'ten2', scopeId: 'sc9' })).toHaveLength(0);
    expect([...objects.keys()].every((k) => k.startsWith('scopes/'))).toBe(true);
  });

  it('keeps a scope copy it cannot date, and never reaches outside scopes/', async () => {
    const { bucket, objects } = fakeBucket();
    // A hand-renamed object: no metadata, no parsable capturedAt in the key.
    await bucket.put('scopes/ten1/sc1/latest-manual-copy.json', '{}');
    // An ancient object in a sibling prefix — the OTHER rule's business, never this one's.
    await bucket.put('access-log/old.ndjson', '{}\n');
    expect(await pruneScopeBackups(bucket, { olderThanDays: 0, now: NOW })).toBe(0);
    expect(objects.size).toBe(2);
  });

  // The ULID alphabet (Crockford base32), used to mint ids whose timestamp is known.
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ulidAt = (iso: string, tail: string): string => {
    let ms = new Date(iso).getTime();
    let time = '';
    for (let i = 0; i < 10; i++) {
      time = ALPHABET[ms % 32] + time;
      ms = Math.floor(ms / 32);
    }
    return `${time}${'0'.repeat(16 - tail.length)}${tail}`;
  };
  const actor = platformActorId.parse(ulidAt('2026-01-01T00:00:00.000Z', 'ACTR'));
  const entryAt = (iso: string, tail: string): AccessLogEntry => ({
    id: ulidAt(iso, tail),
    actor,
    method: 'listTenants',
    tenantId: null,
    scopeId: null,
    params: null,
    resultCount: 1,
    drainedAt: null,
    at: iso,
  });

  it('drops shipped batches whose newest row aged out, dating by metadata or by the key itself', async () => {
    const { bucket, objects } = fakeBucket();
    const sink = createR2AccessLogSink(bucket);
    // Stale by its `to` metadata; and a batch STRADDLING the cutoff, kept because its
    // newest row is still in-window — a batch is never dropped while it holds live rows.
    await sink.ship([entryAt('2025-01-01T00:00:00.000Z', 'A1'), entryAt('2025-01-02T00:00:00.000Z', 'A2')]);
    await sink.ship([entryAt('2026-06-01T00:00:00.000Z', 'B1'), entryAt('2026-08-01T00:00:00.000Z', 'B2')]);
    // No metadata (a re-uploaded object) — its age is decoded from the key's own lastId.
    const first = ulidAt('2025-03-01T00:00:00.000Z', 'C1');
    const last = ulidAt('2025-03-02T00:00:00.000Z', 'C2');
    await bucket.put(`access-log/${first}-${last}.ndjson`, '{}\n');
    // Undatable: no metadata and no ULID pair in the name. Kept.
    await bucket.put('access-log/manual-export.ndjson', '{}\n');

    expect(await pruneAccessLogBatches(bucket, { olderThanDays: 365, now: NOW })).toBe(2);
    const kept = [...objects.keys()];
    expect(kept).toContain('access-log/manual-export.ndjson');
    expect(kept.some((k) => k.includes('B1'))).toBe(true);
    expect(kept.some((k) => k.includes('A1') || k.includes('C1'))).toBe(false);
  });
});
