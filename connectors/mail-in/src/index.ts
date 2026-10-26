/**
 * `@substrat-run/connector-mail-in` — inbound mail for a scope (#2611).
 *
 * Host code, never module code. The control plane runs it: Cloudflare Email Routing on the
 * platform's receiving subdomain hands each message to the control plane's `email()` handler, which
 * calls {@link acceptInboundMail} while the sender waits, and the connector sweep (or a
 * `waitUntil` right after accepting) calls {@link deliverInboundMail}. A hosted vertical cannot
 * bind an email route, so this is the same shape as sending: the platform is the one worker
 * trusted with mail.
 *
 * - `address.ts` — an address's life: request, rotate, revoke, read. One address is one
 *   connection.
 * - `headers.ts` — the header block and what the receiving MX said about the sender.
 * - `inbound.ts` — accept, deliver, sweep.
 * - `store.ts` — where an accepted message waits.
 *
 * What lands in the scope, and how a vertical declares it, is `mailInChange` in
 * `@substrat-run/contracts`.
 */
import type { Connection, ConnectionProbe } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { messageEntries, readBinding, readStats } from './address.js';

export {
  BINDING_KEY,
  LOCAL_PART,
  MAIL_IN_BASE,
  MESSAGE_PREFIX,
  MailInError,
  STATS_KEY,
  addressOf,
  listMailInAddresses,
  localPartOf,
  mailInAddressOf,
  mintLocalPart,
  readBinding,
  readStats,
  messageEntries,
  requestMailInAddress,
  revokeMailInAddress,
  rotateMailInAddress,
} from './address.js';
export type { MailInAddressDeps, MailInBinding, MailInLanding, MailInLandingOf, MailInMessageEntry, MailInStats } from './address.js';
export {
  DEDUPE_RETENTION_MS,
  MAX_DELIVERY_ATTEMPTS,
  SMTP_REFUSALS,
  SWEEP_BATCH,
  acceptInboundMail,
  deliverInboundMail,
  resolveRecipient,
  senderAdmitted,
  sweepMailIn,
} from './inbound.js';
export type { AcceptOutcome, DeliveryOutcome, InboundMessage, MailInInboundDeps, MailInSweepResult } from './inbound.js';
export { CLOUDFLARE_AUTHSERV_ID, authVerdict, headerFields } from './headers.js';
export type { AuthVerdict } from './headers.js';
export { memoryMailInStore, r2MailInStore } from './store.js';
export type { MailInStore, R2LikeBucket } from './store.js';

/**
 * No standing grants. Each address's connection is granted the key its vertical declares, on the
 * one scope the address is for, when the address is minted — never a fixed key, never a whole
 * tenant.
 */
export const MAIL_IN_CONNECTION_GRANTS: readonly string[] = [];

/**
 * **Test connection** for an address: there is no provider to ask, so the answer is what the
 * platform knows — the address is live and bound, and what it has received.
 */
export async function probeMailInConnection(host: ScopeHost, connection: Pick<Connection, 'id'>): Promise<ConnectionProbe> {
  const binding = await readBinding(host, connection.id);
  if (!binding) {
    return { ok: false, refused: true, accountRef: null, accountLabel: null, facts: [], error: 'this connection holds no mail-in address' };
  }
  const [stats, entries] = await Promise.all([readStats(host, connection.id), messageEntries(host, connection.id)]);
  return {
    ok: true,
    refused: false,
    accountRef: binding.address.split('@')[0]!,
    accountLabel: binding.address,
    facts: [
      { label: 'Delivers to', value: binding.operation },
      { label: 'Senders', value: binding.allowlist.length ? binding.allowlist.join(', ').slice(0, 400) : 'anyone mail authentication passes' },
      { label: 'Received', value: String(stats.received) },
      { label: 'Delivered', value: String(stats.delivered) },
      { label: 'Waiting', value: String(entries.filter((e) => e.entry.status === 'pending').length) },
      { label: 'Dead-lettered', value: String(stats.deadLettered) },
      { label: 'Refused', value: String(stats.rejected) },
    ],
    error: null,
  };
}

/** A mail-in address is minted by the platform, never pasted: every candidate is refused. */
export async function probeMailInSecret(): Promise<ConnectionProbe> {
  return {
    ok: false,
    refused: true,
    accountRef: null,
    accountLabel: null,
    facts: [],
    error: 'a mail-in address is minted by the platform — request one for the scope instead of pasting a credential',
  };
}
