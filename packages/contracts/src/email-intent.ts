import { z } from 'zod';
import { EMAIL_RELAY_MAX_ATTACHMENTS } from './control-plane.js';
import { entityRef } from './events.js';
import { dataSubjectId, platformRequestId } from './ids.js';

/**
 * Email as a transactional platform intent (#2102).
 *
 * A vertical's mail used to be a synchronous POST to the control plane's email relay, made
 * outside the operation's transaction: an operation that threw after the call had still sent
 * the mail, and a send that failed was simply lost. Requested as an intent instead, the send
 * is a row in the scope's own spine written by the operation — so it commits or rolls back
 * with everything else the operation did — and the platform's drain delivers it afterwards,
 * retrying what a provider deferred and saying what became of it as an event.
 *
 * The payload is the relay's body without the caller's identity: the drain reads the row out
 * of the scope that wrote it, so who is asking is never something the payload says.
 */
export const SEND_EMAIL_KIND = 'send-email';

export const sendEmailRequest = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1),
    html: z.string().min(1),
    text: z.string().min(1),
    /** The display name for the FROM. With no `from`, the address stays the platform's. */
    fromName: z.string().min(1).optional(),
    /** Send as this tenant address, through the tenant's mail connection that covers it (#2098). */
    from: z.string().email().optional(),
    /** Files from the sending scope, by attachment id. Only with `from`. */
    attachments: z
      .array(z.object({ attachmentId: z.string().min(1) }).strict())
      .max(EMAIL_RELAY_MAX_ATTACHMENTS)
      .optional(),
    /**
     * The entity this mail is about — an invoice, a ticket. The outcome event is written on
     * that entity, so its timeline says the mail went (or did not). Absent, the event is
     * written on the intent itself (`{ entityType: 'platform-request', entityId: <id> }`).
     */
    about: entityRef.optional(),
    /**
     * The person this mail is to or about, when it is one. The row holds their address and the
     * message, so it is personal data in the spine, and this id is what a subject erasure finds
     * it by: a held send is cancelled and the row becomes a tombstone, as an event copy does.
     * Without it, nothing links the row to anybody (kernel-design.md §13.1, limit 7).
     */
    subjectId: dataSubjectId.optional(),
    /**
     * Stamped by `requestEmail` beside `subjectId` — never needed from module code. With
     * `subjectId` it is the outbox's own erasure predicate (`subjectId` + a `piiClass` other
     * than `none`), which the intent redaction already applies to every payload it walks.
     */
    piiClass: z.literal('direct').optional(),
  })
  .strict()
  .refine((m) => m.piiClass === undefined || m.subjectId !== undefined, {
    message: '`piiClass` classifies a `subjectId`; there is none',
    path: ['piiClass'],
  })
  .refine((m) => !m.attachments?.length || m.from !== undefined, {
    message: "attachments ride only with `from` — the platform's own sender carries none",
    path: ['attachments'],
  });
export type SendEmailRequest = z.infer<typeof sendEmailRequest>;

/** The entity type an outcome is written on when the request named none. */
export const PLATFORM_REQUEST_ENTITY_TYPE = 'platform-request';

/** The provider accepted the message. Not delivery to an inbox: "accepted" is all most say. */
export const EMAIL_SENT = 'email.sent';
/** The provider, or the platform on its behalf, refused the message for good. Not retried. */
export const EMAIL_REFUSED = 'email.refused';
/** Every attempt the platform allows met a transient failure. The send is over. */
export const EMAIL_DEAD_LETTERED = 'email.dead-lettered';

export const emailOutcomeType = z.enum([EMAIL_SENT, EMAIL_REFUSED, EMAIL_DEAD_LETTERED]);
export type EmailOutcomeType = z.infer<typeof emailOutcomeType>;

/**
 * The outcome event's payload. Deliberately carries no address and no provider prose: an
 * event is retained beyond the person it would name, and a provider's refusal can quote
 * them. The full refusal stays on the intent row (`ctx.platformRequests`), which erasure
 * reaches; the event says which request, what happened, and the codes a screen branches on.
 */
export const emailOutcomePayload = z
  .object({
    /** The id `requestEmail` returned — how a vertical joins the event to what it asked. */
    request: platformRequestId,
    about: entityRef.nullable(),
    /** Whose sender carried it: the platform's own address, or a tenant connection's. */
    sender: z.enum(['platform', 'tenant']),
    /** The provider's id for the message, when the provider gives one. */
    messageId: z.string().min(1).nullable(),
    /** Attempts made, this one included. */
    attempts: z.number().int().positive(),
    /** The taxonomy code of a refusal or of the last transient failure; `null` on `email.sent`. */
    code: z.string().min(1).nullable(),
    /** The provider's HTTP status, when the failure carried one. */
    status: z.number().int().nullable(),
  })
  .strict();
export type EmailOutcomePayload = z.infer<typeof emailOutcomePayload>;

/**
 * An event a platform-request SETTLE writes into the scope (#2102) — the drain's way of saying
 * what became of an intent as a fact the vertical can consume, rather than a row it must poll.
 *
 * The drain names the type, the entity and the payload; the scope stamps the rest (id, time,
 * tenant, scope, the kernel as actor) and writes it in the same transaction as the settle, and
 * only when that settle moved the row out of `pending`. A type outside this enum is refused,
 * so the settle route cannot be used to write an arbitrary event into a scope.
 */
export const platformOutcomeEvent = z
  .object({
    type: emailOutcomeType,
    entity: entityRef,
    payload: emailOutcomePayload,
  })
  .strict();
export type PlatformOutcomeEvent = z.infer<typeof platformOutcomeEvent>;
