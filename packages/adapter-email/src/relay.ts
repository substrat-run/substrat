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
  /**
   * How long to wait for the relay before giving up, in ms. Default {@link RELAY_TIMEOUT_MS}.
   *
   * Not tuning — a bound. This POST is made from inside whatever request asked for the mail,
   * and the caller is often not in a position to know that: Better Auth awaits a sign-up's
   * verification email inline unless an `advanced.backgroundTasks.handler` is configured, so an
   * unbounded send sits in the middle of a browser's redirect chain and the person watching sees
   * a page that never finishes. Two more services are behind this hop (the control plane, then
   * its mail provider), which is two more things that can be slow, so the bound belongs here —
   * at the one place that knows it is talking to a network.
   */
  timeoutMs?: number;
}

/**
 * The minimal `fetch` shape this transport needs — declared structurally so the package
 * depends on no DOM/Workers lib types (the same reason `SendEmailBinding` is structural).
 * The real `globalThis.fetch` in Node, Workers, and browsers is assignable to it.
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignalLike },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The abort signal, structurally — declared rather than imported for the same reason `FetchLike`
 * and `SendEmailBinding` are: this package carries no DOM or Workers lib types, so the real
 * `AbortSignal` is not a name it can refer to. Nothing here reads the signal; it is only
 * forwarded to whatever `fetch` it was given, so one field is the whole shape needed to keep
 * that pass-through honest.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

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

/**
 * The default bound on one relay POST. Generous for a control-plane hop that then calls a mail
 * provider, and far short of how long a person will watch a page that is not finishing — which
 * is the failure this exists to cap, not a slow send.
 */
export const RELAY_TIMEOUT_MS = 10_000;

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
    // Called in an arrow, never handed on: the package is kernel-free by design, so it
    // cannot use `globalFetch` and carries the same one-liner (see `lint:bound-fetch`).
    const fetchImpl: FetchLike =
      this.opts.fetchImpl ?? ((input, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(input, init));
    const base = this.opts.controlPlaneUrl.replace(/\/$/, '');
    // `AbortSignal.timeout` is web-standard and present in Node 18+, workerd and browsers — the
    // same availability bar the rest of this package holds to. Reached through `globalThis` with
    // a structural type, exactly as `fetch` is two lines below, because this package declares no
    // DOM lib. Feature-checked anyway: an environment without it must lose the bound rather than
    // the send, and a `fetchImpl` a test supplies need not honour a signal at all.
    const timeouts = (globalThis as unknown as { AbortSignal?: { timeout?: (ms: number) => AbortSignalLike } })
      .AbortSignal;
    const signal = typeof timeouts?.timeout === 'function'
      ? timeouts.timeout(this.opts.timeoutMs ?? RELAY_TIMEOUT_MS)
      : undefined;
    const res = await fetchImpl(`${base}/internal/email/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLATFORM_SECRET_HEADER]: this.opts.platformSecret,
      },
      ...(signal ? { signal } : {}),
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
