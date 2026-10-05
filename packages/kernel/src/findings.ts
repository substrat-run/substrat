import {
  FINDING_RULE_MAX_DAYS,
  findingEntry,
  findingRuleEntry,
  opsFailureFingerprint,
  substratError,
  type ErrorCode,
  type FindingEntry,
  type FindingEvidence,
  type FindingFilter,
  type FindingKind,
  type FindingLikelyCause,
  type FindingRuleEntry,
  type FindingRuleInput,
  type FindingSeverity,
  type FindingStatus,
  type FindingStatusInput,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from './ulid.js';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit, ISSUE_RETENTION_DAYS } from './scope-host.js';

/**
 * How long a finding outlives its last occurrence — the issue store's window, since a Recurring
 * finding is the tenant's projection of an issue and should be recognisable for as long.
 */
export const FINDING_RETENTION_DAYS = ISSUE_RETENTION_DAYS;

/**
 * The findings store (#1748), as statements both adapters run against their directory — the
 * SQLite host over better-sqlite3, the hosted one inside ControlPlaneDO — so the lifecycle is
 * written once. `sql` is the row-returning executor subject erasure already uses.
 *
 * Detection is ON WRITE: the call that records an ops failure or a sweep run also observes the
 * finding it implies, so there is no cron and no scan. Per occurrence that is one indexed rule
 * lookup and one primary-key upsert, over evidence that is already bounded upstream.
 */
export type DirectorySql = RedactionSql;

export const FINDINGS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_findings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    regressed INTEGER NOT NULL DEFAULT 0,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    operation TEXT,
    codes TEXT NOT NULL DEFAULT '[]',
    vertical TEXT,
    scope_id TEXT,
    seen_count INTEGER NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_version TEXT,
    resolved_version TEXT,
    resolved_at TEXT,
    resolution TEXT,
    acknowledged_at TEXT,
    rule_id TEXT,
    evidence TEXT NOT NULL,
    likely_cause TEXT,
    UNIQUE (tenant_id, kind, subject)
  );
  CREATE INDEX IF NOT EXISTS _substrat_findings_tenant_seen ON _substrat_findings (tenant_id, last_seen);
  CREATE INDEX IF NOT EXISTS _substrat_findings_seen ON _substrat_findings (last_seen);
  CREATE TABLE IF NOT EXISTS _substrat_finding_rules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT,
    operation TEXT,
    code TEXT,
    subject TEXT,
    expires_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _substrat_finding_rules_tenant ON _substrat_finding_rules (tenant_id, expires_at);
  CREATE INDEX IF NOT EXISTS _substrat_finding_rules_expiry ON _substrat_finding_rules (expires_at);
