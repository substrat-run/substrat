import { z } from 'zod';
import {
  compareDecimal,
  addDecimal,
  manifestEntities,
  moduleManifest,
  moneyOf,
  mulMoney,
  permissionKey,
  type EntityRef,
  type Money,
} from '@substrat-run/contracts';
import { handlebarEntities } from './entities.js';
import {
  assertAllowed,
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
    // MIXED: the child is engine-workorder's, the parent is ours — so the parent
    // IS checked. The engine links workorder → <facility ref>; in this vertical
    // that ref is a bike, and only this vertical knows it.
    foreignChildOf: [{ entityType: 'workorder', parentType: 'bike' }],
    // Neither side is ours: engine-protocol is entity-agnostic and hangs its
    // instances off whatever the vertical says.
    foreignChildren: [{ entityType: 'protocol', parentType: 'workorder' }],
  }),
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
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO bike_shop_customers (id, number, name, phone, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.number, input.name, input.phone ?? null, new Date().toISOString()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM bike_shop_customers WHERE id = ?', [id])[0]!;
};

const listCustomersOp: OperationHandler<
  undefined,
  (CustomerRow & { bikes: BikeRow[] })[]
> = async (ctx) => {
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  const customers = ctx.sql.query<CustomerRow>('SELECT * FROM bike_shop_customers ORDER BY number');
  return customers.map((c) => ({
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
  if (!customer) throw new Error(`customer not found: ${input.customerId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO bike_shop_bikes (id, customer_id, label, frame_no, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, customer.id, input.label, input.frameNo ?? null, new Date().toISOString()],
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

const priceListOp: OperationHandler<undefined, PriceRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(CS_PERM.customerManage));
  return ctx.sql.query<PriceRow>('SELECT * FROM bike_shop_price_list ORDER BY article');
};

const createRepairOp: OperationHandler<
  { bikeId: string; kind: string; title: string; description?: string },
  WorkOrder
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));
  const bike = ctx.sql.query<BikeRow>('SELECT * FROM bike_shop_bikes WHERE id = ?', [input.bikeId])[0];
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
 * Starting a tillståndsrapport is engine mechanics + VERTICAL policy:
 * Handlebar attaches condition reports at intake or during the repair,
 * never after pickup. The invariants (version pinning, one open instance,
 * events) live in the engine's in-scope function, composed here in the same
 * transaction (K-16). Fill/sign/counter-sign/read carry no Handlebar
 * policy — the engine's default `protocol/*` bindings are used directly,
 * exactly like `workorder/assign`.
 */
const startConditionReportInput = z.object({
  orderId: z.string().min(1),
  templateKey: z.string().min(1).default('tillstandsrapport'),
});

const startConditionReportOp: OperationHandler<
  z.infer<typeof startConditionReportInput>,
  ProtocolInstanceRow
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(PROTO.create));
  const input = startConditionReportInput.parse(rawInput ?? {});
  const repair = listOrders(ctx).find((o) => o.id === input.orderId);
  if (!repair) throw new Error(`repair not found: ${input.orderId}`);
  if (repair.status !== 'planned' && repair.status !== 'in_progress') {
    throw new Error(
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

/** Portal listing: per-entity proof walks (workorder → bike → customer). */
const portalRepairsOp: OperationHandler<undefined, WorkOrder[]> = async (ctx) => {
  const all = listOrders(ctx);
  const visible: WorkOrder[] = [];
  for (const order of all) {
    const decision = await ctx.check(WO.read, { entityType: 'workorder', entityId: order.id });
    if (decision.allowed) visible.push(order);
  }
  return visible;
};

const timelineOp: OperationHandler<
  { entityType: string; entityId: string },
  { type: string; occurred_at: string; actor: string }[]
> = async (ctx, input) => {
  const entity: EntityRef = z
    .object({ entityType: z.string().min(1), entityId: z.string().min(1) })
    .parse(input);
  assertAllowed(await ctx.check(WO.read, entity));
  // Append order is authoritative — rowid, not ULID (ids emitted in the same
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
    'bike-shop/create-customer': createCustomerOp as never,
    'bike-shop/list-customers': listCustomersOp as never,
    'bike-shop/register-bike': registerBikeOp as never,
    'bike-shop/upsert-price': upsertPriceOp as never,
    'bike-shop/price-list': priceListOp as never,
    'bike-shop/create-repair': createRepairOp as never,
    'bike-shop/start-condition-report': startConditionReportOp as never,
    'bike-shop/complete-repair': completeRepairOp as never,
    'bike-shop/close-repair': closeRepairOp as never,
    'bike-shop/portal-repairs': portalRepairsOp as never,
    'bike-shop/timeline': timelineOp as never,
  },
};
