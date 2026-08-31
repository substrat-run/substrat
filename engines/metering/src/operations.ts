/**
 * The metering engine's declared operation surface (#865, #891's recipe applied
 * to the last three packages that had none).
 *
 * ## Why this file exists now
 *
 * It used to not, and the cost was stated rather than hidden: this engine's
 * node-only claim was a `nodeOnlySuite` tripwire — a grep of `index.ts` for a
 * two-argument `ctx.check`. That proves an absence, never a behaviour, and it is
 * lexical: a check assembled through a helper is invisible to it. A DECLARATION
 * is exact. `planEntityCheckCoverage` reads these eight entries the same way the
 * conformance kit does, so "this engine narrows nowhere" is a fact about the
 * surface rather than about the text, and the day one of them narrows the
 * assessment goes red.
 *
 * ## Every check is a node check, and that is the design
 *
 * Metering counts what a scope consumed. A meter is scope-level configuration,
 * `record` is machine-driven ingest, and a period closes for the scope as a
 * whole — none of the four keys has a per-entity reader. A principal entitled to
 * see one meter's usage and not another's is a reporting concern in the vertical
 * above, expressed by what it queries rather than by narrowing the engine's own
 * checks. Note what would change that: an entry's `subject` is an opaque
 * `EntityRef` into the vertical's own noun, so if a per-subject read is ever
 * wanted it is the VERTICAL that owns the edge and the walk.
 *
 * ## Shapes are the PUBLISHED ones, not the rows
 *
 * The outputs here are the camelCase projections the in-scope functions return
 * (`Meter`, `UsageEntry`, `MeteringPeriod`, `PeriodLine`), not the snake_case
 * rows in `entities.ts`. Both exist on purpose: the registry describes what is
 * STORED (which is what a migration journal is compared against), and these
 * describe what a caller receives.
 *
 * No `http` — an engine owns no URL shape. A vertical binds these names to its
 * own paths with `defineEngineRoutes`.
 */
import { defineOperations, entityRef, z } from '@substrat-run/contracts';
import { meteringEntities } from './entities.js';
import { isoInstantIn, signedDecimal } from './formats.js';

/** The keys these operations check. Mirrors `PERM` in index.ts. */
export const METERING_PERMISSIONS = [
  'metering:read',
  'metering:record',
  'metering:configure',
  'metering:close',
] as const;

/** A quantity, always a decimal STRING — never a float (D-E, contracts' money rule). */
const qty = signedDecimal;

/** What `configureMeter`/`listMeters` return: the meter, projected. */
export const meter = z.object({
  key: z.string(),
  kind: z.enum(['counter', 'gauge']),
  unit: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});

/** One observation in the append-only ledger, projected. */
export const usageEntry = z.object({
  id: z.string(),
  meterKey: z.string(),
  qty,
  subject: entityRef.nullable(),
  occurredAt: z.string(),
  dedupeKey: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});

/** One close, projected. */
export const meteringPeriod = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  closedBy: z.string(),
  closedAt: z.string(),
});

/** One meter's frozen aggregate for a closed period. Unpriced, by design (D-E). */
export const periodLine = z.object({
  meterKey: z.string(),
  kind: z.enum(['counter', 'gauge']),
  unit: z.string(),
  qty,
  entryCount: z.number(),
});

/**
 * An instant as the operations accept one.
 *
 * The VALIDATING half of the storage schema, shared through `formats.ts` — the
 * same strings, without the transform that normalises to millisecond precision.
 * Non-transforming on purpose: a transforming schema at the door would hand the
 * handler a value the in-scope function then re-parses, and a declared input
 * describes what a caller may send rather than what will be stored.
 *
 * What it must NOT be is looser than the handler. It was `z.string().min(1)`,
 * so `"not-a-date"` passed the boundary parse the host applies and was refused
 * by `isoInstant.parse` inside — a contract saying a value is valid and a
 * handler disagreeing after the guards ran.
 */
const instantIn = isoInstantIn;

