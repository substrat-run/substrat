import {
  addDecimal,
  compareDecimal,
  listLimitOf,
  moneyOf,
  mulMoney,
  operationInputsOf,
  pageOf,
  pageVisible,
  z,
  type HandlerInput,
  type HandlerOutput,
  type OperationImpl,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  readTimeline,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  closeWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  getReportedLines,
  listOrders,
  PERM as WO,
  type BillableLine,
} from '@substrat-run/engine-workorder';
import { bikeShopEntities } from './entities.js';
import { bikeShopOperations, priceRow } from './operations.js';
import { bikeShopManifest, SHOP_PERM } from './manifest.js';
import { bikeShopMigrations } from './migrations.js';

// ============================================================================
// The bike-shop HANDLERS. Each is either:
//   - a thin custodian of the vertical's own tables (customers, bikes, prices),
//     OR
//   - a COMPOSITION that wraps an engine's in-scope function inside the same
//     transaction and adds the vertical's policy (the pricing moment).
//
// Every operation's FIRST line is the permission check. Data access is
// `ctx.sql` only. No `fetch`, no `node:*`, no other engine's tables.
//
// WHAT EACH OPERATION IS is declared in `src/operations.ts`, against the
// entities in `src/entities.ts` — this file holds only the bodies. The binding
// at the bottom is `satisfies OperationImpl<…>`, so a handler that disagrees
// with its declaration is a compile error at the exact method.
// ============================================================================

/** The row shapes, read off the registry so there is one description of each. */
export type CustomerRow = z.infer<typeof bikeShopEntities.customer.fields>;
export type BikeRow = z.infer<typeof bikeShopEntities.bike.fields>;
export type PriceRow = z.infer<typeof priceRow>;

/**
 * One handler's signature, derived from its declaration.
 *
 * `HandlerInput` resolves what the host will hand in — the declared `input`,
 * plus the page trio when the operation is `paged` — and `HandlerOutput`
 * resolves what it must answer with, wrapping the declared entry in a `Page`
 * for a paged read. Neither is restated here, so a change to `operations.ts`
 * lands on the handler as a type error rather than as a silent disagreement.
 */
type Op<K extends keyof typeof bikeShopOperations> = OperationHandler<
  HandlerInput<(typeof bikeShopOperations)[K]>,
  HandlerOutput<(typeof bikeShopOperations)[K]>
>;

const createCustomerOp: Op<'shop/create-customer'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO shop_customers (id, number, name, phone, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.number, input.name, input.phone ?? null, ctx.now()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM shop_customers WHERE id = ?', [id])[0]!;
};

/**
 * The customer list, hydrated with each customer's bikes.
 *
 * Handler-composed keyset paging over `number`, the customer's natural key —
 * keyset and never offset, because on live data an offset shifts between
 * requests and pages then drop and duplicate rows. The page also BOUNDS the
 * hydration: one bikes query per customer ON THE PAGE, where the unpaged read
 * this replaced ran one per customer in the whole scope.
 */
const listCustomersOp: Op<'shop/list-customers'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  const limit = listLimitOf(input?.limit);
  const customers = input?.cursor
    ? ctx.sql.query<CustomerRow>(
        'SELECT * FROM shop_customers WHERE number > ? ORDER BY number LIMIT ?',
        [input.cursor, limit],
      )
    : ctx.sql.query<CustomerRow>('SELECT * FROM shop_customers ORDER BY number LIMIT ?', [limit]);
  const hydrated = customers.map((c) => ({
    ...c,
    bikes: ctx.sql.query<BikeRow>('SELECT * FROM shop_bikes WHERE customer_id = ? ORDER BY label', [
      c.id,
    ]),
  }));
  return pageOf(hydrated, limit, (row) => row.number);
};

