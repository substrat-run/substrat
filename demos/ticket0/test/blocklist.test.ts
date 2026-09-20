/**
 * The desk's blocklist (#1088) — refusing a named sender at both public doors.
 *
 * ticket0 has two doors anybody on the internet may knock on: the widget routes and an
 * inbox address. Until this, the only remedy against a specific abuser was taking the
 * origin out of `allowed_origins`, which takes the widget down for a whole customer's
 * site, or nothing at all for email. This suite is about the refusal, not the matcher:
 * every case drives a real operation as the principal that door actually runs as — the
 * desk's `relay` for mail, its `widget` service for the bubble — so a check wired into
 * the wrong place fails here rather than passing a unit test of `blockedBy`.
 *
 * What it pins, in the order it matters:
 *
 *   - a blocked address is refused BEFORE anything is written: no contact, no
 *     conversation, no message. That is the cost argument in the issue — junk a human
 *     would delete in a second is junk the desk has already paid inference on;
 *   - an unblocked sender still gets through, on the same code path in the same run;
 *   - a domain rule covers its sub-domains, which is the shape throwaway mail takes;
 *   - removing ONE rule leaves the others in force — the whole reason this is a table
 *     and not a JSON column on the desk row;
 *   - a blocked mail answers Resend 200 rather than asking it to retry a delivery this
 *     desk will never accept.
 *
 * Every address here is invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CountedPage } from '@substrat-run/contracts';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { receiveInbound, type InboundConfig } from '../harness/inbound.js';
import { SENDER_BLOCKED } from '../src/module.js';
import { buildHost, seed, signIdentity, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let desk: Desk;

const NOW_MS = 1_800_000_000_000;
const KEY = new TextEncoder().encode('ticket0-blocklist-test-signing-key');
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY))}`;

type Role = 'admin' | 'agent' | 'relay' | 'widget';
const at = (role: Role): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

interface BlockRule {
  id: string;
  kind: 'email' | 'domain' | 'contact';
  value: string;
  reason: string | null;
  created_by: string;
  created_at: string;
}

/** Block something, as the one role that holds `desk:configure`. */
async function block(
  kind: BlockRule['kind'],
  value: string,
  reason?: string,
): Promise<BlockRule> {
  const admin = await at('admin');
  return (await admin.invoke('ticket0/add-block-rule', {
    kind,
    value,
    ...(reason === undefined ? {} : { reason }),
  })) as BlockRule;
}

async function unblock(ruleId: string): Promise<{ id: string; kind: string }> {
  const admin = await at('admin');
  return (await admin.invoke('ticket0/remove-block-rule', { ruleId })) as {
    id: string;
    kind: string;
  };
}

async function rules(kind?: BlockRule['kind']): Promise<CountedPage<BlockRule>> {
  const admin = await at('admin');
  return (await admin.invoke(
    'ticket0/list-block-rules',
    kind ? { kind } : {},
  )) as CountedPage<BlockRule>;
}

/** Mail arriving at the desk, as the relay presents it. */
async function mailFrom(
  email: string,
  opts: { messageId?: string; body?: string } = {},
): Promise<{ id: string; conversation_id: string }> {
  const relay = await at('relay');
  return (await relay.invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: email,
    contactName: null,
    subject: 'Hello',
    bodyText: opts.body ?? 'Is anybody there?',
    emailMessageId: opts.messageId ?? `<${email}-${Math.random()}@mail.example>`,
  })) as { id: string; conversation_id: string };
}

/**
 * How many rows a table holds right now.
 *
 * Read straight out of the scope's store, because the claim under test is that NOTHING
 * was written — and an operation-level list read can only show what its own permission
 * reaches, which is a weaker statement than the one being made.
 */
function rowCount(table: string): number {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  db.close();
  return row.n;
}

