/**
 * The notification-transport port — one interface every email implementation
 * satisfies (D-18: a notification transport is an ADAPTER, infra the host
 * consumes, not a connector a tenant configures).
 *
 * Callers depend on `EmailTransport` and nothing else; which implementation runs
 * (Cloudflare, mock, later Resend) is a deployment choice, never a code change.
 * The port also owns the deliverability invariants that must hold for EVERY
 * implementation — both an html and a text part, a subject, at least one
 * recipient — so no single provider can forget them (`prepareMessage`).
 */

/** A recipient/sender: an address, optionally with a display name. */
export interface EmailAddress {
  email: string;
  name?: string;
}

/** Either a bare address string or a named address. */
export type EmailRecipient = string | EmailAddress;

/**
 * A file sent with a message, as bytes — what a transport that talks to a provider sends.
 */
export interface EmailFileAttachment {
  filename: string;
  /** The MIME type, e.g. `application/pdf`. */
  contentType: string;
  content: Uint8Array;
}

/**
 * A file sent with a message, named by the id of an attachment in the sending scope (#2098).
 * Only the platform relay carries these: it reads the bytes on the platform side, as the
 * connection that sends, so a hosted vertical never ships file bytes in the request. A
 * transport that talks to a provider directly refuses one.
 */
export interface EmailAttachmentRef {
  attachmentId: string;
}

export type EmailAttachment = EmailFileAttachment | EmailAttachmentRef;

/** Is this attachment a reference by id rather than bytes? */
export function isAttachmentRef(attachment: EmailAttachment): attachment is EmailAttachmentRef {
  return 'attachmentId' in attachment;
}

/**
 * One transactional message. Both `html` and `text` are required: some clients
 * render only the text part, and a missing text part is a spam signal
 * (deliverability best practice, enforced by `prepareMessage`).
 */
export interface EmailMessage {
  to: EmailRecipient | EmailRecipient[];
  from: EmailAddress;
  replyTo?: EmailRecipient;
  subject: string;
  html: string;
  text: string;
  /** Extra headers (e.g. `List-Unsubscribe`, an idempotency key). */
  headers?: Record<string, string>;
  /** Files sent with the message — bytes for a provider transport, ids for the relay. */
  attachments?: EmailAttachment[];
}

/**
 * The immediate, normalized outcome of a send — the shape Cloudflare Email
 * Service returns per-recipient, mapped onto neutral names so a caller never
 * couples to a provider's response body.
 *
 *  - `delivered` — accepted by the recipient's mail server.
 *  - `queued`    — accepted by the transport, delivery still in flight.
 *  - `bounced`   — permanently rejected or suppressed; do not retry these.
 */
export interface SendResult {
  delivered: string[];
  queued: string[];
  bounced: string[];
}

/** The one method the whole platform sends mail through. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>;
}

/** A malformed message or a transport-level failure — distinct from a bounce. */
export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailError';
  }
}

/** A message after validation + normalization — recipients coerced to a list. */
export interface PreparedMessage {
  to: EmailAddress[];
  from: EmailAddress;
  replyTo?: EmailAddress;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Present only when the message carried any. */
  attachments?: EmailAttachment[];
}

/** The bare address of a recipient/sender — what a `SendResult` list carries. */
export function addressEmail(address: EmailAddress): string {
  return address.email;
}

/**
 * Validate + normalize a message before it reaches any provider. Every
 * implementation runs this first, so the port's invariants hold uniformly and a
 * programmer error (missing text part, empty subject, no recipient) fails fast
 * in dev/CI against the mock rather than as a silent spam-folder loss in prod.
 */
export function prepareMessage(message: EmailMessage): PreparedMessage {
  const to = (Array.isArray(message.to) ? message.to : [message.to]).map(coerceAddress);
  if (to.length === 0) throw new EmailError('email has no recipient');

  const subject = message.subject?.trim();
  if (!subject) throw new EmailError('email has no subject');

  // Both parts, always — see EmailMessage. The port enforces it so no provider can drop it.
  if (!message.html?.trim()) throw new EmailError('email has no html body');
  if (!message.text?.trim()) throw new EmailError('email has no text body');

  const attachments = message.attachments ?? [];
  for (const a of attachments) {
    if (isAttachmentRef(a)) {
      if (!a.attachmentId?.trim()) throw new EmailError('email attachment has an empty id');
    } else if (!a.filename?.trim() || !a.contentType?.trim()) {
      throw new EmailError('email attachment needs a filename and a content type');
    }
  }

  return {
    to,
    from: coerceAddress(message.from),
    replyTo: message.replyTo === undefined ? undefined : coerceAddress(message.replyTo),
    subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
    ...(attachments.length ? { attachments } : {}),
  };
}

/**
 * The byte attachments of a prepared message, for a transport that sends to a provider. A
 * reference by id cannot be resolved there — only the platform relay can read the scope —
 * so it is a programmer error, not something to drop silently.
 */
export function fileAttachments(m: PreparedMessage): EmailFileAttachment[] {
  return (m.attachments ?? []).map((a) => {
    if (isAttachmentRef(a)) {
      throw new EmailError(
        `attachment '${a.attachmentId}' is named by id, which only the platform relay can read — ` +
          `this transport sends bytes`,
      );
    }
    return a;
  });
}

/**
 * Coerce a recipient to a normalized address. The email check is deliberately
 * lax — exactly one `@` with non-empty sides — because real validation is the
 * provider's job (it bounces an unroutable address); this only catches the
 * obvious programmer error of passing something that isn't an address at all.
 */
function coerceAddress(recipient: EmailRecipient): EmailAddress {
  const raw = typeof recipient === 'string' ? { email: recipient } : recipient;
  const email = raw.email?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new EmailError(`invalid email address: ${JSON.stringify(recipient)}`);
  }
  const name = raw.name?.trim();
  return name ? { email, name } : { email };
}
