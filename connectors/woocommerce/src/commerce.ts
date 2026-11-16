import {
  commerceChange,
  compareDecimal,
  instant,
  moneyAmount,
  type CommerceAddress,
  type CommerceOrderUpsert,
  type CommerceProductUpsert,
  type CommerceStock,
  type CommerceStockStatus,
  type CommerceVariant,
  type CurrencyCode,
  type Instant,
  type MoneyAmount,
} from '@substrat-run/contracts';
import type { WcAddress, WcOrder, WcProduct, WcVariation } from './api.js';

/**
 * WooCommerce rows → the provider-neutral commerce shape (`@substrat-run/contracts`,
 * `commerce-source.ts`). Every result is parsed by the contracts schema on the way out, and a value
 * that does not fit is REFUSED with the row it came from named, never reshaped: a price that is not
 * a decimal does not become one by rounding.
 */
export class WooCommerceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WooCommerceMappingError';
  }
}

/** MySQL's zero date, which WordPress stores for "never set" and a REST read can pass on (#3241). */
const ZERO_DATE = /^0000-00-00(?:[T ]00:00:00)?$/;

/**
 * A `_gmt` date as WooCommerce sends it (`2026-11-01T10:00:00`, UTC with no zone), or `null`. The
 * zero date is `null` too: it is how WordPress says "unset", not a date to refuse.
 */
export function gmtInstant(value: string | null, what: string): Instant | null {
  if (value === null || ZERO_DATE.test(value.trim())) return null;
  const parsed = instant.safeParse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  if (!parsed.success) throw new WooCommerceMappingError(`${what}: '${value}' is not a date`);
  return parsed.data;
}

/**
 * When a row last changed — the sync's cursor: its modified date, else its created date when the
 * modified one is unset. A row with neither is refused.
 */
export function modifiedAtOf(row: { id: number; date_modified_gmt: string | null; date_created_gmt: string | null }, what: string): Instant {
  const at =
    gmtInstant(row.date_modified_gmt, `${what} ${row.id} date_modified_gmt`) ??
    gmtInstant(row.date_created_gmt, `${what} ${row.id} date_created_gmt`);
  if (at === null) throw new WooCommerceMappingError(`${what} ${row.id} has neither a modified nor a created date`);
  return at;
}

function amount(value: string, what: string): MoneyAmount {
  const parsed = moneyAmount.safeParse(value.trim());
  if (!parsed.success) throw new WooCommerceMappingError(`${what}: '${value}' is not a decimal amount`);
  return parsed.data;
}

/** A price that may be unset: `''` is no price, anything else must be a decimal. */
function price(value: string, what: string): MoneyAmount | null {
  return value.trim() === '' ? null : amount(value, what);
}

/** The regular price, only when it is above what the variant sells for — i.e. it is on sale. */
function compareAt(regular: string, current: MoneyAmount | null, what: string): MoneyAmount | null {
  const r = price(regular, what);
  return r !== null && current !== null && compareDecimal(r, current) > 0 ? r : null;
}

// A Map, not an object literal: a plugin's status word such as `constructor` must miss, not find
// an inherited key.
const STOCK_STATUS = new Map<string, CommerceStockStatus>([
  ['instock', 'in_stock'],
  ['outofstock', 'out_of_stock'],
  ['onbackorder', 'on_backorder'],
]);

/**
 * Stock as the store reports it on a product or a variation (#3223). Untracked stock has no
 * quantity, whatever the row carries: WooCommerce keeps a stale `stock_quantity` after a merchant
 * stops counting, and it must not arrive as a count. A variation whose product keeps the count
 * (`manage_stock: 'parent'`) reports the product's count, flagged as shared.
 */
function stockOf(row: { manage_stock: boolean | 'parent'; stock_quantity: number | string | null; stock_status: string }, what: string): CommerceStock {
  const manageStock = row.manage_stock !== false;
  let quantity: number | null = null;
  if (manageStock && row.stock_quantity !== null && row.stock_quantity !== '') {
    quantity = typeof row.stock_quantity === 'number' ? row.stock_quantity : Number(row.stock_quantity.trim());
    if (!Number.isFinite(quantity)) throw new WooCommerceMappingError(`${what} stock_quantity: '${row.stock_quantity}' is not a number`);
  }
  return {
    manageStock,
    quantity,
    status: STOCK_STATUS.get(row.stock_status) ?? null,
    providerStatus: row.stock_status,
    sharedWithProduct: row.manage_stock === 'parent',
  };
}

