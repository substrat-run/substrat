import { defineEngineRoutes, defineOperations, money } from '@substrat-run/contracts';
import { invoicingOperations } from '@substrat-run/engine-invoicing';
import { protocolInstanceRow, protocolOperations } from '@substrat-run/engine-protocol';
import { billableLine, workOrder, workorderOperations } from '@substrat-run/engine-workorder';
import { z } from 'zod';
import { calloutEntities } from './entities.js';

/** The permission keys operations may require. Mirrors `SC_PERM` in manifest.ts. */
export const CALLOUT_PERMISSIONS = ['customer:manage', 'facility:manage'] as const;

/**
 * Callout policy: protocols live on work orders. Declared here and parsed by the
 * handler — the SAME object, which is the point of the model being TypeScript.
 */
export const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entityType: z.literal('workorder'),
  entityId: z.string().min(1),
});

/** A price-list row. A table, not an entity — so its shape lives here, not in the registry. */
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
 * Callout's declared operation surface (#707).
 *
 * ## Eleven of eleven
 *
 * Four of these return ENGINE types, and until the engines exported Zod schemas
 * for them a vertical could only have declared an `output` by transcribing the
 * engine's shape into Zod here — a description held in agreement by nothing, and
 * a wrong one worse than the `unknown` it replaced because it looks
 * authoritative. `protocolInstanceRow`, `workOrder` and `billableLine` removed
 * that, so the whole surface is declared.
 *
 * Note `workOrder`, NOT `workorderRow`: the engine stores `facility_type` and
 * `facility_id` as two snake_case columns and publishes one `EntityRef` in
 * camelCase. The row and the published type are different shapes, and only the
 * second is what an operation returns.
 *
 * `ApiOperationDoc.output` already carries the same "adopted incrementally" note.
 */
