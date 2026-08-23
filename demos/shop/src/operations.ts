/**
 * Shop's declared operation surface (#707/#865/#891).
 *
 * Twenty-one handlers registered as `'shop/checkout': checkoutOp as never`, and
 * the only description of what each one checked was its body. Four of those
 * checks narrow to an entity, and `entityCheckConformanceSuite` derives its
 * behavioural pair from an operation's `permission` — so undeclared, they were
 * not merely untested but **undeclarable**.
 *
 * ## `permission` names ONE key, and two of these operations check two
 *
 * **`shop/checkout`** opens with the node gate `cart:checkout`, then narrows
 * `order:read` to the customer being billed. Its own comment says what the second
 * check is for: *"Without this a shopper could place an invoice order billed to
 * someone else's customer."* That is the fail-open bug the conformance kit exists
 * to catch — and the kit **cannot reach it**, which is worth writing down rather
 * than working around.
 *
 * The kit's probe holds nothing scope-wide, by design: that is what makes its
 * case 1 able to tell an entity check from a node check at all. So the probe
 * fails `cart:checkout` on the first line and never arrives at the narrowed
 * check. `alsoGrant` does not help either — it grants NARROWED to the target
 * entity, and a narrowed grant deliberately does not widen to satisfy a node
 * check (`permission-suite`: *"No node-level access"*).
 *
 * So a narrowed check sitting BEHIND a node gate is outside this kit's reach, and
 * declaring the narrowed one here would only produce a red suite that says the
 * handler is broken when it is not. This declares the gate it opens with, as
 * Meridian's `hr/issue-employment-contract` does, and the second check is stated
 * here instead. It is the same underlying gap in both: an operation has one
 * `permission` and may check several.
 *
 * **`shop/catalog`** is a third variation: it opens with `shop:browse` and checks
 * `catalog:manage` only when the caller asks for drafts. That second check is
 * conditional on an optional input, so — as with Meridian's `hr/list-projects` —
 * declaring it would claim a gate that a caller omitting the flag does not pass.
 * It declares `shop:browse`.
 *
 * ## The two per-row walks
 *
 * `shop/portal-orders` and `shop/my-customer` ask per row rather than once, so
 * they declare `narrows`. The scenario's portal-isolation beat is what proves
 * them; a single entity check is not what they do.
 */
import { defineOperations, money, z } from '@substrat-run/contracts';
import { shopEntities } from './entities.js';
import {
  addToCartInput,
  addVariantInput,
  cartIdInput,
  catalogInput,
  checkoutInput,
  createCustomerInput,
  createDiscountInput,
  createProductInput,
  orderIdInput,
  publishProductInput,
  quoteInput,
  removeLineInput,
  setLineQtyInput,
  setStockInput,
} from './inputs.js';
import {
  cartLineView,
  catalogProduct,
  customerView,
  orderLineRow,
  orderRow,
  productRow,
  stockRow,
  variantRow,
} from './schemas.js';

/** The keys these operations check. Mirrors `SHOP_PERM` in module.ts. */
export const SHOP_PERMISSIONS = [
  'catalog:manage',
  'stock:manage',
  'discount:manage',
  'customer:manage',
  'order:read',
  'order:fulfil',
  'shop:browse',
  'cart:checkout',
] as const;

const orderDetail = z.object({ order: orderRow, lines: z.array(orderLineRow) });

