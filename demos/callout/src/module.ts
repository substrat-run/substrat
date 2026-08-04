import { z } from 'zod';
import {
  compareDecimal,
  addDecimal,
  moneyOf,
  mulMoney,
  type EntityRef,
  type Money,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SC_PERM, calloutManifest } from './manifest.js';
import { calloutMigrations } from './migrations.js';
import {
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
  requireSigned,
  PROTOCOL_PERM as PROTO,
  type ProtocolInstanceRow,
} from '@substrat-run/engine-protocol';

// ============================================================================
// The Callout vertical (spec/testrun.md §5.1): customers, facilities, the
// price list, and the ORCHESTRATION — including the pricing moment, which is
// vertical logic composed with engine functions in one transaction (K-16).
// The declarative surface (SC_PERM, manifest) lives in manifest.ts; the
// migration journal in migrations.ts. This file is operations + wiring.
// ============================================================================

export interface CustomerRow {
  id: string;
  number: string;
  name: string;
  org_ref: string | null;
  created_at: string;
}

export interface FacilityRow {
  id: string;
  customer_id: string;
  name: string;
  address: string | null;
  access_note: string | null;
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
  { number: string; name: string; orgRef?: string },
  CustomerRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO callout_customers (id, number, name, org_ref, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.number, input.name, input.orgRef ?? null, new Date().toISOString()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM callout_customers WHERE id = ?', [id])[0]!;
};

const listCustomersOp: OperationHandler<
  undefined,
  (CustomerRow & { facilities: FacilityRow[] })[]
> = async (ctx) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const customers = ctx.sql.query<CustomerRow>(
    'SELECT * FROM callout_customers ORDER BY number',
  );
  return customers.map((c) => ({
    ...c,
    facilities: ctx.sql.query<FacilityRow>(
      'SELECT * FROM callout_facilities WHERE customer_id = ? ORDER BY name',
      [c.id],
    ),
  }));
};

