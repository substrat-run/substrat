import { useCallback, useEffect, useRef } from 'react';
import { browserEnv, startAutoRefresh } from './auto-refresh';

/**
 * Stale-while-revalidate for a hand-rolled load(): refetch when the tab comes back
 * into view, a slow poll while it stays visible, and an explicit `revalidate()` for
 * the click that asks for one. The scheduling itself lives in `./auto-refresh.ts`.
 *
 * ## The revalidate-and-deny contract (#801)
 *
 * A permission-centric app has a failure mode of its own: **the screen outlives the
 * grant.** Nothing leaks — the server refuses every subsequent action — but the person
 * keeps looking at data they no longer have access to, for as long as nothing refetches.
 * This hook is the "re-ask" half of that; the caller's `load()` is the other half:
 *
 * - `load()` must route a 403 into its deny state and **replace** the content it just
 *   refused — clear the page, not only set an error beside it — so the wall takes the
 *   place of the data rather than sitting above it. The same goes for every other read
 *   the screen makes (the next page of a walk, the detail of one row): a denial there
 *   is the same revoke, seen from a different request. This hook only ignores
 *   rejections; it does not know what a denial looks like, and whatever `load()` did
 *   with its own state stands.
 * - **Refetch on re-select.** A click on the nav item that is already selected is the
 *   click someone makes when they suspect the screen is stale, and it changes no route,
 *   so nothing else would refetch. Wire it to `revalidate()` (or bump a reload key)
 *   instead of letting it be a no-op same-route link.
 *
 * `demos/todo/app` (`ListView`) and `demos/shop/app` (the nav tabs) are the reference.
 */
export interface AutoRefreshOptions {
  /** Poll period while the tab is visible. Default 30s. */
  intervalMs?: number;
  /** Gate (e.g. an auth flag) — false tears the listeners down. Default true. */
  enabled?: boolean;
}

export interface AutoRefreshHandle {
  /**
   * Force a refresh now, gap or no gap — the re-click of the current selection.
   * Settles when `load()` does; a rejection is swallowed here as everywhere else.
   */
  revalidate: () => Promise<void>;
}

export function useAutoRefresh(refresh: () => unknown, options: AutoRefreshOptions = {}): AutoRefreshHandle {
  const { intervalMs = 30_000, enabled = true } = options;

  // Latest closure without re-subscribing the listeners on every render.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    const controller = startAutoRefresh(() => refreshRef.current(), { intervalMs, env: browserEnv() });
    return controller.stop;
  }, [enabled, intervalMs]);

  const revalidate = useCallback(async () => {
    try {
      await refreshRef.current();
    } catch {
      // The caller's load() owns its errors; see the contract above.
    }
  }, []);

  return { revalidate };
}
