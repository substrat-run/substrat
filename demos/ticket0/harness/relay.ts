/**
 * The process that runs as the relay (#935, first slice).
 *
 * `ticket0/read-outbound` and `ticket0/record-delivery` have existed since the desk
 * did, and until this file nothing called them outside a test: a public reply on an
 * email conversation was a row nobody turned into mail. This is the runner that
 * closes that — notice, read, send, record — and the seam the sending provider
 * plugs into.
 *
 * ── Harness, not module code ─────────────────────────────────────────────────
 * A send leaves the building, so it cannot happen inside `ctx`. This file lives in
 * `harness/` beside the widget surface and the KB ingester for exactly that reason:
 * it holds a network client and a scope stub, and module code may hold neither. The
 * three operations it drives are ordinary operations, permission-checked as the
 * `relay` principal like every other caller.
 *
 * ── Why the send is outside the transaction, and what that costs ─────────────
 * The desk writes the reply and commits it. This runs afterwards. A send that fails
 * therefore leaves a public message with no `delivered_at` — which is the truthful
 * state, not a bug: the desk did decide to send it, and it has not gone. The next
 * sweep finds the same row and tries again, because `list-pending-outbound` is
 * defined by the absence of a delivery rather than by a queue somebody has to drain.
 * Rolling the reply back instead would mean a provider outage deleting an agent's
 * work, which is the worse of the two failures.
 *
 * ── At-least-once, and where the duplicate window is ─────────────────────────
 * `record-delivery` is a SECOND call, after the provider has accepted the message.
 * A crash between the two leaves a sent message that still looks pending, and the
 * next sweep sends it again. That window is real and is not closed here: closing it
 * needs a reservation on the row — a column, and so a migration — which is the next
 * slice rather than this one. What IS closed is the common case: a delivered
 * message leaves the list for good, and two sweeps running at once converge.
 */
import type { Page } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';

/** How this runner reaches the desk — one scope stub's `invoke`, nothing else. */
export interface RelayInvoke {
  <T>(operation: string, input: unknown): Promise<T>;
}

/** One message, as `ticket0/read-outbound` hands it over. */
export interface OutboundMessage {
  messageId: string;
  conversationId: string;
  subject: string;
  toEmail: string | null;
  fromAddress: string;
  agentName: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  emailInReplyTo: string | null;
}

/**
 * The provider seam.
 *
 * One method, and it returns the provider's own message id — which is the whole
 * reason the seam is shaped this way. That id is what `record-delivery` stores and
 * what a later inbound `In-Reply-To` matches against, so a provider that cannot
 * name what it just sent cannot thread, and the desk would answer the same customer
 * in a new conversation every time. Providers that hand back a bare id rather than
 * an RFC 5322 `Message-ID` are normalised here, at the connector, so every provider
 * gives the desk one shape (concept §3).
 */
export interface OutboundSender {
  /** A name for the log, and for `sweepOutbound`'s report. */
  readonly name: string;
  send(message: OutboundMessage): Promise<{ emailMessageId: string }>;
}

/** What one sweep did. Counts, never addresses — this is what gets logged. */
export interface SweepReport {
  /** How many rows the worklist offered. */
  pending: number;
  /** How many the provider accepted and `record-delivery` stamped. */
  sent: number;
  /** How many were skipped before the provider saw them — no recipient, no body. */
  skipped: number;
  /** How many the provider or the record refused. They stay pending. */
  failed: number;
}

interface PendingRow {
  messageId: string;
  conversationId: string;
  createdAt: string;
}

/** How many messages one sweep sends before leaving the rest to the next one. */
const SWEEP_BATCH = 25;

/**
 * Send everything this desk is waiting to send.
 *
 * Bounded on purpose: a desk that replied to a thousand conversations in a minute
 * sends them across several sweeps rather than holding one invocation open past
 * whatever ceiling the host has. The cap is a bound on one run, not on the day.
 *
 * Nothing in here throws for a single message. A recipient-less row, a body erased
 * between the reply and the send, a provider that refused — each is counted and the
 * sweep carries on, because one bad row must not stop the other twenty-four. The
 * counts are the signal; the reasons go to `onError`.
 */
