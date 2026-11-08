/**
 * The local stand-in for the platform's `send-email` drain: every mail a dev server's scopes
 * queue is written to a folder as an `.eml` file, and one line names the file.
 *
 * A vertical sends mail as a platform intent (`requestEmail`, #2102): a row its operation writes,
 * which the platform's drain delivers once the operation has committed. A hosted worker raises a
 * flag when an invoke requested something (`kickFlags`) and the router has the drain act within
 * seconds. A local dev server has no platform behind it, so the row sat `pending` forever: an
 * invitation queued by an admin went nowhere, said so nowhere, and could not be read by the person
 * testing it. Five of five CRM-shaped eval builds hit it (#3017).
 *
 * The same two moves, locally. `kick(node)` is the stub options a dev server spreads into
 * `getScope`, as the worker spreads `kickFlags`: after an invoke that requested something
 * commits, that scope is drained. `drain()` reads every scope's queue, for what a previous run
 * left pending. Each `send-email` is written, then settled `done` with the `email.sent` event the
 * platform's handler writes, so the vertical's timeline reads as it would hosted; any other kind
 * of intent is left for a platform this process does not have.
 *
 * Not a mail server and not a sender: nothing leaves the machine. It does not ask whether the
 * vertical holds the `emailSender` grant, which a hosted send needs (`sendsEmail` in
 * package.json), so a send that works here can still be refused when hosted.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMAIL_SENT,
  PLATFORM_REQUEST_ENTITY_TYPE,
  SEND_EMAIL_KIND,
  isPlatformRequest,
  sendEmailRequest,
  type PlatformActorId,
  type PlatformRequest,
  type ScopeId,
  type SendEmailRequest,
  type TenantId,
} from '@substrat-run/contracts';
import type { HostAdmin, ScopeHost, ScopeStubOptions } from '@substrat-run/kernel';

/** The environment variable that moves the outbox; unset, it is `<dataDir>/outbox`. */
export const MAIL_OUTBOX_ENV = 'MAIL_OUTBOX_DIR';

export interface DevMailOutboxOptions {
  /** The dev server's data directory. The outbox is `$MAIL_OUTBOX_DIR`, else `<dataDir>/outbox`. */
  dataDir: string;
  /** The local platform actor `drain()` lists scopes as. */
  actor: PlatformActorId;
  /** Overrides both the variable and the default. */
  dir?: string;
  /** Where the one line per mail goes. Default `console.log`. */
  log?: (line: string) => void;
}

/** A scope, as a dev server's caller resolves one. */
export interface OutboxNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

export interface DevMailOutbox {
  /** The folder mail is written to. */
  readonly dir: string;
  /**
   * Stub options for `getScope`: drain `node` once an invoke that requested something commits.
   * Spread them beside the caller's own, as a worker spreads `kickFlags`.
   */
  kick(node: OutboxNode): Pick<ScopeStubOptions, 'onPlatformRequests'>;
  /** Write every pending mail in `node`, or in every active scope; resolves to the files written. */
  drain(node?: OutboxNode): Promise<string[]>;
}

type OutboxHost = Pick<ScopeHost, 'listPlatformRequests' | 'settlePlatformRequest'> & {
  readonly admin: Pick<HostAdmin, 'listScopes'>;
};

export function devMailOutbox(host: OutboxHost, options: DevMailOutboxOptions): DevMailOutbox {
  const dir = options.dir ?? process.env[MAIL_OUTBOX_ENV] ?? join(options.dataDir, 'outbox');
  const log = options.log ?? ((line: string) => console.log(line));

  const drainScope = async (node: OutboxNode): Promise<string[]> => {
    const written: string[] = [];
    for (const entry of await host.listPlatformRequests(node.tenantId, node.scopeId)) {
      // A row that did not decode is the platform drain's to refuse; nothing here acts on it.
      if (!isPlatformRequest(entry) || entry.kind !== SEND_EMAIL_KIND || entry.decodeError !== undefined) continue;
      const parsed = sendEmailRequest.safeParse(entry.payload);
      if (!parsed.success) continue;
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${entry.id}.eml`);
      writeFileSync(file, emlOf(entry, parsed.data, node));
      const mail = parsed.data;
      const sender = mail.from === undefined ? 'platform' : 'tenant';
      const about = mail.about ?? null;
      await host.settlePlatformRequest(node.tenantId, node.scopeId, entry.id, {
        status: 'done',
        result: { sent: true, sender, messageId: null, outbox: file },
        event: {
          type: EMAIL_SENT,
          entity: about ?? { entityType: PLATFORM_REQUEST_ENTITY_TYPE, entityId: entry.id },
          payload: { request: entry.id, about, sender, messageId: null, attempts: entry.attempts + 1, code: null, status: null },
        },
      });
      log(`mail to ${mail.to}, "${mail.subject}": ${file}`);
      written.push(file);
    }
    return written;
  };

  // One drain per scope at a time: a kick that lands while one runs waits for it, and is not lost.
  const running = new Map<string, Promise<string[]>>();
  const serialised = (node: OutboxNode): Promise<string[]> => {
    const key = `${node.tenantId}/${node.scopeId}`;
    const next = (running.get(key) ?? Promise.resolve([])).catch(() => []).then(() => drainScope(node));
    running.set(key, next);
    const settled = () => {
      if (running.get(key) === next) running.delete(key);
    };
    next.then(settled, settled);
    return next;
  };

  return {
    dir,
    kick: (node) => ({
      onPlatformRequests: () => {
        serialised(node).catch((err: unknown) =>
          log(`mail outbox: could not drain ${node.tenantId}/${node.scopeId}: ${err instanceof Error ? err.message : String(err)}`),
        );
      },
    }),
    async drain(node) {
      if (node) return serialised(node);
      const scopes = await host.admin.listScopes(options.actor, { status: ['active'] });
      const written: string[] = [];
      for (const scope of scopes) written.push(...(await serialised({ tenantId: scope.tenantId, scopeId: scope.id })));
      return written;
    },
  };
}

/** A header value, RFC 2047-encoded when it is not plain ASCII. */
function header(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(flat)))}?=`;
}

/** The mail as a message a mail client opens: both bodies, and the headers a reader needs. */
function emlOf(request: PlatformRequest, mail: SendEmailRequest, node: OutboxNode): string {
  const boundary = `substrat-${request.id}`;
  const fromAddress = mail.from ?? 'platform@localhost';
  const from = mail.fromName ? `${header(mail.fromName)} <${fromAddress}>` : fromAddress;
  return [
    `From: ${from}`,
    `To: ${header(mail.to)}`,
    `Subject: ${header(mail.subject)}`,
    `Date: ${new Date(request.requestedAt).toUTCString()}`,
    `Message-ID: <${request.id}@outbox.localhost>`,
    `X-Substrat-Request: ${request.id}`,
    `X-Substrat-Scope: ${node.tenantId}/${node.scopeId}`,
    ...(mail.about ? [`X-Substrat-About: ${mail.about.entityType}/${mail.about.entityId}`] : []),
    ...(mail.attachments?.length ? [`X-Substrat-Attachments: ${mail.attachments.map((a) => a.attachmentId).join(', ')}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    mail.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    mail.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