export const shopOperations = defineOperations(shopEntities, SHOP_PERMISSIONS)({
  // --- catalogue ------------------------------------------------------------
  'shop/create-product': {
    summary: 'Create a product',
    permission: 'catalog:manage',
    input: createProductInput,
    output: productRow,
  },
  'shop/add-variant': {
    summary: 'Add a variant to a product',
    permission: 'catalog:manage',
    input: addVariantInput,
    output: variantRow,
  },
  'shop/publish-product': {
    summary: 'Publish or unpublish a product',
    permission: 'catalog:manage',
    input: publishProductInput,
    output: productRow,
  },
  'shop/set-stock': {
    summary: 'Set a variant’s on-hand stock',
    permission: 'stock:manage',
    input: setStockInput,
    output: z.object({ variantId: z.string(), onHand: z.number() }),
  },
  'shop/catalog': {
    summary: 'The catalogue, published unless drafts are asked for',
    // Opens with browse; the draft flag adds a `catalog:manage` check — see the
    // header for why that one is not what this declares.
    permission: 'shop:browse',
    input: catalogInput,
    inputOptional: true,
    output: catalogProduct,
    paged: {
      over: { entity: 'product', sortable: ['name', 'slug', 'created_at'], filterable: ['published'] },
    },
  },
  'shop/stock-overview': {
    summary: 'Stock across every variant',
    permission: 'stock:manage',
    output: stockRow,
    // A join across products, variants and live reservations, so the handler owns
    // its own query. `variantId` is unique among the rows.
    paged: { sortKey: 'variantId' },
  },

  // --- customers & discounts ------------------------------------------------
  'shop/create-customer': {
    summary: 'Create a customer record',
    permission: 'customer:manage',
    input: createCustomerInput,
    output: customerView,
  },
  'shop/create-discount': {
    summary: 'Create a discount code',
    permission: 'discount:manage',
    input: createDiscountInput,
    output: z.object({ code: z.string(), kind: z.string(), value: z.string() }),
  },

  // --- cart -----------------------------------------------------------------
  'shop/create-cart': {
    summary: 'Open a cart',
    permission: 'cart:checkout',
    output: z.object({ id: z.string() }),
  },
  'shop/add-to-cart': {
    summary: 'Add a variant to the cart, reserving stock',
    permission: 'cart:checkout',
    input: addToCartInput,
    output: z.object({
      lineId: z.string(),
      reserved: z.number(),
      availableAfter: z.number(),
    }),
  },
  'shop/set-line-qty': {
    summary: 'Change a cart line’s quantity',
    permission: 'cart:checkout',
    input: setLineQtyInput,
    output: z.object({ lineId: z.string(), qty: z.number(), removed: z.boolean() }),
  },
  'shop/quote': {
    summary: 'Price the cart, with a discount code if given',
    permission: 'cart:checkout',
    input: quoteInput,
    output: z.object({
      subtotal: money,
      discount: money,
      total: money,
      discountCode: z.string().nullable(),
      discountValid: z.boolean(),
      message: z.string().nullable(),
    }),
  },
  'shop/remove-line': {
    summary: 'Remove a cart line and release its reservation',
    permission: 'cart:checkout',
    input: removeLineInput,
    output: z.object({ released: z.boolean() }),
  },
  'shop/cart': {
    summary: 'The cart as it stands',
    permission: 'cart:checkout',
    input: cartIdInput,
    output: z.object({
      id: z.string(),
      lines: z.array(cartLineView),
      subtotal: money,
    }),
  },
  'shop/checkout': {
    summary: 'Place the order',
    // The gate it opens with. It then narrows `order:read` to the customer being
    // billed — the check that stops a shopper billing someone else, and the one
    // the conformance kit cannot reach from behind this gate. See the header.
    permission: 'cart:checkout',
    input: checkoutInput,
    output: orderDetail,
  },

  // --- orders ---------------------------------------------------------------
  'shop/orders': {
    summary: 'Every order (staff)',
    permission: 'order:read',
    output: orderRow,
    paged: {
      over: { entity: 'order', sortable: ['number', 'placed_at'], filterable: ['status', 'customer_id'] },
      order: 'desc',
    },
  },
  'shop/order': {
    summary: 'One order with its lines',
    permission: { key: 'order:read', entity: 'order', idFrom: 'orderId' },
    input: orderIdInput,
    output: orderDetail,
  },
  'shop/portal-orders': {
    summary: 'The caller’s own orders',
    narrows: {
      reason: 'walks every order and asks per row, so a portal customer sees only their own',
      checks: ['order:read'],
    },
    output: orderRow,
    // Newest first, as this list shipped. Ids are ULIDs, so an `id` walk is the
    // `number` walk without a second column to break ties on.
    paged: { sortKey: 'id', order: 'desc' },
  },
  'shop/my-customer': {
    summary: 'The customer record the caller may act for',
    narrows: {
      reason: 'walks the customers and returns the first the caller holds a grant on',
      checks: ['order:read'],
    },
    output: customerView.nullable(),
  },
  'shop/fulfil-order': {
    summary: 'Advance an order to fulfilled',
    permission: 'order:fulfil',
    input: orderIdInput,
    output: orderRow,
  },
  'shop/close-order': {
    summary: 'Close a fulfilled order',
    permission: 'order:fulfil',
    input: orderIdInput,
    output: orderRow,
  },
});
