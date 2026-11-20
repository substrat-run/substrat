import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query from React state.
 *
 * The apps style with inline styles and tokens, not stylesheets, so a `@media` block is
 * not available where a layout decision has to change the *structure* — a sidebar that
 * becomes an overlay rather than a column cannot be expressed by CSS alone here. Reads
 * synchronously on mount so the first paint is already correct, and stays subscribed so a
 * window resize (or a phone rotating) re-renders.
 */
export function useMediaQuery(query: string | null): boolean {
  // `null` is "no question asked" — a layout that has no breakpoint answers false without
  // touching `matchMedia`. So does an environment without one (jsdom, some embedders): it
  // gets the wide layout, which is the one every suite was written against.
  const asked = query !== null && typeof window.matchMedia === 'function';
  const [matches, setMatches] = useState(() => (asked ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (query === null || typeof window.matchMedia !== 'function') {
      setMatches(false);
      return;
    }
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
