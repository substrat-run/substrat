import { z } from 'zod';
import {
  compareDecimal,
  addDecimal,
  listLimitOf,
  mapPage,
  moneyOf,
  mulMoney,
  pageOf,
  pageVisible,
  type CountedPage,
  type EntityRef,
  type EntityRow,
  type Money,
  type OperationImpl,
  type Page,
} from '@substrat-run/contracts';

/** One outbox row as the timeline reads it, plus the rowid its cursor walks. */
interface TimelineRow {
  type: string;
  occurred_at: string;
  actor: string;
  _cursor: number;
}
import { calloutEntities } from './entities.js';
import { calloutOperations, instantiateProtocolInput } from './operations.js';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PageParams,
} from '@substrat-run/kernel';
import { SC_PERM, calloutManifest } from './manifest.js';
import { calloutMigrations } from './migrations.js';
import {
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

/**
 * The row types come FROM the registry (#697/#707). They were hand-written
 * interfaces, which made the schema described three times — the DDL, the
 * registry, and these. `EntityRow` collapses the third into the second; the
 * remaining two are held together by `test/entities.test.ts`.
 */
export type CustomerRow = EntityRow<typeof calloutEntities, 'customer'>;
export type FacilityRow = EntityRow<typeof calloutEntities, 'facility'>;

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
    [id, input.number, input.name, input.orgRef ?? null, ctx.now()],
  );
  return ctx.sql.query<CustomerRow>('SELECT * FROM callout_customers WHERE id = ?', [id])[0]!;
};

/**
 * #811. The walk is the kernel's, composed from this operation's declared
 * vocabulary and running over indexes it provisioned; the hydration stays here.
 * The page also BOUNDS the hydration — one facilities query per customer on the
 * page, where it used to be one per customer in the scope.
 */
const listCustomersOp: OperationHandler<
  PageParams,
  CountedPage<CustomerRow & { facilities: FacilityRow[] }>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const page = ctx.page<CustomerRow>('customer', {
    ...input,
    total: true,
  }) as CountedPage<CustomerRow>;
  return mapPage(page, (c) => ({
    ...c,
    facilities: ctx.sql.query<FacilityRow>(
      'SELECT * FROM callout_facilities WHERE customer_id = ? ORDER BY name',
      [c.id],
    ),
  }));
};

/**
 * #827. Three steps, and the middle one is the only new verb: check, ask the
 * index for ids, hydrate through the read path that already exists.
 *
 * Hydrating rather than returning what the index holds is what keeps one answer
 * to "what is a customer" — the index stores terms, not rows. The `IN (…)` loses
 * the rank order, so the ids are re-sorted back into it: a picker that lists the
 * best match third is a picker people stop trusting.
 */
const searchCustomersOp: OperationHandler<
  { q: string; limit?: number },
  { results: CustomerRow[]; limit: number; capped: boolean }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const limit = input.limit ?? 20;
  const hits = ctx.search('customer', input.q, { limit });
  if (hits.length === 0) return { results: [], limit, capped: false };
  const rows = ctx.sql.query<CustomerRow>(
    `SELECT * FROM callout_customers WHERE id IN (${hits.map(() => '?').join(', ')})`,
    hits.map((h) => h.id),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    results: hits.map((h) => byId.get(h.id)).filter((r): r is CustomerRow => r !== undefined),
    limit,
    // The honest reading of a full page from a capped read: there may be more,
    // and the caller should narrow the term rather than page — a ranked read has
    // no stable cursor to page WITH.
    capped: hits.length === limit,
  };
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
    [id, customer.id, input.name, input.address ?? null, input.accessNote ?? null, ctx.now()],
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

const priceListOp: OperationHandler<PageParams, Page<PriceRow>> = async (ctx, input) => {
  assertAllowed(await ctx.check(SC_PERM.customerManage));
  const limit = listLimitOf(input?.limit);
  // Handler-composed (see the declaration): a value-keyed table the registry does
  // not carry. Keyset over `article`, its natural key.
  const rows = input?.cursor
    ? ctx.sql.query<PriceRow>(
        'SELECT * FROM callout_price_list WHERE article > ? ORDER BY article LIMIT ?',
        [input.cursor, limit],
      )
    : ctx.sql.query<PriceRow>('SELECT * FROM callout_price_list ORDER BY article LIMIT ?', [limit]);
  return pageOf(rows, limit, (row) => row.article);
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
  // One read by id (#811). This listed every order in the scope and `.find`-ed
  // it, which a page would silently break — the order wanted is not necessarily
  // on page one.
  const order = getWorkOrder(ctx, input.orderId);
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
const instantiateProtocolOp: OperationHandler<
  z.infer<typeof instantiateProtocolInput>,
  ProtocolInstanceRow
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(PROTO.create));
  const input = instantiateProtocolInput.parse(rawInput);
  const order = getWorkOrder(ctx, input.entityId);
  if (order.status !== 'planned' && order.status !== 'in_progress') {
    throw new Error(`work order ${order.number} is '${order.status}' — protocols attach to open orders`);
  }
  return instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
};

