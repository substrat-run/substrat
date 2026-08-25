import { defineEngineRoutes, defineOperations, money, timelineEntry } from '@substrat-run/contracts';
import { invoicingEntities, invoicingOperations } from '@substrat-run/engine-invoicing';
import { protocolEntities, protocolInstanceRow, protocolOperations } from '@substrat-run/engine-protocol';
import { billableLine, workOrder, workorderEntities, workorderOperations } from '@substrat-run/engine-workorder';
import { z } from 'zod';
import { handlebarEntities } from './entities.js';

/** The permission keys operations may require. */
export const HANDLEBAR_PERMISSIONS = [
  'customer:manage',
  'bike:manage',
  'workorder:create',
  'workorder:complete',
  'workorder:close',
  'workorder:read',
  'protocol:create',
] as const;

/** A price-list row. A table, not an entity — no id, never an `EntityRef`. */
export const priceRow = z.object({
  article: z.string(),
  description: z.string(),
  unit: z.string(),
  price_amount: z.string(),
  currency: z.string(),
  min_qty: z.string().nullable(),
  internal: z.number(),
});

/**
 * Handlebar policy: a condition report is started against a bike's repair, and
 * the template defaults to the one the seed ships.
 *
 * Declared here and parsed by the handler — the SAME object. Moving it rather
 * than restating it is the point: retyping this default from memory got it
 * wrong on the first attempt, and only the scenario test caught it.
 */
export const startConditionReportInput = z.object({
  orderId: z.string().min(1),
  templateKey: z.string().min(1).default('tillstandsrapport'),
});

/**
 * Handlebar's policy: the spine is read per repair, and per condition report (#890).
 *
 * `entityType` was a free `z.string()`, with the note that the server supplies
 * the constant by hand. It does — for the route the app calls. The scenario's
 * counter-signature beat reads a PROTOCOL's spine rows, so the operation has
 * always had two admissible types while its declaration could name one.
 *
 * `customer` is deliberately absent: lisbeth reads her repair's timeline as
 * `entityType: 'workorder'` and her grant on the CUSTOMER reaches it through the
 * parent walk (`workorder → bike → customer`). Bounding the type field takes
 * nothing from the portal.
 */
export const timelineInput = z.object({
  entityType: z.enum(['workorder', 'protocol']),
  entityId: z.string().min(1),
});

/**
 * Handlebar's declared operation surface (#707). All eleven.
 *
 * Every engine type this vertical returns already has an exported schema —
 * `workOrder`, `billableLine`, `protocolInstanceRow`, `money` — so nothing here
 * transcribes an engine's shape. That is the difference between this and
 * Callout's first pass, which could declare only six.
 *
 * Note `workOrder`, NOT `workorderRow`: the engine stores `facility_type` /
 * `facility_id` as two snake_case columns and publishes one `EntityRef` in
 * camelCase. Only the published type is what an operation returns.
 */
/** The engine entity registries this vertical composes — see Callout's note (#865). */
const HANDLEBAR_ENGINE_ENTITIES = [workorderEntities, protocolEntities, invoicingEntities] as const;

