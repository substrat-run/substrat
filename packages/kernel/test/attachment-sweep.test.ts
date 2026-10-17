/**
 * The orphan sweep's decisions (#2314), against an in-memory store and a scripted scope side.
 * The SQL halves (the tombstone, the insert's refusal, the load's refusal) and the copy refusal
 * are held on both adapters by `orphanSweepContractSuite`; this holds the order of the pass: the
 * fence, the age floor, the prefix, the condemnation, the fence again, the deletes.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_CONDEMNED_DDL,
  ORPHAN_SWEEP_FENCE_MS,
  ORPHAN_SWEEP_GRACE_MS,
  ORPHAN_TOMBSTONE_RETENTION_MS,
  attachmentSweepFenceKey,
  condemnOrphanAttachments,
  refuseCondemnedAttachment,
  fenceAttachmentSweep,
  sweepOrphanAttachments,
  type OrphanSweepScope,
} from '../src/attachment-sweep.js';
import { attachmentBlobKey, type ScopedSql, type SqlValue, type TenantBlobStore } from '../src/scope-host.js';
import { ulidFloor } from '../src/ulid.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const at = (ms: number): string => new Date(ms).toISOString();
const S = '01JSCOPE00000000000000000A';
const OTHER = '01JSCOPE00000000000000000B';

function memoryStore(): TenantBlobStore & { keys(): string[]; deletes: string[]; failDelete?: string } {
  const objs = new Map<string, Uint8Array>();
  const store = {
    deletes: [] as string[],
    failDelete: undefined as string | undefined,
    keys: () => [...objs.keys()].sort(),
    put: async (key: string, body: Uint8Array) => {
      objs.set(key, body);
    },
    get: async (key: string) => {
      const body = objs.get(key);
      return body ? { body } : null;
    },
    delete: async (key: string) => {
      if (key === store.failDelete) throw new Error('store down');
      store.deletes.push(key);
      objs.delete(key);
    },
    // Deliberately ignores the prefix: the sweep must not trust a listing to be confined.
    list: async () => [...objs.keys()].sort(),
  };
  return store;
}

const bytes = new Uint8Array([1]);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * A ULID minted at `ms`. Not `ulid(ms)`: the process mint is monotonic, so after any later id it
 * hands back that later time, and an "old" id would not be old.
 */
