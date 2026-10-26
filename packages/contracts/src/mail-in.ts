import { z } from 'zod';
import { attachmentRecord } from './attachments.js';
import { connectionId } from './connections.js';
import { entityRef } from './events.js';
import { instant, scopeId, tenantId } from './ids.js';

/**
 * Inbound mail vocabulary (#2611): what a vertical sees of a message somebody mailed to one of its
 * scopes, and what crosses the relay when a scope asks for, rotates or gives up its address.
 *
 * The platform receives on a subdomain of its own (`in.substrat.run`), through Cloudflare Email
 * Routing into the control plane, because a hosted vertical cannot bind an email route. An address
 * is a **capability**: `<slug>-<token>@<domain>`, minted for one scope, delivering into the one
 * operation the vertical declares for it. It is backed by its own `mail-in` connection, so it is
 * revoked, rotated and audited the way every connection is, and delivery is the connection's door
 * (`getConnectorScope`, #97): the event actor is `{ connection }`, never the person who asked for
 * the address.
 *
 * A vertical opts in by declaring a landing in its manifest:
 *
 * ```ts
 * connections: [{ provider: 'mail-in', operation: 'docs/receive-mail', permission: 'docs:receive-mail' }]
 * ```
 *
 * The connection is granted that key on the address's scope, and on nothing else. The entity the
 * message lands as must be an attachment target writable with the same key, since the attachment
 * bytes land as the same connection.
 */

/** The provider slug a mail-in connection carries. */
export const MAIL_IN_PROVIDER = 'mail-in';

/** The largest raw message accepted, as Email Routing measures it. A bigger one is refused at SMTP time. */
export const MAIL_IN_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** The most attachments one message lands. Past it the rest are named on the message and not landed. */
export const MAIL_IN_MAX_ATTACHMENTS = 20;
/** The most characters of the text body the message change carries; the rest is cut and said to be. */
export const MAIL_IN_MAX_TEXT_CHARS = 64 * 1024;
/** The most addresses an allowlist holds. */
export const MAIL_IN_MAX_ALLOWLIST = 20;

/** An address's sender allowlist entry: a whole address, or `@domain` for any address there. */
export const mailInAllowEntry = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^([^\s@]+@[^\s@]+\.[^\s@]+|@[^\s@]+\.[^\s@]+)$/, 'an address, or @domain');

/** What the platform made of the message's authentication, as Cloudflare stamped it. */
export const mailInAuthResult = z.enum(['pass', 'fail', 'none', 'unknown']);
export type MailInAuthResult = z.infer<typeof mailInAuthResult>;

const mailbox = z.object({ address: z.string(), name: z.string().nullable() });

const commonChange = {
  /** The mail-in connection the address is — the actor of everything the delivery writes. */
  connectionId,
  /**
   * The platform's id for this message: the hash it is deduplicated on (its `Message-ID`, or its
   * bytes when it has none). A landing operation keys on it, since delivery is at least once.
   */
  messageId: z.string().min(1),
};

/**
 * What a delivery lands through the address's operation, one change per invoke — parsed with this
 * schema on the way out, as `fileSourceChange` is.
 *
 * - `message`: the message arrived. Header metadata and the text body, never bytes. Each attachment
 *   is named with its `index`; when the operation answers `{ entity }`, each one's bytes land on
 *   that entity and an `attachment` change follows per file. Answer anything else and no bytes land.
 * - `attachment`: one file's bytes landed as `attachment` on the entity the message change named.
 *
 * Delivery is **at least once**, keyed by `messageId` (and `index` within it): an operation upserts,
 * and may see either change twice.
 */
export const mailInChange = z.discriminatedUnion('change', [
  z.object({
    change: z.literal('message'),
    ...commonChange,
    /** The message's own `Message-ID` header, as sent. */
    headerMessageId: z.string().nullable(),
    /** The address it was delivered to — the scope's mail-in address. */
    to: z.string(),
    /** The envelope sender (`MAIL FROM`), which a forwarder rewrites. */
    envelopeFrom: z.string(),
    /** The `From:` header. */
    from: mailbox.nullable(),
    replyTo: mailbox.nullable(),
    /**
     * Who the message was addressed to, as its `To:` and `Cc:` headers say — the sender's text,
     * lowercased addresses only. Distinct from `to`, which is the address it was delivered to.
     */
    recipients: z.object({ to: z.array(z.string()), cc: z.array(z.string()) }),
    subject: z.string().nullable(),
    /** The `Date:` header, as an instant when it parses. */
    date: z.string().nullable(),
    inReplyTo: z.string().nullable(),
    references: z.array(z.string()),
    text: z.string().nullable(),
    textTruncated: z.boolean(),
    /** Whether an HTML body came with it. Its markup is not carried. */
    hasHtml: z.boolean(),
    authentication: z.object({ spf: mailInAuthResult, dkim: mailInAuthResult, dmarc: mailInAuthResult }),
    attachments: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number().int().nonnegative(),
        /** False past {@link MAIL_IN_MAX_ATTACHMENTS}: named here, never landed. */
        lands: z.boolean(),
      }),
    ),
    receivedAt: instant,
  }),
  z.object({
    change: z.literal('attachment'),
    ...commonChange,
    index: z.number().int().nonnegative(),
    attachment: attachmentRecord.pick({ id: true, filename: true, contentType: true, size: true, sha256: true }),
  }),
]);
export type MailInChange = z.infer<typeof mailInChange>;

/**
 * What the operation answers to a `message` change: the entity its attachments land on. Parsed by
 * the platform, not the vertical, so an answer carrying more than `entity` is accepted.
 */
export const mailInMessageAnswer = z.object({ entity: entityRef.nullable().optional() }).passthrough();
export type MailInMessageAnswer = z.infer<typeof mailInMessageAnswer>;

/** One scope's address, as the relay and the dashboard show it. */
export const mailInAddress = z.object({
  address: z.string(),
  connectionId,
  tenantId,
  scopeId,
  vertical: z.string(),
  operation: z.string(),
  permission: z.string(),
  allowlist: z.array(z.string()),
  createdAt: instant,
  createdBy: z.string(),
  /** Counts only — never an address the mail came from. */
  stats: z.object({
    received: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    lastReceivedAt: instant.nullable(),
    lastRejectedAt: instant.nullable(),
    lastRejectReason: z.string().nullable(),
  }),
});
export type MailInAddress = z.infer<typeof mailInAddress>;

/**
 * The relay a vertical's worker calls (`/internal/mail-in/address`) for its own scope's address.
 * `get` reads; `request` mints one when the scope has none (and answers the live one when it has);
 * `rotate` replaces the address, carrying the allowlist and any mail still in flight; `revoke`
 * gives it up. `allowlist` on `request` or `rotate` replaces the list; absent keeps it.
 */
export const mailInRelayRequest = z.object({
  tenantId,
  scopeId,
  action: z.enum(['get', 'request', 'rotate', 'revoke']),
  /** The principal whose in-scope `ctx.check` authorized the act. Required for every action but `get`. */
  createdBy: z.string().min(1).optional(),
  allowlist: z.array(mailInAllowEntry).max(MAIL_IN_MAX_ALLOWLIST).optional(),
});
export type MailInRelayRequest = z.input<typeof mailInRelayRequest>;

export const mailInRelayResult = z.object({ address: mailInAddress.nullable() });
export type MailInRelayResult = z.infer<typeof mailInRelayResult>;
