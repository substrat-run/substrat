import type { MailSendResult, OutboundMail } from '@substrat-run/kernel';
import { GRAPH_BASE } from './credential.js';
import { toBase64 } from './x509.js';

/** What a Graph call needs: an egress that records health, a token, and where Graph is. */
export interface GraphClient {
  fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
  accessToken: string;
  graphBase?: string;
}

/** A Graph refusal, with the HTTP status and Graph's own error code. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * The most attachment bytes one message may carry. Graph's `sendMail` takes a request of at
 * most 4 MB, attachments base64-encoded inside it, so this leaves room for the encoding and the
 * body. A larger file needs a draft and an upload session, and creating a draft needs
 * `Mail.ReadWrite` on the mailbox — which the least-privilege setup deliberately does not grant.
 */
export const MAX_ATTACHMENT_BYTES = Math.floor(2.5 * 1024 * 1024);

/**
 * Send one message as `mail.from` with `POST /users/{from}/sendMail`.
 *
 * Graph's message has one body, so the HTML part is sent and the text part is not. Only
 * `X-` headers may be set on a message through Graph; any other header is left out rather
 * than failing the send. Accepted (202) means queued, never delivered — Graph does not say more.
 */
export async function sendMail(client: GraphClient, mail: OutboundMail): Promise<MailSendResult> {
  const total = mail.attachments.reduce((n, a) => n + a.content.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new GraphError(
      413,
      undefined,
      `the attachments come to ${total} bytes; a message sent through Microsoft 365 carries at most ` +
        `${MAX_ATTACHMENT_BYTES} (larger files need Mail.ReadWrite on the mailbox, which this setup does not grant)`,
    );
  }
  const recipient = (a: { email: string; name?: string }) => ({
    emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
  });
  const headers = Object.entries(mail.headers ?? {})
    .filter(([name]) => /^x-/i.test(name))
    .map(([name, value]) => ({ name, value }));
  const message = {
    subject: mail.subject,
    body: { contentType: 'HTML', content: mail.html },
    toRecipients: mail.to.map(recipient),
    ...(mail.replyTo ? { replyTo: [recipient(mail.replyTo)] } : {}),
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
    ...(mail.attachments.length
      ? {
          attachments: mail.attachments.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.filename,
            contentType: a.contentType,
            contentBytes: toBase64(a.content),
          })),
        }
      : {}),
  };
  await call(client, 'POST', `users/${encodeURIComponent(mail.from.email)}/sendMail`, {
    message,
    saveToSentItems: true,
  });
  return { delivered: [], queued: mail.to.map((t) => t.email), bounced: [] };
}

async function call(client: GraphClient, method: string, path: string, body?: unknown) {
  const res = await client.fetch(`${client.graphBase ?? GRAPH_BASE}/v1.0/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${client.accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return res;
  const err = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }).error;
  throw new GraphError(res.status, err?.code, err?.message ?? `Graph answered ${res.status}`);
}
