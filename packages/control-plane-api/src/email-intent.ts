import {
  EMAIL_DEAD_LETTERED,
  EMAIL_REFUSED,
  EMAIL_SENT,
  PLATFORM_REQUEST_ENTITY_TYPE,
  sendEmailRequest,
  type EmailOutcomeType,
  type EntityRef,
  type PlatformRequest,
  type PlatformRequestFailure,
  type SendEmailRequest,
  type TenantId,
  type ScopeId,
} from '@substrat-run/contracts';
import { attributeFailure } from './failure-attribution.js';
import type { PlatformRequestHandler, PlatformRequestOutcome } from './platform-drain.js';
import { isTerminalDispatchFailure, providerErrorStatus } from './provider-error.js';

/**
 * The drain's handler for `send-email` (#2102): one mail a vertical requested inside an
 * operation, delivered after that operation committed.
 *
 * It routes as the synchronous relay does — no `from` sends as the platform, a `from` sends
 * through the tenant connection whose `MailSender` covers that address — and it retries what a
 * provider deferred: a `429`, a `5xx`, or a failure with no status at all. Any other 4xx is a
 * refusal and is final. Each outcome that ends the request is written into the scope as an
 * event, with the provider's message id when it gives one.
 *
 * **Retries wait.** The drain runs on every kick and every sweep, and a kick follows any
 * operation that requested something — so a throttled mailbox would otherwise be retried as
 * fast as the vertical writes. A failed attempt records the earliest time to try again in the
 * intent's `result` (`Retry-After` when the provider gave one, else a doubling backoff), and a
 * pass before then defers it without trying, which counts no attempt. Within one pass, a
 * sender that answered `429` is not tried again: the rest of its mail defers to the next pass.
 *
 * **At least once.** A send the provider accepted whose settle is then lost is sent again on
 * the next pass. Mail has no idempotency key a provider honours across all of them, so this is
 * the honest guarantee; the alternative — settle before sending — loses mail instead.
 */

/** Attempts before a send that keeps failing transiently dead-letters. Well under the drain's ceiling. */
export const MAX_EMAIL_SEND_ATTEMPTS = 10;
/** The first retry's wait when the provider named none; doubled per attempt. */
export const EMAIL_RETRY_BASE_MS = 30_000;
/** The longest wait between attempts the backoff alone will choose. */
export const EMAIL_RETRY_MAX_MS = 30 * 60_000;

/** What a sender returns. `messageId` when the provider gives one. */
export interface EmailSent {
  messageId?: string;
}

export interface SendEmailDeps {
  /** Does this vertical hold the `emailSender` grant? Read per pass, so a revoke takes effect. */
  mayEmail(vertical: string): Promise<boolean>;
  /**
   * Send as the platform's own address. A refusal throws an error carrying `status` (and
   * `retryAfter` seconds for a throttle), read structurally.
   */
  sendAsPlatform(mail: Omit<SendEmailRequest, 'from' | 'attachments' | 'about'>): Promise<EmailSent>;
  /**
   * Send as a tenant address, through the connection that covers it. Same error contract; a
   * wrapper that rewords a provider's failure keeps the original as `cause`.
   */
  sendAsTenant(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    from: string;
    fromName?: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    attachmentIds: string[];
  }): Promise<EmailSent>;
  now?(): Date;
  maxAttempts?: number;
}

/** What a failed attempt leaves in the intent's `result`, so the next pass knows when to try. */
interface RetryState {
  retryAt: string;
}

