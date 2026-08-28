import { z } from 'zod';

/**
 * Who is on the other end of a request — the CLIENT, not the principal.
 *
 * A principal says who is authorised; this says what they are holding and roughly
 * where they are holding it: the browser and OS a support agent needs to reproduce
 * a bug, the country and timezone that tell them it is 3 am for the person typing,
 * the language the reply should probably be in. None of it is authority, and none of
 * it is trusted for anything but display and triage.
 *
 * It is a NORMALISED shape, and that is the point of it. Every runtime hands these
 * facts over differently — Cloudflare puts geo on `request.cf`, another edge puts it
 * in headers, a node dev server has no geo at all — and a vertical that read the raw
 * source would be a vertical that only runs on one host. So a host builds one of
 * these (`@substrat-run/adapter-cloudflare` exports `cloudflareClientContext`), passes
 * it in as operation input, and module code sees only this. The one part that is the
 * same everywhere — the `User-Agent` and `Accept-Language` headers — is parsed here,
 * so every host reads "Safari 17 on iOS" the same way.
 *
 * What is deliberately absent: the IP address. It is the most identifying field a
 * request carries and the least useful to a person reading a conversation; the
 * country and city it resolves to carry the useful part without the fingerprint.
 * Every field is nullable, because every field is something a request may not say.
 */

/** ISO 3166-1 alpha-2, upper case. */
const countryCode = z.string().regex(/^[A-Z]{2}$/);

/**
 * Where the request came from, as far as the edge could tell.
 *
 * `region` is the human name (`Stockholm County`), not a code — codes differ per
 * country and a person reads the name. `timezone` is an IANA name, which is what a
 * UI hands to `Intl.DateTimeFormat` to show the visitor's local time.
 */
export const clientGeo = z.object({
  country: countryCode.nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  timezone: z.string().nullable(),
  /** Two-letter continent code as Cloudflare reports it (`EU`, `NA`, …). */
  continent: z.string().regex(/^[A-Z]{2}$/).nullable(),
});
export type ClientGeo = z.infer<typeof clientGeo>;

export const EMPTY_GEO: ClientGeo = Object.freeze({
  country: null,
  region: null,
  city: null,
  timezone: null,
  continent: null,
});

/**
 * What kind of thing sent the request. Coarse on purpose: the question a person
 * asks is "were they on a phone?", and a finer answer than this would be a guess
 * dressed as a fact — user agents lie, and iPadOS reports itself as a Mac.
 */
export const clientDeviceKind = z.enum(['desktop', 'mobile', 'tablet', 'bot', 'unknown']);
export type ClientDeviceKind = z.infer<typeof clientDeviceKind>;

/** The browser and operating system, parsed out of the `User-Agent` into names a person reads. */
export const clientDevice = z.object({
  /** `Chrome`, `Safari`, `Firefox`, `Edge`, `Samsung Internet`, `Opera`, `Internet Explorer`, or a bot's name. */
  browser: z.string().nullable(),
  /** As reported, e.g. `126.0.6478.127`; show the major. */
  browserVersion: z.string().nullable(),
  /** `iOS`, `Android`, `macOS`, `Windows`, `Linux`, `ChromeOS`. */
  os: z.string().nullable(),
  osVersion: z.string().nullable(),
  kind: clientDeviceKind,
});
export type ClientDevice = z.infer<typeof clientDevice>;

export const clientContext = z.object({
  /** The raw header, kept so a better parser can re-read it later. */
  userAgent: z.string().nullable(),
  /** The first tag of `Accept-Language` (BCP 47, e.g. `sv-SE`) — what the person asked to be spoken to in. */
  language: z.string().nullable(),
  device: clientDevice,
  geo: clientGeo,
});
export type ClientContext = z.infer<typeof clientContext>;

// ---------------------------------------------------------------------------
// User-Agent parsing
// ---------------------------------------------------------------------------

const UNKNOWN_DEVICE: ClientDevice = Object.freeze({
  browser: null,
  browserVersion: null,
  os: null,
  osVersion: null,
  kind: 'unknown',
});

/**
 * The bots worth naming. Anything else matching the generic tail is still a bot,
 * just an unnamed one.
 */
