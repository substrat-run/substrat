import { z } from 'zod';
import { instant } from './ids.js';
import { currencyCode, moneyAmount } from './money.js';

/**
 * Commerce-source vocabulary (#3136): what a vertical sees of an online store, whichever store
 * platform it runs on.
 *
 * A commerce source is a connector whose far side is a shop: products with their variants, and the
 * orders placed for them. The first is WooCommerce; Shopify is the second this vocabulary is checked
 * against. A vertical codes against these names, so swapping one store platform for another keeps
 * its landing operation, its tables and the schemas it parses. The CONNECTION is still the
 * provider's (its credential, its probe, its binding), and so is any event type a later write
 * travels under: the type is what routes a delivery to a provider's connector, so a neutral type
 * could not say which one to run.
 *
 * One shape crosses today, {@link commerceChange}, landed through the vertical's own operation, one
 * product or one order per invoke. The invariants a provider's sync loop holds, which no schema
 * here can:
 *
 * - **Delivery is at least once, keyed by the provider's id.** A landing operation upserts by
 *   `productId` or `orderId` and may see the same change twice, or an older change after a newer
 *   one was retried. `modifiedAt` is what tells them apart.
 * - **Money is a decimal string with its currency.** Never a float, and never reshaped: a provider
 *   amount that is not a decimal is refused by the connector rather than rounded into one.
 * - **Every product has at least one variant.** A store platform that sells a product without
 *   variants (a WooCommerce simple product) lands it with one variant whose id is the product's,
 *   so a vertical prices, stocks and sells variants and never branches on the platform.
 * - **An order line names the variant it sold**, by the same id a product change carries, or
 *   `null` when the line sold nothing the catalogue holds (a custom line, a deleted product).
 *
 * What is NOT here, by decision:
 *
 * - **Deletes.** A store's "changed since" listing does not list what was deleted, so a delete
 *   needs its own signal; `change` is a discriminator so it can be added without a bump.
 * - **Stock levels.** Stock moves on every sale, is shared between variants on some platforms and
 *   fractional on others, and wants its own shape and its own freshness rule.
 * - **Fulfilment, refunds and customers as records of their own.** An order carries the customer it
 *   was placed by, as the order states it; a customer register is a later shape.
 * - **Write requests** (set stock, mark an order fulfilled) and the shared `CommerceSource` facet:
 *   both wait for a second store platform, so they are extracted from two implementations rather
 *   than designed from one.
 *
 * An order carries personal data (a name, an email address, postal addresses). A vertical that
 * lands it declares those columns as such.
 */

/** A postal address as an order states it. Blank parts are `''`, not absent. */
export const commerceAddress = z.object({
  firstName: z.string(),
  lastName: z.string(),
  company: z.string(),
  line1: z.string(),
  line2: z.string(),
  city: z.string(),
  /** State, county or province — a code or a name, as the store recorded it. */
  region: z.string(),
  postalCode: z.string(),
  /** ISO 3166-1 alpha-2 where the store records one; `''` when it does not. */
  country: z.string(),
});
export type CommerceAddress = z.infer<typeof commerceAddress>;

/** One option a variant is picked by, e.g. `{ name: 'Size', value: 'M' }`. */
export const commerceVariantOption = z.object({ name: z.string(), value: z.string() });

/** One sellable variant of a product. */
export const commerceVariant = z.object({
  /** The variant's id at the store. For a product without variants, the product's own id. */
  variantId: z.string().min(1),
  sku: z.string().nullable(),
  /** A label for the variant, when the store gives one; `null` for a product's only variant. */
  title: z.string().nullable(),
  options: z.array(commerceVariantOption),
  /** What the variant sells for now, in the product's currency. `null` when the store has no price set. */
  price: moneyAmount.nullable(),
  /**
   * The higher price `price` is shown against when the variant is on sale, or `null`. Only set when
   * it is greater than `price`, so a vertical can show it struck through without comparing.
   */
  compareAtPrice: moneyAmount.nullable(),
});
export type CommerceVariant = z.infer<typeof commerceVariant>;

