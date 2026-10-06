/**
 * Closing an audited change whose outcome was never written (#2064), shared by both adapters.
 *
 * The owner hand-over (#1665) and dashboard member management (#1150) audit a change made in the
 * vertical's own deployment in two rows paired by `operationId`: an `intent`, then `applied`,
 * `refused` or `failed`. The two stores are separate, so an intent can be left with no outcome:
 * its outcome write failed, or the request died between the two. The control plane's scheduled
 * pass finds such an intent and asks the host to settle it through
 * `HostAdmin.settleUnrecordedOutcome`.
 *
 * **The settle is one transaction, and it claims the outcome only if none exists.** It reads
 * the intent by id, checks there is no outcome row for the operation, then writes the `unknown`
 * row and the ops-failure row that brings it to the staff digest. Two passes that race settle
 * once. An outcome that lands before the settle runs wins, and the settle writes nothing.
 * Because the ops-failure row is written in the same unit, an `unknown` row cannot exist without
 * the digest hearing of it.
 *
 * **A real outcome supersedes `unknown`, by priority, not by order.** The log is append-only, so
 * a real outcome that lands after the settle is still recorded. Every reader resolves an
 * operation by `effectiveOutcomes`: a real outcome (`applied`, `refused`, `failed`) beats
 * `unknown` whichever row was written first, since the two writers' ids and clocks need not
 * agree. Two real outcomes for one operation break the audit's invariant, so they resolve to
 * `conflicting`, which is reported and never guessed past. The control plane bounds the vertical call well inside the
 * settle's grace window, so a live request cannot normally be overtaken this way. The rule is
 * stated for the case where one is.
 */
import { memberChangeAudit, ownerTransferAudit, substratError, type AdminAction } from '@substrat-run/contracts';
import type { OpsFailureInput } from './scope-host.js';

/** The admin actions written intent-then-outcome around a vertical call, which a settle closes. */
export const AUDITED_CHANGE_ACTIONS = ['transferOwner', 'manageScopeMember'] as const satisfies readonly AdminAction[];
export type AuditedChangeAction = (typeof AUDITED_CHANGE_ACTIONS)[number];

/** The intent a settle reads by id, inside its transaction. */
export const SETTLE_INTENT_SQL =
  'SELECT id, action, tenant_id, scope_id, vertical, after FROM _substrat_admin_log WHERE id = ?';

/**
 * Both statements below write `+action`, so the action column cannot drive an index choice: an
 * operation's few rows are reached through `_substrat_admin_log_operation` (the kernel's
 * admin-log index list), never by walking every row of an action. A planner left to choose takes
 * `(action, id)`, which reads the whole history of the action.
 */
/**
 * Whether the operation already has an outcome: a non-intent row of the SAME operation, its whole
 * identity compared column by column. The operation id reaches `_substrat_admin_log_operation`.
 * The action, tenant and scope are compared with `IS`, so a null tenant or scope matches only
 * null and never acts as a wildcard, and written `+column` so that the operation id is the only
 * index the statement can use: left to choose, the planner took `(action, id)` once, and
 * `(tenant_id, id)` or `(scope_id, id)` would read as much. No
 * value is serialized to compare, so nothing depends on two encoders agreeing. Never by row
 * order: the intent, a real outcome and a settle's `unknown` are stamped by different writers
 * whose ids and clocks need not agree.
 */
export const SETTLE_OUTCOME_SQL = `SELECT 1 AS present FROM _substrat_admin_log
  WHERE json_extract(after, '$.operationId') = ?
    AND json_extract(after, '$.operationId') IS NOT NULL
    AND +action IS ?
    AND +tenant_id IS ?
    AND +scope_id IS ?
    AND json_extract(after, '$.phase') <> 'intent'
  LIMIT 1`;

/** `SETTLE_OUTCOME_SQL`'s parameters for one operation, every part of its identity in order. */
export const settleOutcomeParamsOf = (operation: AuditedOperationRef): [string, string, string | null, string | null] => [
  operation.operationId,
  operation.action,
  operation.tenantId,
  operation.scopeId,
];