function outboxCount(type: string): number {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
  const row = db.prepare('SELECT COUNT(*) AS n FROM _substrat_outbox WHERE type = ?').get(type) as {
    n: number;
  };
  db.close();
  return row.n;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-blocklist-'));
  host = buildHost(dir);
  world = await seed(host);
  // Kestrel, deliberately: the supervised desk carries no story the other suites read,
  // so blocking people in it cannot make a scenario assertion depend on this file.
  desk = world.kestrel;
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('an address on the blocklist never reaches the desk', () => {
  it('refuses the mail, and writes nothing at all', async () => {
    const rule = await block('email', 'spam@blocked.example', 'sent the same thing nine times');
    expect(rule.value).toBe('spam@blocked.example');
    expect(rule.created_by).toBe(String(desk.admin.principal));

    const contacts = rowCount('ticket0_contacts');
    const conversations = rowCount('ticket0_conversations');
    const messages = rowCount('ticket0_messages');

    await expect(mailFrom('spam@blocked.example')).rejects.toThrow(SENDER_BLOCKED);

    // The cost argument, as an assertion: the refusal happens before the desk has
    // spent a row on them, let alone a model call.
    expect(rowCount('ticket0_contacts')).toBe(contacts);
    expect(rowCount('ticket0_conversations')).toBe(conversations);
    expect(rowCount('ticket0_messages')).toBe(messages);

    await unblock(rule.id);
  });

  it('lets everybody else through on the same path, in the same run', async () => {
    const rule = await block('email', 'spam@blocked.example');

    await expect(mailFrom('spam@blocked.example')).rejects.toThrow(SENDER_BLOCKED);
    const welcome = await mailFrom('real@customer.example');
    expect(welcome.conversation_id).toBeTruthy();

    await unblock(rule.id);
  });

  it('keys on the address rather than on its capitals', async () => {
    const rule = await block('email', 'Loud.Sender@Blocked.Example');
    expect(rule.value).toBe('loud.sender@blocked.example');

    await expect(mailFrom('LOUD.SENDER@blocked.example')).rejects.toThrow(SENDER_BLOCKED);

    await unblock(rule.id);
  });
});

describe('a domain rule covers the addresses behind it', () => {
  it('refuses the domain itself and every sub-domain of it', async () => {
    const rule = await block('domain', '@throwaway.example');
    expect(rule.value).toBe('throwaway.example');

    await expect(mailFrom('one@throwaway.example')).rejects.toThrow(SENDER_BLOCKED);
    await expect(mailFrom('two@mail.throwaway.example')).rejects.toThrow(SENDER_BLOCKED);

    // And stops there. A rule is about a domain, not about a string that ends the
    // same way — `notthrowaway.example` is somebody else entirely.
    const other = await mailFrom('three@notthrowaway.example');
    expect(other.conversation_id).toBeTruthy();

    await unblock(rule.id);
  });

  it('refuses a domain that is not one', async () => {
    await expect(block('domain', 'not a domain')).rejects.toThrow(/is not a domain/);
  });
});

describe('the widget door', () => {
  it('refuses a vouched visitor whose address is blocked, before a session exists', async () => {
    const rule = await block('email', 'nuisance@blocked.example');
    const widget = await at('widget');
    const openings = rowCount('ticket0_widget_openings');

    await expect(
      widget.invoke('ticket0/widget-start', {
        origin: desk.origin,
        identity: {
          externalId: 'nuisance@blocked.example',
          email: 'nuisance@blocked.example',
          signature: await signIdentity(desk.verificationSecret, 'nuisance@blocked.example'),
        },
      }),
    ).rejects.toThrow(SENDER_BLOCKED);

    // No session, so nothing for them to hold and nothing to reap.
    expect(rowCount('ticket0_widget_openings')).toBe(openings);

    await unblock(rule.id);
  });

  it('refuses an anonymous visitor from their second message, once there is a contact', async () => {
    const widget = await at('widget');
    const agent = await at('agent');
    const started = (await widget.invoke('ticket0/widget-start', { origin: desk.origin })) as {
      sessionId: string;
      token: string;
    };

    // The first message is what creates their contact — nothing exists to block before
    // it, which is the honest limit of this table and the rate limiter's job instead.
    const first = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: 'first',
    })) as { conversation_id: string };

    const conversation = (await agent.invoke('ticket0/get-conversation', {
      conversationId: first.conversation_id,
    })) as { contact_id: string };
    const rule = await block('contact', conversation.contact_id, 'abusive in the chat');

    const messages = rowCount('ticket0_messages');
    await expect(
      widget.invoke('ticket0/widget-post', {
        sessionId: started.sessionId,
        token: started.token,
        body: 'second',
      }),
    ).rejects.toThrow(SENDER_BLOCKED);
    expect(rowCount('ticket0_messages')).toBe(messages);

    // The handoff door is the same visitor asking the same desk, and it writes two
    // messages and notifies the staff — so it must refuse them too.
    await expect(
      widget.invoke('ticket0/request-human', {
        sessionId: started.sessionId,
        token: started.token,
        body: 'let me talk to someone',
      }),
    ).rejects.toThrow(SENDER_BLOCKED);

    // Unblocked, the same session resumes — the rule was about the person, and their
    // token was never the thing that was taken away.
    await unblock(rule.id);
    const after = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: 'third',
    })) as { id: string };
    expect(after.id).toBeTruthy();
  });

  it('a contact rule is not evadable by one capital letter', async () => {
    const agent = await at('agent');
    // The person appears through email, so the desk has a contact for them.
    const first = await mailFrom('shouty@customer.example');
    const conversation = (await agent.invoke('ticket0/get-conversation', {
      conversationId: first.conversation_id,
    })) as { contact_id: string };
    const rule = await block('contact', conversation.contact_id);

    // `contactByEmail` matches exactly, so this address resolves to NO contact and
    // would otherwise open a second one — carrying the same person past a rule an
    // agent added about them.
    await expect(mailFrom('SHOUTY@customer.example')).rejects.toThrow(SENDER_BLOCKED);
    await expect(mailFrom('shouty@customer.example')).rejects.toThrow(SENDER_BLOCKED);

    await unblock(rule.id);
  });

  it('refuses a rule naming a contact that does not exist', async () => {
    await expect(block('contact', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toThrow(/contact not/);
  });
});

