import {
  STORAGE_EXCLUSIONS,
  scopeStorageSample,
  type ScopeId,
  type ScopeStorageSample,
  type StorageGauge,
  type TenantId,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit, boundedRetentionDelete } from './retention.js';
import { utcDayMonthsBefore } from './billing-retention.js';

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
 *
 * Beside the samples, `_substrat_scope_storage_attempts` keeps one row per scope: when the
 * phase last TRIED, and the error if the read failed. It is what the phase picks due scopes
 * by. Without it a scope whose read keeps failing would stay due and be retried on every
 * pass, ahead of every scope that can be read, and its error would reach every pass's
 * failure digest. With it, a failing scope is tried once a day like any other, while its last
 * good sample stands.
 *
 * `_substrat_scope_attachment_storage` (#2501) is the database table's shape for attachment
 * bytes: the day's latest reading of what the scope's attachment rows sum to, read in the same
 * attempt as the database. It sits beside the database figure and never inside it.
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
  CREATE TABLE IF NOT EXISTS _substrat_scope_storage_attempts (
    scope_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS _substrat_scope_store_storage (
    scope_id TEXT NOT NULL,
    binding TEXT NOT NULL,
    day TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, binding, day)
  );
  CREATE INDEX IF NOT EXISTS _substrat_scope_store_storage_tenant ON _substrat_scope_store_storage (tenant_id, day);
  CREATE TABLE IF NOT EXISTS _substrat_scope_attachment_storage (
    scope_id TEXT NOT NULL,
    day TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, day)
  );
  CREATE INDEX IF NOT EXISTS _substrat_scope_attachment_storage_tenant ON _substrat_scope_attachment_storage (tenant_id, day);
  CREATE INDEX IF NOT EXISTS _substrat_scope_attachment_storage_day ON _substrat_scope_attachment_storage (day);
