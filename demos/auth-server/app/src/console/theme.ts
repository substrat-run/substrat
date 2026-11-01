import { useCallback, useEffect, useState } from 'react';

export type ConsoleTheme = 'light' | 'dark';

const KEY = 'substrat.auth.theme';

/**
 * The console's theme. `?theme=dark|light` wins on load (demos and screenshots, as on the
 * dashboard), then the operator's last choice, then the system's. Kept on the console root
 * rather than <html>: the hand-off screens in the same document belong to the relying party.
 */
function initialTheme(): ConsoleTheme {
  const forced = new URLSearchParams(window.location.search).get('theme');
  if (forced === 'dark' || forced === 'light') return forced;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Storage refused (a private window, blocked site data): the system's answer is fine.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useConsoleTheme(): [ConsoleTheme, () => void] {
  const [theme, setTheme] = useState<ConsoleTheme>(initialTheme);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not remembered across reloads, which is all storage was for.
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}
