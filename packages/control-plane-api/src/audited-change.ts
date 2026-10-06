/**
 * A change the control plane makes in ANOTHER store, audited around the call (#2064).
 *
 * The owner hand-over (#1665) and dashboard member management (#1150) both change state in the
 * vertical's own deployment, so the admin log cannot record them in the same transaction. Each is
 * written in two rows paired by `operationId`: an `intent` before the vertical is reached, then
 * the outcome (`applied`, `refused` or `failed`). The two stores are separate, so no order makes
 * the pair atomic. This one fails toward "an intent with no outcome", never toward "a change with
 * no row":
 *
 * - the `intent` write failing stops the call, so nothing moves unaudited;
 * - the `applied` write failing is reported to the caller as exactly that: the change happened
 *   and its row is missing (`unrecorded`), so nobody retries a change believing it failed;
 * - the `refused`/`failed` write failing is NOT the caller's answer. The vertical's own status
 *   still is, because a correctly refused `403`/`409` turned into a `5xx` reads as retryable,
 *   and each retry would add an intent row. It is logged at error level with the operation id.
 *
 * Neither failure is silent any more, and neither is left for a reader to explain: an intent
 * with no outcome is closed by `settleUnrecordedOutcomes` below, which the scheduled pass runs.
 * Every flow of this shape goes through `auditedChange`, so the next one cannot leave the
 * outcome write in a bare `.catch(() => undefined)` again.
 */
import { AUDIT_ERROR_MAX, type AdminAction, type AdminLogEntry, type PlatformActorId } from '@substrat-run/contracts';
import type { HostAdmin, OpsFailureInput } from '@substrat-run/kernel';

/** One row of an audited change, before the flow adds its own fields. */
export type AuditedRow<T> =
  | { phase: 'intent' }
  | { phase: 'applied'; result: T }
  | { phase: 'refused' | 'failed'; error: string };

export interface AuditedChangeSpec<T> {
  /** Names the flow in the error log line, e.g. `owner-transfer`. */
  flow: string;
  operationId: string;
  /** Writes one row. Throws when the row could not be written. */
  record: (row: AuditedRow<T>) => Promise<void>;
  /** The call into the other store. */
  run: () => Promise<T>;
  /** Whether a throw from `run` is a refusal (nothing was written there) rather than a failure. */
  refused: (error: unknown) => boolean;
  /** Where an unwritten outcome is reported. Defaults to `console.error`. */
  logError?: (message: string, fields: Record<string, unknown>) => void;
}

export type AuditedChange<T> =
  /** Applied, and recorded. */
  | { operationId: string; result: T }
  /** Applied, but the `applied` row could not be written: `unrecorded` is why. */
  | { operationId: string; result: T; unrecorded: string }
  /** `run` threw; its error, untouched, for the caller to answer with. */
  | { operationId: string; error: unknown };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The structured line both unwritten outcomes leave, keyed so a log search finds every one. */
export const UNRECORDED_OUTCOME_LOG = 'audit-outcome-unrecorded';

/**
 * Run one audited change: the `intent` row (its failure propagates, and `run` is not called),
 * the call, then the outcome row. See the module header for what each failure answers.
 */
export async function auditedChange<T>(spec: AuditedChangeSpec<T>): Promise<AuditedChange<T>> {
  const { flow, operationId, record } = spec;
  const logError = spec.logError ?? ((message, fields) => console.error(message, fields));
  await record({ phase: 'intent' });
  let result: T;
  try {
    result = await spec.run();
  } catch (error) {
    const phase = spec.refused(error) ? 'refused' : 'failed';
    try {
      await record({ phase, error: messageOf(error).slice(0, AUDIT_ERROR_MAX) });
    } catch (auditError) {
      logError(UNRECORDED_OUTCOME_LOG, { flow, operationId, phase, auditError: messageOf(auditError) });
    }
    return { operationId, error };
  }
  try {
    await record({ phase: 'applied', result });
  } catch (auditError) {
    const unrecorded = messageOf(auditError);
    logError(UNRECORDED_OUTCOME_LOG, { flow, operationId, phase: 'applied', auditError: unrecorded });
    return { operationId, result, unrecorded };
  }
  return { operationId, result };
}

/**
 * The admin actions written through `auditedChange`, and how the sweep writes an `unknown`
 * outcome for each: through the same narrow, parsed recorder the flow itself uses.
 */
type AuditedAction = Extract<AdminAction, 'transferOwner' | 'manageScopeMember'>;
const SETTLERS: Record<AuditedAction, (admin: SettleAdmin, actor: PlatformActorId, entry: never) => Promise<void>> = {
  transferOwner: (admin, actor, entry) => admin.recordOwnerTransfer(actor, entry),
  manageScopeMember: (admin, actor, entry) => admin.recordMemberChange(actor, entry),
};
export const AUDITED_CHANGE_ACTIONS = Object.keys(SETTLERS) as AuditedAction[];