`;

/**
 * A scope's attachment bytes (#2501), as its own database records them: the sum of the sizes on
 * its `_substrat_attachments` rows, not what the blob store holds. Bytes in the blob store that no
 * row names (an orphan the sweep has not collected, #2314) are not in it, and a fork or snapshot
 * that is itself a stored scope counts its copied rows again, though they name the parent's blobs.
 * Both adapters read it with this one statement.
 */
export const ATTACHMENT_BYTES_SQL = 'SELECT COALESCE(SUM(size), 0) AS bytes FROM _substrat_attachments';

/**
 * The statuses a scope that holds a store can be in: every status but `provisioning` (no
 * store yet) and `reaped` (its store is gone). A non-serving scope (suspended, archiving,
 * archived) still holds its storage until reap, so it is measured and belongs on the bill.
 */
export const STORED_SCOPE_STATUSES = ['active', 'suspended', 'archiving', 'archived'] as const;

/**
 * Whether a scope holds a store to measure (#1524): a `STORED_SCOPE_STATUSES` status, unless
 * it was archived straight from `provisioning` (`archivedFromStatus`). That scope never held
 * data, so it is neither read (a read would create the spine it never had) nor counted. A row
 * archived before the column existed has a null `archivedFromStatus` and is measured, as
 * before. `holdsStoreSql` is the same rule for the directory's SQL.
 */
export function holdsStore(scope: { status: string; archivedFromStatus?: string | null }): boolean {
  if (!(STORED_SCOPE_STATUSES as readonly string[]).includes(scope.status)) return false;
  return !((scope.status === 'archived' || scope.status === 'archiving') && scope.archivedFromStatus === 'provisioning');
}

/** `holdsStore` over a `scopes` row, with an optional table alias (`'s.'`). */
export function holdsStoreSql(alias = ''): string {
  return (
    `${alias}status IN ('active', 'suspended', 'archiving', 'archived') AND NOT ` +
    `(${alias}status IN ('archiving', 'archived') AND ${alias}archived_from_status IS 'provisioning')`
  );
}

/** How long a day's sample is kept: thirteen months, so a year can be compared with the one before it. */
export const STORAGE_GAUGE_RETENTION_MONTHS = 13;

/** How many samples one `pruneScopeStorage` call deletes, by default. */
export const STORAGE_GAUGE_PRUNE_BATCH = 500;

/** The most history rows one `listScopeStorage` call returns, and its default. */
export const STORAGE_HISTORY_LIMIT_MAX = 10_000;
export const STORAGE_HISTORY_LIMIT_DEFAULT = 1_000;

/** What the storage phase hands `recordScopeStorage`: one attempt to read a scope's size. */
export interface ScopeStorageReadingInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The size read, or null when there is none: a failed read (`error` says why), or a scope the reader declined. */
  bytes: number | null;
  error?: string;
  /** When the read was made. Its UTC date is the sample's day. */
  readAt: string;
  /**
   * Scope stores read in the same attempt (#2212). Present means this attempt measured
   * them: an empty list replaces the day's store rows with nothing. Absent leaves them.
   */
  stores?: readonly { binding: string; bytes: number }[];
  /**
   * Attachment bytes read in the same attempt (#2501): what the scope's attachment rows sum to.
   * Present means this attempt measured them, and writes the day's attachment sample. Absent
   * leaves it as it is: the read was not made, failed, or the deployment cannot make it.
   */
  attachments?: number;
}

/** When the phase last tried a scope (#1524), and why it failed if it did. */
export interface ScopeStorageAttempt {
  tenantId: TenantId;
  scopeId: ScopeId;
  attemptedAt: string;
  error: string | null;
}

/**
 * Filter for `listScopeStorage`. `latest` returns one row per stored scope, its most
 * recent day, and ignores `since`/`until`/`limit`: that set is bounded by the scope count,
 * the same as `listScopes`. Otherwise it is history, ordered (scope, day), `since`/`until`
 * inclusive UTC days, at most `limit` rows. History also holds a reaped scope's days (#2515),
 * which count against `limit` as any row does; there is no cursor, so a tenant with many
 * reaped scopes reaches the cap sooner and the scopes sorting last can be cut off.
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
  return utcDayMonthsBefore(nowMs, STORAGE_GAUGE_RETENTION_MONTHS);
}

/**
 * Record attempts, a statement or two each. Every row is written only for a scope the
 * directory holds UNDER THAT TENANT and has not reaped, so a reading can never land in another
 * tenant's figure, and a scope reaped while its read was in flight leaves no row behind.
 *
 * Every attempt replaces the scope's attempt row. One with a database size also upserts the
 * day's sample, which replaces an older reading of that day and never a newer one; a failed
 * database read (no size) leaves every sample alone, so the last good reading stands. The store
 * and attachment samples beside it are written only when the attempt carries them, so a failed
 * read of either leaves its own sample alone while the database sample is still written.
 * Returns how many DATABASE sample rows were written.
 */
export function recordScopeStorageRows(sql: RedactionSql, readings: readonly ScopeStorageReadingInput[]): number {
  let recorded = 0;
  for (const r of readings) {
    const readAt = new Date(r.readAt).toISOString();
    const ok = r.bytes !== null && Number.isInteger(r.bytes) && r.bytes >= 0;
    sql(
      `INSERT INTO _substrat_scope_storage_attempts (scope_id, tenant_id, attempted_at, error)
       SELECT scope_id, tenant_id, ?, ? FROM scopes
        WHERE scope_id = ? AND tenant_id = ? AND ${holdsStoreSql()}
       ON CONFLICT (scope_id) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error
        WHERE excluded.attempted_at >= _substrat_scope_storage_attempts.attempted_at`,
      [readAt, r.error ?? null, r.scopeId, r.tenantId],
    );
    if (!ok) continue;
    recorded += sql(
      `INSERT INTO _substrat_scope_storage (scope_id, day, tenant_id, bytes, read_at)
       SELECT scope_id, ?, tenant_id, ?, ? FROM scopes
        WHERE scope_id = ? AND tenant_id = ? AND ${holdsStoreSql()}
       ON CONFLICT (scope_id, day) DO UPDATE SET bytes = excluded.bytes, read_at = excluded.read_at
        WHERE excluded.read_at >= _substrat_scope_storage.read_at
       RETURNING 1`,
      [storageGaugeDay(readAt), r.bytes, readAt, r.scopeId, r.tenantId],
    ).length;
    if (r.stores) recordScopeStoreRows(sql, r, readAt);
    if (r.attachments !== undefined && Number.isInteger(r.attachments) && r.attachments >= 0) {
      // The database sample's rule: the day's latest reading, never replaced by an older one. Its
      // own literal statement, not one shared with the table above: lint:attachment-writers reads
      // every INSERT's target, and a computed one is a writer it cannot see.
      sql(
        `INSERT INTO _substrat_scope_attachment_storage (scope_id, day, tenant_id, bytes, read_at)
         SELECT scope_id, ?, tenant_id, ?, ? FROM scopes
          WHERE scope_id = ? AND tenant_id = ? AND ${holdsStoreSql()}
         ON CONFLICT (scope_id, day) DO UPDATE SET bytes = excluded.bytes, read_at = excluded.read_at
          WHERE excluded.read_at >= _substrat_scope_attachment_storage.read_at`,
        [storageGaugeDay(readAt), r.attachments, readAt, r.scopeId, r.tenantId],
      );
    }
  }
  return recorded;
}

/**
 * The row that says a day's stores were measured (#2212), whatever they held. Its binding is one
 * no declaration can name (a binding is `[A-Z][A-Z0-9_]*`), and the read skips it. Without it a
 * day that measured no store at all leaves no row, and the latest day with one, older, is billed.
 */
const MEASURED_DAY = '';

/**
 * Replace one scope's store samples for the day. A binding that is gone leaves no row, and an
 * empty list leaves only the measured-day marker. A reading older than the day's recorded one
 * changes nothing, as the database sample's upsert keeps the newer reading.
 */
function recordScopeStoreRows(sql: RedactionSql, reading: ScopeStorageReadingInput, readAt: string): void {
  const day = storageGaugeDay(readAt);
  const newer = sql(
    `SELECT 1 FROM _substrat_scope_store_storage
      WHERE scope_id = ? AND tenant_id = ? AND day = ? AND read_at > ? LIMIT 1`,
    [reading.scopeId, reading.tenantId, day, readAt],
  );
  if (newer.length > 0) return;
  sql(
    `DELETE FROM _substrat_scope_store_storage
      WHERE scope_id = ? AND tenant_id = ? AND day = ?
        AND EXISTS (
          SELECT 1 FROM scopes
           WHERE scope_id = ? AND tenant_id = ? AND ${holdsStoreSql()}
        )`,
    [reading.scopeId, reading.tenantId, day, reading.scopeId, reading.tenantId],
  );
  const rows = (reading.stores ?? []).filter(
    (store) => Number.isInteger(store.bytes) && store.bytes >= 0 && store.binding.length > 0,
  );
  for (const store of [{ binding: MEASURED_DAY, bytes: 0 }, ...rows]) {
    sql(
      `INSERT INTO _substrat_scope_store_storage (scope_id, binding, day, tenant_id, bytes, read_at)
       SELECT scope_id, ?, ?, tenant_id, ?, ? FROM scopes
        WHERE scope_id = ? AND tenant_id = ? AND ${holdsStoreSql()}
       ON CONFLICT (scope_id, binding, day) DO UPDATE SET bytes = excluded.bytes, read_at = excluded.read_at
        WHERE excluded.read_at >= _substrat_scope_store_storage.read_at`,
      [store.binding, day, store.bytes, readAt, reading.scopeId, reading.tenantId],
    );
  }
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
  // History also reads a reaped scope's days (#2515): its storage is gone, but the bytes it held
  // on those days are what a later invoice is cut from. `latest` stays on scopes that hold a store.
  const where: string[] = [filter.latest ? holdsStoreSql('s.') : `(${holdsStoreSql('s.')} OR s.status = 'reaped')`];
  const params: (string | number)[] = [];
  if (filter.tenantId) {
    where.push('s.tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.scopeId) {
    where.push('s.scope_id = ?');
    params.push(filter.scopeId);
  }
  let tail = '';
  // `latest` is joined on the scope's newest day, which the (scope_id, day) key answers with
  // one seek per scope, so a meter read touches one sample per scope however much history
  // retention holds, rather than reading every day and discarding all but the last.
  let latestDay = '';
  if (filter.latest) {
    latestDay = ' AND g.day = (SELECT MAX(m.day) FROM _substrat_scope_storage m WHERE m.scope_id = s.scope_id)';
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
  // The join to `scopes` keeps a fork's leftovers (its row is gone) and a scope that never held
  // a store out of every read; a reaped scope's tombstone row is what admits its kept days.
  const rows = sql(
    `SELECT g.tenant_id, g.scope_id, g.day, g.bytes, g.read_at
       FROM scopes s
       JOIN _substrat_scope_storage g ON g.scope_id = s.scope_id AND g.tenant_id = s.tenant_id${latestDay}
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

