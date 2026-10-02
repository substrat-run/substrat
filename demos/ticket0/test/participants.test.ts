/**
 * Somebody else on a conversation (#1086): CCs on the customer's thread, a third party on
 * a side thread, and who may put either there.
 *
 * Every desk here is fresh (`desk-kit.ts`), because the claims are about exactly who is on
 * one conversation and exactly which reads return one message — a shared world would make
 * each of them a fact about whichever test ran first.
 *
 * The properties, each with its twin:
 *
 *  - WHO CAN CALL. Putting an address on a conversation is `conversation:forward`: an
 *    agent may, the assistant trusted to answer the customer may not, and nor may a
 *    follower. Reading who is on it is the read of the thread: a follower may, for the
 *    thread they follow and no other.
 *  - CC. A mail's To and Cc become CCs when somebody on the customer's thread sent it, and
 *    never the desk, the sender, a blocked sender or a bad address; a CC's reply joins the
 *    thread; every public reply is copied to them; taking them off stops it.
 *  - FORWARD. A forward and the third party's answer are `forward`: the desk reads them,
 *    and no read a customer can reach ever returns them — not the widget, not the portal,
 *    not the mail, not the assistant's transcript.
 *  - PORTAL. A CC who signs in reads the thread's public messages; taken off, they read
 *    nothing; a third party reads nothing ever; only the requester rates it.
 *  - LIFECYCLE. Merge moves them, a follow-up carries the CCs, a discard deletes them and
 *    the contacts the junk alone brought in.
 *  - MIGRATION 0022. An existing desk upgrades to exactly a fresh desk's indexes, keeps
 *    every row, and then accepts the third visibility.
 */
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { priorMessages } from '../harness/assistant.js';
import { ticket0Manifest } from '../src/manifest.js';
import { HANDED_TO_A_PERSON, ORPHAN_CONTACTS_DELETE } from '../src/module.js';
import { MODULES } from '../src/provision.js';
import { PARTICIPANTS_MAX } from '../spec/model.js';
import { createKit, type Desk } from './desk-kit.js';

const kit = createKit('ticket0-participants-');
afterAll(() => kit.dispose());

const actor = platformActorId.parse(ulid());
const DESK_ADDRESS = 'support@example.com';

interface Message {
  id: string;
  conversation_id: string;
  author_kind: string;
  visibility: string;
  body_text: string;
  author_contact_id: string | null;
  third_party_contact_id: string | null;
}
interface Participant {
  role: string;
  contact_id: string | null;
  principal: string | null;
}
interface Outbound {
  toEmail: string | null;
  ccEmails: string[];
  visibility: string;
  subject: string;
}

let mails = 0;

/** A mail arriving, with every header the relay passes. */
async function mail(
  desk: Desk,
  opts: { from: string; to?: string[]; cc?: string[]; inReplyTo?: string; body?: string; subject?: string; into?: string },
): Promise<Message> {
  kit.clock.advance(60_000);
  mails += 1;
  return (await (await kit.as(desk, desk.relay)).invoke('ticket0/ingest-message', {
    conversationId: opts.into ?? null,
    contactEmail: opts.from,
    contactName: null,
    subject: opts.subject ?? `Question ${mails}`,
    bodyText: opts.body ?? 'Something is not working.',
    emailMessageId: `<participants-${mails}@mail.example>`,
    emailInReplyTo: opts.inReplyTo ?? null,
    ...(opts.to ? { to: opts.to } : {}),
    ...(opts.cc ? { cc: opts.cc } : {}),
  })) as Message;
}

/** The Message-ID a mail was ingested under. */
const messageIdOf = (desk: Desk, id: string): string =>
  kit.sql(desk, (db) => (db.prepare('SELECT email_message_id AS m FROM ticket0_messages WHERE id = ?').get(id) as { m: string }).m);

const contactIdOf = (desk: Desk, email: string): string | undefined =>
  kit.sql(desk, (db) => (db.prepare('SELECT id FROM ticket0_contacts WHERE email = ?').get(email) as { id: string } | undefined)?.id);

async function participants(desk: Desk, conversationId: string, who: PrincipalId = desk.admin): Promise<Participant[]> {
  return ((await (await kit.as(desk, who)).invoke('ticket0/list-participants', { conversationId })) as {
    participants: Participant[];
  }).participants;
}

/** CC addresses on a conversation, as the address book would show them. */
async function ccs(desk: Desk, conversationId: string): Promise<string[]> {
  const rows = (await participants(desk, conversationId)).filter((p) => p.role === 'cc');
  return kit.sql(desk, (db) =>
    rows.map((p) => (db.prepare('SELECT email FROM ticket0_contacts WHERE id = ?').get(p.contact_id) as { email: string }).email).sort(),
  );
}

async function staffMessages(desk: Desk, conversationId: string): Promise<Message[]> {
  return ((await (await kit.as(desk, desk.admin)).invoke('ticket0/list-messages', { conversationId, limit: 100 })) as Page<Message>)
    .entries;
}

async function readOutbound(desk: Desk, messageId: string): Promise<Outbound> {
  return (await (await kit.as(desk, desk.relay)).invoke('ticket0/read-outbound', { messageId })) as Outbound;
}

async function pending(desk: Desk): Promise<string[]> {
  return ((await (await kit.as(desk, desk.relay)).invoke('ticket0/list-pending-outbound', { limit: 100 })) as Page<{
    messageId: string;
  }>).entries.map((r) => r.messageId);
}

