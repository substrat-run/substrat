/**
 * @substrat-run/adapter-email — the platform's notification-transport port.
 *
 * Email is an ADAPTER, not a connector (D-18: notification transports are infra
 * the host consumes). One interface, `EmailTransport`, with swappable
 * implementations:
 *
 *   - CloudflareEmailTransport — Cloudflare Email Service (`send_email` binding).
 *     The default for platform transactional mail (invites, resets, receipts) on
 *     substrat.run: same platform, no new sub-processor, SPF/DKIM auto-configured.
 *   - PlatformRelayEmailTransport — for a HOSTED VERTICAL, which cannot bind
 *     `send_email` (#303): POSTs the message to the control plane's relay, which
 *     sends on its behalf when the vertical holds the `emailSender` grant.
 *   - MockEmailTransport — in memory, for dev/CI/scenario tests.
 *
 * Host code, never module code: module code has no network (CLAUDE.md), so mail
 * is sent by the host after commit, driven by the outbox. This package is only
 * the transport — it holds no templates, no addresses, no scheduling; those
 * belong to the caller (the invites executor, the dashboard/console workers).
 *
 * A mature provider (Resend) is a third implementation of this same port the day
 * measured deliverability or tenant-owned sender domains demand one — see README.
 */
export {
  type EmailAddress,
  type EmailRecipient,
  type EmailMessage,
  type SendResult,
  type EmailTransport,
  type PreparedMessage,
  EmailError,
  prepareMessage,
  addressEmail,
} from './transport.js';
export { CloudflareEmailTransport, type SendEmailBinding } from './cloudflare.js';
export { PlatformRelayEmailTransport, type PlatformRelayOptions } from './relay.js';
export { MockEmailTransport, type MockEmailOptions } from './mock.js';