describe('the list is rules, not a blob', () => {
  it('removing one leaves the others in force', async () => {
    const one = await block('email', 'first@blocked.example');
    const two = await block('email', 'second@blocked.example');
    const three = await block('domain', 'third.example');

    await unblock(two.id);

    // The two that were not removed still refuse, which is the property a JSON column
    // could not hold: removing one entry there is a rewrite of the whole set.
    await expect(mailFrom('first@blocked.example')).rejects.toThrow(SENDER_BLOCKED);
    await expect(mailFrom('anyone@third.example')).rejects.toThrow(SENDER_BLOCKED);
    const back = await mailFrom('second@blocked.example');
    expect(back.conversation_id).toBeTruthy();

    const left = await rules();
    const values = left.entries.map((r) => r.value);
    expect(values).toContain('first@blocked.example');
    expect(values).toContain('third.example');
    expect(values).not.toContain('second@blocked.example');

    await unblock(one.id);
    await unblock(three.id);
  });

  it('blocking the same address twice is one rule and one event', async () => {
    const before = outboxCount('ticket0.block-rule-added');
    const first = await block('email', 'twice@blocked.example', 'the first reason');
    const again = await block('email', 'TWICE@blocked.example', 'a different reason');

    expect(again.id).toBe(first.id);
    // The decision, and who made it, belongs to whoever made it first.
    expect(again.reason).toBe('the first reason');
    expect(outboxCount('ticket0.block-rule-added')).toBe(before + 1);
    expect((await rules('email')).entries.filter((r) => r.value === 'twice@blocked.example'))
      .toHaveLength(1);

    await unblock(first.id);
  });

  it('is filterable by kind, and counts', async () => {
    const one = await block('email', 'filtered@blocked.example');
    const two = await block('domain', 'filtered.example');

    const emails = await rules('email');
    expect(emails.entries.every((r) => r.kind === 'email')).toBe(true);
    expect(emails.entries.map((r) => r.value)).toContain('filtered@blocked.example');
    expect(emails.entries.map((r) => r.value)).not.toContain('filtered.example');
    expect(emails.total).toBe(emails.entries.length);

    await unblock(one.id);
    await unblock(two.id);
  });

  it('refuses to remove a rule that is not there', async () => {
    await expect(unblock('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toThrow(/block rule not found/);
  });
});

describe('a blocked mail stops the retries rather than starting them', () => {
  /** A Resend webhook delivery, signed the way `receiveInbound` insists on. */
  async function delivery(emailId: string) {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: emailId } });
    const timestamp = String(Math.floor(NOW_MS / 1000));
    const id = `msg_${emailId}`;
    const key = await crypto.subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
    );
    return {
      body,
      headers: new Headers({
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
      }),
    };
  }

  const received = {
    em_blocked: {
      from: 'Nobody <flood@blocked.example>',
      subject: 'buy things',
      text: 'buy things',
      message_id: '<flood-1@blocked.example>',
    },
  };

  const fetchImpl: InboundConfig['fetch'] = (url) => {
    const id = decodeURIComponent(url.split('/').pop()!);
    return Promise.resolve({
      ok: id in received,
      status: id in received ? 200 : 404,
      json: () => Promise.resolve(received[id as keyof typeof received]),
    } as never);
  };

  it('answers 200 with a reason, so the provider does not try the same mail again', async () => {
    const rule = await block('domain', 'blocked.example');
    const relay = await at('relay');
    const d = await delivery('em_blocked');

    const result = await receiveInbound({
      config: { webhookSecret: SECRET, apiKey: 're_test', fetch: fetchImpl },
      headers: d.headers,
      body: d.body,
      invoke: <T,>(op: string, input: unknown) => relay.invoke(op, input) as Promise<T>,
      now: () => NOW_MS,
    });

    // 2xx is this receiver's own word for "never bring this back". A 5xx here would
    // ask Resend to redeliver a mail whose refusal is a standing decision.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ignored: 'the sending address is blocked at this desk' });

    await unblock(rule.id);
  });
});