/** Portal listing: per-entity proof walks, no node-level permission required. */
/**
 * #811. Paged by OVER-FETCHING, which is what a permission-filtered walk needs: a
 * page of 20 read from the table can leave 3 after the proof walk, so the page
 * size cannot be the fetch size. The cursor advances by the last row EXAMINED, or
 * the rows the walk rejected would be examined again forever.
 */
const portalOrdersOp: OperationHandler<PageParams, Page<WorkOrder>> = async (ctx, input) =>
  pageVisible(
    (p) => listOrders(ctx, { ...input, ...p }),
    input,
    async (order) =>
      (await ctx.check(WO.read, { entityType: 'workorder', entityId: order.id })).allowed,
  );

/**
 * #811. Handler-composed: `_substrat_outbox` is the kernel's table, so there is
 * no registry entity for `paged.over` to name. The cursor is the `rowid` because
 * append order is authoritative — ids emitted in the same millisecond are not
 * mutually ordered, so `occurred_at` alone would put a page boundary inside a tie.
 */
const timelineOp: OperationHandler<
  { entityType: string; entityId: string } & PageParams,
  Page<{ type: string; occurred_at: string; actor: string }>
> = async (ctx, input) => {
  const entity: EntityRef = z
    .object({ entityType: z.string().min(1), entityId: z.string().min(1) })
    .parse(input);
  assertAllowed(await ctx.check(WO.read, entity));
  const limit = listLimitOf(input.limit);
  const rows = ctx.sql.query<TimelineRow>(
    `SELECT type, occurred_at, actor, rowid AS _cursor FROM _substrat_outbox
     WHERE entity_type = ? AND entity_id = ?${input.cursor ? ' AND rowid > ?' : ''}
     ORDER BY rowid LIMIT ?`,
    input.cursor
      ? [entity.entityType, entity.entityId, Number(input.cursor), limit]
      : [entity.entityType, entity.entityId, limit],
  );
  // The walk is computed over `_cursor`; `mapPage` then drops it, because the
  // entry shape is published and the rowid is not.
  const page = pageOf(rows, limit, (row) => String(row._cursor));
  return mapPage(page, ({ _cursor: _drop, ...entry }) => entry);
};

/**
 * "Who am I" for the app shell — the caller's own role hint, resolved from THIS scope.
 * No permission gate: every principal in the scope may ask about themselves (it reveals
 * only their own role, already theirs). The role is a UI hint derived by probing the
 * caller's own grants — the kernel still enforces the real permission on every operation
 * regardless of what this returns. `portal` (an entity-narrowed customer login) is not
 * detectable here — it holds no node-level permission to probe — so it reads as `none`.
 * That is not a gap to close by widening this enum: the app decides portal chrome by
 * exclusion (neither staff role ⇒ portal), which is true whoever is asking. It used to be
 * decided by the dev server's persona table instead, which made it true locally and false
 * everywhere else.
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

/**
 * The handlers bound to `calloutOperations`. `satisfies` is the drift detector:
 * change a declared return and tsc names the method whose handler no longer
 * agrees. An operation declared but not implemented, or implemented but not
 * declared, is an error here too.
 */
const declaredOperations = {
  'callout/whoami': whoamiOp,
  'callout/create-customer': createCustomerOp,
  'callout/list-customers': listCustomersOp,
  'callout/search-customers': searchCustomersOp,
  'callout/create-facility': createFacilityOp,
  'callout/upsert-price': upsertPriceOp,
  'callout/price-list': priceListOp,
  'callout/create-workorder': createWorkOrderOp,
  'callout/complete-workorder': completeWorkOrderOp,
  'callout/instantiate-protocol': instantiateProtocolOp,
  'callout/portal-orders': portalOrdersOp,
  'callout/timeline': timelineOp,
} satisfies OperationImpl<typeof calloutOperations, OperationContext>;

export const calloutModule: ModuleRegistration = {
  manifest: calloutManifest,
  migrations: calloutMigrations,
  operations: {
    // ALL of them bound to the declaration (#707): input and return are checked
    // against `calloutOperations` at the exact method. The `as never` casts these
    // used to carry were never necessary — `OperationHandler<never, unknown>`
    // accepts any handler by contravariance — they simply threw the types away.
    ...(declaredOperations as Record<string, OperationHandler<never, unknown>>),
  },
};