const registerBikeOp: Op<'shop/register-bike'> = async (ctx, input) => {
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

const upsertPriceOp: Op<'shop/upsert-price'> = async (ctx, input) => {
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

/**
 * The price list, paged. Handler-composed (see the declaration): a value-keyed
 * table the entity registry deliberately does not carry, so there is no indexed
 * entity for the kernel to walk. Keyset over `article`, its natural key.
 */
const priceListOp: Op<'shop/price-list'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SHOP_PERM.customerManage));
  const limit = listLimitOf(input?.limit);
  const rows = input?.cursor
    ? ctx.sql.query<PriceRow>(
        'SELECT * FROM shop_price_list WHERE article > ? ORDER BY article LIMIT ?',
        [input.cursor, limit],
      )
    : ctx.sql.query<PriceRow>('SELECT * FROM shop_price_list ORDER BY article LIMIT ?', [limit]);
  return pageOf(rows, limit, (row) => row.article);
};

/**
 * Open a repair: a vertical operation that composes the engine's `createWorkOrder`.
 * The vertical resolves its own vocabulary (a bike, its owner) into the engine's
 * `facility`/`customer` refs; the engine owns the number, the state, the event.
 */
const createRepairOp: Op<'shop/create-repair'> = async (ctx, input) => {
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
const completeRepairOp: Op<'shop/complete-repair'> = async (ctx, input) => {
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
const closeRepairOp: Op<'shop/close-repair'> = async (ctx, input) => {
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
const portalRepairsOp: Op<'shop/portal-repairs'> = async (ctx, input) =>
  pageVisible(
    (p) => listOrders(ctx, { ...input, ...p }),
    input,
    async (order) =>
      (await ctx.check(WO.read, { entityType: 'workorder', entityId: order.id })).allowed,
  );

/**
 * An entity's event timeline, read straight off the spine (a read of `_substrat_*`
 * for a projection is allowed; writing it is not). Gated by a per-entity
 * `workorder:read` check, so it obeys the same walk as the portal.
 *
 * `readTimeline` rather than a `SELECT` of our own: it takes an `EntityRef`,
 * pages like a list read, and DECODES the envelope — `actor` comes back as the
 * union the spine recorded, where `SELECT actor` returns a string that looks
 * usable and is not. It checks no permission; we do, above, as always.
 *
 * No `.parse` in here: the host already parsed `entity` against `timelineInput`
 * before this line ran, on whichever path the call came in by.
 */
const timelineOp: Op<'shop/timeline'> = async (ctx, input) => {
  // The operation is `paged`, so the host hands the page trio in on the SAME
  // object as the entity's two fields. An `EntityRef` is exactly those two, so
  // name them rather than passing the whole input — `ctx.check` and
  // `readTimeline` should be given a ref, not a ref with a cursor stuck to it.
  const entity = { entityType: input.entityType, entityId: input.entityId };
  assertAllowed(await ctx.check(WO.read, entity));
  return readTimeline(ctx, entity, input);
};

/**
 * The handlers, bound to `bikeShopOperations`. `satisfies` is the drift
 * detector: change a declared input or return and tsc names the method whose
 * handler no longer agrees. An operation declared but not implemented, or
 * implemented but not declared, is an error here too.
 */
const declaredOperations = {
  'shop/create-customer': createCustomerOp,
  'shop/list-customers': listCustomersOp,
  'shop/register-bike': registerBikeOp,
  'shop/upsert-price': upsertPriceOp,
  'shop/price-list': priceListOp,
  'shop/create-repair': createRepairOp,
  'shop/complete-repair': completeRepairOp,
  'shop/close-repair': closeRepairOp,
  'shop/portal-repairs': portalRepairsOp,
  'shop/timeline': timelineOp,
} satisfies OperationImpl<typeof bikeShopOperations, OperationContext>;

export const bikeShopModule: ModuleRegistration = {
  manifest: bikeShopManifest,
  migrations: bikeShopMigrations,
  // The host parses every invocation against the DECLARED input schemas before
  // the guards, the permission check and the handler — so "parse, don't trust"
  // holds on every path in (HTTP, test, seed, schedule) rather than in the
  // handlers that remembered to do it themselves.
  operationInputs: operationInputsOf(bikeShopOperations),
  operations: {
    // All ten bound to the declaration: input and return are checked against
    // `bikeShopOperations` at the exact method. The `as never` casts this map
    // used to carry were never necessary — `OperationHandler<never, unknown>`
    // accepts any handler by contravariance — they simply threw the types away.
    ...(declaredOperations as Record<string, OperationHandler<never, unknown>>),
  },
};
