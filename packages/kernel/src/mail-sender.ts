import type { Connection } from '@substrat-run/contracts';
import type { ScopeHost } from './scope-host.js';

/**
 * A connection that can send mail as an address the tenant owns (#2098) — a tenant's own
 * mailbox behind the platform's email relay.
 *
 * A vertical says what to send and from which address; the platform decides who sends it.
 * With no `from` the relay sends as the platform's own address, as it always has. With one,
 * it looks for a live connection of the tenant's whose sender says it may send as that
 * address, and hands the message to it. So Microsoft 365, Google Workspace or a tenant's own
 * Resend account is a connector implementing this, and a vertical never branches on which.
 *
 * **Shaped like a connection inspector, not a dispatch.** The relay runs top-level on the
 * control plane, not inside a delivery for a scope, so the sender is handed the host and the
 * connection's row and opens its own credential — the same way `probe(host, row)` does —
 * rather than being handed a connection the relay opened for it.
 */
export interface MailSender {
  /**
   * The addresses this connection may send as. Compared case-insensitively by the relay.
   *
   * Asked on every send that names a `from`, so it should answer from what the connection
   * already holds (its configuration, its secret) rather than a provider round trip.
   */
  senders(host: ScopeHost, connection: Connection): Promise<readonly string[]>;
  /**
   * Send one message as `mail.from.email`, which `senders` has already admitted.
   *
   * A failure should throw an error carrying the provider's numeric `status`, and for a
   * throttle its `Retry-After` in seconds as `retryAfter` (#2102): the platform retries a
   * send whose status is 429 or 5xx (or absent) and refuses one whose status is any other 4xx,
   * reading both structurally, so a sender that rewords an error must keep the two fields.
   */
  send(host: ScopeHost, connection: Connection, mail: OutboundMail): Promise<MailSendResult>;
}

/** An address, optionally with a display name. */
export interface MailAddress {
  email: string;
  name?: string;
}

/**
 * One file sent with a message, as bytes. The relay reads it from the scope's attachments by
 * id, as the sending connection, before the sender sees it — so a sender never needs a door
 * into the scope, and reads nothing its connection was not granted.
 */
export interface OutboundMailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/**
 * A message after the relay has validated it: recipients are a list, both parts are
 * present, attachments are bytes. Structurally the email adapter's prepared message plus
 * attachments; declared here because connectors depend on the kernel and not on the adapter.
 */
export interface OutboundMail {
  from: MailAddress;
  to: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  attachments: OutboundMailAttachment[];
}

/**
 * The immediate outcome, per recipient, on the email adapter's neutral names: `delivered`
 * (accepted by the recipient's server), `queued` (accepted, still in flight) and `bounced`
 * (refused for good). A sender that only learns "accepted" reports every recipient `queued`.
 */
export interface MailSendResult {
  delivered: string[];
  queued: string[];
  bounced: string[];
  /** The provider's id for the message, when it returns one (#2102). Graph's `sendMail` does not. */
  messageId?: string;
}