const idAt = (ms: number): string =>
  ulidFloor(ms).slice(0, 10) + Array.from({ length: 16 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join('');
const old = (): string => idAt(NOW - ORPHAN_SWEEP_GRACE_MS - DAY);
const young = (): string => idAt(NOW - ORPHAN_SWEEP_GRACE_MS + DAY);

/** A scope side whose rows are `rows`; it records what it was asked. */
function scopeOf(rows: Set<string>): OrphanSweepScope & { asked: string[][]; condemned: string[]; reads: number } {
  const side = {
    asked: [] as string[][],
    condemned: [] as string[],
    reads: 0,
    rowless: async (ids: readonly string[]) => {
      side.reads++;
      side.asked.push([...ids]);
      return ids.filter((id) => !rows.has(id));
    },
    condemn: async (ids: readonly string[]) => {
      side.asked.push([...ids]);
      const out = ids.filter((id) => !rows.has(id));
      side.condemned.push(...out);
      return out;
    },
  };
  return side;
}

describe('sweepOrphanAttachments (#2314)', () => {
  it('deletes an aged object no row names, and keeps the row-backed, the young and every foreign key', async () => {
    const store = memoryStore();
    const live = old();
    const orphan = old();
    const fresh = young();
    const foreignOld = old();
    const foreign = [
      attachmentBlobKey(OTHER, foreignOld), // another scope's attachment
      `scope/${S}/exports/${old()}`, // another feature, same scope
      `scope/${S}/att/${old()}/nested`, // not a key this platform writes
      `scope/${S}/att/not-a-ulid`,
      `scope/${S}/attx/${old()}`,
      `scope/${S}x/att/${old()}`,
      `other/${old()}`,
    ];
    for (const key of [attachmentBlobKey(S, live), attachmentBlobKey(S, orphan), attachmentBlobKey(S, fresh), ...foreign]) {
      await store.put(key, bytes);
    }
    const scope = scopeOf(new Set([live]));
    const report = await sweepOrphanAttachments(store, S, scope, { now: at(NOW) });

    expect(store.deletes).toEqual([attachmentBlobKey(S, orphan)]);
    expect(report).toMatchObject({ candidates: 2, orphans: 1, deleted: 1, dryRun: false });
    expect(report.keys).toEqual([attachmentBlobKey(S, orphan)]);
    // The scope is only ever asked about this scope's aged attachment ids.
    expect(scope.asked.flat().sort()).toEqual([live, orphan].sort());
    for (const key of foreign) expect(store.keys()).toContain(key);
    expect(store.keys()).toContain(attachmentBlobKey(S, fresh));
  });

  it('never asks the scope about an object younger than the grace period', async () => {
    const store = memoryStore();
    const fresh = young();
    await store.put(attachmentBlobKey(S, fresh), bytes);
    const scope = scopeOf(new Set());
    const report = await sweepOrphanAttachments(store, S, scope, { now: at(NOW) });
    expect(scope.asked).toEqual([]);
    expect(report.candidates).toBe(0);
    expect(store.keys()).toEqual([attachmentBlobKey(S, fresh)]);
    // The positive twin: one day past the floor, the same object is judged and swept.
    const later = await sweepOrphanAttachments(store, S, scope, { now: at(NOW + 2 * DAY) });
    expect(later.deleted).toBe(1);
  });

  it('deletes nothing while a restore fence holds, and sweeps once it has lapsed', async () => {
    const store = memoryStore();
    const orphan = old();
    await store.put(attachmentBlobKey(S, orphan), bytes);
    await fenceAttachmentSweep(store, S, at(NOW - DAY));
    const scope = scopeOf(new Set());
    const held = await sweepOrphanAttachments(store, S, scope, { now: at(NOW) });
    expect(held.fencedUntil).toBe(at(NOW - DAY + ORPHAN_SWEEP_FENCE_MS));
    expect(held.deleted).toBe(0);
    expect(scope.asked).toEqual([]);
    expect(store.keys()).toContain(attachmentBlobKey(S, orphan));

    const lapsed = await sweepOrphanAttachments(store, S, scope, { now: at(NOW - DAY + ORPHAN_SWEEP_FENCE_MS + 1) });
    expect(lapsed.fencedUntil).toBeUndefined();
    expect(lapsed.deleted).toBe(1);
  });

  it('re-reads the fence after the condemnation: a restore fenced mid-pass stops every delete', async () => {
    const store = memoryStore();
    const orphan = old();
    await store.put(attachmentBlobKey(S, orphan), bytes);
    const scope = scopeOf(new Set());
    const racing: OrphanSweepScope = {
      rowless: scope.rowless,
      condemn: async (ids, now) => {
        const out = await scope.condemn(ids, now);
        // A rewind arms between the condemnation and the first delete: it writes its fence first.
        await fenceAttachmentSweep(store, S, at(NOW));
        return out;
      },
    };
    const report = await sweepOrphanAttachments(store, S, racing, { now: at(NOW) });
    expect(scope.condemned).toEqual([orphan]);
    expect(report.deleted).toBe(0);
    expect(report.fencedUntil).toBe(at(NOW + ORPHAN_SWEEP_FENCE_MS));
    expect(store.deletes).toEqual([]);
  });

  it('holds a fence it cannot read as one that never lapses', async () => {
    const store = memoryStore();
    await store.put(attachmentBlobKey(S, old()), bytes);
    await store.put(attachmentSweepFenceKey(S), new TextEncoder().encode('garbage'));
    const report = await sweepOrphanAttachments(store, S, scopeOf(new Set()), { now: at(NOW + 400 * DAY) });
    expect(report.fencedUntil).toBe('never');
    expect(store.deletes).toEqual([]);
  });

  it('a dry run condemns nothing and deletes nothing, and reports the keys a pass would delete', async () => {
    const store = memoryStore();
    const orphan = old();
    await store.put(attachmentBlobKey(S, orphan), bytes);
    const scope = scopeOf(new Set());
    const report = await sweepOrphanAttachments(store, S, scope, { now: at(NOW), dryRun: true });
    expect(report).toMatchObject({ dryRun: true, orphans: 1, deleted: 0 });
    expect(report.keys).toEqual([attachmentBlobKey(S, orphan)]);
    expect(scope.condemned).toEqual([]);
    expect(scope.reads).toBe(1);
    expect(store.deletes).toEqual([]);
  });

  it('deletes only ids it asked about, whatever the scope answers', async () => {
    const store = memoryStore();
    const mine = old();
    const foreign = old();
    await store.put(attachmentBlobKey(S, mine), bytes);
    await store.put(attachmentBlobKey(S, foreign), bytes);
    // `unasked` is younger than the floor, so the pass never asks the scope about it.
    const unasked = young();
    await store.put(attachmentBlobKey(S, unasked), bytes);
    const report = await sweepOrphanAttachments(store, S, {
      rowless: async () => [],
      // A scope that answers with an id it was not asked about (a stale batch, a bug).
      condemn: async () => [unasked],
    }, { now: at(NOW) });
    expect(report.deleted).toBe(0);
    expect(store.deletes).toEqual([]);
  });

  it('bounds the deletes of one pass by `limit`, oldest first', async () => {
    const store = memoryStore();
    const ids = [old(), old(), old()].sort();
    for (const id of ids) await store.put(attachmentBlobKey(S, id), bytes);
    const report = await sweepOrphanAttachments(store, S, scopeOf(new Set()), { now: at(NOW), limit: 2 });
    expect(report.deleted).toBe(2);
    expect(store.deletes).toEqual(ids.slice(0, 2).map((id) => attachmentBlobKey(S, id)));
  });

  it('refuses a grace below a day and a fence below the PITR window', async () => {
    const store = memoryStore();
    await expect(sweepOrphanAttachments(store, S, scopeOf(new Set()), { now: at(NOW), graceMs: DAY - 1 })).rejects.toThrow(
      /graceMs must be at least/,
    );
    await expect(
      sweepOrphanAttachments(store, S, scopeOf(new Set()), { now: at(NOW), fenceMs: 31 * DAY - 1 }),
    ).rejects.toThrow(/fenceMs must be at least/);
  });

  it('a delete that fails stops the pass and leaves the rest for the next one', async () => {
    const store = memoryStore();
    const [a, b] = [old(), old()].sort();
    await store.put(attachmentBlobKey(S, a!), bytes);
    await store.put(attachmentBlobKey(S, b!), bytes);
    store.failDelete = attachmentBlobKey(S, a!);
    await expect(sweepOrphanAttachments(store, S, scopeOf(new Set()), { now: at(NOW) })).rejects.toThrow(/store down/);
    expect(store.keys()).toEqual([a, b].map((id) => attachmentBlobKey(S, id!)));
    store.failDelete = undefined;
    const retry = await sweepOrphanAttachments(store, S, scopeOf(new Set()), { now: at(NOW) });
    expect(retry.deleted).toBe(2);
  });
});

/**
 * The tombstone half on a real SQLite (node's own), so the statements are the ones both adapters
 * run: a condemnation answers only rowless ids, and re-condemning an id re-stamps its tombstone,
 * so the prune in the same transaction never takes the tombstone of an id it returns (#2314 r1).
 */
describe('condemnOrphanAttachments on SQLite (#2314)', () => {
  const sqlOf = async (): Promise<ScopedSql & { db: { exec(sql: string): void } }> => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE _substrat_attachments (id TEXT PRIMARY KEY)');
    db.exec(ATTACHMENT_CONDEMNED_DDL);
    return {
      db,
      query: <T>(sql: string, params: readonly SqlValue[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
      exec: (sql: string, params: readonly SqlValue[] = []) => ({ changes: Number(db.prepare(sql).run(...(params as never[])).changes) }),
    };
  };
  const tombstones = (sql: ScopedSql) =>
    sql.query<{ id: string; condemned_at: string }>('SELECT id, condemned_at FROM _substrat_attachment_condemned ORDER BY id');

  it('condemns only the ids no row names, and the insert check then refuses them', async () => {
    const sql = await sqlOf();
    sql.exec("INSERT INTO _substrat_attachments (id) VALUES ('A')");
    expect(condemnOrphanAttachments(sql, ['A', 'B'], at(NOW))).toEqual(['B']);
    expect(tombstones(sql)).toEqual([{ id: 'B', condemned_at: at(NOW) }]);
    expect(() => refuseCondemnedAttachment(sql, 'B')).toThrow(/swept as an orphan/);
    expect(() => refuseCondemnedAttachment(sql, 'C')).not.toThrow();
  });

  it('re-condemning an id past the tombstone retention re-stamps it, so the prune keeps it', async () => {
    const sql = await sqlOf();
    const long = NOW - ORPHAN_TOMBSTONE_RETENTION_MS - DAY;
    expect(condemnOrphanAttachments(sql, ['B'], at(long))).toEqual(['B']);
    // A later pass (a backlog past `limit`, a failed delete) returns it again for deletion.
    expect(condemnOrphanAttachments(sql, ['B'], at(NOW))).toEqual(['B']);
    expect(tombstones(sql)).toEqual([{ id: 'B', condemned_at: at(NOW) }]);
    expect(() => refuseCondemnedAttachment(sql, 'B')).toThrow();
  });

  it('the twin: a tombstone past retention that no pass returns is pruned', async () => {
    const sql = await sqlOf();
    condemnOrphanAttachments(sql, ['OLD'], at(NOW - ORPHAN_TOMBSTONE_RETENTION_MS - DAY));
    condemnOrphanAttachments(sql, ['NEW'], at(NOW));
    expect(tombstones(sql).map((r) => r.id)).toEqual(['NEW']);
  });
});
