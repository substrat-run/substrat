import { z } from 'zod';
import {
  addDecimal,
  addMoney,
  assertTransition,
  defineLifecycles,
  compareDecimal,
  moneyOf,
  mulDecimal,
  mulMoney,
  manifestEntities,
  moduleManifest,
  permissionKey,
  type EntityRef,
  type Money,
} from '@substrat-run/contracts';
import { shopEntities } from './entities.js';
import {
  assertAllowed,
  PermissionDenied,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The Kallkälla Kaffe vertical (spec/concept.md). A retail domain composed on
// the kernel: catalog + variants + a RESERVATION LEDGER (no-oversell) + cart +
// the checkout PRICING MOMENT that freezes an immutable order and emits a fat
// `commerce.order-placed` event. The invoicing engine consumes that event
// (additive, star topology) to build an invoice basis — engine reuse across a
// different domain than the work-order verticals.
//
// The reservation invariant and the order state machine live as VERTICAL code
// now; they are the extraction seam for a future engine-inventory /
// engine-order at the *second* retail vertical (decision 27), never designed
// ahead. The concurrency claim is honest for the pure-SQLite host: operations
// are strictly serialized per scope (K-6), so "read available, then reserve"
// is atomic by construction — no interleave is possible.
// ============================================================================

export const SHOP_PERM = {
  catalogManage: permissionKey.parse('catalog:manage'),
  stockManage: permissionKey.parse('stock:manage'),
  discountManage: permissionKey.parse('discount:manage'),
  customerManage: permissionKey.parse('customer:manage'),
  orderRead: permissionKey.parse('order:read'),
  orderFulfil: permissionKey.parse('order:fulfil'),
  browse: permissionKey.parse('shop:browse'),
  checkout: permissionKey.parse('cart:checkout'),
};

/** Default hold on a reserved unit — released lazily once elapsed (§6). */
const DEFAULT_HOLD_SECONDS = 900;

export const shopManifest = moduleManifest.parse({
  id: '@substrat-run/demo-shop',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'catalog:manage', description: 'Manage products, variants and publishing' },
    { key: 'stock:manage', description: 'Adjust stock levels' },
    { key: 'discount:manage', description: 'Create and manage discount codes' },
    { key: 'customer:manage', description: 'Manage customer records' },
    { key: 'order:read', description: 'Read orders (admin); portal customers hold an entity-narrowed grant' },
    { key: 'order:fulfil', description: 'Advance an order from placed → fulfilled → closed' },
    { key: 'shop:browse', description: 'Read the published catalogue' },
    { key: 'cart:checkout', description: 'Create a cart, reserve stock and place an order' },
  ],
  events: {
    emits: [{ type: 'commerce.order-placed', schemaVersion: 1 }],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  // Entity names checked against the registry (#697). Both edges —
  // variant → product and order → customer — are DERIVED from the entities'
  // own `parents` rather than restated here.
  ...manifestEntities(shopEntities, {
    attachmentTargets: [
      { entityType: 'product', readPermission: 'shop:browse' },
      { entityType: 'order', readPermission: 'order:read' },
    ],
  }),
  entitlementKey: 'shop',
});

