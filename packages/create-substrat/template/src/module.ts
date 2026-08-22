import {
  addDecimal,
  compareDecimal,
  moneyOf,
  mulMoney,
  pageVisible,
  z,
  type EntityRef,
  type Money,
  type Page,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationHandler,
  type PageParams,
} from '@substrat-run/kernel';
import {
  closeWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  getReportedLines,
  listOrders,
  PERM as WO,
  type BillableLine,
  type WorkOrder,
} from '@substrat-run/engine-workorder';
import { bikeShopManifest, SHOP_PERM } from './manifest.js';
import { bikeShopMigrations } from './migrations.js';

// ============================================================================
// The bike-shop operations. Each is either:
//   - a thin custodian of the vertical's own tables (customers, bikes, prices),
//     OR
//   - a COMPOSITION that wraps an engine's in-scope function inside the same
//     transaction and adds the vertical's policy (the pricing moment).
//
// Every operation's FIRST line is the permission check. Data access is
// `ctx.sql` only. No `fetch`, no `node:*`, no other engine's tables.
// ============================================================================

export interface CustomerRow {
  id: string;
  number: string;
  name: string;
  phone: string | null;
  created_at: string;
}

export interface BikeRow {
  id: string;
  customer_id: string;
  label: string;
  frame_no: string | null;
  created_at: string;
}

export interface PriceRow {
  article: string;
  description: string;
  unit: string;
  price_amount: string;
  currency: string;
  min_qty: string | null;
  internal: number;
}

const createCustomerOp: OperationHandler<
  { number: string; name: string; phone?: string },
  CustomerRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO shop_customers (id, number, name, phone, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.number, input.name, input.phone ?? null, ctx.now()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM shop_customers WHERE id = ?', [id])[0]!;
};

const listCustomersOp: OperationHandler<undefined, (CustomerRow & { bikes: BikeRow[] })[]> = async (
  ctx,
) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  const customers = ctx.sql.query<CustomerRow>('SELECT * FROM shop_customers ORDER BY number');
  return customers.map((c) => ({
    ...c,
    bikes: ctx.sql.query<BikeRow>('SELECT * FROM shop_bikes WHERE customer_id = ? ORDER BY label', [
      c.id,
    ]),
  }));
};

