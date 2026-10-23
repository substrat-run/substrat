import {
  meterDay,
  meterDayTake,
  utcDay,
  type Instant,
  type MeterDay,
  type MeterDayTake,
  type MeterDayVertical,
  type ScopeStatus,
  type TenantId,
  type TenantStatus,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit, boundedRetentionDelete } from './scope-host.js';
import { billingRollupHorizon } from './billing-retention.js';
import { foldMeterReading, isLive, type MeterEntitlementInput, type MeterScopeInput, type MeterTenantInput } from './meters.js';

/**
 * The daily meter snapshot (#2501), as statements both adapters run against their directory: the
 * SQLite host over better-sqlite3, the hosted one inside ControlPlaneDO. Written once so the two
 * cannot keep different histories of the same fleet.
 *
 * Meters 1 and 2 (`readMeters`) are recomputed on every read and store nothing, so a past day's
 * reading is gone once the directory moves on. This keeps one row per (UTC day, tenant): the
 * tenant's reading as the first scheduled pass of the day found it, folded by `foldMeterReading`
 * so the billable rule is the one `/meters` applies. Beside the tenant's scope counts it holds the
 * same counts split by vertical, and every grant the tenant held with whether it was live at the
 * snapshot's instant: an expiry is decided lazily from `expires_at` and leaves no trace of its
 * own, so the day it lapsed is only known if someone looked that day.
 *
 * `_substrat_meter_day_takes` keeps one row per day a pass tried: when, whether the snapshot was
 * taken, and why the last attempt failed. A day with no rows and a record was taken over no
 * tenant; a day with no record had no pass. A failed attempt carries the run of identical failures
 * it belongs to (`failing_since`, `failing_count`), handed on from the attempt before it.
 *
 * The nested lists are JSON, parsed by `meterDay` on the way in and on the way out.
 */
export const METER_DAYS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_meter_days (
    day TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    status TEXT NOT NULL,
    billable INTEGER NOT NULL,
    scopes TEXT NOT NULL,
    verticals TEXT NOT NULL,
    entitlements TEXT NOT NULL,
    PRIMARY KEY (day, tenant_id)
  );
  CREATE INDEX IF NOT EXISTS _substrat_meter_days_tenant ON _substrat_meter_days (tenant_id, day);
  CREATE TABLE IF NOT EXISTS _substrat_meter_day_takes (
    day TEXT PRIMARY KEY,
    attempted_at TEXT NOT NULL,
    taken_at TEXT,
    tenant_count INTEGER,
    error TEXT,
    failing_since TEXT,
    failing_count INTEGER
  );
