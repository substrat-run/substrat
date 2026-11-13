import {
  commerceChange,
  compareDecimal,
  instant,
  moneyAmount,
  type CommerceAddress,
  type CommerceOrderUpsert,
  type CommerceProductUpsert,
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

/** A `_gmt` date as WooCommerce sends it (`2026-11-01T10:00:00`, UTC with no zone), or `null`. */
export function gmtInstant(value: string | null, what: string): Instant | null {
  if (value === null) return null;
  const parsed = instant.safeParse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  if (!parsed.success) throw new WooCommerceMappingError(`${what}: '${value}' is not a date`);
  return parsed.data;
}

/** When a row last changed — the sync's cursor. A row with no date at all is refused. */
export function modifiedAtOf(row: { id: number; date_modified_gmt: string | null; date_created_gmt: string | null }, what: string): Instant {
  const at = gmtInstant(row.date_modified_gmt ?? row.date_created_gmt, `${what} ${row.id} date_modified_gmt`);
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
