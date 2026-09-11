/**
 * The one thing in this desk that leaves the building (#935).
 *
 * `read-outbound` and `record-delivery` have been right since the desk existed, and
 * every suite here drove them by hand — so a desk that sent nothing at all passed
 * every test in the package. This one drives the RUNNER, against a fake provider, and
 * asserts the four things that decide whether a customer hears back:
 *
 *   - a public reply on an email conversation is sent, once;
 *   - an internal note is never sent, whatever else is waiting;
 *   - a widget conversation's reply is not emailed — the widget IS the delivery;
 *   - a second sweep sends nothing, because the first one recorded the delivery.
 *
 * The provider is a fake rather than a mock of HTTP: the seam this vertical owns is
 * `OutboundSender`, and what is worth pinning is that the runner calls it once per
 * waiting message with the body the desk actually wrote. `resendSender`'s own wire
 * shape is exercised separately, through an injected fetch, because that is a
 * different claim — what Resend is told — from this one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import {
  resendSender,
  senderFor,
  sweepOutbound,
  unconfiguredSender,
  type OutboundMessage,
  type OutboundSender,
} from '../harness/relay.js';
import { buildHost, seed, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

/** Distinct provider message ids, without reaching for a clock. */
let arrivals = 0;
/** Distinct ids from the fake provider, for the same reason. */
let accepted = 0;

interface Message {
  id: string;
  conversation_id: string;
  delivered_at: string | null;
  email_message_id: string | null;
}

const at = (desk: Desk, role: 'admin' | 'agent' | 'relay' | 'widget'): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

/** A provider that accepts everything and remembers what it was handed. */
function fakeSender(): OutboundSender & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    name: 'fake',
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve({ emailMessageId: `<sent-${(accepted += 1)}@provider.example>` });
    },
  };
}

/** The runner, as the desk's own relay principal — the only door this has. */
async function sweep(desk: Desk, sender: OutboundSender) {
  const relay = await at(desk, 'relay');
  return sweepOutbound({
    invoke: <T,>(op: string, input: unknown) => relay.invoke(op, input) as Promise<T>,
    sender,
    // Silence, not `console.error`: the failure cases below are expected, and the
    // report is what they are asserted on.
    onError: () => {},
  });
}

/** An email conversation with the customer's message already in it. */
async function emailConversation(desk: Desk, subject: string): Promise<string> {
  const relay = await at(desk, 'relay');
  const arrived = (await relay.invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: 'inbound@customer.example',
    contactName: 'Inbound',
    subject,
    bodyText: 'Is this thing on?',
    emailMessageId: `<in-${(arrivals += 1)}@mail.example>`,
  })) as Message;
  return arrived.conversation_id;
}

async function reply(desk: Desk, conversationId: string, body: string): Promise<Message> {
  const agent = await at(desk, 'agent');
  return (await agent.invoke('ticket0/post-public-reply', {
    conversationId,
    body,
  })) as Message;
}

async function note(desk: Desk, conversationId: string, body: string): Promise<Message> {
  const agent = await at(desk, 'agent');
  return (await agent.invoke('ticket0/post-note', { conversationId, body })) as Message;
}

