import {
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
  fileAttachments,
  prepareMessage,
} from './transport.js';

/**
 * The Cloudflare Email Service `send_email` Workers binding, typed
 * structurally so this package pulls in no platform typings (the kernel/scrive
 * convention — a locally-declared shape the real
 * `@cloudflare/workers-types` binding is assignable to).
 *
 * Bound in `wrangler.jsonc` as `"send_email": [{ "name": "EMAIL" }]`. No API
 * key: the binding IS the credential, and the `from` domain must be onboarded
 * (`wrangler email sending enable substrat.run`), which also auto-configures
 * SPF/DKIM because the zone is already on Cloudflare.
 */
export interface SendEmailBinding {
  send(message: {
    to: BindingAddress | BindingAddress[];
    from: BindingAddress;
    replyTo?: BindingAddress;
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
    attachments?: BindingAttachment[];
  }): Promise<CloudflareSendResponse>;
}

type BindingAddress = string | { email: string; name?: string };

/** The binding's attachment shape (Email Service Workers API): binary or base64 content. */
interface BindingAttachment {
  content: Uint8Array;
  filename: string;
  type: string;
  disposition: 'attachment' | 'inline';
}

/** CF returns immediate per-recipient feedback; the REST surface wraps it in `result`. */
interface CloudflareSendBody {
  delivered?: string[];
  permanent_bounces?: string[];
  queued?: string[];
}
type CloudflareSendResponse = CloudflareSendBody | { result: CloudflareSendBody };

/**
 * Send platform transactional mail through Cloudflare Email Service — the
 * default transport for invites, resets, and receipts on substrat.run. Same
 * platform, no new sub-processor (Cloudflare is already the foundational one),
 * and managed IP reputation + suppression lists + soft-bounce retries handled
 * by the service.
 *
 * The only thing a spec sheet can't promise is inbox-placement at volume; this
 * being a swappable port is the hedge — a warmer provider (Resend) is another
 * implementation of the same interface, not a rewrite. See README.
 */
export class CloudflareEmailTransport implements EmailTransport {
  constructor(private readonly binding: SendEmailBinding) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const m = prepareMessage(message);
    const attachments = fileAttachments(m);
    const response = await this.binding.send({
      to: m.to.map(toBinding),
      from: toBinding(m.from),
      ...(m.replyTo ? { replyTo: toBinding(m.replyTo) } : {}),
      subject: m.subject,
      html: m.html,
      text: m.text,
      ...(m.headers ? { headers: m.headers } : {}),
      // The whole message, attachments included, must stay under the service's 5 MiB.
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              content: a.content,
              filename: a.filename,
              type: a.contentType,
              disposition: 'attachment' as const,
            })),
          }
        : {}),
    });
    // The Workers binding returns the body directly; the REST surface wraps it
    // in `result` — accept either so the same transport works over both.
    const body = 'result' in response ? response.result : response;
    return {
      delivered: body.delivered ?? [],
      queued: body.queued ?? [],
      bounced: body.permanent_bounces ?? [],
    };
  }
}

/**
 * Our normalized address → the binding's address shape. A named address becomes
 * `{ email, name }`; a NAMELESS one becomes a bare string, never `{ email }`. The
 * workerd `EmailAddress` runtime rejects an object whose `name` is absent
 * ("Incorrect type for the 'name' field on 'EmailAddress': … not of type 'string'"),
 * so the object form is only safe when we actually have a name — a bare string is the
 * documented shape for a recipient with no display name.
 */
function toBinding(address: EmailAddress): string | { email: string; name: string } {
  return address.name ? { email: address.email, name: address.name } : address.email;
}
