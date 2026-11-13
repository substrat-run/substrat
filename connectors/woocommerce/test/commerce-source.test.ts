import { WooCommerceMock } from '../src/mock.js';
import { commerceSourceSuite } from './commerce-source-suite.js';
import { ORDERS, PRODUCTS, VARIATIONS } from './fixture.js';
import { touch, world, type World } from './world.js';

/** The shared commerce-source behaviour, run against the WooCommerce mock. */
commerceSourceSuite('woocommerce', () => {
  const mock = new WooCommerceMock({ products: PRODUCTS(), variations: VARIATIONS(), orders: ORDERS() });
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
    renameSimpleProduct: async (name) => touch(mock.products.find((p) => p.id === 11)!, '2026-11-05T09:00:00', { name }),
    close: () => w?.close(),
  };
});
