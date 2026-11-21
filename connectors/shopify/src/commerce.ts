import {
  commerceChange,
  compareDecimal,
  instant,
  moneyAmount,
  type CommerceAddress,
  type CommerceOrderUpsert,
  type CommerceProductUpsert,
  type CommerceStock,
  type CommerceVariant,
  type CurrencyCode,
  type Instant,
  type MoneyAmount,
} from '@substrat-run/contracts';
import { idOfGid, type ShopifyAddress, type ShopifyLineItem, type ShopifyOrder, type ShopifyProduct, type ShopifyVariant } from './api.js';

/**
 * Shopify rows → the provider-neutral commerce shape (`@substrat-run/contracts`,
 * `commerce-source.ts`). Every result is parsed by the contracts schema on the way out, and a value
 * that does not fit is REFUSED with the row it came from named, never reshaped.
 *
 * Where Shopify and the shape differ, the reading is:
 *
 * - **Ids** are the number at the end of Shopify's global id (`gid://shopify/Product/123` → `123`),
 *   the id a merchant sees in the admin's URLs. A product's single variant keeps its own id: Shopify
 *   always has a variant row, so unlike WooCommerce the product's id is never borrowed for it.
 * - **A product sold without options** (`hasOnlyDefaultVariant`) lands its one variant untitled and
 *   picked by no option, rather than as Shopify's "Default Title" / `Title: Default Title`.
 * - **Stock** is the variant's count summed over every location. Shopify has no stock-status word,
 *   so `status` is derived: untracked is `in_stock` (Shopify sells it regardless), a positive count
 *   is `in_stock`, and at zero or below the inventory policy decides — `CONTINUE` keeps selling, a
 *   backorder, `DENY` is `out_of_stock`. `providerStatus` is `untracked`, or the policy word.
 * - **An order's money** is in the currency the customer paid in (`presentmentMoney`), as
 *   WooCommerce's order currency is. A product's prices are in the shop's currency.
 * - **Line amounts exclude tax**, as the shape says. Where the shop's prices include tax
 *   (`taxesIncluded`, the norm in Sweden and the EU), Shopify's line amounts include it, so the line's
 *   tax is subtracted — exactly, from Shopify's own tax lines. One figure cannot be had by
 *   subtraction: the pre-discount subtotal of a DISCOUNTED line in such a shop, whose tax Shopify
 *   does not state. It is the original amount divided by one plus the line's tax rates, rounded half
 *   to even at the amount's own precision (two decimals at least). It is the only derived amount.
 * - **`paidAt`**: Shopify records no paid-at time on an order. An order whose financial status says
 *   it was paid (`PAID`, `PARTIALLY_REFUNDED`, `REFUNDED`) is paid at its last successful sale or
 *   capture, else at the time it was processed; any other order is unpaid.
 */
export class ShopifyMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyMappingError';
  }
}

/** A Shopify timestamp (`2026-11-01T10:00:00Z`), or `null`. */
export function shopifyInstant(value: string | null, what: string): Instant | null {
  if (value === null) return null;
  const parsed = instant.safeParse(value);
  if (!parsed.success) throw new ShopifyMappingError(`${what}: '${value}' is not a date`);
  return parsed.data;
}

/** When a row last changed — the sync's cursor. */
export function updatedAtOf(row: { id: string; updatedAt: string }, what: string): Instant {
  const at = shopifyInstant(row.updatedAt, `${what} ${row.id} updatedAt`);
  if (at === null) throw new ShopifyMappingError(`${what} ${row.id} has no updatedAt`);
  return at;
}

/** The numeric id of a global id of `type`, as the shape's string key. */
function idOf(gid: string, type: string, what: string): string {
  const id = idOfGid(gid, type);
  if (id === null) throw new ShopifyMappingError(`${what}: '${gid}' is not a Shopify ${type} id`);
  return String(id);
}

// ---------------------------------------------------------------------------------------------
// Exact decimals. Shopify sends `Decimal` and `Money` as strings; these never pass through a float.
// ---------------------------------------------------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;

interface Dec {
  units: bigint;
  scale: number;
}

function dec(value: string, what: string): Dec {
  const v = value.trim();
  if (!DECIMAL.test(v)) throw new ShopifyMappingError(`${what}: '${value}' is not a decimal amount`);
  const negative = v.startsWith('-');
  const [int, frac = ''] = (negative ? v.slice(1) : v).split('.');
  const units = BigInt(`${int}${frac}`);
  return { units: negative ? -units : units, scale: frac.length };
}

function rescale(d: Dec, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

function text(d: Dec): string {
  const negative = d.units < 0n;
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, '0');
  const out = d.scale === 0 ? digits : `${digits.slice(0, -d.scale)}.${digits.slice(-d.scale)}`;
  return `${negative ? '-' : ''}${out}`;
}

