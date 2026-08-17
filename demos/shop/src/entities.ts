import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * Shop's entities (#697). Four of nine tables — carts, cart lines, order lines
 * and discounts are rows this vertical owns, never the subject of an `EntityRef`.
 */
export const shopEntities = defineEntities({
  customer: {
    table: 'shop_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      org_ref: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['number'],
    // A retail customer is a private person unless org_ref says otherwise.
    erasable: ['name'],
  },
  product: {
    table: 'shop_products',
    fields: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      origin: z.string(),
      notes: z.string(),
      roast: z.number(),
      published: z.number(),
      created_at: z.string(),
    }),
    key: ['slug'],
  },
  variant: {
    table: 'shop_variants',
    fields: z.object({
      id: z.string(),
      product_id: z.string(),
      sku: z.string(),
      grind: z.string(),
      size_label: z.string(),
      price_amount: z.string(),
      currency: z.string(),
      created_at: z.string(),
    }),
    parents: ['product'],
    key: ['sku'],
  },
  order: {
    table: 'shop_orders',
    fields: z.object({
      id: z.string(),
      number: z.number(),
      cart_id: z.string(),
      customer_id: z.string(),
      owner: z.string(),
      status: z.enum(['placed', 'fulfilled', 'closed', 'cancelled']),
      payment_method: z.string(),
      discount_code: z.string().nullable(),
      subtotal_amount: z.string(),
      discount_amount: z.string(),
      total_amount: z.string(),
      currency: z.string(),
      placed_at: z.string(),
    }),
    parents: ['customer'],
  },
});

export const shopModel = emitModel(shopEntities);
