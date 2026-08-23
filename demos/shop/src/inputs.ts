import { z } from '@substrat-run/contracts';

/**
 * What Shop's operations ACCEPT (#707/#865/#891).
 *
 * These were inline TypeScript object types on the handler signatures.
 * `defineOperations` declares each operation's `input` as a schema, and a
 * declaration file that imports the implementation would close a cycle — so they
 * live below both, the way `entities.ts` and `schemas.ts` do.
 *
 * As in `demos/rally`, these declare the SHAPE; the handlers that did not
 * previously parse still do not. Shop already parses where it matters most
 * (`paymentMethod` goes through `z.enum` at checkout, because an unknown method
 * would place an order that neither invoices nor charges); wiring the rest is a
 * behaviour change to a live demo and is called out in the changeset rather than
 * smuggled in here.
 */

export const createProductInput = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  origin: z.string(),
  notes: z.string(),
  roast: z.number().int().optional(),
});

export const addVariantInput = z.object({
  productId: z.string().min(1),
  sku: z.string().min(1),
  grind: z.string().min(1),
  sizeLabel: z.string().min(1),
  priceAmount: z.string(),
  currency: z.string().optional(),
});

export const publishProductInput = z.object({
  productId: z.string().min(1),
  published: z.boolean().optional(),
});

export const setStockInput = z.object({
  variantId: z.string().min(1),
  onHand: z.number().int().min(0),
});

export const catalogInput = z.object({ includeUnpublished: z.boolean().optional() });

export const createCustomerInput = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  orgRef: z.string().min(1).optional(),
});

export const createDiscountInput = z.object({
  code: z.string().min(1),
  kind: z.enum(['pct', 'fixed']),
  value: z.string(),
  minSpend: z.string().optional(),
  validTo: z.string().optional(),
  uses: z.number().int().optional(),
});

export const cartIdInput = z.object({ cartId: z.string().min(1) });

export const addToCartInput = cartIdInput.extend({
  variantId: z.string().min(1),
  qty: z.number().int().positive(),
  holdSeconds: z.number().int().positive().optional(),
});

export const setLineQtyInput = cartIdInput.extend({
  lineId: z.string().min(1),
  qty: z.number().int().min(0),
});

export const quoteInput = cartIdInput.extend({ discountCode: z.string().min(1).optional() });

export const removeLineInput = cartIdInput.extend({ lineId: z.string().min(1) });

export const checkoutInput = cartIdInput.extend({
  customerId: z.string().min(1),
  paymentMethod: z.enum(['invoice', 'card']).optional(),
  discountCode: z.string().min(1).optional(),
});

export const orderIdInput = z.object({ orderId: z.string().min(1) });
