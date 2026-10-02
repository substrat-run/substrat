/**
 * The suspended queue and the model-free spam filter (#1088).
 *
 * What this holds, in the order a reviewer would ask:
 *
 *  1. The filter is OFF until a desk says so, and when it is on it holds a stranger's
 *     first message for signals that need no model — and nobody else's.
 *  2. A held conversation is out of every read and every sweep that means the inbox, and
 *     the desk cannot work it. Each sweep has its own case and its positive twin: the same
 *     conversation, accepted, IS touched.
 *  3. "Not spam" is lossless; discard destroys the content completely, only for what is
 *     suspended, only for an admin, and all or nothing in bulk.
 *  4. The widget surface — the producer of the model call — never hands a held message to
 *     the assistant, driven against the real desk rather than a stub.
 *  5. A row with no queue (what an older version writes) is in the inbox.
 *
 * Every block builds its own desk (`test/desk-kit.ts`), so every count is about exactly
 * what the block made.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId, type CountedPage, type Page } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { mountWidgetSurface } from '../harness/widget-surface.js';
import { ticket0Manifest } from '../src/manifest.js';
import { MODULES } from '../src/provision.js';
import { signIdentity } from '../src/seed.js';
import { DISCARD_BATCH_MAX, SPAM_MAX_LINKS_MAX, SPAM_REPEAT_MAX } from '../spec/model.js';
import { INBOX_PARTIAL_INDEXES, listsBefore0021 } from './before-0021.js';
import { createKit, ORIGIN, type ConversationRead, type Desk } from './desk-kit.js';

const kit = createKit('ticket0-suspended-');
afterAll(() => kit.dispose());

type Conversation = ConversationRead;
interface Held {
  id: string;
  contact_email: string | null;
  reasons: string[];
  excerpt: string | null;
  messages: number;
}
interface Message {
  id: string;
  body_text: string;
  visibility: string;
}

/** A sentence carrying `n` links — the shape a link-farm message takes. */
const linky = (n: number, tag = 'x'): string =>
  `Great offers here ${Array.from({ length: n }, (_, i) => `https://deals-${tag}-${i}.example/buy`).join(' and ')}`;

const admin = (d: Desk): Promise<ScopeStub> => kit.as(d, d.admin);

/** A desk with the filter on (`{}` unless bounds are given). */
async function filtered(
  opts: { agents?: number; spamFilter?: Record<string, number> } = {},
): Promise<Desk> {
  const d = await kit.freshDesk({ agents: opts.agents ?? 1 });
  await kit.configure(d, { spamFilter: opts.spamFilter ?? {} });
  return d;
}

/** A new anonymous visitor says `body` — the widget's first message. */
const visitor = (d: Desk, body: string) => kit.chat(d, body);

async function say(d: Desk, session: { sessionId: string; token: string }, body: string) {
  kit.clock.advance(60_000);
  return (await (await kit.as(d, d.widget)).invoke('ticket0/widget-post', {
    sessionId: session.sessionId,
    token: session.token,
    body,
  })) as { conversation_id: string; suspended: boolean };
}

async function inbox(d: Desk, input: Record<string, unknown> = {}): Promise<string[]> {
  const page = (await (await admin(d)).invoke('ticket0/list-conversations', { limit: 100, ...input })) as Page<Conversation>;
  return page.entries.map((c) => c.id);
}

async function queue(d: Desk): Promise<Held[]> {
  return ((await (await admin(d)).invoke('ticket0/list-suspended', { limit: 100 })) as Page<Held>).entries;
}

const read = (d: Desk, id: string): Promise<Conversation> => kit.read(d, id);

const messages = async (d: Desk, id: string): Promise<Message[]> =>
  ((await (await admin(d)).invoke('ticket0/list-messages', { conversationId: id, limit: 100 })) as Page<Message>)
    .entries;

const conflict = (reason: string) => ({ code: 'conflict', extensions: { reason } });