/**
 * A product and, for a `variable` one, its variations. A product WooCommerce sells without
 * variations — a simple product, or a variable one with none yet — lands with ONE variant whose id
 * is the product's, so a vertical never branches on the product type.
 */
export function productChange(
  connectionId: string,
  currency: CurrencyCode,
  row: WcProduct,
  variations: readonly WcVariation[],
): CommerceProductUpsert {
  const what = `product ${row.id}`;
  const variants: CommerceVariant[] =
    variations.length > 0
      ? variations.map((v) => {
          const p = price(v.price, `${what} variation ${v.id} price`);
          const named = v.attributes.filter((a) => a.option !== '');
          return {
            variantId: String(v.id),
            sku: v.sku,
            title: named.length > 0 ? named.map((a) => a.option).join(' / ') : null,
            options: named.map((a) => ({ name: a.name, value: a.option })),
            price: p,
            compareAtPrice: compareAt(v.regular_price, p, `${what} variation ${v.id} regular_price`),
            stock: stockOf(v, `${what} variation ${v.id}`),
          };
        })
      : [
          (() => {
            const p = price(row.price, `${what} price`);
            return {
              variantId: String(row.id),
              sku: row.sku,
              title: null,
              options: [],
              price: p,
              compareAtPrice: compareAt(row.regular_price, p, `${what} regular_price`),
              stock: stockOf(row, what),
            };
          })(),
        ];
  return commerceChange.parse({
    record: 'product',
    change: 'upsert',
    connectionId,
    productId: String(row.id),
    name: row.name,
    slug: row.slug,
    url: row.permalink,
    listed: row.status === 'publish',
    providerStatus: row.status,
    currency,
    variants,
    createdAt: gmtInstant(row.date_created_gmt, `${what} date_created_gmt`),
    modifiedAt: modifiedAtOf(row, 'product'),
  }) as CommerceProductUpsert;
}

function address(a: WcAddress | null): CommerceAddress | null {
  if (a === null) return null;
  const mapped: CommerceAddress = {
    firstName: a.first_name,
    lastName: a.last_name,
    company: a.company,
    line1: a.address_1,
    line2: a.address_2,
    city: a.city,
    region: a.state,
    postalCode: a.postcode,
    country: a.country,
  };
  // WooCommerce sends an empty shipping address as every field `''`: that is no address.
  return Object.values(mapped).every((v) => v.trim() === '') ? null : mapped;
}

export function orderChange(connectionId: string, row: WcOrder): CommerceOrderUpsert {
  const what = `order ${row.id}`;
  return commerceChange.parse({
    record: 'order',
    change: 'upsert',
    connectionId,
    orderId: String(row.id),
    number: row.number ?? String(row.id),
    providerStatus: row.status,
    paidAt: gmtInstant(row.date_paid_gmt, `${what} date_paid_gmt`),
    cancelled: row.status === 'cancelled',
    // The order's own currency: WooCommerce records it per order, and a multi-currency plugin may
    // make it differ from the store's.
    currency: row.currency.toUpperCase(),
    total: amount(row.total, `${what} total`),
    taxTotal: amount(row.total_tax, `${what} total_tax`),
    shippingTotal: amount(row.shipping_total, `${what} shipping_total`),
    discountTotal: amount(row.discount_total, `${what} discount_total`),
    customer: {
      customerId: row.customer_id > 0 ? String(row.customer_id) : null,
      email: row.billing?.email ?? null,
      firstName: row.billing?.first_name ?? '',
      lastName: row.billing?.last_name ?? '',
      phone: row.billing?.phone ?? null,
    },
    billingAddress: address(row.billing),
    shippingAddress: address(row.shipping),
    lines: row.line_items.map((l) => {
      if (!Number.isInteger(l.quantity)) throw new WooCommerceMappingError(`${what} line ${l.id}: quantity ${l.quantity} is not whole`);
      return {
        lineId: String(l.id),
        productId: l.product_id,
        // A line that sold a variation names it; one that sold a simple product names the
        // product, which is the id its only variant carries.
        variantId: l.variation_id ?? l.product_id,
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        subtotal: amount(l.subtotal, `${what} line ${l.id} subtotal`),
        total: amount(l.total, `${what} line ${l.id} total`),
        tax: amount(l.total_tax, `${what} line ${l.id} total_tax`),
      };
    }),
    customerNote: row.customer_note,
    createdAt: gmtInstant(row.date_created_gmt, `${what} date_created_gmt`),
    modifiedAt: modifiedAtOf(row, 'order'),
  }) as CommerceOrderUpsert;
}