export const shopMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE shop_products (
        id         TEXT PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        origin     TEXT NOT NULL,
        notes      TEXT NOT NULL,
        roast      INTEGER NOT NULL DEFAULT 1,
        published  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE shop_variants (
        id           TEXT PRIMARY KEY,
        product_id   TEXT NOT NULL REFERENCES shop_products(id),
        sku          TEXT NOT NULL UNIQUE,
        grind        TEXT NOT NULL,
        size_label   TEXT NOT NULL,
        price_amount TEXT NOT NULL,
        currency     TEXT NOT NULL DEFAULT 'SEK',
        created_at   TEXT NOT NULL
      );
      CREATE TABLE shop_stock (
        variant_id TEXT PRIMARY KEY REFERENCES shop_variants(id),
        on_hand    INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE shop_customers (
        id         TEXT PRIMARY KEY,
        number     TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        org_ref    TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE shop_discounts (
        code           TEXT PRIMARY KEY,
        kind           TEXT NOT NULL CHECK (kind IN ('pct','fixed')),
        value          TEXT NOT NULL,
        min_spend      TEXT,
        valid_to       TEXT,
        uses_remaining INTEGER,
        currency       TEXT NOT NULL DEFAULT 'SEK',
        created_at     TEXT NOT NULL
      );
      CREATE TABLE shop_carts (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('open','placed','abandoned')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE shop_cart_lines (
        id         TEXT PRIMARY KEY,
        cart_id    TEXT NOT NULL REFERENCES shop_carts(id),
        variant_id TEXT NOT NULL REFERENCES shop_variants(id),
        qty        INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE shop_orders (
        id              TEXT PRIMARY KEY,
        number          INTEGER NOT NULL UNIQUE,
        cart_id         TEXT NOT NULL,
        customer_id     TEXT NOT NULL REFERENCES shop_customers(id),
        owner           TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('placed','fulfilled','closed','cancelled')),
        payment_method  TEXT NOT NULL,
        discount_code   TEXT,
        subtotal_amount TEXT NOT NULL,
        discount_amount TEXT NOT NULL,
        total_amount    TEXT NOT NULL,
        currency        TEXT NOT NULL,
        placed_at       TEXT NOT NULL
      );
      CREATE TABLE shop_order_lines (
        id                TEXT PRIMARY KEY,
        order_id          TEXT NOT NULL REFERENCES shop_orders(id),
        variant_id        TEXT NOT NULL,
        sku               TEXT NOT NULL,
        name              TEXT NOT NULL,
        grind             TEXT NOT NULL,
        size_label        TEXT NOT NULL,
        qty               INTEGER NOT NULL,
        unit_price_amount TEXT NOT NULL,
        line_total_amount TEXT NOT NULL,
        currency          TEXT NOT NULL
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  origin: string;
  notes: string;
  roast: number;
  published: number;
  created_at: string;
}
export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  grind: string;
  size_label: string;
  price_amount: string;
  currency: string;
  created_at: string;
}
export interface OrderRow {
  id: string;
  number: number;
  cart_id: string;
  customer_id: string;
  owner: string;
  status: 'placed' | 'fulfilled' | 'closed' | 'cancelled';
  payment_method: string;
  discount_code: string | null;
  subtotal_amount: string;
  discount_amount: string;
  total_amount: string;
  currency: string;
  placed_at: string;
}
export interface OrderLineRow {
  id: string;
  order_id: string;
  variant_id: string;
  sku: string;
  name: string;
  grind: string;
  size_label: string;
  qty: number;
  unit_price_amount: string;
  line_total_amount: string;
  currency: string;
}

const productRef = (id: string): EntityRef => ({ entityType: 'product', entityId: id });
const variantRef = (id: string): EntityRef => ({ entityType: 'variant', entityId: id });
const orderRef = (id: string): EntityRef => ({ entityType: 'order', entityId: id });
const customerRef = (id: string): EntityRef => ({ entityType: 'customer', entityId: id });

// ---------------------------------------------------------------------------
// The reservation ledger (§6). Available = on_hand − Σ(active reservations),
// where a reservation is a line on an OPEN cart whose hold has not elapsed.
// Expiry is LAZY: elapsed holds are simply excluded here, and swept on the next
// write to the variant. No timer, no cron, no cross-boundary reach.
// ---------------------------------------------------------------------------

function reservedNow(ctx: OperationContext, variantId: string, nowIso: string): number {
  return (
    ctx.sql.query<{ q: number }>(
      `SELECT COALESCE(SUM(l.qty), 0) AS q
         FROM shop_cart_lines l JOIN shop_carts c ON c.id = l.cart_id
        WHERE l.variant_id = ? AND c.status = 'open' AND l.expires_at > ?`,
      [variantId, nowIso],
    )[0]?.q ?? 0
  );
}

function onHand(ctx: OperationContext, variantId: string): number {
  return (
    ctx.sql.query<{ on_hand: number }>('SELECT on_hand FROM shop_stock WHERE variant_id = ?', [
      variantId,
    ])[0]?.on_hand ?? 0
  );
}

function availableQty(ctx: OperationContext, variantId: string, nowIso: string): number {
  return onHand(ctx, variantId) - reservedNow(ctx, variantId, nowIso);
}

/** Opportunistic sweep of elapsed holds for a variant — keeps the ledger tidy. */
function sweepExpired(ctx: OperationContext, variantId: string, nowIso: string): void {
  ctx.sql.exec(
    `DELETE FROM shop_cart_lines
      WHERE variant_id = ? AND expires_at <= ?
        AND cart_id IN (SELECT id FROM shop_carts WHERE status = 'open')`,
    [variantId, nowIso],
  );
}

function getVariant(ctx: OperationContext, variantId: string): VariantRow {
  const v = ctx.sql.query<VariantRow>('SELECT * FROM shop_variants WHERE id = ?', [variantId])[0];
  if (!v) throw new Error(`variant not found: ${variantId}`);
  return v;
}

function requireOwnOpenCart(ctx: OperationContext, cartId: string): { id: string; owner: string } {
  const cart = ctx.sql.query<{ id: string; owner: string; status: string }>(
    'SELECT id, owner, status FROM shop_carts WHERE id = ?',
    [cartId],
  )[0];
  if (!cart) throw new Error(`cart not found: ${cartId}`);
  // Cart isolation is by ownership: the near-zero-privilege shopper reaches
  // exactly its own cart, nobody else's (concept §3).
  if (cart.owner !== ctx.principal) {
    throw new PermissionDenied('permission denied — cart belongs to another shopper');
  }
  if (cart.status !== 'open') throw new Error(`cart ${cartId} is '${cart.status}', not open`);
  return { id: cart.id, owner: cart.owner };
}

// ---------------------------------------------------------------------------
// Catalogue (catalog:manage) + browse (shop:browse)
// ---------------------------------------------------------------------------

const createProductOp: OperationHandler<
  { slug: string; name: string; origin: string; notes: string; roast?: number },
  ProductRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.catalogManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO shop_products (id, slug, name, origin, notes, roast, published, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [id, input.slug, input.name, input.origin, input.notes, input.roast ?? 1, new Date().toISOString()],
  );
  return ctx.sql.query<ProductRow>('SELECT * FROM shop_products WHERE id = ?', [id])[0]!;
};

const addVariantOp: OperationHandler<
  { productId: string; sku: string; grind: string; sizeLabel: string; priceAmount: string; currency?: string },
  VariantRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.catalogManage));
  const product = ctx.sql.query<ProductRow>('SELECT * FROM shop_products WHERE id = ?', [
    input.productId,
  ])[0];
  if (!product) throw new Error(`product not found: ${input.productId}`);
  moneyOf(input.priceAmount, input.currency ?? 'SEK'); // validate money shape at the boundary
  const id = ulid();
  const now = new Date().toISOString();
  ctx.sql.exec(
    `INSERT INTO shop_variants (id, product_id, sku, grind, size_label, price_amount, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, product.id, input.sku, input.grind, input.sizeLabel, input.priceAmount, input.currency ?? 'SEK', now],
  );
  ctx.sql.exec('INSERT INTO shop_stock (variant_id, on_hand, updated_at) VALUES (?, 0, ?)', [id, now]);
  ctx.link(variantRef(id), productRef(product.id));
  return getVariant(ctx, id);
};

const publishProductOp: OperationHandler<{ productId: string; published?: boolean }, ProductRow> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(SHOP_PERM.catalogManage));
  ctx.sql.exec('UPDATE shop_products SET published = ? WHERE id = ?', [
    input.published === false ? 0 : 1,
    input.productId,
  ]);
  const row = ctx.sql.query<ProductRow>('SELECT * FROM shop_products WHERE id = ?', [input.productId])[0];
  if (!row) throw new Error(`product not found: ${input.productId}`);
  return row;
};

const setStockOp: OperationHandler<{ variantId: string; onHand: number }, { variantId: string; onHand: number }> =
  async (ctx, input) => {
    assertAllowed(await ctx.check(SHOP_PERM.stockManage));
    getVariant(ctx, input.variantId);
    const qty = z.number().int().min(0).parse(input.onHand);
    ctx.sql.exec(
      `INSERT INTO shop_stock (variant_id, on_hand, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(variant_id) DO UPDATE SET on_hand = excluded.on_hand, updated_at = excluded.updated_at`,
      [input.variantId, qty, new Date().toISOString()],
    );
    return { variantId: input.variantId, onHand: qty };
  };

interface CatalogVariant {
  id: string;
  sku: string;
  grind: string;
  sizeLabel: string;
  price: Money;
  available: number;
}
interface CatalogProduct extends ProductRow {
  variants: CatalogVariant[];
}

const catalogOp: OperationHandler<{ includeUnpublished?: boolean } | undefined, CatalogProduct[]> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(SHOP_PERM.browse));
  // Drafts are not part of the published catalogue: seeing them is a catalogue
  // author's privilege, not a browser's. Checked here rather than at the route,
  // so the flag cannot be widened by a future caller.
  if (input?.includeUnpublished) assertAllowed(await ctx.check(SHOP_PERM.catalogManage));
  const now = new Date().toISOString();
  const products = input?.includeUnpublished
    ? ctx.sql.query<ProductRow>('SELECT * FROM shop_products ORDER BY name')
    : ctx.sql.query<ProductRow>('SELECT * FROM shop_products WHERE published = 1 ORDER BY name');
  return products.map((p) => ({
    ...p,
    variants: ctx.sql
      .query<VariantRow>('SELECT * FROM shop_variants WHERE product_id = ? ORDER BY size_label', [p.id])
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        grind: v.grind,
        sizeLabel: v.size_label,
        price: moneyOf(v.price_amount, v.currency),
        available: availableQty(ctx, v.id, now),
      })),
  }));
};

interface StockRow {
  productId: string;
  productName: string;
  slug: string;
  published: number;
  variantId: string;
  sku: string;
  grind: string;
  sizeLabel: string;
  price: Money;
  onHand: number;
  reserved: number;
  available: number;
}

/**
 * The warehouse view: on-hand vs reserved, which `shop/catalog` deliberately
 * never exposes — it is browse-gated, and a shopper has no business reading the
 * reservation ledger. Same numbers `add-to-cart` enforces against, so the gap
 * between on-hand and available *is* the live cart holds.
 */
const stockOverviewOp: OperationHandler<undefined, StockRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(SHOP_PERM.stockManage));
  const now = new Date().toISOString();
  const products = ctx.sql.query<ProductRow>('SELECT * FROM shop_products ORDER BY name');
  const rows: StockRow[] = [];
  for (const p of products) {
    const variants = ctx.sql.query<VariantRow>(
      'SELECT * FROM shop_variants WHERE product_id = ? ORDER BY size_label',
      [p.id],
    );
    for (const v of variants) {
      const held = reservedNow(ctx, v.id, now);
      const hand = onHand(ctx, v.id);
      rows.push({
        productId: p.id,
        productName: p.name,
        slug: p.slug,
        published: p.published,
        variantId: v.id,
        sku: v.sku,
        grind: v.grind,
        sizeLabel: v.size_label,
        price: moneyOf(v.price_amount, v.currency),
        onHand: hand,
        reserved: held,
        available: hand - held,
      });
    }
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Customers (customer:manage) + discounts (discount:manage)
// ---------------------------------------------------------------------------

const createCustomerOp: OperationHandler<
  { number: string; name: string; orgRef?: string },
  { id: string; number: string; name: string }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO shop_customers (id, number, name, org_ref, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, input.number, input.name, input.orgRef ?? null, new Date().toISOString()],
  );
  return { id, number: input.number, name: input.name };
};

const createDiscountOp: OperationHandler<
  { code: string; kind: 'pct' | 'fixed'; value: string; minSpend?: string; validTo?: string; uses?: number },
  { code: string; kind: string; value: string }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.discountManage));
  const parsed = z
    .object({
      code: z.string().min(1),
      kind: z.enum(['pct', 'fixed']),
      value: z.string().regex(/^\d+(\.\d{1,6})?$/),
      minSpend: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
      validTo: z.string().optional(),
      uses: z.number().int().positive().optional(),
    })
    .parse(input);
  ctx.sql.exec(
    `INSERT OR REPLACE INTO shop_discounts (code, kind, value, min_spend, valid_to, uses_remaining, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'SEK', ?)`,
    [
      parsed.code.toUpperCase(),
      parsed.kind,
      parsed.value,
      parsed.minSpend ?? null,
      parsed.validTo ?? null,
      parsed.uses ?? null,
      new Date().toISOString(),
    ],
  );
  return { code: parsed.code.toUpperCase(), kind: parsed.kind, value: parsed.value };
};

// ---------------------------------------------------------------------------
// Cart + the reservation writes (cart:checkout)
// ---------------------------------------------------------------------------

const createCartOp: OperationHandler<undefined, { id: string }> = async (ctx) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  const id = ulid();
  ctx.sql.exec('INSERT INTO shop_carts (id, owner, status, created_at) VALUES (?, ?, \'open\', ?)', [
    id,
    ctx.principal,
    new Date().toISOString(),
  ]);
  return { id };
};

const addToCartOp: OperationHandler<
  { cartId: string; variantId: string; qty: number; holdSeconds?: number },
  { lineId: string; reserved: number; availableAfter: number }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  requireOwnOpenCart(ctx, input.cartId);
  const variant = getVariant(ctx, input.variantId);
  const qty = z.number().int().positive().parse(input.qty);
  const now = new Date().toISOString();

  // Sweep elapsed holds first, then check availability atomically (K-6 serializes
  // the whole operation per scope — no other cart can slip in between).
  sweepExpired(ctx, variant.id, now);
  const available = availableQty(ctx, variant.id, now);
  if (available < qty) {
    throw new Error(
      `out of stock: ${variant.sku} — ${available} available, ${qty} requested`,
    );
  }

  const holdSeconds = input.holdSeconds ?? DEFAULT_HOLD_SECONDS;
  const expiresAt = new Date(Date.now() + holdSeconds * 1000).toISOString();

  // Merge into an existing line for this variant so a product shows once; the
  // availability check above already accounts for the current hold, so `qty` is
  // the additional amount either way.
  const existing = ctx.sql.query<{ id: string; qty: number }>(
    'SELECT id, qty FROM shop_cart_lines WHERE cart_id = ? AND variant_id = ?',
    [input.cartId, variant.id],
  )[0];
  let lineId: string;
  if (existing) {
    lineId = existing.id;
    ctx.sql.exec('UPDATE shop_cart_lines SET qty = ?, expires_at = ? WHERE id = ?', [
      existing.qty + qty,
      expiresAt,
      existing.id,
    ]);
  } else {
    lineId = ulid();
    ctx.sql.exec(
      'INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [lineId, input.cartId, variant.id, qty, expiresAt, now],
    );
  }
  return { lineId, reserved: qty, availableAfter: available - qty };
};

/** Set an absolute quantity for a cart line (0 removes it). Increases re-check stock. */
const setLineQtyOp: OperationHandler<
  { cartId: string; lineId: string; qty: number },
  { lineId: string; qty: number; removed: boolean }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  requireOwnOpenCart(ctx, input.cartId);
  const qty = z.number().int().min(0).parse(input.qty);
  const line = ctx.sql.query<{ id: string; variant_id: string; qty: number }>(
    'SELECT id, variant_id, qty FROM shop_cart_lines WHERE id = ? AND cart_id = ?',
    [input.lineId, input.cartId],
  )[0];
  if (!line) throw new Error(`cart line not found: ${input.lineId}`);
  if (qty === 0) {
    ctx.sql.exec('DELETE FROM shop_cart_lines WHERE id = ?', [line.id]);
    return { lineId: line.id, qty: 0, removed: true };
  }
  const now = new Date().toISOString();
  const delta = qty - line.qty;
  if (delta > 0) {
    sweepExpired(ctx, line.variant_id, now);
    const available = availableQty(ctx, line.variant_id, now); // excludes this line's own hold
    if (available < delta) {
      const v = getVariant(ctx, line.variant_id);
      throw new Error(`out of stock: ${v.sku} — ${available} available, ${delta} more requested`);
    }
  }
  const expiresAt = new Date(Date.now() + DEFAULT_HOLD_SECONDS * 1000).toISOString();
  ctx.sql.exec('UPDATE shop_cart_lines SET qty = ?, expires_at = ? WHERE id = ?', [qty, expiresAt, line.id]);
  return { lineId: line.id, qty, removed: false };
};

/** Friendly, shopper-facing reason a discount code did not apply. */
function friendlyDiscountMessage(err: string): string {
  if (err.includes('not found')) return 'Ogiltig rabattkod.';
  if (err.includes('expired')) return 'Rabattkoden har gått ut.';
  if (err.includes('exhausted')) return 'Rabattkoden är förbrukad.';
  if (err.includes('below minimum spend')) return 'Köpet når inte upp till kodens minsta belopp.';
  return 'Rabattkoden kunde inte användas.';
}

/** Priced preview of a cart with an optional discount — the same math as checkout. */
const quoteOp: OperationHandler<
  { cartId: string; discountCode?: string },
  {
    subtotal: Money;
    discount: Money;
    total: Money;
    discountCode: string | null;
    discountValid: boolean;
    message: string | null;
  }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  requireOwnOpenCart(ctx, input.cartId);
  const lines = cartLines(ctx, input.cartId);
  const currency = lines[0]?.unitPrice.currency ?? 'SEK';
  const subtotal = lines.reduce((s, l) => addMoney(s, l.lineTotal), moneyOf('0', currency));

  let discount = moneyOf('0', currency);
  let discountValid = false;
  let discountCode: string | null = null;
  let message: string | null = null;
  const raw = input.discountCode?.trim();
  if (raw) {
    try {
      const r = resolveDiscount(ctx, raw, subtotal, new Date().toISOString().slice(0, 10));
      discount = moneyOf(r.amount, currency);
      discountValid = true;
      discountCode = r.row.code;
    } catch (e) {
      message = friendlyDiscountMessage((e as Error).message);
    }
  }
  const total = moneyOf(addDecimal(subtotal.amount, `-${discount.amount}`), currency);
  return { subtotal, discount, total, discountCode, discountValid, message };
};

const removeLineOp: OperationHandler<{ cartId: string; lineId: string }, { released: boolean }> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  requireOwnOpenCart(ctx, input.cartId);
  const { changes } = ctx.sql.exec('DELETE FROM shop_cart_lines WHERE id = ? AND cart_id = ?', [
    input.lineId,
    input.cartId,
  ]);
  return { released: changes > 0 };
};

interface CartLineView {
  lineId: string;
  variantId: string;
  sku: string;
  name: string;
  grind: string;
  sizeLabel: string;
  qty: number;
  unitPrice: Money;
  lineTotal: Money;
}

function cartLines(ctx: OperationContext, cartId: string): CartLineView[] {
  const rows = ctx.sql.query<{
    id: string;
    variant_id: string;
    qty: number;
    sku: string;
    grind: string;
    size_label: string;
    price_amount: string;
    currency: string;
    name: string;
  }>(
    `SELECT l.id, l.variant_id, l.qty, v.sku, v.grind, v.size_label, v.price_amount, v.currency, p.name
       FROM shop_cart_lines l
       JOIN shop_variants v ON v.id = l.variant_id
       JOIN shop_products p ON p.id = v.product_id
      WHERE l.cart_id = ? ORDER BY l.created_at`,
    [cartId],
  );
  return rows.map((r) => {
    const unitPrice = moneyOf(r.price_amount, r.currency);
    return {
      lineId: r.id,
      variantId: r.variant_id,
      sku: r.sku,
      name: r.name,
      grind: r.grind,
      sizeLabel: r.size_label,
      qty: r.qty,
      unitPrice,
      lineTotal: mulMoney(String(r.qty), unitPrice),
    };
  });
}

const cartOp: OperationHandler<
  { cartId: string },
  { id: string; lines: CartLineView[]; subtotal: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  requireOwnOpenCart(ctx, input.cartId);
  const lines = cartLines(ctx, input.cartId);
  const currency = lines[0]?.unitPrice.currency ?? 'SEK';
  const subtotal = lines.reduce((s, l) => addMoney(s, l.lineTotal), moneyOf('0', currency));
  return { id: input.cartId, lines, subtotal };
};

// ---------------------------------------------------------------------------
// THE PRICING MOMENT (§5): reprice from the catalogue, apply the discount, freeze
// totals onto an immutable order, decrement on_hand, emit the fat event. All one
// transaction (K-16); the discount/price logic is 100% vertical-owned.
// ---------------------------------------------------------------------------

interface DiscountRow {
  code: string;
  kind: 'pct' | 'fixed';
  value: string;
  min_spend: string | null;
  valid_to: string | null;
  uses_remaining: number | null;
  currency: string;
}

function resolveDiscount(
  ctx: OperationContext,
  code: string,
  subtotal: Money,
  today: string,
): { amount: string; row: DiscountRow } {
  const row = ctx.sql.query<DiscountRow>('SELECT * FROM shop_discounts WHERE code = ?', [
    code.toUpperCase(),
  ])[0];
  if (!row) throw new Error(`discount code not found: ${code}`);
  if (row.valid_to && row.valid_to < today) throw new Error(`discount code expired: ${code}`);
  if (row.uses_remaining !== null && row.uses_remaining <= 0)
    throw new Error(`discount code exhausted: ${code}`);
  if (row.min_spend && compareDecimal(subtotal.amount, row.min_spend) < 0)
    throw new Error(`discount code below minimum spend: ${code} needs ${row.min_spend}`);

  let amount =
    row.kind === 'pct'
      ? mulDecimal(subtotal.amount, mulDecimal(row.value, '0.01'))
      : row.value;
  // Never discount below zero.
  if (compareDecimal(amount, subtotal.amount) > 0) amount = subtotal.amount;
  return { amount, row };
}

const checkoutOp: OperationHandler<
  {
    cartId: string;
    customerId: string;
    paymentMethod?: 'invoice' | 'card';
    discountCode?: string;
  },
  { order: OrderRow; lines: OrderLineRow[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.checkout));
  requireOwnOpenCart(ctx, input.cartId);

  // Authorize the buyer: the shopper must be allowed to act for this customer
  // (their entity-narrowed order:read grant, or a node-level admin grant). Without
  // this a shopper could place an invoice order billed to someone else's customer.
  assertAllowed(await ctx.check(SHOP_PERM.orderRead, customerRef(input.customerId)));

  const customer = ctx.sql.query<{ id: string }>('SELECT id FROM shop_customers WHERE id = ?', [
    input.customerId,
  ])[0];
  if (!customer) throw new Error(`customer not found: ${input.customerId}`);

  const lines = cartLines(ctx, input.cartId);
  if (lines.length === 0) throw new Error('cart is empty');
  const currency = lines[0]!.unitPrice.currency;
  // Parse, don't trust: an unknown method would place an order that neither
  // invoices (consumer ignores non-'invoice') nor charges.
  const paymentMethod = z.enum(['invoice', 'card']).parse(input.paymentMethod ?? 'invoice');

  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);

  // Realize the sale against on_hand. Our own reservation guaranteed availability
  // at add time; re-verify on_hand here in case our hold had elapsed and another
  // cart claimed the unit (§6 edge).
  const needed = new Map<string, number>();
  for (const l of lines) needed.set(l.variantId, (needed.get(l.variantId) ?? 0) + l.qty);
  for (const [variantId, qty] of needed) {
    if (onHand(ctx, variantId) < qty) {
      const v = getVariant(ctx, variantId);
      throw new Error(`out of stock: ${v.sku} — reservation elapsed before checkout`);
    }
  }

  const subtotal = lines.reduce((s, l) => addMoney(s, l.lineTotal), moneyOf('0', currency));
  let discountAmount = '0';
  let discountRow: DiscountRow | undefined;
  if (input.discountCode) {
    const resolved = resolveDiscount(ctx, input.discountCode, subtotal, today);
    discountAmount = resolved.amount;
    discountRow = resolved.row;
  }
  const totalAmount = addDecimal(subtotal.amount, `-${discountAmount}`);

  // Decrement stock, create the immutable order.
  for (const [variantId, qty] of needed) {
    ctx.sql.exec('UPDATE shop_stock SET on_hand = on_hand - ?, updated_at = ? WHERE variant_id = ?', [
      qty,
      nowIso,
      variantId,
    ]);
  }

  const orderId = ulid();
  const number =
    ctx.sql.query<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM shop_orders')[0]?.n ?? 1;
  ctx.sql.exec(
    `INSERT INTO shop_orders
       (id, number, cart_id, customer_id, owner, status, payment_method, discount_code,
        subtotal_amount, discount_amount, total_amount, currency, placed_at)
     VALUES (?, ?, ?, ?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      number,
      input.cartId,
      customer.id,
      ctx.principal,
      paymentMethod,
      discountRow?.code ?? null,
      subtotal.amount,
      discountAmount,
      totalAmount,
      currency,
      nowIso,
    ],
  );
  for (const l of lines) {
    ctx.sql.exec(
      `INSERT INTO shop_order_lines
         (id, order_id, variant_id, sku, name, grind, size_label, qty, unit_price_amount, line_total_amount, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        orderId,
        l.variantId,
        l.sku,
        l.name,
        l.grind,
        l.sizeLabel,
        l.qty,
        l.unitPrice.amount,
        l.lineTotal.amount,
        currency,
      ],
    );
  }

  if (discountRow && discountRow.uses_remaining !== null) {
    ctx.sql.exec('UPDATE shop_discounts SET uses_remaining = uses_remaining - 1 WHERE code = ?', [
      discountRow.code,
    ]);
  }

  // Close the cart so its lines stop counting as live reservations.
  ctx.sql.exec("UPDATE shop_carts SET status = 'placed' WHERE id = ?", [input.cartId]);
  ctx.link(orderRef(orderId), customerRef(customer.id));

  // The fat event (concept §7): everything invoicing needs, no cross-module read.
  // A discount line keeps the underlag total net of the discount.
  const billable = lines.map((l) => ({
    article: l.sku,
    description: `${l.name} — ${l.grind}, ${l.sizeLabel}`,
    qty: String(l.qty),
    unit: 'påse',
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  }));
  if (compareDecimal(discountAmount, '0') > 0 && discountRow) {
    const neg = moneyOf(`-${discountAmount}`, currency);
    billable.push({
      article: 'rabatt',
      description: `Rabattkod ${discountRow.code}`,
      qty: '1',
      unit: 'st',
      unitPrice: neg,
      lineTotal: neg,
    });
  }

  ctx.emit({
    type: 'commerce.order-placed',
    schemaVersion: 1,
    entity: orderRef(orderId),
    piiClass: 'none',
    payload: {
      orderId,
      number,
      customer: customerRef(customer.id),
      paymentMethod,
      billable,
      subtotal,
      discount: moneyOf(discountAmount, currency),
      total: moneyOf(totalAmount, currency),
    },
  });

  const order = ctx.sql.query<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [orderId])[0]!;
  const orderLines = ctx.sql.query<OrderLineRow>(
    'SELECT * FROM shop_order_lines WHERE order_id = ? ORDER BY id',
    [orderId],
  );
  return { order, lines: orderLines };
};

// ---------------------------------------------------------------------------
// Orders: admin read/fulfil + the portal proof walk
// ---------------------------------------------------------------------------

const ordersOp: OperationHandler<undefined, OrderRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(SHOP_PERM.orderRead));
  return ctx.sql.query<OrderRow>('SELECT * FROM shop_orders ORDER BY number DESC');
};

const orderOp: OperationHandler<{ orderId: string }, { order: OrderRow; lines: OrderLineRow[] }> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(SHOP_PERM.orderRead, orderRef(input.orderId)));
  const order = ctx.sql.query<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [input.orderId])[0];
  if (!order) throw new Error(`order not found: ${input.orderId}`);
  const lines = ctx.sql.query<OrderLineRow>(
    'SELECT * FROM shop_order_lines WHERE order_id = ? ORDER BY id',
    [input.orderId],
  );
  return { order, lines };
};

/** Portal listing: per-entity proof walks (order → customer), no node-level grant. */
const portalOrdersOp: OperationHandler<undefined, OrderRow[]> = async (ctx) => {
  const all = ctx.sql.query<OrderRow>('SELECT * FROM shop_orders ORDER BY number DESC');
  const visible: OrderRow[] = [];
  for (const order of all) {
    const decision = await ctx.check(SHOP_PERM.orderRead, orderRef(order.id));
    if (decision.allowed) visible.push(order);
  }
  return visible;
};

/** "My account": the customer the caller is authorized to read — their portal identity. */
const myCustomerOp: OperationHandler<undefined, { id: string; number: string; name: string } | null> = async (
  ctx,
) => {
  const all = ctx.sql.query<{ id: string; number: string; name: string }>(
    'SELECT id, number, name FROM shop_customers ORDER BY number',
  );
  for (const c of all) {
    const decision = await ctx.check(SHOP_PERM.orderRead, customerRef(c.id));
    if (decision.allowed) return c;
  }
  return null;
};

/**
 * The declared machine, applied. Named after the VERB, so the legal states are
 * read off the declaration rather than restated at each call site.
 */
function requireTransition(order: OrderRow, operation: string): void {
  assertTransition(shopLifecycles.order, `order ${order.number}`, order.status, operation);
}

const fulfilOrderOp: OperationHandler<{ orderId: string }, OrderRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.orderFulfil));
  const order = ctx.sql.query<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [input.orderId])[0];
  if (!order) throw new Error(`order not found: ${input.orderId}`);
  requireTransition(order, 'shop/fulfil-order');
  ctx.sql.exec("UPDATE shop_orders SET status = 'fulfilled' WHERE id = ?", [order.id]);
  return ctx.sql.query<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [order.id])[0]!;
};

const closeOrderOp: OperationHandler<{ orderId: string }, OrderRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.orderFulfil));
  const order = ctx.sql.query<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [input.orderId])[0];
  if (!order) throw new Error(`order not found: ${input.orderId}`);
  requireTransition(order, 'shop/close-order');
  ctx.sql.exec("UPDATE shop_orders SET status = 'closed' WHERE id = ?", [order.id]);
  return ctx.sql.query<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [order.id])[0]!;
};

/**
 * The registered handlers, extracted so the lifecycle below can be checked
 * against them (#844). Same placement reasoning as `engine-booking`: this map is
 * the only description of the operation surface, so a separate file importing it
 * would close a cycle.
 */
const OPERATIONS = {
    'shop/create-product': createProductOp as never,
    'shop/add-variant': addVariantOp as never,
    'shop/publish-product': publishProductOp as never,
    'shop/set-stock': setStockOp as never,
    'shop/stock-overview': stockOverviewOp as never,
    'shop/catalog': catalogOp as never,
    'shop/create-customer': createCustomerOp as never,
    'shop/create-discount': createDiscountOp as never,
    'shop/create-cart': createCartOp as never,
    'shop/add-to-cart': addToCartOp as never,
    'shop/set-line-qty': setLineQtyOp as never,
    'shop/remove-line': removeLineOp as never,
    'shop/cart': cartOp as never,
    'shop/quote': quoteOp as never,
    'shop/checkout': checkoutOp as never,
    'shop/orders': ordersOp as never,
    'shop/order': orderOp as never,
    'shop/portal-orders': portalOrdersOp as never,
    'shop/my-customer': myCustomerOp as never,
  'shop/fulfil-order': fulfilOrderOp as never,
  'shop/close-order': closeOrderOp as never,
};

export const shopModule: ModuleRegistration = {
  manifest: shopManifest,
  migrations: shopMigrations,
  operations: OPERATIONS,
};

/**
 * The order's state machine, declared (#844).
 *
 * ## The bug this closed
 *
 * Both guards threw a bare `new Error(...)`, so a shopper fulfilling an already-
 * fulfilled order got a **500** where every engine answers **409**. Nothing was
 * red: the scenario test asserted `/invalid transition/`, which a bare `Error`
 * carries just as well as a `conflict` does. Routing the check through
 * `assertTransition` puts this demo back on the platform's error contract, and
 * the message keeps the same prefix.
 *
 * ## `cancelled` is declared and unreachable, deliberately visibly
 *
 * The column admits `cancelled` — it is in the enum and in the migration's
 * `CHECK` — and **nothing in this vertical ever writes it**. Declaring the
 * machine is what surfaced that: `states` must be total over the enum, so the
 * dead state cannot stay invisible. It is left declared rather than quietly
 * dropped, because removing it is a migration and a product decision, and the
 * emitted `model.json` now shows a state with no way in.
 */
export const shopLifecycles = defineLifecycles(
  shopEntities,
  OPERATIONS,
)({
  order: {
    field: 'status',
    initial: 'placed',
    states: {
      placed: { on: { 'shop/fulfil-order': 'fulfilled' } },
      fulfilled: { on: { 'shop/close-order': 'closed' } },
      closed: { terminal: true },
      /** No inbound edge — see above. Not terminal by intent, terminal by neglect. */
      cancelled: { terminal: true },
    },
  },
});