export async function sweepOutbound(options: {
  invoke: RelayInvoke;
  sender: OutboundSender;
  /** Cap for one run. Defaults to `SWEEP_BATCH`. */
  batch?: number;
  /** Where a per-message failure goes. Defaults to `console.error`. */
  onError?: (where: { messageId: string; conversationId: string }, error: unknown) => void;
}): Promise<SweepReport> {
  const { invoke, sender } = options;
  const batch = options.batch ?? SWEEP_BATCH;
  const onError =
    options.onError ??
    ((where, error) =>
      console.error('ticket0: relay send failed', {
        ...where,
        provider: sender.name,
        // Never the address or the body: a log is a copy an erasure cannot reach.
        error: error instanceof Error ? error.message : String(error),
      }));

  const report: SweepReport = { pending: 0, sent: 0, skipped: 0, failed: 0 };
  let cursor: string | undefined;

  while (report.pending < batch) {
    const page = await invoke<Page<PendingRow>>('ticket0/list-pending-outbound', {
      limit: Math.min(batch - report.pending, batch),
      ...(cursor ? { cursor } : {}),
    });
    const rows = page.entries;
    if (rows.length === 0) break;
    report.pending += rows.length;

    for (const row of rows) {
      const where = { messageId: row.messageId, conversationId: row.conversationId };
      try {
        const message = await invoke<OutboundMessage>('ticket0/read-outbound', {
          messageId: row.messageId,
        });
        // Nothing to send is not a failure. An erasure between the reply and the send
        // leaves a public message with no body, which is the outcome `read-outbound`
        // was shaped to produce; a conversation with no email address behind it is a
        // desk misconfiguration a retry cannot fix. Both stay pending and neither
        // spends a provider call.
        if (!message.toEmail || (!message.bodyText && !message.bodyHtml)) {
          report.skipped += 1;
          continue;
        }
        const { emailMessageId } = await sender.send(message);
        await invoke('ticket0/record-delivery', { messageId: row.messageId, emailMessageId });
        report.sent += 1;
      } catch (error) {
        report.failed += 1;
        onError(where, error);
      }
    }

    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }

  return report;
}

/**
 * The sender a desk with no provider configured gets.
 *
 * It does NOT record a delivery — it throws, so the message stays pending and the
 * relay reports a failure. That is the point: a no-op that stamped `delivered_at`
 * would tell the desk a customer had been written to when nobody had, and the
 * conversation would look answered forever. A desk with no mail provider is a desk
 * that cannot send, and it should say so on every sweep.
 *
 * The subject line is written to the log so a local run can still be followed.
 */
export function unconfiguredSender(): OutboundSender {
  return {
    name: 'unconfigured',
    send(message) {
      console.warn('ticket0: no mail provider configured — reply not sent', {
        messageId: message.messageId,
        conversationId: message.conversationId,
        subject: message.subject,
      });
      return Promise.reject(
        new Error('no outbound mail provider is configured for this desk'),
      );
    },
  };
}

/** What Resend answers a `POST /emails` with. Everything else on it is ignored. */
interface ResendAccepted {
  id?: string;
}

/**
 * Resend, behind the seam.
 *
 * The threading headers are set HERE rather than by the desk, because they are the
 * part every provider spells differently and the desk must not learn three spellings:
 * `In-Reply-To` and `References` both carry the message this one answers, which is
 * what a mail client reads to keep the customer's thread together. Resend returns its
 * own id rather than a `Message-ID`, so it is normalised into one — the same shape
 * `ticket0/ingest-message` will match an inbound `In-Reply-To` against.
 *
 * `fetch` is injected as a `FetchLike` and never reached for globally: workerd checks
 * the receiver, and a bare global called as `options.fetch(…)` throws there and
 * nowhere a test runs (`lint:bound-fetch`).
 */
export function resendSender(options: {
  apiKey: string;
  fetch: FetchLike;
  /** Override for a test double. Defaults to Resend's own. */
  endpoint?: string;
}): OutboundSender {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails';
  return {
    name: 'resend',
    async send(message) {
      const from = message.agentName
        ? `${message.agentName} <${message.fromAddress}>`
        : message.fromAddress;
      const headers: Record<string, string> = message.emailInReplyTo
        ? { 'In-Reply-To': message.emailInReplyTo, References: message.emailInReplyTo }
        : {};
      const response = await options.fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.toEmail],
          subject: message.subject,
          ...(message.bodyText ? { text: message.bodyText } : {}),
          ...(message.bodyHtml ? { html: message.bodyHtml } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        }),
      });
      if (!response.ok) {
        // The status and nothing from the body: a provider's error text can quote the
        // recipient back, and this string ends up in a log.
        throw new Error(`resend refused the send (HTTP ${response.status})`);
      }
      const accepted = (await response.json()) as ResendAccepted;
      if (!accepted.id) {
        // Accepted with no id is worse than a refusal: the mail went, and nothing can
        // thread the customer's answer back to this conversation. Loud, not silent.
        throw new Error('resend accepted the send but named no message id');
      }
      // Normalised to an RFC 5322 Message-ID, because that is what an inbound
      // `In-Reply-To` will look like when the customer answers.
      return {
        emailMessageId: accepted.id.startsWith('<') ? accepted.id : `<${accepted.id}@resend.com>`,
      };
    },
  };
}

/**
 * Which sender a desk's configuration asks for.
 *
 * One place, so the worker and the node dev server cannot disagree about what
 * "configured" means. Absent credential ⇒ the unconfigured sender, which refuses
 * loudly rather than pretending.
 */
export function senderFor(
  settings: { RESEND_API_KEY?: string | undefined },
  fetchImpl: FetchLike,
): OutboundSender {
  const apiKey = settings.RESEND_API_KEY;
  if (!apiKey) return unconfiguredSender();
  return resendSender({ apiKey, fetch: fetchImpl });
}
