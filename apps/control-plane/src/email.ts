import {
  CloudflareEmailTransport,
  MockEmailTransport,
  type EmailAddress,
  type EmailTransport,
  type SendEmailBinding,
} from '@substrat-run/adapter-email';

/**
 * The control plane's email seam (#303). Unlike the dashboard's — which sends the
 * platform's OWN transactional mail (team invites) — this transport exists to send mail
 * ON BEHALF OF a hosted vertical that holds the `emailSender` grant. Outbound is a
 * platform concern (deploy.ts §4 keeps `send_email` out of the sandbox allowlist and a
 * WfP dispatch script cannot bind it anyway), so the credential lives here, in one
 * privileged top-level worker, and the vertical reaches it through the `/internal/email/send`
 * relay rather than by holding a binding of its own.
 *
 * The message body (recipient, subject, html/text) comes from the vertical; the FROM
 * address is ALWAYS the platform's onboarded sender, never the vertical's choice — a
 * vertical must not be able to send as an arbitrary address on the platform's domain.
 */
interface EmailEnv {
  /** The Cloudflare Email Service `send_email` binding, when configured. */
  EMAIL?: SendEmailBinding;
  /** The sender address (e.g. `no-reply@send.substrat.net`); the domain must be onboarded. */
  EMAIL_FROM?: string;
}

/**
 * Resolve the transport: Cloudflare Email Service when the `send_email` binding is present
 * (prod), else the in-memory mock (local dev / tests). The mock accepts and drops — a
 * missing binding must degrade to a no-op, never crash a vertical's reset request.
 */
export function transportFor(env: EmailEnv): EmailTransport {
  return env.EMAIL ? new CloudflareEmailTransport(env.EMAIL) : new MockEmailTransport();
}

/**
 * The platform sender the relay stamps on every message, from config with a sensible
 * default — the dedicated sending SUBDOMAIN (`send.substrat.net`), never the apex, whose
 * MX carries live inbound mail. An optional per-vertical display `name` (e.g. "Substrat
 * Auth") rides on top so the FROM reads sensibly without letting the vertical pick the
 * address. Override the address with `EMAIL_FROM`.
 */
export function senderFor(env: EmailEnv, name?: string): EmailAddress {
  return { email: env.EMAIL_FROM ?? 'no-reply@send.substrat.net', name: name ?? 'Substrat' };
}
