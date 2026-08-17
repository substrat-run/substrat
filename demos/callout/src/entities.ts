import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * Callout's entities (#697). The first adopter of the registry.
 *
 * NOT every table is an entity. `callout_price_list` is a table — keyed by
 * article, no id, never the subject of an `EntityRef`, never a permission-walk
 * node — so it is deliberately absent. An entity is a thing the platform can
 * point at: attachments hang off one, grants narrow to one, events are about
 * one. The price list is data those things operate on.
 *
 * Nothing is derived from this yet — the migration journal is still the source
 * of the tables, and `test/entities.test.ts` holds the two descriptions to each
 * other rather than letting them drift. Deriving the DDL from here is
 * #680/#685's step 2; until then the registry's job is to give the manifest's
 * entity names something to be checked against.
 *
 * Field names mirror the SQL columns verbatim, snake_case included. They are the
 * row shape as `ctx.sql` returns it, not a domain model — a second, prettier
 * naming would be exactly the second description this exists to remove.
 */
export const calloutEntities = defineEntities({
  customer: {
    table: 'callout_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      org_ref: z.string().nullable(),
      created_at: z.string(),
    }),
    /** `number` is UNIQUE in 0001-init — the natural key a human quotes. */
    key: ['number'],
    /**
     * A customer may be a private person, so the name is erasure-reachable
     * (§12). Callout emits no events today, so nothing can leak it yet; the
     * declaration is what makes that stay true when it does.
     */
    erasable: ['name'],
  },
  facility: {
    table: 'callout_facilities',
    fields: z.object({
      id: z.string(),
      customer_id: z.string(),
      name: z.string(),
      address: z.string().nullable(),
      access_note: z.string().nullable(),
      created_at: z.string(),
    }),
    /** Permission flows facility → customer; `entityRelations` is derived from this. */
    parent: 'customer',
    /** A site address for a private customer is their home address. */
    erasable: ['address'],
  },
});

/**
 * The artifact of record, emitted from the declaration above.
 *
 * `tools/model-diff.mts` reads THIS rather than importing `@substrat-run/contracts`
 * itself — a root tool that depended on the packages it inspects would be a cycle,
 * which is the same reason `tools/permission-diff.mts` reads structurally.
 */
export const calloutModel = emitModel(calloutEntities);
