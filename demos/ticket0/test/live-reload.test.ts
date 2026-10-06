/**
 * The path a push takes to a re-read, and the poll that stands in for it (#938).
 *
 * Driven through a real `createFeed` with a fake socket, so what is held is the whole
 * client half: a frame arriving on the socket, the screen's read running because of it,
 * the poll's pace following whether the socket is open, and a hidden tab doing nothing
 * until it comes back. The pace is the portal's, the screen this change made live; the
 * other screens share the binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeed, type Feed, type SocketLike } from '../app/src/feed.js';
import { bindLiveReload, type PageLike } from '../app/src/live-reload.js';
import { LIVE_FLOOR_MS, PACE } from '../app/src/pace.js';
import { REFRESH_TIMING } from '../app/src/refresh.js';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
};

let socket: FakeSocket | null;
/** Whether the next connect gets a socket, or finds no WebSocket at all. */
let canConnect: boolean;
let feed: Feed;
let hidden: boolean;
let comeBack: (() => void) | null;
const page: PageLike = {
  hidden: () => hidden,
  onReturn: (fn) => {
    comeBack = fn;
    return () => (comeBack = null);
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  socket = null;
  canConnect = true;
  hidden = false;
  comeBack = null;
  feed = createFeed({
    connect: () => (canConnect ? (socket = new FakeSocket()) : null),
    now: () => Date.now(),
    ...timers,
  });
});
afterEach(() => vi.useRealTimers());

/** A screen bound to the feed, counting its reads. */
function screen(hears: Parameters<typeof bindLiveReload>[0]['hears'] = () => true) {
  const reads = { count: 0 };
  const stop = bindLiveReload({ feed, pace: PACE.portal, reload: () => void (reads.count += 1), hears, page, ...timers });
  return { reads, stop };
}

const nudge = () => socket!.onmessage?.({ data: JSON.stringify({ kind: 'nudge', id: '01', at: 'now' }) });

describe('a push is a re-read', () => {
  it('re-reads once for a burst of nudges, through the screen’s own read', () => {
    const { reads } = screen();
    socket!.onopen?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    const afterOpen = reads.count;
    nudge();
    nudge();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(reads.count).toBe(afterOpen + 1);
  });

  it('does not re-read for a frame the screen does not hear — the twin', () => {
    const { reads } = screen((frame) => frame.kind === 'change');
    socket!.onopen?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    const afterOpen = reads.count;
    nudge();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(reads.count).toBe(afterOpen);
  });

  it('re-reads once when the feed opens: what changed before it opened was announced to nobody', () => {
    const { reads } = screen();
    expect(reads.count).toBe(0);
    socket!.onopen?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(reads.count).toBe(1);
  });
});

describe('the poll is the fallback', () => {
  it('polls at the screen’s own pace when there is no socket at all', () => {
    canConnect = false;
    const { reads } = screen();
    vi.advanceTimersByTime(PACE.portal.everyMs * 3);
    expect(reads.count).toBe(3);
  });

  it('slows to the floor while the socket is open, and returns to its pace when it drops', () => {
    const { reads } = screen();
    socket!.onopen?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    const open = reads.count;
    // The read on opening restarted the poll, so the next one is a whole floor after it.
    vi.advanceTimersByTime(LIVE_FLOOR_MS - 1);
    expect(reads.count).toBe(open);
    vi.advanceTimersByTime(1);
    expect(reads.count).toBe(open + 1);

    socket!.onclose?.();
    const dropped = reads.count;
    vi.advanceTimersByTime(PACE.portal.everyMs);
    expect(reads.count).toBe(dropped + 1);
  });
});

describe('a hidden tab', () => {
  it('neither polls nor re-reads on a nudge, and catches up the moment it comes back', () => {
    const { reads } = screen();
    socket!.onopen?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    const before = reads.count;

    hidden = true;
    comeBack?.();
    nudge();
    vi.advanceTimersByTime(LIVE_FLOOR_MS * 2);
    expect(reads.count).toBe(before);

    hidden = false;
    comeBack?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    expect(reads.count).toBe(before + 1);
  });
});

describe('stopping', () => {
  it('reads nothing more once the screen lets go', () => {
    const { reads, stop } = screen();
    socket!.onopen?.();
    vi.advanceTimersByTime(REFRESH_TIMING.burstMs);
    const before = reads.count;
    stop();
    nudge();
    vi.advanceTimersByTime(LIVE_FLOOR_MS * 2);
    expect(reads.count).toBe(before);
  });
});
