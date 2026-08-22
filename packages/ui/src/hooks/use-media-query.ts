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
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
