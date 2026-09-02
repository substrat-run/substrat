import { z } from 'zod';
import {
  compareDecimal,
  addDecimal,
  listsDeclaredBy,
  manifestEntities,
  moduleManifest,
  moneyOf,
  listLimitOf,
  mapPage,
  mulMoney,
  operationInputsOf,
  pageOf,
  pageVisible,
  permissionKey,
  substratError,
  type CountedPage,
  type EntityRef,
  type Page,
  type EntityRow,
  type OperationImpl,
  type Money,
  type TimelineEntry,
} from '@substrat-run/contracts';

/**
 * Handlebar's own conflicts — the platform owns `conflict`, this vertical owns the
 * reason (§2 of the error model: a module never invents a code).
 */
type HandlebarConflictReason = 'no_price' | 'not_open';
const conflict = (reason: HandlebarConflictReason, message: string) =>
  substratError('conflict', message, { reason });
import { protocolEntities } from '@substrat-run/engine-protocol';

import { workorderEntities } from '@substrat-run/engine-workorder';
import { handlebarEntities } from './entities.js';
import { handlebarOperations, startConditionReportInput, timelineInput } from './operations.js';
import {
  assertAllowed,
  readTimeline,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import type { PageParams } from '@substrat-run/kernel';
import {
  closeWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  getReportedLines,
  getWorkOrder,
  listOrders,
  PERM as WO,
  type BillableLine,
  type WorkOrder,
} from '@substrat-run/engine-workorder';
import {
  instantiateProtocol,
  PROTOCOL_PERM as PROTO,
  type ProtocolInstanceRow,
} from '@substrat-run/engine-protocol';

// ============================================================================
// The Handlebar vertical (spec/concept.md) — the v2 bike-shop skin. Same
// engines as Callout, different vocabulary: a repair IS a work order, a
// mechanic IS a technician, and the order's "facility" ref is a BIKE the
// customer brings in. Everything here is vocabulary, price list, and
// orchestration — the state machine stays in the engine.
//
// Milestone B (engine-protocol.md §2): this vertical's tillståndsrapport —
// a per-bike condition report filled at intake/during the repair, SIGNED by
// the workshop and COUNTER-SIGNED by the customer at pickup — is the second
// protocol shape that forced the extraction of @substrat-run/engine-protocol.
// The template content below is 100% Handlebar vocabulary; every
// invariant (sign → immutable, counter-sign on frozen content, append-only
// responses, verifiable hash) lives in the engine.
// ============================================================================

export const CS_PERM = {
  customerManage: permissionKey.parse('customer:manage'),
  bikeManage: permissionKey.parse('bike:manage'),
};

export const bikeShopManifest = moduleManifest.parse({
  id: '@substrat-run/demo-handlebar',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'customer:manage', description: 'Manage customers and the workshop price list' },
    { key: 'bike:manage', description: "Register and manage customers' bikes" },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  // Entity names checked against `handlebarEntities` (#697). `bike → customer`
  // is DERIVED from the entity's `parent`; the two engine-crossing edges are
  // split by which half can be checked.
  ...manifestEntities(handlebarEntities, {
    attachmentTargets: [
      { entityType: 'customer', readPermission: 'customer:manage' },
      { entityType: 'bike', readPermission: 'bike:manage' },
    ],
    // Edges involving an engine's entity. Both sides are checked against the
    // composed registries: the engine links workorder → <facility ref>, and in
    // this vertical that ref is a bike — something only this vertical knows.
    engines: [protocolEntities, workorderEntities],
    relations: [
      { entityType: 'workorder', parentType: 'bike' },
      { entityType: 'protocol', parentType: 'workorder' },
    ],
  }),
  // #811: DERIVED from the operations' own `paged.over`, never written twice.
  //
  // Its ABSENCE was a live bug, and the kind only driving the HTTP path finds:
  // `bike-shop/list-customers` has always declared `paged.over`, but nothing carried
  // that declaration to the kernel, so `GET /api/customers` — the Kunder screen —
  // answered 400 `NotListable` on every call. Every other vertical and engine in the
  // workspace already had this line. The scenario suite never noticed because it
  // invokes operations directly and never pages through the kernel.
  lists: listsDeclaredBy(handlebarOperations, handlebarEntities, [
    workorderEntities,
    protocolEntities,
  ]),
  // MILESTONE C — the manifest-declared guard (engine-protocol.md §6, kernel
  // open question 11). Handlebar's pickup rule: a repair is not closed until
  // the customer has COUNTER-SIGNED the tillståndsrapport — i.e. accepted, on
  // frozen content, the condition the bike goes home in. That gate is
  // UNCONDITIONAL (it holds for every pickup, it depends on no vertical field),
  // so it belongs here rather than in glue: the kernel runs it inside
  // `bike-shop/close-repair`'s own transaction, before the handler, and
  // DROPPING it is now a manifest diff a human reviews — not a deleted line
  // inside a 60-line operation. Contrast: Callout's montage→self-inspection gate
  // is conditional on order.kind — vertical vocabulary the kernel must never
  // learn — so it stays vertical-composed glue (demos/callout/src/module.ts).
  //
  // Star topology: the workorder engine knows nothing of protocols; the protocol
  // engine contributes the named predicate; the VERTICAL — the layer that owns
  // "what is mandatory when" — wires them.
  // …and the complement that makes the guard ENFORCEABLE rather than merely
  // reviewable: the engine's default `workorder/close` binding is WITHDRAWN in
  // this host. The only door out of a repair is `bike-shop/close-repair`, which
  // the guard above stands in front of. Withdrawal removes the BINDING, not the
  // capability — the engine's in-scope `closeWorkOrder` is exactly what the
  // vertical's guarded operation composes. Opt-in: Callout withdraws nothing
  // and keeps `workorder/close` (demos/callout).
  withdraws: ['workorder/close'],
  guards: [
    {
      before: 'bike-shop/close-repair',
      predicate: 'protocol/all-signed',
      config: {
        templateKey: 'tillstandsrapport', // vertical content
        entityType: 'workorder',
        entityIdFrom: 'orderId', // the input field carrying the repair id
        countersigned: true, // the customer accepted it at pickup
      },
    },
  ],
  entitlementKey: 'handlebar',
});

