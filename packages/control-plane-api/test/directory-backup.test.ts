import { describe, it, expect } from 'vitest';
import type { DirectoryDump, DirectoryDumpPage, PlatformActorId, ScopeDumpTable } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { backupDirectoryIfDue } from '../src/directory-backup.js';
import { createR2DirectoryBackupStore } from '../src/r2-backups.js';
import type { DirectoryBackupStore } from '../src/backups.js';
import { fakeBucket } from './fake-r2-bucket.js';

/**
 * The scheduled directory backup (#40) — the cadence guard and the retention window.
 *
 * Driven against fakes, because the behaviour worth pinning is the SCHEDULE, not the
 * bytes: a quarter-hourly cron must take one copy a day (not ninety-six), a missed tick
 * must be caught up rather than skipped, a failed capture must never be the thing that
 * deletes the last good copy, and the window must actually bound the bucket.
 */

const ACTOR = 'act_1' as PlatformActorId;

/** The R2 directory store over a fake bucket, recording what the schedule holds and deletes. */
function fakeStore(bucketOpts?: Parameters<typeof fakeBucket>[1]) {
  const { bucket, objects } = fakeBucket(100, bucketOpts);
  const r2 = createR2DirectoryBackupStore(bucket);
  const deleted: string[] = [];
  const store: DirectoryBackupStore = {
    ...r2,
    delete: async (input) => {
      deleted.push(input.capturedAt);
      await r2.delete(input);
    },
  };
  const held = async () => (await r2.list()).map((b) => b.capturedAt).sort();
  return { store, objects, deleted, held };
}

const TENANTS: ScopeDumpTable = {
  name: 'tenants',
  ddl: 'CREATE TABLE tenants (tenant_id TEXT)',
  columns: ['tenant_id'],
  rows: [['t1']],
};

/** A `HostAdmin` that only knows how to export the whole directory. */
function fakeAdmin(clock: () => Date, onExport?: () => void): HostAdmin {
  return {
    exportDirectory: async (): Promise<DirectoryDump> => {
      onExport?.();
      return { capturedAt: clock().toISOString(), tables: [TENANTS] };
    },
  } as unknown as HostAdmin;
}

/** A `HostAdmin` that exports in pages: `tenants` spread over the first two, `verticals` in the third. */
function pagedAdmin(clock: () => Date): HostAdmin {
  const pages: ScopeDumpTable[][] = [
    [{ ...TENANTS, rows: [['t1'], ['t2']] }],
    [{ ...TENANTS, rows: [['t3']] }],
    [{ name: 'verticals', ddl: 'CREATE TABLE verticals (slug TEXT)', columns: ['slug'], rows: [['todo']] }],
  ];
  let capturedAt = '';
  return {
    exportDirectoryPage: async (_actor: PlatformActorId, cursor: string | null): Promise<DirectoryDumpPage> => {
      const seq = cursor === null ? 0 : Number(cursor);
      if (seq === 0) capturedAt = clock().toISOString();
      return { capturedAt, tables: pages[seq]!, next: seq + 1 < pages.length ? String(seq + 1) : null };
    },
  } as unknown as HostAdmin;
}