function sum(values: readonly Dec[]): Dec {
  const scale = Math.max(0, ...values.map((v) => v.scale));
  return { units: values.reduce((acc, v) => acc + rescale(v, scale), 0n), scale };
}

function minus(a: Dec, b: Dec): Dec {
  return sum([a, { units: -b.units, scale: b.scale }]);
}

/** `a / (1 + rate)`, rounded half to even at `max(a's scale, 2)` decimals. */
function exclusiveOf(a: Dec, rate: Dec): Dec {
  const scale = Math.max(a.scale, 2);
  // a / (1 + r) = a·10^rs / (10^rs + r·...) with r = rate.units / 10^rs.
  const divisor = 10n ** BigInt(rate.scale) + rate.units;
  if (divisor <= 0n) throw new ShopifyMappingError(`a tax rate of ${text(rate)} cannot be taken out of a price`);
  const numerator = rescale(a, scale) * 10n ** BigInt(rate.scale);
  let q = numerator / divisor;
  const r = numerator % divisor;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice > divisor || (twice === divisor && q % 2n !== 0n)) q += numerator < 0n ? -1n : 1n;
  return { units: q, scale };
}

function amount(d: Dec, what: string): MoneyAmount {
  // At most six decimals, as the shape takes; a provider amount finer than that is refused.
  const parsed = moneyAmount.safeParse(text(d));
  if (!parsed.success) throw new ShopifyMappingError(`${what}: '${text(d)}' is not a money amount the shape takes`);
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

function stockOf(v: ShopifyVariant, what: string): CommerceStock {
  const tracked = v.inventoryItem.tracked;
  if (!tracked) return { manageStock: false, quantity: null, status: 'in_stock', providerStatus: 'untracked', sharedWithProduct: false };
  const quantity = v.inventoryQuantity;
  if (quantity !== null && !Number.isInteger(quantity)) throw new ShopifyMappingError(`${what} inventoryQuantity: ${quantity} is not whole`);
  const policy = v.inventoryPolicy.toUpperCase();
  return {
    manageStock: true,
    quantity,
    status: quantity !== null && quantity > 0 ? 'in_stock' : policy === 'CONTINUE' ? 'on_backorder' : 'out_of_stock',
    providerStatus: policy.toLowerCase(),
    sharedWithProduct: false,
  };
}

/** A product and every one of its variants (the first page with the row, and the rest read after). */
export function productChange(connectionId: string, currency: CurrencyCode, row: ShopifyProduct, variants: readonly ShopifyVariant[]): CommerceProductUpsert {
  const productId = idOf(row.id, 'Product', 'product');
  const what = `product ${productId}`;
  if (variants.length === 0) throw new ShopifyMappingError(`${what} has no variant: Shopify gives every product one`);
  const mapped: CommerceVariant[] = variants.map((v) => {
    const variantId = idOf(v.id, 'ProductVariant', `${what} variant`);
    const at = `${what} variant ${variantId}`;
    const price = v.price === null ? null : dec(v.price, `${at} price`);
    const compare = v.compareAtPrice === null ? null : dec(v.compareAtPrice, `${at} compareAtPrice`);
    const priceAmount = price === null ? null : amount(price, `${at} price`);
    const compareAmount = compare === null ? null : amount(compare, `${at} compareAtPrice`);
    const options = v.selectedOptions.filter((o) => o.value !== '');
    return {
      variantId,
      sku: v.sku,
      title: row.hasOnlyDefaultVariant || v.title === '' ? null : v.title,
      options: row.hasOnlyDefaultVariant ? [] : options.map((o) => ({ name: o.name, value: o.value })),
      price: priceAmount,
      compareAtPrice: compareAmount !== null && priceAmount !== null && compareDecimal(compareAmount, priceAmount) > 0 ? compareAmount : null,
      stock: stockOf(v, at),
    };
  });
  return commerceChange.parse({
    record: 'product',
    change: 'upsert',
    connectionId,
    productId,
    name: row.title,
    slug: row.handle,
    url: row.onlineStoreUrl,
    listed: row.status.toUpperCase() === 'ACTIVE',
    providerStatus: row.status.toLowerCase(),
    currency,
    variants: mapped,
    createdAt: shopifyInstant(row.createdAt, `${what} createdAt`),
    modifiedAt: updatedAtOf(row, 'product'),
  }) as CommerceProductUpsert;
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

function address(a: ShopifyAddress | null): CommerceAddress | null {
  if (a === null) return null;
  const mapped: CommerceAddress = {
    firstName: a.firstName,
    lastName: a.lastName,
    company: a.company,
    line1: a.address1,
    line2: a.address2,
    city: a.city,
    region: a.provinceCode || a.province,
    postalCode: a.zip,
    country: a.countryCodeV2,
  };
  return Object.values(mapped).every((v) => v.trim() === '') ? null : mapped;
}

const PAID = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);

function paidAtOf(row: ShopifyOrder, what: string): Instant | null {
  if (!PAID.has(row.displayFinancialStatus.toUpperCase())) return null;
  const settled = row.transactions
    .filter((t) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS' && t.processedAt !== null)
    .map((t) => shopifyInstant(t.processedAt, `${what} transaction processedAt`)!)
    .sort();
  return settled.at(-1) ?? shopifyInstant(row.processedAt ?? row.createdAt, `${what} processedAt`);
}

export function orderChange(connectionId: string, row: ShopifyOrder, lines: readonly ShopifyLineItem[]): CommerceOrderUpsert {
  const orderId = idOf(row.id, 'Order', 'order');
  const what = `order ${orderId}`;
  const currency = row.presentmentCurrencyCode.toUpperCase();
  /** A money field, held to the order's currency: one in another is refused, never converted. */
  const money = (m: { presentmentMoney: { amount: string; currencyCode: string } } | null, field: string): Dec => {
    if (m === null) return { units: 0n, scale: 0 };
    if (m.presentmentMoney.currencyCode.toUpperCase() !== currency) {
      throw new ShopifyMappingError(`${what} ${field}: in ${m.presentmentMoney.currencyCode}, but the order is in ${currency}`);
    }
    return dec(m.presentmentMoney.amount, `${what} ${field}`);
  };
  const buyer = row.billingAddress ?? row.shippingAddress;
  return commerceChange.parse({
    record: 'order',
    change: 'upsert',
    connectionId,
    orderId,
    number: row.name || orderId,
    providerStatus: row.displayFinancialStatus.toLowerCase(),
    paidAt: paidAtOf(row, what),
    cancelled: row.cancelledAt !== null,
    currency,
    total: amount(money(row.totalPriceSet, 'totalPriceSet'), `${what} total`),
    taxTotal: amount(money(row.totalTaxSet, 'totalTaxSet'), `${what} taxTotal`),
    shippingTotal: amount(money(row.totalShippingPriceSet, 'totalShippingPriceSet'), `${what} shippingTotal`),
    discountTotal: amount(money(row.totalDiscountsSet, 'totalDiscountsSet'), `${what} discountTotal`),
    customer: {
      customerId: row.customer === null ? null : idOf(row.customer.id, 'Customer', `${what} customer`),
      email: row.email,
      firstName: buyer?.firstName ?? '',
      lastName: buyer?.lastName ?? '',
      phone: row.phone ?? row.billingAddress?.phone ?? null,
    },
    billingAddress: address(row.billingAddress),
    shippingAddress: address(row.shippingAddress),
    lines: lines.map((l) => {
      const lineId = idOf(l.id, 'LineItem', `${what} line`);
      const at = `${what} line ${lineId}`;
      if (!Number.isInteger(l.quantity)) throw new ShopifyMappingError(`${at}: quantity ${l.quantity} is not whole`);
      const original = money(l.originalTotalSet, `line ${lineId} originalTotalSet`);
      const discount = sum([{ units: 0n, scale: 0 }, ...l.discountAllocations.map((d) => money(d.allocatedAmountSet, `line ${lineId} discount`))]);
      const tax = sum([{ units: 0n, scale: 0 }, ...l.taxLines.map((t) => money(t.priceSet, `line ${lineId} tax`))]);
      const discounted = minus(original, discount);
      let subtotal = original;
      let total = discounted;
      if (row.taxesIncluded) {
        total = minus(discounted, tax);
        if (discount.units === 0n) subtotal = total;
        else {
          const rates = l.taxLines.map((t) => {
            if (t.rate === null) throw new ShopifyMappingError(`${at}: a tax line states no rate, so its pre-discount price cannot be taken out of tax`);
            return dec(t.rate, `${at} tax rate`);
          });
          subtotal = exclusiveOf(original, sum([{ units: 0n, scale: 0 }, ...rates]));
        }
      }
      return {
        lineId,
        productId: l.product === null ? null : idOf(l.product.id, 'Product', `${at} product`),
        variantId: l.variant === null ? null : idOf(l.variant.id, 'ProductVariant', `${at} variant`),
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        subtotal: amount(subtotal, `${at} subtotal`),
        total: amount(total, `${at} total`),
        tax: amount(tax, `${at} tax`),
      };
    }),
    customerNote: row.note,
    createdAt: shopifyInstant(row.createdAt, `${what} createdAt`),
    modifiedAt: updatedAtOf(row, 'order'),
  }) as CommerceOrderUpsert;
}
