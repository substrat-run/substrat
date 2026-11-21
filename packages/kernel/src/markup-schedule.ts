/**
 * The markup schedule's directory half (#3316, Pricing), shared by both adapters: the row as
 * stored, the read that puts the owner's seed beneath it, and the rule a new row is held to. The
 * vocabulary and the pricing read are `@substrat-run/contracts`' (`markupInForce`,
 * `priceCostRows`); the table is each adapter's directory DDL, which `lint:spine-ddl` keeps in step.
 *
 * The seed (`MARKUP_SEED`) is not inserted: it is read beneath the stored rows, every time. A
 * directory restore applies the schema to an empty directory and then loads the dump, so a seed
 * written at schema time would collide with its own dumped copy; read beneath, it cannot. It is
 * still a row like any other, dated from before any usage, and a stored row supersedes it.
 */
import {
  MARKUP_SEED,
  markupRow,
  markupRowInput,
  substratError,
  type MarkupRow,
  type MarkupRowInput,
  type PlatformActorId,
} from '@substrat-run/contracts';

/** A `_substrat_markup_schedule` row as SQLite returns it. */
export interface MarkupScheduleRecord {
  id: string;
  tenant_id: string | null;
  dimension: string | null;
  kind: string | null;
  effective_from: string;
  percent: number | null;
  reason: string;
  set_at: string;
  set_by: string;
}

/** The columns a read names, in the order `markupRecordValues` binds them. */
export const MARKUP_COLUMNS = 'id, tenant_id, dimension, kind, effective_from, percent, reason, set_at, set_by';

/** The one write the schedule has: a row is added, never updated or deleted. */
export const MARKUP_INSERT_SQL = `INSERT INTO _substrat_markup_schedule (${MARKUP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** A row's bindings for `MARKUP_INSERT_SQL`. */
export function markupRecordValues(row: MarkupRow): (string | number | null)[] {
  return [row.id, row.tenantId, row.dimension, row.kind, row.effectiveFrom, row.percent, row.reason, row.setAt, row.setBy];
}

/**
 * The schedule a read answers: the seed beneath the stored rows, oldest effective day first.
 * `records` are the stored rows the read selected (a tenant's own and the platform's, or all).
 */
export function markupScheduleOf(records: readonly MarkupScheduleRecord[]): MarkupRow[] {
  return [...MARKUP_SEED, ...records.map(markupRowOf)].sort((a, b) =>
    a.effectiveFrom !== b.effectiveFrom ? (a.effectiveFrom < b.effectiveFrom ? -1 : 1)
      : a.setAt !== b.setAt ? (a.setAt < b.setAt ? -1 : 1)
        : a.id < b.id ? -1 : 1,
  );
}

/** The stored rows a tenant-narrowed read selects: its own and the platform's. */
export const MARKUP_SELECT_SQL = `SELECT ${MARKUP_COLUMNS} FROM _substrat_markup_schedule`;
export const MARKUP_SELECT_FOR_TENANT_SQL = `${MARKUP_SELECT_SQL} WHERE tenant_id IS NULL OR tenant_id = ?`;

/** Stored → the contract's row, parsed on the way out so a malformed row throws rather than prices. */
export function markupRowOf(record: MarkupScheduleRecord): MarkupRow {
  return markupRow.parse({
    id: record.id,
    tenantId: record.tenant_id,
    dimension: record.dimension,
    kind: record.kind,
    effectiveFrom: record.effective_from,
    percent: record.percent,
    reason: record.reason,
    setAt: record.set_at,
    setBy: record.set_by,
  });
}

/**
 * A staff request → the row to store. Refuses a row taking effect before today (UTC): a past day
 * is priced at the markup in force then, so no row may reach back and reprice it. Today itself is
 * not closed yet, so a row may take effect from it.
 */
export function newMarkupRow(input: MarkupRowInput, stamp: { id: string; now: string; actor: PlatformActorId }): MarkupRow {
  const parsed = markupRowInput.parse(input);
  const today = stamp.now.slice(0, 10);
  if (parsed.effectiveFrom < today) {
    throw substratError(
      'validation_failed',
      `a markup row cannot take effect before today (${today}): a past day keeps the markup in force then`,
    );
  }
  return markupRow.parse({
    id: stamp.id,
    tenantId: parsed.tenantId ?? null,
    dimension: parsed.dimension ?? null,
    kind: parsed.kind ?? null,
    effectiveFrom: parsed.effectiveFrom,
    percent: parsed.percent,
    reason: parsed.reason,
    setAt: stamp.now,
    setBy: stamp.actor,
  });
}