export const meteringOperations = defineOperations(meteringEntities, METERING_PERMISSIONS)({
  'metering/configure-meter': {
    summary: 'Register a meter, or update its description and active flag',
    permission: 'metering:configure',
    input: z.object({
      key: z.string().min(1),
      kind: z.enum(['counter', 'gauge']),
      unit: z.string().min(1),
      description: z.string().optional(),
      active: z.boolean().optional(),
    }),
    output: meter,
  },

  'metering/list-meters': {
    summary: 'Every configured meter, by key',
    permission: 'metering:read',
    output: meter,
    // Handler-composed (#959): what is answered is the PROJECTION of the row
    // (`active` as a boolean, `createdAt` renamed), not the stored row, so
    // `paged.over` has nothing to walk. `key` is the primary key — the order and
    // a unique cursor at once.
    paged: { sortKey: 'key' },
  },

  'metering/record': {
    summary: 'Record one usage observation — idempotent per (meter, dedupeKey)',
    permission: 'metering:record',
    input: z.object({
      meter: z.string().min(1),
      /**
       * Counters take signed deltas (a correction is a compensating entry, never
       * an edit); gauges take non-negative level samples. The per-kind half is
       * enforced by the handler, which knows the meter — a declared input cannot,
       * and claiming otherwise here would be a schema that reads stricter than it
       * is. The DECIMAL half is not per-kind and belongs here: `"-"` used to reach
       * a handler that then refused it.
       */
      qty: signedDecimal,
      subject: entityRef.optional(),
      /**
       * Defaults to the operation's own instant, and the handler bounds it on
       * BOTH sides (#1066): never behind the close horizon, whose period is
       * frozen, and never more than a small skew tolerance ahead of `ctx.now()`,
       * because the horizon only moves forward and an entry past it is
       * aggregated by no close — usage that leaves the billing stream silently.
       * Like the per-kind `qty` rule above, that is a fact about stored state
       * rather than about the string, so it lives in the handler and is stated
       * here rather than claimed by the schema.
       */
      occurredAt: instantIn.optional(),
      dedupeKey: z.string().min(1),
      note: z.string().optional(),
    }),
    // `deduped` is the fact a caller branches on: a replay is not an error, and a
    // caller that cannot tell the two apart cannot report either honestly.
    output: z.object({ entry: usageEntry, deduped: z.boolean() }),
  },

  'metering/total': {
    summary: 'Aggregate one meter over [from, to)',
    permission: 'metering:read',
    input: z.object({ meter: z.string().min(1), from: instantIn, to: instantIn }),
    // Null when the window holds nothing — distinct from a zero total, which a
    // counter with compensating entries can legitimately produce.
    output: z.object({ qty, entryCount: z.number() }).nullable(),
  },

  'metering/list-entries': {
    summary: 'The ledger, filtered by meter, subject or window',
    permission: 'metering:read',
    input: z.object({
      meter: z.string().min(1).optional(),
      subject: entityRef.optional(),
      from: instantIn.optional(),
      to: instantIn.optional(),
    }),
    inputOptional: true,
    output: usageEntry,
    // The ledger is the read most obviously unbounded — one row per observation,
    // for as long as the meter has run. Handler-composed: the entry is a
    // projection (two columns folded into one `subject` ref) and the `WHERE` is
    // built from four optional filters. `occurredAt` is caller-supplied and NOT
    // unique, so the cursor is the (occurredAt, id) pair the SQL already orders
    // by — see the handler.
    paged: { sortKey: 'occurredAt' },
  },

  'metering/close-period': {
    summary: 'Freeze [from, to) — aggregate every meter and advance the horizon',
    permission: 'metering:close',
    input: z.object({ from: instantIn, to: instantIn }),
    output: z.object({ period: meteringPeriod, lines: z.array(periodLine) }),
  },

  'metering/list-periods': {
    summary: 'Closed periods, oldest first',
    permission: 'metering:read',
    output: meteringPeriod,
    // Handler-composed: `from`/`to` are the projection of `from_at`/`to_at`.
    // Closes are non-overlapping so `from` is in practice unique, but the SQL
    // orders by (from_at, id) and the cursor matches it rather than relying on
    // that.
    paged: { sortKey: 'from' },
  },

  'metering/period-lines': {
    summary: "One period's frozen lines",
    permission: 'metering:read',
    input: z.object({ periodId: z.string().min(1) }),
    output: periodLine,
    // Handler-composed: the line is a projection, and the read 404s on an unknown
    // period before it lists anything. One line per meter per period, so
    // `meterKey` is unique within the period and is the order.
    paged: { sortKey: 'meterKey' },
  },
});
