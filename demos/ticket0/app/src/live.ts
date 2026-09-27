/**
 * Keep a screen current without making it expensive.
 *
 * The inbox used to load once and never again — so a conversation that arrived while
 * you had it open simply was not there, and the only way to find out was to reload.
 * For a queue somebody is watching, that is the whole point of the screen.
 *
 * Two triggers into the same reload, and neither is the source of truth:
 *
 * - **A push** (#938). The desk's change feed at `/api/live`, one socket per tab. A
 *   frame names an entity that changed and carries nothing else, and the screen
 *   re-reads through the operation it already calls. So a push can make a screen
 *   current sooner and can never show it something the read would not have.
 * - **A poll**, which stays as the floor. While the socket is open it slows to
 *   `LIVE_FLOOR_MS`, which covers whatever the feed does not announce (a new tag in
 *   the vocabulary, the visitor card) and a frame lost to a dropped connection. With
 *   no socket it runs at the caller's own pace, exactly as it always did. That covers
 *   the dev server, which answers 501 because its host has no live reads, and a
 *   hostname that cannot carry a WebSocket.
 *
 * Paced the same way the widget is: nothing at all while the tab is hidden, and an
 * immediate refetch the moment it comes back, which is the gesture that actually
 * matters, because you switch to the tab to see what changed. A frame that arrives
 * while hidden is dropped for the same reason: coming back re-reads anyway.
 */
import { useEffect, useRef } from 'react';

/** One frame on the feed: the kernel's `LiveChange`, restated for the browser bundle. */
export interface LiveChange {
  kind: 'change';
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  at: string;
}

/** How often a screen still polls while it is being pushed to. */
export const LIVE_FLOOR_MS = 60_000;
/** Consecutive connections that never opened before the feed stops trying. */
const GIVE_UP_AFTER = 3;
/** Keeps an idle socket from being closed as idle; the scope answers `pong`. */
const PING_MS = 45_000;
/**
 * How long the socket outlives its last listener. Moving from the inbox to a
 * conversation unmounts one screen and mounts the next, and without this every
 * navigation would be a reconnect and a re-read.
 */
const LINGER_MS = 5_000;

type Listener = {
  frame: (change: LiveChange) => void;
  /** The feed opened or closed. On open the screen re-reads, to cover the gap. */
  state: (open: boolean) => void;
};

/**
 * The one socket every mounted screen shares.
 *
 * Module state rather than a context, because there is exactly one feed per tab and the
 * screens that listen come and go. The socket opens when the first listener arrives and
 * closes when the last one leaves.
 */
const feed = {
  listeners: new Set<Listener>(),
  socket: null as WebSocket | null,
  open: false,
  /** Connections in a row that failed before opening. Reset by one that opens. */
  failures: 0,
  retry: null as ReturnType<typeof setTimeout> | null,
  linger: null as ReturnType<typeof setTimeout> | null,
  ping: null as ReturnType<typeof setInterval> | null,
};

function setOpen(open: boolean): void {
  if (feed.open === open) return;
  feed.open = open;
  for (const l of feed.listeners) l.state(open);
}

function connect(): void {
  if (feed.socket || feed.retry || feed.listeners.size === 0) return;
  if (typeof WebSocket === 'undefined' || feed.failures >= GIVE_UP_AFTER) return;

  const url = new URL('/api/live', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  feed.socket = ws;
  let opened = false;

  ws.onopen = () => {
    opened = true;
    feed.failures = 0;
    feed.ping = setInterval(() => ws.send('ping'), PING_MS);
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
    for (const l of feed.listeners) l.frame(change);
  };
  ws.onclose = () => {
    if (feed.ping) clearInterval(feed.ping);
    feed.ping = null;
    feed.socket = null;
    setOpen(false);
    // A socket that never opened is a host saying no: 501 on the dev server, a hop that
    // cannot carry a WebSocket, a signed-out session. The browser does not say which, so
    // a few attempts and then the poll alone, for the life of the tab. A socket that did
    // open and then dropped is a network blip, and is retried with a backoff.
    if (!opened) feed.failures += 1;
    if (feed.listeners.size === 0 || feed.failures >= GIVE_UP_AFTER) return;
    const delay = Math.min(30_000, 1000 * 2 ** feed.failures);
    feed.retry = setTimeout(() => {
      feed.retry = null;
      connect();
    }, delay);
  };
}

function disconnect(): void {
  if (feed.retry) clearTimeout(feed.retry);
  feed.retry = null;
  const ws = feed.socket;
  if (!ws) return;
  ws.onclose = null;
  if (feed.ping) clearInterval(feed.ping);
  feed.ping = null;
  feed.socket = null;
  feed.open = false;
  ws.close(1000, 'no screen is listening');
}

/**
 * Re-run `reload` when something this screen shows may have changed.
 *
 * `hears` narrows which frames count. The default is all of them, which suits a list.
 * A screen about one thing passes a filter, since every frame is a re-read. Both
 * triggers call the same `reload`, so a caller writes its read once.
 */
export function useLiveReload(
  reload: () => void,
  everyMs = 10_000,
  hears: (change: LiveChange) => boolean = () => true,
): void {
  // Kept in refs so a caller does not have to memoise its callbacks to avoid
  // restarting the timer (or reconnecting) on every render.
  const latest = useRef(reload);
  latest.current = reload;
  const filter = useRef(hears);
  filter.current = hears;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      const pace = feed.open ? Math.max(everyMs, LIVE_FLOOR_MS) : everyMs;
      if (!document.hidden) timer = setInterval(() => latest.current(), pace);
    };
    const onVisible = () => {
      if (!document.hidden) latest.current();
      start();
    };

    const listener: Listener = {
      frame: (change) => {
        if (!document.hidden && filter.current(change)) latest.current();
      },
      state: (open) => {
        // Opening re-reads once: anything that changed between this screen's last read
        // and the subscription starting was announced to nobody. Either way the poll's
        // pace follows the feed.
        if (open && !document.hidden) latest.current();
        start();
      },
    };
    feed.listeners.add(listener);
    if (feed.linger) clearTimeout(feed.linger);
    feed.linger = null;
    connect();
    // Joining a feed that is already open fires no `state`: this screen's own first load
    // is what covers the gap, and `start` reads `feed.open` for the slower pace.
    start();
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('focus', onVisible);
    return () => {
      stop();
      feed.listeners.delete(listener);
      if (feed.listeners.size === 0 && !feed.linger) {
        feed.linger = setTimeout(() => {
          feed.linger = null;
          if (feed.listeners.size === 0) disconnect();
        }, LINGER_MS);
      }
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('focus', onVisible);
    };
  }, [everyMs]);
}
