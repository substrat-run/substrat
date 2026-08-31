/**
 * engine-metering — composed **by call**, not by event.
 *
 * The in-scope functions are the surface: `configureMeter`, `recordUsage`,
 * `closePeriod`, `usageTotal`, `listMeters`, `listEntries`, `listPeriods`,
 * `periodLines`. A vertical imports those into its own operations and runs them
 * inside its own transaction — ticket0 calls `recordUsage` in the same transaction
 * that produced the usage, so the ledger row and the work it bills for commit or
 * roll back together. (The builder reaches the same ledger through the registered
 * operations instead; both are callers, and neither composes by event.)
 *
 * By call rather than by event is deliberate. Usage arrives from the vertical's own
 * work, and an event round-trip would put the ledger write outside the transaction
 * that knows whether the work happened.
 *
 * There are no consumers here. Nothing composes this engine by emitting at it.
 */
import { z } from 'zod';
import {
  addDecimal,
  compareDecimal,
  CURSOR_FIELD_SEPARATOR,
  entityRef,
  moduleManifest,
  operationInputsOf,
  pageOverFold,
  permissionKey,
  type EntityRef,
  type ListPage,
  type Page,
  substratError,
} from '@substrat-run/contracts';

/**
 * The conflict reasons this engine raises — its own vocabulary, narrowing the platform's
 * `conflict` code (#113). Exported so a vertical can branch on WHY a refusal happened
 * without importing this engine's types or matching on its prose; `as const` so a typo
 * is a compile error here rather than a slug nobody ever matches.
 *
 * Additive only, like every other engine surface: new reasons may appear, existing ones
 * do not change spelling.
 */
export const METERING_CONFLICT_REASONS = [
  'dedupe_mismatch',
  'definition_frozen',
  'meter_inactive',
  'occurred_at_ahead',
  'period_closed',
  'period_overlap',
] as const;
export type MeteringConflictReason = (typeof METERING_CONFLICT_REASONS)[number];

/** `conflict(reason, message)` — reason first, so the classification reads before the prose. */
const conflict = (reason: MeteringConflictReason, message: string) => substratError('conflict', message, { reason });