export const bikeShopMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE bike_shop_customers (
        id          TEXT PRIMARY KEY,
        number      TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        phone       TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE bike_shop_bikes (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES bike_shop_customers(id),
        label       TEXT NOT NULL,
        frame_no    TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE bike_shop_price_list (
        article      TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        unit         TEXT NOT NULL,
        price_amount TEXT NOT NULL,
        currency     TEXT NOT NULL DEFAULT 'SEK',
        min_qty      TEXT,
        internal     INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

/**
 * DERIVED from the registry (#697/#707). These were hand-written interfaces, so
 * the schema was described three times — the DDL, the registry, and here.
 */
export type CustomerRow = EntityRow<typeof handlebarEntities, 'customer'>;
export type BikeRow = EntityRow<typeof handlebarEntities, 'bike'>;

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
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO bike_shop_customers (id, number, name, phone, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.number, input.name, input.phone ?? null, ctx.now()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM bike_shop_customers WHERE id = ?', [id])[0]!;
};

/**
 * #811. The walk is the kernel's; the hydration stays here — and the page is what
 * BOUNDS it. This used to run one bikes query per customer in the scope, so the
 * cost of the read grew with the table; it now runs one per customer on the page.
 */
const listCustomersOp: OperationHandler<
  PageParams,
  CountedPage<CustomerRow & { bikes: BikeRow[] }>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  const page = ctx.page<CustomerRow>('customer', { ...input, total: true }) as CountedPage<CustomerRow>;
  return mapPage(page, (c) => ({
    ...c,
    bikes: ctx.sql.query<BikeRow>(
      'SELECT * FROM bike_shop_bikes WHERE customer_id = ? ORDER BY label',
      [c.id],
    ),
  }));
};

const registerBikeOp: OperationHandler<
  { customerId: string; label: string; frameNo?: string },
  BikeRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(CS_PERM.bikeManage));
  const customer = ctx.sql.query<CustomerRow>('SELECT * FROM bike_shop_customers WHERE id = ?', [
    input.customerId,
  ])[0];
  if (!customer) throw substratError('not_found', `customer not found: ${input.customerId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO bike_shop_bikes (id, customer_id, label, frame_no, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, customer.id, input.label, input.frameNo ?? null, ctx.now()],
  );
  ctx.link({ entityType: 'bike', entityId: id }, { entityType: 'customer', entityId: customer.id });
  return ctx.sql.query<BikeRow>('SELECT * FROM bike_shop_bikes WHERE id = ?', [id])[0]!;
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
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO bike_shop_price_list
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
  return ctx.sql.query<PriceRow>('SELECT * FROM bike_shop_price_list WHERE article = ?', [
    input.article,
  ])[0]!;
};

const priceListOp: OperationHandler<PageParams, Page<PriceRow>> = async (ctx, input) => {
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  const limit = listLimitOf(input?.limit);
  // Handler-composed (see the declaration): a value-keyed table the registry does
  // not carry. Keyset over `article`, which is its natural key.
  const rows = input?.cursor
    ? ctx.sql.query<PriceRow>(
        'SELECT * FROM bike_shop_price_list WHERE article > ? ORDER BY article LIMIT ?',
        [input.cursor, limit],
      )
    : ctx.sql.query<PriceRow>('SELECT * FROM bike_shop_price_list ORDER BY article LIMIT ?', [limit]);
  return pageOf(rows, limit, (row) => row.article);
};

const createRepairOp: OperationHandler<
  { bikeId: string; kind: string; title: string; description?: string },
  WorkOrder
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));
  const bike = ctx.sql.query<BikeRow>('SELECT * FROM bike_shop_bikes WHERE id = ?', [input.bikeId])[0];
  if (!bike) throw substratError('not_found', `bike not found: ${input.bikeId}`);
  return createWorkOrder(ctx, {
    facility: { entityType: 'bike', entityId: bike.id },
    customer: { entityType: 'customer', entityId: bike.customer_id },
    kind: input.kind,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
};

/**
 * THE PRICING MOMENT (spec/concept.md §5): read the engine's reported lines,
 * price them from the workshop price list — mechanic time bills at least the
 * half-hour minimum, internal articles (verkstadsmtrl) are dropped — then call
 * the engine's complete. One transaction, engine invariant intact, pricing
 * 100% vertical-owned.
 */
const completeRepairOp: OperationHandler<
  { orderId: string },
  { order: WorkOrder; billable: BillableLine[]; total: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.complete));
  const reported = getReportedLines(ctx, input.orderId);
  const prices = new Map<string, PriceRow>(
    ctx.sql.query<PriceRow>('SELECT * FROM bike_shop_price_list').map((p) => [p.article, p]),
  );

  const billable: BillableLine[] = [];

  // Mechanic time: aggregate reported hours, apply the minimum billable qty.
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

  // Parts: one billable line per reported line; internal articles dropped.
  for (const m of reported.material) {
    const price = prices.get(m.article);
    // `conflict`, not `not_found`: the repair the caller addressed exists, and a 404
    // would say otherwise. The gap is a row in this workshop's own price list.
    if (!price) throw conflict('no_price', `no price for article: ${m.article}`);
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
 * Starting a tillståndsrapport is engine mechanics + VERTICAL policy:
 * Handlebar attaches condition reports at intake or during the repair,
 * never after pickup. The invariants (version pinning, one open instance,
 * events) live in the engine's in-scope function, composed here in the same
 * transaction (K-16). Fill/sign/counter-sign/read carry no Handlebar
 * policy — the engine's default `protocol/*` bindings are used directly,
 * exactly like `workorder/assign`.
 */
const startConditionReportOp: OperationHandler<
  z.infer<typeof startConditionReportInput>,
  ProtocolInstanceRow
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(PROTO.create));
  const input = startConditionReportInput.parse(rawInput ?? {});
  // One read by id (#811). This used to list every order and `.find` it, which
  // a page would silently break: the order you want is not necessarily on page one.
  const repair = getWorkOrder(ctx, input.orderId);
  if (repair.status !== 'planned' && repair.status !== 'in_progress') {
    throw conflict(
      'not_open',
      `repair ${repair.number} is '${repair.status}' — condition reports attach at intake or during the repair`,
    );
  }
  return instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: { entityType: 'workorder', entityId: repair.id },
  });
};

