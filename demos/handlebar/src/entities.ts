import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * Handlebar's entities (#697). The second adopter, chosen because its permission
 * walk is the one that crosses the ownership boundary:
 *
 *   customer → bike → workorder → protocol
 *   └─ local ─┘      └── engine-owned ──┘
 *
 * `bike → customer` is entirely this vertical's, so it is derived from the
 * `parent` declaration below. `workorder → bike` is the MIXED edge — the child
 * is engine-workorder's, the parent is ours — and `protocol → workorder` is
 * neither's. Both live in the manifest, in fields that say which halves are
 * checked. See `manifest`'s `foreignChildOf` / `foreignChildren`.
 *
 * As in Callout: not every table is an entity. `bike_shop_price_list` is keyed
 * by article, is never the subject of an `EntityRef`, and is never a
 * permission-walk node.
 *
 * Field names mirror the SQL columns verbatim — a second, prettier naming would
 * be exactly the second description this exists to remove. `test/entities.test.ts`
 * holds the two to each other until migrations are derived from here.
 */
export const handlebarEntities = defineEntities({
  customer: {
    table: 'bike_shop_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      phone: z.string().nullable(),
      created_at: z.string(),
    }),
    /** UNIQUE in 0001-init — the number a human quotes over the counter. */
    key: ['number'],
    /**
     * A bike-shop customer is a private person essentially always, so both the
     * name and the phone are erasure-reachable (§12).
     */
    erasable: ['name', 'phone'],
  },
  bike: {
    table: 'bike_shop_bikes',
    fields: z.object({
      id: z.string(),
      customer_id: z.string(),
      label: z.string(),
      frame_no: z.string().nullable(),
      created_at: z.string(),
    }),
    /** Permission flows bike → customer; `entityRelations` is derived from this. */
    parents: ['customer'],
    /**
     * A frame number identifies a bike, and a bike identifies its owner — it is
     * the serial a police report quotes. Pseudonymous rather than direct, but
     * an erasure that left it behind would leave a pointer to the person.
     */
    erasable: ['frame_no'],
  },
});

/**
 * The artifact of record. `tools/model-diff.mts` reads this rather than
 * importing `@substrat-run/contracts` itself — a root tool depending on the
 * packages it inspects would be a cycle.
 */
export const handlebarModel = emitModel(handlebarEntities);
