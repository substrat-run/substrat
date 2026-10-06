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
 * **A real outcome supersedes `unknown`.** The log is append-only, so a real outcome that lands
 * after the settle is still recorded, as the later row. Readers take the latest outcome row of
 * an operation as its result. The control plane bounds the vertical call well inside the
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
 * Whether the operation already has an outcome. An outcome is written after its intent, so its
 * ULID id is greater, which keeps the scan on the `(action, id)` range of the log.
 */
export const SETTLE_OUTCOME_SQL = `SELECT 1 AS present FROM _substrat_admin_log
  WHERE action = ? AND id > ?
    AND json_extract(after, '$.operationId') = ?
    AND json_extract(after, '$.phase') <> 'intent'
  LIMIT 1`;

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

/** The phases an audited change's rows carry. `pending` is an operation with no outcome yet. */
export type AuditedPhase = 'intent' | 'applied' | 'refused' | 'failed' | 'unknown';

/** One operation's key: the two flows mint their operation ids independently. */
export const auditedKeyOf = (action: string, operationId: string): string => `${action}:${operationId}`;

/** The outcome an operation stands at: its LATEST outcome row, by id. */
export interface EffectiveOutcome {
  phase: Exclude<AuditedPhase, 'intent'>;
  /** The id of the outcome row that decides it. */
  id: string;
  at: string;
}

/**
 * Each audited operation's effective outcome among `rows`, keyed by `auditedKeyOf`: the latest
 * outcome row wins (#2064), so a real outcome recorded after a settle's `unknown` is the result.
 * Rows of other actions, and intents, decide nothing.
 */
export function effectiveOutcomes(
  rows: readonly { id: string; action: string; at: string; after: unknown }[],
): Map<string, EffectiveOutcome> {
  const out = new Map<string, EffectiveOutcome>();
  for (const row of rows) {
    if (!isAudited(row.action)) continue;
    const after = row.after as { phase?: unknown; operationId?: unknown } | null;
    if (typeof after?.operationId !== 'string' || after.phase === 'intent' || typeof after.phase !== 'string') continue;
    const key = auditedKeyOf(row.action, after.operationId);
    const seen = out.get(key);
    if (!seen || row.id > seen.id) out.set(key, { phase: after.phase as EffectiveOutcome['phase'], id: row.id, at: row.at });
  }
  return out;
}