/** A person with no role, holding one portal grant: `conversation:read-own` on one contact. */
async function portalFor(desk: Desk, contactId: string): Promise<PrincipalId> {
  const p = principalId.parse(ulid());
  await kit.host.admin.grant(actor, {
    principalId: p,
    permission: permissionKey.parse('conversation:read-own'),
    node: { tenantId: desk.tenant, scopeId: desk.scope },
    entity: { entityType: 'contact', entityId: contactId },
    grantedBy: desk.admin,
  });
  return p;
}

async function myConversations(desk: Desk, who: PrincipalId): Promise<string[]> {
  return ((await (await kit.as(desk, who)).invoke('ticket0/my-conversations', { limit: 100 })) as Page<{ id: string }>).entries.map(
    (c) => c.id,
  );
}

async function role(desk: Desk, roleKey: string): Promise<PrincipalId> {
  const p = principalId.parse(ulid());
  await kit.host.admin.assignRole(actor, { principalId: p, roleKey, node: { tenantId: desk.tenant, scopeId: desk.scope } });
  return p;
}

describe('who may put an address on a conversation, and who may see who is on it', () => {
  it('an agent may add, forward and remove; the autonomous assistant and a follower may do none of it', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    const agent = await kit.as(d, d.agents[0]!);
    const conversationId = (await mail(d, { from: 'customer@customer.example' })).conversation_id;

    // The assistant trusted to answer the customer holds reply-public, and not this.
    const autonomous = await kit.as(d, await role(d, 'assistant-autonomous'));
    await expect(autonomous.invoke('ticket0/add-participant', { conversationId, email: 'x@customer.example' })).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      autonomous.invoke('ticket0/forward-message', { conversationId, to: 'x@vendor.example', body: 'Hi' }),
    ).rejects.toThrow(/permission denied/i);
    await expect(autonomous.invoke('ticket0/remove-participant', { conversationId, contactId: 'anyone' })).rejects.toThrow(
      /permission denied/i,
    );

    // A follower reads the thread and nothing else: not a door to who receives it.
    const guest = await kit.guest(d);
    await agent.invoke('ticket0/follow-conversation', { conversationId, follower: guest });
    const follower = await kit.as(d, guest);
    await expect(follower.invoke('ticket0/add-participant', { conversationId, email: 'x@customer.example' })).rejects.toThrow(
      /permission denied/i,
    );

    // The positive twin: the same three calls, as an agent.
    const added = (await agent.invoke('ticket0/add-participant', { conversationId, email: 'cc@customer.example' })) as {
      contact_id: string;
      role: string;
      added_by: string;
    };
    expect(added).toMatchObject({ role: 'cc', added_by: d.agents[0] });
    await agent.invoke('ticket0/forward-message', { conversationId, to: 'supplier@vendor.example', body: 'Seen this?' });
    expect(await agent.invoke('ticket0/remove-participant', { conversationId, contactId: added.contact_id })).toEqual({
      conversation_id: conversationId,
      contact_id: added.contact_id,
      removed: true,
    });
  });

  it('a follower lists who is on the thread they follow, and is refused on any other; a customer is refused', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    const agent = await kit.as(d, d.agents[0]!);
    const followed = (await mail(d, { from: 'one@customer.example', cc: ['two@customer.example'] })).conversation_id;
    const other = (await mail(d, { from: 'three@customer.example' })).conversation_id;
    const guest = await kit.guest(d);
    await agent.invoke('ticket0/follow-conversation', { conversationId: followed, follower: guest });

    const seen = await participants(d, followed, guest);
    expect(seen.map((p) => p.role)).toEqual(['requester', 'cc', 'follower']);
    expect(seen.find((p) => p.role === 'follower')?.principal).toBe(guest);
    // Ids only: no row in the answer carries an address or a name.
    expect(JSON.stringify(seen)).not.toMatch(/@/);
    await expect(participants(d, other, guest)).rejects.toThrow(/permission denied/i);

    const customer = await portalFor(d, contactIdOf(d, 'one@customer.example')!);
    await expect(participants(d, followed, customer)).rejects.toThrow(/permission denied/i);

    // And the address behind an id is the directory's read: an agent's, not a follower's.
    const cc = seen.find((p) => p.role === 'cc')!.contact_id!;
    expect(await agent.invoke('ticket0/get-contact', { contactId: cc })).toMatchObject({ email: 'two@customer.example' });
    await expect((await kit.as(d, guest)).invoke('ticket0/get-contact', { contactId: cc })).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('CC — captured from the mail, copied on the reply', () => {
  it('copies in To and Cc, and never the desk, the sender, a bad address or a blocked sender', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await (await kit.as(d, d.admin)).invoke('ticket0/add-block-rule', { kind: 'domain', value: 'junk.example' });
    const m = await mail(d, {
      from: 'ana@customer.example',
      // The desk in any case is still the desk.
      to: [DESK_ADDRESS.toUpperCase(), 'bo@customer.example'],
      cc: ['cy@customer.example', 'not an address', 'ana@customer.example', 'spam@junk.example', 'bo@customer.example'],
    });
    expect(await ccs(d, m.conversation_id)).toEqual(['bo@customer.example', 'cy@customer.example']);
    // Each announced, with ids and never an address.
    const added = kit.events(d, 'ticket0.participant-added', m.conversation_id);
    expect(added).toHaveLength(2);
    for (const e of added) {
      expect(Object.keys(JSON.parse(e.payload)).sort()).toEqual(['added_by', 'contact_id', 'conversation_id', 'id', 'role']);
      expect(e.payload).not.toMatch(/@/);
      expect(e.operation).toBe('ticket0/ingest-message');
    }
  });

  it('keeps at most PARTICIPANTS_MAX of a long list, and still takes the mail', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const many = Array.from({ length: PARTICIPANTS_MAX + 5 }, (_, i) => `person-${i}@customer.example`);
    const m = await mail(d, { from: 'lead@customer.example', cc: many, body: 'All of you, look.' });
    expect(await ccs(d, m.conversation_id)).toHaveLength(PARTICIPANTS_MAX);
    expect((await staffMessages(d, m.conversation_id)).map((x) => x.body_text)).toContain('All of you, look.');
  });

  it('a CC replying joins the thread as themselves; a stranger quoting the same Message-ID does not', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const first = await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] });
    const header = messageIdOf(d, first.id);

    const fromCc = await mail(d, { from: 'bo@customer.example', inReplyTo: header, body: 'Same here.', cc: ['di@customer.example'] });
    expect(fromCc.conversation_id).toBe(first.conversation_id);
    expect(fromCc).toMatchObject({ visibility: 'public', author_contact_id: contactIdOf(d, 'bo@customer.example') });
    // A reply-all from somebody on the thread copies in who they copied in.
    expect(await ccs(d, first.conversation_id)).toEqual(['bo@customer.example', 'di@customer.example']);

    const stranger = await mail(d, { from: 'eve@elsewhere.example', inReplyTo: header });
    expect(stranger.conversation_id).not.toBe(first.conversation_id);
    // Nor can a stranger put themselves on it by naming it in a header.
    expect(await ccs(d, first.conversation_id)).toEqual(['bo@customer.example', 'di@customer.example']);
  });

  it('a public reply is copied to every CC; taken off, a CC is copied on nothing more', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const first = await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example', 'cy@customer.example'] });
    const reply = (await admin.invoke('ticket0/post-public-reply', { conversationId: first.conversation_id, body: 'On it.' })) as Message;
    expect(await readOutbound(d, reply.id)).toMatchObject({
      toEmail: 'ana@customer.example',
      ccEmails: ['bo@customer.example', 'cy@customer.example'],
      visibility: 'public',
    });

    const cy = contactIdOf(d, 'cy@customer.example')!;
    await admin.invoke('ticket0/remove-participant', { conversationId: first.conversation_id, contactId: cy });
    const next = (await admin.invoke('ticket0/post-public-reply', { conversationId: first.conversation_id, body: 'Done.' })) as Message;
    expect((await readOutbound(d, next.id)).ccEmails).toEqual(['bo@customer.example']);
    // Removing somebody not on it is a no-op that says so; the requester cannot be removed.
    expect(await admin.invoke('ticket0/remove-participant', { conversationId: first.conversation_id, contactId: cy })).toMatchObject({
      removed: false,
    });
    const requester = contactIdOf(d, 'ana@customer.example')!;
    await expect(
      admin.invoke('ticket0/remove-participant', { conversationId: first.conversation_id, contactId: requester }),
    ).rejects.toThrow(/cannot be taken off/);
  });

  it('a person adds a CC once, and is refused the desk, a blocked sender, the requester and a full thread', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    await admin.invoke('ticket0/add-block-rule', { kind: 'email', value: 'spam@junk.example' });
    const conversationId = (await mail(d, { from: 'ana@customer.example' })).conversation_id;
    const add = (email: string) => admin.invoke('ticket0/add-participant', { conversationId, email });

    const once = (await add('bo@customer.example')) as { id: string };
    expect(((await add('bo@customer.example')) as { id: string }).id).toBe(once.id);
    expect(kit.events(d, 'ticket0.participant-added', conversationId)).toHaveLength(1);

    await expect(add(DESK_ADDRESS)).rejects.toThrow(/own address/);
    await expect(add('spam@junk.example')).rejects.toThrow(/blocks that sender/);
    await expect(add('ana@customer.example')).rejects.toThrow(/already on it/);
    for (let i = 1; i < PARTICIPANTS_MAX; i++) await add(`p${i}@customer.example`);
    await expect(add('one-too-many@customer.example')).rejects.toThrow(new RegExp(`at most ${PARTICIPANTS_MAX}`));
  });
});