/** One message, read back through the operation a screen would use. */
async function readMessage(desk: Desk, conversationId: string, id: string): Promise<Message> {
  const agent = await at(desk, 'agent');
  const thread = (await agent.invoke('ticket0/list-messages', { conversationId })) as {
    entries: Message[];
  };
  const found = thread.entries.find((m) => m.id === id);
  if (!found) throw new Error(`message ${id} is not on conversation ${conversationId}`);
  return found;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-relay-'));
  host = buildHost(dir);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a public reply on an email conversation becomes mail, exactly once', () => {
  let conversationId = '';
  let sentReply = '';

  it('drains whatever the seeded world is already holding', async () => {
    // The seed writes a desk with history in it, and some of that history is public
    // replies on email conversations — which is to say the worklist is not empty on
    // the first sweep. Draining it here is what lets every assertion below be about
    // the ONE message its own block created.
    const sender = fakeSender();
    await sweep(world.substrat, sender);
    const after = await sweep(world.substrat, sender);
    expect(after.pending).toBe(0);
  });

  it('sends it, with the body the agent wrote and the desk’s From address', async () => {
    const desk = world.substrat;
    conversationId = await emailConversation(desk, 'Does the relay run?');
    sentReply = (await reply(desk, conversationId, 'It does now.')).id;

    const sender = fakeSender();
    const report = await sweep(desk, sender);

    expect(report.sent).toBe(1);
    expect(report.failed).toBe(0);
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.messageId).toBe(sentReply);
    expect(mail.bodyText).toBe('It does now.');
    expect(mail.toEmail).toBe('inbound@customer.example');
    expect(mail.fromAddress).toBe('support@substrat.net');
  });

  it('records the provider’s id, which is what a later reply threads against', async () => {
    const stored = await readMessage(world.substrat, conversationId, sentReply);
    expect(stored.delivered_at).not.toBeNull();
    expect(stored.email_message_id).toMatch(/^<sent-\d+@provider\.example>$/);
  });

  it('and a second sweep sends nothing — the delivery is what takes it off the list', async () => {
    const sender = fakeSender();
    const report = await sweep(world.substrat, sender);
    expect(report.pending).toBe(0);
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

describe('what the relay must never send', () => {
  it('an internal note, even with a sendable reply beside it on the same thread', async () => {
    const desk = world.substrat;
    const conversationId = await emailConversation(desk, 'Two messages, one sendable');
    const internal = await note(desk, conversationId, 'Customer is on the old plan — check first.');
    const sendable = await reply(desk, conversationId, 'Checked — you are covered.');

    const sender = fakeSender();
    const report = await sweep(desk, sender);

    expect(report.sent).toBe(1);
    expect(sender.sent.map((m) => m.messageId)).toEqual([sendable.id]);
    // And the note is still a note: nothing stamped a delivery on it.
    expect((await readMessage(desk, conversationId, internal.id)).delivered_at).toBeNull();
  });

  it('a reply on a WIDGET conversation — the widget is already the delivery', async () => {
    const desk = world.substrat;
    const widget = await at(desk, 'widget');
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: desk.origin,
    })) as { sessionId: string; token: string };
    // The conversation exists from the first message, not from the opening.
    const asked = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: 'Hello from a browser.',
    })) as Message;

    const answered = await reply(desk, asked.conversation_id, 'Hello back.');

    const sender = fakeSender();
    const report = await sweep(desk, sender);

    expect(report.pending).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect((await readMessage(desk, asked.conversation_id, answered.id)).delivered_at).toBeNull();
  });
});

describe('a desk with no mail provider', () => {
  it('refuses loudly and leaves the message pending, rather than marking it delivered', async () => {
    const desk = world.substrat;
    const conversationId = await emailConversation(desk, 'Nowhere to send this');
    const waiting = await reply(desk, conversationId, 'Sent into the void.');

    const report = await sweep(desk, unconfiguredSender());
    expect(report.pending).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(0);
    // The whole point: the desk does not get to look answered.
    expect((await readMessage(desk, conversationId, waiting.id)).delivered_at).toBeNull();

    // …and the next sweep, with a provider, still finds it.
    const sender = fakeSender();
    expect((await sweep(desk, sender)).sent).toBe(1);
    expect(sender.sent[0]!.messageId).toBe(waiting.id);
  });

  it('is what an absent credential selects, so nothing has to remember to check', () => {
    expect(senderFor({}, () => Promise.reject(new Error('not called'))).name).toBe('unconfigured');
    expect(
      senderFor({ RESEND_API_KEY: 're_test' }, () => Promise.reject(new Error('not called'))).name,
    ).toBe('resend');
  });
});

