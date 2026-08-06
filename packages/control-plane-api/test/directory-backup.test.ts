import { describe, it, expect } from 'vitest';
import type { DirectoryBackup, DirectoryDump, PlatformActorId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { backupDirectoryIfDue } from '../src/directory-backup.js';
import { createR2DirectoryBackupStore } from '../src/r2-backups.js';
import type { DirectoryBackupStore } from '../src/backups.js';

/**
 * The scheduled directory backup (#40) — the cadence guard and the retention window.
 *
 * Driven against fakes, because the behaviour worth pinning is the SCHEDULE, not the
 * bytes: a quarter-hourly cron must take one copy a day (not ninety-six), a missed tick
 * must be caught up rather than skipped, a failed capture must never be the thing that
 * deletes the last good copy, and the window must actually bound the bucket.
 */

const ACTOR = 'act_1' as PlatformActorId;

/** An in-memory `DirectoryBackupStore`, recording the calls the schedule makes. */
function fakeStore(): DirectoryBackupStore & { held: () => string[]; deleted: string[] } {
  const copies = new Map<string, DirectoryDump>();
  const deleted: string[] = [];
  return {
    deleted,
    held: () => [...copies.keys()].sort(),
    put: async ({ dump }) => {
      copies.set(dump.capturedAt, dump);
      return { capturedAt: dump.capturedAt, size: JSON.stringify(dump).length, tables: dump.tables.length };
    },
    list: async () =>
      [...copies.values()]
        .map(
          (d): DirectoryBackup => ({
            capturedAt: d.capturedAt,
            size: JSON.stringify(d).length,
            tables: d.tables.length,
          }),
        )
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)),
    get: async ({ capturedAt }) => copies.get(capturedAt) ?? null,
    delete: async ({ capturedAt }) => {
      copies.delete(capturedAt);
      deleted.push(capturedAt);
    },
  };
}

/** A `HostAdmin` that only knows how to export — the one method the phase calls. */
function fakeAdmin(clock: () => Date, onExport?: () => void): HostAdmin {
  return {
    exportDirectory: async (): Promise<DirectoryDump> => {
      onExport?.();
      return {
        capturedAt: clock().toISOString(),
        tables: [
          { name: 'tenants', ddl: 'CREATE TABLE tenants (tenant_id TEXT)', columns: ['tenant_id'], rows: [['t1']] },
        ],
      };
    },
  } as unknown as HostAdmin;
}

