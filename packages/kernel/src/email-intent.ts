import {
  SEND_EMAIL_KIND,
  domainEvent,
  eventId,
  platformOutcomeEvent,
  sendEmailRequest,
  type PlatformOutcomeEvent,
  type PlatformRequestFailure,
  type PlatformRequestId,
  type PlatformRequestStatus,
  type ScopeId,
  type SendEmailRequest,
  type TenantId,
} from '@substrat-run/contracts';
import { KERNEL_ACTOR, kernelOutboxInsertSql } from './kernel-outbox.js';
import type { OperationContext } from './scope-host.js';
import type { SwitchSql } from './system-switch.js';

/**
 * Ask the platform to send one email, inside the operation (#2102).
 *
 * The send is a platform intent: a row written in this operation's transaction, so an
 * operation that throws afterwards sends nothing, and one that commits is delivered by the
 * platform's drain — retried while the provider defers it, and reported back as an
 * `email.sent`, `email.refused` or `email.dead-lettered` event on `mail.about` (or on the
 * intent, when the mail names no entity). The returned id is the `request` those events carry.
 *
 * Name the recipient's `subjectId` when they are a person in your data: the row holds their
 * address and the message, and that id is how a subject erasure finds and cancels it.
 *
 * Parsed here rather than at drain time, so a malformed address fails the operation that wrote
 * it, in front of the person who typed it, instead of a refusal event minutes later. Needs the
 * vertical's `emailSender` grant, as the relay always has; without it the send is refused.
 */
export function requestEmail(
  ctx: Pick<OperationContext, 'requestPlatform'>,
  mail: Omit<SendEmailRequest, 'piiClass'>,
): PlatformRequestId {
  const parsed = sendEmailRequest.parse(mail);
  // Classified like an event naming the same person, so a subject erasure reaches the row.
  const payload = parsed.subjectId ? { ...parsed, piiClass: 'direct' as const } : parsed;
  return ctx.requestPlatform({ kind: SEND_EMAIL_KIND, payload });
}

/** What the scope stamps on an outcome event it writes: the drain names the rest. */
export interface OutcomeEventStamp {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** ISO 8601 — the settle's instant. */
  now: string;
  mintEventId(ms: number): string;
  /** The deploy writing it, for the outbox's `version` column. */
  version: string | null;
}

export interface PlatformRequestSettle {
  status: PlatformRequestStatus;
  result?: unknown;
  lastError?: string | null;
  failure?: PlatformRequestFailure | null;
  /** #2102: the event this settle writes into the scope, when it moves the row out of `pending`. */
  event?: PlatformOutcomeEvent | null;
}

/**
 * Journal a platform-request outcome, and write its outcome event (#2102) — one step, so both
 * adapters say the same thing and the event commits with the settle or not at all. Run it in a
 * transaction.
 *
 * **Compare-and-set on `pending` (#1600 review).** The drain reads pending rows, runs a handler,
 * then settles — and between the read and the settle a subject erasure can redact the row.
 * Settling by `id` alone let that stale pass overwrite the redaction and write a provider's
 * reply, which can quote the person, back into `last_error`. A settle that finds the row
 * already terminal does nothing, deliberately silently — throwing would make the drain's
 * blanket catch retry a row that is correctly over. The event follows the same rule: written
 * only by the settle that actually moved the row, so a repeated settle never writes it twice.
 *
 * The event is refused (before anything is written) on a `pending` settle — an outcome event
 * says the request is over — and when its `request` is not the row being settled.
 */
export function settlePlatformRequestIn(
  db: SwitchSql,
  id: PlatformRequestId,
  outcome: PlatformRequestSettle,
  stamp: OutcomeEventStamp,
): void {
  const event = outcome.event == null ? null : platformOutcomeEvent.parse(outcome.event);
  if (event && outcome.status === 'pending') {
    throw new Error(`settle of platform request ${id}: an outcome event needs a terminal status, not 'pending'`);
  }
  if (event && event.payload.request !== id) {
    throw new Error(
      `settle of platform request ${id}: the outcome event names request ${event.payload.request}`,
    );
  }
  const was = db.all('SELECT status FROM _substrat_platform_requests WHERE id = ?', id)[0]?.status;
  db.run(
    `UPDATE _substrat_platform_requests
       SET status = ?, result = COALESCE(?, result), last_error = ?, last_failure = ?,
           attempts = attempts + 1, settled_at = ?
     WHERE id = ? AND status = 'pending'`,
    outcome.status,
    outcome.result === undefined ? null : JSON.stringify(outcome.result),
    outcome.lastError ?? null,
    outcome.failure == null ? null : JSON.stringify(outcome.failure),
    outcome.status === 'pending' ? null : stamp.now,
    id,
  );
  if (!event || was !== 'pending') return;
  const full = domainEvent.parse({
    id: eventId.parse(stamp.mintEventId(Date.parse(stamp.now))),
    type: event.type,
    schemaVersion: 1,
    occurredAt: stamp.now,
    tenantId: stamp.tenantId,
    scopeId: stamp.scopeId,
    actor: KERNEL_ACTOR,
    entity: event.entity,
    piiClass: 'none',
    payload: event.payload,
  });
  const st = kernelOutboxInsertSql(full, stamp.version);
  db.run(st.sql, ...st.params);
}
