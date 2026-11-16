import { afterEach, describe, expect, it } from 'vitest';
import type { CommerceChange } from '@substrat-run/contracts';
import { listWooCommerceBindings, WOOCOMMERCE_ROW_ATTEMPTS, woocommerceConnectionActivity } from '../src/index.js';
import { WooCommerceMock } from '../src/mock.js';
import { ORDERS, PRODUCTS, VARIATIONS } from './fixture.js';
import { RECORD, world, type World } from './world.js';

/**
 * #3241: one record the walk cannot land must not hold everything after it. An unreadable row is
 * skipped at once; a row whose landing fails stalls its own resource's walk for a few passes, then is
 * skipped; either way it is listed with its error and tried again until it lands.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const store = () => new WooCommerceMock({ products: PRODUCTS(), variations: VARIATIONS(), orders: ORDERS() });
const ids = (changes: CommerceChange[]) => changes.map((c) => (c.record === 'product' ? `p${c.productId}` : `o${c.orderId}`));
const lastSync = async (x: World) => (await listWooCommerceBindings(x.host, x.connId))[0]?.lastSync;
const status = async (x: World) => (await woocommerceConnectionActivity(x.host, x.connId)).entries[0];

describe('woocommerce connector — a record that cannot land (#3241)', () => {
  it('moves past rows it cannot read, lists them with their error, and lands one once it reads', async () => {
    const mock = store();
    // A WPML-style decimal comma in the middle of the catalogue, and an order whose line WooCommerce would never send.
    mock.products.find((p) => p.id === 12)!.price = '1 299,00';
    mock.variations[12] = [];
    (mock.orders.find((o) => o.id === 502)!.line_items as Record<string, unknown>[])[0]!.quantity = 'two';
    w = await world(mock);
    await w.bind();

    expect(await w.sweep()).toMatchObject({ failed: [], synced: [{ products: 2, orders: 2, skipped: 2, caughtUp: true }] });
    expect(ids(w.landed)).toEqual(['p11', 'p13', 'o501', 'o504']);
    expect((await lastSync(w))?.skipped).toEqual([
      expect.objectContaining({ resource: 'products', id: 12, modifiedAt: '2026-11-01T10:00:00.000Z', attempts: 1, error: "product 12 price: '1 299,00' is not a decimal amount" }),
      expect.objectContaining({ resource: 'orders', id: 502, attempts: 1, error: expect.stringContaining('line_items.0.quantity') }),
    ]);
    const entry = await status(w);
    expect(entry?.status).toBe('synced — 2 skipped');
    expect(entry?.facts).toContainEqual({ label: 'Skipped product 12', value: expect.stringMatching(/^product 12 price: '1 299,00' is not a decimal amount — last tried /) });

    // Fixed at the store without a save that would move it: the retry by id lands it and clears it.
    mock.products.find((p) => p.id === 12)!.price = '1299.00';
    w.landed.length = 0;
    await w.sweep({ reconcileEveryMs: 0 });
    expect(ids(w.landed)).toEqual(['p12']);
    expect((await lastSync(w))?.skipped).toEqual([expect.objectContaining({ resource: 'orders', id: 502, attempts: 2 })]);
    expect((await status(w))?.status).toBe('synced — 1 skipped');
  });

  it('stalls the products at a landing that keeps failing while the orders land, then moves past it', async () => {
    const mock = store();
    let refuse = true;
    w = await world(mock, {
      onLand: (c) => {
        if (refuse && c.record === 'product' && c.productId === '12') throw new Error('UNIQUE constraint failed: products.sku');
      },
    });
    await w.bind();

    const first = await w.sweep();
    expect(first.failed).toEqual([
      {
        scopeId: w.scopeId,
        error: expect.stringContaining('product 12: '),
        said: expect.stringMatching(/^product 12 did not land, and its walk waits there: the landing operation 'shop\/record-commerce' refused it.*UNIQUE constraint failed/),
      },
    ]);
    // The product it waits at holds only the products: every order landed.
    expect(ids(w.landed)).toEqual(['p11', 'o501', 'o502', 'o504']);
    expect((await status(w))?.status).toBe('stalled at product 12');
    expect((await lastSync(w))?.caughtUp).toBe(false);

    for (let pass = 2; pass < WOOCOMMERCE_ROW_ATTEMPTS; pass += 1) expect((await w.sweep()).failed).toHaveLength(1);
    expect((await lastSync(w))?.stalled).toEqual([expect.objectContaining({ id: 12, attempts: WOOCOMMERCE_ROW_ATTEMPTS - 1 })]);
    w.landed.length = 0;
    expect((await w.sweep()).failed).toEqual([]);
    expect(ids(w.landed)).toEqual(['p13']);
    expect(await lastSync(w)).toMatchObject({ caughtUp: true, skipped: [{ id: 12, attempts: WOOCOMMERCE_ROW_ATTEMPTS }] });
    expect((await lastSync(w))?.stalled).toBeUndefined();

    refuse = false;
    w.landed.length = 0;
    await w.sweep({ reconcileEveryMs: 0 });
    expect(ids(w.landed)).toEqual(['p12']);
    expect((await lastSync(w))?.skipped).toBeUndefined();
    expect((await status(w))?.status).toBe('synced');
  });

  it('skips nothing when the connection may no longer land at all', async () => {
    w = await world(store());
    await w.bind();
    await w.host.admin.revokeFromConnection(w.staff, { connectionId: w.connId, permission: RECORD, node: { tenantId: w.tenantId, scopeId: w.scopeId }, revokedBy: w.staff });
    for (let pass = 0; pass <= WOOCOMMERCE_ROW_ATTEMPTS; pass += 1) {
      expect((await w.sweep()).failed).toEqual([{ scopeId: w.scopeId, error: expect.stringMatching(/permission denied/) }]);
    }
    expect(w.landed).toEqual([]);
    expect(await lastSync(w)).toMatchObject({ products: { at: null } });
    expect((await lastSync(w))?.skipped).toBeUndefined();
  });
});