export const handlebarOperations = defineOperations(
  handlebarEntities,
  HANDLEBAR_PERMISSIONS,
  HANDLEBAR_ENGINE_ENTITIES,
)({
  'bike-shop/create-customer': {
    summary: 'Register a customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string(), name: z.string(), phone: z.string().optional() }),
    output: handlebarEntities.customer.fields,
    http: { method: 'POST', path: '/customers' },
  },
  'bike-shop/list-customers': {
    summary: 'List customers with their bikes',
    permission: 'customer:manage',
    // The ENTRY, not the envelope. The bikes are hydrated per entry by the
    // handler — which the page also BOUNDS: the hydration used to run once per
    // customer in the scope, and now runs once per customer on the page.
    output: handlebarEntities.customer.fields.extend({
      bikes: z.array(handlebarEntities.bike.fields),
    }),
    paged: {
      over: { entity: 'customer', sortable: ['number', 'name', 'created_at'] },
      total: true,
    },
    http: { method: 'GET', path: '/customers' },
  },
  'bike-shop/register-bike': {
    summary: "Register a bike against its owner",
    permission: 'bike:manage',
    input: z.object({ customerId: z.string(), label: z.string(), frameNo: z.string().optional() }),
    output: handlebarEntities.bike.fields,
    http: { method: 'POST', path: '/customers/{customerId}/bikes' },
  },
  'bike-shop/upsert-price': {
    summary: 'Create or update a price-list article',
    permission: 'customer:manage',
    input: z.object({
      article: z.string(),
      description: z.string(),
      unit: z.string(),
      priceAmount: z.string(),
      currency: z.string().optional(),
      minQty: z.string().optional(),
      internal: z.boolean().optional(),
    }),
    output: priceRow,
    http: { method: 'POST', path: '/prices' },
  },
  'bike-shop/price-list': {
    summary: 'The current price list',
    permission: 'customer:manage',
    output: priceRow,
    // Handler-composed, not `over`: `bike_shop_price_list` is a value-keyed table
    // and deliberately NOT a declared entity (see `entities.ts`), so there is no
    // registry entry for the kernel to index or resolve a table from. It still
    // pages, still carries a cursor, and still satisfies the gate — it just owns
    // its own one-line `ORDER BY`.
    paged: { sortKey: 'article' },
    http: { method: 'GET', path: '/prices' },
  },
  'bike-shop/create-repair': {
    summary: 'Open a repair against a bike',
    permission: 'workorder:create',
    input: z.object({
      bikeId: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }),
    output: workOrder,
    http: { method: 'POST', path: '/repairs' },
  },
  'bike-shop/start-condition-report': {
    summary: 'Instantiate the condition-report protocol for a repair',
    permission: 'protocol:create',
    input: startConditionReportInput,
    output: protocolInstanceRow,
    // `templateKey` defaults, so the route carries only the id — a caller may still
    // name a template, which is a choice this vertical is happy to expose.
    http: { method: 'POST', path: '/repairs/{orderId}/condition-report' },
  },
  'bike-shop/complete-repair': {
    summary: 'Complete a repair and price its billable lines',
    permission: 'workorder:complete',
    input: z.object({ orderId: z.string() }),
    output: z.object({ order: workOrder, billable: z.array(billableLine), total: money }),
    http: { method: 'POST', path: '/repairs/{orderId}/complete' },
  },
  'bike-shop/close-repair': {
    summary: 'Close a completed repair at pickup',
    permission: 'workorder:close',
    input: z.object({ orderId: z.string() }),
    output: workOrder,
    // The ONLY door to `closed` — the engine's own `workorder/close` binding is
    // withdrawn in this host, so this path has no engine sibling to collide with.
    http: { method: 'POST', path: '/repairs/{orderId}/close' },
  },
  'bike-shop/portal-repairs': {
    summary: "The repairs visible to the caller's portal",
    narrows: {
      reason: 'a customer sees their own repairs, not a denial',
      // Walks on the workorder engine's read key, declared by the engine.
      checks: [],
    },
    output: workOrder,
    // Handler-composed. A per-row permission walk cannot be a kernel `WHERE` —
    // visibility is decided by the proof walk, not by a column — so this pages by
    // over-fetching (`pageVisible`) and the cursor advances by the last row
    // EXAMINED. Its pages may come back short; the walk ends at the absent Link.
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/portal/repairs' },
  },
  'bike-shop/timeline': {
    summary: 'The event timeline for one entity',
    /**
     * Narrowed to the entity named, not checked at the node — the handler has
     * always called `ctx.check(WO.read, entity)` and the declaration has always
     * said otherwise. The key was right here (Callout's was not, see #865), so
     * what this fixes is the shape: read as a node check, it says any holder of
     * `workorder:read` reads any repair's timeline, which is the whole of the
     * portal's isolation stated backwards.
     *
     * `entityFrom` (#890): two admissible types, enumerated once in
     * `timelineInput` and read from there, so the kit drives the pair over a
     * repair AND over a condition report instead of over whichever one a fixture
     * happened to name.
     */
    permission: { key: 'workorder:read', entityFrom: 'entityType', idFrom: 'entityId' },
    input: timelineInput,
    // The KERNEL's shape (#800) — `readTimeline` owns the walk and therefore the
    // entry, including `actor` as the union the spine recorded rather than the
    // stored JSON this used to publish as a string.
    output: timelineEntry,
    // Handler-composed: this walks `_substrat_outbox`, a KERNEL table. It is not
    // a declared entity and never will be — rule 3 permits a projection read of
    // the spine, not a registry entry over it.
    //
    // The cursor is `id`: the event's ULID, which is also this repair's version
    // at that point (#901). It said `occurred_at` while the handler walked the
    // rowid — a disagreement `sortKey` could not catch, because both were fields
    // and neither was the cursor.
    paged: { sortKey: 'id' },
  },
});

/**
 * The workorder engine's operations, at Handlebar's URLs.
 *
 * `workorder/close` is deliberately absent, and this is the one binding list in the
 * repo where that absence is load-bearing: the engine's default binding is WITHDRAWN
 * in this host (`src/module.ts`), because a repair is not closed until the customer
 * has counter-signed the tillståndsrapport. `bike-shop/close-repair` is the only
 * door, and binding the engine's here would reopen the one this vertical shut.
 */
export const handlebarWorkorderRoutes = defineEngineRoutes(workorderOperations)({
  'workorder/list': { method: 'GET', path: '/repairs' },
  'workorder/get': { method: 'GET', path: '/repairs/{orderId}' },
  'workorder/assign': { method: 'POST', path: '/repairs/{orderId}/assign' },
  'workorder/start': { method: 'POST', path: '/repairs/{orderId}/start' },
  'workorder/report-time': { method: 'POST', path: '/repairs/{orderId}/time' },
  'workorder/report-material': { method: 'POST', path: '/repairs/{orderId}/material' },
});

/**
 * The protocol engine's operations, at Handlebar's URLs.
 *
 * `protocol/list-for-entity` is absent for the reason Callout gives at length: it
 * takes an entity-agnostic `entityType`, and binding it would let a caller list the
 * protocols on anything at all. `GET /repairs/{id}/protocols` supplies that constant
 * by hand, and stays hand-written.
 *
 * `protocol/countersign` IS bound — the customer's counter-signature at pickup is
 * this vertical's whole reason for existing.
 */
export const handlebarProtocolRoutes = defineEngineRoutes(protocolOperations)({
  'protocol/list-templates': { method: 'GET', path: '/protocol-templates' },
  'protocol/get': { method: 'GET', path: '/protocols/{instanceId}' },
  'protocol/fill': { method: 'POST', path: '/protocols/{instanceId}/responses' },
  'protocol/sign': { method: 'POST', path: '/protocols/{instanceId}/sign' },
  'protocol/countersign': { method: 'POST', path: '/protocols/{instanceId}/countersign' },
  'protocol/void': { method: 'POST', path: '/protocols/{instanceId}/void' },
});

/** The invoicing engine's operations, at Handlebar's URLs. All three. */
export const handlebarInvoicingRoutes = defineEngineRoutes(invoicingOperations)({
  'invoicing/list': { method: 'GET', path: '/invoicing' },
  'invoicing/get': { method: 'GET', path: '/invoicing/{underlagId}' },
  'invoicing/export': { method: 'POST', path: '/invoicing/{underlagId}/export' },
});
