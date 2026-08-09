import { useEffect, useRef } from 'react';

/**
 * Stale-while-revalidate for a hand-rolled load(): refetch when the tab comes
 * back into view, plus a slow poll while it stays visible. The same shape
 * react-query/SWR ship as defaults (refetchOnWindowFocus + refetchInterval),
 * inlined here because neither app carries a query library.
 *
 * Deliberate behavior:
 * - Nothing fires while the tab is hidden — a wall of backgrounded consoles
 *   must not poll the control plane all day. The catch-up read happens on
 *   return instead.
 * - `focus` and `visibilitychange` both fire on tab return; a minimum gap
 *   collapses the pair (and rapid alt-tabbing) into one refresh.
 * - No refresh on mount — the caller's initial load already ran.
 * - Errors are swallowed: a background refresh must never surface a toast the
 *   user didn't ask for. The caller's load() keeps its own error handling.
 */
export interface AutoRefreshOptions {
  /** Poll period while the tab is visible. Default 30s. */
  intervalMs?: number;
  /** Gate (e.g. an auth flag) — false tears the listeners down. Default true. */
  enabled?: boolean;
}

/** Two refreshes closer together than this collapse into one. */
const MIN_GAP_MS = 5_000;

export function useAutoRefresh(refresh: () => unknown, options: AutoRefreshOptions = {}): void {
  const { intervalMs = 30_000, enabled = true } = options;

  // Latest closure without re-subscribing the listeners on every render.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      void Promise.resolve(refreshRef.current()).catch(() => {});
    };
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);
    const timer = setInterval(maybeRefresh, intervalMs);
    return () => {
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', maybeRefresh);
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);
}
