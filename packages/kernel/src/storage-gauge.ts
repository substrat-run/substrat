import {
  STORAGE_EXCLUSIONS,
  scopeStorageSample,
  type ScopeId,
  type ScopeStorageSample,
  type StorageGauge,
  type TenantId,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit, boundedRetentionDelete } from './scope-host.js';

/**
 * The stored storage gauge (#1524), as statements both adapters run against their directory:
 * the SQLite host over better-sqlite3, the hosted one inside ControlPlaneDO. Written once so
 * the two cannot keep different histories of the same fleet.
 *
 * One row per (scope, UTC day): the day's LATEST reading, replaced by a later one on the
 * same day. A day holds one number per scope, which is what a byte-day sum needs and no
 * more, so the table grows by at most one row per scope per day, and retention
 * (`STORAGE_GAUGE_RETENTION_MONTHS`) bounds it in time.
 *
 * The rows are written by the scheduled pass (`runPlatformSweep`'s storage phase), which
 * samples only scopes an earlier phase of the same pass already woke. Nothing here reads a
 * scope; serving a figure is a directory read.
 */
export const SCOPE_STORAGE_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_scope_storage (
    scope_id TEXT NOT NULL,
    day TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, day)
  );
  CREATE INDEX IF NOT EXISTS _substrat_scope_storage_tenant ON _substrat_scope_storage (tenant_id, day);
  CREATE INDEX IF NOT EXISTS _substrat_scope_storage_day ON _substrat_scope_storage (day);
