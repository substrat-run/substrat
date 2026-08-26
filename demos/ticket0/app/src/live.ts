/**
 * Keep a screen current without making it expensive.
 *
 * The inbox used to load once and never again — so a conversation that arrived while
 * you had it open simply was not there, and the only way to find out was to reload.
 * For a queue somebody is watching, that is the whole point of the screen.
 *
 * Paced the same way the widget is: a slow tick while the tab is visible, nothing at
 * all while it is hidden, and an immediate refetch the moment it comes back — which is
 * the gesture that actually matters, because you switch to the tab to see what changed.
 *
 * Polling because that is what the platform can do today; a live read would be a
 * subscription to the scope's event stream, which is a kernel change (see the notes in
 * `widget.js`). This is the honest stopgap, not a design.
 */
import { useEffect, useRef } from 'react';

export function useLiveReload(reload: () => void, everyMs = 10_000): void {
  // Kept in a ref so a caller does not have to memoise the callback to avoid
  // restarting the timer on every render.
  const latest = useRef(reload);
  latest.current = reload;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      if (!document.hidden) timer = setInterval(() => latest.current(), everyMs);
    };
    const onVisible = () => {
      if (!document.hidden) latest.current();
      start();
    };

    start();
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('focus', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('focus', onVisible);
    };
  }, [everyMs]);
}