describe('the filter is off until a desk switches it on', () => {
  it('lets a stranger’s link farm into the inbox on a desk that never said, and holds it once the desk says {}', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    const before = await visitor(d, linky(6, 'off'));
    expect(before.suspended).toBe(false);
    expect(await inbox(d)).toContain(before.conversationId);

    await kit.configure(d, { spamFilter: {} });
    const after = await visitor(d, linky(6, 'on'));
    expect(after.suspended).toBe(true);
    expect(await inbox(d)).not.toContain(after.conversationId);

    // And `null` switches it off again.
    await kit.configure(d, { spamFilter: null });
    expect((await visitor(d, linky(6, 'again'))).suspended).toBe(false);
  });

  it('refuses a bound outside the declared range at save time, and takes the bounds themselves', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const a = await admin(d);
    for (const spamFilter of [
      { maxLinks: SPAM_MAX_LINKS_MAX + 1 },
      { maxLinks: -1 },
      { repeatAfter: 0 },
      { repeatAfter: SPAM_REPEAT_MAX + 1 },
      { links: 3 },
    ]) {
      await expect(a.invoke('ticket0/configure-desk', { settings: { spamFilter } }), JSON.stringify(spamFilter)).rejects.toThrow();
    }
    await a.invoke('ticket0/configure-desk', { settings: { spamFilter: { maxLinks: 0, repeatAfter: SPAM_REPEAT_MAX } } });
    await a.invoke('ticket0/configure-desk', { settings: { spamFilter: { maxLinks: SPAM_MAX_LINKS_MAX, repeatAfter: 1 } } });
  });
});

describe('what the filter holds, and whom it never holds', () => {
  it('holds more links than the desk allows a stranger, and not one fewer', async () => {
    const d = await filtered();
    const held = await visitor(d, linky(3, 'three'));
    const kept = await visitor(d, linky(2, 'two'));
    expect(held.suspended).toBe(true);
    expect(kept.suspended).toBe(false);

    const [row] = await queue(d);
    expect(row!.id).toBe(held.conversationId);
    expect(row!.reasons).toEqual(['links']);
    expect(row!.excerpt).toBe(linky(3, 'three'));
    expect(row!.messages).toBe(1);
    expect((await queue(d)).map((r) => r.id)).not.toContain(kept.conversationId);
  });

  it('holds ANY link when a desk sets maxLinks to 0, and plain text still passes', async () => {
    const d = await filtered({ spamFilter: { maxLinks: 0 } });
    expect((await visitor(d, 'See www.example.com please')).suspended).toBe(true);
    expect((await visitor(d, 'How do I rotate a key?')).suspended).toBe(false);
  });

  it('holds the third copy of a pasted run, and never a short greeting however many say it', async () => {
    const d = await filtered();
    const pitch = 'Buy followers cheap — fast delivery guaranteed today';
    const first = await visitor(d, pitch);
    const second = await visitor(d, `  ${pitch.toUpperCase()}  `);
    const third = await visitor(d, pitch);
    expect([first.suspended, second.suspended, third.suspended]).toEqual([false, false, true]);
    expect((await queue(d)).find((r) => r.id === third.conversationId)!.reasons).toEqual(['repeated']);

    for (let i = 0; i < 4; i++) expect((await visitor(d, 'hello there')).suspended).toBe(false);
  });

  it('counts a run inside the window only', async () => {
    const d = await filtered();
    const pitch = 'Limited offer on crypto signals, message me now';
    await visitor(d, pitch);
    await visitor(d, pitch);
    kit.clock.advance(25 * 60 * 60 * 1000);
    expect((await visitor(d, pitch)).suspended).toBe(false);
  });

  it('never holds a visitor the host site vouched for', async () => {
    const d = await filtered();
    const a = await admin(d);
    const { secret } = (await a.invoke('ticket0/rotate-verification-secret', {})) as { secret: string };
    const widget = await kit.as(d, d.widget);
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: ORIGIN,
      identity: { externalId: 'known-customer', signature: await signIdentity(secret, 'known-customer') },
    })) as { sessionId: string; token: string };
    const posted = (await widget.invoke('ticket0/widget-post', { ...started, body: linky(8, 'vouched') })) as {
      suspended: boolean;
    };
    expect(posted.suspended).toBe(false);
  });

  it('never holds a sender the desk already accepted — mail from a known address with links lands in the inbox', async () => {
    const d = await filtered();
    const first = await kit.mail(d, { from: 'regular@customer.example', body: 'Hello, a question.' });
    expect((await read(d, first)).quarantine).toBeNull();
    const second = await kit.mail(d, { from: 'regular@customer.example', subject: 'Another', body: linky(5, 'known') });
    expect((await read(d, second)).quarantine).toBeNull();

    // The positive twin: the same mail from an address nobody has accepted is held.
    const stranger = await kit.mail(d, { from: 'new@stranger.example', body: linky(5, 'stranger') });
    expect((await read(d, stranger)).quarantine).toBe('suspended');
  });

  it('holds a sender whose only history is a discarded conversation, however plainly they write', async () => {
    const d = await filtered();
    const junk = await kit.mail(d, { from: 'spammer@junk.example', body: linky(5, 'first') });
    await (await admin(d)).invoke('ticket0/discard', { conversationId: junk });
    const again = await kit.mail(d, { from: 'spammer@junk.example', body: 'Hi, just checking in.' });
    const held = (await queue(d)).find((r) => r.id === again);
    expect(held?.reasons).toEqual(['discarded-before']);
  });

  it('keeps a held thread held as the sender writes more, and never re-judges an accepted one', async () => {
    const d = await filtered();
    const held = await visitor(d, linky(4, 'held'));
    expect((await say(d, held, 'hello?')).suspended).toBe(true);
    const mail = await kit.mail(d, { from: 'x@held.example', body: linky(4, 'mail') });
    await kit.mail(d, { into: mail, from: 'x@held.example', body: 'still there?' });
    expect((await read(d, mail)).quarantine).toBe('suspended');

    const accepted = await visitor(d, 'How do I rotate a key?');
    expect((await say(d, accepted, linky(9, 'later'))).suspended).toBe(false);
    expect((await read(d, accepted.conversationId)).quarantine).toBeNull();
  });

  it('records that the filter acted, beside the desk’s other behaviours', async () => {
    const d = await filtered();
    await visitor(d, 'How do I rotate a key?');
    expect((await kit.runs(d)).map((r) => r.behaviour)).not.toContain('spamFilter');
    await visitor(d, linky(4, 'runs'));
    expect((await kit.runs(d)).find((r) => r.behaviour === 'spamFilter')?.last_count).toBe(1);
  });
});

