import { afterEach, describe, expect, it } from 'vitest';
import { connectionId, type CommerceChange, type DomainEvent } from '@substrat-run/contracts';
import { isConnectorRefusal, ulid, type ConnectorContext } from '@substrat-run/kernel';
import {
  WOOCOMMERCE_ORDER_COMPLETE_REQUESTED,
  WOOCOMMERCE_STOCK_SET_REQUESTED,
  bindWooCommerceScope,
  declareWooCommerceConnector,
  woocommerceConnector,
} from '../src/index.js';
import { WooCommerceMock, type WooCommerceMockOptions } from '../src/mock.js';
import { ORDERS, PRODUCTS, VARIATIONS } from './fixture.js';
import { OPERATION, RECORD, world, type World } from './world.js';

/**
 * The write-back dispatch (#3136) against `WooCommerceMock`: a request the vertical emitted is
 * written through the store connection bound to the asking scope, and the record as it now stands
 * lands through the binding's operation.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const store = (over: WooCommerceMockOptions = {}) =>
  new WooCommerceMock({ products: PRODUCTS(), variations: VARIATIONS(), orders: ORDERS(), ...over });

async function setup(mock: WooCommerceMock, opts: { grant?: boolean; bind?: boolean } = {}) {
  w = await world(mock, { grant: opts.grant });
  if (opts.bind !== false) {
    // Without the grant, bound as the landing pass binds: before the grant it is about to write.
    await bindWooCommerceScope(w.host, {
      connectionId: w.connId,
      tenantId: w.tenantId,
      scopeId: w.scopeId,
      vertical: 'shop',
      operation: OPERATION,
      permission: RECORD,
      grantPreflighted: opts.grant === false,
    });
  }
  const handler = woocommerceConnector({ fetch: mock.fetch, host: w.host });
  const ctx = {
    admin: w.host.admin,
    tenantId: w.tenantId,
    scopeId: w.scopeId,
    vertical: 'shop',
    connection: async () => {
      throw new Error('the write-back opens its connection by the binding, never by ctx.connection');
    },
  } as unknown as ConnectorContext;
  const world_ = w;
  const run = async (type: string, payload: Record<string, unknown>): Promise<void> =>
    handler(ctx, { id: ulid(), type, tenantId: world_.tenantId, scopeId: world_.scopeId, payload: { requestId: 'req-1', connectionId: world_.connId, ...payload } } as unknown as DomainEvent);
  return { run, w: world_ };
}

const variant = (c: CommerceChange | undefined, id: string) =>
  c?.record === 'product' && c.change === 'upsert' ? c.variants.find((v) => v.variantId === id) : undefined;

describe('woocommerce connector — write-back', () => {
  it.each([
    ['a simple product, on the product', '11', '11', '/wp-json/wc/v3/products/11'],
    ['a variation with its own count, on the variation', '12', '122', '/wp-json/wc/v3/products/12/variations/122'],
    ['a variation sharing its product count, on the product', '12', '121', '/wp-json/wc/v3/products/12'],
  ])('sets the stock of %s, and lands the product as it now stands', async (_, productId, variantId, path) => {
    const mock = store();
    const { run, w } = await setup(mock);
    await run(WOOCOMMERCE_STOCK_SET_REQUESTED, { productId, variantId, quantity: 4 });
    expect(mock.writes).toEqual([{ path, body: { manage_stock: true, stock_quantity: 4 } }]);
    expect(w.landed).toHaveLength(1);
    expect(variant(w.landed[0], variantId)?.stock).toMatchObject({ manageStock: true, quantity: 4 });
  });

  it('completes a processing order, and lands it completed', async () => {
    const mock = store();
    const { run, w } = await setup(mock);
    await run(WOOCOMMERCE_ORDER_COMPLETE_REQUESTED, { orderId: '501' });
    expect(mock.writes).toEqual([{ path: '/wp-json/wc/v3/orders/501', body: { status: 'completed' } }]);
    expect(w.landed).toEqual([expect.objectContaining({ record: 'order', orderId: '501', providerStatus: 'completed' })]);
    // Redelivered: already completed, so nothing is written again, and it lands again.
    await run(WOOCOMMERCE_ORDER_COMPLETE_REQUESTED, { orderId: '501' });
    expect(mock.writes).toHaveLength(1);
    expect(w.landed).toHaveLength(2);
  });

  it.each([
    ['a cancelled order', WOOCOMMERCE_ORDER_COMPLETE_REQUESTED, { orderId: '502' }, /is 'cancelled' at the store/],
    ['an order the store does not hold', WOOCOMMERCE_ORDER_COMPLETE_REQUESTED, { orderId: '999' }, /holds no order 999/],
    ['a variant the store does not hold', WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: '12', variantId: '999', quantity: 1 }, /holds no variant 999/],
    ['a product the store does not hold', WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: '999', variantId: '999', quantity: 1 }, /invalid_id/],
  ])('refuses %s for good, and lands nothing', async (_, type, payload, message) => {
    const mock = store();
    const { run, w } = await setup(mock);
    const err = await run(type, payload).catch((e: unknown) => e);
    expect(isConnectorRefusal(err)).toBe(true);
    expect((err as Error).message).toMatch(message);
    expect(w.landed).toEqual([]);
  });

  it('refuses a key without Write permission for good, and lands nothing', async () => {
    const mock = store({ write: false });
    const { run, w } = await setup(mock);
    const err = await run(WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: '11', variantId: '11', quantity: 1 }).catch((e: unknown) => e);
    expect(isConnectorRefusal(err)).toBe(true);
    expect((err as Error).message).toMatch(/401 woocommerce_rest_cannot_edit/);
    expect(w.landed).toEqual([]);
  });

  it('writes nothing through a connection not bound to the asking scope', async () => {
    const mock = store();
    const { run } = await setup(mock, { bind: false });
    const err = await run(WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: '11', variantId: '11', quantity: 1 }).catch((e: unknown) => e);
    expect(isConnectorRefusal(err)).toBe(true);
    expect((err as Error).message).toMatch(/is not bound to scope/);
    // Another tenant's connection id is refused the same way, before the store is asked anything.
    const other = await run(WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: '11', variantId: '11', quantity: 1, connectionId: connectionId.parse(ulid()) }).catch((e: unknown) => e);
    expect(isConnectorRefusal(other)).toBe(true);
    expect(mock.requests).toEqual([]);
  });

  it('waits, and writes nothing, while the connection does not hold the landing key yet', async () => {
    const mock = store();
    const { run, w } = await setup(mock, { grant: false });
    const err = await run(WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: '11', variantId: '11', quantity: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isConnectorRefusal(err)).toBe(false);
    expect((err as Error).message).toMatch(/does not hold 'commerce:record'/);
    expect(mock.writes).toEqual([]);
    expect(w.landed).toEqual([]);
  });

  it('refuses a request that does not name a store id', async () => {
    const { run } = await setup(store());
    await expect(run(WOOCOMMERCE_STOCK_SET_REQUESTED, { productId: 'mug', variantId: '11', quantity: 1 })).rejects.toThrow(/a store id/);
  });

  it('declares both requests for routing, under the woocommerce provider', () => {
    const registered: { id: string; type: string; provider?: string }[] = [];
    declareWooCommerceConnector({
      registerConnector: (id, type, _handler, options) => {
        registered.push({ id, type, provider: options?.provider });
      },
    });
    expect(registered).toEqual([
      { id: WOOCOMMERCE_STOCK_SET_REQUESTED, type: WOOCOMMERCE_STOCK_SET_REQUESTED, provider: 'woocommerce' },
      { id: WOOCOMMERCE_ORDER_COMPLETE_REQUESTED, type: WOOCOMMERCE_ORDER_COMPLETE_REQUESTED, provider: 'woocommerce' },
    ]);
  });
});
