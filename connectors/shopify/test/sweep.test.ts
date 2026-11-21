import { afterEach, describe, expect, it } from 'vitest';
import type { CommerceChange } from '@substrat-run/contracts';
import { ROW_COST, ShopifyMock, type ShopifyMockOptions } from '../src/mock.js';
import { SHOPIFY_ORDERS_PAGE, SHOPIFY_PRODUCTS_PAGE } from '../src/api.js';
import { NOW, ORDERS, PRODUCTS, gid, line, order, product, variant } from './fixture.js';
import { touch, world, type World } from './world.js';

const ids = (landed: CommerceChange[], record: 'product' | 'order'): string[] =>
  landed.filter((c) => c.record === record && c.change === 'upsert').map((c) => (c.record === 'product' ? (c as { productId: string }).productId : (c as { orderId: string }).orderId));

describe('shopify sweep', () => {
  let w: World | undefined;
  afterEach(() => {
    w?.close();
    w = undefined;
  });
  const start = async (options: ShopifyMockOptions = {}, clock?: { now: number }) => {
    const mock = new ShopifyMock({ products: PRODUCTS(), orders: ORDERS(), now: () => clock?.now ?? NOW, ...options });
    w = await world(mock, clock ? { clock } : {});
    await w.bind();
    return { mock, w };
  };

  it('lands the shop in change order, with one token per pass and nothing it was not asked for', async () => {
    const { mock, w } = await start();
    const r = await w.sweep();
    expect(r).toMatchObject({ found: 1, failed: [] });
    expect(ids(w.landed, 'product')).toEqual(['11', '12', '13']);
    expect(ids(w.landed, 'order')).toEqual(['501', '502']);
    // Without read_customers the order query never asks for the customer, so it is not refused.
    expect(w.landed.find((c) => c.record === 'order')).toMatchObject({ customer: { customerId: null } });
    expect(mock.minted).toHaveLength(1);
    expect((await w.binding()).lastSync).toMatchObject({ caughtUp: true, products: { at: '2026-11-01T11:00:00.000Z', landedAt: ['13'] } });
  });

  it('names the customer account when the app holds read_customers', async () => {
    const { w } = await start({ scopes: ['read_products', 'read_orders', 'read_customers'] });
    await w.sweep();
    expect(w.landed.find((c) => c.record === 'order')).toMatchObject({ customer: { customerId: '77' } });
  });

  it('walks a bulk edit saved in one second across passes, by the GraphQL cursor it stopped at', async () => {
    const many = Array.from({ length: SHOPIFY_PRODUCTS_PAGE * 2 + 10 }, (_, i) => product(100 + i, '2026-11-04T10:00:00Z'));
    const { w } = await start({ products: many, orders: [] });
    await w.sweep({ pagesPerSync: 1 });
    expect((await w.binding()).lastSync).toMatchObject({ caughtUp: false, products: { resume: { from: null } } });
    await w.sweep({ pagesPerSync: 1 });
    await w.sweep({ pagesPerSync: 1 });
    const landed = ids(w.landed, 'product');
    expect(landed).toHaveLength(many.length);
    expect(new Set(landed).size).toBe(many.length);
    const last = (await w.binding()).lastSync!;
    expect(last.caughtUp).toBe(true);
    expect(last.products.resume).toBeUndefined();
  });

  it('asks a page Shopify refuses as too costly again at half the size, keeps that size, and lands every row', async () => {
    const orders = Array.from({ length: SHOPIFY_ORDERS_PAGE * 2 + 1 }, (_, i) => order(600 + i, `2026-11-02T09:${String(10 + i).padStart(2, '0')}:00Z`));
    const { mock, w } = await start({ orders, products: [], maxQueryCost: ROW_COST.ChangedOrders * (SHOPIFY_ORDERS_PAGE / 2) });
    const r = await w.sweep();
    expect(r.failed).toEqual([]);
    expect(ids(w.landed, 'order')).toEqual(orders.map((o) => o.id.split('/').pop()));
    // Refused once, then the halved size is kept for the rest of the pass.
    expect(mock.costRefusals.ChangedOrders).toBe(1);
  });

  it('leaves a change younger than the settle window for a later pass', async () => {
    const clock = { now: NOW };
    const { mock, w } = await start({}, clock);
    await w.sweep();
    const before = w.landed.length;
    touch(mock.products[0]!, new Date(NOW - 30_000).toISOString(), { title: 'Fresh' });
    await w.sweep();
    expect(w.landed.length).toBe(before);
    clock.now = NOW + 5 * 60_000;
    await w.sweep();
    expect(w.landed.slice(before)).toEqual([expect.objectContaining({ productId: '11', name: 'Fresh' })]);
  });

  it('reads the variants and lines past the first page with their product or order', async () => {
    const variants = Array.from({ length: 23 }, (_, i) => variant(9000 + i, { title: `V${i}`, selectedOptions: [{ name: 'N', value: `V${i}` }] }));
    const lines = Array.from({ length: 12 }, (_, i) => line(80000 + i));
    const { w } = await start({ products: [product(90, '2026-11-01T10:00:00Z', { hasOnlyDefaultVariant: false, variants })], orders: [order(800, '2026-11-02T09:00:00Z', { lineItems: lines })] });
    await w.sweep();
    const p = w.landed.find((c) => c.record === 'product') as { variants: unknown[] };
    const o = w.landed.find((c) => c.record === 'order') as { lines: unknown[] };
    expect(p.variants).toHaveLength(23);
    expect(o.lines).toHaveLength(12);
  });

  it("reports a deleted product, and a deleted order only where the app can tell it from Shopify's 60-day window", async () => {
    for (const [scopes, ordersReported] of [
      [['read_products', 'read_orders'], false],
      [['read_products', 'read_orders', 'read_all_orders'], true],
    ] as const) {
      const { mock, w } = await start({ scopes: [...scopes] });
      await w.sweep({ reconcileEveryMs: 0 });
      mock.products.splice(mock.products.findIndex((p) => p.id === gid('Product', 13)), 1);
      mock.orders.splice(mock.orders.findIndex((o) => o.id === gid('Order', 502)), 1);
      await w.sweep({ reconcileEveryMs: 0 });
      const removed = w.landed.filter((c) => c.change === 'removed');
      expect(removed).toEqual([
        expect.objectContaining({ record: 'product', productId: '13', removal: 'deleted' }),
        ...(ordersReported ? [expect.objectContaining({ record: 'order', orderId: '502', removal: 'deleted' })] : []),
      ]);
      expect((await w.binding()).lastSync?.ordersReconciled).toBe(ordersReported);
      // Reported once: the id is forgotten with it.
      await w.sweep({ reconcileEveryMs: 0 });
      expect(w.landed.filter((c) => c.change === 'removed')).toHaveLength(removed.length);
      w.close();
    }
    w = undefined;
  });

  it('sees an order older than 60 days only with read_all_orders', async () => {
    const old = order(700, '2026-08-01T09:00:00Z', { createdAt: '2026-08-01T09:00:00Z' });
    const without = await start({ orders: [old], products: [] });
    await without.w.sweep();
    expect(ids(without.w.landed, 'order')).toEqual([]);
    without.w.close();
    const withAll = await start({ orders: [order(700, '2026-08-01T09:00:00Z', { createdAt: '2026-08-01T09:00:00Z' })], products: [], scopes: ['read_products', 'read_orders', 'read_all_orders'] });
    await withAll.w.sweep();
    expect(ids(withAll.w.landed, 'order')).toEqual(['700']);
  });

  it('waits out a throttle for as long as the bucket needs, and mints again for a token revoked mid-pass', async () => {
    const { mock, w } = await start({ throttleFirst: 2 });
    let revoked = false;
    const r = await w.sweep();
    expect(r.failed).toEqual([]);
    // (500 asked − 100 available) / 100 a second.
    expect(w.waited).toEqual([4000, 4000]);
    const before = w.landed.length;
    touch(mock.products[2]!, '2026-11-05T10:00:00Z');
    touch(mock.orders[0]!, '2026-11-05T10:00:00Z');
    // Revoked between the product and the order: the order's query is refused once, then minted for.
    const landing = w.landed.push.bind(w.landed);
    w.landed.push = (...c: CommerceChange[]) => {
      if (!revoked) {
        mock.revokeTokens();
        revoked = true;
      }
      return landing(...c);
    };
    await w.sweep();
    expect(w.landed.length).toBe(before + 2);
    expect(mock.minted).toHaveLength(3);
  });

  it('skips a row its mapping refuses and lands the rest, keeping it listed', async () => {
    const products = PRODUCTS();
    (products[1]!.variants[0] as Record<string, unknown>).price = 'abc';
    const { w } = await start({ products });
    const r = await w.sweep();
    expect(r.failed).toEqual([]);
    expect(ids(w.landed, 'product')).toEqual(['11', '13']);
    expect((await w.binding()).lastSync?.skipped).toEqual([expect.objectContaining({ resource: 'products', id: 12, error: expect.stringMatching(/'abc' is not a decimal/) })]);
  });

  it('refuses to sync an app without the scopes a sync reads', async () => {
    const { w } = await start({ scopes: ['read_products'] });
    const r = await w.sweep();
    expect(r.failed).toEqual([expect.objectContaining({ error: expect.stringMatching(/lacks read_orders/) })]);
    expect(w.landed).toEqual([]);
  });
});
