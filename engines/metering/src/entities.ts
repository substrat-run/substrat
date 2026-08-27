import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-metering's entities (#697/#707), landed for #865's tail.
 *
 * Three of the four tables are entities and one deliberately is not.
 *
 * - **`metering-meter`** is what the platform points at when a meter is
 *   configured — `metering.meter-configured` names it as its `EntityRef`, and it
 *   has always used that spelling. Keyed by `key` rather than a ULID, which is
 *   the point of a meter: `api.calls` is the same meter in every scope that
 *   configures one.
 * - **`metering-entry`** is one observation in the append-only ledger. An entity
 *   because it has an id and a lifetime of its own — a dedupe replay returns the
 *   existing one rather than writing a second.
 * - **`metering-period`** is a close: immutable once written, and the thing a
 *   vertical reads back to price.
 * - **`metering_period_lines`** is NOT an entity. A line is a period's frozen
 *   aggregate for one meter — it has no identity outside the close that made it,
 *   nothing ever refers to one, and an `EntityRef` to a line would be a reference
 *   to a third of a period.
 *
 * No `parents`. An entry's `subject` is an opaque `EntityRef` into whatever the
 * VERTICAL is metering — a tenant, a site, a robot — so the edge is the
 * vertical's to declare and this engine cannot know it. A period's lines are the
 * period's own rows rather than children.
 */
export const meteringEntities = defineEntities({
  'metering-meter': {
    table: 'metering_meters',
    fields: z.object({
      key: z.string(),
      kind: z.enum(['counter', 'gauge']),
      unit: z.string(),
      description: z.string().nullable(),
      active: z.number(),
      created_at: z.string(),
    }),
  },
  'metering-entry': {
    table: 'metering_entries',
    fields: z.object({
      id: z.string(),
      meter_key: z.string(),
      qty: z.string(),
      subject_type: z.string().nullable(),
      subject_id: z.string().nullable(),
      occurred_at: z.string(),
      dedupe_key: z.string(),
      note: z.string().nullable(),
      created_by: z.string(),
      created_at: z.string(),
    }),
  },
  'metering-period': {
    table: 'metering_periods',
    fields: z.object({
      id: z.string(),
      from_at: z.string(),
      to_at: z.string(),
      closed_by: z.string(),
      closed_at: z.string(),
    }),
  },
});

/** The stored meter row — for a vertical declaring a return against it. */
export const meterRow = meteringEntities['metering-meter'].fields;
/** One observation in the ledger, as stored. */
export const entryRow = meteringEntities['metering-entry'].fields;
/** One close, as stored. */
export const periodRow = meteringEntities['metering-period'].fields;