`;

/** One occurrence, as a source hands it to `observeFinding`. */
export interface FindingObservation {
  tenantId: string;
  kind: FindingKind;
  subject: string;
  severity: FindingSeverity;
  title: string;
  operation: string | null;
  code: ErrorCode | null;
  vertical: string | null;
  scopeId: string | null;
  version: string | null;
  evidence: FindingEvidence;
}

/**
 * The Recurring source: a tenant's own ops failure, keyed on the same fingerprint as the fleet
 * issue. A failure with no tenant is the platform's own and stays in the staff issue store.
 */
export function findingOfOpsFailure(f: {
  tenantId?: string | null;
  scopeId?: string | null;
  operation: string;
  stage?: string | null;
  code?: ErrorCode | null;
  vertical?: string | null;
  version?: string | null;
}): FindingObservation | null {
  if (!f.tenantId) return null;
  const fingerprint = opsFailureFingerprint(f);
  return {
    tenantId: f.tenantId,
    kind: 'recurring',
    subject: fingerprint,
    severity: 'warning',
    title: `${f.operation} fails${f.stage ? ` at ${f.stage}` : ''}${f.code ? ` (${f.code})` : ''}`,
    operation: f.operation,
    code: f.code ?? null,
    vertical: f.vertical ?? null,
    scopeId: f.scopeId ?? null,
    version: f.version ?? null,
    evidence: { source: 'ops-failures', fingerprint },
  };
}

/**
 * The Invariant and Drift sources: a scheduled run that failed (expected 0 failed runs,
 * observed N) and a freshness expectation judged stale. Every other sweep row implies nothing.
 */
export function findingOfSweepRun(r: {
  kind: string;
  unit: string;
  outcome: string;
  tenantId?: string | null;
  scopeId?: string | null;
  vertical?: string | null;
  version?: string | null;
  operation?: string | null;
  eventType?: string | null;
}): FindingObservation | null {
  if (!r.tenantId || r.outcome !== 'failed') return null;
  const base = {
    tenantId: r.tenantId,
    subject: r.unit,
    code: null,
    vertical: r.vertical ?? null,
    scopeId: r.scopeId ?? null,
    version: r.version ?? null,
  };
  if (r.kind === 'schedule') {
    return {
      ...base,
      kind: 'invariant',
      severity: 'critical',
      title: `Scheduled ${r.operation ?? r.unit} failed`,
      operation: r.operation ?? null,
      evidence: { source: 'sweep-runs', kind: 'schedule', unit: r.unit },
    };
  }
  if (r.kind === 'freshness') {
    return {
      ...base,
      kind: 'drift',
      severity: 'warning',
      title: `${r.eventType ?? r.unit} has gone stale`,
      operation: null,
      evidence: { source: 'sweep-runs', kind: 'freshness', unit: r.unit },
    };
  }
  return null;
}

interface FindingRow {
  id: string;
  tenant_id: string;
  kind: string;
  subject: string;
  status: string;
  regressed: number;
  severity: string;
  title: string;
  operation: string | null;
  codes: string;
  vertical: string | null;
  scope_id: string | null;
  seen_count: number;
  first_seen: string;
  last_seen: string;
  last_version: string | null;
  resolved_version: string | null;
  resolved_at: string | null;
  resolution: string | null;
  acknowledged_at: string | null;
  rule_id: string | null;
  evidence: string;
  likely_cause: string | null;
}

interface RuleRow {
  id: string;
  tenant_id: string;
  kind: string | null;
  operation: string | null;
  code: string | null;
  subject: string | null;
  expires_at: string;
  reason: string;
  created_by: string;
  created_at: string;
}

const FINDING_COLUMNS =
  'id, tenant_id, kind, subject, status, regressed, severity, title, operation, codes, vertical, scope_id, ' +
  'seen_count, first_seen, last_seen, last_version, resolved_version, resolved_at, resolution, acknowledged_at, ' +
  'rule_id, evidence, likely_cause';
const RULE_COLUMNS = 'id, tenant_id, kind, operation, code, subject, expires_at, reason, created_by, created_at';

function findingOf(r: FindingRow): FindingEntry {
  return findingEntry.parse({
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    subject: r.subject,
    status: r.status,
    regressed: r.regressed === 1,
    severity: r.severity,
    title: r.title,
    operation: r.operation,
    codes: JSON.parse(r.codes) as unknown,
    vertical: r.vertical,
    scopeId: r.scope_id,
    count: r.seen_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    lastVersion: r.last_version,
    resolvedVersion: r.resolved_version,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    acknowledgedAt: r.acknowledged_at,
    ruleId: r.rule_id,
    evidence: JSON.parse(r.evidence) as unknown,
    likelyCause: r.likely_cause === null ? null : (JSON.parse(r.likely_cause) as unknown),
  });
}

function ruleOf(r: RuleRow): FindingRuleEntry {
  return findingRuleEntry.parse({
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    operation: r.operation,
    code: r.code,
    subject: r.subject,
    expiresAt: r.expires_at,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
  });
}

function rowById(sql: DirectorySql, tenantId: string, id: string): FindingRow | undefined {
  return sql(`SELECT ${FINDING_COLUMNS} FROM _substrat_findings WHERE tenant_id = ? AND id = ?`, [tenantId, id])[0] as
    | FindingRow
    | undefined;
}

/**
 * The unexpired rule covering this occurrence, if any. A rule field left NULL matches anything;
 * a set one must equal the occurrence's — and `= NULL` is never true, so a rule naming an
 * operation never covers a finding that has none.
 */
function activeRule(
  sql: DirectorySql,
  o: { tenantId: string; kind: string; operation: string | null; code: string | null; subject: string },
  at: string,
): string | null {
  const row = sql(
    `SELECT id FROM _substrat_finding_rules
      WHERE tenant_id = ? AND expires_at > ?
        AND (kind IS NULL OR kind = ?)
        AND (operation IS NULL OR operation = ?)
        AND (code IS NULL OR code = ?)
        AND (subject IS NULL OR subject = ?)
      ORDER BY expires_at DESC, id LIMIT 1`,
    [o.tenantId, at, o.kind, o.operation, o.code, o.subject],
  )[0] as { id: string } | undefined;
  return row?.id ?? null;
}

const MAX_CODES = 5;

/**
 * Record one occurrence on its finding, opening it if new. The transitions, in order:
 * - an unexpired rule covers it → `suppressed` (counted all the same: suppressing hides the
 *   finding, never the evidence);
 * - it was `resolved` → `open`, `regressed`, and when it came back under a version other than
 *   the one it was resolved under, that version is the likely cause;
 * - it was `suppressed` and no rule covers it any longer → `open`;
 * - otherwise the status stands (`acked` stays acked: somebody is already on it).
 */
export function observeFinding(sql: DirectorySql, o: FindingObservation, at: string): void {
  const ruleId = activeRule(sql, o, at);
  const existing = sql(
    `SELECT ${FINDING_COLUMNS} FROM _substrat_findings WHERE tenant_id = ? AND kind = ? AND subject = ?`,
    [o.tenantId, o.kind, o.subject],
  )[0] as FindingRow | undefined;
  if (!existing) {
    sql(
      `INSERT INTO _substrat_findings (${FINDING_COLUMNS})
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      [
        ulid(),
        o.tenantId,
        o.kind,
        o.subject,
        ruleId ? 'suppressed' : 'open',
        o.severity,
        o.title,
        o.operation,
        JSON.stringify(o.code ? [o.code] : []),
        o.vertical,
        o.scopeId,
        at,
        at,
        o.version,
        ruleId,
        JSON.stringify(o.evidence),
      ],
    );
    return;
  }
  let status = existing.status as FindingStatus;
  let regressed = existing.regressed;
  let likelyCause = existing.likely_cause;
  if (ruleId) {
    status = 'suppressed';
  } else if (status === 'resolved') {
    status = 'open';
    regressed = 1;
    if (o.version !== null && o.version !== existing.resolved_version) {
      const cause: FindingLikelyCause = {
        kind: 'deploy',
        version: o.version,
        reason: existing.resolved_version
          ? `resolved under ${existing.resolved_version}, seen again under ${o.version}`
          : `seen again under ${o.version} after it was resolved`,
      };
      likelyCause = JSON.stringify(cause);
    }
  } else if (status === 'suppressed') {
    status = 'open';
  }
  const codes = JSON.parse(existing.codes) as string[];
  const nextCodes = o.code ? [o.code, ...codes.filter((c) => c !== o.code)].slice(0, MAX_CODES) : codes;
  sql(
    `UPDATE _substrat_findings SET
       status = ?, regressed = ?, rule_id = ?, likely_cause = ?, codes = ?,
       seen_count = seen_count + 1, last_seen = ?,
       last_version = COALESCE(?, last_version), vertical = COALESCE(?, vertical), scope_id = COALESCE(?, scope_id)
     WHERE id = ?`,
    [
      status,
      regressed,
      status === 'suppressed' ? ruleId : null,
      likelyCause,
      JSON.stringify(nextCodes),
      at,
      o.version,
      o.vertical,
      o.scopeId,
      existing.id,
    ],
  );
}