const createFacilityOp: OperationHandler<
  { customerId: string; name: string; address?: string; accessNote?: string },
  FacilityRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.facilityManage));
  const customer = ctx.sql.query<CustomerRow>('SELECT * FROM callout_customers WHERE id = ?', [
    input.customerId,
  ])[0];
  if (!customer) throw new Error(`customer not found: ${input.customerId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO callout_facilities (id, customer_id, name, address, access_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, customer.id, input.name, input.address ?? null, input.accessNote ?? null, new Date().toISOString()],
  );
  ctx.link({ entityType: 'facility', entityId: id }, { entityType: 'customer', entityId: customer.id });
  return ctx.sql.query<FacilityRow>('SELECT * FROM callout_facilities WHERE id = ?', [id])[0]!;
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
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO callout_price_list
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
  return ctx.sql.query<PriceRow>('SELECT * FROM callout_price_list WHERE article = ?', [
    input.article,
  ])[0]!;
};

const priceListOp: OperationHandler<undefined, PriceRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  return ctx.sql.query<PriceRow>('SELECT * FROM callout_price_list ORDER BY article');
};

const createWorkOrderOp: OperationHandler<
  { facilityId: string; kind: string; title: string; description?: string },
  WorkOrder
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));
  const facility = ctx.sql.query<FacilityRow>('SELECT * FROM callout_facilities WHERE id = ?', [
    input.facilityId,
  ])[0];
  if (!facility) throw new Error(`facility not found: ${input.facilityId}`);
  return createWorkOrder(ctx, {
    facility: { entityType: 'facility', entityId: facility.id },
    customer: { entityType: 'customer', entityId: facility.customer_id },
    kind: input.kind,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
};

/**
 * Callout compliance policy ("obligatorisk för status"): which order kinds
 * demand a signed protocol before the engine's complete may run. Vertical
 * vocabulary on both axes — kinds AND template keys are Callout content.
 */
const REQUIRED_SIGNED_PROTOCOLS: Record<string, string[]> = {
  montage: ['self-inspection-electrical'],
};

/**
 * THE PRICING MOMENT (spec §5.1): reads the engine's reported lines, prices
 * them from the vertical's price list (min-qty applied, internal articles
 * dropped), then calls the engine's complete — one transaction, engine
 * invariant intact, pricing 100% vertical-owned.
 */
const completeWorkOrderOp: OperationHandler<
  { orderId: string },
  { order: WorkOrder; billable: BillableLine[]; total: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.complete));

  // THE GUARD, vertical-composed pole (engine-protocol.md §6, open question 11):
  // predicate before the engine transition, same transaction. This glue IS the
  // compliance gate — removing it is human-checkpoint material, not a refactor.
  //
  // It stays glue ON PURPOSE, and is the contrast that defines the other pole.
  // Milestone C added MANIFEST-declared guards (`guards: [{ before, predicate,
  // config }]`, see demos/handlebar) — but those are UNCONDITIONAL gates on an
  // operation. This one is conditional on VERTICAL DATA: only `montage` orders
  // owe an self-inspection, and `order.kind` is Callout vocabulary the kernel
  // must never learn. Conditional-on-vertical-data policy is composed here;
  // unconditional gates are declared in the manifest.
  const order = listOrders(ctx).find((o) => o.id === input.orderId);
  if (!order) throw new Error(`work order not found: ${input.orderId}`);
  for (const templateKey of REQUIRED_SIGNED_PROTOCOLS[order.kind] ?? []) {
    requireSigned(ctx, { entityType: 'workorder', entityId: order.id }, templateKey);
  }

  const reported = getReportedLines(ctx, input.orderId);
  const prices = new Map<string, PriceRow>(
    ctx.sql
      .query<PriceRow>('SELECT * FROM callout_price_list')
      .map((p) => [p.article, p]),
  );

  const billable: BillableLine[] = [];

  // Labor: aggregate reported hours, apply minimum billable quantity.
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

  // Material: one billable line per reported line; internal articles dropped.
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
 * Starting an self-inspection is engine mechanics + VERTICAL policy: Callout
 * attaches protocols to work orders still being worked. The invariants
 * (version pinning, one open instance, events) live in the engine's in-scope
 * function, composed here in the same transaction (K-16). Fill/sign/void/read
 * carry no Callout policy — the engine's default `protocol/*` bindings are
 * used directly, exactly like `workorder/assign`.
 */
const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entityType: z.literal('workorder'), // Callout policy: protocols live on work orders
  entityId: z.string().min(1),
});

const instantiateProtocolOp: OperationHandler<
  z.infer<typeof instantiateProtocolInput>,
  ProtocolInstanceRow
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(PROTO.create));
  const input = instantiateProtocolInput.parse(rawInput);
  const order = listOrders(ctx).find((o) => o.id === input.entityId);
  if (!order) throw new Error(`work order not found: ${input.entityId}`);
  if (order.status !== 'planned' && order.status !== 'in_progress') {
    throw new Error(`work order ${order.number} is '${order.status}' — protocols attach to open orders`);
  }
  return instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
};

/** Portal listing: per-entity proof walks, no node-level permission required. */
const portalOrdersOp: OperationHandler<undefined, WorkOrder[]> = async (ctx) => {
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

/**
 * "Who am I" for the app shell — the caller's own role hint, resolved from THIS scope.
 * No permission gate: every principal in the scope may ask about themselves (it reveals
 * only their own role, already theirs). The role is a UI hint derived by probing the
 * caller's own grants — the kernel still enforces the real permission on every operation
 * regardless of what this returns. `portal` (an entity-narrowed customer login) is not
 * detectable here — it holds no node-level permission — so it reads as `none`; a portal
 * user is a dev-cast concern (server.ts), never a hosted OIDC login.
 */
export interface WhoAmI {
  role: 'office-admin' | 'technician' | 'none';
}
const whoamiOp: OperationHandler<undefined, WhoAmI> = async (ctx) => {
  const role: WhoAmI['role'] = (await ctx.check(SC_PERM.customerManage)).allowed
    ? 'office-admin'
    : (await ctx.check(WO.report)).allowed
      ? 'technician'
      : 'none';
  return { role };
};

export const calloutModule: ModuleRegistration = {
  manifest: calloutManifest,
  migrations: calloutMigrations,
  operations: {
    'callout/whoami': whoamiOp as never,
    'callout/create-customer': createCustomerOp as never,
    'callout/list-customers': listCustomersOp as never,
    'callout/create-facility': createFacilityOp as never,
    'callout/upsert-price': upsertPriceOp as never,
    'callout/price-list': priceListOp as never,
    'callout/create-workorder': createWorkOrderOp as never,
    'callout/complete-workorder': completeWorkOrderOp as never,
    'callout/instantiate-protocol': instantiateProtocolOp as never,
    'callout/portal-orders': portalOrdersOp as never,
    'callout/timeline': timelineOp as never,
  },
};
