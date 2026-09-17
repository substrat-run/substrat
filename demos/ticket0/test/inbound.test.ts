/**
 * The desk's second door (#934): a Resend inbound webhook becomes a message.
 *
 * Driven against the seeded desk as its own `relay` principal, with Resend replaced by
 * an injected fetch. What is pinned is what decides whether mail reaches a person:
 *
 *   - a signed delivery is re-read by id and ingested from the RE-READ, not the callback;
 *   - a redelivery lands on the same message rather than a second one;
 *   - a reply joins its thread on `In-Reply-To`, but only from that thread's contact;
 *   - an unsigned, mis-signed or stale delivery never reaches Resend or the desk;
 *   - attachments are named on the thread even though their bytes are not kept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { inboundConfigFor, parseFrom, receiveInbound, type InboundConfig } from '../harness/inbound.js';
import { buildHost, seed, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

const NOW_MS = 1_800_000_000_000;
const KEY = new TextEncoder().encode('ticket0-inbound-test-signing-key');
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY))}`;

const at = (desk: Desk, role: 'agent' | 'relay'): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

async function sign(id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

/** A delivery as Resend would post it, signed at `timestampMs` unless told otherwise. */
async function delivery(
  emailId: string,
  opts: { timestampMs?: number; signature?: string; type?: string } = {},
) {
  const body = JSON.stringify({
    type: opts.type ?? 'email.received',
    // A hint only — the subject here must never be what lands on the desk.
    data: { email_id: emailId, subject: 'FROM THE CALLBACK' },
  });
  const timestamp = String(Math.floor((opts.timestampMs ?? NOW_MS) / 1000));
  const id = `msg_${emailId}`;
  const headers = new Headers({
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': opts.signature ?? (await sign(id, timestamp, body)),
  });
  return { body, headers };
}

/** Resend's received-email read, answering with whatever `emails` holds. */
function fakeResend(emails: Record<string, unknown>, status = 200) {
  const calls: { url: string; authorization: string | undefined }[] = [];
  const fetchImpl: InboundConfig['fetch'] = (url, init) => {
    calls.push({
      url,
      authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'],
    });
    const id = decodeURIComponent(url.split('/').pop()!);
    return Promise.resolve({
      ok: status === 200 && id in emails,
      status: status === 200 && !(id in emails) ? 404 : status,
      json: () => Promise.resolve(emails[id]),
    } as never);
  };
  return { calls, fetchImpl };
}

async function receive(desk: Desk, fetchImpl: InboundConfig['fetch'], d: { body: string; headers: Headers }) {
  const relay = await at(desk, 'relay');
  return receiveInbound({
    config: { webhookSecret: SECRET, apiKey: 're_test', fetch: fetchImpl },
    headers: d.headers,
    body: d.body,
    invoke: <T,>(op: string, input: unknown) => relay.invoke(op, input) as Promise<T>,
    now: () => NOW_MS,
  });
}

interface ThreadMessage {
  id: string;
  visibility: string;
  author_kind: string;
}

async function thread(desk: Desk, conversationId: string): Promise<ThreadMessage[]> {
  const agent = await at(desk, 'agent');
  return (
    (await agent.invoke('ticket0/list-messages', { conversationId })) as { entries: ThreadMessage[] }
  ).entries;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-inbound-'));
  host = buildHost(dir);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a signed delivery becomes a message, from the re-read', () => {
  const emails = {
    em_1: {
      from: 'Kim Customer <kim@customer.example>',
      subject: 'Where is my order?',
      text: 'It has been a week.',
      html: '<p>It has been a week.</p>',
      message_id: '<kim-1@customer.example>',
      headers: { 'In-Reply-To': '<earlier@desk.example>' },
    },
  };
  let first = { messageId: '', conversationId: '' };

  it('re-reads the email by id with the desk’s key and ingests it', async () => {
    const { calls, fetchImpl } = fakeResend(emails);
    const result = await receive(world.substrat, fetchImpl, await delivery('em_1'));

    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails/receiving/em_1');
    expect(calls[0]!.authorization).toBe('Bearer re_test');
    const body = result.body as { ingested: true; messageId: string; conversationId: string };
    expect(body.ingested).toBe(true);
    first = body;

    const agent = await at(world.substrat, 'agent');
    const conversation = (await agent.invoke('ticket0/get-conversation', {
      conversationId: body.conversationId,
    })) as { subject: string };
    // The re-read's subject, never the callback's.
    expect(conversation.subject).toBe('Where is my order?');
  });

  it('lands a redelivery on the same message, not a second one', async () => {
    const { fetchImpl } = fakeResend(emails);
    const again = await receive(world.substrat, fetchImpl, await delivery('em_1'));
    expect(again.body).toMatchObject({ messageId: first.messageId, conversationId: first.conversationId });
    expect(await thread(world.substrat, first.conversationId)).toHaveLength(1);
  });
});