/**
 * Findings, most recently seen first. No cursor, like the issue read it projects: the
 * cardinality is the number of distinct shapes a tenant has, and `limit` bounds it.
 */
export function listFindings(sql: DirectorySql, filter: FindingFilter = {}): FindingEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tenantId !== undefined) {
    where.push('tenant_id = ?');
    params.push(filter.tenantId);
  }
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind !== undefined) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  params.push(assertRowLimit('limit', filter.limit ?? 100));
  const rows = sql(
    `SELECT ${FINDING_COLUMNS} FROM _substrat_findings` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY last_seen DESC, id LIMIT ?',
    params,
  ) as FindingRow[];
  return rows.map(findingOf);
}

export interface FindingChange {
  before: FindingEntry;
  after: FindingEntry;
}

/**
 * A person's verdict: acknowledge, resolve, or reopen. Keyed on (tenant, id), so a tenant can
 * never move another tenant's finding by guessing its id. Reopening a suppressed finding lifts
 * it out of its rule for now; the next occurrence the rule still covers suppresses it again —
 * revoking the rule is what ends a suppression.
 */
export function setFindingStatus(
  sql: DirectorySql,
  tenantId: TenantId,
  id: string,
  status: FindingStatusInput,
  at: string,
): FindingChange | undefined {
  const existing = rowById(sql, tenantId, id);
  if (!existing) return undefined;
  const resolved = status === 'resolved';
  sql(
    `UPDATE _substrat_findings SET
       status = ?, rule_id = NULL,
       regressed = CASE WHEN ? THEN 0 ELSE regressed END,
       resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END,
       resolved_version = CASE WHEN ? THEN last_version ELSE resolved_version END,
       resolution = CASE WHEN ? THEN 'verdict' ELSE resolution END,
       acknowledged_at = CASE WHEN ? = 'acked' THEN ? WHEN ? = 'open' THEN NULL ELSE acknowledged_at END
     WHERE id = ?`,
    [status, resolved ? 1 : 0, resolved ? 1 : 0, at, resolved ? 1 : 0, resolved ? 1 : 0, status, at, status, id],
  );
  return { before: findingOf(existing), after: findingOf(rowById(sql, tenantId, id)!) };
}

