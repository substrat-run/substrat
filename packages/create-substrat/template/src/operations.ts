import { defineOperations, money, timelineEntry, z } from '@substrat-run/contracts';
import { billableLine, workOrder, workorderEntities } from '@substrat-run/engine-workorder';
import { bikeShopEntities } from './entities.js';

// ============================================================================
// The bike shop's DECLARED OPERATION SURFACE — what each operation accepts,
// what it answers with, and which permission gates it.
//
// This is one declaration, not documentation of another one. `src/module.ts`
// binds its handlers to this object with `satisfies OperationImpl<…>`, so four
// things become compile errors at the exact method: a handler whose input
// disagrees with `input`, one whose return disagrees with `output`, an
// operation declared and not implemented, and one implemented and not declared.
// `operationInputsOf(bikeShopOperations)` hands the host the same schemas, so
// every invocation is parsed before the guards and the handler.
// ============================================================================

/**
 * The permission keys an operation here may name.
 *
 * Two of them are this vertical's own (they mirror `SHOP_PERM` in
 * `src/manifest.ts`); the other four are the WORKORDER ENGINE's. An engine key
 * is listed because a vertical operation may be gated by one — this is the
 * vocabulary a `permission` may draw on, not a second declaration of who owns
 * the key. The engine still declares them.
 */
export const SHOP_PERMISSIONS = [
  'customer:manage',
  'bike:manage',
  'workorder:create',
  'workorder:read',
  'workorder:complete',
  'workorder:close',
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
  },
  'shop/list-customers': {
    summary: 'List customers with the bikes they have registered',
    permission: 'customer:manage',
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
  },
  'shop/price-list': {
    summary: 'The workshop price list',
    permission: 'customer:manage',
    output: priceRow,
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
  },
  'shop/complete-repair': {
    summary: 'Complete a repair and price its billable lines',
    permission: 'workorder:complete',
    input: z.object({ orderId: z.string().min(1) }),
    output: z.object({ order: workOrder, billable: z.array(billableLine), total: money }),
  },
  'shop/close-repair': {
    summary: 'Hand the bike back — completed to closed',
    permission: 'workorder:close',
    input: z.object({ orderId: z.string().min(1) }),
    output: workOrder,
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
  },
});