/** How many operation ids one batched read binds: well under a Durable Object's 100 parameters. */
export const AUDITED_OPERATIONS_BATCH = 50;

/**
 * Every row of the given operations, by the operation-id index. One statement per batch of
 * `AUDITED_OPERATIONS_BATCH` ids. The caller narrows the rows to the action, tenant and scope it
 * asked about.
 */
export function auditedOperationsSql(count: number): string {
  return `SELECT id, action, tenant_id, scope_id,
      json_extract(after, '$.operationId') AS operation_id, json_extract(after, '$.phase') AS phase
    FROM _substrat_admin_log
    WHERE json_extract(after, '$.operationId') IN (${Array.from({ length: count }, () => '?').join(', ')})
      AND json_extract(after, '$.operationId') IS NOT NULL
      AND +action IN (${AUDITED_CHANGE_ACTIONS.map((a) => `'${a}'`).join(', ')})`;
}

/** One row as `auditedOperationsSql` reads it. */
export interface AuditedOperationSqlRow {
  id: string;
  action: string;
  tenant_id: string | null;
  scope_id: string | null;
  operation_id: string;
  phase: string | null;
}

/** One row of an audited operation, as `HostAdmin.auditedOperations` answers it. */
export interface AuditedOperationRow {
  id: string;
  action: string;
  tenantId: string | null;
  scopeId: string | null;
  operationId: string;
  phase: string | null;
}

/** The operations a reader asks about: an operation is its action, its id and its scope. */
export interface AuditedOperationRef {
  action: string;
  operationId: string;
  tenantId: string | null;
  scopeId: string | null;
}

/**
 * Run `auditedOperationsSql` over `refs` in batches through `all`, and keep only the rows of
 * the exact operations asked about. An operation id from another action or scope is not one.
 */
export function readAuditedOperations(
  all: (sql: string, params: string[]) => AuditedOperationSqlRow[],
  refs: readonly AuditedOperationRef[],
): AuditedOperationRow[] {
  const wanted = new Set(refs.map(operationKeyOf));
  const ids = [...new Set(refs.map((r) => r.operationId))];
  const rows: AuditedOperationRow[] = [];
  for (let i = 0; i < ids.length; i += AUDITED_OPERATIONS_BATCH) {
    const batch = ids.slice(i, i + AUDITED_OPERATIONS_BATCH);
    for (const r of all(auditedOperationsSql(batch.length), batch)) {
      const row = { id: r.id, action: r.action, tenantId: r.tenant_id, scopeId: r.scope_id, operationId: r.operation_id, phase: r.phase };
      if (wanted.has(operationKeyOf(row))) rows.push(row);
    }
  }
  return rows;
}

/**
 * An audited operation's identity: its action, its operation id AND the tenant and scope it was
 * made in. The one key every grouping, lookup and resolution uses, built only here. An id alone
 * is not an operation: the same id in two scopes is two operations, never a conflict.
 */
export type OperationKey = string & { readonly __operationKey: unique symbol };
export const operationKeyOf = (r: AuditedOperationRef): OperationKey =>
  JSON.stringify([r.action, r.operationId, r.tenantId, r.scopeId]) as OperationKey;

/** One row as `SETTLE_INTENT_SQL` reads it. */
export interface SettleIntentRow {
  id: string;
  action: string;
  tenant_id: string | null;
  scope_id: string | null;
  vertical: string | null;
  after: string | null;
}

/** What a settle writes: the admin row's target and payload, and the ops-failure row. */
export interface UnknownOutcome {
  action: AuditedChangeAction;
  operationId: string;
  /** The operation the intent belongs to, the settle check's whole key. */
  operation: AuditedOperationRef;
  target: { tenantId: string | null; scopeId: string | null; vertical: string | null };
  after: Record<string, unknown>;
  failure: Omit<OpsFailureInput, 'actor'>;
}

const isAudited = (action: string): action is AuditedChangeAction =>
  (AUDITED_CHANGE_ACTIONS as readonly string[]).includes(action);

