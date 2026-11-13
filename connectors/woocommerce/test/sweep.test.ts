import { afterEach, describe, expect, it } from 'vitest';
import type { CommerceChange } from '@substrat-run/contracts';
import { listWooCommerceBindings, woocommerceConnectionActivity } from '../src/index.js';
import { WooCommerceMock, type WooCommerceMockOptions } from '../src/mock.js';
import { ORDERS, PRODUCTS, VARIATIONS, product } from './fixture.js';
import { touch, world, type World } from './world.js';

/**
 * The inbound path end to end against `WooCommerceMock`: bound to a scope, a sweep walks what
 * changed at the store and lands each product and order, in the neutral commerce shape, through the
 * vertical's own operation as the connection itself.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const store = (over: WooCommerceMockOptions = {}) =>
  new WooCommerceMock({ products: PRODUCTS(), variations: VARIATIONS(), orders: ORDERS(), ...over });

const ids = (changes: CommerceChange[]) => changes.map((c) => (c.record === 'product' ? `p${c.productId}` : `o${c.orderId}`));

describe('woocommerce connector — inbound sync', () => {
  it('lands every product, then every order, in the neutral commerce shape', async () => {
    w = await world(store());
    await w.bind();
    const result = await w.sweep();
    expect(result).toMatchObject({ found: 1, unchanged: 0, failed: [] });
    // Oldest change first; the draft checkout is passed over.
    expect(ids(w.landed)).toEqual(['p11', 'p12', 'p13', 'o501', 'o502', 'o504']);

    const [mug, shirt, card, paid, cancelled, custom] = w.landed;
    expect(mug).toMatchObject({
      record: 'product',
      name: 'Mugg Åre',
      listed: true,
      currency: 'SEK',
      modifiedAt: '2026-11-01T10:00:00.000Z',
      // A simple product sells one variant, under the product's own id.
      variants: [{ variantId: '11', sku: 'MUG-1', title: null, options: [], price: '129.00', compareAtPrice: '149.00' }],
    });
    expect(shirt).toMatchObject({
      variants: [
        { variantId: '121', title: 'M', options: [{ name: 'Size', value: 'M' }], price: '199.00', compareAtPrice: null },
        { variantId: '122', title: 'L', price: '219.50', compareAtPrice: '249.00' },
      ],
    });
    expect(card).toMatchObject({ listed: false, providerStatus: 'draft', variants: [{ variantId: '13', sku: null, price: null }] });
    expect(paid).toMatchObject({
      record: 'order',
      orderId: '501',
      paidAt: '2026-11-02T08:05:00.000Z',
      cancelled: false,
      total: '546.25',
      discountTotal: '10.00',
      customer: { customerId: '7', email: 'asa@example.com', lastName: 'Ångström', phone: null },
      billingAddress: { city: 'Umeå', postalCode: '903 26', country: 'SE' },
      lines: [
        { productId: '11', variantId: '11', quantity: 2, subtotal: '206.40' },
        { productId: '12', variantId: '122', total: '167.60', tax: '43.90' },
      ],
      customerNote: null,
    });
    expect(cancelled).toMatchObject({ cancelled: true, paidAt: null, customer: { customerId: null }, shippingAddress: null, customerNote: 'Ring innan leverans' });
    expect(custom).toMatchObject({ lines: [{ productId: null, variantId: null, name: 'Frakttillägg' }] });
  });

  it.each([false, true])(
    'lands nothing on an idle pass, and exactly what changed after — modified_after inclusive: %s',
    async (inclusive) => {
      const mock = store({ modifiedAfterInclusive: inclusive });
      w = await world(mock);
      await w.bind();
      await w.sweep();
      w.landed.length = 0;

      expect(await w.sweep()).toMatchObject({ unchanged: 1, synced: [] });
      expect(w.landed).toEqual([]);

      // One product saved in the cursor's own second, one order later.
      touch(mock.products.find((p) => p.id === 12)!, '2026-11-01T11:00:00', { name: 'T-shirt (ny)' });
      touch(mock.orders.find((o) => o.id === 502)!, '2026-11-03T12:00:00');
      await w.sweep();
      expect(ids(w.landed)).toEqual(['p12', 'o502']);
      expect(w.landed[0]).toMatchObject({ name: 'T-shirt (ny)' });
    },
  );

  it('walks a long backlog over several passes, and more changes in one second than a page holds', async () => {
    // 120 products in one second, then 130 a second apart: 250 rows, in pages of 100.
    const rows = [
      ...Array.from({ length: 120 }, (_, i) => product(1000 + i, '2026-11-01T10:00:00')),
      ...Array.from({ length: 130 }, (_, i) => product(2000 + i, new Date(Date.UTC(2026, 10, 1, 11, 0, i)).toISOString().slice(0, 19))),
    ];
    const mock = new WooCommerceMock({ products: rows });
    w = await world(mock);
    await w.bind();

    const first = await w.sweep({ pagesPerSync: 1 });
    expect(first.synced[0]).toMatchObject({ products: 100, caughtUp: false });
    expect((await woocommerceConnectionActivity(w.host, w.connId)).entries[0]).toMatchObject({ status: 'catching up' });

    for (let pass = 0; pass < 5; pass += 1) await w.sweep({ pagesPerSync: 1 });
    const landed = ids(w.landed);
    expect(new Set(landed).size).toBe(250);
    expect(landed.length).toBe(250);
    expect((await listWooCommerceBindings(w.host, w.connId))[0]?.lastSync?.caughtUp).toBe(true);
  });

  it('misses nothing when a product is saved while the sweep is walking past it', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => product(3000 + i, new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString().slice(0, 19)));
    const mock = new WooCommerceMock({ products: rows });
    // Saving product 3010 moves it to the end of the list and every later row one place back: a
    // walk by page number would then never see the row that slid onto page one.
    w = await world(mock, {
      onLand: (c) => {
        if (c.record === 'product' && c.productId === '3050') touch(mock.products.find((p) => p.id === 3010)!, '2026-11-01T12:00:00');
      },
    });
    await w.bind();
    await w.sweep();
    expect(new Set(ids(w.landed))).toEqual(new Set(rows.map((r) => `p${r.id}`)));
  });

  it('refuses a row it cannot read faithfully, keeping what landed before it', async () => {
    const mock = store();
    mock.products.find((p) => p.id === 13)!.price = '1 299,00';
    w = await world(mock);
    await w.bind();
    const result = await w.sweep();
    expect(result.failed).toEqual([{ scopeId: w.scopeId, error: expect.stringMatching(/product 13 price: '1 299,00' is not a decimal amount/) }]);
    expect(ids(w.landed)).toEqual(['p11', 'p12']);

    // Fixed at the store: the next pass resumes at the refused row, not at the start.
    touch(mock.products.find((p) => p.id === 13)!, '2026-11-01T11:00:00', { price: '1299.00' });
    w.landed.length = 0;
    await w.sweep();
    expect(ids(w.landed)).toEqual(['p13', 'o501', 'o502', 'o504']);
  });

  it('refuses to bind a connection that does not hold the landing permission', async () => {
    w = await world(store(), { grant: false });
    await expect(w.bind()).rejects.toThrow(/does not hold 'commerce:record'/);
  });

  it('sits out a rate limit and completes, waiting what the store asked', async () => {
    w = await world(store({ rateLimitFirst: 1 }));
    await w.bind();
    expect((await w.sweep()).failed).toEqual([]);
    expect(w.waited).toEqual([2000]);
  });
});
