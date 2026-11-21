import { commerceSourceSuite } from '@substrat-run/contract-tests';
import { ShopifyMock } from '../src/mock.js';
import { NOW, ORDERS, PRODUCTS } from './fixture.js';
import { touch, world, type World } from './world.js';

/** The shared commerce-source behaviour, run against the Shopify mock — the same suite WooCommerce runs. */
commerceSourceSuite('shopify', () => {
  const mock = new ShopifyMock({ products: PRODUCTS(), orders: ORDERS(), now: () => NOW });
  let w: World | undefined;
  return {
    seed: async () => {
      w = await world(mock);
      await w.bind();
    },
    sweep: async () => {
      await w!.sweep();
    },
    landed: () => w!.landed,
    renameSimpleProduct: async (name) => touch(mock.products.find((p) => p.id.endsWith('/11'))!, '2026-11-05T09:00:00Z', { title: name }),
    close: () => w?.close(),
  };
});
