import { describe, it, expect } from 'vitest';
import type { ScopeDump } from '@substrat-run/contracts';
import { createR2BackupStore } from '../src/r2-backups.js';

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
