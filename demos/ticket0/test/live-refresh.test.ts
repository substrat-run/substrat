/**
 * A refresh a push asked for is done only when a read has run (#938).
 *
 * The inbox declines a read while it is appending a page. A frame arriving then must
 * not be forgotten with the poll pushed back a whole connected interval, which left the
 * change it announced invisible for up to a minute. Each case is beside its twin: the
 * same request with the screen free to read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_TIMING, createRefresh } from '../app/src/refresh.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A screen whose read is declined while `appending` is true, as the inbox's is. */
function screen() {
  const state = { appending: false, reads: 0 };
  const afterRead = vi.fn();
  const refresh = createRefresh({
    reload: () => {
      if (state.appending) return false;
      state.reads += 1;
    },
    afterRead,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  });
  return { state, afterRead, refresh };
}

describe('a pushed refresh', () => {
  it('stays pending while the screen declines, and reads once the append settles, restarting the poll only then', () => {
    const { state, afterRead, refresh } = screen();
    state.appending = true;
    refresh.request();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(state.reads).toBe(0);
    // The poll is NOT pushed back by a read that did not happen.
    expect(afterRead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REFRESH_TIMING.retryMs * 3);
    expect(state.reads).toBe(0);
    expect(afterRead).not.toHaveBeenCalled();

    state.appending = false; // the page landed
    vi.advanceTimersByTime(REFRESH_TIMING.retryMs);
    expect(state.reads).toBe(1);
    expect(afterRead).toHaveBeenCalledOnce();
  });

  it('reads at once when the screen is free, and restarts the poll from that read', () => {
    const { state, afterRead, refresh } = screen();
    refresh.request();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(state.reads).toBe(1);
    expect(afterRead).toHaveBeenCalledOnce();
  });

  it('makes one read of requests arriving together', () => {
    const { state, refresh } = screen();
    refresh.request();
    refresh.request();
    refresh.request();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(state.reads).toBe(1);
  });

  it('stops retrying once the screen has gone', () => {
    const { state, afterRead, refresh } = screen();
    state.appending = true;
    refresh.request();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    refresh.cancel();
    state.appending = false;
    vi.advanceTimersByTime(REFRESH_TIMING.retryMs * 10);
    expect(state.reads).toBe(0);
    expect(afterRead).not.toHaveBeenCalled();
  });
});
