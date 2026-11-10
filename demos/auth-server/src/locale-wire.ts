/**
 * Which language a hosted screen or an email is in. Free of dependencies because the browser
 * imports this file as well as the server.
 */

export const LOCALES = ['sv', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** The declared key holding the issuer's default language. */
export const ISSUER_LOCALE = 'ISSUER_LOCALE';

/** The cookie holding the language, read by the screens, the error hook and the mail. */
export const LOCALE_COOKIE = 'auth_locale';

/** A supported locale from a language tag (`sv-SE`, `SV`), or null. */
export function supportedLocale(tag: string | null | undefined): Locale | null {
  const language = tag?.trim().split(/[-_]/)[0]?.toLowerCase();
  return LOCALES.find((l) => l === language) ?? null;
}

/** The issuer's default language. Anything but a supported one is English. */
export function issuerLocale(value: string | undefined): Locale {
  return supportedLocale(value) ?? 'en';
}

/**
 * The language to use: what the application asked for (OIDC `ui_locales`, an ordered,
 * space-separated list), then what was chosen or settled on in this browser, then the browser's
 * own languages in order, then the issuer's default.
 */
export function resolveLocale(input: {
  uiLocales?: string | null;
  cookie?: string | null;
  browser?: readonly string[];
  issuerDefault: Locale;
}): Locale {
  for (const tag of input.uiLocales?.split(/\s+/) ?? []) {
    const locale = supportedLocale(tag);
    if (locale) return locale;
  }
  const chosen = supportedLocale(input.cookie);
  if (chosen) return chosen;
  for (const tag of input.browser ?? []) {
    const locale = supportedLocale(tag);
    if (locale) return locale;
  }
  return input.issuerDefault;
}

/** The value of one cookie in a `Cookie` header or `document.cookie`. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const [key, value] = part.trim().split('=');
    if (key === name) return value ?? null;
  }
  return null;
}

/** The language of a request, for what the server writes in reply to it. No request: the default. */
export function requestLocale(headers: Headers | null | undefined, issuerDefault: Locale): Locale {
  return resolveLocale({
    cookie: cookieValue(headers?.get('cookie'), LOCALE_COOKIE),
    browser: (headers?.get('accept-language') ?? '').split(',').map((part) => part.split(';')[0]!),
    issuerDefault,
  });
}