/**
 * A product as it now stands at the store, with every variant it sells.
 *
 * `listed` is the one fact a vertical branches on for visibility: the product is published for sale
 * (WooCommerce `publish`, Shopify `active`). `providerStatus` is the store's own word for display;
 * branching on it binds a vertical to one platform.
 */
export const commerceProductUpsert = z.object({
  record: z.literal('product'),
  change: z.literal('upsert'),
  connectionId: z.string().min(1),
  /** The product's id at the store — the stable key. */
  productId: z.string().min(1),
  name: z.string(),
  slug: z.string().nullable(),
  /** The product's public page, when it has one. */
  url: z.string().nullable(),
  listed: z.boolean(),
  providerStatus: z.string(),
  /** The currency every price on this product is in: the store's, since a product states none. */
  currency: currencyCode,
  variants: z.array(commerceVariant).min(1),
  createdAt: instant.nullable(),
  modifiedAt: instant,
});
export type CommerceProductUpsert = z.infer<typeof commerceProductUpsert>;

/** One line of an order. */
export const commerceOrderLine = z.object({
  lineId: z.string().min(1),
  /** The product sold, or `null` for a line the catalogue does not hold. */
  productId: z.string().nullable(),
  /** The variant sold, by the id its product change carries, or `null` as for `productId`. */
  variantId: z.string().nullable(),
  sku: z.string().nullable(),
  /** The line's name as it was sold — kept, since the product may since have been renamed. */
  name: z.string(),
  quantity: z.number().int(),
  /** Before discounts, excluding tax. */
  subtotal: moneyAmount,
  /** After discounts, excluding tax. */
  total: moneyAmount,
  /** The tax on `total`. */
  tax: moneyAmount,
});
export type CommerceOrderLine = z.infer<typeof commerceOrderLine>;

/**
 * An order as it now stands at the store.
 *
 * `paidAt` and `cancelled` are the two facts a vertical branches on; `providerStatus` is the
 * store's own word for display. `total` is what was charged, tax and shipping included. The
 * breakdown (`taxTotal`, `shippingTotal`, `discountTotal`) is the store's, and is not promised to
 * sum to `total` under one rule across platforms: a vertical that needs it to reconciles it itself.
 */
export const commerceOrderUpsert = z.object({
  record: z.literal('order'),
  change: z.literal('upsert'),
  connectionId: z.string().min(1),
  /** The order's id at the store — the stable key. */
  orderId: z.string().min(1),
  /** The order number a customer sees, which need not be the id. */
  number: z.string(),
  providerStatus: z.string(),
  paidAt: instant.nullable(),
  cancelled: z.boolean(),
  currency: currencyCode,
  total: moneyAmount,
  taxTotal: moneyAmount,
  shippingTotal: moneyAmount,
  discountTotal: moneyAmount,
  customer: z.object({
    /** The customer's account at the store, or `null` for a guest checkout. */
    customerId: z.string().nullable(),
    email: z.string().nullable(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string().nullable(),
  }),
  billingAddress: commerceAddress.nullable(),
  shippingAddress: commerceAddress.nullable(),
  lines: z.array(commerceOrderLine),
  customerNote: z.string().nullable(),
  createdAt: instant.nullable(),
  modifiedAt: instant,
});
export type CommerceOrderUpsert = z.infer<typeof commerceOrderUpsert>;

/**
 * What a sync lands through the binding's operation, one record per invoke — parsed with this
 * schema on the way out, so a vertical compiled against one version of a connector gets a throw
 * rather than a reshaped record from another. `record` says which; `change` is `upsert` for both
 * today (see "What is NOT here").
 */
export const commerceChange = z.discriminatedUnion('record', [commerceProductUpsert, commerceOrderUpsert]);
export type CommerceChange = z.infer<typeof commerceChange>;
