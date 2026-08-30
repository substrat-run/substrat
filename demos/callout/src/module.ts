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
  operationConcurrencyOf,
  operationInputsOf,
  substratError,
  type CountedPage,
  type EntityRef,
  type EntityRow,
  type Money,
  type OperationImpl,
  type Page,
  type TimelineEntry,
} from '@substrat-run/contracts';

/**
 * Callout's own conflicts — `conflict` is the platform's code, the reason is this
 * vertical's (§2: a module never invents a code, it narrows one with a reason it owns).
 * Declaring the union means a typo is a compile error and the set is readable in one
 * place, which is how the engines already do it.
 */
type CalloutConflictReason = 'no_price' | 'not_open';
const conflict = (reason: CalloutConflictReason, message: string) =>
  substratError('conflict', message, { reason });

import { calloutEntities } from './entities.js';
import { calloutOperations, instantiateProtocolInput, timelineInput } from './operations.js';
import {
  assertAllowed,
  readTimeline,
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
  if (!customer) throw substratError('not_found', `customer not found: ${input.customerId}`);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO callout_facilities (id, customer_id, name, address, access_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, customer.id, input.name, input.address ?? null, input.accessNote ?? null, ctx.now()],
  );
  ctx.link({ entityType: 'facility', entityId: id }, { entityType: 'customer', entityId: customer.id });
  const row = ctx.sql.query<FacilityRow>('SELECT * FROM callout_facilities WHERE id = ?', [id])[0]!;
  // #129: without this the row has no version, and every conditional update
  // against it would be refused forever — see the declaration.
  ctx.emit({
    type: 'callout.facility-created',
    schemaVersion: 1,
    entity: { entityType: 'facility', entityId: row.id },
    piiClass: 'none',
    payload: {
      id: row.id,
      customer_id: row.customer_id,
      name: row.name,
      access_note: row.access_note,
    },
  });
  return row;
};

/** The read that hands out the tag (#129) — see the declaration for why it exists. */
const getFacilityOp: OperationHandler<{ facilityId: string }, FacilityRow> = async (ctx, input) => {
  assertAllowed(
    await ctx.check(SC_PERM.facilityManage, { entityType: 'facility', entityId: input.facilityId }),
  );
  const row = ctx.sql.query<FacilityRow>('SELECT * FROM callout_facilities WHERE id = ?', [
    input.facilityId,
  ])[0];
  if (!row) throw substratError('not_found', `facility not found: ${input.facilityId}`);
  return row;
};

/**
 * The guarded update (#129). The precondition is NOT here — by the time this runs
 * the host has already compared the caller's `If-Match` against the facility's
 * version, inside this same transaction, and thrown `precondition_failed` if it
 * had moved. A handler that re-checked would be checking a value it cannot read
 * atomically with its own write, which is the mistake the declaration exists to
 * make unnecessary.
 *
 * What IS here is the rule that makes the guard mean anything: the write emits.
 * A version is the last event about an entity, so an update that announced
 * nothing would never move the tag it is guarded on.
 */
const updateFacilityOp: OperationHandler<
  { facilityId: string; name?: string; address?: string; accessNote?: string },
  FacilityRow
> = async (ctx, input) => {
  assertAllowed(
    await ctx.check(SC_PERM.facilityManage, { entityType: 'facility', entityId: input.facilityId }),
  );
  const current = ctx.sql.query<FacilityRow>('SELECT * FROM callout_facilities WHERE id = ?', [
    input.facilityId,
  ])[0];
  if (!current) throw substratError('not_found', `facility not found: ${input.facilityId}`);
  // COALESCE semantics stated in TypeScript rather than SQL: an omitted field
  // preserves what the row carries. That is what makes this read-modify-write and
  // therefore what makes the precondition load-bearing.
  const next = {
    name: input.name ?? current.name,
    address: input.address ?? current.address,
    access_note: input.accessNote ?? current.access_note,
  };
  ctx.sql.exec('UPDATE callout_facilities SET name = ?, address = ?, access_note = ? WHERE id = ?', [
    next.name,
    next.address,
    next.access_note,
    input.facilityId,
  ]);
  const row = ctx.sql.query<FacilityRow>('SELECT * FROM callout_facilities WHERE id = ?', [
    input.facilityId,
  ])[0]!;
  ctx.emit({
    type: 'callout.facility-updated',
    schemaVersion: 1,
    entity: { entityType: 'facility', entityId: row.id },
    piiClass: 'none',
    // Fat, minus the erasable address — the declaration in `operations.ts` is
    // what the compiler holds this list to.
    payload: {
      id: row.id,
      customer_id: row.customer_id,
      name: row.name,
      access_note: row.access_note,
    },
  });
  return row;
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
  if (!facility) throw substratError('not_found', `facility not found: ${input.facilityId}`);
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
    // `conflict`, not `not_found`: the order the caller addressed is right there, and a
    // 404 on a report route would say it is not. What is missing is a row in THIS
    // vertical's price list, which is a state the caller cannot address around.
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
    throw conflict(
      'not_open',
      `work order ${order.number} is '${order.status}' — protocols attach to open orders`,
    );
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
 * #811, over the kernel's own read (#800). `_substrat_outbox` is the kernel's
 * table, so there is no registry entity for `paged.over` to name — but the walk
 * across it is the platform's, not this vertical's. `readTimeline` orders by the
 * event id (creation order, since `ulid()` is monotonic), pages on it, and
 * decodes `actor` out of the JSON the column actually holds.
 *
 * What this vertical still owns is the line above it: the permission check.
 */
const timelineOp: OperationHandler<
  z.infer<typeof timelineInput> & PageParams,
  Page<TimelineEntry>
> = async (ctx, input) => {
  // The DECLARED schema, not a second copy of it (#890): `entityType` is a
  // literal there, so a caller naming another entity is refused here rather than
  // reaching `ctx.check` with a ref the declaration never claimed.
  const entity: EntityRef = timelineInput.parse(input);
  assertAllowed(await ctx.check(WO.read, entity));
  return readTimeline(ctx, entity, input);
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
  'callout/get-facility': getFacilityOp,
  'callout/update-facility': updateFacilityOp,
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
  // #129: the entity whose version an `If-Match` is compared against, derived
  // from the same declaration the routes and the document come from.
  operationConcurrency: operationConcurrencyOf(calloutOperations),
  // …and the input schemas from that same declaration, so the host parses every
  // invocation before the guards and the handler (#953).
  operationInputs: operationInputsOf(calloutOperations),
  operations: {
    // ALL of them bound to the declaration (#707): input and return are checked
    // against `calloutOperations` at the exact method. The `as never` casts these
    // used to carry were never necessary — `OperationHandler<never, unknown>`
    // accepts any handler by contravariance — they simply threw the types away.
    ...(declaredOperations as Record<string, OperationHandler<never, unknown>>),
  },
};
