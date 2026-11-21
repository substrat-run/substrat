import type { MockOrder, MockProduct } from '../src/mock.js';

/**
 * A small shop, written the way Shopify's GraphQL answers it: global ids, money as decimal strings
 * in `presentmentMoney`, `null` for what is unset, and "Default Title" for the one variant of a
 * product sold without options. Two products change in the same second, on purpose. Prices include
 * Swedish VAT (25 %), as a Swedish shop's do.
 */
export const NOW = Date.parse('2026-11-10T12:00:00Z');

export const gid = (type: string, id: number): string => `gid://shopify/${type}/${id}`;

export const variant = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: gid('ProductVariant', id),
  sku: `SKU-${id}`,
  title: 'Default Title',
  price: '100.00',
  compareAtPrice: null,
  selectedOptions: [{ name: 'Title', value: 'Default Title' }],
  inventoryQuantity: 0,
  inventoryPolicy: 'DENY',
  inventoryItem: { tracked: false },
  ...over,
});

export const product = (id: number, updatedAt: string, over: Partial<MockProduct> = {}): MockProduct => ({
  id: gid('Product', id),
  title: `Product ${id}`,
  handle: `product-${id}`,
  status: 'ACTIVE',
  onlineStoreUrl: `https://shop.acme.example/products/product-${id}`,
  hasOnlyDefaultVariant: true,
  createdAt: '2026-10-01T08:00:00Z',
  updatedAt,
  variants: [variant(id * 10 + 1)],
  ...over,
});

const size = (id: number, value: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  variant(id, { sku: `TS-${value}`, title: value, selectedOptions: [{ name: 'Size', value }], ...over });

export const PRODUCTS = (): MockProduct[] => [
  product(11, '2026-11-01T10:00:00Z', {
    title: 'Mugg Åre',
    variants: [variant(111, { sku: 'MUG-1', price: '129.00', compareAtPrice: '149.00', inventoryQuantity: 7, inventoryItem: { tracked: true } })],
  }),
  product(12, '2026-11-01T10:00:00Z', {
    title: 'T-shirt',
    hasOnlyDefaultVariant: false,
    variants: [
      size(121, 'M', { price: '199.00', inventoryQuantity: 30, inventoryItem: { tracked: true } }),
      size(122, 'L', { price: '219.50', compareAtPrice: '249.00', inventoryQuantity: 0, inventoryPolicy: 'CONTINUE', inventoryItem: { tracked: true } }),
    ],
  }),
  product(13, '2026-11-01T11:00:00Z', { title: 'Presentkort', status: 'DRAFT', onlineStoreUrl: null, variants: [variant(131, { sku: null, price: '500.00' })] }),
];

const sek = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'SEK' } });

export const address = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  firstName: 'Anna',
  lastName: 'Svensson',
  company: null,
  address1: 'Storgatan 1',
  address2: null,
  city: 'Åre',
  province: null,
  provinceCode: null,
  zip: '837 52',
  countryCodeV2: 'SE',
  phone: null,
  ...over,
});

export const line = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: gid('LineItem', id),
  name: `Line ${id}`,
  sku: null,
  quantity: 1,
  product: null,
  variant: null,
  originalTotalSet: sek('100.00'),
  discountAllocations: [],
  taxLines: [{ rate: 0.25, priceSet: sek('20.00') }],
  ...over,
});

export const order = (id: number, updatedAt: string, over: Partial<MockOrder> = {}): MockOrder => ({
  id: gid('Order', id),
  name: `#${id}`,
  createdAt: '2026-11-02T09:00:00Z',
  updatedAt,
  processedAt: '2026-11-02T09:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PENDING',
  taxesIncluded: true,
  presentmentCurrencyCode: 'SEK',
  email: 'anna@example.com',
  phone: null,
  note: null,
  customer: { id: gid('Customer', 77) },
  billingAddress: address(),
  shippingAddress: null,
  totalPriceSet: sek('100.00'),
  totalTaxSet: sek('20.00'),
  totalShippingPriceSet: sek('0.00'),
  totalDiscountsSet: sek('0.00'),
  transactions: [],
  lineItems: [line(id * 10 + 1)],
  ...over,
});

/**
 * Order 501 sells two mugs (no discount) and one T-shirt in L (19.50 off), plus a custom line the
 * catalogue does not hold; it is paid. Order 502 was cancelled before payment.
 */
export const ORDERS = (): MockOrder[] => [
  order(501, '2026-11-02T09:05:00Z', {
    displayFinancialStatus: 'PAID',
    note: 'Ring på dörren',
    totalPriceSet: sek('557.00'),
    totalTaxSet: sek('101.60'),
    totalShippingPriceSet: sek('49.00'),
    totalDiscountsSet: sek('19.50'),
    shippingAddress: address({ address1: 'Fjällvägen 3' }),
    transactions: [
      { kind: 'AUTHORIZATION', status: 'SUCCESS', processedAt: '2026-11-02T09:00:30Z' },
      { kind: 'CAPTURE', status: 'SUCCESS', processedAt: '2026-11-02T09:01:00Z' },
    ],
    lineItems: [
      line(5011, { name: 'Mugg Åre', sku: 'MUG-1', quantity: 2, product: { id: gid('Product', 11) }, variant: { id: gid('ProductVariant', 111) }, originalTotalSet: sek('258.00'), taxLines: [{ rate: 0.25, priceSet: sek('51.60') }] }),
      line(5012, {
        name: 'T-shirt - L',
        sku: 'TS-L',
        product: { id: gid('Product', 12) },
        variant: { id: gid('ProductVariant', 122) },
        originalTotalSet: sek('219.50'),
        discountAllocations: [{ allocatedAmountSet: sek('19.50') }],
        taxLines: [{ rate: 0.25, priceSet: sek('40.00') }],
      }),
      line(5013, { name: 'Presentinslagning', originalTotalSet: sek('50.00'), taxLines: [{ rate: 0.25, priceSet: sek('10.00') }] }),
    ],
  }),
  order(502, '2026-11-03T08:00:00Z', {
    cancelledAt: '2026-11-03T08:00:00Z',
    displayFinancialStatus: 'VOIDED',
    lineItems: [line(5021, { product: { id: gid('Product', 11) }, variant: { id: gid('ProductVariant', 111) }, originalTotalSet: sek('129.00'), taxLines: [{ rate: 0.25, priceSet: sek('25.80') }] })],
  }),
];
