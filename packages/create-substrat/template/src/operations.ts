import { defineEngineRoutes, defineOperations, money, timelineEntry, z } from '@substrat-run/contracts';
import { invoicingOperations } from '@substrat-run/engine-invoicing';
import {
  billableLine,
  workOrder,
  workorderEntities,
  workorderOperations,
} from '@substrat-run/engine-workorder';
import { bikeShopEntities } from './entities.js';

// ============================================================================
// The bike shop's DECLARED OPERATION SURFACE — what each operation accepts,
// what it answers with, which permission gates it, and where it lives in the
// HTTP API.
//
// This is one declaration, not documentation of another one. `src/module.ts`
// binds its handlers to this object with `satisfies OperationImpl<…>`, so four
// things become compile errors at the exact method: a handler whose input
// disagrees with `input`, one whose return disagrees with `output`, an
// operation declared and not implemented, and one implemented and not declared.
// `operationInputsOf(bikeShopOperations)` hands the host the same schemas, so
// every invocation is parsed before the guards and the handler — and
// `mountOperations` (src/routes.ts) derives the route table from the `http`
// each operation declares, so a `{var}` in a path that names no input field is
// a compile error too, and there is no second list of routes to drift.
// ============================================================================

/**
 * The permission keys an operation here may name.
 *
 * Two of them are this vertical's own (they mirror `SHOP_PERM` in
 * `src/manifest.ts`); the rest belong to the ENGINES this vertical composes. An
 * engine key is listed because a vertical operation may be gated by one — this
 * is the vocabulary a `permission` may draw on, not a second declaration of who
 * owns the key. The engine still declares them.
 *
 * One array, two readers, and that is what makes it checked (#1208).
 * `defineOperations` takes it below as the union a mistyped `permission:` fails
 * against; `definePermissions` in `src/provision.ts` takes the SAME array as
 * `keys` and throws at module load if it and `MODULES` disagree in either
 * direction. So every key a registered module declares is here, including the
 * ones no shop operation checks today — `MODULES` registers both engines, so a
 * scope declares them, and an operation gated on one had no way to say so while
 * the list held only the subset the shop happened to check.
 */
export const SHOP_PERMISSIONS = [
  // The shop's own — `SHOP_PERM` in src/manifest.ts.
  'customer:manage',
  'bike:manage',
  // @substrat-run/engine-workorder
  'workorder:create',
  'workorder:read',
  'workorder:assign',
  'workorder:report',
  'workorder:complete',
  'workorder:close',
  // @substrat-run/engine-invoicing
  'invoicing:read',
  'invoicing:export',
] as const;

/**
 * The engine entity registries this vertical composes — `defineOperations`'s
 * third argument, and what lets `shop/timeline` narrow its check to a
 * `workorder` rather than settling for a node-level check on a key of its own.
 */
const SHOP_ENGINE_ENTITIES = [workorderEntities] as const;

/**
 * A price-list row. A TABLE, not an entity (see `src/entities.ts`), so its shape
 * is declared here rather than in the registry.
 */
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
 * Shop policy: a timeline is read for a repair. Declared once here and parsed by
 * the host — the handler never re-parses it, which is the point of the model
 * being TypeScript rather than prose.
 *
 * `entityType` is a literal rather than an open string. The handler is genuinely
 * entity-agnostic — `ctx.check` is handed whatever ref the caller names — but
 * "any entity at all" was never what the vertical meant, and an open string
 * would cost the permission declaration below its accuracy.
 */
export const timelineInput = z.object({
  entityType: z.literal('workorder'),
  entityId: z.string().min(1),
});