`;

/** How long a day's sample is kept: thirteen months, so a year can be compared with the one before it. */
export const STORAGE_GAUGE_RETENTION_MONTHS = 13;

/** How many samples one `pruneScopeStorage` call deletes, by default. */
export const STORAGE_GAUGE_PRUNE_BATCH = 500;

/** The most history rows one `listScopeStorage` call returns, and its default. */
export const STORAGE_HISTORY_LIMIT_MAX = 10_000;
export const STORAGE_HISTORY_LIMIT_DEFAULT = 1_000;

/** What the storage phase hands `recordScopeStorage`: one successful read. */
export interface ScopeStorageReadingInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  bytes: number;
  /** When the size was read. Its UTC date is the row's day. */
  readAt: string;
}

/**
 * Filter for `listScopeStorage`. `latest` returns one row per non-reaped scope, its most
 * recent day, and ignores `since`/`until`/`limit`: that set is bounded by the scope count,
 * the same as `listScopes`. Otherwise it is history, ordered (scope, day), `since`/`until`
 * inclusive UTC days, at most `limit` rows.
 */
export interface ScopeStorageFilter {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  latest?: boolean;
  since?: string;
  until?: string;
  limit?: number;
}

/** The UTC day a reading belongs to. */
export function storageGaugeDay(readAt: string): string {
  return new Date(readAt).toISOString().slice(0, 10);
}

/** The first day retention keeps: thirteen calendar months before `nowMs`, as a UTC day. */
export function storageRetentionHorizon(nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - STORAGE_GAUGE_RETENTION_MONTHS);
  return d.toISOString().slice(0, 10);
}

/**
 * Upsert readings, one statement each. The row is written only for a scope the directory
 * holds UNDER THAT TENANT and has not reaped, so a reading can never land in another tenant's
 * figure, and a scope reaped while its read was in flight leaves no row behind. Within a day a
 * reading replaces an older one and never a newer one. Returns how many rows were written.
 */
export function recordScopeStorageRows(sql: RedactionSql, readings: readonly ScopeStorageReadingInput[]): number {
  let recorded = 0;
  for (const r of readings) {
    if (!Number.isInteger(r.bytes) || r.bytes < 0) continue;
    const readAt = new Date(r.readAt).toISOString();
    recorded += sql(
      `INSERT INTO _substrat_scope_storage (scope_id, day, tenant_id, bytes, read_at)
       SELECT scope_id, ?, tenant_id, ?, ? FROM scopes
        WHERE scope_id = ? AND tenant_id = ? AND status <> 'reaped'
       ON CONFLICT (scope_id, day) DO UPDATE SET bytes = excluded.bytes, read_at = excluded.read_at
        WHERE excluded.read_at >= _substrat_scope_storage.read_at
       RETURNING 1`,
      [storageGaugeDay(readAt), r.bytes, readAt, r.scopeId, r.tenantId],
    ).length;
  }
  return recorded;
}

interface SampleRow {
  tenant_id: string;
  scope_id: string;
  day: string;
  bytes: number;
  read_at: string;
}

/** Read samples — see `ScopeStorageFilter`. Every row is parsed on the way out. */
export function listScopeStorageRows(sql: RedactionSql, filter: ScopeStorageFilter = {}): ScopeStorageSample[] {
  const where: string[] = ["s.status <> 'reaped'"];
  const params: (string | number)[] = [];
  if (filter.tenantId) {
    where.push('g.tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.scopeId) {
    where.push('g.scope_id = ?');
    params.push(filter.scopeId);
  }
  let tail = '';
  if (filter.latest) {
    where.push('g.day = (SELECT MAX(m.day) FROM _substrat_scope_storage m WHERE m.scope_id = g.scope_id)');
  } else {
    if (filter.since) {
      where.push('g.day >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('g.day <= ?');
      params.push(filter.until);
    }
    const limit = assertRowLimit('limit', filter.limit ?? STORAGE_HISTORY_LIMIT_DEFAULT);
    tail = ' LIMIT ?';
    params.push(Math.min(limit, STORAGE_HISTORY_LIMIT_MAX));
  }
  // The join to `scopes` is the belt to the reap's braces: a reaped scope's rows are
  // deleted at reap, and any that survived are still never read.
  const rows = sql(
    `SELECT g.tenant_id, g.scope_id, g.day, g.bytes, g.read_at
       FROM _substrat_scope_storage g
       JOIN scopes s ON s.scope_id = g.scope_id AND s.tenant_id = g.tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY g.scope_id, g.day${tail}`,
    params,
  ) as SampleRow[];
  return rows.map((r) =>
    scopeStorageSample.parse({
      tenantId: r.tenant_id,
      scopeId: r.scope_id,
      day: r.day,
      bytes: r.bytes,
      readAt: r.read_at,
    }),
  );
}

/** Delete at most `limit` samples older than retention, oldest first. Returns how many went. */
export function pruneScopeStorageRows(sql: RedactionSql, nowMs: number, limit: number): number {
  return sql(boundedRetentionDelete('_substrat_scope_storage', 'day'), [
    storageRetentionHorizon(nowMs),
    assertRowLimit('limit', limit),
  ]).length;
}

/** Drop a scope's samples: its storage is gone, so its history describes nothing billable. */
export function forgetScopeStorage(sql: RedactionSql, scopeId: string): void {
  sql('DELETE FROM _substrat_scope_storage WHERE scope_id = ?', [scopeId]);
}

/**
 * Fold latest samples into one gauge. `total` is the caller's count of non-reaped scopes;
 * samples are expected to be the latest per non-reaped scope (`listScopeStorage({ latest })`).
 */
export function foldStorageGauge(
  samples: readonly { bytes: number; readAt: string }[],
  total: number,
): StorageGauge {
  let bytes = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const s of samples) {
    bytes += s.bytes;
    if (oldest === null || s.readAt < oldest) oldest = s.readAt;
    if (newest === null || s.readAt > newest) newest = s.readAt;
  }
  return {
    basis: 'scope-databases',
    excluded: [...STORAGE_EXCLUSIONS],
    bytes,
    sampled: samples.length,
    total,
    oldestReadAt: oldest as StorageGauge['oldestReadAt'],
    newestReadAt: newest as StorageGauge['newestReadAt'],
  };
}
