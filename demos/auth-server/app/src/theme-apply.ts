import { schemeOf, type ClientTheme } from '../../src/theme-wire.js';

/**
 * The wire vocabulary (`src/theme-wire.ts`) mapped onto the custom properties `tokens.css`
 * declares. Values arrive sanitized (hex colors, a px radius), so setting them is safe;
 * `setProperty` takes them as one CSS value, never as parseable stylesheet text.
 */
const THEME_VARS: [Exclude<keyof ClientTheme, 'text' | 'languages'>, string][] = [
  ['colorPrimary', '--accent'],
  ['colorPrimaryForeground', '--accent-contrast'],
  ['colorBackground', '--bg'],
  ['colorPanel', '--panel'],
  ['colorInput', '--panel-2'],
  ['colorText', '--text'],
  ['colorMutedText', '--muted'],
  ['colorBorder', '--line'],
  ['colorDanger', '--danger'],
  ['borderRadius', '--radius'],
];

/**
 * Apply (or, with `{}`, fully remove) a client theme. Removal matters: `refresh()` runs
 * again after sign-in, and the dashboard must come back in the issuer's own colors rather
 * than whichever relying party's flow ran last.
 */
export function applyClientTheme(theme: ClientTheme): void {
  const root = document.documentElement.style;
  for (const [key, cssVar] of THEME_VARS) {
    const value = theme[key];
    if (value) root.setProperty(cssVar, value);
    else root.removeProperty(cssVar);
  }
  // The card's larger radius follows the input radius instead of being its own key.
  if (theme.borderRadius) root.setProperty('--radius-lg', `${parseInt(theme.borderRadius, 10) + 6}px`);
  else root.removeProperty('--radius-lg');
}

const RAW_CSS_ID = 'auth-theme-css';

/**
 * Put a theme's palette and raw CSS on the page, or with `null` take them off. The CSS goes in
 * as `textContent`, so it cannot close its element, and last in <head>, so it wins a tie with
 * `tokens.css`.
 */
export function paintHandOff(theme: ClientTheme | null): void {
  const root = document.documentElement;
  if (theme && schemeOf(theme) === 'dark') root.setAttribute('data-auth-scheme', 'dark');
  else root.removeAttribute('data-auth-scheme');

  const existing = document.getElementById(RAW_CSS_ID);
  if (!theme?.css) return existing?.remove();
  const style = existing ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: RAW_CSS_ID }));
  style.textContent = theme.css;
}