export const bikeShopOperations = defineOperations(
  bikeShopEntities,
  SHOP_PERMISSIONS,
  SHOP_ENGINE_ENTITIES,
)({
  'shop/create-customer': {
    summary: 'Register a workshop customer',
    permission: 'customer:manage',
    input: z.object({
      number: z.string().min(1),
      name: z.string().min(1),
      phone: z.string().min(1).optional(),
    }),
    // The row shape comes from the registry — not restated here.
    output: bikeShopEntities.customer.fields,
    http: { method: 'POST', path: '/customers' },
  },
  'shop/list-customers': {
    summary: 'List customers with the bikes they have registered',
    permission: 'customer:manage',
    http: { method: 'GET', path: '/customers' },
    // The ENTRY, not the envelope — `paged` wraps it. The page also BOUNDS the
    // hydration: one bikes query per customer ON THE PAGE, where an unpaged read
    // ran one per customer in the scope.
    output: bikeShopEntities.customer.fields.extend({
      bikes: z.array(bikeShopEntities.bike.fields),
    }),
    // Handler-composed, keyset over the customer's natural key. A list read that
    // answered with the whole table would be a bug with a delay on it: it passes
    // review, it passes tests, and then one workshop's table gets large.
    paged: { sortKey: 'number' },
  },
  'shop/register-bike': {
    summary: 'Register a bike against a customer',
    permission: 'bike:manage',
    input: z.object({
      customerId: z.string().min(1),
      label: z.string().min(1),
      frameNo: z.string().min(1).optional(),
    }),
    output: bikeShopEntities.bike.fields,
    // `{customerId}` must name an input field, and the compiler checks that it does.
    http: { method: 'POST', path: '/customers/{customerId}/bikes' },
  },
  'shop/upsert-price': {
    summary: 'Create or update a price-list article',
    permission: 'customer:manage',
    input: z.object({
      article: z.string().min(1),
      description: z.string().min(1),
      unit: z.string().min(1),
      priceAmount: z.string().min(1),
      currency: z.string().min(1).optional(),
      minQty: z.string().min(1).optional(),
      internal: z.boolean().optional(),
    }),
    output: priceRow,
    http: { method: 'POST', path: '/prices' },
  },
  'shop/price-list': {
    summary: 'The workshop price list',
    permission: 'customer:manage',
    output: priceRow,
    http: { method: 'GET', path: '/prices' },
    // Handler-composed rather than `over`: `shop_price_list` is value-keyed and
    // deliberately not a declared entity, so the registry has no table for the
    // kernel to index. It still pages, and still carries a cursor.
    paged: { sortKey: 'article' },
  },
  'shop/create-repair': {
    summary: 'Open a repair against a bike',
    // An ENGINE key: the vertical owns the word "repair", the engine owns the
    // work order it is.
    permission: 'workorder:create',
    input: z.object({
      bikeId: z.string().min(1),
      kind: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
    }),
    // The engine's published type, not a transcription of it. Note `workOrder`
    // and NOT the row: the engine stores `facility_type`/`facility_id` as two
    // snake_case columns and publishes one `EntityRef` in camelCase.
    output: workOrder,
    http: { method: 'POST', path: '/repairs' },
  },
  'shop/complete-repair': {
    summary: 'Complete a repair and price its billable lines',
    permission: 'workorder:complete',
    input: z.object({ orderId: z.string().min(1) }),
    output: z.object({ order: workOrder, billable: z.array(billableLine), total: money }),
    http: { method: 'POST', path: '/repairs/{orderId}/complete' },
  },
  'shop/close-repair': {
    summary: 'Hand the bike back — completed to closed',
    permission: 'workorder:close',
    input: z.object({ orderId: z.string().min(1) }),
    output: workOrder,
    http: { method: 'POST', path: '/repairs/{orderId}/close' },
  },
  'shop/portal-repairs': {
    summary: 'The repairs visible to the calling portal customer',
    /**
     * No node-level permission, stated rather than left as an absence: a portal
     * customer holds an entity-narrowed `workorder:read` on their own customer
     * record and nothing at the node, so a blanket check would deny every one of
     * them. Visibility is decided per row by the proof walk instead.
     */
    narrows: {
      reason: 'a portal customer sees their own repairs, not a denial',
      // Walks on `workorder:read` alone — an engine key, declared by the engine.
      checks: [],
    },
    output: workOrder,
    // Handler-composed, and it has to be: visibility here is decided by a
    // per-row walk, not by a column, so there is no `WHERE` the kernel could
    // compose. It pages by OVER-fetching, so a SHORT page does not end the walk
    // — only an absent cursor does.
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/portal/repairs' },
  },
  'shop/timeline': {
    summary: 'The event timeline for one repair',
    /**
     * `workorder:read` ON THE ENTITY named, not at the node. A `mechanic` holds
     * `workorder:read` and a portal customer holds it narrowed to their own
     * customer record; both reach a repair's timeline through the walk
     * (workorder → bike → customer), and neither would pass a node check.
     */
    permission: { key: 'workorder:read', entity: 'workorder', idFrom: 'entityId' },
    input: timelineInput,
    // The KERNEL's shape, not a fourth copy of it: `readTimeline` decodes the
    // envelope, and `actor` is a union the spine recorded rather than the raw
    // string a hand-rolled `SELECT actor` returns.
    output: timelineEntry,
    // The cursor is `id` — the event's ULID, which IS this entity's version at
    // that point.
    paged: { sortKey: 'id' },
    // The path carries `entityId` alone. `entityType` is the literal above, and
    // `mountOperations` PINS a literal — it goes into the payload before anything
    // the caller sent, so a caller cannot talk this route into another entity type.
    http: { method: 'GET', path: '/repairs/{entityId}/timeline' },
  },
});

/**
 * Where the composed engines' operations live in this vertical's API.
 *
 * An engine declares no `http`, and should not: it is entity-agnostic and does
 * not own a URL shape — this shop calls a work order a repair, and the path is
 * the shop's decision. A binding is a name and a path; the summary, the input
 * schema and the return shape all come from the engine, so nothing here
 * restates anything. Bind a `{var}` the engine's input does not accept and it
 * does not compile; bind a name the engine does not have and it throws when the
 * module loads.
 *
 * `workorder/complete` and `workorder/close` are deliberately NOT bound: the
 * shop wraps them (`shop/complete-repair` owns the pricing moment,
 * `shop/close-repair` the handback) and a route straight to the engine would
 * skip that. Which operations are the vertical's and which are the engine's,
 * invoked directly, is the composition boundary — visible right here.
 */
export const bikeShopEngineRoutes = defineEngineRoutes(workorderOperations)({
  'workorder/list': { method: 'GET', path: '/repairs' },
  'workorder/get': { method: 'GET', path: '/repairs/{orderId}' },
  'workorder/assign': { method: 'POST', path: '/repairs/{orderId}/assign' },
  'workorder/start': { method: 'POST', path: '/repairs/{orderId}/start' },
  'workorder/report-time': { method: 'POST', path: '/repairs/{orderId}/time' },
  'workorder/report-material': { method: 'POST', path: '/repairs/{orderId}/material' },
});

/**
 * The invoicing engine's operations (the sibling engine, fed by event). All
 * three, because this engine's callable surface is reads and one export — there
 * is nothing to create, so there is no constant for the shop to pin.
 */
export const bikeShopInvoicingRoutes = defineEngineRoutes(invoicingOperations)({
  'invoicing/list': { method: 'GET', path: '/invoicing' },
  'invoicing/get': { method: 'GET', path: '/invoicing/{underlagId}' },
  'invoicing/export': { method: 'POST', path: '/invoicing/{underlagId}/export' },
});