describe('scheduled directory backup (#40)', () => {
  it('takes the first copy when the store is empty — a new deployment is covered at once', async () => {
    const store = fakeStore();
    const now = new Date('2026-08-06T00:00:00.000Z');
    const result = await backupDirectoryIfDue({
      admin: fakeAdmin(() => now),
      store,
      actor: ACTOR,
      now: () => now,
    });

    expect(result.taken?.capturedAt).toBe('2026-08-06T00:00:00.000Z');
    expect(result.skippedFor).toBeNull();
    expect(store.held()).toEqual(['2026-08-06T00:00:00.000Z']);
  });

  it('skips inside the cadence window — a quarter-hourly cron takes ONE copy a day', async () => {
    const store = fakeStore();
    let exports = 0;
    // 96 passes across 24h, exactly what the deployed `*/15` cron does.
    for (let tick = 0; tick < 96; tick++) {
      const now = new Date(Date.UTC(2026, 7, 6, 0, 0, 0) + tick * 15 * 60_000);
      await backupDirectoryIfDue({
        admin: fakeAdmin(() => now, () => (exports += 1)),
        store,
        actor: ACTOR,
        now: () => now,
      });
    }
    // One capture, not ninety-six — and the directory was exported exactly once, so the
    // guard is refusing the WORK, not merely discarding its result.
    expect(exports).toBe(1);
    expect(store.held()).toHaveLength(1);
  });

  it('takes the next copy once the window has elapsed', async () => {
    const store = fakeStore();
    const first = new Date('2026-08-06T00:00:00.000Z');
    await backupDirectoryIfDue({ admin: fakeAdmin(() => first), store, actor: ACTOR, now: () => first });

    const justInside = new Date('2026-08-06T23:59:00.000Z');
    const skipped = await backupDirectoryIfDue({
      admin: fakeAdmin(() => justInside),
      store,
      actor: ACTOR,
      now: () => justInside,
    });
    expect(skipped.taken).toBeNull();
    expect(skipped.skippedFor).toBe('2026-08-06T00:00:00.000Z');

    const due = new Date('2026-08-07T00:00:01.000Z');
    const taken = await backupDirectoryIfDue({
      admin: fakeAdmin(() => due),
      store,
      actor: ACTOR,
      now: () => due,
    });
    expect(taken.taken?.capturedAt).toBe('2026-08-07T00:00:01.000Z');
    expect(store.held()).toHaveLength(2);
  });

  it('catches up a missed window rather than skipping the day — late, never never', async () => {
    const store = fakeStore();
    const first = new Date('2026-08-01T00:00:00.000Z');
    await backupDirectoryIfDue({ admin: fakeAdmin(() => first), store, actor: ACTOR, now: () => first });

    // The cron did not run for three days (a deploy, an outage). The next pass to
    // arrive takes a copy immediately — the schedule is derived from the newest stored
    // copy, so there is no missed slot to have forgotten.
    const late = new Date('2026-08-04T09:13:00.000Z');
    const result = await backupDirectoryIfDue({
      admin: fakeAdmin(() => late),
      store,
      actor: ACTOR,
      now: () => late,
    });
    expect(result.taken?.capturedAt).toBe('2026-08-04T09:13:00.000Z');
  });

  it('force ignores the cadence — the operator\'s pre-migration checkpoint', async () => {
    const store = fakeStore();
    const first = new Date('2026-08-06T00:00:00.000Z');
    await backupDirectoryIfDue({ admin: fakeAdmin(() => first), store, actor: ACTOR, now: () => first });

    const minutesLater = new Date('2026-08-06T00:05:00.000Z');
    const forced = await backupDirectoryIfDue({
      admin: fakeAdmin(() => minutesLater),
      store,
      actor: ACTOR,
      force: true,
      now: () => minutesLater,
    });
    expect(forced.taken?.capturedAt).toBe('2026-08-06T00:05:00.000Z');
    expect(store.held()).toHaveLength(2);
  });

  it('prunes to the retention window, keeping the NEWEST copies', async () => {
    const store = fakeStore();
    // 35 daily passes against a window of 30.
    for (let day = 1; day <= 35; day++) {
      const now = new Date(Date.UTC(2026, 6, 1) + (day - 1) * 86_400_000);
      await backupDirectoryIfDue({
        admin: fakeAdmin(() => now),
        store,
        actor: ACTOR,
        retain: 30,
        now: () => now,
      });
    }
    const held = store.held();
    expect(held).toHaveLength(30);
    // The oldest five are gone and the newest is kept — the window slides forward.
    expect(held[0]).toBe('2026-07-06T00:00:00.000Z');
    expect(held.at(-1)).toBe('2026-08-04T00:00:00.000Z');
    expect(store.deleted).toHaveLength(5);
  });

  it('never prunes when the capture failed — a broken backup cannot delete the last good one', async () => {
    const store = fakeStore();
    const first = new Date('2026-08-06T00:00:00.000Z');
    await backupDirectoryIfDue({ admin: fakeAdmin(() => first), store, actor: ACTOR, retain: 1, now: () => first });
    expect(store.held()).toHaveLength(1);

    const broken = {
      exportDirectory: async () => {
        throw new Error('directory unreachable');
      },
    } as unknown as HostAdmin;
    const later = new Date('2026-08-07T00:00:00.000Z');
    await expect(
      backupDirectoryIfDue({ admin: broken, store, actor: ACTOR, retain: 1, now: () => later }),
    ).rejects.toThrow('directory unreachable');

    // The copy that existed before the failure is still there — prune runs only after a
    // successful put, so the worst case is a stale copy, never no copy.
    expect(store.held()).toEqual(['2026-08-06T00:00:00.000Z']);
    expect(store.deleted).toEqual([]);
  });

  it('drives the real R2 store end to end — take, list, restore-source, prune', async () => {
    // The same schedule against `createR2DirectoryBackupStore` and a fake bucket, so the
    // key scheme and the newest-first ordering the guard depends on are exercised
    // together rather than only against an in-memory double.
    const objects = new Map<string, { key: string; body: string; customMetadata?: Record<string, string> }>();
    const bucket = {
      put: async (key: string, body: string, opts?: { customMetadata?: Record<string, string> }) => {
        objects.set(key, { key, body, ...(opts?.customMetadata ? { customMetadata: opts.customMetadata } : {}) });
      },
      get: async (key: string) => {
        const o = objects.get(key);
        return o ? { text: async () => o.body } : null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async (opts?: { prefix?: string; include?: string[] }) => ({
        objects: [...objects.values()]
          .filter((o) => (opts?.prefix ? o.key.startsWith(opts.prefix) : true))
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((o) => ({ key: o.key, size: o.body.length, ...(o.customMetadata ? { customMetadata: o.customMetadata } : {}) })),
        truncated: false,
      }),
    };
    const store = createR2DirectoryBackupStore(bucket);

    for (let day = 1; day <= 4; day++) {
      const now = new Date(Date.UTC(2026, 7, day));
      await backupDirectoryIfDue({ admin: fakeAdmin(() => now), store, actor: ACTOR, retain: 3, now: () => now });
    }

    // Keys carry the `directory/` prefix, so this store can share a bucket with the
    // scope backups' `scopes/` prefix without either being able to see the other.
    expect([...objects.keys()].every((k) => k.startsWith('directory/'))).toBe(true);
    const held = await store.list();
    expect(held.map((b) => b.capturedAt)).toEqual([
      '2026-08-04T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ]);
    // And a stored copy still parses back into a restorable dump.
    const dump = await store.get({ capturedAt: '2026-08-04T00:00:00.000Z' });
    expect(dump?.tables[0]?.name).toBe('tenants');
    expect(await store.get({ capturedAt: '2026-08-01T00:00:00.000Z' })).toBeNull();
  });
});
