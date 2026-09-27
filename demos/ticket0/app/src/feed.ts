/**
 * The desk's live feed as a state machine: one socket, shared by every screen that
 * listens, reconnecting on its own (#938).
 *
 * Free of the DOM and of React on purpose. The socket and the clock come in as
 * `FeedDeps`, so the node suite drives this with a fake socket and fake timers, and
 * `live.ts` binds it to the browser's `WebSocket` and the hook the screens call.
 */

/**
 * The part of a frame this app reads: the kernel's `LiveChange`, cut down to what the
 * screens act on, since the browser bundle does not depend on the kernel.
 */
export interface LiveChange {
  kind: 'change';
  entityType: string;
  entityId: string;
}

/** What the feed needs of a WebSocket. The browser's satisfies it. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface FeedDeps {
  /** Open a socket to the feed, or null where this runtime has no WebSocket. */
  connect(): SocketLike | null;
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}

export interface FeedListener {
  frame(change: LiveChange): void;
  /** The feed opened or closed. */
  state(open: boolean): void;
}

export const FEED_TIMING = {
  /** Connections in a row that did not hold before the feed stops trying for a while. */
  giveUpAfter: 3,
  /**
   * How long it stops for. Not for good: a hop that could not carry a socket at 9:00
   * may be a network that can at 9:05, and a tab stays open all day. Coming back to the
   * tab tries at once too (`wake`).
   */
  restMs: 5 * 60_000,
  /**
   * How long a connection has to stay open to count as a good one. A socket that opens
   * and drops straight away is a failure like one that never opened. Otherwise a hop
   * that accepts the handshake and cuts it would reconnect every second, and each
   * reconnect is a re-read of every screen listening.
   */
  stableMs: 10_000,
  /** The ceiling on the wait between attempts. */
  maxBackoffMs: 30_000,
  /** Keeps an idle socket from being closed as idle; the scope answers `pong`. */
  pingMs: 45_000,
  /**
   * How long the socket outlives its last listener. Moving from the inbox to a
   * conversation unmounts one screen and mounts the next, and without this every
   * navigation would be a reconnect and a re-read.
   */
  lingerMs: 5_000,
} as const;

export interface Feed {
  /** Start hearing frames. Opens the socket if nobody was listening. Returns the unlisten. */
  listen(listener: FeedListener): () => void;
  isOpen(): boolean;
  /**
   * Try now, if the feed is waiting to try. Called when the tab becomes visible, which is
   * when a person is about to look and a connection is worth an attempt.
   */
  wake(): void;
  /**
   * The session is over: close the socket and never open another. A signed-out tab
   * holding a subscription made for the person who was signed in is exactly what must
   * not outlive the session, and signing back in is a page load, which makes a new feed.
   */
  end(): void;
}

/**
 * The client's fetch, ending `feed` on the first 401 it sees. Any read answering 401
 * means the session this feed was opened for is gone, whichever screen noticed first.
 */
export function endingOnUnauthorized<F extends (...args: never[]) => Promise<Response>>(
  fetchImpl: F,
  feed: Pick<Feed, 'end'>,
): F {
  return (async (...args: Parameters<F>) => {
    const res = await fetchImpl(...args);
    if (res.status === 401) feed.end();
    return res;
  }) as F;
}

export function createFeed(deps: FeedDeps): Feed {
  const listeners = new Set<FeedListener>();
  let socket: SocketLike | null = null;
  let open = false;
  /** When the current socket opened, or null while it has not. */
  let openedAt: number | null = null;
  /** Connections in a row that did not hold. Reset by one that stayed up `stableMs`. */
  let failures = 0;
  let retry: Timer | null = null;
  let linger: Timer | null = null;
  let ping: Timer | null = null;
  let ended = false;

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    for (const l of listeners) l.state(next);
  }

  /** Forget the socket, and tell whoever is still listening that the feed is closed. */
  function teardown(): void {
    if (ping) deps.clearInterval(ping);
    ping = null;
    socket = null;
    openedAt = null;
    setOpen(false);
  }

  function scheduleRetry(): void {
    // A few attempts, then a long rest with the poll alone. The browser does not say why
    // a handshake failed (501 on the dev server, a hop that cannot carry a WebSocket, a
    // session that ended), so there is nothing better to go on than the count.
    if (listeners.size === 0) return;
    const delay =
      failures >= FEED_TIMING.giveUpAfter
        ? FEED_TIMING.restMs
        : Math.min(FEED_TIMING.maxBackoffMs, 1000 * 2 ** failures);
    retry = deps.setTimeout(() => {
      retry = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (ended || socket || retry || listeners.size === 0) return;
    const ws = deps.connect();
    if (!ws) return;
    socket = ws;

    ws.onopen = () => {
      openedAt = deps.now();
      ping = deps.setInterval(() => ws.send('ping'), FEED_TIMING.pingMs);
      setOpen(true);
    };
    ws.onmessage = (event) => {
      if (event.data === 'pong') return;
      let change: LiveChange;
      try {
        change = JSON.parse(String(event.data)) as LiveChange;
      } catch {
        return;
      }
      if (change.kind !== 'change') return;
      for (const l of listeners) l.frame(change);
    };
    ws.onclose = () => {
      const held = openedAt !== null && deps.now() - openedAt >= FEED_TIMING.stableMs;
      teardown();
      failures = held ? 0 : failures + 1;
      scheduleRetry();
    };
  }

  function disconnect(reason: string): void {
    if (retry) deps.clearTimeout(retry);
    retry = null;
    const ws = socket;
    if (!ws) return;
    ws.onclose = null;
    teardown();
    ws.close(1000, reason);
  }

  return {
    listen(listener) {
      listeners.add(listener);
      if (linger) deps.clearTimeout(linger);
      linger = null;
      connect();
      return () => {
        listeners.delete(listener);
        // A listen clears the linger, so it only runs out with nobody listening.
        if (listeners.size === 0) {
          linger = deps.setTimeout(() => {
            linger = null;
            disconnect('no screen is listening');
          }, FEED_TIMING.lingerMs);
        }
      };
    },
    isOpen: () => open,
    wake() {
      if (ended || socket || !retry) return;
      deps.clearTimeout(retry);
      retry = null;
      connect();
    },
    end() {
      ended = true;
      if (linger) deps.clearTimeout(linger);
      linger = null;
      disconnect('the session ended');
    },
  };
}
