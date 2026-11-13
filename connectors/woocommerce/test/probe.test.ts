import { describe, expect, it } from 'vitest';
import { probeWooCommerceSecret } from '../src/index.js';
import { WooCommerceMock } from '../src/mock.js';

/**
 * The connect-time probe: a good key names the store, and each way a paste can be wrong is told
 * apart — wrong key, a key without the role to read the store, an address with no WooCommerce
 * behind it, an address that is not allowed — without the secret ever appearing in the answer.
 */
const SECRET = 'cs_0123456789abcdef';
const probe = (mock: WooCommerceMock, over: Record<string, string> = {}) =>
  probeWooCommerceSecret({ ...mock.secret, ...over }, { fetch: mock.fetch });

describe('woocommerce probe', () => {
  it('names the store, its WooCommerce version and currency, without triggering its remote tests', async () => {
    const mock = new WooCommerceMock({ consumerSecret: SECRET, currency: 'EUR' });
    expect(await probe(mock)).toEqual({
      ok: true,
      refused: false,
      accountRef: null,
      accountLabel: 'https://shop.example.com',
      facts: [
        { label: 'Store', value: 'https://shop.example.com' },
        { label: 'WooCommerce', value: '9.4.0' },
        { label: 'Currency', value: 'EUR' },
      ],
      error: null,
    });
    expect(mock.remoteTests).toBe(0);
  });

  it.each([
    ['a wrong key', new WooCommerceMock({ consumerSecret: SECRET }), { consumerSecret: 'cs_wrong' }, true, /Consumer key is invalid/],
    ['a key whose user is no manager', new WooCommerceMock({ consumerSecret: SECRET, manager: false }), {}, true, /administrator or a shop manager/],
    ['WordPress without WooCommerce', new WooCommerceMock({ consumerSecret: SECRET, notWooCommerce: 'wordpress' }), {}, false, /no WooCommerce store at/],
    ['a site that answers a page', new WooCommerceMock({ consumerSecret: SECRET, notWooCommerce: 'html' }), {}, false, /not JSON/],
    ['an address that does not resolve', new WooCommerceMock({ consumerSecret: SECRET }), { storeUrl: 'https://elsewhere.example.com' }, false, /ENOTFOUND/],
    ['a plain-HTTP address', new WooCommerceMock({ consumerSecret: SECRET }), { storeUrl: 'http://shop.example.com' }, false, /https:\/\//],
    ['a missing secret', new WooCommerceMock({ consumerSecret: SECRET }), { consumerSecret: '' }, true, /consumerSecret/],
  ])('fails on %s, refused: %s', async (_, mock, over, refused, error) => {
    const answer = await probe(mock, over);
    expect(answer).toMatchObject({ ok: false, refused, accountLabel: null, error: expect.stringMatching(error) });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // Only the unauthenticated index is ever asked with no key; the key never travels in a URL.
    expect(mock.requests.join(' ')).not.toMatch(/consumer_(key|secret)/);
  });
});