import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The metering engine (docs/engines/metering.md, #646). Owns an
// APPEND-ONLY usage ledger over configured meters, idempotent ingest keyed by
// (meter, dedupe key), window aggregation (counters sum; gauges sample and
// carry forward), and an append-only period-close journal whose latest close is
// a hard horizon no new entry may land behind — a closed period's lines stay
// reproducible from its entries forever.
//
// It owns QUANTITIES, never prices: no currency, no rates, no plans (D-E) —
// pricing is vertical vocabulary, and the vertical feeds invoicing from the fat
// `metering.period-closed` event exactly like the timesheet hand-off. It is the
// BILLABLE plane; platform metering stays Analytics Engine (D-A).
// ============================================================================

// The entity registry + declared operation surface (#697/#865): what is stored,
// and what each operation checks and takes.
export { meteringEntities, meterRow, entryRow, periodRow } from './entities.js';
export {
  meteringOperations,
  METERING_PERMISSIONS,
  meter,
  usageEntry,
  meteringPeriod,
  periodLine,
} from './operations.js';
import { meteringOperations } from './operations.js';
// The value formats, shared with the declared surface above so a caller cannot be
// told a value is acceptable and then have the handler refuse it.
import { isoInstant, isoInstantIn, nonNegDecimal, signedDecimal } from './formats.js';
import { entryRow, meterRow, periodRow } from './entities.js';
import { columnsOf, returns } from './seam.js';

export const PERM = {
  read: permissionKey.parse('metering:read'),
  record: permissionKey.parse('metering:record'),
  configure: permissionKey.parse('metering:configure'),
  close: permissionKey.parse('metering:close'),
};

export const meteringManifest = moduleManifest.parse({
  id: '@substrat-run/engine-metering',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'metering:read', description: 'Read meters, usage entries, totals and closed periods' },
    { key: 'metering:record', description: 'Record usage entries against a meter' },
    { key: 'metering:configure', description: 'Configure meters (register keys; kind/unit are frozen after creation)' },
    { key: 'metering:close', description: 'Close a billing period, freezing its aggregates' },
  ],
  events: {
    emits: [
      { type: 'metering.meter-configured', schemaVersion: 1 },
      { type: 'metering.usage-recorded', schemaVersion: 1 },
      { type: 'metering.period-closed', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entityRelations: [],
  entitlementKey: 'metering',
  // No schedules: WHEN to close a period is billing policy — vertical
  // vocabulary. The vertical calls closePeriod from its own schedule.
  schedules: [],
});

export const meteringMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE metering_meters (
        key         TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('counter','gauge')),
        unit        TEXT NOT NULL,
        description TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE metering_entries (
        id           TEXT PRIMARY KEY,
        meter_key    TEXT NOT NULL,
        qty          TEXT NOT NULL,
        subject_type TEXT,
        subject_id   TEXT,
        occurred_at  TEXT NOT NULL,
        dedupe_key   TEXT NOT NULL,
        note         TEXT,
        created_by   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (meter_key, dedupe_key)
      );
      CREATE INDEX metering_entries_by_meter_time
        ON metering_entries (meter_key, occurred_at);
      CREATE TABLE metering_periods (
        id        TEXT PRIMARY KEY,
        from_at   TEXT NOT NULL,
        to_at     TEXT NOT NULL,
        closed_by TEXT NOT NULL,
        closed_at TEXT NOT NULL
      );
      CREATE TABLE metering_period_lines (
        id          TEXT PRIMARY KEY,
        period_id   TEXT NOT NULL,
        meter_key   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        unit        TEXT NOT NULL,
        qty         TEXT NOT NULL,
        entry_count INTEGER NOT NULL
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Schemas & shapes
// ---------------------------------------------------------------------------

// `isoInstant`, `nonNegDecimal` and `signedDecimal` are imported from `formats.ts`
// above — the same rules the declared inputs enforce, so a value the operation
// contract accepts is one these handlers can also parse.

const meterKind = z.enum(['counter', 'gauge']);
export type MeterKind = z.infer<typeof meterKind>;

/**
 * The STORED rows (#771/#970).
 *
 * `entities.ts` describes what the journal comparison checks against, so its
 * quantities and instants are bare strings. Here they are narrowed to the formats
 * this engine actually depends on — `signedDecimal` because a `qty` is folded
 * into a billed line, `isoInstantIn` because every window in this engine is a
 * string comparison over instants at one precision. Validating rather than
 * transforming: normalising is the WRITE's decision (`isoInstant`), and a read
 * that quietly rewrote a stored value would hide the drift it is here to catch.
 */
const meterRowShape = meterRow;
type MeterRow = z.infer<typeof meterRowShape>;

const entryRowShape = entryRow.extend({ qty: signedDecimal, occurred_at: isoInstantIn });
type EntryRow = z.infer<typeof entryRowShape>;

const periodRowShape = periodRow.extend({ from_at: isoInstantIn, to_at: isoInstantIn });
type PeriodRow = z.infer<typeof periodRowShape>;

/**
 * A period's frozen line, as stored. NOT in the entity registry, deliberately —
 * a line has no identity outside the close that made it (`entities.ts`) — so its
 * row shape is declared here, where the reads of it are.
 */
const periodLineRow = z.object({
  id: z.string(),
  period_id: z.string(),
  meter_key: z.string(),
  kind: meterKind,
  unit: z.string(),
  qty: signedDecimal,
  entry_count: z.number(),
});
type PeriodLineRow = z.infer<typeof periodLineRow>;

/** The PUBLISHED shapes — what a composing vertical declares its `output` with. */
const meterShape = z.object({
  key: z.string(),
  kind: meterKind,
  unit: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type Meter = z.infer<typeof meterShape>;

const usageEntryShape = z.object({
  id: z.string(),
  meterKey: z.string(),
  qty: signedDecimal,
  subject: entityRef.nullable(),
  occurredAt: isoInstantIn,
  dedupeKey: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type UsageEntry = z.infer<typeof usageEntryShape>;

const meteringPeriodShape = z.object({
  id: z.string(),
  from: isoInstantIn,
  to: isoInstantIn,
  closedBy: z.string(),
  closedAt: z.string(),
});
export type MeteringPeriod = z.infer<typeof meteringPeriodShape>;

/** One meter's frozen aggregate for a closed period. Unpriced, by design (D-E). */
const periodLineShape = z.object({
  meterKey: z.string(),
  kind: meterKind,
  unit: z.string(),
  qty: signedDecimal,
  entryCount: z.number(),
});
export type PeriodLine = z.infer<typeof periodLineShape>;

/** A window aggregate — the shape `usageTotal` publishes and a close freezes. */
const usageAggregate = z.object({ qty: signedDecimal, entryCount: z.number() });

/**
 * The SELECT lists, derived from the row schemas (#771).
 *
 * Never `SELECT *`: that pins the shape a read returns to whatever the physical
 * table currently holds, which is the same trust-TypeScript hole `returns` closes
 * from the other side. A column dropped from the table is then a SQL error naming
 * it; a column added to the table is simply never read.
 */
const METER_COLUMNS = columnsOf(meterRowShape);
const ENTRY_COLUMNS = columnsOf(entryRowShape);
const PERIOD_COLUMNS = columnsOf(periodRowShape);
const PERIOD_LINE_COLUMNS = columnsOf(periodLineRow);

/**
 * What both aggregates read — a projection of `entryRowShape`, not a table.
 *
 * `occurred_at` is in it even though the fold never sums it, because it is what
 * DECIDES the fold: the window is a string comparison, and an instant in a shape
 * this engine never promised sorts into or out of it silently. Leaving it out
 * would have parsed the summand and trusted the thing that chose which summands
 * there were — and a close freezes that choice into an immutable line.
 */
const entryFold = entryRowShape.pick({ qty: true, occurred_at: true });

/** A stored row, parsed BEFORE anything is made of it. */
const storedMeter = (r: MeterRow): MeterRow => returns(meterRowShape, `meter row ${r.key}`, r);
const storedEntry = (r: EntryRow): EntryRow => returns(entryRowShape, `usage entry row ${r.id}`, r);
const storedPeriod = (r: PeriodRow): PeriodRow => returns(periodRowShape, `period row ${r.id}`, r);
const storedLine = (r: PeriodLineRow): PeriodLineRow =>
  returns(periodLineRow, `period line row ${r.id}`, r);

/**
 * A stored row, published (#771) — the projection AND the parse in one place,
 * because every path out of this engine goes through one of these four.
 */
const toMeter = (raw: MeterRow): Meter => {
  const r = storedMeter(raw);
  return returns(meterShape, `meter ${r.key}`, {
    key: r.key,
    kind: r.kind,
    unit: r.unit,
    description: r.description,
    // Parsed BEFORE this normalisation: `active` is 0/1 and read with `=== 1`,
    // so a retyped one would not throw — it would publish every meter as
    // inactive and refuse every `recordUsage` against it as `meter_inactive`.
    active: r.active === 1,
    createdAt: r.created_at,
  });
};

const toEntry = (raw: EntryRow): UsageEntry => {
  const r = storedEntry(raw);
  return returns(usageEntryShape, `usage entry ${r.id}`, {
    id: r.id,
    meterKey: r.meter_key,
    qty: r.qty,
    subject:
      r.subject_type !== null && r.subject_id !== null
        ? { entityType: r.subject_type, entityId: r.subject_id }
        : null,
    occurredAt: r.occurred_at,
    dedupeKey: r.dedupe_key,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  });
};

const toPeriod = (raw: PeriodRow): MeteringPeriod => {
  const r = storedPeriod(raw);
  return returns(meteringPeriodShape, `metering period ${r.id}`, {
    id: r.id,
    from: r.from_at,
    to: r.to_at,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
  });
};

const toLine = (raw: PeriodLineRow): PeriodLine => {
  const r = storedLine(raw);
  return returns(periodLineShape, `period line ${r.id}`, {
    meterKey: r.meter_key,
    kind: r.kind,
    unit: r.unit,
    qty: r.qty,
    entryCount: r.entry_count,
  });
};

function getMeterRow(ctx: OperationContext, key: string): MeterRow {
  const row = ctx.sql.query<MeterRow>(`SELECT ${METER_COLUMNS} FROM metering_meters WHERE key = ?`, [
    key,
  ])[0];
  if (!row) throw substratError('not_found', `meter not found: ${key}`);
  // Parsed here rather than at each caller: `kind` decides counter-versus-gauge
  // aggregation and `active` decides whether usage may be recorded at all, so
  // every path through this engine reads a meter row it has already checked.
  return storedMeter(row);
}

/** The latest closed `to` — nothing may be recorded behind it (D-D). */
function closeHorizon(ctx: OperationContext): string | null {
  return (
    ctx.sql.query<{ horizon: string | null }>(
      'SELECT MAX(to_at) AS horizon FROM metering_periods',
    )[0]?.horizon ?? null
  );
}

/**
 * One meter's aggregate over half-open [from, to) — the SINGLE code path shared
 * by `usageTotal` and `closePeriod`, so a preview can never disagree with the
 * frozen line. Returns null when the meter has nothing to say for the window:
 * a counter with no entries (a zero sum bills nothing), or a gauge never
 * sampled at all. A gauge with no in-window samples carries the latest earlier
 * sample forward with entryCount 0 — a level persists between observations.
 */
function aggregateMeter(
  ctx: OperationContext,
  meter: MeterRow,
  from: string,
  to: string,
): { qty: string; entryCount: number } | null {
  // Parsed on the way into the fold, the way absence parses a ledger delta: a
  // summand that drifted crosses as a NUMBER nobody questions, and this one is
  // frozen into a period line and billed.
  const rows = ctx.sql
    .query<{ qty: string; occurred_at: string }>(
      `SELECT ${columnsOf(entryFold)} FROM metering_entries
      WHERE meter_key = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at, id`,
      [meter.key, from, to],
    )
    .map((r) => returns(entryFold, `usage entry on meter '${meter.key}'`, r));
  if (meter.kind === 'counter') {
    if (rows.length === 0) return null;
    return { qty: rows.reduce((sum, r) => addDecimal(sum, r.qty), '0'), entryCount: rows.length };
  }
  if (rows.length > 0) {
    const max = rows.reduce((m, r) => (compareDecimal(r.qty, m) > 0 ? r.qty : m), rows[0]!.qty);
    return { qty: max, entryCount: rows.length };
  }
  const carried = ctx.sql.query<{ qty: string; occurred_at: string }>(
    `SELECT ${columnsOf(entryFold)} FROM metering_entries
      WHERE meter_key = ? AND occurred_at < ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [meter.key, from],
  )[0];
  // The carry-forward is chosen by `occurred_at` too — it is the LATEST earlier
  // sample — so the same parse decides it.
  return carried
    ? {
        qty: returns(entryFold, `carried entry on meter '${meter.key}'`, carried).qty,
        entryCount: 0,
      }
    : null;
}

// ---------------------------------------------------------------------------
// In-scope functions (K-16) — composable from vertical operations, same
// transaction. The registered operations below are their default bindings.
// The CALLER is responsible for the permission check.
// ---------------------------------------------------------------------------

export const configureMeterInput = z.object({
  key: z.string().min(1),
  kind: z.enum(['counter', 'gauge']),
  unit: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().optional(),
});
export type ConfigureMeterInput = z.infer<typeof configureMeterInput>;

/**
 * Register or update a meter. `kind` and `unit` are FROZEN after creation:
 * changing a meter's unit mid-period corrupts every aggregate that spans the
 * change — a new unit is a new meter key (D-B). `description`/`active` update.
 */
export function configureMeter(ctx: OperationContext, rawInput: ConfigureMeterInput): Meter {
  const input = configureMeterInput.parse(rawInput);
  const stored = ctx.sql.query<MeterRow>(
    `SELECT ${METER_COLUMNS} FROM metering_meters WHERE key = ?`,
    [input.key],
  )[0];
  // `kind` and `unit` are FROZEN, and this is the read that judges them — a
  // drifted one would either wave through a change the invariant forbids or
  // refuse a legitimate one with a message naming a value nothing declared.
  const existing = stored ? storedMeter(stored) : undefined;
  if (existing) {
    if (existing.kind !== input.kind || existing.unit !== input.unit) {
      throw conflict('definition_frozen', 
        `meter '${input.key}' is ${existing.kind}/${existing.unit} — kind and unit are frozen after creation; a new unit is a new meter key`,
      );
    }
    ctx.sql.exec(
      `UPDATE metering_meters SET description = COALESCE(?, description), active = COALESCE(?, active) WHERE key = ?`,
      [
        input.description ?? null,
        input.active === undefined ? null : input.active ? 1 : 0,
        input.key,
      ],
    );
  } else {
    ctx.sql.exec(
      `INSERT INTO metering_meters (key, kind, unit, description, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.key,
        input.kind,
        input.unit,
        input.description ?? null,
        input.active === false ? 0 : 1,
        ctx.now(),
      ],
    );
  }
  const row = getMeterRow(ctx, input.key);
  ctx.emit({
    type: 'metering.meter-configured',
    schemaVersion: 1,
    entity: { entityType: 'metering-meter', entityId: row.key },
    piiClass: 'none',
    payload: { key: row.key, kind: row.kind, unit: row.unit, active: row.active === 1 },
  });
  return toMeter(row);
}

export function listMeters(ctx: OperationContext): Meter[] {
  return ctx.sql
    .query<MeterRow>(`SELECT ${METER_COLUMNS} FROM metering_meters ORDER BY key`)
    .map(toMeter);
}

/**
 * How far AHEAD of the operation's own instant an `occurredAt` may sit (#1066).
 *
 * The window is bounded on BOTH sides, and the two bounds are not the same kind
 * of thing. Behind, the bound is the close horizon: the period covering that
 * instant is frozen, so an entry landing there would change a line already
 * billed. Ahead, the bound is this one, and it exists because `closePeriod`
 * advances the horizon monotonically forward — an entry post-dated past every
 * period anyone will realistically close is aggregated into none of them, and the
 * usage it represents leaves the billing stream with no error anywhere. Nothing
 * ever raises it again: `dedupeKey` does not help (it is per-`(meter, key)`, and
 * this is a first write), and the close journal has no "sweep the stragglers"
 * pass by design, because a closed period must stay reproducible from its own
 * entries forever.
 *
 * So it is a SKEW tolerance, not a feature: a producer whose clock runs a little
 * fast still records, and one that would park a year of usage past the horizon
 * does not. Deliberately small — a caller with a legitimately future observation
 * does not have one, it has a plan.
 */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export const recordUsageInput = z.object({
  meter: z.string().min(1),
  /** Counters take signed deltas (a correction is a compensating entry, never
   *  an edit); gauges take non-negative level samples — enforced per kind. */
  qty: signedDecimal,
  subject: entityRef.optional(),
  /**
   * Defaults to now, and is bounded on both sides. Behind: never past the close
   * horizon (D-D), whose period is frozen. Ahead: never more than
   * `MAX_FUTURE_SKEW_MS` past the operation's own instant, since the horizon only
   * ever moves forward and an entry beyond it is aggregated by no close (#1066).
   */
  occurredAt: isoInstant.optional(),
  /** Caller-supplied idempotency key, unique per meter (D-C) — e.g. a turn id. */
  dedupeKey: z.string().min(1),
  note: z.string().optional(),
});
export type RecordUsageInput = z.infer<typeof recordUsageInput>;

/**
 * The idempotent ingest (D-C): a replay with the same (meter, dedupeKey) and
 * the same qty returns the existing entry — no second row, no second event, no
 * double bill. The same key with a DIFFERENT qty throws: that is an upstream
 * bug, and swallowing it would hide exactly the defect the key exists to catch.
 */
export function recordUsage(
  ctx: OperationContext,
  rawInput: RecordUsageInput,
): { entry: UsageEntry; deduped: boolean } {
  const input = recordUsageInput.parse(rawInput);
  const meter = getMeterRow(ctx, input.meter);
  if (meter.active !== 1) throw conflict('meter_inactive', `meter '${meter.key}' is inactive`);
  if (meter.kind === 'gauge') nonNegDecimal.parse(input.qty);

  const priorRow = ctx.sql.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM metering_entries WHERE meter_key = ? AND dedupe_key = ?`,
    [meter.key, input.dedupeKey],
  )[0];
  // Parsed before the dedupe comparison: `existing.qty` is compared as a decimal
  // to decide replay-versus-upstream-bug, so a drifted one would answer the
  // wrong question — a silent second bill, or a `dedupe_mismatch` naming a
  // quantity that is not one.
  const existing = priorRow ? storedEntry(priorRow) : undefined;
  if (existing) {
    if (compareDecimal(existing.qty, input.qty) !== 0) {
      throw conflict('dedupe_mismatch', 
        `dedupe key '${input.dedupeKey}' on meter '${meter.key}' was recorded with qty ${existing.qty}, now ${input.qty} — a dedupe key must name one observation`,
      );
    }
    return { entry: toEntry(existing), deduped: true };
  }

  const now = ctx.now();
  const occurredAt = input.occurredAt ?? now;
  const horizon = closeHorizon(ctx);
  if (horizon !== null && occurredAt < horizon) {
    throw conflict('period_closed',
      `occurred_at ${occurredAt} is behind the close horizon ${horizon} — the period covering it is closed; record late usage at observation time`,
    );
  }
  // The forward half of the same window (#1066). `new Date(ms)` reads a value we
  // just derived from `ctx.now()`, not the wall clock — R6 bans originating an
  // instant, and this originates none.
  const ceiling = new Date(Date.parse(now) + MAX_FUTURE_SKEW_MS).toISOString();
  if (occurredAt > ceiling) {
    throw conflict('occurred_at_ahead',
      `occurred_at ${occurredAt} is ahead of ${now} by more than the ${MAX_FUTURE_SKEW_MS / 60_000}-minute skew tolerance — the close horizon only moves forward, so an entry past it is aggregated by no period; record usage at observation time`,
    );
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO metering_entries
       (id, meter_key, qty, subject_type, subject_id, occurred_at, dedupe_key, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      meter.key,
      input.qty,
      input.subject?.entityType ?? null,
      input.subject?.entityId ?? null,
      occurredAt,
      input.dedupeKey,
      input.note ?? null,
      ctx.principal,
      now,
    ],
  );
  const entry = toEntry(
    ctx.sql.query<EntryRow>(`SELECT ${ENTRY_COLUMNS} FROM metering_entries WHERE id = ?`, [id])[0]!,
  );
  ctx.emit({
    type: 'metering.usage-recorded',
    schemaVersion: 1,
    entity: { entityType: 'metering-entry', entityId: id },
    piiClass: 'none',
    payload: {
      entryId: id,
      meterKey: meter.key,
      kind: meter.kind,
      unit: meter.unit,
      qty: input.qty,
      subject: input.subject ?? null,
      occurredAt,
      dedupeKey: input.dedupeKey,
    },
  });
  return { entry, deduped: false };
}

/**
 * A window aggregate over half-open [from, to) — the same code path a close
 * would freeze, so a preview and the eventual line can never disagree. Null
 * means the meter has nothing to say for the window (see aggregateMeter).
 */
export function usageTotal(
  ctx: OperationContext,
  input: { meter: string; from: string; to: string },
): { qty: string; entryCount: number } | null {
  const from = isoInstant.parse(input.from);
  const to = isoInstant.parse(input.to);
  if (to <= from) throw substratError('validation_failed', `to ${to} must be after from ${from}`);
  const agg = aggregateMeter(ctx, getMeterRow(ctx, input.meter), from, to);
  return agg && returns(usageAggregate, `usage total for '${input.meter}'`, agg);
}

export function listEntries(
  ctx: OperationContext,
  input?: { meter?: string; subject?: EntityRef; from?: string; to?: string },
): UsageEntry[] {
  const where: string[] = [];
  const params: string[] = [];
  if (input?.meter) {
    where.push('meter_key = ?');
    params.push(input.meter);
  }
  if (input?.subject) {
    where.push('subject_type = ? AND subject_id = ?');
    params.push(input.subject.entityType, input.subject.entityId);
  }
  if (input?.from) {
    where.push('occurred_at >= ?');
    params.push(isoInstant.parse(input.from));
  }
  if (input?.to) {
    where.push('occurred_at < ?');
    params.push(isoInstant.parse(input.to));
  }
  const sql = `SELECT ${ENTRY_COLUMNS} FROM metering_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at, id`;
  return ctx.sql.query<EntryRow>(sql, params).map(toEntry);
}

export const closePeriodInput = z.object({
  from: isoInstant,
  to: isoInstant,
});
export type ClosePeriodInput = z.infer<typeof closePeriodInput>;

/**
 * Freeze [from, to): aggregate EVERY meter (inactive ones too — usage recorded
 * while a meter lived still bills after deactivation), write immutable period +
 * line rows, advance the close horizon, and emit ONE fat event carrying the
 * unpriced lines — the vertical prices them and feeds invoicing (D-E), the
 * same wiring as timesheet.period-closed. Closes are monotonic and
 * non-overlapping; gaps are allowed (metering may start mid-life), rewinds are
 * not (D-D).
 */
export function closePeriod(
  ctx: OperationContext,
  rawInput: ClosePeriodInput,
): { period: MeteringPeriod; lines: PeriodLine[] } {
  const input = closePeriodInput.parse(rawInput);
  if (input.to <= input.from) throw substratError('validation_failed', `to ${input.to} must be after from ${input.from}`);
  const horizon = closeHorizon(ctx);
  if (horizon !== null && input.from < horizon) {
    throw conflict('period_overlap', 
      `period from ${input.from} overlaps the close horizon ${horizon} — closes are monotonic and non-overlapping`,
    );
  }

  const id = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO metering_periods (id, from_at, to_at, closed_by, closed_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.from, input.to, ctx.principal, now],
  );

  const lines: PeriodLine[] = [];
  for (const raw of ctx.sql.query<MeterRow>(
    `SELECT ${METER_COLUMNS} FROM metering_meters ORDER BY key`,
  )) {
    const meter = storedMeter(raw);
    const agg = aggregateMeter(ctx, meter, input.from, input.to);
    if (!agg) continue;
    ctx.sql.exec(
      `INSERT INTO metering_period_lines (id, period_id, meter_key, kind, unit, qty, entry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), id, meter.key, meter.kind, meter.unit, agg.qty, agg.entryCount],
    );
    lines.push(
      returns(periodLineShape, `period line for '${meter.key}'`, {
        meterKey: meter.key,
        kind: meter.kind,
        unit: meter.unit,
        qty: agg.qty,
        entryCount: agg.entryCount,
      }),
    );
  }

  ctx.emit({
    type: 'metering.period-closed',
    schemaVersion: 1,
    entity: { entityType: 'metering-period', entityId: id },
    piiClass: 'none',
    payload: { periodId: id, from: input.from, to: input.to, lines },
  });
  return {
    period: returns(meteringPeriodShape, `metering period ${id}`, {
      id,
      from: input.from,
      to: input.to,
      closedBy: String(ctx.principal),
      closedAt: now,
    }),
    lines,
  };
}

export function listPeriods(ctx: OperationContext): MeteringPeriod[] {
  return ctx.sql
    .query<PeriodRow>(`SELECT ${PERIOD_COLUMNS} FROM metering_periods ORDER BY from_at, id`)
    .map(toPeriod);
}

export function periodLines(ctx: OperationContext, input: { periodId: string }): PeriodLine[] {
  const period = ctx.sql.query<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM metering_periods WHERE id = ?`,
    [input.periodId],
  )[0];
  if (!period) throw substratError('not_found', `metering period not found: ${input.periodId}`);
  return ctx.sql
    .query<PeriodLineRow>(
      `SELECT ${PERIOD_LINE_COLUMNS} FROM metering_period_lines WHERE period_id = ? ORDER BY meter_key`,
      [input.periodId],
    )
    .map(toLine);
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// ---------------------------------------------------------------------------

const configureMeterOp: OperationHandler<ConfigureMeterInput, Meter> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.configure));
  return configureMeter(ctx, input);
};

// Paged (#959). The in-scope `listMeters`/`listEntries`/`listPeriods`/`periodLines`
// above stay unpaged: a vertical composing one inside its own transaction is
// folding it — pricing a period's lines, summing a window — not rendering a table.
// The same split `listOrders` kept in #811.
const listMetersOp: OperationHandler<ListPage | undefined, Page<Meter>> = async (ctx, page) => {
  assertAllowed(await ctx.check(PERM.read));
  // `key` is the primary key, so it is both the order and a unique cursor.
  return pageOverFold(listMeters(ctx), page ?? {}, (m) => m.key);
};

const recordOp: OperationHandler<RecordUsageInput, { entry: UsageEntry; deduped: boolean }> =
  async (ctx, input) => {
    assertAllowed(await ctx.check(PERM.record));
    return recordUsage(ctx, input);
  };

const totalOp: OperationHandler<
  { meter: string; from: string; to: string },
  { qty: string; entryCount: number } | null
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  return usageTotal(ctx, input);
};

const listEntriesOp: OperationHandler<
  ({ meter?: string; subject?: EntityRef; from?: string; to?: string } & ListPage) | undefined,
  Page<UsageEntry>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  // `occurredAt` is the order and is NOT unique — it is caller-supplied, so two
  // observations can share an instant. The cursor is the (occurredAt, id) pair the
  // SQL already orders by, joined by `CURSOR_FIELD_SEPARATOR`.
  return pageOverFold(
    listEntries(ctx, input),
    input ?? {},
    (e) => `${e.occurredAt}${CURSOR_FIELD_SEPARATOR}${e.id}`,
  );
};

const closePeriodOp: OperationHandler<
  ClosePeriodInput,
  { period: MeteringPeriod; lines: PeriodLine[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.close));
  return closePeriod(ctx, input);
};

const listPeriodsOp: OperationHandler<ListPage | undefined, Page<MeteringPeriod>> = async (
  ctx,
  page,
) => {
  assertAllowed(await ctx.check(PERM.read));
  // Oldest first. The SQL orders by (from_at, id), so the cursor is that pair —
  // closes do not overlap, but the cursor matches the ORDER BY rather than
  // relying on that.
  return pageOverFold(
    listPeriods(ctx),
    page ?? {},
    (p) => `${p.from}${CURSOR_FIELD_SEPARATOR}${p.id}`,
  );
};

const periodLinesOp: OperationHandler<{ periodId: string } & ListPage, Page<PeriodLine>> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.read));
  // One line per meter per period, so `meterKey` is unique within the period.
  return pageOverFold(periodLines(ctx, input), input, (l) => l.meterKey);
};

export const meteringModule: ModuleRegistration = {
  manifest: meteringManifest,
  migrations: meteringMigrations,
  // Parse, don't trust: the HOST applies the declared schemas, on every path in.
  operationInputs: operationInputsOf(meteringOperations),
  operations: {
    'metering/configure-meter': configureMeterOp as OperationHandler<never, unknown>,
    'metering/list-meters': listMetersOp as OperationHandler<never, unknown>,
    'metering/record': recordOp as OperationHandler<never, unknown>,
    'metering/total': totalOp as OperationHandler<never, unknown>,
    'metering/list-entries': listEntriesOp as OperationHandler<never, unknown>,
    'metering/close-period': closePeriodOp as OperationHandler<never, unknown>,
    'metering/list-periods': listPeriodsOp as OperationHandler<never, unknown>,
    'metering/period-lines': periodLinesOp as OperationHandler<never, unknown>,
  },
};