/** A bounded projection for a tenant-facing gauge. The sentinel proves when its sum is partial. */
export function readBoundedTenantStorageGauge(
  sql: RedactionSql, tenantId: TenantId, limit: number,
): { gauge: StorageGauge; truncated: boolean } {
  const cap = Math.min(assertRowLimit('limit', limit), 500);
  const rows = sql(
    `SELECT g.bytes, g.read_at, a.attempted_at,
            CASE WHEN a.error IS NULL THEN 0 ELSE 1 END AS failed
       FROM scopes s
       LEFT JOIN _substrat_scope_storage g ON g.scope_id = s.scope_id AND g.tenant_id = s.tenant_id
        AND g.day = (SELECT MAX(m.day) FROM _substrat_scope_storage m WHERE m.scope_id = s.scope_id)
       LEFT JOIN _substrat_scope_storage_attempts a ON a.scope_id = s.scope_id AND a.tenant_id = s.tenant_id
      WHERE s.tenant_id = ? AND ${holdsStoreSql('s.')}
      ORDER BY s.scope_id LIMIT ?`,
    [tenantId, cap + 1],
  ) as { bytes: number | null; read_at: string | null; attempted_at: string | null; failed: number }[];
  const covered = rows.slice(0, cap);
  return {
    gauge: foldStorageGauge(
      covered.filter((row) => row.bytes !== null && row.read_at !== null)
        .map((row) => ({ bytes: row.bytes!, readAt: row.read_at! })),
      covered.length,
      covered.filter((row) => row.attempted_at !== null)
        .map((row) => ({ attemptedAt: row.attempted_at!, error: row.failed ? 'failed' : null })),
    ),
    truncated: rows.length > cap,
  };
}

