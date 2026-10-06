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
 * Every control-plane flow of this shape goes through `auditedChange`, so the next one cannot
 * leave the outcome write in a bare `.catch(() => undefined)` again. (The schedule and peer kill
 * switches audit the same way inside the adapters, which cannot import this package; they are
 * not covered here.)
 */
import { AUDIT_ERROR_MAX, type AdminLogEntry, type OpsFailureEntry, type PlatformActorId } from '@substrat-run/contracts';
import {
  AUDITED_CHANGE_ACTIONS,
  operationKeyOf,
  effectiveOutcomes,
  isSupersededOutcome,
  type AuditedOperationRef,
  type EffectiveOutcome,
  type OperationKey,
  type HostAdmin,
} from '@substrat-run/kernel';
import { AUDITED_CALL_DEADLINE_MS } from './vertical-client.js';

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
const consoleError = (message: string, fields: Record<string, unknown>) => console.error(message, fields);

/** The structured line both unwritten outcomes leave, keyed so a log search finds every one. */
export const UNRECORDED_OUTCOME_LOG = 'audit-outcome-unrecorded';

/**
 * Run one audited change: the `intent` row (its failure propagates, and `run` is not called),
 * the call, then the outcome row. See the module header for what each failure answers.
 */
export async function auditedChange<T>(spec: AuditedChangeSpec<T>): Promise<AuditedChange<T>> {
  const { flow, operationId, record } = spec;
  const logError = spec.logError ?? consoleError;
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

export type SettleAdmin = Pick<HostAdmin, 'auditLog' | 'settleUnrecordedOutcome'>;

export interface SettleOptions {
  admin: SettleAdmin;
  actor: PlatformActorId;
  now?: Date;
  /**
   * How old an intent must be before its missing outcome is called unknown. It must exceed
   * `AUDITED_CALL_DEADLINE_MS`, the longest the vertical call between the two rows may run, so a
   * live request is never settled; `settleUnrecordedOutcomes` refuses a window that does not.
   */
  graceMs?: number;
  /**
   * How far back each pass looks. The pass runs every quarter hour, so a week is margin for a
   * sweep that was down, not the expected lag; it bounds what each pass reads from a log that is
   * never pruned.
   */
  lookbackMs?: number;
}

export interface SettleResult {
  /** Intents this pass closed with an `unknown` row. */
  settled: { action: string; operationId: string; tenantId: string | null; scopeId: string | null }[];
  /** Per-intent write failures: the intent stays open, and the next pass tries again. */
  errors: { operationId: string; error: string }[];
}

/** An hour: sixty times the deadline on the call it waits out. */
export const SETTLE_GRACE_MS = 60 * 60 * 1000;
const SETTLE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE = 500;

if (SETTLE_GRACE_MS <= AUDITED_CALL_DEADLINE_MS) {
  throw new Error('SETTLE_GRACE_MS must exceed AUDITED_CALL_DEADLINE_MS, or a live call could be settled');
}

/**
 * Close every audited change whose intent has no outcome row (#2064). Each intent older than
 * the grace window and still without an outcome is handed to `HostAdmin.settleUnrecordedOutcome`,
 * which writes the `unknown` row and its ops-failure row in ONE transaction, and only if no
 * outcome exists by then. The scan here only nominates. The host's check is the one that holds,
 * so two concurrent passes, or an outcome landing between the scan and the settle, still leave
 * one outcome row. A real outcome written later supersedes `unknown` (kernel `audit-outcome.ts`).
 */
export async function settleUnrecordedOutcomes(opts: SettleOptions): Promise<SettleResult> {
  const { admin, actor } = opts;
  const now = (opts.now ?? new Date()).getTime();
  const graceMs = opts.graceMs ?? SETTLE_GRACE_MS;
  if (graceMs <= AUDITED_CALL_DEADLINE_MS) {
    throw new Error(`a settle grace of ${graceMs} ms does not exceed the ${AUDITED_CALL_DEADLINE_MS} ms call deadline`);
  }
  const cutoff = new Date(now - graceMs).toISOString();
  const since = new Date(now - (opts.lookbackMs ?? SETTLE_LOOKBACK_MS)).toISOString();

  const intents = new Map<OperationKey, AdminLogEntry>();
  const closed = new Set<OperationKey>();
  for (let cursor: string | undefined; ; ) {
    const page = await admin.auditLog(actor, { action: [...AUDITED_CHANGE_ACTIONS], since, limit: PAGE, cursor });
    for (const row of page) {
      const after = row.after as { phase?: unknown; operationId?: unknown } | null;
      if (typeof after?.operationId !== 'string') continue;
      // The operation's whole identity, as every reader keys it.
      const key = operationKeyOf({ action: row.action, operationId: after.operationId, tenantId: row.tenantId, scopeId: row.scopeId });
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
    const operationId = (intent.after as { operationId: string }).operationId;
    const error = `no outcome was recorded within ${minutes} minutes of the intent (${intent.at}); whether the change happened is not known to this log`;
    try {
      if (await admin.settleUnrecordedOutcome(actor, { intentId: intent.id, error })) {
        result.settled.push({ action: intent.action, operationId, tenantId: intent.tenantId, scopeId: intent.scopeId });
      }
    } catch (e) {
      result.errors.push({ operationId, error: messageOf(e) });
    }
  }
  return result;
}

const operationIdOf = (row: AdminLogEntry): string | null => {
  const id = (row.after as { operationId?: unknown } | null)?.operationId;
  return (AUDITED_CHANGE_ACTIONS as readonly string[]).includes(row.action) && typeof id === 'string' ? id : null;
};

/** The structured line an operation with two real outcomes leaves: the audit's invariant broke. */
export const OUTCOME_CONFLICT_LOG = 'audit-outcome-conflict';

/**
 * Resolve `refs` to their effective outcomes (#2064): ONE batched read of exactly these
 * operations' rows through the operation-id index, then the kernel's priority rule. An operation
 * found `conflicting` is logged here, once per read, so a reader never hides it.
 */
async function resolveOperations(
  admin: Pick<HostAdmin, 'auditedOperations'>,
  actor: PlatformActorId,
  refs: AuditedOperationRef[],
  logError: NonNullable<AuditedChangeSpec<unknown>['logError']> = consoleError,
): Promise<Map<OperationKey, EffectiveOutcome>> {
  if (refs.length === 0) return new Map();
  const effective = effectiveOutcomes(await admin.auditedOperations(actor, refs));
  for (const [key, outcome] of effective) {
    if (outcome.outcome === 'conflicting') logError(OUTCOME_CONFLICT_LOG, { operation: JSON.parse(key) as unknown, outcomes: outcome.real });
  }
  return effective;
}

/**
 * The admin-log read surface's half of the priority rule (#2064). Each row of an audited change
 * is annotated with the outcome its operation stands at: a real outcome beats `unknown` whatever
 * the row order, and two real outcomes read `conflicting`. An `unknown` a real outcome beat is
 * marked `superseded`. The rows are returned as written, so the raw history stays readable.
 */
export async function withAuditedOutcomes(
  admin: Pick<HostAdmin, 'auditedOperations'>,
  actor: PlatformActorId,
  entries: AdminLogEntry[],
  logError?: AuditedChangeSpec<unknown>['logError'],
): Promise<AdminLogEntry[]> {
  const refs: AuditedOperationRef[] = [];
  for (const row of entries) {
    const operationId = operationIdOf(row);
    if (operationId !== null) refs.push({ action: row.action, operationId, tenantId: row.tenantId, scopeId: row.scopeId });
  }
  if (refs.length === 0) return entries;
  const effective = await resolveOperations(admin, actor, refs, logError);
  return entries.map((row) => {
    const operationId = operationIdOf(row);
    if (operationId === null) return row;
    const outcome = effective.get(operationKeyOf({ action: row.action, operationId, tenantId: row.tenantId, scopeId: row.scopeId }));
    const phase = (row.after as { phase?: string }).phase ?? null;
    return {
      ...row,
      audited: { operationId, outcome: outcome?.outcome ?? 'pending', superseded: isSupersededOutcome(phase, outcome) },
    };
  });
}

/**
 * The digest's half (#2064): of the ops-failure rows the settle wrote for an `unknown` outcome,
 * the ones whose operation has since recorded ONE real outcome, whatever the order the two rows
 * landed in. The settle's row names the operation in `reference`. The digest drops these. A
 * `conflicting` operation is kept and logged: it is the one a person must look at.
 */
export async function supersededUnknowns(
  admin: Pick<HostAdmin, 'auditedOperations'>,
  actor: PlatformActorId,
  failures: readonly OpsFailureEntry[],
  logError?: AuditedChangeSpec<unknown>['logError'],
): Promise<Set<string>> {
  const unknowns = new Map<string, AuditedOperationRef>();
  for (const f of failures) {
    const action = f.operation.startsWith('audit.') ? f.operation.slice('audit.'.length) : null;
    if (f.stage !== 'outcome-unknown' || !action || !f.reference) continue;
    if (!(AUDITED_CHANGE_ACTIONS as readonly string[]).includes(action)) continue;
    unknowns.set(f.id, { action, operationId: f.reference, tenantId: f.tenantId, scopeId: f.scopeId });
  }
  const effective = await resolveOperations(admin, actor, [...unknowns.values()], logError);
  const superseded = new Set<string>();
  for (const [id, ref] of unknowns) {
    const outcome = effective.get(operationKeyOf(ref));
    if (outcome && outcome.real.length === 1) superseded.add(id);
  }
  return superseded;
}
