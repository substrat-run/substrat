/**
 * What ticket0 writes through `ctx.log` (#1747), and what it keeps out of it.
 *
 * The lines are for a person reading the Logs page — including the vertical's builder,
 * who sees them across every desk that installed it — so the rule the call sites follow
 * is ids, counts and reason codes, never a customer's address, name, subject or words.
 * This suite drives the real operations against a collecting sink and holds both halves:
 * that each line says what happened, under the right operation, and that none of the
 * personal data the same calls handled appears anywhere on any line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleLogLine, ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { buildHost, seed, type Desk } from '../src/seed.js';

const EMAIL = 'maja.lind@private-mail.example';
const NAME = 'Maja Lind';
const SUBJECT = 'My invoice from March is wrong';
const BODY = 'My account number is 1234-5678 and the total is off by 300.';

let dir: string;
let host: ScopeHost;
let desk: Desk;
const lines: ModuleLogLine[] = [];

type Role = 'admin' | 'agent' | 'relay';
const at = (role: Role): Promise<ScopeStub> => host.getScope(desk[role].principal, desk.tenant, desk.scope);

/** The lines one operation wrote, in order. */
const linesOf = (operation: string) => lines.filter((l) => l.operation === operation);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-logging-'));
  host = buildHost(dir, undefined, (line) => lines.push(line));
  desk = (await seed(host)).kestrel;
  lines.length = 0;
}, 60_000);

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ticket0 ctx.log (#1747)', () => {
  let conversationId: string;
  const messageId = '<first-mail@private-mail.example>';

  it('says how an inbound mail found its conversation, and what it dropped', async () => {
    const relay = await at('relay');
    const row = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: EMAIL,
      contactName: NAME,
      subject: SUBJECT,
      bodyText: BODY,
      emailMessageId: messageId,
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 1000 }],
    })) as { conversation_id: string };
    conversationId = row.conversation_id;
    const ingest = linesOf('ticket0/ingest-message');
    expect(ingest).toContainEqual(
      expect.objectContaining({
        level: 'info',
        template: 'mail ingested into {conversationId} as {binding}',
        fields: { conversationId, binding: 'a new conversation' },
        tenantId: desk.tenant,
        scopeId: desk.scope,
      }),
    );
    expect(ingest).toContainEqual(
      expect.objectContaining({ level: 'warn', fields: { count: 1, conversationId } }),
    );
  });

  it('marks a redelivery as a redelivery, by conversation and not by Message-ID', async () => {
    const relay = await at('relay');
    await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: EMAIL,
      contactName: NAME,
      subject: SUBJECT,
      bodyText: BODY,
      emailMessageId: messageId,
    });
    expect(linesOf('ticket0/ingest-message').at(-1)).toMatchObject({
      level: 'debug',
      template: 'mail already ingested into {conversationId}',
      fields: { conversationId },
    });
  });

  it('logs a reply by who wrote it, never what they wrote', async () => {
    const agent = await at('agent');
    await agent.invoke('ticket0/post-public-reply', { conversationId, body: `Hi ${NAME}, about ${SUBJECT}: fixed.` });
    expect(linesOf('ticket0/post-public-reply')).toContainEqual(
      expect.objectContaining({ template: '{authorKind} replied on {conversationId}', fields: { authorKind: 'agent', conversationId } }),
    );
  });

  it('logs a refused sender by the rule that refused them, not by their address', async () => {
    const admin = await at('admin');
    const rule = (await admin.invoke('ticket0/add-block-rule', { kind: 'email', value: 'spam@junk.example' })) as { id: string };
    const relay = await at('relay');
    await expect(
      relay.invoke('ticket0/ingest-message', {
        conversationId: null,
        contactEmail: 'spam@junk.example',
        contactName: null,
        subject: 'Buy now',
        bodyText: 'Buy now',
        emailMessageId: '<spam-1@junk.example>',
      }),
    ).rejects.toThrow();
    expect(linesOf('ticket0/ingest-message').at(-1)).toMatchObject({
      level: 'warn',
      template: 'refused a {sender} blocked by rule {ruleId}',
      fields: { sender: 'new sender', ruleId: rule.id },
    });
  });

  it('writes none of the personal data those calls handled, on any line', () => {
    expect(lines.length).toBeGreaterThan(0);
    const text = JSON.stringify(lines);
    for (const personal of [EMAIL, NAME, SUBJECT, BODY, 'invoice.pdf', 'private-mail.example', 'spam@junk.example', 'junk.example']) {
      expect(text, personal).not.toContain(personal);
    }
  });
});
