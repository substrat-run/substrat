/**
 * The client half of a request, read the same way on every host.
 *
 * The user agents below are real ones, copied rather than composed, because a
 * parser tested only against strings its author wrote passes by construction.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_GEO,
  clientContext,
  clientContextOf,
  parseUserAgent,
  preferredLanguage,
} from '../src/client-context.js';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
  chromeAndroidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  ie11: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.6.0',
  unnamedBot: 'Mozilla/5.0 (compatible; SomethingCrawler/1.0)',
};

describe('parseUserAgent', () => {
  it('reads the four things a support agent asks — browser, OS, phone or not, human or not', () => {
    expect(parseUserAgent(UA.chromeMac)).toEqual({
      browser: 'Chrome',
      browserVersion: '126.0.6478.127',
      os: 'macOS',
      osVersion: '10.15.7',
      kind: 'desktop',
    });
    expect(parseUserAgent(UA.safariIphone)).toEqual({
      browser: 'Safari',
      browserVersion: '17.5',
      os: 'iOS',
      osVersion: '17.5.1',
      kind: 'mobile',
    });
  });

  it('tells an Android phone from an Android tablet by the Mobile token', () => {
    expect(parseUserAgent(UA.chromeAndroidPhone)).toMatchObject({ os: 'Android', osVersion: '14', kind: 'mobile' });
    expect(parseUserAgent(UA.chromeAndroidTablet)).toMatchObject({ os: 'Android', osVersion: '13', kind: 'tablet' });
    expect(parseUserAgent(UA.safariIpad)).toMatchObject({ os: 'iOS', kind: 'tablet' });
  });

  /** Every Chromium fork says `Chrome/` and every WebKit browser says `Safari/`. */
  it('names the fork, not the engine it is built on', () => {
    expect(parseUserAgent(UA.edgeWindows)).toMatchObject({ browser: 'Edge', browserVersion: '126.0.2592.87', os: 'Windows', osVersion: '10' });
    expect(parseUserAgent(UA.samsung)).toMatchObject({ browser: 'Samsung Internet', browserVersion: '23.0' });
    expect(parseUserAgent(UA.firefoxLinux)).toMatchObject({ browser: 'Firefox', browserVersion: '127.0', os: 'Linux', kind: 'desktop' });
    expect(parseUserAgent(UA.ie11)).toMatchObject({ browser: 'Internet Explorer', browserVersion: '11.0', os: 'Windows', osVersion: '7' });
  });

  it('marks crawlers and tools as bots, named when it knows them', () => {
    expect(parseUserAgent(UA.googlebot)).toMatchObject({ browser: 'Googlebot', kind: 'bot' });
    expect(parseUserAgent(UA.curl)).toMatchObject({ browser: 'curl', kind: 'bot' });
    expect(parseUserAgent(UA.unnamedBot)).toMatchObject({ browser: null, kind: 'bot' });
  });

  it('answers unknown for nothing, never throws', () => {
    for (const ua of [null, undefined, '', '   ', 'not a user agent'])
      expect(parseUserAgent(ua)).toEqual({ browser: null, browserVersion: null, os: null, osVersion: null, kind: 'unknown' });
  });
});

describe('preferredLanguage', () => {
  it('is the head of the weighted list', () => {
    expect(preferredLanguage('sv-SE,sv;q=0.9,en;q=0.8')).toBe('sv-SE');
    expect(preferredLanguage('en')).toBe('en');
  });
  it('is null for nothing or garbage', () => {
    expect(preferredLanguage(null)).toBeNull();
    expect(preferredLanguage('')).toBeNull();
    expect(preferredLanguage('*')).toBeNull();
  });
});

describe('clientContextOf', () => {
  const headers = new Headers({ 'user-agent': UA.safariIphone, 'accept-language': 'sv-SE,sv;q=0.9' });

  it('is the header half with an empty geo when the host knows none', () => {
    const ctx = clientContextOf(headers);
    expect(ctx.userAgent).toBe(UA.safariIphone);
    expect(ctx.language).toBe('sv-SE');
    expect(ctx.device.browser).toBe('Safari');
    expect(ctx.geo).toEqual(EMPTY_GEO);
    expect(clientContext.parse(ctx)).toEqual(ctx);
  });

  it('fills a partial geo out to every column, so a row never has a missing field', () => {
    const ctx = clientContextOf(headers, { country: 'SE', city: 'Stockholm' });
    expect(ctx.geo).toEqual({ ...EMPTY_GEO, country: 'SE', city: 'Stockholm' });
    expect(clientContext.parse(ctx)).toEqual(ctx);
  });

  it('treats a geo field that is present but undefined as absent', () => {
    // `Partial<ClientGeo>` admits `{ city: undefined }`, and the schema does not: a
    // spread would have carried the undefined through and failed the parse.
    const ctx = clientContextOf(headers, { country: 'SE', city: undefined, region: undefined });
    expect(ctx.geo).toEqual({ ...EMPTY_GEO, country: 'SE' });
    expect(clientContext.parse(ctx)).toEqual(ctx);
  });

  it('is all-null for a request with no headers', () => {
    const ctx = clientContextOf(new Headers());
    expect(ctx).toEqual({
      userAgent: null,
      language: null,
      device: { browser: null, browserVersion: null, os: null, osVersion: null, kind: 'unknown' },
      geo: EMPTY_GEO,
    });
  });
});
