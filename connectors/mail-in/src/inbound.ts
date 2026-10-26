import PostalMime, { type Address, type Attachment } from 'postal-mime';
import {
  MAIL_IN_MAX_ATTACHMENTS,
  MAIL_IN_MAX_MESSAGE_BYTES,
  MAIL_IN_MAX_TEXT_CHARS,
  MAIL_IN_PROVIDER,
  instant,
  mailInChange,
  mailInMessageAnswer,
  scopeId as scopeIdSchema,
  type Connection,
  type ConnectionId,
  type PlatformActorId,
} from '@substrat-run/contracts';
import { connectorUploadBody, type ScopeAttachments, type ScopeHost } from '@substrat-run/kernel';
import {
  MESSAGE_PREFIX,
  bumpStats,
  localPartOf,
  messageEntries,
  readBinding,
  type MailInBinding,
  type MailInMessageEntry,
} from './address.js';
import {
  allowed,
  authVerdict,
  envelopeFromProven,
  firstAddress,
  firstHeader,
  headerFields,
  headerFromProven,
  type AuthVerdict,
} from './headers.js';
import type { MailInStore } from './store.js';

/**
 * Receiving one message (#2611), in the two halves the issue asks for: an **accept** that runs while
 * the sending server waits and either refuses or makes the message durable, and a **delivery** that
 * runs after, as often as it takes.
 *
 * ## Accept: refuse at SMTP time, or keep it
 *
 * Every refusal is an SMTP rejection (`setReject`), so a sender learns at once and nothing is
 * stored: an address that is not one the platform minted, one that is revoked or never existed,
 * a message over the size cap, and — when the address has an allowlist — a sender off it or not
 * proven to be who it says. The answers are deliberately few and plain; an unknown address and a
 * revoked one read the same, so the bounce is no oracle for which addresses were ever live.
 *
 * What passes is written to the store and recorded `pending` on the address's connection, keyed by
 * the hash of its `Message-ID` (or of its bytes when it carries none). A redelivery of the same
 * message finds the key and is accepted without storing it again, which is what makes "the same
 * `Message-ID` lands once" true.
 *
 * ## Deliver: the job half
 *
 * Parse the MIME, land a `message` change through the vertical's declared operation as the
 * connection, then each attachment's bytes on the entity it answered, each with its own
 * `attachment` change. Progress is written after every step, so a retry resumes where the last
 * attempt stopped instead of landing a file twice. A delivery that fails is retried with backoff by
 * the connector sweep; after {@link MAX_DELIVERY_ATTEMPTS} it is dead-lettered and its raw message
 * kept for an operator.
 *
 * ## The sender check
 *
 * Cloudflare already refuses mail that fails the sender's DMARC policy, or passes neither SPF nor
 * DKIM. With no allowlist that is the whole check. An allowlist narrows it to named senders, and
 * then a name is not enough: the `From:` address must be proven by DMARC (or an aligned DKIM
 * signature), or the envelope sender by SPF, as the receiving MX stamped them. Only that MX's
 * topmost result is read (`authVerdict`), since a sender can write any result into its own headers.
 */

/** Deliveries tried before a message is dead-lettered. */
export const MAX_DELIVERY_ATTEMPTS = 8;
/** The longest wait between two attempts. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Messages one sweep of one address delivers, at most. */
export const SWEEP_BATCH = 10;
/** How long a delivered message's dedupe record is kept. */
export const DEDUPE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What every refusal says to the sending server. Plain, and no oracle. */
export const SMTP_REFUSALS = {
  unknown: 'No such address',
  tooLarge: 'Message too large',
  notAllowed: 'Sender not allowed for this address',
  malformed: 'Malformed message',
} as const;

export interface MailInInboundDeps {
  actor: PlatformActorId;
  store: MailInStore;
  /** The receiving domain. Absent ⇒ every message is refused as an unknown address. */
  domain: string | undefined;
  /** Whose `Authentication-Results` are trusted. Defaults to Cloudflare Email Routing's. */
  authservId?: string;
  now?: () => Date;
}

/** One message as Email Routing hands it over. */
export interface InboundMessage {
  /** The envelope recipient (`RCPT TO`). */
  to: string;
  /** The envelope sender (`MAIL FROM`). */
  envelopeFrom: string;
  rawSize: number;
  /** The raw message, read only once the address is known to be live. */
  raw: () => Promise<Uint8Array>;
}