describe('forward — a side thread the customer never reads', () => {
  it('goes to the third party alone, and their answer lands on the thread as forward', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const relay = await kit.as(d, d.relay);
    const first = await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] });
    const conversationId = first.conversation_id;

    const sent = (await admin.invoke('ticket0/forward-message', {
      conversationId,
      to: 'supplier@vendor.example',
      body: 'Is part 42 back in stock?',
    })) as Message;
    const supplier = contactIdOf(d, 'supplier@vendor.example')!;
    expect(sent).toMatchObject({ visibility: 'forward', author_kind: 'agent', third_party_contact_id: supplier });
    expect((await participants(d, conversationId)).find((p) => p.contact_id === supplier)?.role).toBe('third-party');
    expect(await pending(d)).toContain(sent.id);
    expect(await readOutbound(d, sent.id)).toMatchObject({
      toEmail: 'supplier@vendor.example',
      ccEmails: [],
      visibility: 'forward',
    });
    // And a reply on the customer's thread never copies the third party.
    const reply = (await admin.invoke('ticket0/post-public-reply', { conversationId, body: 'Checking.' })) as Message;
    expect(await readOutbound(d, reply.id)).toMatchObject({ toEmail: 'ana@customer.example', ccEmails: ['bo@customer.example'] });

    await relay.invoke('ticket0/record-delivery', { messageId: sent.id, emailMessageId: '<forward-1@desk.example>' });
    const answer = await mail(d, {
      from: 'supplier@vendor.example',
      inReplyTo: '<forward-1@desk.example>',
      body: 'Back in stock Friday.',
      cc: ['boss@vendor.example'],
    });
    expect(answer).toMatchObject({
      conversation_id: conversationId,
      visibility: 'forward',
      author_kind: 'contact',
      author_contact_id: supplier,
      third_party_contact_id: supplier,
    });
    // A third party's recipients are theirs: nobody is copied onto the customer's thread.
    expect(await ccs(d, conversationId)).toEqual(['bo@customer.example']);
    // The event says which audience it was written to.
    expect(JSON.parse(kit.events(d, 'ticket0.message-ingested', answer.id)[0]!.payload)).toMatchObject({ visibility: 'forward' });
  });

  it('no read a customer can reach returns a forward or the answer to one', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const relay = await kit.as(d, d.relay);
    const SECRET = 'SUPPLIER-ONLY-PRICING';
    // On a widget conversation, so the visitor's own thread is one of the reads.
    const chat = await kit.chat(d, 'Where is my order? It is late.');
    const conversationId = chat.conversationId;
    const sent = (await admin.invoke('ticket0/forward-message', {
      conversationId,
      to: 'supplier@vendor.example',
      body: `Ask: ${SECRET}`,
    })) as Message;
    // A forward is always mail, whatever channel the conversation is on.
    expect(await pending(d)).toContain(sent.id);
    await relay.invoke('ticket0/record-delivery', { messageId: sent.id, emailMessageId: '<fw-widget@desk.example>' });
    await mail(d, { from: 'supplier@vendor.example', inReplyTo: '<fw-widget@desk.example>', body: `Answer: ${SECRET}` });

    // The desk reads both.
    expect((await staffMessages(d, conversationId)).filter((m) => m.body_text.includes(SECRET))).toHaveLength(2);

    // The widget.
    const thread = (await (await kit.as(d, d.widget)).invoke('ticket0/widget-thread', {
      sessionId: chat.sessionId,
      token: chat.token,
    })) as Page<Record<string, unknown>>;
    expect(JSON.stringify(thread)).not.toContain(SECRET);
    // Nor any id of another person on it: the customer shape drops them.
    for (const row of thread.entries) {
      expect(row).not.toHaveProperty('author_contact_id');
      expect(row).not.toHaveProperty('third_party_contact_id');
    }
    // The portal.
    const requester = (await kit.read(d, conversationId)).contact_id;
    const portal = await kit.as(d, await portalFor(d, requester));
    expect(JSON.stringify(await portal.invoke('ticket0/my-messages', { conversationId }))).not.toContain(SECRET);
    // The assistant's transcript, which is what the customer could be told.
    const transcript = await priorMessages(admin, conversationId, 'not-a-message-in-this-thread');
    expect(JSON.stringify(transcript)).not.toContain(SECRET);
    const last = (await staffMessages(d, conversationId)).at(-1)!;
    expect(JSON.stringify(await priorMessages(admin, conversationId, last.id))).not.toContain(SECRET);
    // The mail: a forward is never read out as the customer's.
    const replies = (await staffMessages(d, conversationId)).filter((m) => m.visibility === 'forward');
    for (const m of replies.filter((m) => m.author_kind === 'contact')) {
      expect(await pending(d)).not.toContain(m.id);
    }
  });

  it('is neither a first response nor a customer waiting, and a stood request for a person still stands', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const relay = await kit.as(d, d.relay);
    const chat = await kit.chat(d, 'Can a person help?');
    await (await kit.as(d, d.widget)).invoke('ticket0/request-human', { sessionId: chat.sessionId, token: chat.token });
    const conversationId = chat.conversationId;
    const before = kit.sql(d, (db) =>
      db.prepare('SELECT first_public_reply_at, no_reply_candidate_at FROM ticket0_conversations WHERE id = ?').get(conversationId),
    );
    const sent = (await admin.invoke('ticket0/forward-message', { conversationId, to: 's@vendor.example', body: 'Q?' })) as Message;
    await relay.invoke('ticket0/record-delivery', { messageId: sent.id, emailMessageId: '<fw-clock@desk.example>' });
    await mail(d, { from: 's@vendor.example', inReplyTo: '<fw-clock@desk.example>', body: 'A.' });
    expect(
      kit.sql(d, (db) =>
        db.prepare('SELECT first_public_reply_at, no_reply_candidate_at FROM ticket0_conversations WHERE id = ?').get(conversationId),
      ),
    ).toEqual(before);
    // The visitor's request for a person stands: the desk has told them nothing.
    const publicDesk = (await staffMessages(d, conversationId)).filter((m) => m.visibility === 'public' && m.author_kind !== 'contact');
    expect(publicDesk.at(-1)?.body_text).toBe(HANDED_TO_A_PERSON);
  });

  it('wakes a conversation snoozed on the supplier, and an answer after it closed opens the supplier’s own', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const relay = await kit.as(d, d.relay);
    const conversationId = (await mail(d, { from: 'ana@customer.example' })).conversation_id;
    const send = async (header: string) => {
      const sent = (await admin.invoke('ticket0/forward-message', { conversationId, to: 's@vendor.example', body: 'Q?' })) as Message;
      await relay.invoke('ticket0/record-delivery', { messageId: sent.id, emailMessageId: header });
    };
    await send('<fw-snooze@desk.example>');
    await kit.park(d, conversationId, 86_400_000);
    expect((await kit.read(d, conversationId)).state).toBe('snoozed');
    await mail(d, { from: 's@vendor.example', inReplyTo: '<fw-snooze@desk.example>', body: 'Here.' });
    expect((await kit.read(d, conversationId)).state).toBe('open');

    await send('<fw-late@desk.example>');
    await admin.invoke('ticket0/close', { conversationId });
    const late = await mail(d, { from: 's@vendor.example', inReplyTo: '<fw-late@desk.example>', body: 'Sorry, late.' });
    // Not the customer's follow-up, which would be public: a conversation of their own.
    expect(late.conversation_id).not.toBe(conversationId);
    const own = await kit.read(d, late.conversation_id);
    expect(own.contact_id).toBe(contactIdOf(d, 's@vendor.example'));
    expect(kit.sql(d, (db) => db.prepare('SELECT follows FROM ticket0_conversations WHERE id = ?').get(late.conversation_id))).toEqual({
      follows: null,
    });
    // And the customer's closed thread gained nothing.
    expect((await staffMessages(d, conversationId)).map((m) => m.body_text)).not.toContain('Sorry, late.');
  });

  it('is refused for the customer, a CC, the desk and a closed conversation; taken off, a third party is mailed nothing more', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const first = await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] });
    const conversationId = first.conversation_id;
    const forward = (to: string) => admin.invoke('ticket0/forward-message', { conversationId, to, body: 'Q?' });
    await expect(forward('ana@customer.example')).rejects.toThrow(/a reply is how/);
    await expect(forward('bo@customer.example')).rejects.toThrow(/reply the customer can read/);
    await expect(forward(DESK_ADDRESS)).rejects.toThrow(/own address/);
    // Nor may a third party be copied onto the customer's thread.
    const sent = (await forward('s@vendor.example')) as Message;
    await expect(admin.invoke('ticket0/add-participant', { conversationId, email: 's@vendor.example' })).rejects.toThrow(
      /show them the customer/,
    );

    await admin.invoke('ticket0/remove-participant', { conversationId, contactId: contactIdOf(d, 's@vendor.example')! });
    expect(await pending(d)).not.toContain(sent.id);
    expect((await readOutbound(d, sent.id)).toEmail).toBeNull();

    // Withdrawn on the forward itself: putting the same person back does not send it.
    expect(
      kit.sql(d, (db) => db.prepare('SELECT withdrawn_at FROM ticket0_messages WHERE id = ?').get(sent.id)) as {
        withdrawn_at: string | null;
      },
    ).toMatchObject({ withdrawn_at: expect.any(String) });
    const resent = (await forward('s@vendor.example')) as Message;
    expect(await pending(d)).toContain(resent.id);
    expect(await pending(d)).not.toContain(sent.id);
    expect((await readOutbound(d, sent.id)).toEmail).toBeNull();
    expect((await readOutbound(d, resent.id)).toEmail).toBe('s@vendor.example');

    await admin.invoke('ticket0/close', { conversationId });
    await expect(forward('t@vendor.example')).rejects.toThrow(/invalid transition|closed/i);
  });
});

