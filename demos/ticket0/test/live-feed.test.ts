/**
 * The app's live feed, as a state machine (#938): when it reconnects, how fast, and
 * when it stops. Driven with a fake socket and fake timers, since what is held here is
 * timing that a browser would take minutes to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_TIMING, createFeed, type Feed, type SocketLike } from '../app/src/feed.js';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  send(): void {}
  close(): void {
    this.closed = true;
  }
  /** The server accepts. */
  accept(): void {
    this.onopen?.();
  }
  /** The connection ends, from the server's side or the network's. */
  drop(): void {
    this.onclose?.();
  }
}

let sockets: FakeSocket[];
let feed: Feed;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  feed = createFeed({
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
  });
});
afterEach(() => vi.useRealTimers());

const listener = () => ({ frame: vi.fn(), state: vi.fn() });
const latest = () => sockets[sockets.length - 1]!;

describe('the live feed reconnects', () => {
  it('backs off a socket that opens and drops straight away, rather than reconnecting every second', () => {
    feed.listen(listener());
    for (const [failures, wait] of [
      [1, 2_000],
      [2, 4_000],
    ] as const) {
      latest().accept();
      latest().drop();
      const before = sockets.length;
      vi.advanceTimersByTime(wait - 1);
      expect(sockets.length, `after ${failures} short-lived connection(s)`).toBe(before);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(before + 1);
    }
  });

  it('comes back after a second when a connection that held for a while drops', () => {
    feed.listen(listener());
    // Two short-lived ones first, so a reset is what the one-second wait proves.
    latest().drop();
    vi.advanceTimersByTime(2_000);
    latest().drop();
    vi.advanceTimersByTime(4_000);

    latest().accept();
    vi.advanceTimersByTime(FEED_TIMING.stableMs);
    latest().drop();
    const before = sockets.length;
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBe(before + 1);
  });

  it('rests for a long while after three failed attempts, then tries again', () => {
    feed.listen(listener());
    latest().drop();
    vi.advanceTimersByTime(2_000);
    latest().drop();
    vi.advanceTimersByTime(4_000);
    latest().drop();
    const before = sockets.length;
    vi.advanceTimersByTime(FEED_TIMING.restMs - 1);
    expect(sockets.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(before + 1);
  });

  it('tries at once when woken during that rest, and not when it is already connected', () => {
    feed.listen(listener());
    for (let i = 0; i < FEED_TIMING.giveUpAfter; i++) {
      latest().drop();
      vi.advanceTimersByTime(1000 * 2 ** (i + 1));
    }
    const resting = sockets.length;
    feed.wake();
    expect(sockets.length).toBe(resting + 1);

    latest().accept();
    feed.wake();
    expect(sockets.length).toBe(resting + 1);
  });

  it('tells its listeners when it opens and when it closes', () => {
    const l = listener();
    feed.listen(l);
    latest().accept();
    expect(l.state).toHaveBeenLastCalledWith(true);
    expect(feed.isOpen()).toBe(true);
    latest().drop();
    expect(l.state).toHaveBeenLastCalledWith(false);
    expect(feed.isOpen()).toBe(false);
  });
});
