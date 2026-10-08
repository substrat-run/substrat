import { describe, expect, it, vi } from 'vitest';
import { changePeerAccess, validPeerReason } from '../web/src/lib/peer-switch.js';

describe('dashboard peer switch confirmation', () => {
  it('does not refresh or claim success when the write is refused', async () => {
    for (const status of [403, 404, 409, 501]) {
      const error = Object.assign(new Error('forbidden'), { status });
      const read = vi.fn();
      expect(await changePeerAccess(async () => { throw error; }, read)).toEqual({ kind: 'write-failed', error });
      expect(read).not.toHaveBeenCalled();
    }
  });

  // #2010: a write whose answer was lost may have moved the switch. It is never a refusal to
  // retry; the position is read again, which is the confirmation the failure asks for.
  it('a write that failed without proving nothing moved is unknown, and reads the position', async () => {
    const view = { callers: [{ vertical: 'acme/board-room', calls: 'off' }] };
    for (const error of [
      Object.assign(new Error('the switch may or may not have moved'), { status: 502 }),
      Object.assign(new Error('internal error'), { status: 500 }),
      new TypeError('Failed to fetch'),
    ]) {
      const read = vi.fn().mockResolvedValue(view);
      expect(await changePeerAccess(async () => { throw error; }, read)).toEqual({ kind: 'unknown', error, view });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('an unknown write whose re-read fails too carries both failures', async () => {
    const error = Object.assign(new Error('lost'), { status: 502 });
    const readError = new Error('unavailable');
    expect(await changePeerAccess(async () => { throw error; }, async () => { throw readError; })).toEqual({
      kind: 'unknown',
      error,
      view: null,
      readError,
    });
  });

  it('reports an applied write separately when the confirming read fails', async () => {
    const write = vi.fn().mockResolvedValue({ changed: true });
    const error = new Error('unavailable');
    expect(await changePeerAccess(write, async () => { throw error; })).toEqual({ kind: 'unconfirmed', error });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns the fresh position after a successful write', async () => {
    const view = { callers: [{ vertical: 'acme/board-room', calls: 'off' }] };
    expect(await changePeerAccess(async () => ({ changed: true }), async () => view)).toEqual({ kind: 'applied', view });
  });

  it('a write that went through but whose admin-log row was lost carries its auditWarning, applied or unconfirmed (#2089)', async () => {
    const view = { callers: [] };
    const auditWarning = 'the switch completed, but its outcome could not be written to the admin log: log down';
    const write = async () => ({ changed: true, auditWarning });
    expect(await changePeerAccess(write, async () => view)).toEqual({ kind: 'applied', view, auditWarning });
    const error = new Error('unavailable');
    expect(await changePeerAccess(write, async () => { throw error; })).toEqual({ kind: 'unconfirmed', error, auditWarning });
  });

  it('requires a nonblank reason within the server limit', () => {
    expect(validPeerReason('   ')).toBe(false);
    expect(validPeerReason('x'.repeat(501))).toBe(false);
    expect(validPeerReason(' incident resolved ')).toBe(true);
    expect(validPeerReason('x'.repeat(500))).toBe(true);
  });
});

import { showPeerDisclosure } from '../web/src/lib/peer-disclosure.js';

it('discloses legacy unenforced callers, hiding only a known empty declaration', () => {
  const empty = { declares: [], calls: [], callers: [], callersError: null };
  expect(showPeerDisclosure(empty)).toBe(false);
  expect(showPeerDisclosure({ ...empty, declares: null })).toBe(true);
  expect(showPeerDisclosure({ ...empty, declares: ['acme/crm'] })).toBe(true);
  expect(showPeerDisclosure({ ...empty, callersError: 'unreadable' })).toBe(true);
});