describe('the provider seam, as Resend sees it', () => {
  const message: OutboundMessage = {
    messageId: 'M1',
    conversationId: 'C1',
    subject: 'Re: a question',
    toEmail: 'customer@example.com',
    fromAddress: 'support@desk.example',
    agentName: 'Robin',
    bodyText: 'Here you go.',
    bodyHtml: '<p>Here you go.</p>',
    emailInReplyTo: '<their-question@mail.example>',
  };

  /** Resend's two calls: accept the send, then say what it was actually sent as. */
  function fakeResend(retrieve: { ok: boolean; body: unknown }) {
    const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
    const fetchImpl = (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      });
      if (method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'abc123' }),
        } as never);
      }
      return Promise.resolve({
        ok: retrieve.ok,
        status: retrieve.ok ? 200 : 404,
        json: () => Promise.resolve(retrieve.body),
      } as never);
    };
    return { calls, fetchImpl };
  }

  it('threads the customer’s message and signs it with the agent’s name', async () => {
    const { calls, fetchImpl } = fakeResend({
      ok: true,
      body: { message_id: '<real-wire-id@desk.example>' },
    });
    await resendSender({ apiKey: 're_test', fetch: fetchImpl }).send(message);

    const posted = calls[0]!.body!;
    expect(posted['from']).toBe('Robin <support@desk.example>');
    expect(posted['to']).toEqual(['customer@example.com']);
    // Both headers, because a mail client reads one or the other depending on who
    // wrote it — a reply that carries neither starts a new thread in the customer's
    // inbox, which is the failure this whole seam exists to prevent.
    expect(posted['headers']).toEqual({
      'In-Reply-To': '<their-question@mail.example>',
      References: '<their-question@mail.example>',
    });
  });

  it('records the Message-ID that went out on the wire, never Resend’s own row id', async () => {
    const { calls, fetchImpl } = fakeResend({
      ok: true,
      body: { message_id: '<real-wire-id@desk.example>' },
    });
    const { emailMessageId } = await resendSender({ apiKey: 're_test', fetch: fetchImpl }).send(
      message,
    );

    // The retrieve is what the second call is FOR: `POST /emails` answers with Resend's
    // handle for the row, and an inbound `In-Reply-To` will never equal it. Recording
    // that instead would split every customer's reply into a new conversation, silently.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(calls[1]!.url).toMatch(/\/emails\/abc123$/);
    expect(emailMessageId).toBe('<real-wire-id@desk.example>');
    expect(emailMessageId).not.toContain('abc123');
  });

  it('still records a delivery when the retrieve comes back empty — sending twice is worse', async () => {
    const { fetchImpl } = fakeResend({ ok: false, body: {} });
    const { emailMessageId } = await resendSender({ apiKey: 're_test', fetch: fetchImpl }).send(
      message,
    );
    // The mail HAS gone. Throwing would leave the row pending and the next sweep would
    // send it again, so the provider's own id is recorded and the degradation logged.
    expect(emailMessageId).toBe('abc123');
  });

  it('refuses a send the provider accepted without naming anything at all', async () => {
    const sender = resendSender({
      apiKey: 're_test',
      fetch: () =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as never),
    });
    await expect(sender.send(message)).rejects.toThrow(/named no id/i);
  });

  it('says only the status when the provider refuses — an error body can quote the recipient', async () => {
    const sender = resendSender({
      apiKey: 're_test',
      fetch: () =>
        Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({ message: 'customer@example.com is suppressed' }),
        } as never),
    });
    await expect(sender.send(message)).rejects.toThrow(/HTTP 422/);
    await expect(sender.send(message)).rejects.not.toThrow(/customer@example\.com/);
  });

  it('bounds every provider call, so one stalled send cannot hold up the queue behind it', async () => {
    const signals: unknown[] = [];
    await resendSender({
      apiKey: 're_test',
      fetch: (_url, init) => {
        signals.push((init as { signal?: unknown } | undefined)?.signal);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'abc123', message_id: '<wire@desk.example>' }),
        } as never);
      },
      timeoutMs: 50,
    }).send(message);

    // Both of them: `sweepOutbound` sends serially, and the retrieve stalling would
    // block the queue exactly as the send stalling would.
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s !== undefined)).toBe(true);
  });
});