/**
 * Every stored scope's latest attempt — what the storage phase picks due scopes by, and
 * what a meter reading names failing scopes from. `tenantId` narrows to one tenant.
 */
export function listScopeStorageAttemptRows(sql: RedactionSql, tenantId?: TenantId): ScopeStorageAttempt[] {
  const rows = sql(
    `SELECT a.tenant_id, a.scope_id, a.attempted_at, a.error
       FROM _substrat_scope_storage_attempts a
       JOIN scopes s ON s.scope_id = a.scope_id AND s.tenant_id = a.tenant_id
      WHERE ${holdsStoreSql('s.')}${tenantId ? ' AND s.tenant_id = ?' : ''}
      ORDER BY a.scope_id`,
    tenantId ? [tenantId] : [],
  ) as { tenant_id: string; scope_id: string; attempted_at: string; error: string | null }[];
  return rows.map((r) => ({
    tenantId: r.tenant_id as TenantId,
    scopeId: r.scope_id as ScopeId,
    attemptedAt: r.attempted_at,
    error: r.error,
  }));
}

/**
 * Delete at most `limit` samples older than retention, oldest first: the databases' first, then
 * the stores' and the attachments' with what the limit leaves. Returns how many went.
 */
export function pruneScopeStorageRows(sql: RedactionSql, nowMs: number, limit: number): number {
  const horizon = storageRetentionHorizon(nowMs);
  let remaining = assertRowLimit('limit', limit);
  for (const table of ['_substrat_scope_storage', '_substrat_scope_store_storage', '_substrat_scope_attachment_storage']) {
    if (remaining === 0) break;
    remaining -= sql(boundedRetentionDelete(table, 'day'), [horizon, remaining]).length;
  }
  return limit - remaining;
}

/**
 * Bindings on the latest day that measured stores for the scope. A binding absent that day has
 * stopped, and a day that measured none leaves only its marker, which is not a binding.
 */
export function listScopeStoreStorageRows(
  sql: RedactionSql,
  tenantId?: TenantId,
): { tenantId: TenantId; bytes: number; readAt: string }[] {
  const rows = sql(
    `SELECT g.tenant_id, g.bytes, g.read_at
       FROM scopes s
       JOIN _substrat_scope_store_storage g ON g.scope_id = s.scope_id AND g.tenant_id = s.tenant_id
        AND g.day = (
          SELECT MAX(m.day) FROM _substrat_scope_store_storage m
           WHERE m.scope_id = g.scope_id AND m.tenant_id = g.tenant_id
        )
      WHERE g.binding <> '' AND ${holdsStoreSql('s.')}${tenantId ? ' AND s.tenant_id = ?' : ''}
      ORDER BY g.scope_id, g.binding`,
    tenantId ? [tenantId] : [],
  ) as { tenant_id: string; bytes: number; read_at: string }[];
  return rows.map((r) => ({ tenantId: r.tenant_id as TenantId, bytes: r.bytes, readAt: r.read_at }));
}