/**
 * PICKUP: hand the bike back. A thin vertical binding of the engine's in-scope
 * `closeWorkOrder` — the operation carries no policy of its own, because the
 * policy is DECLARED in the manifest above: the kernel evaluates the
 * `protocol/all-signed` guard (countersigned: true) before this handler runs,
 * in the same transaction, and a failure rolls the whole invoke back.
 *
 * Why a vertical operation and not `guards: [{ before: 'workorder/close' }]`:
 * the vertical must name the moment it actually owns — PICKUP, where the
 * customer accepts the report — and the engine's transition is only part of it.
 * The engine's default `workorder/close` binding is WITHDRAWN in the manifest,
 * so this is the only door: there is no ungated path to `closed`.
 */
const closeRepairOp: OperationHandler<{ orderId: string }, WorkOrder> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.close));
  return closeWorkOrder(ctx, { orderId: input.orderId });
};

/**
 * Portal listing: per-entity proof walks (workorder → bike → customer).
 *
 * Paged by OVER-FETCHING (#811), which is what a permission-filtered walk needs.
 * A page of 20 read from the table can leave 3 after the walk, so the page size
 * cannot be the fetch size — and the cursor has to advance by the last row
 * EXAMINED rather than the last row returned, or the rows filtered out are
 * examined again on the next request and the walk never terminates.
 */
