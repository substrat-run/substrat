/**
 * Mail arriving at the desk (#934) — the inbound half of the relay.
 *
 * `ticket0/ingest-message` has existed since the desk did, and until this file nothing
 * called it outside the seed and a test: the concept's second door ("someone emails the
 * support address") was connected to nothing. This is the receiver that closes that —
 * verify, re-read, ingest — for Resend's inbound webhook.
 *
 * ── Harness, not module code ─────────────────────────────────────────────────
 * It holds a network client and a scope stub, which module code may hold neither of,
 * so it lives beside `relay.ts` and drives one ordinary operation as the desk's `relay`
 * principal — the account that holds `conversation:relay` and nothing a human holds.
 *
 * ── The body is a hint; the re-read is the fact ──────────────────────────────
 * The same rule the Scrive ingress follows (`docs/architecture/connections.md` §5). A
 * signed webhook proves Resend sent SOMETHING; what gets written is what Resend answers
 * when asked for the received email by id, never the fields the callback carried. It
 * also means there is no seen-set for replay: a redelivered webhook re-reads the same
 * email, and `ingest-message` is idempotent on `emailMessageId`.
 *
 * ── Replay protection ────────────────────────────────────────────────────────
 * Resend signs with Svix: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, keyed
 * by the base64 part of a `whsec_…` secret, and a signature older or newer than five
 * minutes is refused. That window is the replay protection; idempotency covers the rest.
 * The comparison is `crypto.subtle.verify`, which is constant-time, rather than a string
 * compare somebody has to get right by hand.
 *
 * ── Threading ────────────────────────────────────────────────────────────────
 * Every mail is ingested with `conversationId: null` and its `In-Reply-To` header, and
 * `ingest-message` does the stitch itself: a reply to a message the desk sent or
 * received joins that conversation when the sender is its contact, and opens one of its
 * own otherwise (`threadRepliedTo` in the module says why the address must match). The
 * relay holds no read that maps a header onto a conversation, and needs none.
 *
 * Attachments arrive as METADATA: `ingest-message` writes the internal note naming each
 * file (#1080), and the bytes are not fetched, because the desk has nowhere to put them.
 */
import { z } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';
import type { RelayInvoke } from './relay.js';

/** What a webhook request's headers are read through — a `Headers`, structurally. */
export interface InboundHeaders {
  get(name: string): string | null;
}

/** What this desk needs to receive mail. Both halves, or the door stays shut. */
export interface InboundConfig {
  /** The webhook's signing secret, as Resend shows it (`whsec_…`). */
  webhookSecret: string;
  /** The same key the outbound relay sends with — it is what may re-read a received email. */
  apiKey: string;
  fetch: FetchLike;
  /** Override for a test double. Defaults to Resend's own. */
  endpoint?: string;
  /** Per-call deadline for the re-read. */
  timeoutMs?: number;
}

/** The answer the route hands back to Resend. Counts and ids, never an address. */
export interface InboundResult {
  status: 200 | 400 | 401 | 502;
  body:
    | { ingested: true; messageId: string; conversationId: string; attachmentsNoted: number }
    | { ignored: string }
    | { error: string };
}

/** How far a signature's timestamp may sit from now before it is a replay. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
/** How long the re-read may take. Resend retries a non-2xx, so giving up is safe. */
const RETRIEVE_TIMEOUT_MS = 10_000;

/**
 * Which inbound config a desk's settings describe, or null.
 *
 * One place, like `senderFor`, so "configured" means one thing. Null is the normal state
 * of a desk that answers in the widget, and the route turns it into a 404: an unconfigured
 * desk must not look like it has a mail door that refuses signatures.
 */
export function inboundConfigFor(
  settings: { RESEND_API_KEY?: string | undefined; RESEND_WEBHOOK_SECRET?: string | undefined },
  fetchImpl: FetchLike,
): InboundConfig | null {
  const apiKey = settings.RESEND_API_KEY;
  const webhookSecret = settings.RESEND_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) return null;
  return { apiKey, webhookSecret, fetch: fetchImpl };
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Whether a Svix-signed request is one Resend sent, recently.
 *
 * `svix-signature` may carry several space-separated `v1,<base64>` entries (a secret
 * mid-rotation signs twice); any one verifying is enough.
 */
