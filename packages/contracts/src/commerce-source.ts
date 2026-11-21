import { z } from 'zod';
import { instant } from './ids.js';
import { currencyCode, moneyAmount } from './money.js';

/**
 * Commerce-source vocabulary (#3136): what a vertical sees of an online store, whichever store
 * platform it runs on.
 *
 * A commerce source is a connector whose far side is a shop: products with their variants, and the
 * orders placed for them. WooCommerce and Shopify both land it (`connectors/woocommerce`,
 * `connectors/shopify`), and `commerceSourceSuite` in `@substrat-run/contract-tests` is the behaviour
 * the two share. A vertical codes against these names, so swapping one store platform for another keeps
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
 * - **A removal is reported only for an id that was delivered**, and is as safe to repeat as an
 *   upsert. It says the record left the store; what that means (archive, hide, keep for the books)
 *   is the vertical's to decide. A record that comes back (restored from the trash) arrives as an
 *   upsert again.
 * - **Money is a decimal string with its currency.** Never a float, and never reshaped: a provider
 *   amount that is not a decimal is refused by the connector rather than rounded into one.
 * - **Every product has at least one variant.** A product sold without variants lands with exactly
 *   one, untitled and picked by no option, so a vertical prices, stocks and sells variants and
 *   never branches on the platform. Its id is the store's to give: the product's own where the
 *   store has no variant row (a WooCommerce simple product), the store's default variant's where
 *   it has one (Shopify). A vertical keys on `variantId` and never assumes either.
 * - **Stock is read-only and per variant** (#3223), as the store last reported it with the
 *   product: whether the store tracks it, how many, and in stock / out / on backorder. Where a
 *   store keeps one count for the whole product (`sharedWithProduct`), every variant reports that
 *   count, so a vertical must not add them up. Writing stock back is a later shape.
 * - **An order line names the variant it sold**, by the same id a product change carries, or
 *   `null` when the line sold nothing the catalogue holds (a custom line, a deleted product).
 *
 * What is NOT here, by decision:
 *
 *  * - **Fulfilment, refunds and customers as records of their own.** An order carries the customer it
 *   was placed by, as the order states it; a customer register is a later shape.
 * - **Write requests** (set stock, mark an order fulfilled) and a shared `CommerceSource` facet. The
 *   second store platform now exists, so both are extracted from the two connectors when a vertical
 *   first needs them, rather than designed ahead of that.
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

/** Whether a variant can be sold now, in the store's terms. */
export const commerceStockStatus = z.enum(['in_stock', 'out_of_stock', 'on_backorder']);
export type CommerceStockStatus = z.infer<typeof commerceStockStatus>;

/**
 * A variant's stock as the store reports it (#3223).
 *
 * `manageStock` false means the store does not count it: `quantity` is then `null`, never `0`, and
 * `status` is whatever the merchant set by hand. `status` is `null` when the store's word is none of
 * the three (a plugin's own); `providerStatus` keeps the word either way.
 */
export const commerceStock = z
  .object({
    manageStock: z.boolean(),
    /** How many the store holds; may be negative on backorder, and fractional on some platforms. */
    quantity: z.number().nullable(),
    status: commerceStockStatus.nullable(),
    providerStatus: z.string(),
    /** One count for the whole product, reported on each of its variants: never sum them. */
    sharedWithProduct: z.boolean(),
  })
  .refine((s) => s.manageStock || s.quantity === null, { message: 'a stock the store does not track has no quantity', path: ['quantity'] });
export type CommerceStock = z.infer<typeof commerceStock>;

/** One sellable variant of a product. */
export const commerceVariant = z.object({
  /**
   * The variant's id at the store. For a product without variants, whatever id the store gives its
   * only variant: the product's own on WooCommerce, the default variant's on Shopify.
   */
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
  /**
   * The variant's stock (#3223). Optional because it was added after the shape shipped: a source
   * that reads no stock leaves it out; the WooCommerce and Shopify connectors always send it.
   */
  stock: commerceStock.optional(),
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
 * How a record left the store. `trashed`: moved to the store's trash, from which it can still be
 * restored (and then arrives as an upsert again). `deleted`: gone for good. A cancelled or refunded
 * order is neither — that is a status, carried on the order's upsert.
 */
export const commerceRemoval = z.enum(['trashed', 'deleted']);
export type CommerceRemoval = z.infer<typeof commerceRemoval>;

const removedFields = {
  change: z.literal('removed'),
  connectionId: z.string().min(1),
  removal: commerceRemoval,
  /**
   * When the connector saw it gone — not when it went, which a store does not record for a delete.
   * A later upsert of the same id (`modifiedAt` after this) means it came back.
   */
  observedAt: instant,
};

/** A product that left the store (#3224), by the `productId` its upserts carried. */
export const commerceProductRemoved = z.object({
  record: z.literal('product'),
  productId: z.string().min(1),
  ...removedFields,
});
export type CommerceProductRemoved = z.infer<typeof commerceProductRemoved>;

/** An order that left the store (#3224), by the `orderId` its upserts carried. */
export const commerceOrderRemoved = z.object({
  record: z.literal('order'),
  orderId: z.string().min(1),
  ...removedFields,
});
export type CommerceOrderRemoved = z.infer<typeof commerceOrderRemoved>;

/**
 * What a sync lands through the binding's operation, one record per invoke — parsed with this
 * schema on the way out, so a vertical compiled against one version of a connector gets a throw
 * rather than a reshaped record from another. `record` says which kind; `change` says whether it is
 * the record as it now stands (`upsert`) or a report that it left the store (`removed`, #3224).
 */
export const commerceChange = z.discriminatedUnion('record', [
  z.discriminatedUnion('change', [commerceProductUpsert, commerceProductRemoved]),
  z.discriminatedUnion('change', [commerceOrderUpsert, commerceOrderRemoved]),
]);
export type CommerceChange = z.infer<typeof commerceChange>;