const portalRepairsOp: OperationHandler<PageParams, Page<WorkOrder>> = async (ctx, input) =>
  pageVisible(
    (p) => listOrders(ctx, { ...input, ...p }),
    input,
    async (order) =>
      (await ctx.check(WO.read, { entityType: 'workorder', entityId: order.id })).allowed,
  );

/**
 * #811, over the kernel's own read (#800). `_substrat_outbox` is the kernel's
 * table — rule 3 permits the projection read; it does not make the spine a
 * registry entity, so there is nothing for `paged.over` to name. The WALK is the
 * platform's: ordered and paged by the event id, with `actor` decoded out of the
 * JSON the column holds rather than handed on as text.
 */
const timelineOp: OperationHandler<
  z.infer<typeof timelineInput> & PageParams,
  Page<TimelineEntry>
> = async (ctx, input) => {
  // The DECLARED schema (#890), so the literal is enforced here rather than
  // trusted from the mount that happens to supply it.
  const entity: EntityRef = timelineInput.parse(input);
  assertAllowed(await ctx.check(WO.read, entity));
  return readTimeline(ctx, entity, input);
};

/**
 * "Who am I" for the app shell — the caller's own role hint, resolved from THIS scope.
 *
 * No permission gate: every principal in the scope may ask about themselves, and the
 * answer reveals only their own grants, which are already theirs. The role is a UI HINT
 * derived by probing those grants; the kernel still enforces the real permission on every
 * operation regardless of what this returns.
 *
 * `portal` (an entity-narrowed customer login) is deliberately not detectable here — a
 * portal principal holds no node-level permission to probe, so it reads as `none`. That is
 * not a gap to widen the enum for: the app decides portal chrome by exclusion (neither
 * staff role ⇒ portal), which is true whoever is asking. It used to be decided by the dev
 * server's persona table, which made it true locally and false everywhere else.
 */
export interface WhoAmI {
  role: 'workshop-admin' | 'mechanic' | 'none';
}
const whoamiOp: OperationHandler<undefined, WhoAmI> = async (ctx) => {
  const role: WhoAmI['role'] = (await ctx.check(CS_PERM.customerManage)).allowed
    ? 'workshop-admin'
    : (await ctx.check(WO.report)).allowed
      ? 'mechanic'
      : 'none';
  return { role };
};

/** The handlers bound to `handlebarOperations`. `satisfies` is the drift detector. */
const declaredOperations = {
  'bike-shop/whoami': whoamiOp,
  'bike-shop/create-customer': createCustomerOp,
  'bike-shop/list-customers': listCustomersOp,
  'bike-shop/register-bike': registerBikeOp,
  'bike-shop/upsert-price': upsertPriceOp,
  'bike-shop/price-list': priceListOp,
  'bike-shop/create-repair': createRepairOp,
  'bike-shop/start-condition-report': startConditionReportOp,
  'bike-shop/complete-repair': completeRepairOp,
  'bike-shop/close-repair': closeRepairOp,
  'bike-shop/portal-repairs': portalRepairsOp,
  'bike-shop/timeline': timelineOp,
} satisfies OperationImpl<typeof handlebarOperations, OperationContext>;

export const bikeShopModule: ModuleRegistration = {
  manifest: bikeShopManifest,
  migrations: bikeShopMigrations,
  // The host parses every invocation against the same declaration the routes and
  // the document come from, so "parse, don't trust" holds on every path in rather
  // than in the handlers that remembered (#953).
  operationInputs: operationInputsOf(handlebarOperations),
  operations: {
    // ALL of them bound to the declaration (#707): input and return checked at
    // the exact method. The `as never` casts these carried were never necessary
    // — OperationHandler<never, unknown> accepts any handler by contravariance.
    ...(declaredOperations as Record<string, OperationHandler<never, unknown>>),
  },
};
