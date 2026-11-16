import { afterEach, describe, expect, it } from 'vitest';
import type { CommerceChange } from '@substrat-run/contracts';
import { listWooCommerceBindings, WOOCOMMERCE_RECONCILE_EVERY_MS, woocommerceConnectionActivity } from '../src/index.js';
import { WooCommerceMock, type WooCommerceMockOptions } from '../src/mock.js';
import { ORDERS, PRODUCTS, VARIATIONS, product } from './fixture.js';
import { touch, world, type World } from './world.js';

/**
 * Deletes and the trash (#3224): the reconcile pass asks the store about the ids it delivered, and
 * reports each one that left through the same landing operation, as `change: 'removed'`.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const HOUR = WOOCOMMERCE_RECONCILE_EVERY_MS;
const store = (over: WooCommerceMockOptions = {}) =>
  new WooCommerceMock({ products: PRODUCTS(), variations: VARIATIONS(), orders: ORDERS(), ...over });

const ids = (changes: CommerceChange[]) => changes.map((c) => (c.record === 'product' ? `p${c.productId}` : `o${c.orderId}`));
const removals = (changes: CommerceChange[]) =>
  changes
    .filter((c) => c.change === 'removed')
    .map((c) => `${c.record === 'product' ? `p${c.productId}` : `o${c.orderId}`}:${c.change === 'removed' ? c.removal : ''}`);

/** A world whose clock the test moves, swept once (everything delivered, first reconcile done). */
async function swept(mock: WooCommerceMock, onLand?: (c: CommerceChange) => void) {
  let t = Date.parse('2026-11-16T10:00:00Z');
  w = await world(mock, { onLand });
  await w.bind();
  const sweep = () => w!.sweep({ now: () => t });
  await sweep();
  w.landed.length = 0;
  return { w, sweep, later: (ms = HOUR) => (t += ms) };
}

describe('woocommerce connector — deletes and the trash', () => {
  it('reports a trashed product and a deleted order once, within one reconcile interval, and never an id it did not deliver', async () => {
    const mock = store();
    const s = await swept(mock);
    mock.products.find((p) => p.id === 11)!.status = 'trash';
    mock.orders.splice(mock.orders.findIndex((o) => o.id === 502), 1);
    // The draft checkout was never delivered: its delete is not the vertical's business.
    mock.orders.splice(mock.orders.findIndex((o) => o.id === 503), 1);

    // Inside the interval nothing is asked.
    s.later(HOUR / 2);
    await s.sweep();
    expect(s.w.landed).toEqual([]);

    s.later(HOUR / 2);
    const result = await s.sweep();
    expect(removals(s.w.landed)).toEqual(['p11:trashed', 'o502:deleted']);
    expect(s.w.landed[0]).toMatchObject({ record: 'product', change: 'removed', productId: '11', observedAt: '2026-11-16T11:00:00.000Z' });
    expect(result.synced[0]).toMatchObject({ removed: 2 });

    // A re-sweep with nothing new removed reports nothing.
    s.w.landed.length = 0;
    s.later();
    expect(await s.sweep()).toMatchObject({ unchanged: 1 });
    expect(s.w.landed).toEqual([]);

    // The trash emptied: the product is now gone for good, and says so.
    mock.products.splice(mock.products.findIndex((p) => p.id === 11), 1);
    s.later();
    await s.sweep();
    expect(removals(s.w.landed)).toEqual(['p11:deleted']);
    expect((await woocommerceConnectionActivity(s.w.host, s.w.connId)).entries[0]?.facts).toContainEqual({
      label: 'Deletes reconciled',
      value: '2026-11-16T13:00:00.000Z',
    });
  });

  it('watches a product restored from the trash as live again, so a second trashing is reported', async () => {
    const mock = store();
    const s = await swept(mock);
    const mug = mock.products.find((p) => p.id === 11)!;
    mug.status = 'trash';
    s.later();
    await s.sweep();
    // Restoring saves the product: the walk lands it again.
    touch(mug, '2026-11-16T10:30:00', { status: 'publish' });
    s.later();
    await s.sweep();
    mug.status = 'trash';
    s.later();
    await s.sweep();
    expect(removals(s.w.landed)).toEqual(['p11:trashed', 'p11:trashed']);
    expect(s.w.landed.filter((c) => c.change === 'upsert').map((c) => c.record === 'product' && c.productId)).toEqual(['11']);
  });

  it('reports a removal again when landing it failed', async () => {
    const mock = store();
    let fail = true;
    const s = await swept(mock, (c) => {
      if (c.change === 'removed' && fail) {
        fail = false;
        throw new Error('vertical down');
      }
    });
    mock.orders.splice(mock.orders.findIndex((o) => o.id === 501), 1);
    s.later();
    expect((await s.sweep()).failed).toEqual([{ scopeId: s.w.scopeId, error: expect.stringMatching(/vertical down/) }]);
    // Not reconciled: the next pass asks again without waiting out the interval.
    await s.sweep();
    expect(removals(s.w.landed)).toEqual(['o501:deleted', 'o501:deleted']);
  });

  it('reads on from where a capped confirmation stopped — a store that ignores include reports nothing falsely, and misses no delete', async () => {
    // More products than two batches: asked by id, this store answers its first hundred whatever was asked.
    const products = Array.from({ length: 250 }, (_, i) => product(4000 + i, new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString().slice(0, 19)));
    const mock = store({ ignoreInclude: true, products, orders: [] });
    const all = products.map((p) => p.id);
    const reads = () => mock.requests.filter((r) => /\/products\/\d+\?/.test(r)).map((r) => Number(/\/products\/(\d+)/.exec(r)![1]));
    mock.requests.length = 0;
    // The first sweep's reconcile reads the first hundred of the hundred and fifty left out, and finds them.
    const s = await swept(mock);
    expect(reads()).toEqual(all.slice(100, 200));
    expect(s.w.landed).toEqual([]);

    // Deleted among the ones no pass has read yet; the next pass reads on from there, without waiting.
    mock.products.splice(mock.products.findIndex((p) => p.id === 4249), 1);
    mock.requests.length = 0;
    await s.sweep();
    expect(removals(s.w.landed)).toEqual(['p4249:deleted']);
    expect(reads().slice(0, 50)).toEqual(all.slice(200, 250));
  });

  it('records what a binding synced before delivered ids were tracked already holds, by walking the store once more', async () => {
    const mock = store();
    const s = await swept(mock);
    // As the previous version left it: cursors, but no delivered ids and no marker.
    const [binding] = await listWooCommerceBindings(s.w.host, s.w.connId);
    const { tracksDelivered: _, reconciledAt: __, ...legacy } = binding!.lastSync!;
    await s.w.host.admin.putConnectorState(s.w.connId, `woocommerce:binding:${s.w.scopeId}`, { ...binding, lastSync: legacy });
    for (const { key } of await s.w.host.admin.listConnectorState(s.w.connId, 'woocommerce:seen:')) {
      await s.w.host.admin.putConnectorState(s.w.connId, key, null);
    }

    await s.sweep();
    expect(ids(s.w.landed)).toEqual(['p11', 'p12', 'p13', 'o501', 'o502', 'o504']);
    s.w.landed.length = 0;

    mock.products.splice(mock.products.findIndex((p) => p.id === 13), 1);
    s.later();
    await s.sweep();
    expect(removals(s.w.landed)).toEqual(['p13:deleted']);
  });
});