export type AcceptOutcome =
  | { accepted: true; connectionId: ConnectionId; messageId: string; duplicate: boolean }
  | { accepted: false; smtp: string; reason: string; connectionId?: ConnectionId };

const nowOf = (deps: { now?: () => Date }) => (deps.now ?? (() => new Date()))();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The live address a recipient names, with its connection — or null for anything else. */
export async function resolveRecipient(
  host: ScopeHost,
  deps: Pick<MailInInboundDeps, 'actor' | 'domain'>,
  to: string,
): Promise<{ connection: Connection; binding: MailInBinding } | null> {
  if (!deps.domain) return null;
  const local = localPartOf(to, deps.domain);
  if (!local) return null;
  const rows = await host.admin.listConnections(deps.actor, { provider: MAIL_IN_PROVIDER, externalAccountRef: local });
  const connection = rows.find((r) => !r.revokedAt);
  if (!connection) return null;
  const binding = await readBinding(host, connection.id);
  return binding ? { connection, binding } : null;
}

/** Whether the allowlist admits this sender, proven. An empty allowlist admits everyone Cloudflare let through. */
export function senderAdmitted(binding: Pick<MailInBinding, 'allowlist'>, verdict: AuthVerdict, headerFrom: string | null, envelopeFrom: string): boolean {
  if (binding.allowlist.length === 0) return true;
  if (headerFrom && allowed(binding.allowlist, headerFrom) && headerFromProven(verdict, headerFrom)) return true;
  const envelope = envelopeFrom.toLowerCase();
  return envelope.includes('@') && allowed(binding.allowlist, envelope) && envelopeFromProven(verdict, envelope);
}

const objectKeyOf = (binding: MailInBinding, connectionId: ConnectionId, messageId: string) =>
  `mail-in/${binding.tenantId}/${connectionId}/${messageId}.eml`;

/** The SMTP-time half: refuse, or make the message durable and pending. Never delivers. */
export async function acceptInboundMail(host: ScopeHost, deps: MailInInboundDeps, message: InboundMessage): Promise<AcceptOutcome> {
  const found = await resolveRecipient(host, deps, message.to);
  if (!found) return { accepted: false, smtp: SMTP_REFUSALS.unknown, reason: 'unknown-address' };
  const { connection, binding } = found;
  const refuse = async (smtp: string, reason: string): Promise<AcceptOutcome> => {
    const at = instant.parse(nowOf(deps).toISOString());
    await bumpStats(host, connection.id, (s) => ({ ...s, rejected: s.rejected + 1, lastRejectedAt: at, lastRejectReason: reason }));
    return { accepted: false, smtp, reason, connectionId: connection.id };
  };
  if (message.rawSize > MAIL_IN_MAX_MESSAGE_BYTES) return refuse(SMTP_REFUSALS.tooLarge, 'too-large');
  const raw = await message.raw();
  if (raw.byteLength > MAIL_IN_MAX_MESSAGE_BYTES) return refuse(SMTP_REFUSALS.tooLarge, 'too-large');
  const fields = headerFields(raw);
  if (!fields) return refuse(SMTP_REFUSALS.malformed, 'malformed');
  const verdict = authVerdict(fields, deps.authservId);
  const headerFrom = firstAddress(firstHeader(fields, 'from'));
  if (!senderAdmitted(binding, verdict, headerFrom, message.envelopeFrom)) {
    return refuse(SMTP_REFUSALS.notAllowed, verdict.stamped ? 'sender-not-allowed' : 'sender-unverified');
  }

  const headerMessageId = firstHeader(fields, 'message-id')?.trim().toLowerCase();
  const messageId = await sha256Hex(headerMessageId ? new TextEncoder().encode(headerMessageId) : raw);
  const key = `${MESSAGE_PREFIX}${messageId}`;
  if (await host.admin.getConnectorState(connection.id, key)) {
    return { accepted: true, connectionId: connection.id, messageId, duplicate: true };
  }
  const objectKey = objectKeyOf(binding, connection.id, messageId);
  // The bytes first: a state row that names an object that never landed would be a pending
  // message nothing can deliver, where a stored object with no row is only re-stored by a retry.
  await deps.store.put(objectKey, raw);
  const at = instant.parse(nowOf(deps).toISOString());
  const entry: MailInMessageEntry = {
    status: 'pending',
    receivedAt: at,
    size: raw.byteLength,
    objectKey,
    envelopeFrom: message.envelopeFrom.toLowerCase(),
    attempts: 0,
    nextAttemptAt: at,
    landed: {},
  };
  await host.admin.putConnectorState(connection.id, key, entry);
  await bumpStats(host, connection.id, (s) => ({ ...s, received: s.received + 1, lastReceivedAt: at }));
  return { accepted: true, connectionId: connection.id, messageId, duplicate: false };
}