/**
 * The `unknown` outcome for one intent row: the intent's own fields with `phase: 'unknown'` and
 * `error` saying why, parsed by the same schema the flow writes its rows with. Throws `not_found`
 * when the row is absent, or is not the intent of an audited change.
 */
export function unknownOutcomeOf(row: SettleIntentRow | undefined, intentId: string, error: string): UnknownOutcome {
  const after = row?.after ? (JSON.parse(row.after) as Record<string, unknown>) : null;
  if (!row || !isAudited(row.action) || after?.phase !== 'intent' || typeof after.operationId !== 'string') {
    throw substratError('not_found', `no audited-change intent ${intentId} to settle`);
  }
  const entry = { ...after, tenantId: row.tenant_id, scopeId: row.scope_id, phase: 'unknown', error };
  const { tenantId: _t, scopeId: _s, ...parsed } =
    row.action === 'transferOwner' ? ownerTransferAudit.parse(entry) : memberChangeAudit.parse(entry);
  const operationId = after.operationId;
  return {
    action: row.action,
    operationId,
    operation: { action: row.action, operationId, tenantId: row.tenant_id, scopeId: row.scope_id },
    target: { tenantId: row.tenant_id, scopeId: row.scope_id, vertical: row.vertical },
    after: parsed,
    failure: {
      operation: `audit.${row.action}`,
      stage: 'outcome-unknown',
      tenantId: row.tenant_id as OpsFailureInput['tenantId'],
      scopeId: row.scope_id as OpsFailureInput['scopeId'],
      vertical: row.vertical,
      // The operation id is the row's handle: the digest reads the admin log by it, to drop an
      // `unknown` that a real outcome has since superseded.
      reference: operationId,
      message: `operation ${operationId}: ${error}`,
    },
  };
}

/** The phases an audited change's rows carry. */
export type AuditedPhase = 'intent' | 'applied' | 'refused' | 'failed' | 'unknown';


const REAL_OUTCOMES: ReadonlySet<string> = new Set(['applied', 'refused', 'failed']);

/** Where an operation stands, by priority over its rows (see the module header). */
export interface EffectiveOutcome {
  /** `conflicting`: more than one real outcome row, which the audit must never hold. */
  outcome: 'applied' | 'refused' | 'failed' | 'unknown' | 'conflicting';
  /** The real outcome phases found, in no particular order: one, or several when conflicting. */
  real: string[];
}

/**
 * Each audited operation's effective outcome among `rows`, keyed by `operationKeyOf`. A real
 * outcome beats `unknown` regardless of which was written first. Two or more real outcome rows
 * are `conflicting`. An operation with only an intent has no entry, so it is pending. Row ids
 * and timestamps decide nothing.
 */
export function effectiveOutcomes(
  rows: readonly (AuditedOperationRef & { phase: string | null })[],
): Map<OperationKey, EffectiveOutcome> {
  const seen = new Map<OperationKey, { real: string[]; unknown: boolean }>();
  for (const row of rows) {
    if (!isAudited(row.action) || row.phase === null || row.phase === 'intent') continue;
    const key = operationKeyOf(row);
    const entry = seen.get(key) ?? { real: [], unknown: false };
    if (REAL_OUTCOMES.has(row.phase)) entry.real.push(row.phase);
    else if (row.phase === 'unknown') entry.unknown = true;
    seen.set(key, entry);
  }
  const out = new Map<OperationKey, EffectiveOutcome>();
  for (const [key, { real, unknown }] of seen) {
    if (real.length > 1) out.set(key, { outcome: 'conflicting', real });
    else if (real.length === 1) out.set(key, { outcome: real[0] as EffectiveOutcome['outcome'], real });
    else if (unknown) out.set(key, { outcome: 'unknown', real });
  }
  return out;
}

/** Whether a row is an outcome its operation's effective outcome replaced: an `unknown` beaten by a real one. */
export function isSupersededOutcome(phase: string | null, effective: EffectiveOutcome | undefined): boolean {
  return phase === 'unknown' && effective !== undefined && effective.real.length > 0;
}