const BOT_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Googlebot/i, 'Googlebot'],
  [/bingbot/i, 'Bingbot'],
  [/DuckDuckBot/i, 'DuckDuckBot'],
  [/Slackbot/i, 'Slackbot'],
  [/Twitterbot/i, 'Twitterbot'],
  [/facebookexternalhit/i, 'Facebook'],
  [/LinkedInBot/i, 'LinkedInBot'],
  [/Applebot/i, 'Applebot'],
  [/GPTBot/i, 'GPTBot'],
  [/ClaudeBot/i, 'ClaudeBot'],
  [/HeadlessChrome/i, 'Headless Chrome'],
  [/Lighthouse/i, 'Lighthouse'],
  [/curl\//i, 'curl'],
  [/Wget\//i, 'wget'],
  [/python-requests|python-urllib|aiohttp/i, 'Python'],
  [/Go-http-client/i, 'Go'],
  [/node-fetch|undici/i, 'Node'],
];
const BOT_GENERIC = /bot|crawl|spider|slurp|scrape|fetch|monitor|preview|headless/i;

/**
 * Browsers in the order they must be tried. Every Chromium fork carries `Chrome/`
 * and every WebKit browser carries `Safari/`, so the specific names go first and
 * the two generic ones last.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
  [/\bOPR\/([\d.]+)/, 'Opera'],
  [/\bOpera[/ ]([\d.]+)/, 'Opera'],
  [/\bSamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
  [/\bFirefox\/([\d.]+)/, 'Firefox'],
  [/\bFxiOS\/([\d.]+)/, 'Firefox'],
  [/\bCriOS\/([\d.]+)/, 'Chrome'],
  [/\bChrome\/([\d.]+)/, 'Chrome'],
  // Safari's own version is in `Version/`; the `Safari/` token is the WebKit build.
  [/\bVersion\/([\d.]+).*\bSafari\//, 'Safari'],
  [/\bMSIE ([\d.]+)/, 'Internet Explorer'],
  [/\bTrident\/.*\brv:([\d.]+)/, 'Internet Explorer'],
];

/** `Windows NT 10.0` is Windows 10 (or 11 — the UA cannot tell them apart). */
const WINDOWS_NT: Readonly<Record<string, string>> = {
  '10.0': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
  '6.0': 'Vista',
  '5.1': 'XP',
};

function os(ua: string): { os: string | null; osVersion: string | null } {
  let m: RegExpMatchArray | null;
  if ((m = /\b(?:iPhone|iPad|iPod)\b.*?\bOS (\d+(?:_\d+)*)/.exec(ua)))
    return { os: 'iOS', osVersion: m[1]!.replace(/_/g, '.') };
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return { os: 'iOS', osVersion: null };
  if ((m = /\bAndroid (\d+(?:\.\d+)*)/.exec(ua))) return { os: 'Android', osVersion: m[1]! };
  if (/\bAndroid\b/.test(ua)) return { os: 'Android', osVersion: null };
  if ((m = /\bWindows NT (\d+\.\d+)/.exec(ua)))
    return { os: 'Windows', osVersion: WINDOWS_NT[m[1]!] ?? m[1]! };
  if (/\bWindows\b/.test(ua)) return { os: 'Windows', osVersion: null };
  if ((m = /\bMac OS X (\d+(?:[_.]\d+)*)/.exec(ua)))
    return { os: 'macOS', osVersion: m[1]!.replace(/_/g, '.') };
  if (/\bMacintosh\b/.test(ua)) return { os: 'macOS', osVersion: null };
  if (/\bCrOS\b/.test(ua)) return { os: 'ChromeOS', osVersion: null };
  if (/\bLinux\b|\bX11\b/.test(ua)) return { os: 'Linux', osVersion: null };
  return { os: null, osVersion: null };
}

function kindOf(ua: string, osName: string | null): ClientDeviceKind {
  if (/\biPad\b|\bTablet\b/i.test(ua)) return 'tablet';
  // Android reports `Mobile` on phones and omits it on tablets.
  if (osName === 'Android') return /\bMobile\b/.test(ua) ? 'mobile' : 'tablet';
  if (/\biPhone\b|\biPod\b|\bMobi/i.test(ua)) return 'mobile';
  if (osName === 'Windows' || osName === 'macOS' || osName === 'Linux' || osName === 'ChromeOS')
    return 'desktop';
  return 'unknown';
}

/**
 * Turn a `User-Agent` into names a person reads.
 *
 * Hand-rolled and small on purpose. A full UA database is a dependency that
 * changes weekly and answers questions nobody here asks (which Nokia model?); this
 * answers the four a support agent does — which browser, which OS, phone or not,
 * human or not — and stores the raw string beside them so a wrong answer can be
 * re-read later. Absent or unrecognised input is `unknown`, never a throw: a request
 * with a strange UA is still a request.
 */
export function parseUserAgent(userAgent: string | null | undefined): ClientDevice {
  const ua = userAgent?.trim() ?? '';
  if (!ua) return UNKNOWN_DEVICE;

  for (const [re, name] of BOT_NAMES)
    if (re.test(ua)) return { ...UNKNOWN_DEVICE, browser: name, kind: 'bot' };

  const platform = os(ua);
  let browser: string | null = null;
  let browserVersion: string | null = null;
  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      browser = name;
      browserVersion = m[1] ?? null;
      break;
    }
  }
  // An unnamed crawler that still says "bot" somewhere: a browser never does, so the
  // browser and OS it may spoof are kept (they are what it claims) and the kind is not.
  const kind = BOT_GENERIC.test(ua) ? 'bot' : kindOf(ua, platform.os);
  return { browser, browserVersion, os: platform.os, osVersion: platform.osVersion, kind };
}

// ---------------------------------------------------------------------------
// From a request
// ---------------------------------------------------------------------------

/** The subset of the web-standard `Headers` this needs — so a test hands in a plain object. */
export interface HeadersLike {
  get(name: string): string | null;
}

/**
 * The first language tag of `Accept-Language`, or null. The header is a weighted
 * list (`sv-SE,sv;q=0.9,en;q=0.8`) and browsers put the preferred one first, so the
 * head is the answer; weights are not re-sorted, because no browser sends them out
 * of order and a hand-written header that does is not worth a parser.
 */
export function preferredLanguage(acceptLanguage: string | null | undefined): string | null {
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim() ?? '';
  return /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(first) ? first : null;
}

/**
 * Build a `ClientContext` from a request's headers and whatever geo the host knows.
 *
 * This is the runtime-neutral half: the headers are the same on every host, and the
 * geo is what differs — so a host with none (the node dev server) passes nothing and
 * gets `EMPTY_GEO`, and one with some (`cloudflareClientContext`) passes what it
 * normalised. A partial geo is filled out to the full shape so a row always has
 * every column.
 */
export function clientContextOf(headers: HeadersLike, geo?: Partial<ClientGeo>): ClientContext {
  const userAgent = headers.get('user-agent')?.trim() || null;
  return {
    userAgent,
    language: preferredLanguage(headers.get('accept-language')),
    device: parseUserAgent(userAgent),
    geo: { ...EMPTY_GEO, ...(geo ?? {}) },
  };
}
