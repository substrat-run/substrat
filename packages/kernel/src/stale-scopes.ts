import {
  staleScope,
  staleScopeTake,
  type Instant,
  type ScopeId,
  type StaleScope,
  type StaleScopeFindingKind,
  type StaleScopeTake,
  type TenantId,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit } from './retention.js';
import { pushDayWindow, utcDayOf } from './billing-retention.js';

/**
 * The daily stale-scopes report (#3313), as statements both adapters run against their directory:
 * the SQLite host over better-sqlite3, the hosted one inside ControlPlaneDO. Written once so the
 * two cannot report different things about the same fleet.
 *
 * It finds the scopes nothing will ever clean up: an active scope nobody uses, a fork with no
 * expiry, a scope stuck half-made, one whose tenant or vertical is gone. It REPORTS and never moves
 * a scope: a person archives through the doors that exist, and the retention reap deletes. Every
 * finding but `idle` is decided from the directory's own rows, so no scope is woken (§5.4).
 *
 * `idle` reads the daily request rollup (`request-rollup.ts`): a scope's "last used" is the newest
 * UTC day the rollup counted a routed request for it. That is the router's count of the requests it
 * dispatched, so a scope reached only by peer calls or schedules has none, and a scope used once a
 * year looks like a dead one. Nothing is stamped on the request path: a last-seen write there would
 * be a write to the singleton directory on every request.
 *
 * `_substrat_stale_scopes` holds one row per (scope, finding) the latest report made, with the first
 * and latest report that made it, so the list says how long each has been true rather than raising
 * a fresh alert every day. A finding the latest report no longer makes is deleted.
 * `_substrat_stale_scope_takes` holds one row per day a pass tried, with `meterDayTake`'s rules: a
 * day is reported once, and a failed attempt carries the run of identical failures it belongs to.
 */
export const STALE_SCOPES_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_stale_scopes (
    scope_id TEXT NOT NULL,
    finding TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    vertical TEXT,
    kind TEXT,
    status TEXT NOT NULL,
    forked_from TEXT,
    created_at TEXT NOT NULL,
    last_request_day TEXT,
    detail TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (scope_id, finding)
  );
  CREATE INDEX IF NOT EXISTS _substrat_stale_scopes_tenant ON _substrat_stale_scopes (tenant_id, finding);
  CREATE TABLE IF NOT EXISTS _substrat_stale_scope_takes (
    day TEXT PRIMARY KEY,
    attempted_at TEXT NOT NULL,
    taken_at TEXT,
    finding_count INTEGER,
    idle_judged INTEGER,
    error TEXT,
    failing_since TEXT,
    failing_count INTEGER
  );