export type DeliveryOutcome =
  | { status: 'delivered'; attachments: number }
  | { status: 'retrying'; attempts: number; error: string; nextAttemptAt: string }
  | { status: 'dead-lettered'; attempts: number; error: string }
  | { status: 'skipped'; why: string };

const mailbox = (a: Address | undefined) => {
  if (!a) return null;
  if (a.address) return { address: a.address.toLowerCase(), name: a.name || null };
  const first = a.group?.find((m) => m.address);
  return first ? { address: first.address.toLowerCase(), name: first.name || null } : null;
};

/** Every mailbox address a header names, groups flattened, lowercased. */
const addressesOf = (list: Address[] | undefined): string[] =>
  (list ?? []).flatMap((a) => (a.address ? [a.address] : (a.group ?? []).map((m) => m.address))).filter(Boolean).map((x) => x.toLowerCase());

const bytesOf = (content: Attachment['content']): Uint8Array =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);

const isoOrNull = (date: string | undefined): string | null => {
  if (!date) return null;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** Deliver one accepted message. Writes its progress after every step; never throws for the delivery's own failure. */
export async function deliverInboundMail(
  host: ScopeHost,
  deps: MailInInboundDeps,
  connectionId: ConnectionId,
  messageId: string,
): Promise<DeliveryOutcome> {
  const key = `${MESSAGE_PREFIX}${messageId}`;
  const stored = (await host.admin.getConnectorState(connectionId, key)) as MailInMessageEntry | undefined;
  if (!stored || stored.status !== 'pending') return { status: 'skipped', why: stored ? stored.status : 'unknown message' };
  const binding = await readBinding(host, connectionId);
  if (!binding) return { status: 'skipped', why: 'the address has no binding' };
  const entry: MailInMessageEntry = { ...stored, landed: { ...stored.landed } };
  const save = () => host.admin.putConnectorState(connectionId, key, entry);
  try {
    const raw = await deps.store.get(entry.objectKey);
    if (!raw) throw new Error('the stored message is gone');
    const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
    const fields = headerFields(raw) ?? [];
    const verdict = authVerdict(fields, deps.authservId);
    const scopeRef = scopeIdSchema.parse(binding.scopeId);
    const scope = await host.getConnectorScope(connectionId, scopeRef);
    const files = email.attachments;
    if (!entry.invoked) {
      const text = email.text ?? null;
      const change = mailInChange.parse({
        change: 'message',
        connectionId,
        messageId,
        headerMessageId: email.messageId ?? null,
        to: binding.address,
        envelopeFrom: entry.envelopeFrom ?? '',
        from: mailbox(email.from),
        replyTo: mailbox(email.replyTo?.[0]),
        recipients: { to: addressesOf(email.to), cc: addressesOf(email.cc) },
        subject: email.subject ?? null,
        date: isoOrNull(email.date),
        inReplyTo: email.inReplyTo ?? null,
        references: (email.references ?? '').split(/\s+/).filter(Boolean),
        text: text === null ? null : text.slice(0, MAIL_IN_MAX_TEXT_CHARS),
        textTruncated: text !== null && text.length > MAIL_IN_MAX_TEXT_CHARS,
        hasHtml: typeof email.html === 'string' && email.html.length > 0,
        authentication: { spf: verdict.spf, dkim: verdict.dkim, dmarc: verdict.dmarc },
        attachments: files.map((f, index) => ({
          index,
          filename: f.filename ?? `attachment-${index + 1}`,
          contentType: f.mimeType || 'application/octet-stream',
          size: bytesOf(f.content).byteLength,
          lands: index < MAIL_IN_MAX_ATTACHMENTS,
        })),
        receivedAt: entry.receivedAt,
      });
      const answer = mailInMessageAnswer.safeParse(await scope.invoke(binding.operation, change));
      entry.invoked = { entity: answer.success ? (answer.data.entity ?? null) : null };
      await save();
    }
    const entity = entry.invoked.entity;
    if (entity) {
      let attachments: ScopeAttachments | undefined;
      for (const [index, file] of files.entries()) {
        if (index >= MAIL_IN_MAX_ATTACHMENTS) break;
        if (entry.landed[String(index)]) continue;
        attachments ??= await host.getConnectorAttachments(connectionId, scopeRef);
        const record = await attachments.upload({
          entity,
          filename: file.filename ?? `attachment-${index + 1}`,
          contentType: file.mimeType || 'application/octet-stream',
          visibility: 'internal',
          body: connectorUploadBody(bytesOf(file.content)),
        });
        await scope.invoke(
          binding.operation,
          mailInChange.parse({
            change: 'attachment',
            connectionId,
            messageId,
            index,
            attachment: { id: record.id, filename: record.filename, contentType: record.contentType, size: record.size, sha256: record.sha256 },
          }),
        );
        entry.landed[String(index)] = record.id;
        await save();
      }
    }
    entry.status = 'delivered';
    entry.deliveredAt = instant.parse(nowOf(deps).toISOString());
    delete entry.lastError;
    delete entry.envelopeFrom;
    await save();
    // The bytes now live in the scope, as the vertical chose to keep them; the platform keeps none.
    await deps.store.delete(entry.objectKey);
    await bumpStats(host, connectionId, (s) => ({ ...s, delivered: s.delivered + 1 }));
    await host.admin.recordConnectionUse(connectionId, { ok: true }).catch(() => undefined);
    return { status: 'delivered', attachments: Object.keys(entry.landed).length };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    entry.attempts += 1;
    entry.lastError = error;
    await host.admin.recordConnectionUse(connectionId, { ok: false, error }).catch(() => undefined);
    if (entry.attempts >= MAX_DELIVERY_ATTEMPTS) {
      entry.status = 'dead-lettered';
      await save();
      await bumpStats(host, connectionId, (s) => ({ ...s, deadLettered: s.deadLettered + 1 }));
      return { status: 'dead-lettered', attempts: entry.attempts, error };
    }
    const wait = Math.min(60_000 * 2 ** entry.attempts, MAX_BACKOFF_MS);
    entry.nextAttemptAt = instant.parse(new Date(nowOf(deps).getTime() + wait).toISOString());
    await save();
    return { status: 'retrying', attempts: entry.attempts, error, nextAttemptAt: entry.nextAttemptAt };
  }
}

export interface MailInSweepResult {
  /** The address's binding count — one, or zero for a connection with none. */
  found: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
  failed: { scopeId: string; error: string }[];
}

/**
 * One address's pass: deliver what is due, oldest first, at most {@link SWEEP_BATCH}; and forget the
 * dedupe records of messages delivered more than {@link DEDUPE_RETENTION_MS} ago.
 */
export async function sweepMailIn(
  host: ScopeHost,
  deps: MailInInboundDeps,
  connectionId: ConnectionId,
  opts: { batch?: number } = {},
): Promise<MailInSweepResult> {
  const binding = await readBinding(host, connectionId);
  const result: MailInSweepResult = { found: binding ? 1 : 0, delivered: 0, retrying: 0, deadLettered: 0, failed: [] };
  if (!binding) return result;
  const now = nowOf(deps).getTime();
  const entries = await messageEntries(host, connectionId);
  for (const { key, entry } of entries) {
    if (entry.status === 'delivered' && entry.deliveredAt && now - Date.parse(entry.deliveredAt) > DEDUPE_RETENTION_MS) {
      await host.admin.putConnectorState(connectionId, key, null);
    }
  }
  const due = entries
    .filter((e) => e.entry.status === 'pending' && Date.parse(e.entry.nextAttemptAt) <= now)
    .sort((a, b) => a.entry.receivedAt.localeCompare(b.entry.receivedAt))
    .slice(0, opts.batch ?? SWEEP_BATCH);
  for (const { key } of due) {
    const outcome = await deliverInboundMail(host, deps, connectionId, key.slice(MESSAGE_PREFIX.length));
    if (outcome.status === 'delivered') result.delivered += 1;
    if (outcome.status === 'retrying') result.retrying += 1;
    if (outcome.status === 'dead-lettered') {
      result.deadLettered += 1;
      result.failed.push({ scopeId: binding.scopeId, error: `a message was dead-lettered: ${outcome.error}` });
    }
  }
  return result;
}
