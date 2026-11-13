import type { MockRow } from '../src/mock.js';

/**
 * A small store, written the way WooCommerce sends it: money as strings, `''` for a blank, explicit
 * `null`s, `_gmt` dates without a zone, and a local `date_modified` an hour ahead of the GMT one so
 * a filter on the wrong column shows. Two products change in the same second, on purpose.
 */
const address = (over: Record<string, unknown> = {}) => ({
  first_name: '',
  last_name: '',
  company: '',
  address_1: '',
  address_2: '',
  city: '',
  state: '',
  postcode: '',
  country: '',
  ...over,
});

const local = (gmt: string): string => {
  const d = new Date(`${gmt}Z`);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 19);
};

export const product = (id: number, modified: string, over: Record<string, unknown> = {}): MockRow => ({
  id,
  name: `Product ${id}`,
  slug: `product-${id}`,
  permalink: `https://shop.example.com/product/product-${id}/`,
  type: 'simple',
  status: 'publish',
  sku: `SKU-${id}`,
  price: '100.00',
  regular_price: '100.00',
  sale_price: '',
  on_sale: false,
  manage_stock: false,
  stock_quantity: null,
  variations: [],
  date_created_gmt: '2026-10-01T08:00:00',
  date_modified: local(modified),
  date_modified_gmt: modified,
  ...over,
});

export const PRODUCTS = (): MockRow[] => [
  product(11, '2026-11-01T10:00:00', { name: 'Mugg Åre', sku: 'MUG-1', price: '129.00', regular_price: '149.00', sale_price: '129.00', on_sale: true }),
  product(12, '2026-11-01T10:00:00', { name: 'T-shirt', type: 'variable', sku: '', price: '199.00', regular_price: '', variations: [121, 122] }),
  product(13, '2026-11-01T11:00:00', { name: 'Presentkort', status: 'draft', sku: null, price: '', regular_price: '' }),
];

export const VARIATIONS = (): Record<number, Record<string, unknown>[]> => ({
  12: [
    { id: 121, sku: 'TS-M', price: '199.00', regular_price: '199.00', sale_price: '', manage_stock: 'parent', attributes: [{ id: 1, name: 'Size', option: 'M' }] },
    { id: 122, sku: 'TS-L', price: '219.50', regular_price: '249.00', sale_price: '219.50', manage_stock: true, attributes: [{ id: 1, name: 'Size', option: 'L' }] },
  ],
});

export const order = (id: number, modified: string, over: Record<string, unknown> = {}): MockRow => ({
  id,
  number: String(id),
  status: 'processing',
  currency: 'SEK',
  prices_include_tax: true,
  discount_total: '0.00',
  shipping_total: '49.00',
  total: '100.00',
  total_tax: '20.00',
  customer_id: 7,
  customer_note: '',
  billing: address({ first_name: 'Åsa', last_name: 'Ångström', address_1: 'Storgatan 1', city: 'Umeå', postcode: '903 26', country: 'SE', email: 'asa@example.com', phone: '' }),
  shipping: address({ first_name: 'Åsa', last_name: 'Ångström', address_1: 'Storgatan 1', city: 'Umeå', postcode: '903 26', country: 'SE' }),
  date_created_gmt: '2026-11-02T08:00:00',
  date_modified: local(modified),
  date_modified_gmt: modified,
  date_paid_gmt: '2026-11-02T08:05:00',
  date_completed_gmt: null,
  line_items: [],
  ...over,
});

const line = (id: number, productId: number | string, variationId: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `Line ${id}`,
  product_id: productId,
  variation_id: variationId,
  quantity: 1,
  tax_class: '',
  subtotal: '80.00',
  subtotal_tax: '20.00',
  total: '80.00',
  total_tax: '20.00',
  sku: '',
  // A NUMBER in WooCommerce's schema, and never read: money is read from the string fields.
  price: 80.0001,
  ...over,
});

export const ORDERS = (): MockRow[] => [
  order(501, '2026-11-02T09:00:00', {
    total: '546.25',
    total_tax: '109.25',
    discount_total: '10.00',
    line_items: [
      line(1, 11, 0, { name: 'Mugg Åre', quantity: 2, sku: 'MUG-1', subtotal: '206.40', total: '206.40', total_tax: '51.60' }),
      // product_id as a string: WooCommerce declares it "mixed".
      line(2, '12', 122, { name: 'T-shirt - L', sku: 'TS-L', subtotal: '175.60', total: '167.60', total_tax: '43.90' }),
    ],
  }),
  order(502, '2026-11-02T09:30:00', {
    status: 'cancelled',
    customer_id: 0,
    date_paid_gmt: null,
    customer_note: 'Ring innan leverans',
    shipping: address(),
    line_items: [line(3, 11, 0)],
  }),
  order(503, '2026-11-02T09:45:00', { status: 'checkout-draft', date_paid_gmt: null }),
  order(504, '2026-11-02T10:00:00', { line_items: [line(4, 0, 0, { name: 'Frakttillägg' })] }),
];