export type SettleAdmin = Pick<HostAdmin, 'auditLog' | 'recordOwnerTransfer' | 'recordMemberChange' | 'recordOpsFailure'>;

export interface SettleOptions {
  admin: SettleAdmin;
  actor: PlatformActorId;
  now?: Date;
  /**
   * How old an intent must be before its missing outcome is called unknown. Well past the
   * longest a request can still be running, so the sweep never races a live call.
   */
  graceMs?: number;
  /**
   * How far back each pass looks. The pass runs every quarter hour, so a week is margin for a
   * sweep that was down, not the expected lag; it bounds what each pass reads from a log that is
   * never pruned.
   */
  lookbackMs?: number;
  logError?: AuditedChangeSpec<unknown>['logError'];
}

export interface SettleResult {
  /** Intents this pass closed with an `unknown` row. */
  settled: { action: AuditedAction; operationId: string; tenantId: string | null; scopeId: string | null }[];
  /** Per-intent write failures: the intent stays open, and the next pass tries again. */
  errors: { operationId: string; error: string }[];
}

export const SETTLE_GRACE_MS = 60 * 60 * 1000;
export const SETTLE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE = 500;

/**
 * Close every audited change whose intent has no outcome row (#2064). For each one older than
 * the grace window, write an `unknown` outcome naming why, and an ops-failure row so the staff
 * digest reports it: the log can no longer say whether the change happened, and someone should
 * look in the vertical. Idempotent: a settled intent has an outcome and is skipped next pass.
 */
export async function settleUnrecordedOutcomes(opts: SettleOptions): Promise<SettleResult> {
  const { admin, actor } = opts;
  const logError = opts.logError ?? ((message, fields) => console.error(message, fields));
  const now = (opts.now ?? new Date()).getTime();
  const graceMs = opts.graceMs ?? SETTLE_GRACE_MS;
  const cutoff = new Date(now - graceMs).toISOString();
  const since = new Date(now - (opts.lookbackMs ?? SETTLE_LOOKBACK_MS)).toISOString();

  const intents = new Map<string, AdminLogEntry>();
  const closed = new Set<string>();
  for (let cursor: string | undefined; ; ) {
    const page = await admin.auditLog(actor, { action: AUDITED_CHANGE_ACTIONS, since, limit: PAGE, cursor });
    for (const row of page) {
      const after = row.after as { phase?: unknown; operationId?: unknown } | null;
      if (typeof after?.operationId !== 'string') continue;
      // Keyed by action too: the two flows mint their operation ids independently.
      const key = `${row.action}:${after.operationId}`;
      if (after.phase === 'intent') {
        if (row.at < cutoff) intents.set(key, row);
      } else {
        closed.add(key);
      }
    }
    if (page.length < PAGE) break;
    cursor = page[page.length - 1]!.id;
  }

  const result: SettleResult = { settled: [], errors: [] };
  const minutes = Math.round(graceMs / 60_000);
  for (const [key, intent] of intents) {
    if (closed.has(key)) continue;
    const action = intent.action as AuditedAction;
    const { phase: _intent, ...fields } = intent.after as Record<string, unknown> & { operationId: string };
    const error = `no outcome was recorded within ${minutes} minutes of the intent (${intent.at}); whether the change happened is not known to this log`;
    try {
      await SETTLERS[action](admin, actor, {
        ...fields,
        tenantId: intent.tenantId,
        scopeId: intent.scopeId,
        phase: 'unknown',
        error,
      } as never);
    } catch (e) {
      result.errors.push({ operationId: fields.operationId, error: messageOf(e) });
      continue;
    }
    result.settled.push({ action, operationId: fields.operationId, tenantId: intent.tenantId, scopeId: intent.scopeId });
    const failure: OpsFailureInput = {
      actor,
      operation: `audit.${action}`,
      stage: 'outcome-unknown',
      tenantId: intent.tenantId,
      scopeId: intent.scopeId,
      vertical: intent.vertical,
      message: `operation ${fields.operationId}: ${error}`,
    };
    // The `unknown` row is the record; this only routes it to the digest, so its failure is
    // logged and never undoes the settle.
    await admin.recordOpsFailure(failure).catch((e: unknown) => {
      logError(UNRECORDED_OUTCOME_LOG, { flow: action, operationId: fields.operationId, phase: 'unknown', opsFailureError: messageOf(e) });
    });
  }
  return result;
}
