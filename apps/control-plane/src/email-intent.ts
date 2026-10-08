import { EmailError, type EmailTransport } from '@substrat-run/adapter-email';
import type { PlatformActorId } from '@substrat-run/contracts';
import type { SendEmailDeps } from '@substrat-run/control-plane-api';
import type { MailSender, ScopeHost } from '@substrat-run/kernel';
import type { EmailAddress } from '@substrat-run/adapter-email';
import { sendAsTenant } from './tenant-mail.js';

/**
 * The control plane's half of a queued send (#2102): the same two senders the synchronous
 * relay uses, handed to the drain's `send-email` handler.
 *
 * Neither needs the relay's caller proof. The relay is told which scope is asking; the drain
 * READ the intent out of that scope's own spine, so the scope is the one that asked — which is
 * the proof a tenant send needs, and why a send from inside a Durable Object, refused by the
 * relay, is allowed here.
 */
export interface EmailIntentWiring {
  host: ScopeHost;
  actor: PlatformActorId;
  transport: EmailTransport;
  platformFrom(name?: string): EmailAddress;
  senders: Readonly<Record<string, MailSender>>;
}

export function sendEmailDepsOf(w: EmailIntentWiring): SendEmailDeps {
  return {
    mayEmail: async (vertical) =>
      (await w.host.admin.listVerticals(w.actor)).find((v) => v.slug === vertical)?.emailSender === true,
    sendAsPlatform: async (mail) => {
      try {
        const result = await w.transport.send({
          to: mail.to,
          from: w.platformFrom(mail.fromName),
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        return result.messageId ? { messageId: result.messageId } : {};
      } catch (e) {
        // The transport's own refusal of the message (no text part, a malformed address) is
        // the request's fault, and the next pass would refuse the same bytes: final.
        if (e instanceof EmailError) throw Object.assign(new Error(e.message, { cause: e }), { status: 400 });
        throw e;
      }
    },
    // A refusal is thrown on as it is: its `status` is what the handler classifies by, and a 502's
    // `cause` is the provider's own answer.
    sendAsTenant: async (input) => {
      const result = await sendAsTenant(
        {
          host: w.host,
          actor: w.actor,
          senders: w.senders,
          openAttachment: async (connectionId, attachmentId) =>
            (await w.host.getConnectorAttachments(connectionId, input.scopeId)).open(attachmentId),
        },
        {
          tenantId: input.tenantId,
          vertical: input.vertical,
          from: input.from,
          ...(input.fromName ? { fromName: input.fromName } : {}),
          to: input.to,
          subject: input.subject,
          html: input.html,
          text: input.text,
          attachmentIds: input.attachmentIds,
        },
      );
      return result.messageId ? { messageId: result.messageId } : {};
    },
  };
}
