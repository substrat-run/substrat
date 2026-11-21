import { describe, expect, it } from 'vitest';
import { currencyCode } from '@substrat-run/contracts';
import { shopifyOrder, shopifyProduct } from '../src/api.js';
import { orderChange, productChange } from '../src/commerce.js';
import { ORDERS, PRODUCTS, gid, line, order, product, variant } from './fixture.js';

/**
 * Mapping refuses rather than reshapes, as WooCommerce's does. The fixtures are rows as the mock's
 * changed list answers them, so the nested pages are written out here.
 */
const SEK = currencyCode.parse('SEK');
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const productRow = (p: ReturnType<typeof product>) => shopifyProduct.parse({ ...p, variants: page(p.variants) });
const orderRow = (o: ReturnType<typeof order>) => shopifyOrder.parse({ ...o, lineItems: page(o.lineItems) });
const mapProduct = (p: ReturnType<typeof product>) => {
  const row = productRow(p);
  return productChange('c1', SEK, row, row.variants.nodes);
};
const mapOrder = (o: ReturnType<typeof order>) => {
  const row = orderRow(o);
  return orderChange('c1', row, row.lineItems.nodes);
};

describe('shopify → commerce mapping', () => {
  it("lands a product sold without options with one untitled variant that keeps Shopify's own variant id", () => {
    const change = mapProduct(PRODUCTS()[0]!);
    expect(change).toMatchObject({ productId: '11', name: 'Mugg Åre', slug: 'product-11', listed: true, providerStatus: 'active' });
    // Not the product's id, as WooCommerce's would be: Shopify has a variant row of its own.
    expect(change.variants).toEqual([
      {
        variantId: '111',
        sku: 'MUG-1',
        title: null,
        options: [],
        price: '129.00',
        compareAtPrice: '149.00',
        stock: { manageStock: true, quantity: 7, status: 'in_stock', providerStatus: 'deny', sharedWithProduct: false },
      },
    ]);
  });

  it('derives stock status from the count and the inventory policy, and untracked stock as always in stock', () => {
    const shirt = mapProduct(PRODUCTS()[1]!);
    expect(shirt.variants.map((v) => [v.variantId, v.title, v.options, v.stock?.status, v.compareAtPrice])).toEqual([
      ['121', 'M', [{ name: 'Size', value: 'M' }], 'in_stock', null],
      ['122', 'L', [{ name: 'Size', value: 'L' }], 'on_backorder', '249.00'],
    ]);
    const gift = mapProduct(PRODUCTS()[2]!);
    expect(gift).toMatchObject({ listed: false, providerStatus: 'draft', url: null });
    expect(gift.variants[0]?.stock).toEqual({ manageStock: false, quantity: null, status: 'in_stock', providerStatus: 'untracked', sharedWithProduct: false });
    const soldOut = mapProduct(product(14, '2026-11-01T10:00:00Z', { variants: [variant(141, { inventoryItem: { tracked: true }, inventoryQuantity: -2 })] }));
    expect(soldOut.variants[0]?.stock).toMatchObject({ quantity: -2, status: 'out_of_stock' });
  });

  it('takes tax out of a tax-inclusive order exactly, deriving only the pre-discount subtotal of a discounted line', () => {
    const change = mapOrder(ORDERS()[0]!);
    expect(change).toMatchObject({
      orderId: '501',
      number: '#501',
      providerStatus: 'paid',
      // The capture, not the authorization before it.
      paidAt: '2026-11-02T09:01:00.000Z',
      cancelled: false,
      currency: 'SEK',
      total: '557.00',
      taxTotal: '101.60',
      shippingTotal: '49.00',
      discountTotal: '19.50',
      customer: { customerId: '77', email: 'anna@example.com', firstName: 'Anna', lastName: 'Svensson', phone: null },
      customerNote: 'Ring på dörren',
    });
    expect(change.shippingAddress).toMatchObject({ line1: 'Fjällvägen 3', country: 'SE', region: '' });
    expect(change.lines.map((l) => [l.lineId, l.productId, l.variantId, l.quantity, l.subtotal, l.total, l.tax])).toEqual([
      ['5011', '11', '111', 2, '206.40', '206.40', '51.60'],
      // 219.50 / 1.25 = 175.60 before the discount; 200.00 − 40.00 after it.
      ['5012', '12', '122', 1, '175.60', '160.00', '40.00'],
      // A custom line: nothing in the catalogue to name.
      ['5013', null, null, 1, '40.00', '40.00', '10.00'],
    ]);
  });

  it('keeps line amounts as they are where prices exclude tax, and rounds a derived subtotal half to even', () => {
    const excl = mapOrder(order(503, '2026-11-02T09:00:00Z', { taxesIncluded: false, lineItems: [line(5031, { originalTotalSet: { presentmentMoney: { amount: '100.00', currencyCode: 'SEK' } }, discountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: '10.00', currencyCode: 'SEK' } } }], taxLines: [{ rate: 0.25, priceSet: { presentmentMoney: { amount: '22.50', currencyCode: 'SEK' } } }] })] }));
    expect(excl.lines[0]).toMatchObject({ subtotal: '100.00', total: '90.00', tax: '22.50' });
    // 10.00 / 1.12 = 8.928… → 8.93.
    const incl = mapOrder(order(504, '2026-11-02T09:00:00Z', { lineItems: [line(5041, { originalTotalSet: { presentmentMoney: { amount: '10.00', currencyCode: 'SEK' } }, discountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: '1.00', currencyCode: 'SEK' } } }], taxLines: [{ rate: 0.12, priceSet: { presentmentMoney: { amount: '0.96', currencyCode: 'SEK' } } }] })] }));
    expect(incl.lines[0]).toMatchObject({ subtotal: '8.93', total: '8.04', tax: '0.96' });
  });

  it('is paid at the last successful sale or capture, however many transactions come before it', () => {
    const earlier = Array.from({ length: 11 }, (_, i) => ({ kind: i % 2 === 0 ? 'AUTHORIZATION' : 'SALE', status: i % 2 === 0 ? 'SUCCESS' : 'FAILURE', processedAt: `2026-11-02T09:${String(i).padStart(2, '0')}:00Z` }));
    const change = mapOrder(order(508, '2026-11-02T10:00:00Z', { displayFinancialStatus: 'PAID', transactions: [...earlier, { kind: 'CAPTURE', status: 'SUCCESS', processedAt: '2026-11-02T09:30:00Z' }] }));
    expect(change.paidAt).toBe('2026-11-02T09:30:00.000Z');
  });

  it('marks a cancelled, unpaid order as such', () => {
    expect(mapOrder(ORDERS()[1]!)).toMatchObject({ cancelled: true, paidAt: null, providerStatus: 'voided' });
  });

  it.each([
    ['a price that is not a decimal', () => mapProduct(product(1, '2026-11-01T10:00:00Z', { variants: [variant(11, { price: '1e3' })] })), /price: '1e3' is not a decimal/],
    ['an id of another type', () => mapProduct(product(1, '2026-11-01T10:00:00Z', { id: gid('Collection', 1) })), /is not a Shopify Product id/],
    ['a product with no variant', () => mapProduct(product(1, '2026-11-01T10:00:00Z', { variants: [] })), /has no variant/],
    ['a line in another currency than its order', () => mapOrder(order(505, '2026-11-02T09:00:00Z', { lineItems: [line(5051, { originalTotalSet: { presentmentMoney: { amount: '10.00', currencyCode: 'EUR' } } })] })), /in EUR, but the order is in SEK/],
    ['a quantity that is not whole', () => mapOrder(order(506, '2026-11-02T09:00:00Z', { lineItems: [line(5061, { quantity: 1.5 })] })), /quantity 1.5 is not whole/],
    ['a discounted tax-inclusive line with no rate', () => mapOrder(order(507, '2026-11-02T09:00:00Z', { lineItems: [line(5071, { discountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: '1.00', currencyCode: 'SEK' } } }], taxLines: [{ rate: null, priceSet: { presentmentMoney: { amount: '19.80', currencyCode: 'SEK' } } }] })] })), /states no rate/],
  ])('refuses %s', (_, map, error) => {
    expect(map).toThrow(error);
  });
});
