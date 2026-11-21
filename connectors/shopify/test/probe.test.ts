import { describe, expect, it } from 'vitest';
import { prepareShopifyCandidate, probeShopifySecret, ShopifyKeyRefusal } from '../src/index.js';
import { ShopifyMock, type ShopifyMockOptions } from '../src/mock.js';
import { NOW } from './fixture.js';

const probe = (options: ShopifyMockOptions = {}, secret?: Record<string, string>) => {
  const mock = new ShopifyMock({ now: () => NOW, ...options });
  return { mock, run: () => probeShopifySecret(secret ?? mock.secret, { fetch: mock.fetch, now: () => NOW, sleep: async () => {} }) };
};

describe('shopify probe', () => {
  it('names the shop it reads, and says how far back its orders reach', async () => {
    const result = await probe({ name: 'Acme Butik' }).run();
    expect(result).toMatchObject({ ok: true, accountRef: 'acme.myshopify.com', accountLabel: 'Acme Butik', error: null });
    expect(result.facts).toEqual(
      expect.arrayContaining([
        { label: 'Shopify address', value: 'acme.myshopify.com' },
        { label: 'Order history', value: expect.stringMatching(/last 60 days only/) },
        { label: 'Customer accounts', value: expect.stringMatching(/not read/) },
      ]),
    );
  });

  it.each([
    ['a client the shop does not know', { clientSecret: 'other' }, true, /invalid_client.*Dev Dashboard/],
    ['an app of another organization', { shopNotPermitted: true }, true, /shop_not_permitted/],
    ['an app without read_orders', { scopes: ['read_products'] }, true, /lacks read_orders/],
    // Every scope present, and every sweep would still fail on orders: Test connection must say so.
    ['an app without protected customer data access', { protectedCustomerData: false }, true, /protected customer data access/],
    ['no shop at that name', { noShop: true }, false, /no Shopify shop at acme\.myshopify\.com/],
  ] as const)('tells %s apart', async (_, options, refused, error) => {
    const { mock } = probe();
    const secret = 'clientSecret' in options ? { ...mock.secret, clientSecret: options.clientSecret } : undefined;
    const result = await probe('clientSecret' in options ? {} : options, secret).run();
    expect(result).toMatchObject({ ok: false, refused });
    expect(result.error).toMatch(error);
  });

  it('refuses a custom domain without calling it', async () => {
    const { mock, run } = probe({}, { shop: 'shop.acme.se', clientId: 'client-id', clientSecret: 'shpss_secret' });
    const result = await run();
    expect(result).toMatchObject({ ok: false, refused: false, error: expect.stringMatching(/not a myshopify\.com address/) });
    expect(mock.requests).toEqual([]);
  });
});

describe('shopify candidate preparation', () => {
  it('stores the shop by its own myshopify.com name, and refuses another shop on rotation', async () => {
    const mock = new ShopifyMock({ now: () => NOW });
    const prepare = prepareShopifyCandidate({ fetch: mock.fetch, sleep: async () => {} });
    const typed = { ...mock.secret, shop: 'https://ACME.myshopify.com/admin' };
    await expect(prepare(typed, undefined)).resolves.toEqual({ secret: { ...mock.secret, shop: 'acme.myshopify.com' } });
    await expect(prepare(typed, { shop: 'acme' })).resolves.toBeDefined();
    const other = prepare(typed, { shop: 'other.myshopify.com' });
    await expect(other).rejects.toBeInstanceOf(ShopifyKeyRefusal);
    await expect(other).rejects.toThrow(/this connection is for other\.myshopify\.com/);
  });
});