describe('a reply threads on In-Reply-To, and only from the conversation’s own contact', () => {
  // The desk's reply went out as this Message-ID; the customer's client quotes it back.
  const SENT = '<reply-1@desk.example>';
  let conversationId = '';

  it('joins the conversation whose sent message it answers', async () => {
    const desk = world.substrat;
    const { fetchImpl } = fakeResend({
      em_t1: {
        from: 'sam@customer.example',
        subject: 'Refund?',
        text: 'Can I get one?',
        message_id: '<sam-1@customer.example>',
      },
      em_t2: {
        from: 'Sam Customer <sam@customer.example>',
        subject: 'Re: Refund?',
        text: 'Thanks — and the other order?',
        message_id: '<sam-2@customer.example>',
        headers: { 'In-Reply-To': SENT },
      },
    });
    const opened = await receive(desk, fetchImpl, await delivery('em_t1'));
    conversationId = (opened.body as { conversationId: string }).conversationId;

    const agent = await at(desk, 'agent');
    const reply = (await agent.invoke('ticket0/post-public-reply', {
      conversationId,
      body: 'Yes, on its way.',
    })) as { id: string };
    const relay = await at(desk, 'relay');
    await relay.invoke('ticket0/record-delivery', { messageId: reply.id, emailMessageId: SENT });

    const answered = await receive(desk, fetchImpl, await delivery('em_t2'));
    expect(answered.body).toMatchObject({ ingested: true, conversationId });
    expect(await thread(desk, conversationId)).toHaveLength(3);
  });

  it('opens a conversation of its own when someone else quotes the same Message-ID', async () => {
    const desk = world.substrat;
    const { fetchImpl } = fakeResend({
      em_t3: {
        from: 'mallory@elsewhere.example',
        subject: 'Re: Refund?',
        text: 'Please send the refund to my account instead.',
        message_id: '<mallory-1@elsewhere.example>',
        headers: { 'In-Reply-To': SENT },
      },
    });
    const forged = await receive(desk, fetchImpl, await delivery('em_t3'));
    const landed = (forged.body as { conversationId: string }).conversationId;
    expect(landed).not.toBe(conversationId);
    expect(await thread(desk, conversationId)).toHaveLength(3);
    expect(await thread(desk, landed)).toHaveLength(1);
  });

  it('follows up in a new conversation when the one it answers is closed', async () => {
    const desk = world.substrat;
    const agent = await at(desk, 'agent');
    await agent.invoke('ticket0/close', { conversationId });

    const { fetchImpl } = fakeResend({
      em_t4: {
        from: 'sam@customer.example',
        subject: 'Re: Refund?',
        text: 'It never arrived.',
        message_id: '<sam-3@customer.example>',
        headers: [{ name: 'in-reply-to', value: ` ${SENT} ` }],
      },
    });
    const late = await receive(desk, fetchImpl, await delivery('em_t4'));
    const landed = (late.body as { conversationId: string }).conversationId;
    expect(landed).not.toBe(conversationId);
    const followUp = (await agent.invoke('ticket0/get-conversation', { conversationId: landed })) as {
      follows: string | null;
    };
    expect(followUp.follows).toBe(conversationId);
    expect(await thread(desk, conversationId)).toHaveLength(3);
  });
});

