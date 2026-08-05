import {
  EmailError,
  prepareMessage,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from './transport.js';

/**
 * The email transport a HOSTED VERTICAL uses (#303). A vertical pushed to the Workers-for-
 * Platforms dispatch namespace cannot send mail itself — a dispatch script has no `send_email`
 * binding, and the §4 sandbox contract refuses one on purpose (outbound is a platform concern).
 * So instead of touching a provider, this transport POSTs the message to the control plane's
 * `/internal/email/send` relay, and the platform — the one worker that holds an outbound-mail
 * credential — sends it, but ONLY if this vertical holds the staff-granted `emailSender`
 * capability. Same `EmailTransport` seam as {@link CloudflareEmailTransport}: the auth-server's
 * Better-Auth `sendResetPassword` callback neither knows nor cares which one it got.
 *
 * Authentication is the `PLATFORM_SECRET` the WfP uploader injects into every dispatch script
 * (the same credential it uses to accept `/internal/provision`). That secret only proves "a
 * platform script is calling" — it is shared — so the relay does NOT trust it to say WHICH
 * vertical: it re-derives that from the `(tenantId, scopeId)` the caller names and checks the
 * grant against that scope's registered vertical. The FROM address is the platform's onboarded
 * sender; a `from.name` is forwarded as the display name only.
 */
export interface PlatformRelayOptions {
  /** The control plane's origin (injected into the vertical, e.g. `https://console.substrat.net`). */
  controlPlaneUrl: string;
  /** The `PLATFORM_SECRET` injected into this dispatch script — presented as `x-substrat-platform`. */
  platformSecret: string;
  /** This scope's tenant (ULID) — the relay resolves it to the vertical and checks the grant. */
  tenantId: string;
  /** This scope (ULID). */
  scopeId: string;
  /** `fetch` seam for tests; defaults to the runtime global. */
  fetchImpl?: FetchLike;
}

/**
 * The minimal `fetch` shape this transport needs — declared structurally so the package
 * depends on no DOM/Workers lib types (the same reason `SendEmailBinding` is structural).
 * The real `globalThis.fetch` in Node, Workers, and browsers is assignable to it.
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The response the relay returns — the normalized {@link SendResult} plus a `sent` flag. */
interface RelayResponse {
  sent?: boolean;
  delivered?: string[];
  queued?: string[];
  bounced?: string[];
  error?: string;
}

// The header the platform presents (kernel's `PLATFORM_SECRET_HEADER`). Hardcoded rather than
// imported so this low-level adapter takes no dependency on the kernel — the same structural
// coupling `SendEmailBinding` makes to the Workers runtime shape.
const PLATFORM_SECRET_HEADER = 'x-substrat-platform';

export class PlatformRelayEmailTransport implements EmailTransport {
  constructor(private readonly opts: PlatformRelayOptions) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const m = prepareMessage(message);
    // The relay is single-recipient (transactional reset/verification/invite mail always is);
    // fail loud rather than silently drop the rest of a list.
    const [recipient, ...rest] = m.to;
    if (!recipient || rest.length) {
      throw new EmailError(`the platform email relay sends to one recipient at a time (got ${m.to.length})`);
    }
    const fetchImpl: FetchLike = this.opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    const base = this.opts.controlPlaneUrl.replace(/\/$/, '');
    const res = await fetchImpl(`${base}/internal/email/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLATFORM_SECRET_HEADER]: this.opts.platformSecret,
      },
      body: JSON.stringify({
        tenantId: this.opts.tenantId,
        scopeId: this.opts.scopeId,
        to: recipient.email,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.from.name ? { fromName: m.from.name } : {}),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as RelayResponse;
      throw new EmailError(`platform email relay refused (${res.status}): ${body.error ?? 'unknown error'}`);
    }
    const body = (await res.json().catch(() => ({}))) as RelayResponse;
    return {
      delivered: body.delivered ?? [],
      queued: body.queued ?? [],
      bounced: body.bounced ?? [],
    };
  }
}
