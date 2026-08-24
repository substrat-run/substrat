import { money, z } from '@substrat-run/contracts';
import { shopEntities } from './entities.js';

/**
 * What Shop's operations ANSWER, as schemas (#707/#865/#891).
 *
 * These were nine hand-written interfaces in `module.ts`. They became schemas
 * because `defineOperations` declares an operation's `output`, and a TypeScript
 * interface cannot be one.
 *
 * The four that back a DECLARED entity are derived from the registry rather than
 * restated — `shop_products`, `shop_variants`, `shop_orders` and `shop_customers`
 * are described once, in `entities.ts`, and a column added there reaches the
 * published row without anyone remembering to. The rest are projections over
 * tables this vertical owns that are deliberately not entities (`entities.ts`
 * says why: carts, cart lines, order lines and discounts are never the subject of
 * an `EntityRef`).
 *
 * `module.ts` re-exports every type below, so nothing that imported a row shape
 * from there had to change.
 */

export const productRow = shopEntities.product.fields;
export type ProductRow = z.infer<typeof productRow>;

export const variantRow = shopEntities.variant.fields;
export type VariantRow = z.infer<typeof variantRow>;

export const orderRow = shopEntities.order.fields;
export type OrderRow = z.infer<typeof orderRow>;

export const customerRow = shopEntities.customer.fields;
export type CustomerRow = z.infer<typeof customerRow>;

/** The customer as the portal answers it — the record without its bookkeeping. */
export const customerView = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
});

export const orderLineRow = z.object({
  id: z.string(),
  order_id: z.string(),
  variant_id: z.string(),
  sku: z.string(),
  name: z.string(),
  grind: z.string(),
  size_label: z.string(),
  qty: z.number(),
  unit_price_amount: z.string(),
  line_total_amount: z.string(),
  currency: z.string(),
});
export type OrderLineRow = z.infer<typeof orderLineRow>;

export const catalogVariant = z.object({
  id: z.string(),
  sku: z.string(),
  grind: z.string(),
  sizeLabel: z.string(),
  price: money,
  available: z.number(),
});
export type CatalogVariant = z.infer<typeof catalogVariant>;

export const catalogProduct = productRow.extend({ variants: z.array(catalogVariant) });
export type CatalogProduct = z.infer<typeof catalogProduct>;

export const stockRow = z.object({
  productId: z.string(),
  productName: z.string(),
  slug: z.string(),
  published: z.number(),
  variantId: z.string(),
  sku: z.string(),
  grind: z.string(),
  sizeLabel: z.string(),
  price: money,
  onHand: z.number(),
  reserved: z.number(),
  available: z.number(),
});
export type StockRow = z.infer<typeof stockRow>;

export const cartLineView = z.object({
  lineId: z.string(),
  variantId: z.string(),
  sku: z.string(),
  name: z.string(),
  grind: z.string(),
  sizeLabel: z.string(),
  qty: z.number(),
  unitPrice: money,
  lineTotal: money,
});
export type CartLineView = z.infer<typeof cartLineView>;

export const discountRow = z.object({
  code: z.string(),
  kind: z.enum(['pct', 'fixed']),
  value: z.string(),
  min_spend: z.string().nullable(),
  valid_to: z.string().nullable(),
  uses_remaining: z.number().nullable(),
  currency: z.string(),
});
export type DiscountRow = z.infer<typeof discountRow>;