describe('one mailbox is one person, however it is spelled (#1086, Codex round 1)', () => {
  it('the customer under another case or with spaces is never a CC or a third party', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const conversationId = (await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] })).conversation_id;
    const forward = (to: string) => admin.invoke('ticket0/forward-message', { conversationId, to, body: 'Q?' });

    await expect(forward('Ana@Customer.example')).rejects.toThrow(/a reply is how/);
    await expect(forward('  ANA@customer.example ')).rejects.toThrow(/a reply is how/);
    await expect(admin.invoke('ticket0/add-participant', { conversationId, email: 'ANA@customer.example' })).rejects.toThrow(
      /already on it/,
    );
    // A CC under another spelling is the same CC: answered with their row, nothing written.
    const again = (await admin.invoke('ticket0/add-participant', { conversationId, email: ' Bo@Customer.example ' })) as {
      contact_id: string;
    };
    expect(again.contact_id).toBe(contactIdOf(d, 'bo@customer.example'));
    expect(kit.events(d, 'ticket0.participant-added', conversationId)).toHaveLength(1);
    await expect(forward('BO@customer.example')).rejects.toThrow(/reply the customer can read/);

    // Nor does a mail copy either of them in again — from the customer, or from the CC
    // naming the customer — and the reply goes to each once.
    await mail(d, { from: 'ana@customer.example', into: conversationId, cc: ['ANA@customer.example', 'Bo@customer.example'] });
    await mail(d, { from: 'bo@customer.example', into: conversationId, cc: ['Ana@customer.example'] });
    expect(await ccs(d, conversationId)).toEqual(['bo@customer.example']);
    const reply = (await admin.invoke('ticket0/post-public-reply', { conversationId, body: 'Hi.' })) as Message;
    expect(await readOutbound(d, reply.id)).toMatchObject({ toEmail: 'ana@customer.example', ccEmails: ['bo@customer.example'] });
  });

  it('a reply from another spelling of the customer threads in as the customer', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const first = await mail(d, { from: 'ana@customer.example' });
    const reply = await mail(d, { from: 'Ana@Customer.example', inReplyTo: messageIdOf(d, first.id) });
    expect(reply.conversation_id).toBe(first.conversation_id);
    expect(reply).toMatchObject({ visibility: 'public', author_contact_id: contactIdOf(d, 'ana@customer.example') });
  });

  it('a desk already holding two contacts for one mailbox resolves to the oldest, and still never mails the customer twice', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const first = await mail(d, { from: 'dee@customer.example' });
    const conversationId = first.conversation_id;
    const requester = contactIdOf(d, 'dee@customer.example')!;
    // What an older version could write: a second, OLDER contact for the same mailbox,
    // already copied in on the thread.
    kit.sql(d, (db) => {
      db.prepare(
        "INSERT INTO ticket0_contacts (id, email, created_at) VALUES ('legacy-dee', 'DEE@customer.example', '2020-01-01T00:00:00.000Z')",
      ).run();
      db.prepare(
        `INSERT INTO ticket0_conversation_participants (id, conversation_id, contact_id, role, added_by, created_at)
         VALUES ('legacy-row', ?, 'legacy-dee', 'cc', NULL, '2020-01-01T00:00:00.000Z')`,
      ).run(conversationId);
    });

    // The oldest is the mailbox's: a reply resolves to it, and threads as the customer.
    const reply = await mail(d, { from: 'dee@customer.example', inReplyTo: messageIdOf(d, first.id) });
    expect(reply).toMatchObject({ conversation_id: conversationId, author_contact_id: 'legacy-dee' });
    // It is still the customer: no forward to it, and the customer is not their own CC.
    await expect(
      admin.invoke('ticket0/forward-message', { conversationId, to: 'dee@customer.example', body: 'Q?' }),
    ).rejects.toThrow(/a reply is how/);
    const out = (await admin.invoke('ticket0/post-public-reply', { conversationId, body: 'Hi.' })) as Message;
    const sent = await readOutbound(d, out.id);
    expect(sent.toEmail).toBe('dee@customer.example');
    expect(sent.ccEmails).toEqual([]);
    expect(requester).not.toBe('legacy-dee');

    // A CC with a second, older row for their mailbox is still one CC: adding them by
    // that mailbox answers with the row they have.
    await admin.invoke('ticket0/add-participant', { conversationId, email: 'eli@customer.example' });
    kit.sql(d, (db) =>
      db.prepare(
        "INSERT INTO ticket0_contacts (id, email, created_at) VALUES ('legacy-eli', 'ELI@customer.example', '2020-01-01T00:00:00.000Z')",
      ).run(),
    );
    const eli = (await admin.invoke('ticket0/add-participant', { conversationId, email: 'eli@customer.example' })) as {
      contact_id: string;
    };
    expect(eli.contact_id).toBe(contactIdOf(d, 'eli@customer.example'));
    expect(kit.events(d, 'ticket0.participant-added', conversationId)).toHaveLength(1);

    // And a forward an older version left pointing at the customer's mailbox is never sent.
    kit.sql(d, (db) => {
      db.prepare(
        "INSERT INTO ticket0_contacts (id, email, created_at) VALUES ('legacy-dee-2', 'Dee@customer.example', '2020-01-02T00:00:00.000Z')",
      ).run();
      db.prepare(
        `INSERT INTO ticket0_conversation_participants (id, conversation_id, contact_id, role, added_by, created_at)
         VALUES ('legacy-third', ?, 'legacy-dee-2', 'third-party', NULL, '2020-01-02T00:00:00.000Z')`,
      ).run(conversationId);
      db.prepare(
        `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, third_party_contact_id, created_at)
         VALUES ('legacy-forward', ?, 'agent', 'forward', 'Q?', 'legacy-dee-2', '2020-01-02T00:00:00.000Z')`,
      ).run(conversationId);
    });
    expect((await readOutbound(d, 'legacy-forward')).toEmail).toBeNull();
  });
});

