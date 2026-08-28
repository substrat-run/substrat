/**
 * The scheduling half of `useAutoRefresh`, as a plain function of its environment.
 *
 * Kept apart from the hook so the contract is testable without a DOM: hand it a fake
 * `window`/`document`/clock and assert exactly when `refresh` fires. The hook is the
 * thin React wrapper that runs this for the life of a mounted view.
 *
 * Deliberate behavior (the same shape react-query/SWR ship as defaults —
 * refetchOnWindowFocus + refetchInterval — inlined because no app here carries a
 * query library):
 * - Nothing fires while the tab is hidden — a wall of backgrounded consoles must not
 *   poll all day. The catch-up read happens on return instead.
 * - `focus` and `visibilitychange` both fire on tab return; a minimum gap collapses
 *   the pair (and rapid alt-tabbing) into one refresh.
 * - No refresh on start — the caller's initial load already ran.
 * - Rejections are swallowed: a background refresh must never surface a toast the
 *   user didn't ask for. Whatever `refresh` did with its own state stands.
 */

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface AutoRefreshEnv {
  window: Listenable;
  document: Listenable & { readonly visibilityState: 'visible' | 'hidden' };
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AutoRefreshController {
  /** Tear the listeners and the poll down. */
  stop(): void;
}

/** Two refreshes closer together than this collapse into one. */
export const MIN_GAP_MS = 5_000;

export function startAutoRefresh(
  refresh: () => unknown,
  options: { intervalMs: number; minGapMs?: number; env: AutoRefreshEnv },
): AutoRefreshController {
  const { intervalMs, minGapMs = MIN_GAP_MS, env } = options;
  let last = env.now();
  const maybeRefresh = () => {
    if (env.document.visibilityState !== 'visible') return;
    if (env.now() - last < minGapMs) return;
    last = env.now();
    try {
      void Promise.resolve(refresh()).catch(() => {});
    } catch {
      // A synchronous throw is the same case as a rejection: the caller's own.
    }
  };
  env.window.addEventListener('focus', maybeRefresh);
  env.document.addEventListener('visibilitychange', maybeRefresh);
  const timer = env.setInterval(maybeRefresh, intervalMs);
  return {
    stop() {
      env.window.removeEventListener('focus', maybeRefresh);
      env.document.removeEventListener('visibilitychange', maybeRefresh);
      env.clearInterval(timer);
    },
  };
}

/** The real thing. A function, not a constant, so importing this file needs no DOM. */
export function browserEnv(): AutoRefreshEnv {
  return {
    window,
    document,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as number),
  };
}
