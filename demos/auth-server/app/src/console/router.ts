import { useSyncExternalStore } from 'react';

/**
 * The whole router. Real paths, not a hash — `src/routes.ts` already serves the SPA for
 * everything that is not `/api/*`, `/internal/*` or `/.well-known/*`, so a console URL
 * survives a reload and can be pasted into a support conversation.
 *
 * `pushState` fires no event of its own, so a same-document navigation has to announce
 * itself; `popstate` covers the back button. Both are folded into one subscription and
 * read through `useSyncExternalStore`, which is React's own answer for state that lives
 * outside React — no dependency, no context, and no second copy of the path to keep in
 * step with the address bar.
 */
const NAVIGATED = 'substrat:navigated';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
}

/** The current path, re-rendering whatever reads it whenever the history entry changes. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/**
 * Go to a client route. `replace` is for a correction the back button should not have to
 * step through — landing on `/` and being sent to the first section is a correction, not a
 * place the person was.
 */
export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (window.location.pathname === path) return;
  if (opts.replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(NAVIGATED));
}