`;

/** How many days without a routed request make an active primary scope `idle`, by default. */
export const STALE_SCOPE_IDLE_DAYS = 30;
/**
 * The shortest and longest idle windows. At least 3, because the two newest days may not be rolled
 * up yet and a window must hold a day that is; at most 85, the request rollup's lookback, because a
 * window it cannot cover is never judged.
 */
export const STALE_SCOPE_IDLE_DAYS_MIN = 3;
export const STALE_SCOPE_IDLE_DAYS_MAX = 85;
/** How long a scope may sit in `provisioning` before it is `stuck-provisioning`, by default. */
export const STALE_SCOPE_STUCK_MS = 86_400_000;
/**
 * How long past its `expiresAt` a fork may stay before it is `expired-not-reaped`, by default. The
 * GC runs every pass, so a day is many failed attempts, never one that is merely due.
 */
export const STALE_SCOPE_EXPIRED_GRACE_MS = 86_400_000;
/** How long one report may take before the pass counts the attempt failed, by default. */
export const STALE_SCOPES_TIMEOUT_MS = 30_000;

/** The most rows one `listStaleScopes` call returns, and its default. */
export const STALE_SCOPES_LIMIT_MAX = 10_000;
export const STALE_SCOPES_LIMIT_DEFAULT = 1_000;

const DAY_MS = 86_400_000;
/** The statuses a scope still holds data or a slot in: every one but archived and reaped. */
const LIVE = `('provisioning', 'active', 'suspended', 'archiving')`;
/** A fork or a clean-room preview: `isPrimaryScope`'s negation, over a directory row. */
const COPY = `(s.forked_from IS NOT NULL OR s.kind = 'preview')`;

/** The thresholds a report judges by. Each defaults to the constant above. */
export interface StaleScopeThresholds {
  /** `STALE_SCOPE_IDLE_DAYS_MIN` to `STALE_SCOPE_IDLE_DAYS_MAX`. */
  idleAfterDays?: number;
  stuckAfterMs?: number;
  expiredGraceMs?: number;
}

/**
 * One attempt at the report of the UTC day of `at`. Without `error` the directory takes it; with
 * it, the attempt failed and only the failure is recorded, naming the run it extends.
 */
export type StaleScopeTakeInput =
  | ({ at: string } & StaleScopeThresholds)
  | { at: string; error: string; failingSince?: string; failingCount?: number };

/** What one attempt did. */
export interface StaleScopeTakeResult {
  day: string;
  /** Whether this call took the day's report. False on every later attempt of the day. */
  taken: boolean;
  /** Findings the report holds, by kind; all zero when not taken. */
  findings: Record<StaleScopeFindingKind, number>;
  /** Findings this report made that the one before it did not. */
  opened: number;
  /** Findings the report before it made that this one did not. */
  resolved: number;
  idleJudged: boolean;
}

/** Filter for `listStaleScopes`: ordered by (tenant, finding, first seen, scope), at most `limit` rows. */
export interface StaleScopeFilter {
  tenantId?: TenantId;
  finding?: StaleScopeFindingKind;
  limit?: number;
}

/** Filter for `listStaleScopeTakes`: inclusive UTC days. */
export interface StaleScopeTakeFilter {
  since?: string;
  until?: string;
}

const emptyCounts = (): Record<StaleScopeFindingKind, number> => ({
  'tenant-not-active': 0,
  'vertical-gone': 0,
  unreachable: 0,
  'stuck-provisioning': 0,
  'no-expiry': 0,
  'expired-not-reaped': 0,
  'archived-undated': 0,
  idle: 0,
});

interface ScopeRow {
  scope_id: string;
  tenant_id: string;
  vertical: string | null;
  kind: string | null;
  status: string;
  forked_from: string | null;
  created_at: string;
  expires_at: string | null;
  tenant_status?: string | null;
}

interface Finding {
  row: ScopeRow;
  finding: StaleScopeFindingKind;
  detail: string;
}

const SCOPE_COLUMNS = 's.scope_id, s.tenant_id, s.vertical, s.kind, s.status, s.forked_from, s.created_at, s.expires_at';

function positiveMs(name: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0)) throw new Error(`${name} must be a non-negative number of ms, got ${String(value)}`);
  return value;
}

/** Whether `idleAfterDays` is a whole number of days the report can judge. */
export function assertIdleDays(name: string, days: number): number {
  if (!(Number.isInteger(days) && days >= STALE_SCOPE_IDLE_DAYS_MIN && days <= STALE_SCOPE_IDLE_DAYS_MAX)) {
    throw new Error(`${name} must be a whole number of days from ${STALE_SCOPE_IDLE_DAYS_MIN} to ${STALE_SCOPE_IDLE_DAYS_MAX}, got ${String(days)}`);
  }
  return days;
}

/**
 * Every finding the directory supports at `at`. Pure reads, in the caller's transaction.
 * `idleJudged` is false when the request rollup has not read every day of the idle window, which
 * is a fleet without the rollup (a self-hosted directory) or one that started it recently.
 */
export function staleScopeFindingsAt(
  sql: RedactionSql,
  at: Instant,
  thresholds: StaleScopeThresholds = {},
): { findings: Finding[]; lastRequestDay: Map<string, string>; idleJudged: boolean } {
  const atMs = Date.parse(at);
  const idleDays = assertIdleDays('idleAfterDays', thresholds.idleAfterDays ?? STALE_SCOPE_IDLE_DAYS);
  const stuckBefore = new Date(atMs - positiveMs('stuckAfterMs', thresholds.stuckAfterMs ?? STALE_SCOPE_STUCK_MS)).toISOString();
  const expiredBefore = new Date(
    atMs - positiveMs('expiredGraceMs', thresholds.expiredGraceMs ?? STALE_SCOPE_EXPIRED_GRACE_MS),
  ).toISOString();
  const findings: Finding[] = [];
  const add = (rows: unknown[], finding: StaleScopeFindingKind, detail: (row: ScopeRow) => string) => {
    for (const row of rows as ScopeRow[]) findings.push({ row, finding, detail: detail(row) });
  };

  add(
    sql(
      `SELECT ${SCOPE_COLUMNS}, t.status AS tenant_status FROM scopes s LEFT JOIN tenants t ON t.tenant_id = s.tenant_id
        WHERE s.status IN ${LIVE} AND (t.status IS NULL OR t.status <> 'active')`,
      [],
    ),
    'tenant-not-active',
    (r) => (r.tenant_status ? `its tenant is ${r.tenant_status}` : 'its tenant is gone from the directory'),
  );
  add(
    sql(
      `SELECT ${SCOPE_COLUMNS} FROM scopes s
        WHERE s.status IN ${LIVE} AND s.vertical IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM verticals v WHERE v.slug = s.vertical)`,
      [],
    ),
    'vertical-gone',
    (r) => `its vertical ${r.vertical} is gone from the registry`,
  );
  add(
    sql(
      `SELECT ${SCOPE_COLUMNS} FROM scopes s
        WHERE s.status = 'active' AND NOT ${COPY}
          AND NOT EXISTS (SELECT 1 FROM hostnames h WHERE h.scope_id = s.scope_id)
          AND NOT EXISTS (SELECT 1 FROM peer_bindings p WHERE p.target_scope_id = s.scope_id AND p.invalidated = 0)`,
      [],
    ),
    'unreachable',
    () => 'no hostname and no peer binding reaches it',
  );
  add(
    sql(`SELECT ${SCOPE_COLUMNS} FROM scopes s WHERE s.status = 'provisioning' AND s.created_at <= ?`, [stuckBefore]),
    'stuck-provisioning',
    (r) => `still provisioning since ${r.created_at}`,
  );
  add(
    sql(`SELECT ${SCOPE_COLUMNS} FROM scopes s WHERE ${COPY} AND s.expires_at IS NULL AND s.status IN ${LIVE}`, []),
    'no-expiry',
    (r) =>
      r.forked_from
        ? `a copy of ${r.forked_from} with no expiry: the snapshot GC never reaps it`
        : 'a preview with no expiry: the snapshot GC never reaps it',
  );
  add(
    sql(
      `SELECT ${SCOPE_COLUMNS} FROM scopes s
        WHERE ${COPY} AND s.expires_at IS NOT NULL AND s.expires_at <= ? AND s.status <> 'reaped'`,
      [expiredBefore],
    ),
    'expired-not-reaped',
    (r) => `expired at ${r.expires_at ?? ''} and the snapshot GC has not reaped it`,
  );
  add(
    sql(`SELECT ${SCOPE_COLUMNS} FROM scopes s WHERE s.status = 'archived' AND s.archived_at IS NULL`, []),
    'archived-undated',
    () => 'archived with no archivedAt: the retention reap skips it',
  );

  const lastRequestDay = new Map(
    (
      sql(
        `SELECT scope_id, MAX(day) AS day FROM _substrat_request_days WHERE requests > 0 GROUP BY scope_id`,
        [],
      ) as { scope_id: string; day: string }[]
    ).map((r) => [r.scope_id, r.day]),
  );

  // Idle is judged only over a window the rollup has read: its first day, and every day after it
  // that has ended and settled. A gap (a day whose read failed and waits its retry) holds the
  // judgement back rather than reading as a day without traffic.
  const windowStart = utcDayOf(atMs - idleDays * DAY_MS);
  const lastDay = utcDayOf(atMs - 2 * DAY_MS);
  const read = sql(
    `SELECT COUNT(*) AS n FROM _substrat_request_day_reads WHERE day >= ? AND day <= ? AND read_at IS NOT NULL`,
    [windowStart, lastDay],
  ) as { n: number }[];
  const windowDays = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${windowStart}T00:00:00Z`)) / DAY_MS) + 1;
  const idleJudged = (read[0]?.n ?? 0) >= windowDays;
  if (idleJudged) {
    const idleSince = new Date(atMs - idleDays * DAY_MS).toISOString();
    const candidates = sql(
      `SELECT ${SCOPE_COLUMNS} FROM scopes s WHERE s.status = 'active' AND NOT ${COPY} AND s.created_at <= ?`,
      [idleSince],
    ) as ScopeRow[];
    for (const row of candidates) {
      const last = lastRequestDay.get(row.scope_id);
      if (last !== undefined && last >= windowStart) continue;
      findings.push({
        row,
        finding: 'idle',
        detail: last
          ? `no routed request in ${idleDays} days; the last was on ${last}`
          : `no routed request in ${idleDays} days, and none on record`,
      });
    }
  }
  return { findings, lastRequestDay, idleJudged };
}