describe('scheduled directory backup (#40)', () => {
  it('takes the first copy when the store is empty — a new deployment is covered at once', async () => {
    const { store, held } = fakeStore();
    const now = new Date('2026-08-06T00:00:00.000Z');
    const result = await backupDirectoryIfDue({
      admin: fakeAdmin(() => now),
      store,
      actor: ACTOR,
      now: () => now,
    });

    expect(result.taken?.capturedAt).toBe('2026-08-06T00:00:00.000Z');
    expect(result.skippedFor).toBeNull();
    expect(await held()).toEqual(['2026-08-06T00:00:00.000Z']);
  });

  it('skips inside the cadence window — a quarter-hourly cron takes ONE copy a day', async () => {
    const { store, held } = fakeStore();
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
    expect(await held()).toHaveLength(1);
  });

  it('takes the next copy once the window has elapsed', async () => {
    const { store, held } = fakeStore();
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
    expect(await held()).toHaveLength(2);
  });

  it('catches up a missed window rather than skipping the day — late, never never', async () => {
    const { store } = fakeStore();
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
    const { store, held } = fakeStore();
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
    expect(await held()).toHaveLength(2);
  });

  it('prunes to the retention window, keeping the NEWEST copies', async () => {
    const { store, held, deleted } = fakeStore();
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
    const kept = await held();
    expect(kept).toHaveLength(30);
    // The oldest five are gone and the newest is kept — the window slides forward.
    expect(kept[0]).toBe('2026-07-06T00:00:00.000Z');
    expect(kept.at(-1)).toBe('2026-08-04T00:00:00.000Z');
    expect(deleted).toHaveLength(5);
  });

  it('never prunes when the capture failed — a broken backup cannot delete the last good one', async () => {
    const { store, held, deleted } = fakeStore();
    const first = new Date('2026-08-06T00:00:00.000Z');
    await backupDirectoryIfDue({ admin: fakeAdmin(() => first), store, actor: ACTOR, retain: 1, now: () => first });
    expect(await held()).toHaveLength(1);

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
    expect(await held()).toEqual(['2026-08-06T00:00:00.000Z']);
    expect(deleted).toEqual([]);
  });

  it('stores a paged copy as pages under a manifest and reads it back whole', async () => {
    const { store, objects } = fakeStore();
    // Pages no commit reached: one copy cut off two days ago, one still being written an hour ago.
    const abandoned = 'directory/2026-08-04T00:00:00.000Z/stage/0.json';
    const inFlight = 'directory/2026-08-05T23:00:00.000Z/stage/0.json';
    for (const key of [abandoned, inFlight]) objects.set(key, { key, body: '{"tables":[]}' });
    const now = new Date('2026-08-06T00:00:00.000Z');
    const result = await backupDirectoryIfDue({ admin: pagedAdmin(() => now), store, actor: ACTOR, now: () => now });

    expect(result.taken).toMatchObject({ capturedAt: '2026-08-06T00:00:00.000Z', tables: 2 });
    // The commit swept the abandoned copy's pages, and left the one a day has not passed on.
    expect(objects.has(abandoned)).toBe(false);
    expect(objects.delete(inFlight)).toBe(true);
    // Three pages and the manifest, all under the store's own prefix; only the manifest is listed.
    const keys = [...objects.keys()].filter((k) => k.startsWith('directory/'));
    expect(keys.filter((k) => k.startsWith('directory/2026-08-06T00:00:00.000Z/'))).toHaveLength(3);
    expect(await store.list()).toEqual([expect.objectContaining({ capturedAt: '2026-08-06T00:00:00.000Z', tables: 2 })]);
    // The restore source joins a table's fragments in page order.
    const dump = await store.get({ capturedAt: '2026-08-06T00:00:00.000Z' });
    expect(dump?.tables.map((t) => [t.name, t.rows])).toEqual([
      ['tenants', [['t1'], ['t2'], ['t3']]],
      ['verticals', [['todo']]],
    ]);

    // Pruning a copy takes its pages with it.
    await store.delete({ capturedAt: '2026-08-06T00:00:00.000Z' });
    expect([...objects.keys()].filter((k) => k.startsWith('directory/'))).toEqual([]);
  });

  it('leaves no listed copy and no pages when a page cannot be stored', async () => {
    const { store, objects, held } = fakeStore({ failOn: (key) => key.endsWith('/1.json') });
    const now = new Date('2026-08-06T00:00:00.000Z');
    await expect(backupDirectoryIfDue({ admin: pagedAdmin(() => now), store, actor: ACTOR, now: () => now })).rejects.toThrow(
      'bucket unavailable',
    );
    expect(await held()).toEqual([]);
    expect([...objects.keys()].filter((k) => k.startsWith('directory/'))).toEqual([]);
  });

  it('still reads a copy written whole, before copies were paged', async () => {
    const { store, objects } = fakeStore();
    const capturedAt = '2026-08-01T00:00:00.000Z';
    objects.set(`directory/${capturedAt}.json`, {
      key: `directory/${capturedAt}.json`,
      body: JSON.stringify({ capturedAt, tables: [TENANTS] }),
      customMetadata: { capturedAt, tables: '1' },
    });
    expect(await store.list()).toEqual([expect.objectContaining({ capturedAt, tables: 1 })]);
    expect(await store.get({ capturedAt })).toEqual({ capturedAt, tables: [TENANTS] });
  });

  it('waits a failed copy out instead of trying again every pass', async () => {
    const { store } = fakeStore();
    let exports = 0;
    const broken = {
      exportDirectory: async () => {
        exports += 1;
        throw new Error("Durable Object's isolate exceeded its memory limit and was reset.");
      },
    } as unknown as HostAdmin;
    // A day of the deployed `*/15` cron against a directory that cannot be copied.
    for (let tick = 0; tick < 96; tick++) {
      const now = new Date(Date.UTC(2026, 7, 6) + tick * 15 * 60_000);
      await backupDirectoryIfDue({ admin: broken, store, actor: ACTOR, now: () => now }).catch(() => undefined);
    }
    // Every six hours, not ninety-six times.
    expect(exports).toBe(4);

    const now = new Date(Date.UTC(2026, 7, 6, 23, 50));
    const waiting = await backupDirectoryIfDue({ admin: fakeAdmin(() => now), store, actor: ACTOR, now: () => now });
    expect(waiting).toMatchObject({ taken: null, waitingOutAttempt: '2026-08-06T18:00:00.000Z' });
    // The operator's "back up now" does not wait.
    const forced = await backupDirectoryIfDue({ admin: fakeAdmin(() => now), store, actor: ACTOR, force: true, now: () => now });
    expect(forced.taken?.capturedAt).toBe(now.toISOString());
  });
});