/**
 * A rule expires in the future and within `FINDING_RULE_MAX_DAYS` of `at`. Exported so a host
 * whose store sits behind an RPC hop can refuse BEFORE it, where the refusal keeps its code.
 */
export function assertFindingRuleExpiry(expiresAt: string, at: string): void {
  if (!(expiresAt > at)) throw substratError('validation_failed', 'a suppress rule must expire in the future');
  const ceiling = new Date(Date.parse(at) + FINDING_RULE_MAX_DAYS * 86_400_000).toISOString();
  if (expiresAt > ceiling) {
    throw substratError('validation_failed', `a suppress rule lasts at most ${FINDING_RULE_MAX_DAYS} days`);
  }
}

/**
 * Create a suppress rule and apply it to the findings it covers now: each one not already
 * resolved becomes `suppressed` under it. Returns the rule and the ids it suppressed, for the
 * caller's audit row. The input is parsed by the caller (`findingRuleInput`); the expiry is
 * held here (`assertFindingRuleExpiry`), against the same `at` every other write in the call uses.
 */
export function createFindingRule(
  sql: DirectorySql,
  tenantId: TenantId,
  input: FindingRuleInput,
  createdBy: string,
  at: string,
): { rule: FindingRuleEntry; suppressed: string[] } {
  assertFindingRuleExpiry(input.expiresAt, at);
  const id = ulid();
  sql(`INSERT INTO _substrat_finding_rules (${RULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id,
    tenantId,
    input.kind ?? null,
    input.operation ?? null,
    input.code ?? null,
    input.subject ?? null,
    input.expiresAt,
    input.reason,
    createdBy,
    at,
  ]);
  const covered = sql(
    `SELECT id FROM _substrat_findings
      WHERE tenant_id = ? AND status IN ('open', 'acked', 'suppressed')
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR operation = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(codes) WHERE value = ?))
        AND (? IS NULL OR subject = ?)`,
    [
      tenantId,
      input.kind ?? null,
      input.kind ?? null,
      input.operation ?? null,
      input.operation ?? null,
      input.code ?? null,
      input.code ?? null,
      input.subject ?? null,
      input.subject ?? null,
    ],
  ) as { id: string }[];
  for (const { id: findingId } of covered) {
    sql(`UPDATE _substrat_findings SET status = 'suppressed', rule_id = ? WHERE id = ?`, [id, findingId]);
  }
  return {
    rule: ruleOf(sql(`SELECT ${RULE_COLUMNS} FROM _substrat_finding_rules WHERE id = ?`, [id])[0] as RuleRow),
    suppressed: covered.map((c) => c.id),
  };
}

/**
 * End a rule now. Its findings stay suppressed until their next occurrence, which then opens
 * them — the same thing an expiry does, brought forward.
 */
export function revokeFindingRule(
  sql: DirectorySql,
  tenantId: TenantId,
  ruleId: string,
  at: string,
): { before: FindingRuleEntry; after: FindingRuleEntry } | undefined {
  const read = () =>
    sql(`SELECT ${RULE_COLUMNS} FROM _substrat_finding_rules WHERE tenant_id = ? AND id = ?`, [tenantId, ruleId])[0] as
      | RuleRow
      | undefined;
  const existing = read();
  if (!existing) return undefined;
  if (existing.expires_at > at) {
    sql('UPDATE _substrat_finding_rules SET expires_at = ? WHERE id = ?', [at, ruleId]);
  }
  return { before: ruleOf(existing), after: ruleOf(read()!) };
}

/** A tenant's rules, newest first; `activeAt` keeps only those unexpired at that instant. */
export function listFindingRules(
  sql: DirectorySql,
  tenantId: TenantId | undefined,
  activeAt?: string,
  limit = 100,
): FindingRuleEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (tenantId !== undefined) {
    where.push('tenant_id = ?');
    params.push(tenantId);
  }
  if (activeAt !== undefined) {
    where.push('expires_at > ?');
    params.push(activeAt);
  }
  params.push(assertRowLimit('limit', limit));
  return (
    sql(
      `SELECT ${RULE_COLUMNS} FROM _substrat_finding_rules` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY created_at DESC, id DESC LIMIT ?',
      params,
    ) as RuleRow[]
  ).map(ruleOf);
}

/**
 * The findings half of the retention pass, bounded by `limit` per step, oldest first.
 *
 * An `open` or `acked` finding is never deleted for going quiet: deleting it would take it out
 * of the inbox of whoever was watching it with nothing said. One quiet for the whole
 * `FINDING_RETENTION_DAYS` is RESOLVED as `stale` instead, and returned so the caller can audit each one.
 * A `resolved` or `suppressed` finding is deleted once both its last occurrence and its last
 * resolve are past the horizon — so a stale-resolved finding stays readable for one more window.
 * An expired rule is deleted once its expiry is past the horizon; the admin log keeps its story.
 */
export function findingRetention(
  sql: DirectorySql,
  nowMs: number,
  limit: number,
): { deleted: number; staled: FindingChange[]; rulesDeleted: number } {
  assertRowLimit('limit', limit);
  const now = new Date(nowMs).toISOString();
  const horizon = new Date(nowMs - FINDING_RETENTION_DAYS * 86_400_000).toISOString();
  const quiet = sql(
    `SELECT ${FINDING_COLUMNS} FROM _substrat_findings
      WHERE last_seen < ? AND status IN ('open', 'acked') ORDER BY last_seen LIMIT ?`,
    [horizon, limit],
  ) as FindingRow[];
  const staled: FindingChange[] = [];
  for (const row of quiet) {
    sql(
      `UPDATE _substrat_findings SET status = 'resolved', resolution = 'stale', resolved_at = ?,
         resolved_version = last_version, regressed = 0
       WHERE id = ?`,
      [now, row.id],
    );
    staled.push({ before: findingOf(row), after: findingOf(rowById(sql, row.tenant_id, row.id)!) });
  }
  const deleted = sql(
    `DELETE FROM _substrat_findings WHERE rowid IN (
       SELECT rowid FROM _substrat_findings
        WHERE last_seen < ? AND status IN ('resolved', 'suppressed')
          AND (resolved_at IS NULL OR resolved_at < ?)
        ORDER BY last_seen LIMIT ?) RETURNING 1`,
    [horizon, horizon, limit],
  ).length;
  const rulesDeleted = sql(
    `DELETE FROM _substrat_finding_rules WHERE rowid IN (
       SELECT rowid FROM _substrat_finding_rules WHERE expires_at < ? ORDER BY expires_at LIMIT ?) RETURNING 1`,
    [horizon, limit],
  ).length;
  return { deleted, staled, rulesDeleted };
}
