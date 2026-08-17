import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-workorder's entity (#697/#707).
 *
 * A composing vertical needs the entity-type constant — Handlebar declares
 * `{ entityType: 'workorder', parentType: 'bike' }`, Callout leaves it at the
 * engine's `facility` — and the row schema, so an operation returning a work
 * order can declare an `output` without transcribing this engine's shape.
 *
 * ## `parents` is where the plural came from
 *
 * This engine declares `workorder → facility`. Handlebar declares
 * `workorder → bike`. Those do **not** conflict: `entityRelations` is an
 * allowlist, the kernel accumulates permitted parents into a set per entity
 * type, and `ctx.link` checks membership. In Handlebar's scope a work order may
 * hang off either, and the `facility` option is simply never exercised because
 * Handlebar has no facilities.
 *
 * `facility` is declared here and owned by nobody in particular: it is the
 * vertical's noun, and this engine names it as the conventional parent without
 * being able to check it. That is the honest state until `manifestEntities`
 * accepts engine registries and foreign names become checkable.
 *
 * ## One entity, three tables
 *
 * `workorder` is the thing the platform points at. Time entries and material
 * lines are rows this engine owns and totals — never the subject of an
 * `EntityRef`.
 */
export const workorderEntities = defineEntities({
  workorder: {
    table: 'workorder_orders',
    fields: z.object({
      id: z.string(),
      number: z.number(),
      /** The parent ref, entity-agnostic: a facility in Callout, a bike in Handlebar. */
      facility_type: z.string(),
      facility_id: z.string(),
      customer_type: z.string(),
      customer_id: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      status: z.enum(['planned', 'in_progress', 'completed', 'closed']),
      assigned_to: z.string().nullable(),
      created_by: z.string(),
      created_at: z.string(),
      completed_at: z.string().nullable(),
    }),
    // No `parents` here: the parent is the VERTICAL's noun. The manifest's
    // `entityRelations` still names `facility` as the conventional one, and that
    // stays a hand-written edge until foreign names are checkable.
  },
});

/**
 * The STORED row shape. Not what operations return — `workOrder` is that.
 *
 * The two differ: this carries `facility_type` / `facility_id` as separate
 * snake_case columns, where the published type composes them into one
 * `EntityRef` and uses camelCase. An earlier version of this comment said this
 * schema was for declaring an operation's `output`, which was wrong.
 */
export const workorderRow = workorderEntities.workorder.fields;
