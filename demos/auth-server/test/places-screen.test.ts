import { describe, expect, it } from 'vitest';
import { isPlacesAnswer, placeHref, placesOf } from '../app/src/places.js';

/**
 * The account page's reading of a login's places (#1670, `app/src/places.ts`).
 *
 * The one thing on that screen worth pinning is the link. It is drawn on the page a person
 * trusts to be the issuer's own, from a hostname the platform registered, so only a bare
 * hostname may become an `href` — the issuer already validates it on the way out, and this is
 * the second half of the same rule, held in the browser.
 */
describe("the account page's places", () => {
  it('links a place by its hostname, over https, and a loopback dev host over http', () => {
    expect(placeHref({ hostname: 'desk.acme.test' })).toBe('https://desk.acme.test/');
    expect(placeHref({ hostname: 'desk-acme.global.substrat.run' })).toBe('https://desk-acme.global.substrat.run/');
    expect(placeHref({ hostname: 'localhost:5273' })).toBe('http://localhost:5273/');
  });

  it('links nothing that is not a bare hostname', () => {
    for (const hostname of [
      'javascript:alert(1)',
      'evil.test/phish',
      'user@evil.test',
      'https://evil.test',
      'evil.test?x=1',
      'EVIL.test',
      '',
      '.evil.test',
    ]) {
      expect(placeHref({ hostname })).toBeNull();
    }
  });

  it('keeps only the entries that are places, and recognises the answer shape', () => {
    const good = { tenantId: 't', scopeId: 's', hostname: 'desk.acme.test', name: 'Acme Desk' };
    expect(isPlacesAnswer({ places: [] })).toBe(true);
    expect(isPlacesAnswer({ error: 'sign in to see your places' })).toBe(false);
    expect(placesOf({ places: [good, { ...good, hostname: 'javascript:x' }, { name: 'no ids' }, null] })).toEqual([good]);
  });
});