`;

/**
 * How long one snapshot may take before the pass stops waiting and counts the attempt failed. A
 * directory transaction over the fleet answers in well under a second; this is the bound that keeps
 * a stalled one from holding the pass.
 */
export const METER_SNAPSHOT_TIMEOUT_MS = 30_000;

/** How many day rows one `pruneMeterDays` call deletes, by default. */
export const METER_DAYS_PRUNE_BATCH = 500;

/** The most rows one `listMeterDays` call returns, and its default. */
export const METER_DAYS_LIMIT_MAX = 10_000;
export const METER_DAYS_LIMIT_DEFAULT = 1_000;

/**
 * One attempt at a day's snapshot. The day is always the UTC day of `at`: a snapshot is a reading
 * taken during its day, never one written for a day after it. Without `error` the directory takes
 * the snapshot; with it, the attempt failed and only the failure is recorded, naming the run of
 * identical failures it extends (absent, it starts one).
 */
export type MeterDayTakeInput =
  | { at: string }
  | { at: string; error: string; failingSince?: string; failingCount?: number };

/** What one attempt did: the day, whether this call took its snapshot, and the tenant rows it wrote. */
export interface MeterDayTakeResult {
  day: string;
  taken: boolean;
  tenants: number;
}

/** Filter for `listMeterDays`: inclusive UTC days, at most `limit` rows, ordered by (day, tenant). */
export interface MeterDayFilter {
  tenantId?: TenantId;
  since?: string;
  until?: string;
  limit?: number;
}

/** Filter for `listMeterDayTakes`: inclusive UTC days. */
export interface MeterDayTakeFilter {
  since?: string;
  until?: string;
}

function assertDay(name: string, day: string): string {
  if (!utcDay.safeParse(day).success) throw new Error(`${name} must be a UTC day (YYYY-MM-DD), got ${JSON.stringify(day)}`);
  return day;
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * The day's rows, one per tenant that is not reaped, folded at `readAt`. A reaped tenant is a
 * tombstone: it holds no scope and bills nothing, and a row per day for every one of them would
 * grow the table with nothing in it.
 */
export function meterDayRowsAt(
  readAt: Instant,
  input: {
    tenants: readonly MeterTenantInput[];
    scopes: readonly (MeterScopeInput & { vertical: string | null })[];
    entitlements: readonly MeterEntitlementInput[];
  },
): MeterDay[] {
  const day = readAt.slice(0, 10);
  const tenants = input.tenants.filter((t) => t.status !== 'reaped');
  const reading = foldMeterReading({ readAt, tenants: [...tenants], scopes: [...input.scopes], entitlements: [...input.entitlements] });

  // The split by vertical is the same fold over each vertical's scopes, so a vertical's counts
  // follow the billable rule the tenant's do, and sum to them.
  const byVertical = new Map<string, (MeterScopeInput & { vertical: string | null })[]>();
  for (const s of input.scopes) {
    const key = s.vertical ?? '';
    const list = byVertical.get(key);
    if (list) list.push(s);
    else byVertical.set(key, [s]);
  }
  const verticals = new Map<TenantId, MeterDayVertical[]>();
  for (const key of [...byVertical.keys()].sort(cmp)) {
    const scopes = byVertical.get(key)!;
    const holding = new Set(scopes.map((s) => s.tenantId));
    const folded = foldMeterReading({ readAt, tenants: tenants.filter((t) => holding.has(t.tenantId)), scopes, entitlements: [] });
    for (const row of folded.perTenant) {
      const list = verticals.get(row.tenantId) ?? [];
      list.push({ vertical: key === '' ? null : key, ...row.scopes });
      verticals.set(row.tenantId, list);
    }
  }

  const grants = new Map<TenantId, MeterEntitlementInput[]>();
  for (const g of input.entitlements) {
    const list = grants.get(g.tenantId) ?? [];
    list.push(g);
    grants.set(g.tenantId, list);
  }

  return reading.perTenant.map((t) =>
    meterDay.parse({
      day,
      tenantId: t.tenantId,
      readAt,
      status: t.status,
      billable: t.billable,
      scopes: t.scopes,
      verticals: verticals.get(t.tenantId) ?? [],
      entitlements: (grants.get(t.tenantId) ?? [])
        .map((g) => ({ entitlementKey: g.entitlementKey, plan: g.plan, expiresAt: g.expiresAt, live: isLive(g, readAt) }))
        // Null plan first: the ungrouped flag is the base row a tier hangs off, as meter 2 orders it.
        .sort((a, b) => cmp(a.entitlementKey, b.entitlementKey) || cmp(a.plan ?? '', b.plan ?? '')),
    }),
  );
}

/**
 * Record one attempt at the snapshot of the UTC day of `input.at`, in the caller's transaction.
 *
 * Without an error, it takes the snapshot unless the day already has one: it reads the tenants,
 * their scopes and their grants, folds them (`meterDayRowsAt`), writes the day's rows and marks
 * the day taken. Every row is parsed before anything is written, so a row that does not parse
 * refuses the whole day. A day already taken is left as it is, so the first pass of the day is
 * the one whose reading stands.
 *
 * With an error, it records only the attempt and its run. It never overwrites a day already taken:
 * a snapshot that committed after its caller stopped waiting still stands.
 */
export function recordMeterDayRows(sql: RedactionSql, input: MeterDayTakeInput): MeterDayTakeResult {
  const readAt = new Date(input.at).toISOString() as Instant;
  const day = readAt.slice(0, 10);
  if ('error' in input) {
    const since = new Date(input.failingSince ?? readAt).toISOString();
    const count = input.failingCount ?? 1;
    if (!(Number.isInteger(count) && count >= 1)) {
      throw new Error(`failingCount must be a whole number, at least one, got ${String(count)}`);
    }
    sql(
      `INSERT INTO _substrat_meter_day_takes
         (day, attempted_at, taken_at, tenant_count, error, failing_since, failing_count)
       VALUES (?, ?, NULL, NULL, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         attempted_at = excluded.attempted_at, error = excluded.error,
         failing_since = excluded.failing_since, failing_count = excluded.failing_count
       WHERE _substrat_meter_day_takes.taken_at IS NULL`,
      [day, readAt, input.error || 'the snapshot failed', since, count],
    );
    return { day, taken: false, tenants: 0 };
  }
  const prior = sql('SELECT taken_at FROM _substrat_meter_day_takes WHERE day = ?', [day]) as { taken_at: string | null }[];
  if (prior[0]?.taken_at) return { day, taken: false, tenants: 0 };

  // The three projections `readMeters` folds, read whole: which rows count is the fold's to say.
  const tenants = (sql('SELECT tenant_id, slug, status FROM tenants', []) as {
    tenant_id: string;
    slug: string;
    status: string;
  }[]).map((r) => ({ tenantId: r.tenant_id as TenantId, slug: r.slug, status: r.status as TenantStatus }));
  const scopes = (sql('SELECT tenant_id, status, archived_from_status, vertical FROM scopes', []) as {
    tenant_id: string;
    status: string;
    archived_from_status: string | null;
    vertical: string | null;
  }[]).map((r) => ({
    tenantId: r.tenant_id as TenantId,
    status: r.status as ScopeStatus,
    archivedFromStatus: r.archived_from_status as ScopeStatus | null,
    vertical: r.vertical,
  }));
  const entitlements = (sql('SELECT tenant_id, entitlement_key, plan, expires_at FROM _substrat_entitlements', []) as {
    tenant_id: string;
    entitlement_key: string;
    plan: string | null;
    expires_at: string | null;
  }[]).map((r) => ({
    tenantId: r.tenant_id as TenantId,
    entitlementKey: r.entitlement_key,
    plan: r.plan,
    expiresAt: r.expires_at,
  }));
  // Every row is parsed here, before the first write: a row that does not parse refuses the day.
  const rows = meterDayRowsAt(readAt, { tenants, scopes, entitlements });

  // A day is written only in the transaction that marks it taken, so an untaken day holds no rows.
  for (const r of rows) {
    sql(
      `INSERT INTO _substrat_meter_days (day, tenant_id, read_at, status, billable, scopes, verticals, entitlements)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.day,
        r.tenantId,
        r.readAt,
        r.status,
        r.billable ? 1 : 0,
        JSON.stringify(r.scopes),
        JSON.stringify(r.verticals),
        JSON.stringify(r.entitlements),
      ],
    );
  }
  sql(
    `INSERT INTO _substrat_meter_day_takes
       (day, attempted_at, taken_at, tenant_count, error, failing_since, failing_count)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT (day) DO UPDATE SET
       attempted_at = excluded.attempted_at, taken_at = excluded.taken_at, tenant_count = excluded.tenant_count,
       error = NULL, failing_since = NULL, failing_count = NULL`,
    [day, readAt, readAt, rows.length],
  );
  return { day, taken: true, tenants: rows.length };
}