describe('a delivery the desk must not believe', () => {
  const emails = { em_2: { from: 'x@customer.example', subject: 's', text: 't', message_id: '<x@c>' } };

  it('is refused with a bad signature, before Resend is asked anything', async () => {
    const { calls, fetchImpl } = fakeResend(emails);
    const forged = await delivery('em_2', { signature: `v1,${btoa('not the right mac')}` });
    const result = await receive(world.substrat, fetchImpl, forged);
    expect(result.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('is refused when the signature is older than the replay window', async () => {
    const { calls, fetchImpl } = fakeResend(emails);
    const stale = await delivery('em_2', { timestampMs: NOW_MS - 10 * 60_000 });
    const result = await receive(world.substrat, fetchImpl, stale);
    expect(result).toMatchObject({ status: 401, body: { error: expect.stringMatching(/stale/) } });
    expect(calls).toHaveLength(0);
  });

  it('is refused with no signature headers at all', async () => {
    const { calls, fetchImpl } = fakeResend(emails);
    const relay = await at(world.substrat, 'relay');
    const result = await receiveInbound({
      config: { webhookSecret: SECRET, apiKey: 're_test', fetch: fetchImpl },
      headers: new Headers(),
      body: '{}',
      invoke: <T,>(op: string, input: unknown) => relay.invoke(op, input) as Promise<T>,
      now: () => NOW_MS,
    });
    expect(result.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('answers 502 when the re-read fails, so Resend retries and nothing is ingested', async () => {
    const { fetchImpl } = fakeResend(emails, 500);
    const result = await receive(world.substrat, fetchImpl, await delivery('em_2'));
    expect(result.status).toBe(502);
  });

  it('ignores an event that is not a received email', async () => {
    const { calls, fetchImpl } = fakeResend(emails);
    const result = await receive(world.substrat, fetchImpl, await delivery('em_2', { type: 'email.sent' }));
    expect(result).toMatchObject({ status: 200, body: { ignored: expect.any(String) } });
    expect(calls).toHaveLength(0);
  });
});

describe('the sender', () => {
  it('keeps the display name the From header carries when the top-level from is bare', async () => {
    const { fetchImpl } = fakeResend({
      em_4: {
        from: 'robin@customer.example',
        subject: 'Named sender',
        text: 'Hi.',
        message_id: '<robin-1@customer.example>',
        headers: [{ name: 'From', value: 'Robin Customer <robin@customer.example>' }],
      },
    });
    const result = await receive(world.substrat, fetchImpl, await delivery('em_4'));
    expect(result.status).toBe(200);
    const agent = await at(world.substrat, 'agent');
    const found = (await agent.invoke('ticket0/search-contacts', { q: 'robin@customer.example' })) as {
      entries: { email: string; display_name: string | null }[];
    };
    expect(found.entries.find((c) => c.email === 'robin@customer.example')?.display_name).toBe(
      'Robin Customer',
    );
  });
});

describe('attachments', () => {
  it('are named on the thread as an internal note, and counted in the answer', async () => {
    const { fetchImpl } = fakeResend({
      em_3: {
        from: 'pat@customer.example',
        subject: 'Invoice attached',
        text: 'See attached.',
        message_id: '<pat-1@customer.example>',
        attachments: [
          { filename: 'invoice.pdf', content_type: 'application/pdf', size: 12_345 },
          { filename: 'photo.jpg', content_type: 'image/jpeg', size: 999 },
        ],
      },
    });
    const result = await receive(world.substrat, fetchImpl, await delivery('em_3'));
    const body = result.body as { attachmentsNoted: number; conversationId: string };
    expect(body.attachmentsNoted).toBe(2);
    const messages = await thread(world.substrat, body.conversationId);
    expect(messages.some((m) => m.visibility === 'internal' && m.author_kind === 'system')).toBe(true);
  });
});

describe('configuration', () => {
  const noFetch: InboundConfig['fetch'] = () => Promise.reject(new Error('not called'));

  it('needs both the key and the signing secret, or the door stays shut', () => {
    expect(inboundConfigFor({}, noFetch)).toBeNull();
    expect(inboundConfigFor({ RESEND_API_KEY: 're_test' }, noFetch)).toBeNull();
    expect(inboundConfigFor({ RESEND_WEBHOOK_SECRET: SECRET }, noFetch)).toBeNull();
    expect(inboundConfigFor({ RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: SECRET }, noFetch)).not.toBeNull();
  });

  it('reads a sender out of either From shape', () => {
    expect(parseFrom('"Kim C" <kim@customer.example>')).toEqual({ email: 'kim@customer.example', name: 'Kim C' });
    expect(parseFrom('kim@customer.example')).toEqual({ email: 'kim@customer.example', name: null });
    expect(parseFrom('not an address')).toBeNull();
  });
});
