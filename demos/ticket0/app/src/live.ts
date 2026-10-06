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
 *   current sooner and can never show it something the read would not have. The
 *   portal's conversation view holds its own feed instead (`portalFeed`), whose frames
 *   name nothing at all.
 * - **A poll**, which stays as the floor. While the socket is open it runs at the
 *   screen's `connectedMs` (`PACE`, in `pace.ts`), which covers whatever the feed does
 *   not announce (a new tag in the vocabulary, the visitor card) and a frame lost to a
 *   dropped connection. With no socket it runs at `everyMs`, exactly as it always did.
 *   That covers the dev server, which answers 501 because its host has no live reads,
 *   and a hostname that cannot carry a WebSocket.
 *
 * The socket itself, its reconnects and when it gives up are `feed.ts`, and the two
 * triggers into a read are `live-reload.ts`. The node suite drives both with fakes; this
 * file binds them to the browser and to React.
 *
 * Paced the same way the widget is: nothing at all while the tab is hidden, and an
 * immediate refetch the moment it comes back, which is the gesture that actually
 * matters, because you switch to the tab to see what changed. A frame that arrives
 * while hidden is dropped for the same reason: coming back re-reads anyway.
 */
import { useEffect, useRef } from 'react';
import { createFeed, feedSet, type Feed, type LiveFrame, type SocketLike } from './feed.js';
import { bindLiveReload } from './live-reload.js';
import type { Pace } from './pace.js';

/**
 * Every feed this page opened. A 401 on any read ends them all (`api.ts`): each socket was
 * opened for the session that just ended.
 */
export const feeds = feedSet();

/** A feed on `path`, bound to the browser's socket and clock, and tracked in `feeds`. */
export function browserFeed(path: string): Feed {
  return feeds.track(createFeed({
    connect: () => {
      if (typeof WebSocket === 'undefined') return null;
      const url = new URL(path, location.href);
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
      ws.onclose = (event) => socket.onclose?.({ code: event.code });
      return socket;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
  }));
}

/** The tab's one desk feed (`/api/live`), shared by every staff screen. */
export const liveFeed = browserFeed('/api/live');

const portalFeeds = new Map<string, Feed>();

/**
 * The portal's feed for one conversation (`harness/portal-live.ts`): nudges only, about
 * the public messages a customer may read. One per conversation for the life of the tab,
 * as the desk feed is one, so coming back to a conversation within the feed's linger
 * finds its socket still open rather than opening a second one. A feed nobody listens to
 * holds no socket.
 */
export function portalFeed(conversationId: string): Feed {
  let feed = portalFeeds.get(conversationId);
  if (!feed) {
    feed = browserFeed(`/api/conversations/${encodeURIComponent(conversationId)}/live`);
    portalFeeds.set(conversationId, feed);
  }
  return feed;
}

/**
 * Re-run `reload` when something this screen shows may have changed.
 *
 * `hears` narrows which frames count. The default is all of them, which suits a list.
 * A screen about one thing passes a filter, since every frame is a re-read. Both
 * triggers call the same `reload`, so a caller writes its read once. `feed` is the desk's
 * unless the screen has one of its own (the portal's conversation view).
 *
 * `reload` returns `false` when it declined to read (the inbox does mid-append). A
 * refresh a push or a return to the tab asked for then stays pending and is retried,
 * rather than being dropped while the poll is pushed back a whole interval
 * (`refresh.ts`).
 */
export function useLiveReload(
  reload: () => boolean | void,
  pace: Pace,
  { hears = () => true, feed = liveFeed }: { hears?: (frame: LiveFrame) => boolean; feed?: Feed } = {},
): void {
  // Kept in refs so a caller does not have to memoise its callbacks to avoid
  // restarting the timer (or reconnecting) on every render.
  const { everyMs, connectedMs } = pace;
  const latest = useRef(reload);
  latest.current = reload;
  const filter = useRef(hears);
  filter.current = hears;

  useEffect(
    () =>
      bindLiveReload({
        feed,
        pace: { everyMs, connectedMs },
        reload: () => latest.current(),
        hears: (frame) => filter.current(frame),
        page: {
          hidden: () => document.hidden,
          onReturn: (fn) => {
            document.addEventListener('visibilitychange', fn);
            addEventListener('focus', fn);
            return () => {
              document.removeEventListener('visibilitychange', fn);
              removeEventListener('focus', fn);
            };
          },
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t),
      }),
    [everyMs, connectedMs, feed],
  );
}
