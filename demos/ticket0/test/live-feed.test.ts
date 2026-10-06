/**
 * The app's live feed, as a state machine (#938): when it reconnects, how fast, and
 * when it stops. Driven with a fake socket and fake timers, since what is held here is
 * timing that a browser would take minutes to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_TOO_MANY,
  FEED_TIMING,
  createFeed,
  endingOnUnauthorized,
  feedSet,
  type Feed,
  type SocketLike,
} from '../app/src/feed.js';

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
  drop(code?: number): void {
    this.onclose?.(code === undefined ? undefined : { code });
  }
}

let sockets: FakeSocket[];
let feed: Feed;

/** A feed on fake sockets, each one pushed to `sockets` as it is opened. */
const makeFeed = (): Feed =>
  createFeed({
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

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  feed = makeFeed();
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

describe('the live feed ends with the session', () => {
  it('closes on the first 401 any read gets, tells its listeners, and never opens again', async () => {
    const l = listener();
    feed.listen(l);
    latest().accept();
    const read = endingOnUnauthorized(async () => new Response(null, { status: 401 }), feed);

    await read();
    expect(latest().closed).toBe(true);
    expect(l.state).toHaveBeenLastCalledWith(false);
    const after = sockets.length;
    feed.wake();
    feed.listen(listener());
    vi.advanceTimersByTime(FEED_TIMING.restMs * 2);
    expect(sockets.length).toBe(after);
  });

  it('ends every feed the page opened — the desk’s and a portal conversation’s — on one 401', async () => {
    const page = feedSet();
    const desk = page.track(feed);
    const portal = page.track(makeFeed());
    desk.listen(listener());
    const deskSocket = latest();
    portal.listen(listener());
    const portalSocket = latest();
    deskSocket.accept();
    portalSocket.accept();

    await endingOnUnauthorized(async () => new Response(null, { status: 401 }), page)();
    expect(deskSocket.closed).toBe(true);
    expect(portalSocket.closed).toBe(true);
    expect(portal.isOpen()).toBe(false);
    // A conversation opened after the session ended never connects at all.
    const after = sockets.length;
    page.track(makeFeed()).listen(listener());
    vi.advanceTimersByTime(FEED_TIMING.restMs * 2);
    expect(sockets.length).toBe(after);
  });

  it('leaves the feed alone on any other answer', async () => {
    feed.listen(listener());
    latest().accept();
    for (const status of [200, 403, 404, 500]) {
      await endingOnUnauthorized(async () => new Response(null, { status }), feed)();
    }
    expect(latest().closed).toBe(false);
    expect(feed.isOpen()).toBe(true);
  });
});

describe('the live feed told it holds too many sockets (#938)', () => {
  it(`stops asking after a ${CLOSE_TOO_MANY} close, and the screen keeps polling`, () => {
    const l = listener();
    feed.listen(l);
    latest().accept();
    latest().drop(CLOSE_TOO_MANY);
    expect(l.state).toHaveBeenLastCalledWith(false);
    const after = sockets.length;
    feed.wake();
    vi.advanceTimersByTime(FEED_TIMING.restMs * 2);
    expect(sockets.length).toBe(after);
  });

  it('reconnects after any other close — the twin', () => {
    feed.listen(listener());
    latest().accept();
    latest().drop(1008);
    const after = sockets.length;
    vi.advanceTimersByTime(FEED_TIMING.maxBackoffMs);
    expect(sockets.length).toBe(after + 1);
  });
});

describe('the live feed hands on what a scope sends', () => {
  const deliver = (data: unknown) => latest().onmessage?.({ data });

  it('hands a change to every listener, and a nudge too (the portal’s feed sends only those)', () => {
    const l = listener();
    feed.listen(l);
    latest().accept();
    deliver(JSON.stringify({ kind: 'change', id: '1', type: 't', entityType: 'message', entityId: 'm', at: 'x' }));
    deliver(JSON.stringify({ kind: 'nudge', id: '2', at: 'x' }));
    expect(l.frame.mock.calls.map(([f]) => f.kind)).toEqual(['change', 'nudge']);
  });

  it('drops a pong, a frame it cannot parse, and a kind it does not know', () => {
    const l = listener();
    feed.listen(l);
    latest().accept();
    deliver('pong');
    deliver('{not json');
    deliver('null');
    deliver(JSON.stringify({ kind: 'payload', body: 'never' }));
    expect(l.frame).not.toHaveBeenCalled();
  });
});