/**
 * Record one attempt at the report of the UTC day of `input.at`, in the caller's transaction.
 *
 * Without an error, it takes the report unless the day already has one: it reads the findings
 * (`staleScopeFindingsAt`), upserts each (a new one gets `firstSeen`, every one gets `lastSeen` and
 * its current detail), deletes every listed finding it did not make, and marks the day taken. When
 * idle was not judged, the listed `idle` findings are left as they were. Every row is parsed before
 * the first write, so a row that does not parse refuses the whole day.
 *
 * With an error, it records only the attempt and its run, and never over a day already taken.
 */
export function recordStaleScopeRows(sql: RedactionSql, input: StaleScopeTakeInput): StaleScopeTakeResult {
  const at = new Date(input.at).toISOString() as Instant;
  const day = at.slice(0, 10);
  const none: StaleScopeTakeResult = { day, taken: false, findings: emptyCounts(), opened: 0, resolved: 0, idleJudged: false };
  if ('error' in input) {
    const since = new Date(input.failingSince ?? at).toISOString();
    const count = input.failingCount ?? 1;
    if (!(Number.isInteger(count) && count >= 1)) {
      throw new Error(`failingCount must be a whole number, at least one, got ${String(count)}`);
    }
    sql(
      `INSERT INTO _substrat_stale_scope_takes
         (day, attempted_at, taken_at, finding_count, idle_judged, error, failing_since, failing_count)
       VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         attempted_at = excluded.attempted_at, error = excluded.error,
         failing_since = excluded.failing_since, failing_count = excluded.failing_count
       WHERE _substrat_stale_scope_takes.taken_at IS NULL`,
      [day, at, input.error || 'the report failed', since, count],
    );
    return none;
  }
  const prior = sql('SELECT taken_at FROM _substrat_stale_scope_takes WHERE day = ?', [day]) as { taken_at: string | null }[];
  if (prior[0]?.taken_at) return none;

  const { findings, lastRequestDay, idleJudged } = staleScopeFindingsAt(sql, at, input);
  const tenantSlug = new Map(
    (sql('SELECT tenant_id, slug FROM tenants', []) as { tenant_id: string; slug: string }[]).map((t) => [t.tenant_id, t.slug]),
  );
  const existing = new Map(
    (
      sql('SELECT scope_id, finding, first_seen FROM _substrat_stale_scopes', []) as {
        scope_id: string;
        finding: string;
        first_seen: string;
      }[]
    ).map((r) => [`${r.scope_id} ${r.finding}`, r.first_seen]),
  );
  // Parsed before the first write: a row that does not read as a finding refuses the day.
  const rows = findings.map((f) =>
    staleScope.parse({
      tenantId: f.row.tenant_id,
      tenantSlug: tenantSlug.get(f.row.tenant_id) ?? null,
      scopeId: f.row.scope_id,
      finding: f.finding,
      vertical: f.row.vertical,
      kind: f.row.kind,
      status: f.row.status,
      forkedFrom: f.row.forked_from,
      createdAt: f.row.created_at,
      lastRequestDay: lastRequestDay.get(f.row.scope_id) ?? null,
      detail: f.detail,
      firstSeen: existing.get(`${f.row.scope_id} ${f.finding}`) ?? at,
      lastSeen: at,
    }),
  );

  const counts = emptyCounts();
  let opened = 0;
  for (const r of rows) {
    counts[r.finding] += 1;
    if (!existing.has(`${r.scopeId} ${r.finding}`)) opened += 1;
    sql(
      `INSERT INTO _substrat_stale_scopes
         (scope_id, finding, tenant_id, vertical, kind, status, forked_from, created_at, last_request_day, detail, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope_id, finding) DO UPDATE SET
         tenant_id = excluded.tenant_id, vertical = excluded.vertical, kind = excluded.kind, status = excluded.status,
         forked_from = excluded.forked_from, created_at = excluded.created_at,
         last_request_day = excluded.last_request_day, detail = excluded.detail, last_seen = excluded.last_seen`,
      [
        r.scopeId,
        r.finding,
        r.tenantId,
        r.vertical,
        r.kind,
        r.status,
        r.forkedFrom,
        r.createdAt,
        r.lastRequestDay,
        r.detail,
        r.firstSeen,
        r.lastSeen,
      ],
    );
  }
  const keep = idleJudged ? '' : ` AND finding <> 'idle'`;
  const resolved = (sql(`SELECT COUNT(*) AS n FROM _substrat_stale_scopes WHERE last_seen <> ?${keep}`, [at]) as { n: number }[])[0]?.n ?? 0;
  sql(`DELETE FROM _substrat_stale_scopes WHERE last_seen <> ?${keep}`, [at]);
  if (!idleJudged) counts.idle = (sql(`SELECT COUNT(*) AS n FROM _substrat_stale_scopes WHERE finding = 'idle'`, []) as { n: number }[])[0]?.n ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  sql(
    `INSERT INTO _substrat_stale_scope_takes
       (day, attempted_at, taken_at, finding_count, idle_judged, error, failing_since, failing_count)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT (day) DO UPDATE SET
       attempted_at = excluded.attempted_at, taken_at = excluded.taken_at, finding_count = excluded.finding_count,
       idle_judged = excluded.idle_judged, error = NULL, failing_since = NULL, failing_count = NULL`,
    [day, at, at, total, idleJudged ? 1 : 0],
  );
  return { day, taken: true, findings: counts, opened, resolved, idleJudged };
}