interface MeterDayRow {
  day: string;
  tenant_id: string;
  read_at: string;
  status: string;
  billable: number;
  scopes: string;
  verticals: string;
  entitlements: string;
}

/** Read stored snapshots — see `MeterDayFilter`. Every row is parsed on the way out. */
export function listMeterDayRows(sql: RedactionSql, filter: MeterDayFilter = {}): MeterDay[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tenantId !== undefined) {
    where.push('tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.since !== undefined) {
    where.push('day >= ?');
    params.push(assertDay('since', filter.since));
  }
  if (filter.until !== undefined) {
    where.push('day <= ?');
    params.push(assertDay('until', filter.until));
  }
  const limit = Math.min(assertRowLimit('limit', filter.limit ?? METER_DAYS_LIMIT_DEFAULT), METER_DAYS_LIMIT_MAX);
  params.push(limit);
  const rows = sql(
    `SELECT day, tenant_id, read_at, status, billable, scopes, verticals, entitlements
       FROM _substrat_meter_days
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day, tenant_id LIMIT ?`,
    params,
  ) as MeterDayRow[];
  return rows.map((r) =>
    meterDay.parse({
      day: r.day,
      tenantId: r.tenant_id,
      readAt: r.read_at,
      status: r.status,
      billable: r.billable === 1,
      scopes: JSON.parse(r.scopes),
      verticals: JSON.parse(r.verticals),
      entitlements: JSON.parse(r.entitlements),
    }),
  );
}

/** The record of each day a pass tried to snapshot, in day order — see `MeterDayTakeFilter`. */
export function listMeterDayTakeRows(sql: RedactionSql, filter: MeterDayTakeFilter = {}): MeterDayTake[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.since !== undefined) {
    where.push('day >= ?');
    params.push(assertDay('since', filter.since));
  }
  if (filter.until !== undefined) {
    where.push('day <= ?');
    params.push(assertDay('until', filter.until));
  }
  const rows = sql(
    `SELECT day, attempted_at, taken_at, tenant_count, error, failing_since, failing_count
       FROM _substrat_meter_day_takes
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day`,
    params,
  ) as {
    day: string;
    attempted_at: string;
    taken_at: string | null;
    tenant_count: number | null;
    error: string | null;
    failing_since: string | null;
    failing_count: number | null;
  }[];
  return rows.map((r) =>
    meterDayTake.parse({
      day: r.day,
      attemptedAt: r.attempted_at,
      takenAt: r.taken_at,
      tenants: r.tenant_count,
      error: r.error,
      failingSince: r.failing_since,
      failingCount: r.failing_count,
    }),
  );
}

/**
 * Delete at most `limit` snapshot rows older than a retention of `months`, oldest first, then the
 * records of the days that are gone. `months` null deletes nothing (`BILLING_ROLLUP_RETENTION_MONTHS`).
 * Returns how many snapshot rows went.
 */
export function pruneMeterDayRows(sql: RedactionSql, nowMs: number, limit: number, months: number | null): number {
  const capped = assertRowLimit('limit', limit);
  const horizon = billingRollupHorizon(nowMs, months);
  if (horizon === null) return 0;
  const pruned = sql(boundedRetentionDelete('_substrat_meter_days', 'day'), [horizon, capped]).length;
  // A record goes only once its day holds no row, so a day still being pruned stays marked taken.
  sql(
    `DELETE FROM _substrat_meter_day_takes
      WHERE day < ? AND NOT EXISTS (SELECT 1 FROM _substrat_meter_days d WHERE d.day = _substrat_meter_day_takes.day)`,
    [horizon],
  );
  return pruned;
}
