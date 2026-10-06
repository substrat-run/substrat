/**
 * The two triggers into a screen's read, as one binding (#938): a push and a poll, paced
 * by whether the feed is open and stopped in a hidden tab.
 *
 * DOM-free, like `feed.ts` and `refresh.ts`, so the node suite drives the whole path a
 * push takes to a re-read with a fake feed, a fake page and fake timers. `useLiveReload`
 * in `live.ts` binds it to the browser and to React.
 */
import type { Feed, FeedListener, LiveFrame } from './feed.js';
import { pollPace, type Pace } from './pace.js';
import { createRefresh } from './refresh.js';

type Timer = ReturnType<typeof setTimeout>;

/** What the binding needs of the page: whether it is hidden, and when it comes back. */
export interface PageLike {
  hidden(): boolean;
  /** Call `fn` when the page is shown or focused again. Returns the unsubscribe. */
  onReturn(fn: () => void): () => void;
}

export interface LiveReloadDeps {
  feed: Pick<Feed, 'listen' | 'isOpen' | 'wake'>;
  pace: Pace;
  /** The screen's read. `false` means it declined and read nothing (`refresh.ts`). */
  reload(): boolean | void;
  /** Which frames count. Every frame is a re-read, so a screen about one thing filters. */
  hears(frame: LiveFrame): boolean;
  page: PageLike;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}

/** Start both triggers. Returns what stops them. */
export function bindLiveReload(deps: LiveReloadDeps): () => void {
  const { feed, page } = deps;
  let timer: Timer | null = null;

  const stop = () => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    const every = pollPace(deps.pace, feed.isOpen());
    if (!page.hidden()) timer = deps.setInterval(() => deps.reload(), every);
  };
  // A refresh that is done only once a read has run; the poll then counts from it.
  const refresh = createRefresh({
    reload: () => deps.reload(),
    afterRead: () => start(),
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
  });

  const listener: FeedListener = {
    frame: (frame) => {
      // A frame while hidden is dropped: coming back re-reads anyway.
      if (!page.hidden() && deps.hears(frame)) refresh.request();
    },
    state: (open) => {
      // Opening re-reads once: anything that changed between this screen's last read
      // and the subscription starting was announced to nobody. Either way the poll's
      // pace follows the feed.
      if (open && !page.hidden()) refresh.request();
      start();
    },
  };
  const unlisten = feed.listen(listener);
  // Joining a feed that is already open fires no `state`: this screen's own first load
  // is what covers the gap, and `start` asks the feed for the connected pace.
  start();
  const unreturn = page.onReturn(() => {
    // Coming back is the gesture that matters: you switch to the tab to see what changed.
    if (!page.hidden()) {
      refresh.request();
      feed.wake();
    }
    start();
  });
  return () => {
    stop();
    refresh.cancel();
    unlisten();
    unreturn();
  };
}