interface StaleScopeRow {
  scope_id: string;
  finding: string;
  tenant_id: string;
  tenant_slug: string | null;
  vertical: string | null;
  kind: string | null;
  status: string;
  forked_from: string | null;
  created_at: string;
  last_request_day: string | null;
  detail: string;
  first_seen: string;
  last_seen: string;
}

/** The current findings — see `StaleScopeFilter`. Every row is parsed on the way out. */
export function listStaleScopeRows(sql: RedactionSql, filter: StaleScopeFilter = {}): StaleScope[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tenantId !== undefined) {
    where.push('f.tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.finding !== undefined) {
    where.push('f.finding = ?');
    params.push(filter.finding);
  }
  params.push(Math.min(assertRowLimit('limit', filter.limit ?? STALE_SCOPES_LIMIT_DEFAULT), STALE_SCOPES_LIMIT_MAX));
  const rows = sql(
    `SELECT f.scope_id, f.finding, f.tenant_id, t.slug AS tenant_slug, f.vertical, f.kind, f.status, f.forked_from,
            f.created_at, f.last_request_day, f.detail, f.first_seen, f.last_seen
       FROM _substrat_stale_scopes f LEFT JOIN tenants t ON t.tenant_id = f.tenant_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.tenant_id, f.finding, f.first_seen, f.scope_id LIMIT ?`,
    params,
  ) as StaleScopeRow[];
  return rows.map((r) =>
    staleScope.parse({
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      scopeId: r.scope_id as ScopeId,
      finding: r.finding,
      vertical: r.vertical,
      kind: r.kind,
      status: r.status,
      forkedFrom: r.forked_from,
      createdAt: r.created_at,
      lastRequestDay: r.last_request_day,
      detail: r.detail,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }),
  );
}

/** The report's record of each day it tried, in day order — see `StaleScopeTakeFilter`. */
export function listStaleScopeTakeRows(sql: RedactionSql, filter: StaleScopeTakeFilter = {}): StaleScopeTake[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  pushDayWindow(filter, where, params);
  const rows = sql(
    `SELECT day, attempted_at, taken_at, finding_count, idle_judged, error, failing_since, failing_count
       FROM _substrat_stale_scope_takes
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day`,
    params,
  ) as {
    day: string;
    attempted_at: string;
    taken_at: string | null;
    finding_count: number | null;
    idle_judged: number | null;
    error: string | null;
    failing_since: string | null;
    failing_count: number | null;
  }[];
  return rows.map((r) =>
    staleScopeTake.parse({
      day: r.day,
      attemptedAt: r.attempted_at,
      takenAt: r.taken_at,
      findings: r.finding_count,
      idleJudged: r.idle_judged === null ? null : r.idle_judged === 1,
      error: r.error,
      failingSince: r.failing_since,
      failingCount: r.failing_count,
    }),
  );
}