/** Each stored scope's latest attachment sample (#2501), as the gauge folds it. */
export function listScopeAttachmentStorageRows(sql: RedactionSql, tenantId?: TenantId): { tenantId: TenantId; bytes: number }[] {
  const rows = sql(
    `SELECT g.tenant_id, g.bytes
       FROM scopes s
       JOIN _substrat_scope_attachment_storage g ON g.scope_id = s.scope_id AND g.tenant_id = s.tenant_id
        AND g.day = (
          SELECT MAX(m.day) FROM _substrat_scope_attachment_storage m
           WHERE m.scope_id = s.scope_id AND m.tenant_id = s.tenant_id
        )
      WHERE ${holdsStoreSql('s.')}${tenantId ? ' AND s.tenant_id = ?' : ''}
      ORDER BY g.scope_id`,
    tenantId ? [tenantId] : [],
  ) as { tenant_id: string; bytes: number }[];
  return rows.map((r) => ({ tenantId: r.tenant_id as TenantId, bytes: r.bytes }));
}

/**
 * A reap ends a scope's measuring (#2515): the attempt row goes, the day rows stay. They are the
 * bytes the scope held on the days it held them, which a later invoice for that month is cut
 * from, so they leave only with retention (`pruneScopeStorageRows`) or the tenant's own reap.
 */
export function retireScopeStorage(sql: RedactionSql, scopeId: string): void {
  sql('DELETE FROM _substrat_scope_storage_attempts WHERE scope_id = ?', [scopeId]);
}

/** Drop everything of a scope's: a deleted fork's rows have no scope row left to be read through. */
export function forgetScopeStorage(sql: RedactionSql, scopeId: string): void {
  sql('DELETE FROM _substrat_scope_storage WHERE scope_id = ?', [scopeId]);
  sql('DELETE FROM _substrat_scope_storage_attempts WHERE scope_id = ?', [scopeId]);
  sql('DELETE FROM _substrat_scope_store_storage WHERE scope_id = ?', [scopeId]);
  sql('DELETE FROM _substrat_scope_attachment_storage WHERE scope_id = ?', [scopeId]);
}

/**
 * Fold latest samples into one gauge. `total` is the caller's count of stored scopes
 * (`STORED_SCOPE_STATUSES`); samples are expected to be the latest per stored scope
 * (`listScopeStorage({ latest })`), and attempts the latest per stored scope
 * (`listScopeStorageAttempts`).
 */
export function foldStorageGauge(
  samples: readonly { bytes: number; readAt: string }[],
  total: number,
  attempts: readonly { attemptedAt: string; error: string | null }[] = [],
  stores?: readonly { bytes: number }[],
  attachments?: readonly { bytes: number }[],
): StorageGauge {
  let failing = 0;
  let lastFailed: string | null = null;
  for (const a of attempts) {
    if (a.error === null) continue;
    failing += 1;
    if (lastFailed === null || a.attemptedAt > lastFailed) lastFailed = a.attemptedAt;
  }
  let bytes = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const s of samples) {
    bytes += s.bytes;
    if (oldest === null || s.readAt < oldest) oldest = s.readAt;
    if (newest === null || s.readAt > newest) newest = s.readAt;
  }
  const storeBytes = stores?.reduce((sum, row) => sum + row.bytes, 0);
  return {
    basis: 'scope-databases',
    excluded: [...STORAGE_EXCLUSIONS],
    bytes,
    sampled: samples.length,
    total,
    oldestReadAt: oldest as StorageGauge['oldestReadAt'],
    newestReadAt: newest as StorageGauge['newestReadAt'],
    failing,
    lastFailedAt: lastFailed as StorageGauge['lastFailedAt'],
    ...(stores && stores.length > 0 ? { stores: { bytes: storeBytes ?? 0, sampled: stores.length } } : {}),
    ...(attachments && attachments.length > 0
      ? { attachments: { bytes: attachments.reduce((sum, row) => sum + row.bytes, 0), sampled: attachments.length } }
      : {}),
  };
}
