import { defineEntities, emitModel, z } from '@substrat-run/contracts';

// ============================================================================
// The bike shop's ENTITY REGISTRY — what this vertical declares exists.
//
// This is the first half of the declared model: the entities, and then
// `src/operations.ts` declares the operations against them. The compiler checks
// the joins between the two, so an operation narrowing to an entity that does
// not exist, or emitting about a field the output does not carry, is a build
// error rather than something a reviewer has to notice.
//
// Field names mirror the SQL columns verbatim, snake_case included. They are the
// row shape as `ctx.sql` returns it, not a prettier domain model — a second
// naming would be exactly the second description this exists to remove.
// ============================================================================

/**
 * NOT every table is an entity. `shop_price_list` is a table — keyed by article,
 * no id, never the subject of an `EntityRef`, never a node in a permission walk
 * — so it is deliberately absent here, and its row shape lives beside the
 * operations that return it instead.
 *
 * An entity is a thing the platform can point AT: attachments hang off one,
 * grants narrow to one, events are about one. The price list is data those
 * things operate on.
 */
export const bikeShopEntities = defineEntities({
  customer: {
    table: 'shop_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      phone: z.string().nullable(),
      created_at: z.string(),
    }),
    /** `number` is UNIQUE in 0001-init — the natural key a human quotes. */
    key: ['number'],
    /**
     * A workshop customer is usually a private person, so their name and phone
     * are erasure-reachable. Declaring it is what keeps an event payload from
     * ever carrying them: an immutable event is the one place in a scope an
     * erasure cannot reach, and the compiler enforces the omission.
     */
    erasable: ['name', 'phone'],
  },
  bike: {
    table: 'shop_bikes',
    fields: z.object({
      id: z.string(),
      customer_id: z.string(),
      label: z.string(),
      frame_no: z.string().nullable(),
      created_at: z.string(),
    }),
    /**
     * Permission flows bike → customer, which is the first hop of the portal
     * walk (workorder → bike → customer). The manifest declares the same edge
     * for `ctx.link`; this is the model's half of it.
     */
    parents: ['customer'],
    /**
     * A frame number identifies a bike, and a bike identifies its owner — it is
     * the serial a police report quotes. Pseudonymous rather than direct, which
     * is exactly why it is easy to leave out: an erasure that kept it would
     * leave a pointer to the person it just erased. Declaring it here is what
     * keeps a future `bike.*` event payload from carrying it, since an immutable
     * event is the one place in a scope an erasure cannot reach.
     */
    erasable: ['frame_no'],
  },
});

/**
 * The artifact of record, emitted from the declaration above.
 *
 * A scaffolded project is not in this repo's `demos/`, so nothing here re-emits
 * a `model.json` for it — `pnpm lint:model` walks `demos/` and `engines/`. What
 * this export is for in a scaffold is the same thing it is for in the reference
 * verticals: one object downstream reads, so the authoring notation stays
 * swappable.
 */
export const bikeShopModel = emitModel(bikeShopEntities);