describe('the portal — a CC reads the thread, a third party never does', () => {
  it('a CC lists and reads the public thread, cannot rate it, and reads nothing once taken off', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const first = await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'], body: 'The question.' });
    const conversationId = first.conversation_id;
    await admin.invoke('ticket0/post-note', { conversationId, body: 'INTERNAL-ONLY' });
    await admin.invoke('ticket0/forward-message', { conversationId, to: 's@vendor.example', body: 'FORWARD-ONLY' });
    await admin.invoke('ticket0/post-public-reply', { conversationId, body: 'The answer.' });
    await admin.invoke('ticket0/resolve', { conversationId });
    const unrelated = (await mail(d, { from: 'zed@other.example' })).conversation_id;

    const bo = await portalFor(d, contactIdOf(d, 'bo@customer.example')!);
    expect(await myConversations(d, bo)).toEqual([conversationId]);
    const read = (await (await kit.as(d, bo)).invoke('ticket0/my-messages', { conversationId })) as Page<Message>;
    expect(read.entries.map((m) => m.body_text)).toEqual(['The question.', 'The answer.']);
    await expect((await kit.as(d, bo)).invoke('ticket0/my-messages', { conversationId: unrelated })).rejects.toThrow(
      /permission denied/i,
    );
    // Rating is the requester's.
    await expect((await kit.as(d, bo)).invoke('ticket0/submit-csat', { conversationId, score: 5 })).rejects.toThrow(
      /permission denied/i,
    );
    const ana = await portalFor(d, contactIdOf(d, 'ana@customer.example')!);
    await (await kit.as(d, ana)).invoke('ticket0/submit-csat', { conversationId, score: 5 });

    await admin.invoke('ticket0/remove-participant', { conversationId, contactId: contactIdOf(d, 'bo@customer.example')! });
    expect(await myConversations(d, bo)).toEqual([]);
    await expect((await kit.as(d, bo)).invoke('ticket0/my-messages', { conversationId })).rejects.toThrow(/permission denied/i);
  });

  it('a third party with a portal of their own never sees the conversation they were forwarded', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const conversationId = (await mail(d, { from: 'ana@customer.example' })).conversation_id;
    await admin.invoke('ticket0/forward-message', { conversationId, to: 's@vendor.example', body: 'Q?' });
    const supplier = await portalFor(d, contactIdOf(d, 's@vendor.example')!);
    expect(await myConversations(d, supplier)).toEqual([]);
    await expect((await kit.as(d, supplier)).invoke('ticket0/my-messages', { conversationId })).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('merge, follow-up and discard carry or clear them', () => {
  it('a merge moves the loser’s people onto the survivor, and the survivor’s own row wins', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const survivor = (await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] })).conversation_id;
    const loser = (await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example', 'cy@customer.example'] }))
      .conversation_id;
    await admin.invoke('ticket0/merge', { conversationId: loser, intoConversationId: survivor });
    expect(await ccs(d, survivor)).toEqual(['bo@customer.example', 'cy@customer.example']);
    expect(kit.sql(d, (db) => db.prepare('SELECT COUNT(*) AS n FROM ticket0_conversation_participants WHERE conversation_id = ?').get(loser)))
      .toEqual({ n: 0 });
  });

  it('a follow-up to a closed thread carries its CCs and not its third parties', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const admin = await kit.as(d, d.admin);
    const first = await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] });
    await admin.invoke('ticket0/forward-message', { conversationId: first.conversation_id, to: 's@vendor.example', body: 'Q?' });
    await admin.invoke('ticket0/close', { conversationId: first.conversation_id });
    const again = await mail(d, { from: 'bo@customer.example', inReplyTo: messageIdOf(d, first.id), body: 'Still broken.' });
    expect(again.conversation_id).not.toBe(first.conversation_id);
    expect((await kit.read(d, again.conversation_id)).contact_id).toBe(contactIdOf(d, 'ana@customer.example'));
    expect((await participants(d, again.conversation_id)).map((p) => p.role)).toEqual(['requester', 'cc']);
    expect(await ccs(d, again.conversation_id)).toEqual(['bo@customer.example']);
  });

  it('a discard deletes the junk’s people, and the contacts only it brought in', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await kit.configure(d, { spamFilter: { maxLinks: 0 } });
    // Somebody the desk already knows: they wrote in themselves.
    await mail(d, { from: 'known@customer.example' });
    const junk = await mail(d, {
      from: 'spammer@junk.example',
      body: 'Visit https://junk.example now',
      cc: ['victim-1@target.example', 'victim-2@target.example', 'known@customer.example'],
    });
    expect((await kit.read(d, junk.conversation_id)).quarantine).toBe('suspended');
    expect(await ccs(d, junk.conversation_id)).toHaveLength(3);

    await (await kit.as(d, d.admin)).invoke('ticket0/discard', { conversationId: junk.conversation_id });
    expect(
      kit.sql(d, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM ticket0_conversation_participants WHERE conversation_id = ?').get(junk.conversation_id),
      ),
    ).toEqual({ n: 0 });
    expect(contactIdOf(d, 'victim-1@target.example')).toBeUndefined();
    expect(contactIdOf(d, 'victim-2@target.example')).toBeUndefined();
    // Somebody anything else names stays — and so does the sender, as before.
    expect(contactIdOf(d, 'known@customer.example')).toBeDefined();
    expect(contactIdOf(d, 'spammer@junk.example')).toBeDefined();
  });
});

