import { z } from 'zod';
import {
  addDecimal,
  compareDecimal,
  entityRef,
  moduleManifest,
  permissionKey,
  type EntityRef,
} from '@substrat-run/contracts';
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

/**
 * Instants are UTC ISO-8601, normalized to millisecond precision so
 * lexicographic order IS chronological order — mixed precision would break
 * every string comparison below ('…T00:00:00Z' sorts AFTER '…T00:00:00.000Z').
 */
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, 'must be a UTC ISO-8601 instant (…Z)')
  .transform((s) => new Date(s).toISOString());

const nonNegDecimal = z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal');
const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'must be a decimal');

export type MeterKind = 'counter' | 'gauge';

export interface Meter {
  key: string;
  kind: MeterKind;
  unit: string;
  description: string | null;
  active: boolean;
  createdAt: string;
}

interface MeterRow {
  key: string;
  kind: MeterKind;
  unit: string;
  description: string | null;
  active: number;
  created_at: string;
}

interface EntryRow {
  id: string;
  meter_key: string;
  qty: string;
  subject_type: string | null;
  subject_id: string | null;
  occurred_at: string;
  dedupe_key: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface UsageEntry {
  id: string;
  meterKey: string;
  qty: string;
  subject: EntityRef | null;
  occurredAt: string;
  dedupeKey: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

interface PeriodRow {
  id: string;
  from_at: string;
  to_at: string;
  closed_by: string;
  closed_at: string;
}

export interface MeteringPeriod {
  id: string;
  from: string;
  to: string;
  closedBy: string;
  closedAt: string;
}

interface PeriodLineRow {
  id: string;
  period_id: string;
  meter_key: string;
  kind: MeterKind;
  unit: string;
  qty: string;
  entry_count: number;
}

/** One meter's frozen aggregate for a closed period. Unpriced, by design (D-E). */
export interface PeriodLine {
  meterKey: string;
  kind: MeterKind;
  unit: string;
  qty: string;
  entryCount: number;
}

const toMeter = (r: MeterRow): Meter => ({
  key: r.key,
  kind: r.kind,
  unit: r.unit,
  description: r.description,
  active: r.active === 1,
  createdAt: r.created_at,
});

const toEntry = (r: EntryRow): UsageEntry => ({
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

const toPeriod = (r: PeriodRow): MeteringPeriod => ({
  id: r.id,
  from: r.from_at,
  to: r.to_at,
  closedBy: r.closed_by,
  closedAt: r.closed_at,
});

const toLine = (r: PeriodLineRow): PeriodLine => ({
  meterKey: r.meter_key,
  kind: r.kind,
  unit: r.unit,
  qty: r.qty,
  entryCount: r.entry_count,
});

function getMeterRow(ctx: OperationContext, key: string): MeterRow {
  const row = ctx.sql.query<MeterRow>('SELECT * FROM metering_meters WHERE key = ?', [key])[0];
  if (!row) throw new Error(`meter not found: ${key}`);
  return row;
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
  const rows = ctx.sql.query<{ qty: string }>(
    `SELECT qty FROM metering_entries
      WHERE meter_key = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at, id`,
    [meter.key, from, to],
  );
  if (meter.kind === 'counter') {
    if (rows.length === 0) return null;
    return { qty: rows.reduce((sum, r) => addDecimal(sum, r.qty), '0'), entryCount: rows.length };
  }
  if (rows.length > 0) {
    const max = rows.reduce((m, r) => (compareDecimal(r.qty, m) > 0 ? r.qty : m), rows[0]!.qty);
    return { qty: max, entryCount: rows.length };
  }
  const carried = ctx.sql.query<{ qty: string }>(
    `SELECT qty FROM metering_entries
      WHERE meter_key = ? AND occurred_at < ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [meter.key, from],
  )[0];
  return carried ? { qty: carried.qty, entryCount: 0 } : null;
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
  const existing = ctx.sql.query<MeterRow>('SELECT * FROM metering_meters WHERE key = ?', [
    input.key,
  ])[0];
  if (existing) {
    if (existing.kind !== input.kind || existing.unit !== input.unit) {
      throw new Error(
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
        new Date().toISOString(),
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
  return ctx.sql.query<MeterRow>('SELECT * FROM metering_meters ORDER BY key').map(toMeter);
}

export const recordUsageInput = z.object({
  meter: z.string().min(1),
  /** Counters take signed deltas (a correction is a compensating entry, never
   *  an edit); gauges take non-negative level samples — enforced per kind. */
  qty: signedDecimal,
  subject: entityRef.optional(),
  /** Defaults to now. Must not fall behind the close horizon (D-D). */
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
  if (meter.active !== 1) throw new Error(`meter '${meter.key}' is inactive`);
  if (meter.kind === 'gauge') nonNegDecimal.parse(input.qty);

  const existing = ctx.sql.query<EntryRow>(
    'SELECT * FROM metering_entries WHERE meter_key = ? AND dedupe_key = ?',
    [meter.key, input.dedupeKey],
  )[0];
  if (existing) {
    if (compareDecimal(existing.qty, input.qty) !== 0) {
      throw new Error(
        `dedupe key '${input.dedupeKey}' on meter '${meter.key}' was recorded with qty ${existing.qty}, now ${input.qty} — a dedupe key must name one observation`,
      );
    }
    return { entry: toEntry(existing), deduped: true };
  }

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const horizon = closeHorizon(ctx);
  if (horizon !== null && occurredAt < horizon) {
    throw new Error(
      `occurred_at ${occurredAt} is behind the close horizon ${horizon} — the period covering it is closed; record late usage at observation time`,
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
      new Date().toISOString(),
    ],
  );
  const entry = toEntry(
    ctx.sql.query<EntryRow>('SELECT * FROM metering_entries WHERE id = ?', [id])[0]!,
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
  if (to <= from) throw new Error(`to ${to} must be after from ${from}`);
  return aggregateMeter(ctx, getMeterRow(ctx, input.meter), from, to);
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
  const sql = `SELECT * FROM metering_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at, id`;
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
  if (input.to <= input.from) throw new Error(`to ${input.to} must be after from ${input.from}`);
  const horizon = closeHorizon(ctx);
  if (horizon !== null && input.from < horizon) {
    throw new Error(
      `period from ${input.from} overlaps the close horizon ${horizon} — closes are monotonic and non-overlapping`,
    );
  }

  const id = ulid();
  const now = new Date().toISOString();
  ctx.sql.exec(
    `INSERT INTO metering_periods (id, from_at, to_at, closed_by, closed_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.from, input.to, ctx.principal, now],
  );

  const lines: PeriodLine[] = [];
  for (const meter of ctx.sql.query<MeterRow>('SELECT * FROM metering_meters ORDER BY key')) {
    const agg = aggregateMeter(ctx, meter, input.from, input.to);
    if (!agg) continue;
    ctx.sql.exec(
      `INSERT INTO metering_period_lines (id, period_id, meter_key, kind, unit, qty, entry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), id, meter.key, meter.kind, meter.unit, agg.qty, agg.entryCount],
    );
    lines.push({
      meterKey: meter.key,
      kind: meter.kind,
      unit: meter.unit,
      qty: agg.qty,
      entryCount: agg.entryCount,
    });
  }

  ctx.emit({
    type: 'metering.period-closed',
    schemaVersion: 1,
    entity: { entityType: 'metering-period', entityId: id },
    piiClass: 'none',
    payload: { periodId: id, from: input.from, to: input.to, lines },
  });
  return {
    period: { id, from: input.from, to: input.to, closedBy: String(ctx.principal), closedAt: now },
    lines,
  };
}

export function listPeriods(ctx: OperationContext): MeteringPeriod[] {
  return ctx.sql
    .query<PeriodRow>('SELECT * FROM metering_periods ORDER BY from_at, id')
    .map(toPeriod);
}

export function periodLines(ctx: OperationContext, input: { periodId: string }): PeriodLine[] {
  const period = ctx.sql.query<PeriodRow>('SELECT * FROM metering_periods WHERE id = ?', [
    input.periodId,
  ])[0];
  if (!period) throw new Error(`metering period not found: ${input.periodId}`);
  return ctx.sql
    .query<PeriodLineRow>(
      'SELECT * FROM metering_period_lines WHERE period_id = ? ORDER BY meter_key',
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

const listMetersOp: OperationHandler<undefined, Meter[]> = async (ctx) => {
  assertAllowed(await ctx.check(PERM.read));
  return listMeters(ctx);
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
  { meter?: string; subject?: EntityRef; from?: string; to?: string } | undefined,
  UsageEntry[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  return listEntries(ctx, input);
};

const closePeriodOp: OperationHandler<
  ClosePeriodInput,
  { period: MeteringPeriod; lines: PeriodLine[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.close));
  return closePeriod(ctx, input);
};

const listPeriodsOp: OperationHandler<undefined, MeteringPeriod[]> = async (ctx) => {
  assertAllowed(await ctx.check(PERM.read));
  return listPeriods(ctx);
};

const periodLinesOp: OperationHandler<{ periodId: string }, PeriodLine[]> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  return periodLines(ctx, input);
};

export const meteringModule: ModuleRegistration = {
  manifest: meteringManifest,
  migrations: meteringMigrations,
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
