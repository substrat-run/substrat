/**
 * How the app looks for this viewer: a theme and a light/dark/system mode, applied as
 * classes on <html> and kept in this browser.
 *
 * Browser storage on purpose — this is a per-viewer convenience, and a demo has no
 * settings store to put it in. A deployed vertical would keep the choice per person
 * (and a tenant default) server-side, so it follows them between devices.
 */
import { useSyncExternalStore } from 'react';

export const THEMES = [
  // `preview`: Web Awesome sets its blue/gray scales on :root only, so a card previewing
  // it inside another theme names them; the Substrat themes declare their own.
  { id: 'default', label: 'Web Awesome', className: 'wa-theme-default', preview: 'wa-brand-blue wa-neutral-gray', blurb: 'The library’s own look.' },
  { id: 'ledger', label: 'Ledger', className: 'sub-theme-ledger', preview: '', blurb: 'Dense and flat, for all-day work.' },
  { id: 'atelier', label: 'Atelier', className: 'sub-theme-atelier', preview: '', blurb: 'Warm, roomy, serif headings.' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];
export type Mode = 'light' | 'dark' | 'system';

export interface Appearance {
  theme: ThemeId;
  mode: Mode;
}

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const prefersDark = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;

let current: Appearance = {
  theme: THEMES.find((t) => t.id === stored('todo.theme'))?.id ?? 'ledger',
  mode: (['light', 'dark', 'system'] as const).find((m) => m === stored('todo.mode')) ?? 'system',
};
const listeners = new Set<() => void>();

/** Whether a mode shows dark right now — `system` asks the operating system. */
export const isDark = (mode: Mode) => mode === 'dark' || (mode === 'system' && Boolean(prefersDark?.matches));

function apply() {
  const root = document.documentElement.classList;
  for (const t of THEMES) root.toggle(t.className, t.id === current.theme);
  const dark = isDark(current.mode);
  root.toggle('wa-dark', dark);
  root.toggle('wa-light', !dark);
}

export function setAppearance(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem('todo.theme', current.theme);
    localStorage.setItem('todo.mode', current.mode);
  } catch {
    // A private window: the choice lasts for this page only.
  }
  apply();
  for (const listener of listeners) listener();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

if (typeof document !== 'undefined') {
  apply();
  // `system` follows the OS while the page is open, not only at load.
  prefersDark?.addEventListener('change', () => {
    if (current.mode === 'system') setAppearance({});
  });
}
