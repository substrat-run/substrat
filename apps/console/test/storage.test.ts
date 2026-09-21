import { describe, expect, it } from 'vitest';
import type { StorageMeterReading } from '@substrat-run/contracts';
import { foldStoragePage, formatBytes, partialNote, scopesLeftOut } from '../src/lib/storage';

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
  it('is complete only for a single page the platform itself marked complete', () => {
    const one = foldStoragePage(null, page({ bytes: 300, read: 3, total: 3, complete: true }));
    expect(one).toMatchObject({ complete: true, directoryMayHaveChanged: false, pages: 1 });
    expect(scopesLeftOut(one)).toBe(0);
    // The platform's own verdict is the one that counts: a page it called partial stays so.
    const failedOne = foldStoragePage(null, page({ bytes: 200, read: 2, failed: 1, total: 3, complete: false }));
    expect(failedOne.complete).toBe(false);
    expect(scopesLeftOut(failedOne)).toBe(1);
  });

  it('never calls a multi-page walk complete, even when every count agrees', () => {
    const first = foldStoragePage(null, page({ bytes: 100, read: 2, total: 3, nextCursor: 'S2' as never, complete: false }));
    expect(first.complete).toBe(false);
    const last = foldStoragePage(first, page({ bytes: 50, read: 1, total: 3, readAt: '2026-09-21T09:05:00.000Z' as never }));
    expect(last).toMatchObject({ bytes: 150, read: 3, total: 3, pages: 2, nextCursor: null });
    expect(last.complete).toBe(false);
    expect(last.directoryMayHaveChanged).toBe(true);
    // Quoted from when the tally began, not from its last page.
    expect(last.readAt).toBe('2026-09-21T09:00:00.000Z');
  });

  it('does not mistake a substitution for a total (the case count equality misses)', () => {
    // Page 1 reads S1 and S3. Then S1 is reaped and S0 is provisioned; S0 sorts before the
    // cursor, so no later page reads it. The last page reads S4. read = 3 = total, no
    // failures, and the tally holds S1 (gone) but not S0 (live).
    const first = foldStoragePage(null, page({ bytes: 20, read: 2, total: 3, nextCursor: 'S3' as never, complete: false }));
    const last = foldStoragePage(first, page({ bytes: 10, read: 1, total: 3 }));
    expect(last.read).toBe(last.total);
    expect(last.failed).toBe(0);
    expect(last.complete).toBe(false);
    expect(partialNote(last)).toMatch(/directory may have changed/);
  });

  it('stays partial after a failed read, and lists it', () => {
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
});

describe('scopesLeftOut / partialNote', () => {
  it('never says a negative number of scopes when a read scope was reaped mid-walk', () => {
    // Three scopes on page 1, one reaped before page 2: the last listing says total 3,
    // but four were read.
    const first = foldStoragePage(null, page({ bytes: 30, read: 3, total: 4, nextCursor: 'S3' as never, complete: false }));
    const last = foldStoragePage(first, page({ bytes: 10, read: 1, total: 3 }));
    expect(last.read - last.total).toBe(1);
    expect(scopesLeftOut(last)).toBeNull();
    const note = partialNote(last);
    expect(note).not.toMatch(/-\d/);
    expect(note).toMatch(/cannot be said/);
  });

  it('counts what a single page left out, which it can say exactly', () => {
    const tally = foldStoragePage(null, page({ bytes: 50, read: 50, total: 120, nextCursor: 'S50' as never, complete: false }));
    expect(scopesLeftOut(tally)).toBe(70);
    expect(partialNote(tally)).toBe("This sum leaves out 70 scopes. It is not this tenant's storage total.");
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