describe('a held conversation is out of the inbox, and the desk cannot work it', () => {
  it('is in no inbox read — not by default, not by state, not with closed — and in its own queue', async () => {
    const d = await filtered();
    const held = await visitor(d, linky(4, 'lists'));
    const kept = await visitor(d, 'How do I rotate a key?');
    for (const input of [{}, { state: 'new' }, { include_closed: true }, { queue: 'inbox' }]) {
      const ids = await inbox(d, input);
      expect(ids, JSON.stringify(input)).toContain(kept.conversationId);
      expect(ids, JSON.stringify(input)).not.toContain(held.conversationId);
    }
    const counted = (await (await admin(d)).invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    expect(counted.total).toBe(1);
    expect(await inbox(d, { queue: 'suspended' })).toEqual([held.conversationId]);
  });

  it('is found by search across every queue, and not when search is narrowed to the inbox', async () => {
    const d = await filtered();
    const held = await visitor(d, `${linky(4, 'search')} zebracrossing`);
    const a = await admin(d);
    const hits = async (input: Record<string, unknown>) =>
      ((await a.invoke('ticket0/search-conversations', { q: 'zebracrossing', ...input })) as Page<Conversation>).entries;
    const all = await hits({});
    expect(all.map((c) => c.id)).toEqual([held.conversationId]);
    expect(all[0]!.quarantine).toBe('suspended');
    expect(await hits({ queue: 'inbox' })).toEqual([]);
    expect((await hits({ queue: 'suspended' })).map((c) => c.id)).toEqual([held.conversationId]);
  });

  it('refuses every act of working it, and lets the same acts through once restored', async () => {
    const d = await filtered({ agents: 1 });
    const held = await visitor(d, linky(4, 'work'));
    const id = held.conversationId;
    const a = await admin(d);
    const acts: [string, Record<string, unknown>][] = [
      ['ticket0/assign', { conversationId: id, assignee: d.agents[0] }],
      ['ticket0/post-public-reply', { conversationId: id, body: 'Hi' }],
      ['ticket0/post-note', { conversationId: id, body: 'note' }],
      ['ticket0/set-priority', { conversationId: id, priority: 'urgent' }],
      ['ticket0/tag-conversation', { conversationId: id, tag: 'x' }],
      ['ticket0/close', { conversationId: id }],
    ];
    for (const [op, input] of acts) {
      await expect(a.invoke(op, input), op).rejects.toMatchObject(conflict('suspended'));
    }
    expect(await messages(d, id)).toHaveLength(1);

    await a.invoke('ticket0/restore', { conversationId: id });
    await a.invoke('ticket0/post-note', { conversationId: id, body: 'note' });
    await a.invoke('ticket0/assign', { conversationId: id, assignee: d.agents[0] });
    expect((await read(d, id)).state).toBe('open');
  });

  it('cannot be merged into, and cannot be merged away, while held', async () => {
    const d = await filtered();
    const a = await admin(d);
    const one = await kit.mail(d, { from: 'twice@customer.example', body: 'first' });
    const two = await kit.mail(d, { from: 'twice@customer.example', subject: 'again', body: 'second' });
    await a.invoke('ticket0/suspend', { conversationId: two });
    await expect(a.invoke('ticket0/merge', { conversationId: one, intoConversationId: two })).rejects.toMatchObject(
      conflict('survivor_not_in_inbox'),
    );
    await expect(a.invoke('ticket0/merge', { conversationId: two, intoConversationId: one })).rejects.toMatchObject(
      conflict('suspended'),
    );
    await a.invoke('ticket0/restore', { conversationId: two });
    await a.invoke('ticket0/merge', { conversationId: one, intoConversationId: two });
  });

  it('shows the visitor their own words, and pages nobody when they ask for a person', async () => {
    const d = await filtered({ agents: 2 });
    const held = await visitor(d, linky(4, 'human'));
    const widget = await kit.as(d, d.widget);
    const asked = (await widget.invoke('ticket0/request-human', {
      sessionId: held.sessionId,
      token: held.token,
      body: 'Can a person look at this?',
    })) as { notified: number };
    expect(asked.notified).toBe(0);
    for (const agent of d.agents) expect(await kit.notifications(d, agent)).toEqual([]);
    const thread = (await widget.invoke('ticket0/widget-thread', { sessionId: held.sessionId, token: held.token })) as Page<{
      body_text: string;
    }>;
    // Their two messages and no acknowledgement promising a reply nobody agreed to.
    expect(thread.entries.map((m) => m.body_text)).toEqual([linky(4, 'human'), 'Can a person look at this?']);
    expect(kit.events(d, 'ticket0.human-requested')).toEqual([]);

    // The positive twin: the same button in an accepted conversation tells the desk.
    const kept = await visitor(d, 'How do I rotate a key?');
    const told = (await widget.invoke('ticket0/request-human', { sessionId: kept.sessionId, token: kept.token })) as {
      notified: number;
    };
    expect(told.notified).toBe(2);
  });
});

/**
 * Every sweep that selects by state, against one held conversation and its accepted twin.
 * Both arrive the same way at the same minute; the only difference is the queue.
 */
describe('every sweep and count leaves the suspended queue alone, and still sweeps the inbox', () => {
  async function pair(settings: Record<string, unknown>, agents = 2) {
    const d = await filtered({ agents });
    await kit.configure(d, settings);
    const held = (await visitor(d, linky(4, 'sweep'))).conversationId;
    const kept = (await visitor(d, 'How do I rotate a key? It keeps failing.')).conversationId;
    expect((await read(d, held)).quarantine).toBe('suspended');
    return { d, held, kept };
  }

  it('round-robin hands out the accepted one only', async () => {
    const { d, held, kept } = await pair({ roundRobin: true });
    expect(await kit.sweep(d, 'ticket0/assign-round-robin', 'assigned')).toBe(1);
    expect((await read(d, kept)).assignee).not.toBeNull();
    expect((await read(d, held)).assignee).toBeNull();
  });

  it('auto-tag reads the accepted one only', async () => {
    const { d, held, kept } = await pair({ autoTag: { rules: [{ in: 'either', contains: 'e', tag: 'seen' }] } });
    expect(await kit.sweep(d, 'ticket0/auto-tag', 'tagged')).toBe(1);
    expect(await kit.tags(d, kept)).toEqual(['seen']);
    expect(await kit.tags(d, held)).toEqual([]);
  });

  it('service levels breach the accepted one only, and breaching-soon lists only it', async () => {
    const { d, kept } = await pair({ sla: { firstResponseMinutes: { normal: 60 } } });
    const soon = (await (await admin(d)).invoke('ticket0/breaching-soon', { withinMinutes: 120 })) as {
      rows: { conversationId: string }[];
    };
    expect(soon.rows.map((r) => r.conversationId)).toEqual([kept]);
    kit.clock.advance(2 * 60 * 60 * 1000);
    expect(await kit.sweep(d, 'ticket0/escalate-sla-breaches', 'breached')).toBe(1);
    const breached = kit.sql(d, (db) =>
      db.prepare('SELECT id FROM ticket0_conversations WHERE first_response_breached_at IS NOT NULL').all(),
    );
    expect(breached).toEqual([{ id: kept }]);
  });

  it('no-reply notify tells the desk about the accepted one only', async () => {
    const { d, kept } = await pair({ noReplyNotify: { afterHours: 1 } });
    kit.clock.advance(2 * 60 * 60 * 1000);
    expect(await kit.sweep(d, 'ticket0/notify-no-reply', 'notified')).toBe(1);
    expect((await read(d, kept)).state).toBe('new');
    const told = kit.sql(d, (db) =>
      db.prepare('SELECT id FROM ticket0_conversations WHERE no_reply_notified_at IS NOT NULL').all(),
    );
    expect(told).toEqual([{ id: kept }]);
  });

  it('the reaper closes the abandoned accepted one only — junk waits for a person', async () => {
    const { d, held, kept } = await pair({});
    kit.clock.advance(31 * 24 * 60 * 60 * 1000);
    expect(await kit.sweep(d, 'ticket0/reap-abandoned', 'reaped')).toBe(1);
    expect((await read(d, kept)).state).toBe('closed');
    expect((await read(d, held)).state).toBe('new');
    expect((await read(d, held)).quarantine).toBe('suspended');
  });

  it('auto-close never meets a held conversation — it takes resolved ones, and a held one cannot be resolved', async () => {
    const { d, held, kept } = await pair({ autoClose: { afterDays: 1 } });
    await kit.resolve(d, kept);
    kit.clock.advance(2 * 24 * 60 * 60 * 1000);
    expect(await kit.sweep(d, 'ticket0/auto-close', 'closed')).toBe(1);
    expect((await read(d, kept)).state).toBe('closed');
    expect((await read(d, held)).state).toBe('new');
  });

  it('assistant health stops listing a draft as waiting while its conversation is held, and lists it again once restored', async () => {
    const d = await filtered();
    const a = await admin(d);
    const id = await kit.mail(d, { from: 'drafted@customer.example', body: 'a real question' });
    await a.invoke('ticket0/record-answer', {
      conversationId: id,
      turnId: 'draft-turn-1',
      model: 'offline/extractive',
      body: 'Here is how.',
      inputTokens: 1,
      outputTokens: 1,
      citedArticleIds: [],
      outcome: 'drafted',
    });
    const waiting = async () =>
      ((await a.invoke('ticket0/assistant-health', {})) as { waitingTotal: number }).waitingTotal;
    expect(await waiting()).toBe(1);
    await a.invoke('ticket0/suspend', { conversationId: id });
    expect(await waiting()).toBe(0);
    await a.invoke('ticket0/restore', { conversationId: id });
    expect(await waiting()).toBe(1);
  });

  it('the desk report counts the queue apart, never as backlog or arrivals', async () => {
    const { d } = await pair({});
    const report = (await (await admin(d)).invoke('ticket0/desk-metrics', {})) as {
      volume: { opened: number };
      backlog: { open: number; unassigned: number; suspended: number };
    };
    expect(report.volume.opened).toBe(1);
    expect(report.backlog).toMatchObject({ open: 1, unassigned: 1, suspended: 1 });
  });
});

describe('restore — "not spam" — is lossless', () => {
  it('puts the conversation back exactly as it was, and in the inbox', async () => {
    const d = await filtered();
    const mail = await kit.mail(d, { from: 'false@positive.example', subject: 'My order', body: linky(4, 'real') });
    await kit.mail(d, { into: mail, from: 'false@positive.example', body: 'Any news?' });
    const before = await read(d, mail);
    const bodies = (await messages(d, mail)).map((m) => m.body_text);
    expect(before.quarantine).toBe('suspended');

    kit.clock.advance(60_000);
    const restored = (await (await kit.as(d, d.agents[0]!)).invoke('ticket0/restore', { conversationId: mail })) as Conversation;
    expect(restored.quarantine).toBeNull();
    expect(restored).toMatchObject({
      state: 'new',
      subject: 'My order',
      contact_id: before.contact_id,
      assignee: null,
      suspicion: before.suspicion,
    });
    expect((await messages(d, mail)).map((m) => m.body_text)).toEqual(bodies);
    expect(await inbox(d)).toContain(mail);
    expect(kit.events(d, 'ticket0.conversation-restored', mail)).toHaveLength(1);

    // A second "not spam" is the same decision: it answers, and writes nothing.
    await (await admin(d)).invoke('ticket0/restore', { conversationId: mail });
    expect(kit.events(d, 'ticket0.conversation-restored', mail)).toHaveLength(1);

    // And the contact is no longer a stranger: their next link-heavy mail is accepted.
    const next = await kit.mail(d, { from: 'false@positive.example', subject: 'Again', body: linky(4, 'again') });
    expect((await read(d, next)).quarantine).toBeNull();
  });

  it('suspends by hand only what nobody has worked, and only once', async () => {
    const d = await filtered({ agents: 1 });
    const agent = await kit.as(d, d.agents[0]!);
    const fresh = await kit.mail(d, { body: 'a plain question' });
    const held = (await agent.invoke('ticket0/suspend', { conversationId: fresh })) as Conversation;
    expect(held.quarantine).toBe('suspended');
    expect(JSON.parse(held.suspicion!)).toEqual(['marked']);
    await agent.invoke('ticket0/suspend', { conversationId: fresh });
    expect(kit.events(d, 'ticket0.conversation-suspended', fresh)).toHaveLength(1);

    const worked = await kit.mail(d, { body: 'another' });
    await agent.invoke('ticket0/assign', { conversationId: worked, assignee: d.agents[0] });
    await expect(agent.invoke('ticket0/suspend', { conversationId: worked })).rejects.toMatchObject(
      conflict('invalid_transition'),
    );
    await expect(agent.invoke('ticket0/restore', { conversationId: worked })).rejects.toMatchObject(
      conflict('invalid_transition'),
    );
  });
});

describe('discard destroys the content — completely, only what is suspended, only for an admin', () => {
  it('refuses anything not in the suspended queue, whatever its state, and destroys nothing', async () => {
    const d = await filtered({ agents: 1 });
    const a = await admin(d);
    const fresh = await kit.mail(d, { body: 'keep me' });
    const open = await kit.mail(d, { body: 'keep me too' });
    await a.invoke('ticket0/assign', { conversationId: open, assignee: d.agents[0] });
    const closed = await kit.mail(d, { body: 'and me' });
    await a.invoke('ticket0/close', { conversationId: closed });
    for (const id of [fresh, open, closed]) {
      await expect(a.invoke('ticket0/discard', { conversationId: id })).rejects.toMatchObject(conflict('not_suspended'));
      expect(await messages(d, id)).toHaveLength(1);
    }
    // The positive twin: the same admin, a suspended conversation.
    await a.invoke('ticket0/suspend', { conversationId: fresh });
    expect(((await a.invoke('ticket0/discard', { conversationId: fresh })) as Conversation).quarantine).toBe('discarded');
  });

  it('is an admin’s alone: an agent may suspend and restore, and is refused the discard', async () => {
    const d = await filtered({ agents: 1 });
    const held = (await visitor(d, linky(4, 'who'))).conversationId;
    const agent = await kit.as(d, d.agents[0]!);
    await expect(agent.invoke('ticket0/discard', { conversationId: held })).rejects.toThrow(/denied/i);
    await expect(agent.invoke('ticket0/discard-suspended', { conversationIds: [held] })).rejects.toThrow(/denied/i);
    expect((await read(d, held)).quarantine).toBe('suspended');
    await (await admin(d)).invoke('ticket0/discard', { conversationId: held });
    expect((await read(d, held)).quarantine).toBe('discarded');
  });

  it('leaves nothing anywhere in the desk that still says what was written', async () => {
    const d = await filtered();
    const NEEDLE = 'quixotic-zeppelin-7731';
    const SUBJECT = 'Subject line zeppelin-subject-5512';
    const widget = await visitor(d, `${linky(4, 'needle')} ${NEEDLE}`);
    await say(d, widget, `more ${NEEDLE}`);
    const mail = await kit.mail(d, { from: 'needle@junk.example', subject: SUBJECT, body: `${linky(4, 'm')} ${NEEDLE}` });
    // An attachment the mail carried leaves a note behind (#1080) — it must go too.
    await (await kit.as(d, d.relay)).invoke('ticket0/ingest-message', {
      conversationId: mail,
      contactEmail: 'needle@junk.example',
      contactName: null,
      subject: SUBJECT,
      bodyText: `with a file ${NEEDLE}`,
      emailMessageId: '<needle-attachment@mail.example>',
      attachments: [{ filename: `${NEEDLE}.pdf`, contentType: 'application/pdf', sizeBytes: 1200 }],
    });
    const a = await admin(d);
    const scan = (): string[] =>
      kit.sql(d, (db) => {
        const found: string[] = [];
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        for (const { name } of tables) {
          const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as { name: string }[];
          for (const { name: col } of cols) {
            const hit = db
              .prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${col}" AS TEXT) LIKE ?`)
              .get(`%zeppelin%`) as { n: number };
            if (hit.n > 0) found.push(`${name}.${col}`);
          }
        }
        return found;
      });
    // The probe can see it before: the scan is not vacuous.
    expect(scan()).toEqual(expect.arrayContaining(['ticket0_messages.body_text', 'ticket0_conversations.subject']));

    await a.invoke('ticket0/discard-suspended', { conversationIds: [widget.conversationId, mail] });

    expect(scan()).toEqual([]);
    for (const id of [widget.conversationId, mail]) {
      const row = await read(d, id);
      expect(row).toMatchObject({ state: 'closed', quarantine: 'discarded', subject: '' });
      expect(await messages(d, id)).toEqual([]);
    }
    const search = (await a.invoke('ticket0/search-conversations', { q: NEEDLE })) as Page<Conversation>;
    expect(search.entries).toEqual([]);
    // The visitor's token is gone with the session.
    await expect(
      (await kit.as(d, d.widget)).invoke('ticket0/widget-thread', { sessionId: widget.sessionId, token: widget.token }),
    ).rejects.toThrow(/not found/i);
    // Its own event, and the close a consumer counting closures expects.
    expect(kit.events(d, 'ticket0.conversation-discarded')).toHaveLength(2);
    expect(kit.events(d, 'ticket0.conversation-closed')).toHaveLength(2);
  });

  it('in bulk is all or nothing: one conversation not in the queue refuses the lot', async () => {
    const d = await filtered();
    const a = await admin(d);
    const held = [await visitor(d, linky(4, 'a')), await visitor(d, linky(4, 'b'))].map((v) => v.conversationId);
    const kept = (await visitor(d, 'How do I rotate a key?')).conversationId;
    await expect(a.invoke('ticket0/discard-suspended', { conversationIds: [...held, kept] })).rejects.toMatchObject(
      conflict('not_suspended'),
    );
    for (const id of held) expect((await read(d, id)).quarantine).toBe('suspended');
    expect(kit.events(d, 'ticket0.conversation-discarded')).toEqual([]);

    await expect(a.invoke('ticket0/discard-suspended', { conversationIds: [...held, 'no-such-conversation'] })).rejects.toThrow(
      /not found/i,
    );
    for (const id of held) expect((await read(d, id)).quarantine).toBe('suspended');

    const done = (await a.invoke('ticket0/discard-suspended', { conversationIds: [...held, held[0]!] })) as {
      discarded: string[];
    };
    expect(done.discarded).toEqual(held);
    expect(kit.events(d, 'ticket0.conversation-discarded')).toHaveLength(2);
    expect(await queue(d)).toEqual([]);
  });

  it('refuses an empty selection, and one past a screenful', async () => {
    const d = await filtered();
    const a = await admin(d);
    await expect(a.invoke('ticket0/discard-suspended', { conversationIds: [] })).rejects.toThrow();
    await expect(
      a.invoke('ticket0/discard-suspended', {
        conversationIds: Array.from({ length: DISCARD_BATCH_MAX + 1 }, (_, i) => `c${i}`),
      }),
    ).rejects.toThrow();
  });
});

describe('a conversation with no queue is in the inbox', () => {
  it('reads a row an older version wrote — no quarantine column named — as accepted, listed and swept', async () => {
    const d = await kit.freshDesk({ agents: 1 });
    await kit.configure(d, { roundRobin: true });
    const id = await kit.mail(d, { body: 'written the old way' });
    // What an older version's INSERT leaves: it does not name the column, so it is NULL.
    // The door writes exactly that too; this pins it rather than assuming it.
    expect(kit.sql(d, (db) => db.prepare('SELECT quarantine FROM ticket0_conversations WHERE id = ?').get(id))).toEqual({
      quarantine: null,
    });
    expect(await inbox(d)).toContain(id);
    expect(await kit.sweep(d, 'ticket0/assign-round-robin', 'assigned')).toBe(1);
  });
});

describe('the widget surface never hands a held message to the assistant', () => {
  /** The real surface, in front of the real desk — the producer of the model call. */
  function surface(d: Desk) {
    const app = new Hono();
    const answered = vi.fn();
    mountWidgetSurface(app, {
      resolveDesk: async () => {
        const widget = await kit.as(d, d.widget);
        return {
          invoke: <T,>(op: string, input: unknown) => widget.invoke(op, input) as Promise<T>,
          allowedOrigins: [ORIGIN],
          deskKey: `${d.tenant}/${d.scope}`,
        };
      },
      onCustomerMessage: answered,
    });
    const post = async (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const open = async () => (await (await post('/widget/sessions', {})).json()) as { sessionId: string; token: string };
    return { answered, post, open };
  }

  it('asks the model about an accepted message, and not about a held one — nor tells the browser why', async () => {
    const d = await filtered({ agents: 1 });
    const s = surface(d);

    const kept = await s.open();
    const ok = await s.post(`/widget/sessions/${kept.sessionId}/messages`, { token: kept.token, body: 'How do I rotate a key?' });
    expect(ok.status).toBe(200);
    expect(s.answered).toHaveBeenCalledTimes(1);

    const junk = await s.open();
    const held = await s.post(`/widget/sessions/${junk.sessionId}/messages`, { token: junk.token, body: linky(5, 'surface') });
    expect(held.status).toBe(200);
    const body = (await held.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('suspended');
    expect(body['body_text']).toBe(linky(5, 'surface'));
    expect(s.answered).toHaveBeenCalledTimes(1);

    // A held visitor TYPING for a human is not escalated either: nobody is paged.
    const typed = await s.post(`/widget/sessions/${junk.sessionId}/messages`, {
      token: junk.token,
      body: 'can I talk to a human please',
    });
    expect(typed.status).toBe(200);
    expect(s.answered).toHaveBeenCalledTimes(1);
    expect(await kit.notifications(d, d.agents[0]!)).toEqual([]);
  });
});


/**
 * Migration 0021 on a desk that already holds conversations: the column arrives NULL —
 * the inbox — on every row, and the schema it leaves is the schema a fresh desk gets.
 * Compared whole (every index's name AND definition on the conversation table), so a
 * partial index left wide, or a kernel list index the upgrade lost, is a red diff here.
 */
describe('migration 0021 on an existing desk', () => {
  it('keeps every conversation in the inbox, and leaves exactly the indexes a fresh desk has', async () => {
    const actor = platformActorId.parse(ulid());
    const provision = async (host: SqliteScopeHost, i: number) => {
      const desk = { tenant: tenantId.parse(ulid()), scope: scopeId.parse(ulid()) };
      await host.admin.createTenant(actor, { id: desk.tenant, slug: `migration-0021-${i}`, name: 'Migration' });
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
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ticket0_conversations' ORDER BY name",
          )
          .all() as { name: string; sql: string | null }[];
      } finally {
        db.close();
      }
    };

    // The version before: its journal, and its list declaration — `quarantine` was not a
    // column, so it was not a filter.
    const previous = new SqliteScopeHost({ dir: kit.dir });
    for (const m of MODULES)
      previous.registerModule(
        m.manifest.id === ticket0Manifest.id
          ? {
              ...m,
              manifest: { ...m.manifest, lists: listsBefore0021(m.manifest.lists ?? []) },
              migrations: (m.migrations ?? []).filter((x) => x.version <= '0020'),
            }
          : m,
      );
    const old = await provision(previous, 1);
    await previous.close();
    const db = new Database(file(old));
    db.prepare("INSERT INTO ticket0_contacts (id, created_at) VALUES ('k1', '2026-01-01T00:00:00.000Z')").run();
    for (const [id, state] of [['c1', 'new'], ['c2', 'open'], ['c3', 'closed']] as const)
      db.prepare(
        `INSERT INTO ticket0_conversations (id, contact_id, channel, subject, state, priority, created_at, updated_at)
         VALUES (?, 'k1', 'email', 'Before', ?, 'normal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(id, state);
    db.close();

    const current = new SqliteScopeHost({ dir: kit.dir });
    for (const m of MODULES) current.registerModule(m);
    await current.provisionScope(actor, { tenantId: old.tenant, scopeId: old.scope, vertical: 'ticket0' });
    const fresh = await provision(current, 2);
    await current.close();

    const after = new Database(file(old), { readonly: true });
    try {
      expect(after.prepare('SELECT id, quarantine FROM ticket0_conversations ORDER BY id').all()).toEqual([
        { id: 'c1', quarantine: null },
        { id: 'c2', quarantine: null },
        { id: 'c3', quarantine: null },
      ]);
    } finally {
      after.close();
    }
    const upgraded = indexes(old);
    expect(upgraded).toEqual(indexes(fresh));
    // And the five live-work indexes carry the inbox predicate, not merely exist.
    for (const name of INBOX_PARTIAL_INDEXES) {
      expect(upgraded.find((i) => i.name === name)?.sql, name).toMatch(/AND quarantine IS NULL$/);
    }
    expect(upgraded.map((i) => i.name)).toContain('ticket0_conversations_suspended');
    expect(upgraded.some((i) => /_conversation_quarantine_/.test(i.name))).toBe(true);
  });
});
