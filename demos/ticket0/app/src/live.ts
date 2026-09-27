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
 * - **A poll**, which stays as the floor. While the socket is open it runs at the
 *   screen's `connectedMs` (`PACE`, in `pace.ts`), which covers whatever the feed does
 *   not announce (a new tag in the vocabulary, the visitor card) and a frame lost to a
 *   dropped connection. With no socket it runs at `everyMs`, exactly as it always did.
 *   That covers the dev server, which answers 501 because its host has no live reads,
 *   and a hostname that cannot carry a WebSocket.
 *
 * The socket itself, its reconnects and when it gives up are `feed.ts`, which the node
 * suite drives with a fake socket. This file binds that to the browser and to React.
 *
 * Paced the same way the widget is: nothing at all while the tab is hidden, and an
 * immediate refetch the moment it comes back, which is the gesture that actually
 * matters, because you switch to the tab to see what changed. A frame that arrives
 * while hidden is dropped for the same reason: coming back re-reads anyway.
 */
import { useEffect, useRef } from 'react';
import { createFeed, type FeedListener, type LiveChange, type SocketLike } from './feed.js';
import { pollPace, type Pace } from './pace.js';
import { createRefresh } from './refresh.js';

/** The tab's one feed, bound to the browser's socket and clock. */
export const liveFeed = createFeed({
  connect: () => {
    if (typeof WebSocket === 'undefined') return null;
    const url = new URL('/api/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.onopen = () => socket.onopen?.();
    ws.onmessage = (event) => socket.onmessage?.(event);
    ws.onclose = () => socket.onclose?.();
    return socket;
  },
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
});

/**
 * Re-run `reload` when something this screen shows may have changed.
 *
 * `hears` narrows which frames count. The default is all of them, which suits a list.
 * A screen about one thing passes a filter, since every frame is a re-read. Both
 * triggers call the same `reload`, so a caller writes its read once.
 *
 * `reload` returns `false` when it declined to read (the inbox does mid-append). A
 * refresh a push or a return to the tab asked for then stays pending and is retried,
 * rather than being dropped while the poll is pushed back a whole interval
 * (`refresh.ts`).
 */
export function useLiveReload(
  reload: () => boolean | void,
  pace: Pace,
  hears: (change: LiveChange) => boolean = () => true,
): void {
  // Kept in refs so a caller does not have to memoise its callbacks to avoid
  // restarting the timer (or reconnecting) on every render.
  const { everyMs, connectedMs } = pace;
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
      const every = pollPace({ everyMs, connectedMs }, liveFeed.isOpen());
      if (!document.hidden) timer = setInterval(() => latest.current(), every);
    };
    // A refresh that is done only once a read has run; the poll then counts from it.
    const refresh = createRefresh({
      reload: () => latest.current(),
      afterRead: () => start(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    });
    const onVisible = () => {
      if (!document.hidden) {
        refresh.request();
        liveFeed.wake();
      }
      start();
    };

    const listener: FeedListener = {
      frame: (change) => {
        if (!document.hidden && filter.current(change)) refresh.request();
      },
      state: (open) => {
        // Opening re-reads once: anything that changed between this screen's last read
        // and the subscription starting was announced to nobody. Either way the poll's
        // pace follows the feed.
        if (open && !document.hidden) refresh.request();
        start();
      },
    };
    const unlisten = liveFeed.listen(listener);
    // Joining a feed that is already open fires no `state`: this screen's own first load
    // is what covers the gap, and `start` asks the feed for the connected pace.
    start();
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('focus', onVisible);
    return () => {
      stop();
      refresh.cancel();
      unlisten();
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('focus', onVisible);
    };
  }, [everyMs, connectedMs]);
}
