import { describe, expect, it, vi } from 'vitest';
import { changePeerAccess, validPeerReason } from '../web/src/lib/peer-switch.js';

describe('dashboard peer switch confirmation', () => {
  it('does not refresh or claim success when the write fails', async () => {
    const error = new Error('forbidden');
    const read = vi.fn();
    expect(await changePeerAccess(async () => { throw error; }, read)).toEqual({ kind: 'write-failed', error });
    expect(read).not.toHaveBeenCalled();
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

  it('requires a nonblank reason within the server limit', () => {
    expect(validPeerReason('   ')).toBe(false);
    expect(validPeerReason('x'.repeat(501))).toBe(false);
    expect(validPeerReason(' incident resolved ')).toBe(true);
    expect(validPeerReason('x'.repeat(500))).toBe(true);
  });
});