const registerBikeOp: OperationHandler<
  { customerId: string; label: string; frameNo?: string },
  BikeRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.bikeManage));
  const customer = ctx.sql.query<CustomerRow>('SELECT * FROM shop_customers WHERE id = ?', [
    input.customerId,
  ])[0];
  if (!customer) throw new Error(`customer not found: ${input.customerId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO shop_bikes (id, customer_id, label, frame_no, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, customer.id, input.label, input.frameNo ?? null, ctx.now()],
  );
  // Record the bike → customer edge the manifest declared, so the portal walk
  // (workorder → bike → customer) can resolve an entity-narrowed grant.
  ctx.link({ entityType: 'bike', entityId: id }, { entityType: 'customer', entityId: customer.id });
  return ctx.sql.query<BikeRow>('SELECT * FROM shop_bikes WHERE id = ?', [id])[0]!;
};

const upsertPriceOp: OperationHandler<
  {
    article: string;
    description: string;
    unit: string;
    priceAmount: string;
    currency?: string;
    minQty?: string;
    internal?: boolean;
  },
  PriceRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO shop_price_list
       (article, description, unit, price_amount, currency, min_qty, internal)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.article,
      input.description,
      input.unit,
      input.priceAmount,
      input.currency ?? 'SEK',
      input.minQty ?? null,
      input.internal ? 1 : 0,
    ],
  );
  return ctx.sql.query<PriceRow>('SELECT * FROM shop_price_list WHERE article = ?', [
    input.article,
  ])[0]!;
};

const priceListOp: OperationHandler<undefined, PriceRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  return ctx.sql.query<PriceRow>('SELECT * FROM shop_price_list ORDER BY article');
};

/**
 * Open a repair: a vertical operation that composes the engine's `createWorkOrder`.
 * The vertical resolves its own vocabulary (a bike, its owner) into the engine's
 * `facility`/`customer` refs; the engine owns the number, the state, the event.
 */
const createRepairOp: OperationHandler<
  { bikeId: string; kind: string; title: string; description?: string },
  WorkOrder
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));
  const bike = ctx.sql.query<BikeRow>('SELECT * FROM shop_bikes WHERE id = ?', [input.bikeId])[0];
  if (!bike) throw new Error(`bike not found: ${input.bikeId}`);
  return createWorkOrder(ctx, {
    facility: { entityType: 'bike', entityId: bike.id },
    customer: { entityType: 'customer', entityId: bike.customer_id },
    kind: input.kind,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
};

/**
 * THE PRICING MOMENT — the whole reason a vertical exists. Read the engine's
 * reported time and material, price them against the vertical's OWN price list
 * (labor bills at least its minimum quantity; internal articles are dropped),
 * then hand the priced lines back to the engine's `completeWorkOrder`. One
 * transaction: the engine's invariant stays intact and pricing is 100% vertical.
 * The engine's `workorder.completed` event carries these lines, and the
 * invoicing engine consumes it — no import between the two.
 */
const completeRepairOp: OperationHandler<
  { orderId: string },
  { order: WorkOrder; billable: BillableLine[]; total: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.complete));
  const reported = getReportedLines(ctx, input.orderId);
  const prices = new Map<string, PriceRow>(
    ctx.sql.query<PriceRow>('SELECT * FROM shop_price_list').map((p) => [p.article, p]),
  );

  const billable: BillableLine[] = [];

  // Labor: sum reported hours, then bill at least the minimum quantity.
  const laborPrice = prices.get('labor');
  const reportedHours = reported.time.reduce((sum, t) => addDecimal(sum, t.hours), '0');
  if (laborPrice && compareDecimal(reportedHours, '0') > 0) {
    const minQty = laborPrice.min_qty ?? '0';
    const qty = compareDecimal(reportedHours, minQty) >= 0 ? reportedHours : minQty;
    const unitPrice = moneyOf(laborPrice.price_amount, laborPrice.currency);
    billable.push({
      article: 'labor',
      description: laborPrice.description,
      qty,
      unit: laborPrice.unit,
      unitPrice,
      lineTotal: mulMoney(qty, unitPrice),
      sourceType: 'time',
      sourceId: input.orderId,
    });
  }

  // Parts: one billable line per reported material; internal articles dropped.
  for (const m of reported.material) {
    const price = prices.get(m.article);
    if (!price) throw new Error(`no price for article: ${m.article}`);
    if (price.internal) continue;
    const unitPrice = moneyOf(price.price_amount, price.currency);
    billable.push({
      article: m.article,
      description: price.description,
      qty: m.qty,
      unit: price.unit,
      unitPrice,
      lineTotal: mulMoney(m.qty, unitPrice),
      sourceType: 'material',
      sourceId: m.id,
    });
  }

  const result = completeWorkOrder(ctx, { orderId: input.orderId, billable });
  return { order: result.order, billable, total: result.total };
};

/**
 * Pickup: hand the bike back (completed → closed). A thin composition of the
 * engine's in-scope `closeWorkOrder`; the vertical owns the vocabulary
 * ("pickup"), the engine owns the transition.
 */
const closeRepairOp: OperationHandler<{ orderId: string }, WorkOrder> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.close));
  return closeWorkOrder(ctx, { orderId: input.orderId });
};

/**
 * The customer PORTAL listing. A proof walk: no blanket `workorder:read`, one
 * PER-ENTITY check per repair. A portal customer holds an entity-narrowed grant
 * on their own customer record, so the walk workorder → bike → customer lets
 * them through for their own repairs and no one else's.
 *
 * Paged by OVER-FETCHING, which is what a permission-filtered walk needs: a page
 * of 20 rows read from the table can leave 3 standing after the proof walk, so the
 * fetch size and the page size are not the same number and cannot be made the same
 * number. `pageVisible` does the over-fetch and advances the cursor by the last row
 * EXAMINED — advancing by the last row RETURNED would re-examine every rejected row
 * on the next request, and a page the walk rejects entirely would never advance at
 * all. So a SHORT page does not end this walk; only a null `nextCursor` does.
 */
const portalRepairsOp: OperationHandler<PageParams | undefined, Page<WorkOrder>> = async (
  ctx,
  input,
) =>
  pageVisible(
    (p) => listOrders(ctx, { ...input, ...p }),
    input,
    async (order) =>
      (await ctx.check(WO.read, { entityType: 'workorder', entityId: order.id })).allowed,
  );

const timelineInput = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
});

/**
 * An entity's event timeline, read straight off the spine (a read of `_substrat_*`
 * for a projection is allowed; writing it is not). Gated by a per-entity
 * `workorder:read` check, so it obeys the same walk as the portal.
 */
const timelineOp: OperationHandler<
  z.infer<typeof timelineInput>,
  { type: string; occurred_at: string; actor: string }[]
> = async (ctx, rawInput) => {
  const entity: EntityRef = timelineInput.parse(rawInput);
  assertAllowed(await ctx.check(WO.read, entity));
  // Append order is authoritative — rowid, not ULID (ids minted in the same
  // millisecond are not mutually ordered).
  return ctx.sql.query(
    `SELECT type, occurred_at, actor FROM _substrat_outbox
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
};

export const bikeShopModule: ModuleRegistration = {
  manifest: bikeShopManifest,
  migrations: bikeShopMigrations,
  operations: {
    'shop/create-customer': createCustomerOp as never,
    'shop/list-customers': listCustomersOp as never,
    'shop/register-bike': registerBikeOp as never,
    'shop/upsert-price': upsertPriceOp as never,
    'shop/price-list': priceListOp as never,
    'shop/create-repair': createRepairOp as never,
    'shop/complete-repair': completeRepairOp as never,
    'shop/close-repair': closeRepairOp as never,
    'shop/portal-repairs': portalRepairsOp as never,
    'shop/timeline': timelineOp as never,
  },
};