/** One handler per drain pass: the throttles it learns last only as long as the pass. */
export function sendEmailHandler(deps: SendEmailDeps): PlatformRequestHandler {
  const throttledUntil = new Map<string, number>();
  const now = () => deps.now?.() ?? new Date();
  const maxAttempts = deps.maxAttempts ?? MAX_EMAIL_SEND_ATTEMPTS;

  return async (ctx, request) => {
    const attempts = request.attempts + 1;
    const parsed = sendEmailRequest.safeParse(request.payload);
    if (!parsed.success) {
      // Module code goes through `requestEmail`, which parses first; this is a row written some
      // other way. Final: the same bytes fail the same parse on every pass.
      return over(request, EMAIL_REFUSED, null, 'platform', attempts, {
        error: `not sent: the send-email payload is invalid (${parsed.error.issues[0]?.message ?? 'unknown'})`,
        failure: { origin: 'platform', code: 'validation_failed', permission: null },
      });
    }
    const mail = parsed.data;
    const about = mail.about ?? null;
    const sender = mail.from === undefined ? 'platform' : 'tenant';

    const waitUntil = retryAtOf(request);
    if (waitUntil !== null && waitUntil > now().getTime()) return { status: 'deferred' };
    const key = mail.from === undefined ? 'platform' : `tenant:${mail.from.toLowerCase()}`;
    if ((throttledUntil.get(key) ?? 0) > now().getTime()) return { status: 'deferred' };

    if (!(await deps.mayEmail(ctx.vertical))) {
      return over(request, EMAIL_REFUSED, about, sender, attempts, {
        error:
          `not sent: vertical '${ctx.vertical}' does not hold the email-sender capability — staff ` +
          'grants it in the console (setVerticalEmailSender)',
        failure: { origin: 'platform', code: 'permission_denied', permission: null },
      });
    }

    let sent: EmailSent;
    try {
      sent =
        mail.from === undefined
          ? await deps.sendAsPlatform({
              to: mail.to,
              subject: mail.subject,
              html: mail.html,
              text: mail.text,
              ...(mail.fromName ? { fromName: mail.fromName } : {}),
            })
          : await deps.sendAsTenant({
              tenantId: ctx.tenantId,
              scopeId: ctx.scopeId,
              vertical: ctx.vertical,
              from: mail.from,
              ...(mail.fromName ? { fromName: mail.fromName } : {}),
              to: mail.to,
              subject: mail.subject,
              html: mail.html,
              text: mail.text,
              attachmentIds: (mail.attachments ?? []).map((a) => a.attachmentId),
            });
    } catch (e) {
      const status = sendFailureStatus(e);
      const failure = attributeFailure(innermost(e));
      const error = e instanceof Error ? e.message : String(e);
      if (status !== undefined && isTerminalDispatchFailure({ status })) {
        return over(request, EMAIL_REFUSED, about, sender, attempts, { error, failure, status });
      }
      if (attempts >= maxAttempts) {
        return over(request, EMAIL_DEAD_LETTERED, about, sender, attempts, {
          error: `gave up after ${attempts} attempts — last error: ${error}`,
          failure,
          status,
        });
      }
      const retryAfterMs = retryAfterSecondsOf(e) * 1000;
      if (status === 429) throttledUntil.set(key, now().getTime() + Math.max(retryAfterMs, 1));
      const backoff = Math.min(EMAIL_RETRY_BASE_MS * 2 ** (attempts - 1), EMAIL_RETRY_MAX_MS);
      const retry: RetryState = { retryAt: new Date(now().getTime() + Math.max(retryAfterMs, backoff)).toISOString() };
      return { status: 'pending', result: retry, error, failure };
    }

    return {
      status: 'done',
      result: { sent: true, sender, messageId: sent.messageId ?? null },
      event: {
        type: EMAIL_SENT,
        entity: entityOf(request, about),
        payload: {
          request: request.id,
          about,
          sender,
          messageId: sent.messageId ?? null,
          attempts,
          code: null,
          status: null,
        },
      },
    };
  };
}

/** A terminal outcome and the event that says so. */
function over(
  request: PlatformRequest,
  type: Exclude<EmailOutcomeType, typeof EMAIL_SENT>,
  about: EntityRef | null,
  sender: 'platform' | 'tenant',
  attempts: number,
  why: { error: string; failure: PlatformRequestFailure; status?: number | undefined },
): PlatformRequestOutcome {
  return {
    status: 'failed',
    error: why.error,
    failure: why.failure,
    event: {
      type,
      entity: entityOf(request, about),
      payload: {
        request: request.id,
        about,
        sender,
        messageId: null,
        attempts,
        code: why.failure.code,
        status: why.status ?? null,
      },
    },
  };
}

const entityOf = (request: PlatformRequest, about: EntityRef | null): EntityRef =>
  about ?? { entityType: PLATFORM_REQUEST_ENTITY_TYPE, entityId: request.id };

function retryAtOf(request: PlatformRequest): number | null {
  const at = (request.result as Partial<RetryState> | null | undefined)?.retryAt;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** The error a wrapper kept as `cause`, followed to the bottom: the provider's own, if any. */
function innermost(e: unknown): unknown {
  let current = e;
  for (let depth = 0; depth < 5; depth++) {
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null) return current;
    current = cause;
  }
  return current;
}

/**
 * The status that decides a retry: the provider's, when a wrapper kept it as `cause`, else the
 * wrapper's own. A tenant send that failed in the provider surfaces as a 502 around the
 * provider's answer — the 502 says "the provider failed", the cause says whether it will again.
 */
export function sendFailureStatus(e: unknown): number | undefined {
  return providerErrorStatus(innermost(e)) ?? providerErrorStatus(e);
}

/** `retryAfter` (seconds) wherever along the cause chain a sender put it; 0 when nobody did. */
export function retryAfterSecondsOf(e: unknown): number {
  let current = e;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth++) {
    const value = (current as { retryAfter?: unknown }).retryAfter;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    current = (current as { cause?: unknown }).cause;
  }
  return 0;
}
