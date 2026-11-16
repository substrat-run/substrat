import { describe, it, expect } from 'vitest';
import { commerceChange, commerceProductUpsert } from '../src/index.js';

/**
 * The commerce-source shapes (#3136): what a vertical parses of a store, whichever platform it is.
 * A product always has a variant, money is a decimal string, and the record kind is explicit.
 */
const product = {
  record: 'product',
  change: 'upsert',
  connectionId: 'c1',
  productId: '12',
  name: 'Mug',
  slug: 'mug',
  url: null,
  listed: true,
  providerStatus: 'publish',
  currency: 'SEK',
  variants: [{ variantId: '12', sku: null, title: null, options: [], price: '129.00', compareAtPrice: null }],
  createdAt: null,
  modifiedAt: '2026-11-01T10:00:00Z',
};

describe('commerce-source shapes (#3136)', () => {
  it('accepts a product and normalises its instant', () => {
    expect(commerceChange.parse(product)).toMatchObject({ change: 'upsert' });
    const parsed = commerceProductUpsert.parse(product);
    expect(parsed.modifiedAt).toBe('2026-11-01T10:00:00.000Z');
  });

  it.each([
    [{ variants: [] }, 'a product with no variant'],
    [{ variants: [{ ...product.variants[0], price: 129 }] }, 'a price as a number'],
    [{ variants: [{ ...product.variants[0], price: '1,29' }] }, 'a price that is not a decimal'],
    [{ currency: 'sek' }, 'a currency that is not an ISO code'],
    [{ record: 'customer' }, 'a record kind nobody declared'],
    [{ change: 'delete' }, 'a change kind nobody declared'],
  ] as [Record<string, unknown>, string][])('refuses %j — %s', (over) => {
    expect(commerceChange.safeParse({ ...product, ...over }).success).toBe(false);
  });

  it('accepts a removal of a product or an order, by its id, and refuses one that says neither how nor which', () => {
    const removed = { change: 'removed', connectionId: 'c1', removal: 'trashed', observedAt: '2026-11-02T10:00:00Z' };
    expect(commerceChange.parse({ ...removed, record: 'product', productId: '12' })).toMatchObject({ removal: 'trashed' });
    expect(commerceChange.parse({ ...removed, record: 'order', orderId: '501', removal: 'deleted' })).toMatchObject({ removal: 'deleted' });
    expect(commerceChange.safeParse({ ...removed, record: 'order', productId: '12' }).success).toBe(false);
    expect(commerceChange.safeParse({ ...removed, record: 'product', productId: '12', removal: 'cancelled' }).success).toBe(false);
  });
});