describe('the discard’s contact cleanup reads an index for every question', () => {
  it('scans no table but the ids it was handed', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    await mail(d, { from: 'ana@customer.example', cc: ['bo@customer.example'] });
    const planOf = (db: Database.Database) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${ORPHAN_CONTACTS_DELETE}`).all('["x"]') as { detail: string }[]).map((r) => r.detail);
    const plan = kit.sql(d, planOf);
    // json_each is the list handed in; every other table is a SEARCH, never a SCAN.
    expect(plan.filter((p) => /^SCAN /.test(p) && !/json_each/.test(p))).toEqual([]);
    for (const index of ['ticket0_messages_by_author_contact', 'ticket0_messages_by_third_party', 'ticket0_conversation_participants_by_contact']) {
      expect(plan.some((p) => p.includes(index)), index).toBe(true);
    }

    // The twin: without the author index the same question scans every message.
    const without = kit.sql(d, (db) => {
      db.exec('SAVEPOINT probe; DROP INDEX ticket0_messages_by_author_contact');
      try {
        return planOf(db);
      } finally {
        db.exec('ROLLBACK TO probe; RELEASE probe');
      }
    });
    expect(without.some((p) => /^SCAN m\b/.test(p))).toBe(true);
  });
});

describe('migration 0022 on an existing desk', () => {
  it('keeps every message, names its author, re-creates every index a fresh desk has, then takes forward', async () => {
    const provision = async (host: SqliteScopeHost, i: number) => {
      const desk = { tenant: tenantId.parse(ulid()), scope: scopeId.parse(ulid()) };
      await host.admin.createTenant(actor, { id: desk.tenant, slug: `migration-0022-${i}`, name: 'Migration' });
      await host.admin.grantEntitlement(actor, desk.tenant, ticket0Manifest.entitlementKey as string);
      await host.provisionScope(actor, { tenantId: desk.tenant, scopeId: desk.scope, vertical: 'ticket0' });
      return desk;
    };
    const file = (d: { tenant: string; scope: string }) => join(kit.dir, `${d.tenant}__${d.scope}.sqlite`);
    const indexes = (d: { tenant: string; scope: string }) => {
      const db = new Database(file(d), { readonly: true });
      try {
        return db
          .prepare(
            `SELECT tbl_name, name, sql FROM sqlite_master
              WHERE type = 'index' AND tbl_name IN ('ticket0_messages', 'ticket0_conversation_participants', 'ticket0_contacts')
              ORDER BY tbl_name, name`,
          )
          .all();
      } finally {
        db.close();
      }
    };

    // The version before: its journal, and its list declarations — 0022 changed none.
    const previous = new SqliteScopeHost({ dir: kit.dir });
    for (const m of MODULES)
      previous.registerModule(
        m.manifest.id === ticket0Manifest.id ? { ...m, migrations: (m.migrations ?? []).filter((x) => x.version <= '0021') } : m,
      );
    const old = await provision(previous, 1);
    await previous.close();
    const db = new Database(file(old));
    db.prepare("INSERT INTO ticket0_contacts (id, created_at) VALUES ('k1', '2026-01-01T00:00:00.000Z')").run();
    db.prepare(
      `INSERT INTO ticket0_conversations (id, contact_id, channel, subject, state, priority, created_at, updated_at)
       VALUES ('c1', 'k1', 'email', 'Before', 'open', 'normal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const message = db.prepare(
      `INSERT INTO ticket0_messages (id, conversation_id, author_kind, author_principal, visibility, body_text, body_html,
         email_message_id, delivered_at, cited_article_ids, created_at)
       VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    message.run('m1', 'contact', null, 'public', 'question', '<p>question</p>', '<in@old.example>', null, null);
    message.run('m2', 'agent', 'agent-1', 'public', 'answer', null, '<out@desk.example>', '2026-01-02T00:00:00.000Z', '["a1"]');
    message.run('m3', 'agent', 'agent-1', 'internal', 'note', null, null, null, null);
    const beforeRows = db.prepare('SELECT * FROM ticket0_messages ORDER BY id').all();
    // The old CHECK, before: a third audience is refused.
    expect(() => message.run('m4', 'agent', null, 'forward', 'x', null, null, null, null)).toThrow(/CHECK/);
    db.close();

    const current = new SqliteScopeHost({ dir: kit.dir });
    for (const m of MODULES) current.registerModule(m);
    await current.provisionScope(actor, { tenantId: old.tenant, scopeId: old.scope, vertical: 'ticket0' });
    // Provisioning again changes nothing: the migration is applied once.
    await current.provisionScope(actor, { tenantId: old.tenant, scopeId: old.scope, vertical: 'ticket0' });
    const fresh = await provision(current, 2);
    await current.close();

    expect(indexes(old)).toEqual(indexes(fresh));
    expect((indexes(old) as { name: string }[]).map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'ticket0_messages_public_by_conversation',
        'ticket0_messages_desk_reply',
        'ticket0_messages_by_author_contact',
        'ticket0_messages_by_third_party',
        'ticket0_conversation_participants_by_contact',
        'ticket0_contacts_by_address',
        expect.stringMatching(/^_substrat_list_.*_message_conversation_id_created_at$/),
      ]),
    );

    const after = new Database(file(old));
    try {
      const rows = after.prepare('SELECT * FROM ticket0_messages ORDER BY id').all() as Record<string, unknown>[];
      expect(rows.map(({ author_contact_id: _a, third_party_contact_id: _t, withdrawn_at: _w, ...rest }) => rest)).toEqual(
        beforeRows,
      );
      expect(rows.map((r) => [r.id, r.author_contact_id, r.third_party_contact_id, r.withdrawn_at])).toEqual([
        ['m1', 'k1', null, null],
        ['m2', null, null, null],
        ['m3', null, null, null],
      ]);
      // And after: the third audience is admitted, and nothing beyond it is.
      after
        .prepare(
          `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, created_at)
           VALUES ('m5', 'c1', 'agent', 'forward', 'x', '2026-01-03T00:00:00.000Z')`,
        )
        .run();
      expect(() =>
        after
          .prepare(
            `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, created_at)
             VALUES ('m6', 'c1', 'agent', 'everyone', 'x', '2026-01-03T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      after.close();
    }
  });
});
