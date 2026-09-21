import { describe, expect, it } from 'vitest';
import type { StorageMeterReading } from '@substrat-run/contracts';
import { foldStoragePage, formatBytes } from '../src/lib/storage';

/**
 * The storage card's tally (#1524). The property under test is that a partial sum is
 * never presented as the tenant's total, whether a read failed, a page is left, or the
 * tenant gained a scope while it was being read.
 */

const page = (over: Partial<StorageMeterReading>): StorageMeterReading => ({
  tenantId: '01JZ0000000000000000TEN001' as never,
  readAt: '2026-09-21T09:00:00.000Z' as never,
  basis: 'scope-databases',
  excluded: ['attachments', 'tenant-stores', 'lake'],
  bytes: 0,
  scopes: [],
  read: 0,
  failed: 0,
  total: 0,
  reaped: 0,
  nextCursor: null,
  complete: true,
  ...over,
});

describe('foldStoragePage', () => {
  it('is complete only once the last page is in and every read answered', () => {
    const first = foldStoragePage(null, page({ bytes: 100, read: 2, total: 3, nextCursor: 'S2' as never, complete: false }));
    expect(first.complete).toBe(false);
    const last = foldStoragePage(first, page({ bytes: 50, read: 1, total: 3, readAt: '2026-09-21T09:05:00.000Z' as never }));
    expect(last).toMatchObject({ bytes: 150, read: 3, total: 3, complete: true, nextCursor: null });
    // Quoted from when the tally began, not from its last page.
    expect(last.readAt).toBe('2026-09-21T09:00:00.000Z');
  });

  it('stays partial after a failed read, however the pages end', () => {
    const tally = foldStoragePage(
      null,
      page({
        bytes: 100,
        read: 1,
        failed: 1,
        total: 2,
        complete: false,
        scopes: [
          { scopeId: 'S1' as never, status: 'active', bytes: 100 },
          { scopeId: 'S2' as never, status: 'active', bytes: null, error: 'DO unreachable' },
        ],
      }),
    );
    expect(tally.complete).toBe(false);
    expect(tally.failures).toEqual([{ scopeId: 'S2', error: 'DO unreachable' }]);
  });

  it('stays partial when the tenant grew a scope between pages', () => {
    const first = foldStoragePage(null, page({ bytes: 10, read: 1, total: 2, nextCursor: 'S1' as never, complete: false }));
    // The new scope sorted before the cursor: the last page reads one, and now counts three.
    const last = foldStoragePage(first, page({ bytes: 10, read: 1, total: 3 }));
    expect(last.nextCursor).toBeNull();
    expect(last.complete).toBe(false);
  });
});

describe('formatBytes', () => {
  it('uses binary units and stays exact below one KiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MiB');
  });
});
