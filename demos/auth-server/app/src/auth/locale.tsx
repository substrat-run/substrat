import { createContext, useContext } from 'react';
import { LOCALE_COOKIE, LOCALES, cookieValue, resolveLocale, type Locale } from '../../../src/locale-wire.js';
import { translate, type MessageKey, type TextOverrides } from '../../../src/messages.js';
import { themeTitle, type ClientTheme } from '../../../src/theme-wire.js';

/** A browser's language for these screens, before the issuer's default is known. */
export function detectLocale(issuerDefault: Locale): Locale {
  return resolveLocale({
    uiLocales: new URLSearchParams(window.location.search).get('ui_locales'),
    cookie: cookieValue(document.cookie, LOCALE_COOKIE),
    browser: navigator.languages,
    issuerDefault,
  });
}

/**
 * Tell the server which language is on screen, so a refusal and a reset mail match it. A choice
 * from the switcher is kept for a year; one that was only detected lasts this browser session.
 */
export function storeLocale(locale: Locale, chosen: boolean): void {
  const lifetime = chosen ? '; max-age=31536000' : '';
  if (!chosen && cookieValue(document.cookie, LOCALE_COOKIE) === locale) return;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; SameSite=Lax${lifetime}`;
}

export const LocaleContext = createContext<{ locale: Locale; choose: (locale: Locale) => void; overrides?: TextOverrides }>({
  locale: 'en',
  choose: () => {},
});

export function useT() {
  const { locale, overrides } = useContext(LocaleContext);
  return (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars, overrides);
}

export function useTitle(theme: ClientTheme): string {
  return themeTitle(theme, useContext(LocaleContext).locale);
}

const NAMES: Record<Locale, string> = { sv: 'Svenska', en: 'English' };

/** At the foot of every card, each language named in itself. */
export function LanguageSwitch() {
  const { locale, choose } = useContext(LocaleContext);
  return (
    <div className="lang-switch">
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={l === locale} onClick={() => choose(l)}>
          {NAMES[l]}
        </button>
      ))}
    </div>
  );
}
