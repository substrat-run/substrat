import { prepareMessage, EmailError } from '@substrat-run/adapter-email';
import { isSubstratError, type Connection, type PlatformActorId } from '@substrat-run/contracts';
import type {
  MailSendResult,
  MailSender,
  OpenedAttachment,
  OutboundMailAttachment,
  ScopeHost,
} from '@substrat-run/kernel';

/**
 * Sending as a tenant's own address (#2098) — the half of the email relay that is not the
 * platform's sender.
 *
 * The relay is handed a `from`. It never takes that on the caller's word: it looks through the
 * tenant's live connections for this vertical, asks each one whose connector registers a
 * {@link MailSender} which addresses it may send as, and sends through the one that covers the
 * address. None covering it is a refusal naming the address — never a quiet fall back to the
 * platform's sender, which would deliver mail as somebody the vertical did not ask for.
 *
 * Attachments are read here, by id, AS the sending connection (`getConnectorAttachments`): a
 * file reaches a message only when the tenant granted that connection read on the
 * attachment's target, which is a grant that appears in the permission diff like any other.
 */

/** A refusal the relay answers with, carrying its HTTP status. */
export class TenantMailRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 413 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'TenantMailRefusal';
  }
}

/**
 * The most attachment bytes one relayed message may carry. A bound on what this worker holds in
 * memory for one request, not a promise that a provider accepts that much: each sender still
 * meets its provider's own limit (Cloudflare's is 5 MiB a message), and says so when it refuses.
 */
export const TENANT_MAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface TenantMailDeps {
  host: ScopeHost;
  actor: PlatformActorId;
  /** provider → its mail sender, for the connectors that register one. */
  senders: Readonly<Record<string, MailSender>>;
  /** Read one attachment of the sending scope as `connectionId`. `null` = no such attachment. */
  openAttachment(connectionId: Connection['id'], attachmentId: string): Promise<OpenedAttachment | null>;
}

export interface TenantMailInput {
  tenantId: Connection['tenantId'];
  vertical: string;
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachmentIds: readonly string[];
}

/** The connection that may send as `from`, and its sender. Refuses when none, or more than one, does. */
export async function resolveTenantSender(
  deps: Pick<TenantMailDeps, 'host' | 'actor' | 'senders'>,
  input: Pick<TenantMailInput, 'tenantId' | 'vertical' | 'from'>,
): Promise<{ connection: Connection; sender: MailSender }> {
  const wanted = input.from.toLowerCase();
  const live = await deps.host.admin.listConnections(deps.actor, {
    tenantId: input.tenantId,
    vertical: input.vertical,
  });
  const covering: { connection: Connection; sender: MailSender }[] = [];
  // One connection that cannot answer (a secret that will not open, a provider that is down)
  // must not take mail through every other connection of the tenant down with it.
  const unanswered: Connection['id'][] = [];
  for (const connection of live) {
    if (connection.status !== 'active') continue;
    const sender = deps.senders[connection.provider];
    if (!sender) continue;
    let addresses: readonly string[];
    try {
      addresses = await sender.senders(deps.host, connection);
    } catch {
      unanswered.push(connection.id);
      continue;
    }
    if (addresses.some((a) => a.toLowerCase() === wanted)) covering.push({ connection, sender });
  }
  const [only, ...more] = covering;
  // Nothing covers it, but a connection that did not answer might have: say that, rather than
  // a 403 claiming the address is covered by nothing, which would send someone looking for a
  // configuration mistake that is not there.
  if (!only && unanswered.length > 0) {
    throw new TenantMailRefusal(
      503,
      `no mail connection that answered may send as '${input.from}', and ${unanswered.length} could ` +
        `not be asked (${unanswered.join(', ')}) — try again, or check those connections`,
    );
  }
  if (!only) {
    throw new TenantMailRefusal(
      403,
      `no mail connection of this tenant may send as '${input.from}' — connect one that covers ` +
        `the address, or leave out \`from\` to send as the platform`,
    );
  }
  // Acting through the wrong mailbox is worse than failing: two connections claiming one
  // address is a configuration to fix, not a choice to make silently.
  if (more.length > 0) {
    throw new TenantMailRefusal(
      409,
      `${covering.length} mail connections of this tenant claim '${input.from}' ` +
        `(${covering.map((c) => c.connection.id).join(', ')}) — revoke all but one`,
    );
  }
  return only;
}

/** Send one relayed message as a tenant address. */
export async function sendAsTenant(deps: TenantMailDeps, input: TenantMailInput): Promise<MailSendResult> {
  const { connection, sender } = await resolveTenantSender(deps, input);

  let prepared;
  try {
    prepared = prepareMessage({
      to: input.to,
      from: { email: input.from, ...(input.fromName ? { name: input.fromName } : {}) },
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
  } catch (e) {
    if (e instanceof EmailError) throw new TenantMailRefusal(400, e.message);
    throw e;
  }

  const attachments: OutboundMailAttachment[] = [];
  let total = 0;
  for (const id of input.attachmentIds) {
    const opened = await openAs(deps, connection, id);
    total += opened.body.byteLength;
    if (total > TENANT_MAIL_MAX_ATTACHMENT_BYTES) {
      throw new TenantMailRefusal(
        413,
        `the attachments come to more than ${TENANT_MAIL_MAX_ATTACHMENT_BYTES} bytes, the most one relayed message may carry`,
      );
    }
    attachments.push({ filename: opened.record.filename, contentType: opened.contentType, content: opened.body });
  }

  const mail = {
    from: prepared.from,
    to: prepared.to,
    ...(prepared.replyTo ? { replyTo: prepared.replyTo } : {}),
    subject: prepared.subject,
    html: prepared.html,
    text: prepared.text,
    ...(prepared.headers ? { headers: prepared.headers } : {}),
    attachments,
  };
  try {
    return await sender.send(deps.host, connection, mail);
  } catch (e) {
    // The provider's refusal, said as the connector worded it (#2100: "outside the scope the
    // tenant granted"), rather than a bare 500 that tells the vertical nothing.
    throw new TenantMailRefusal(502, `the tenant's mail connection could not send: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openAs(deps: TenantMailDeps, connection: Connection, attachmentId: string): Promise<OpenedAttachment> {
  let opened: OpenedAttachment | null;
  try {
    opened = await deps.openAttachment(connection.id, attachmentId);
  } catch (e) {
    if (isSubstratError(e) && e.code === 'permission_denied') {
      throw new TenantMailRefusal(
        403,
        `connection ${connection.id} may not read attachment '${attachmentId}' — grant it the read ` +
          `permission of the attachment's target`,
      );
    }
    throw e;
  }
  if (!opened) throw new TenantMailRefusal(400, `attachment '${attachmentId}' does not exist in this scope`);
  return opened;
}