export async function verifyWebhookSignature(input: {
  secret: string;
  headers: InboundHeaders;
  body: string;
  nowMs: number;
}): Promise<'ok' | 'missing' | 'stale' | 'mismatch'> {
  const id = input.headers.get('svix-id');
  const timestamp = input.headers.get('svix-timestamp');
  const signature = input.headers.get('svix-signature');
  if (!id || !timestamp || !signature) return 'missing';

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return 'missing';
  if (Math.abs(input.nowMs / 1000 - seconds) > SIGNATURE_TOLERANCE_SECONDS) return 'stale';

  const keyBytes = base64ToBytes(input.secret.replace(/^whsec_/, ''));
  if (!keyBytes || keyBytes.length === 0) return 'mismatch';
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${input.body}`);
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const candidate = base64ToBytes(value);
    if (candidate && (await crypto.subtle.verify('HMAC', key, candidate, signed))) return 'ok';
  }
  return 'mismatch';
}

/** What `GET /emails/receiving/{id}` answers with — the part of it this reads. */
interface ReceivedEmail {
  from?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  message_id?: string | null;
  headers?: Record<string, string> | { name: string; value: string }[] | null;
  attachments?: { filename?: string | null; content_type?: string | null; size?: number | null }[] | null;
}

/** The abort signal, structurally — see `relay.ts` for why it is not imported. */
interface AbortSignalLike {
  readonly aborted: boolean;
}

function deadline(ms: number): AbortSignalLike | undefined {
  const timeouts = (
    globalThis as unknown as { AbortSignal?: { timeout?: (ms: number) => AbortSignalLike } }
  ).AbortSignal;
  return typeof timeouts?.timeout === 'function' ? timeouts.timeout(ms) : undefined;
}

/** One header off a received email, whichever of the two shapes it came in. */
function headerOf(email: ReceivedEmail, name: string): string | null {
  const wanted = name.toLowerCase();
  const headers = email.headers;
  if (!headers) return null;
  if (Array.isArray(headers)) {
    return headers.find((h) => h.name.toLowerCase() === wanted)?.value ?? null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

const address = z.string().email();

/** `"Name" <a@b>` or `a@b` → the parts `ingest-message` takes. Null if there is no address. */
export function parseFrom(from: string | null | undefined): { email: string; name: string | null } | null {
  if (!from) return null;
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const email = (angled ? angled[2]! : from).trim();
  const name = angled ? angled[1]!.trim() || null : null;
  return address.safeParse(email).success ? { email, name } : null;
}

/** Angle brackets, the shape an `In-Reply-To` carries and `ingest-message` matches exactly. */
const bracketed = (id: string) => (id.startsWith('<') ? id : `<${id}>`);

/**
 * Receive one webhook delivery.
 *
 * Every refusal answers rather than throws, so the route can hand Resend a status it
 * acts on: a 2xx stops the retries (a delivery this desk will never accept — an event it
 * does not handle, a mail with no usable sender), anything else asks for a retry (a bad
 * signature is not retried into success, but it must not look accepted either; a re-read
 * that failed may well work next time). What does throw is the ingest itself, which the
 * route logs.
 */
export async function receiveInbound(options: {
  config: InboundConfig;
  headers: InboundHeaders;
  body: string;
  invoke: RelayInvoke;
  /** The real clock, injectable so a test does not have to sign in the present. */
  now?: () => number;
}): Promise<InboundResult> {
  const { config, headers, body, invoke } = options;
  const verdict = await verifyWebhookSignature({
    secret: config.webhookSecret,
    headers,
    body,
    nowMs: (options.now ?? Date.now)(),
  });
  if (verdict !== 'ok') {
    return { status: 401, body: { error: `webhook signature refused (${verdict})` } };
  }

  let event: { type?: unknown; data?: { email_id?: unknown } };
  try {
    event = JSON.parse(body) as typeof event;
  } catch {
    return { status: 400, body: { error: 'webhook body is not JSON' } };
  }
  if (event.type !== 'email.received') {
    return { status: 200, body: { ignored: `event type ${String(event.type)} is not handled` } };
  }
  const emailId = event.data?.email_id;
  if (typeof emailId !== 'string' || emailId.length === 0) {
    return { status: 400, body: { error: 'email.received carried no email_id' } };
  }

  // The re-read. Nothing from the callback past the id is used below this line.
  const endpoint = (config.endpoint ?? 'https://api.resend.com/emails/receiving').replace(/\/$/, '');
  let email: ReceivedEmail;
  try {
    const signal = deadline(config.timeoutMs ?? RETRIEVE_TIMEOUT_MS);
    const response = await config.fetch(`${endpoint}/${encodeURIComponent(emailId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      return { status: 502, body: { error: `resend refused the re-read (HTTP ${response.status})` } };
    }
    email = (await response.json()) as ReceivedEmail;
  } catch (error) {
    return {
      status: 502,
      body: { error: `resend re-read failed: ${error instanceof Error ? error.message : String(error)}` },
    };
  }

  // The `From` HEADER first: Resend's top-level `from` on a received email can be the
  // bare address, and the header is where the sender's display name survives.
  const sender = parseFrom(headerOf(email, 'from')) ?? parseFrom(email.from);
  if (!sender) {
    // Permanent: a retry re-reads the same sender. Accepted so Resend stops, and said.
    return { status: 200, body: { ignored: 'the received email names no usable sender address' } };
  }

  const attachments = (email.attachments ?? []).map((a) => ({
    filename: a.filename ?? '(unnamed)',
    contentType: a.content_type ?? 'application/octet-stream',
    sizeBytes: typeof a.size === 'number' && a.size >= 0 ? Math.floor(a.size) : 0,
  }));

  const row = await invoke<{ id: string; conversation_id: string }>('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: sender.email,
    contactName: sender.name,
    subject: email.subject ?? '(no subject)',
    bodyText: email.text ?? '',
    bodyHtml: email.html ?? null,
    // The wire `Message-ID` when Resend names one; otherwise Resend's own id, which is
    // stable across redeliveries and so still keeps the ingest idempotent.
    emailMessageId: email.message_id ? bracketed(email.message_id) : `resend:${emailId}`,
    emailInReplyTo: headerOf(email, 'in-reply-to'),
    ...(attachments.length > 0 ? { attachments } : {}),
  });

  return {
    status: 200,
    body: {
      ingested: true,
      messageId: row.id,
      conversationId: row.conversation_id,
      attachmentsNoted: attachments.length,
    },
  };
}