export const calloutOperations = defineOperations(calloutEntities, CALLOUT_PERMISSIONS)({
  'callout/whoami': {
    summary: "Report the caller's role in this scope",
    // No permission gates it: answering "what may I do" must work for everyone,
    // including a principal who may do nothing.
    narrows: {
      reason: 'every principal may ask what they themselves may do',
      // Also checks the workorder engine's `report`, which the ENGINE declares.
      checks: ['customer:manage'],
    },
    // No body at all.
    output: z.object({ role: z.enum(['office-admin', 'technician', 'none']) }),
  },
  'callout/create-customer': {
    summary: 'Register a customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string(), name: z.string(), orgRef: z.string().optional() }),
    // The row shape comes from the registry — not restated here.
    output: calloutEntities.customer.fields,
    http: { method: 'POST', path: '/customers' },
  },
  'callout/list-customers': {
    summary: 'List customers with their facilities',
    permission: 'customer:manage',
    // The ENTRY, not the envelope (#811) — `paged` wraps it, here and in the
    // emitted document, and the HTTP body stays the array it always was (#829).
    // The facilities are hydrated per entry by the handler, which the page also
    // BOUNDS: that ran once per customer in the scope and now runs once per
    // customer on the page.
    output: calloutEntities.customer.fields.extend({
      facilities: z.array(calloutEntities.facility.fields),
    }),
    paged: {
      over: { entity: 'customer', sortable: ['number', 'name', 'created_at'] },
      total: true,
    },
    http: { method: 'GET', path: '/customers' },
  },
  /**
   * The picker's read (#827). A separate operation rather than a `q` on
   * `list-customers`: search is capped and relevance-ordered, a list is sorted
   * and (once #811 lands) paged, and one endpoint cannot carry both contracts —
   * which is why Stripe ships `/v1/customers/search` beside `/v1/customers`.
   *
   * `GET /customers/search` does NOT collide with `/customers/{customerId}/…`:
   * `mountOperations` registers a static segment ahead of its parameter sibling
   * (#785), the same way OpenAPI resolves a concrete path before a templated one.
   */
  'callout/search-customers': {
    summary: 'Find customers by name or number',
    permission: 'customer:manage',
    input: z.object({
      // Two characters is the prefix index's floor, enforced here so a caller
      // gets a 400 naming the field rather than a throw from inside the kernel.
      q: z.string().min(2),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    // Not a bare array: a capped read has to say it was capped, or a picker
    // silently shows the first 20 of 200 matches as if that were all of them.
    output: z.object({
      results: z.array(calloutEntities.customer.fields),
      limit: z.number().int(),
      capped: z.boolean(),
    }),
    http: { method: 'GET', path: '/customers/search' },
  },
  'callout/create-facility': {
    summary: 'Register a facility for a customer',
    permission: 'facility:manage',
    input: z.object({
      customerId: z.string(),
      name: z.string(),
      address: z.string().optional(),
      accessNote: z.string().optional(),
    }),
    output: calloutEntities.facility.fields,
    http: { method: 'POST', path: '/customers/{customerId}/facilities' },
  },
  'callout/price-list': {
    summary: 'The current price list',
    permission: 'customer:manage',
    output: priceRow,
    // Handler-composed, not `over`: `callout_price_list` is a value-keyed table
    // and deliberately not a declared entity, so the registry has no table for
    // the kernel to index. It still pages and still carries a cursor.
    paged: { sortKey: 'article' },
    http: { method: 'GET', path: '/prices' },
  },
  'callout/upsert-price': {
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
  'callout/create-workorder': {
    summary: 'Open a work order against a facility',
    permission: 'customer:manage',
    input: z.object({
      facilityId: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }),
    output: workOrder,
    http: { method: 'POST', path: '/workorders' },
  },
  'callout/complete-workorder': {
    summary: 'Complete a work order and price its billable lines',
    permission: 'customer:manage',
    input: z.object({ orderId: z.string() }),
    output: z.object({ order: workOrder, billable: z.array(billableLine), total: money }),
    http: { method: 'POST', path: '/workorders/{orderId}/complete' },
  },
  'callout/instantiate-protocol': {
    summary: 'Instantiate a protocol against an entity',
    permission: 'customer:manage',
    // The handler's own schema, not a restatement of it.
    input: instantiateProtocolInput,
    output: protocolInstanceRow,
    // `entityType` is `z.literal('workorder')` in that schema, so the route
    // supplies it — this endpoint used to be hand-written for exactly that
    // reason, and the declaration had said it all along.
    http: { method: 'POST', path: '/workorders/{entityId}/protocols' },
  },
  'callout/portal-orders': {
    summary: "The work orders visible to the caller's portal",
    narrows: {
      reason: 'a portal caller sees their own orders, not a denial',
      // Walks on `workorder:read` alone — an engine key, declared by the engine.
      checks: [],
    },
    output: workOrder,
    // Handler-composed. Visibility here is decided by a per-row proof walk, not
    // by a column, so there is no `WHERE` the kernel could compose. It pages by
    // over-fetching (`pageVisible`): pages may come back short, and the walk ends
    // at the absent `Link` rather than at the first short page.
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/portal/orders' },
  },
  'callout/timeline': {
    summary: 'The event timeline for one entity',
    permission: 'customer:manage',
    input: z.object({ entityType: z.string(), entityId: z.string() }),
    output: z.object({ type: z.string(), occurred_at: z.string(), actor: z.string() }),
    // Handler-composed: `_substrat_outbox` is a KERNEL table. Rule 3 permits the
    // projection read; it does not make the spine a registry entity, so there is
    // nothing for `over` to name. The cursor is the rowid — append order is the
    // authority, and ids minted in one millisecond are not mutually ordered.
    paged: { sortKey: 'occurred_at' },
  },
});

/**
 * Where the composed engines' operations live in Callout's API (#738).
 *
 * These were 17 of Callout's 27 hand-written routes, and they had to be: an
 * engine declares no `http` because it does not own a URL shape — a bike shop
 * calls the same work order a repair. The path is the vertical's decision, and
 * this is where it gets declared.
 *
 * Now that the engine declares its operations, a binding is a name and a path:
 * the summary, the input schema and the return shape all come from the engine,
 * so nothing here restates anything. Bind a name it does not have, or a `{var}`
 * its input does not accept, and it does not compile.
 */
export const calloutEngineRoutes = defineEngineRoutes(workorderOperations)({
  'workorder/list': { method: 'GET', path: '/workorders' },
  'workorder/get': { method: 'GET', path: '/workorders/{orderId}' },
  'workorder/assign': { method: 'POST', path: '/workorders/{orderId}/assign' },
  'workorder/start': { method: 'POST', path: '/workorders/{orderId}/start' },
  'workorder/report-time': { method: 'POST', path: '/workorders/{orderId}/time' },
  'workorder/report-material': { method: 'POST', path: '/workorders/{orderId}/material' },
  'workorder/close': { method: 'POST', path: '/workorders/{orderId}/close' },
});

/**
 * The protocol engine's operations, at Callout's URLs (#739).
 *
 * Six of the eight protocol routes Callout serves. The two that are absent are
 * absent for one reason between them: a route that supplies a CONSTANT the
 * caller must not choose.
 *
 * - `POST /workorders/{id}/protocols` instantiates, and Callout's policy is that
 *   protocols live on work orders. That constant is already declared, as
 *   `entityType: z.literal('workorder')` on `callout/instantiate-protocol` —
 *   a vertical operation wrapping the engine, which `mountOperations` pins so a
 *   caller cannot talk the route out of it.
 * - `GET /workorders/{id}/protocols` needs the same constant and has no wrapper,
 *   so it stays hand-written. Binding `protocol/list-for-entity` here would put
 *   `entityType` in the query string and let a caller list the protocols on
 *   anything at all — the engine is entity-agnostic, and this is exactly where
 *   the vertical is supposed to stop being.
 */
export const calloutProtocolRoutes = defineEngineRoutes(protocolOperations)({
  'protocol/list-templates': { method: 'GET', path: '/protocol-templates' },
  'protocol/define-template': { method: 'POST', path: '/protocol-templates' },
  'protocol/get': { method: 'GET', path: '/protocols/{instanceId}' },
  'protocol/fill': { method: 'POST', path: '/protocols/{instanceId}/responses' },
  'protocol/sign': { method: 'POST', path: '/protocols/{instanceId}/sign' },
  'protocol/void': { method: 'POST', path: '/protocols/{instanceId}/void' },
});

/**
 * The invoicing engine's operations, at Callout's URLs (#739).
 *
 * All three, because this engine's callable surface is all reads and one export
 * — there is nothing to create, so there is no constant for a vertical to pin.
 */
export const calloutInvoicingRoutes = defineEngineRoutes(invoicingOperations)({
  'invoicing/list': { method: 'GET', path: '/invoicing' },
  'invoicing/get': { method: 'GET', path: '/invoicing/{underlagId}' },
  'invoicing/export': { method: 'POST', path: '/invoicing/{underlagId}/export' },
});
