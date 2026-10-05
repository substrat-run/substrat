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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId, type CountedPage, type Page, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { mountWidgetSurface } from '../harness/widget-surface.js';
import { ticket0Manifest } from '../src/manifest.js';
import { MODULES } from '../src/provision.js';
import { DELIVERY_DISCARDED } from '../src/module.js';
import { buildHost, seed, signIdentity } from '../src/seed.js';
import { DISCARD_BATCH_MAX, SPAM_MAX_LINKS_MAX, SPAM_REPEAT_MAX, ticket0Entities, ticket0Operations } from '../spec/model.js';
import { INBOX_PARTIAL_INDEXES, listsBefore0021 } from './before-0021.js';
import { listsBefore0025 } from './before-0025.js';
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

  /**
   * The reviewer's repro (Codex round 1, #1973): following is not in the lifecycle, so it
   * never passed through `step()`, and an agent could hand a narrowly granted colleague
   * a read of a held thread. The guest holds `conversation:draft` and nothing else, so a
   * follow is the whole of what they can see.
   */
  it('refuses a new follow on a held conversation, and lets a guest follow an accepted one', async () => {
    const d = await filtered({ agents: 1 });
    const guest = await kit.guest(d);
    const agent = await kit.as(d, d.agents[0]!);
    const asGuest = await kit.as(d, guest);
    const held = (await visitor(d, linky(4, 'follow'))).conversationId;
    await expect(agent.invoke('ticket0/follow-conversation', { conversationId: held, follower: guest })).rejects.toMatchObject(
      conflict('suspended'),
    );
    await expect(asGuest.invoke('ticket0/list-messages', { conversationId: held })).rejects.toThrow(/denied/i);

    const kept = (await visitor(d, 'How do I rotate a key?')).conversationId;
    await agent.invoke('ticket0/follow-conversation', { conversationId: kept, follower: guest });
    expect(((await asGuest.invoke('ticket0/list-messages', { conversationId: kept })) as Page<Message>).entries).toHaveLength(1);
    // Unfollow stays open while held: taking access away is always safe to allow.
    await agent.invoke('ticket0/suspend', { conversationId: kept });
    await agent.invoke('ticket0/unfollow-conversation', { conversationId: kept, follower: guest });
    await expect(asGuest.invoke('ticket0/list-messages', { conversationId: kept })).rejects.toThrow(/denied/i);
  });

  /**
   * EVERY operation in the model, classified — and the classification is checked against
   * the model's whole list, so an operation added tomorrow fails here until somebody says
   * which kind it is (Codex round 2, #1973: the first version only saw operations whose
   * input names `conversationId`, and missed the ones that reach a conversation through a
   * session, a message or a notification, and the sweeps that take no id at all). Each
   * WORK operation is then invoked on a held conversation and must be refused by the
   * queue's rule, by name; every other kind names the test that holds it.
   */
  it('refuses every operation that works a conversation, and the list is the model’s whole list', async () => {
    // Reads of one conversation. A held conversation is the desk's to look at. `widget-watch`
    // proves the visitor's token for their live feed, as `widget-thread` does for their poll.
    const READS = ['get-conversation', 'list-messages', 'widget-session', 'get-csat', 'list-conversation-tags',
      'render-saved-reply', 'list-turns', 'usage-summary', 'my-messages', 'widget-thread', 'widget-watch',
      'list-participants'];
    // The ways out of the queue; the customer's own doors (`widget-post` and `request-human`
    // are held to it in 'keeps a held thread held…' and 'shows the visitor their own
    // words…'); and the writes that only ever narrow access or record a fact: an unfollow,
    // taking a CC or a third party off (#1086, the same argument), the delivery of a mail
    // the provider already took (refusing it would only make the relay send again), and
    // reading a notification, which a held conversation no longer has ('suspension
    // retires what the desk was told…').
    const ALLOWED = ['suspend', 'restore', 'discard', 'discard-suspended', 'ingest-message', 'widget-post',
      'request-human', 'unfollow-conversation', 'remove-participant', 'record-delivery', 'mark-notification-read'];
    // `submit-csat` is the customer's, legal only on a RESOLVED conversation, which a held
    // one never is — refused by the lifecycle before the queue, and not invoked here.
    const LIFECYCLE_ONLY = ['submit-csat'];
    // Reads and sweeps ACROSS conversations, with no id to refuse. Each is held to the queue
    // by its own case: the inbox reads in 'is in no inbox read…' and 'is found by search…',
    // the sweeps and counts in 'every sweep and count leaves the suspended queue alone…',
    // the relay's list in 'never offers the relay mail…'. `wake-snoozed` and `auto-close`
    // meet only snoozed and resolved rows, which a held conversation cannot become; a tag
    // read and the visitor's own list show what they show in every queue.
    const ACROSS = ['list-conversations', 'search-conversations', 'list-suspended', 'breaching-soon',
      'assign-round-robin', 'escalate-sla-breaches', 'auto-tag', 'auto-close', 'notify-no-reply', 'wake-snoozed',
      'reap-abandoned', 'desk-metrics', 'assistant-health', 'list-pending-outbound', 'list-conversations-by-tag',
      'my-conversations', 'my-notifications'];
    // Touch no conversation at all: the desk's settings, people, knowledge, saved replies,
    // prices, the widget's door before a conversation exists, and the waiting list.
    const UNRELATED = ['get-desk', 'list-behaviour-runs', 'configure-desk', 'rotate-verification-secret',
      'list-block-rules', 'add-block-rule', 'remove-block-rule', 'set-agent-profile', 'list-agents',
      'set-agent-offboarded', 'add-kb-source', 'list-kb-sources', 'ingest-kb-source', 'record-kb-articles',
      'record-kb-ingest-failure', 'mint-kb-refresh-token', 'revoke-kb-refresh-token', 'redeem-kb-refresh-token',
      'search-kb', 'search-contacts', 'list-contacts', 'get-contact', 'list-tags', 'list-saved-replies', 'create-saved-reply',
      'get-saved-reply', 'update-saved-reply', 'delete-saved-reply', 'share-saved-reply', 'list-saved-reply-folders',
      'create-saved-reply-folder', 'rename-saved-reply-folder', 'delete-saved-reply-folder', 'set-usage-rate', 'close-usage-period',
      'widget-origins', 'assistant-mode', 'widget-start', 'signup-origins', 'submit-signup', 'confirm-signup',
      'unsubscribe-signup', 'list-signups', 'signup-counts'];
    const d = await filtered({ agents: 1 });
    const guest = await kit.guest(d);
    const a = await admin(d);
    const held = (await visitor(d, linky(4, 'audit'))).conversationId;
    const heldMessage = (await messages(d, held))[0]!.id;
    const other = await kit.mail(d, { body: 'another' });
    const reply = (await a.invoke('ticket0/create-saved-reply', { title: 'Canned', body: 'Hello' })) as { id: string };
    // Who works it, and the input beside the id that reaches the held conversation.
    const WORK: Record<string, [string, Record<string, unknown>]> = {
      'post-note': ['admin', { body: 'note' }],
      'post-public-reply': ['admin', { body: 'Hi' }],
      assign: ['admin', { assignee: d.agents[0] }],
      'set-priority': ['admin', { priority: 'urgent' }],
      snooze: ['admin', { until: '2099-01-01T00:00:00.000Z' }],
      wake: ['admin', {}],
      resolve: ['admin', {}],
      close: ['admin', {}],
      merge: ['admin', { intoConversationId: other }],
      'tag-conversation': ['admin', { tag: 'x' }],
      'untag-conversation': ['admin', { tag: 'x' }],
      'follow-conversation': ['admin', { follower: guest }],
      // #1086: copying somebody in on junk, or forwarding it, is the desk mailing it on.
      'add-participant': ['admin', { email: 'colleague@customer.example' }],
      'forward-message': ['admin', { to: 'supplier@vendor.example', body: 'Do you know this sender?' }],
      'apply-saved-reply': ['admin', { savedReplyId: reply.id }],
      'record-answer': ['admin', {
        turnId: 'audit-turn', model: 'offline/extractive', body: 'draft', inputTokens: 0, outputTokens: 0,
        citedArticleIds: [], outcome: 'drafted',
      }],
      'record-assistant-failure': ['widget', { turnId: 'audit-fail', model: 'offline/extractive', error: 'down' }],
      // Reached through a message: a relay holding an id from before the suspension.
      'read-outbound': ['relay', { messageId: heldMessage }],
    };

    const all = Object.keys(ticket0Operations).map((name) => name.replace(/^ticket0\//, ''));
    const classified = [...READS, ...ALLOWED, ...LIFECYCLE_ONLY, ...ACROSS, ...UNRELATED, ...Object.keys(WORK)];
    expect(new Set(classified).size, 'an operation classified twice').toBe(classified.length);
    expect([...classified].sort()).toEqual([...all].sort());
    // And the cheap half of keeping the buckets honest: anything whose input can reach one
    // conversation is never filed as touching none, or as a sweep with no id to refuse.
    const REACHES = /^(conversationIds?|sessionId|messageId|notificationId)$/;
    const reaching = Object.entries(ticket0Operations)
      .filter(([, op]) => Object.keys((op as { input?: { shape?: object } }).input?.shape ?? {}).some((k) => REACHES.test(k)))
      .map(([name]) => name.replace(/^ticket0\//, ''));
    expect(reaching.filter((op) => UNRELATED.includes(op) || ACROSS.includes(op))).toEqual([]);

    for (const [op, [who, input]] of Object.entries(WORK)) {
      const stub = who === 'admin' ? a : await kit.as(d, who === 'widget' ? d.widget : d.relay);
      const target = 'messageId' in input ? input : { conversationId: held, ...input };
      await expect(stub.invoke(`ticket0/${op}`, target), op).rejects.toMatchObject(conflict('suspended'));
    }
    expect(await messages(d, held)).toHaveLength(1);
  });

  it('never offers the relay mail to send into a held conversation', async () => {
    // No operation can leave a pending reply on a held conversation — a public reply is
    // refused while held and moves a `new` one to `open` otherwise — so the row is placed
    // by hand. The predicate is defence in depth, and this is its proof.
    const d = await kit.freshDesk({ agents: 0 });
    const a = await admin(d);
    const relay = await kit.as(d, d.relay);
    const held = await kit.mail(d, { from: 'h@customer.example', body: 'one' });
    const kept = await kit.mail(d, { from: 'k@customer.example', body: 'two' });
    for (const id of [held, kept]) await a.invoke('ticket0/post-public-reply', { conversationId: id, body: 'Answer' });
    kit.sql(d, (db) => db.prepare("UPDATE ticket0_conversations SET quarantine = 'suspended' WHERE id = ?").run(held));
    const pending = (await relay.invoke('ticket0/list-pending-outbound', {})) as Page<{ conversationId: string }>;
    expect(pending.entries.map((p) => p.conversationId)).toEqual([kept]);
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

/**
 * The reviewer's repro (Codex round 1, #1973): a no-reply notice reached an agent, then
 * the conversation was suspended, and the notice stayed on their list for a thread they
 * could no longer work.
 */
describe('suspension retires what the desk was told about the conversation', () => {
  it('takes the alert off the list, leaves an accepted conversation’s, brings none back on restore, and notifies anew', async () => {
    const d = await filtered({ agents: 1 });
    await kit.configure(d, { noReplyNotify: { afterHours: 1 } });
    const a = await admin(d);
    const agent = d.agents[0]!;
    const held = await kit.mail(d, { from: 'later-held@customer.example', body: 'waiting' });
    const kept = await kit.mail(d, { from: 'kept@customer.example', body: 'also waiting' });
    kit.clock.advance(2 * 60 * 60 * 1000);
    expect(await kit.sweep(d, 'ticket0/notify-no-reply', 'notified')).toBe(2);
    const about = async (id: string) =>
      (await kit.notifications(d, agent)).filter((n) => n.conversation_id === id).length;
    expect([await about(held), await about(kept)]).toEqual([1, 1]);

    await a.invoke('ticket0/suspend', { conversationId: held });
    expect([await about(held), await about(kept)]).toEqual([0, 1]);

    // Restored: the old alert does not come back…
    await a.invoke('ticket0/restore', { conversationId: held });
    expect(await about(held)).toBe(0);
    // …and the next thing that happens notifies as it would for anything in the inbox.
    await kit.mail(d, { into: held, from: 'later-held@customer.example', body: 'still waiting' });
    kit.clock.advance(2 * 60 * 60 * 1000);
    expect(await kit.sweep(d, 'ticket0/notify-no-reply', 'notified')).toBe(1);
    expect(await about(held)).toBe(1);
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

  /**
   * CodeRabbit on #1973: a provider's error text can quote the conversation back, and the
   * turn it sits on stays for billing. The failure is recorded while the conversation is
   * still in the inbox, which a held one would refuse.
   */
  it('keeps the assistant’s turn for billing and drops the provider’s error text', async () => {
    const d = await filtered();
    const QUOTE = 'refused to answer: "my card 4111 was declined"';
    const chat = await visitor(d, 'my card 4111 was declined');
    await (await kit.as(d, d.widget)).invoke('ticket0/record-assistant-failure', {
      conversationId: chat.conversationId,
      turnId: 'quoting-turn',
      model: 'test/none',
      error: QUOTE,
    });
    const a = await admin(d);
    await a.invoke('ticket0/suspend', { conversationId: chat.conversationId });
    await a.invoke('ticket0/discard', { conversationId: chat.conversationId });

    const turns = ((await a.invoke('ticket0/list-turns', { conversationId: chat.conversationId })) as Page<{
      id: string;
      model: string;
      outcome: string;
      error: string | null;
    }>).entries;
    expect(turns).toEqual([expect.objectContaining({ id: 'quoting-turn', model: 'test/none', outcome: 'failed', error: null })]);
    const health = JSON.stringify(await a.invoke('ticket0/assistant-health', {}));
    expect(health).not.toContain('4111');
  });

  /**
   * The reviewer's repro (Codex round 3, #1973): `ticket0.assistant-failed` carried the
   * provider's error in its payload, so a quote of the customer outlived the discard in the
   * event trail — the one copy no column update reaches. Read the trail itself, every
   * payload of every event in the scope, after the discard.
   */
  it('leaves no event in the trail that says what the customer wrote or what the provider quoted', async () => {
    const d = await filtered();
    const WORDS = 'trail-needle-8812 my card was declined';
    const QUOTE = 'provider refused: "trail-needle-8812 my card was declined"';
    const chat = await visitor(d, WORDS);
    await say(d, chat, 'trail-needle-8812 again');
    await (await kit.as(d, d.widget)).invoke('ticket0/record-assistant-failure', {
      conversationId: chat.conversationId,
      turnId: 'trail-turn',
      model: 'test/none',
      error: QUOTE,
    });
    const trail = () =>
      kit.sql(d, (db) => db.prepare('SELECT type, payload FROM _substrat_outbox').all() as { type: string; payload: string }[]);
    // The failure was published, and published WITHOUT the text — before any discard.
    expect(trail().filter((e) => e.type === 'ticket0.assistant-failed')).toHaveLength(1);
    expect(trail().filter((e) => e.payload.includes('trail-needle'))).toEqual([]);
    // The probe can see the text where it does live, so the scan is not vacuous.
    expect(kit.sql(d, (db) => db.prepare('SELECT error FROM ticket0_ai_turns WHERE id = ?').get('trail-turn'))).toEqual({ error: QUOTE });

    const a = await admin(d);
    await a.invoke('ticket0/suspend', { conversationId: chat.conversationId });
    await a.invoke('ticket0/discard', { conversationId: chat.conversationId });
    expect(trail().filter((e) => e.payload.includes('trail-needle'))).toEqual([]);
    expect(kit.sql(d, (db) => db.prepare('SELECT error FROM ticket0_ai_turns WHERE id = ?').get('trail-turn'))).toEqual({ error: null });
  });

  /** CodeRabbit on #1973: every discarded row is `closed`, so the open-states default emptied the queue. */
  it('lists what was discarded in its own queue, and nowhere else', async () => {
    const d = await filtered();
    const held = (await visitor(d, linky(4, 'gone'))).conversationId;
    const kept = (await visitor(d, 'How do I rotate a key?')).conversationId;
    await (await admin(d)).invoke('ticket0/discard', { conversationId: held });
    const counted = (await (await admin(d)).invoke('ticket0/list-conversations', {
      queue: 'discarded',
    })) as CountedPage<Conversation>;
    expect(counted.entries.map((c) => c.id)).toEqual([held]);
    expect(counted.total).toBe(1);
    expect(await inbox(d, { queue: 'discarded', state: 'new' })).toEqual([]);
    expect(await inbox(d, { include_closed: true })).toEqual([kept]);
    expect(await inbox(d, { queue: 'suspended' })).toEqual([]);
  });

  /**
   * The reviewer's repro (Codex round 1, #1973): the filter ABSENT, a person suspends and
   * discards a mail, and the provider delivers the same Message-ID again. The dedupe used
   * to be the message row, which the discard had deleted, so the junk came back as a new
   * inbox conversation with its subject and body.
   */
  it('refuses a redelivery of a discarded mail, and still answers a kept one with its own message', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const a = await admin(d);
    const relay = await kit.as(d, d.relay);
    const deliver = (emailMessageId: string, subject: string, bodyText: string) =>
      relay.invoke('ticket0/ingest-message', {
        conversationId: null,
        contactEmail: 'once@junk.example',
        contactName: null,
        subject,
        bodyText,
        emailMessageId,
      }) as Promise<{ id: string; conversation_id: string }>;

    const junk = await deliver('<junk-1@junk.example>', 'REDELIVERED-SUBJECT', 'REDELIVERED-BODY');
    await a.invoke('ticket0/suspend', { conversationId: junk.conversation_id });
    await a.invoke('ticket0/discard', { conversationId: junk.conversation_id });
    const before = await inbox(d, { include_closed: true });

    await expect(deliver('<junk-1@junk.example>', 'REDELIVERED-SUBJECT', 'REDELIVERED-BODY')).rejects.toMatchObject({
      code: 'forbidden',
      message: DELIVERY_DISCARDED,
    });
    expect(await inbox(d, { include_closed: true })).toEqual(before);
    const hits = (await a.invoke('ticket0/search-conversations', { q: 'REDELIVERED' })) as Page<Conversation>;
    expect(hits.entries).toEqual([]);
    // The record that stopped it holds no words: the id, where it went, and that its message is gone.
    expect(
      kit.sql(d, (db) => db.prepare('SELECT * FROM ticket0_mail_deliveries WHERE email_message_id = ?').get('<junk-1@junk.example>')),
    ).toMatchObject({ conversation_id: junk.conversation_id, message_id: null, direction: 'inbound' });

    // The positive twin: a redelivery of mail the desk kept is the same message, once.
    const kept = await deliver('<kept-1@customer.example>', 'Kept', 'A real question');
    const again = await deliver('<kept-1@customer.example>', 'Kept', 'A real question');
    expect(again.id).toBe(kept.id);
    expect(await messages(d, kept.conversation_id)).toHaveLength(1);
  });

  it('recognises a Message-ID the desk SENT as already handled, as the dedupe always did', async () => {
    const d = await kit.freshDesk({ agents: 0 });
    const a = await admin(d);
    const relay = await kit.as(d, d.relay);
    const id = await kit.mail(d, { body: 'please reply' });
    const reply = (await a.invoke('ticket0/post-public-reply', { conversationId: id, body: 'Answered.' })) as {
      id: string;
    };
    await relay.invoke('ticket0/record-delivery', { messageId: reply.id, emailMessageId: '<sent-1@desk.example>' });
    const looped = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'loop@customer.example',
      contactName: null,
      subject: 'Re: loop',
      bodyText: 'the same mail, coming back in',
      emailMessageId: '<sent-1@desk.example>',
    })) as { id: string };
    expect(looped.id).toBe(reply.id);
  });

  it('revokes every follow on the conversation it discards, and leaves a follow elsewhere standing', async () => {
    const d = await filtered({ agents: 1 });
    const guest = await kit.guest(d);
    const a = await admin(d);
    const asGuest = await kit.as(d, guest);
    const doomed = await kit.mail(d, { from: 'doomed@customer.example', body: 'first' });
    const kept = await kit.mail(d, { from: 'kept@customer.example', body: 'second' });
    for (const id of [doomed, kept]) await a.invoke('ticket0/follow-conversation', { conversationId: id, follower: guest });
    await a.invoke('ticket0/suspend', { conversationId: doomed });
    await a.invoke('ticket0/discard', { conversationId: doomed });
    await expect(asGuest.invoke('ticket0/get-conversation', { conversationId: doomed })).rejects.toThrow(/denied/i);
    await asGuest.invoke('ticket0/get-conversation', { conversationId: kept });
    expect(
      kit.sql(d, (db) => db.prepare('SELECT conversation_id FROM ticket0_conversation_follows ORDER BY conversation_id').all()),
    ).toEqual([{ conversation_id: kept }]);
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
              manifest: { ...m.manifest, lists: listsBefore0021(listsBefore0025(m.manifest.lists ?? [])) },
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
    // A mail received, and a reply sent, before the delivery record existed — both are
    // Message-IDs the old dedupe recognised, so the upgrade must carry both across.
    const message = db.prepare(
      `INSERT INTO ticket0_messages (id, conversation_id, author_kind, visibility, body_text, email_message_id, created_at)
       VALUES (?, 'c1', ?, 'public', 'old', ?, '2026-01-01T00:00:00.000Z')`,
    );
    message.run('m1', 'contact', '<in@old.example>');
    message.run('m2', 'agent', '<out@desk.example>');
    message.run('m3', 'agent', null);
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
      expect(
        after
          .prepare('SELECT email_message_id, conversation_id, message_id, direction FROM ticket0_mail_deliveries ORDER BY message_id')
          .all(),
      ).toEqual([
        { email_message_id: '<in@old.example>', conversation_id: 'c1', message_id: 'm1', direction: 'inbound' },
        { email_message_id: '<out@desk.example>', conversation_id: 'c1', message_id: 'm2', direction: 'outbound' },
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

/**
 * No event carries text a customer or a third party wrote (Codex rounds 3–4, #1973). An
 * event is immutable and outlives every discard and every erasure, so a payload holding
 * such text is a copy nothing can take back.
 *
 * The set is the MODEL's, not a list kept here: every field an entity marks `erasable`
 * (the subject's personal data) or `outsideText` (a provider's or a site's text, a subject
 * line, a raw header). A column added tomorrow is covered by marking it where it is
 * declared, which is also where the compiler refuses it in an `emits.payload`. Two halves:
 * what the operations DECLARE, and what the desk actually EMITS — every event of a seeded
 * world and of the queue's own flows, by key and by value.
 */
describe('events carry no outside text', () => {
  type Def = { table: string; fields: { shape: Record<string, unknown> }; erasable?: readonly string[]; outsideText?: readonly string[] };
  const defs = ticket0Entities as unknown as Record<string, Def>;
  const outside = (entity: string): string[] => [...(defs[entity]?.erasable ?? []), ...(defs[entity]?.outsideText ?? [])];

  /** Every declared payload field, as `entity.field`, that the entity marks outside text. */
  const offending = (ops: Record<string, unknown>) =>
    Object.values(ops).flatMap((op) => {
      const emits = (op as { emits?: { entity: string; type: string; payload?: readonly string[] } }).emits;
      return emits ? (emits.payload ?? []).filter((f) => outside(emits.entity).includes(f)).map((f) => `${emits.type}: ${emits.entity}.${f}`) : [];
    });

  it('marks the columns that hold such text, so the set is the model’s', () => {
    // A floor, not the list: the columns this PR found carrying outside text are marked.
    for (const [entity, field] of [
      ['message', 'body_text'], ['aiTurn', 'error'], ['kbSource', 'last_error'], ['conversation', 'subject'],
      ['blockRule', 'value'], ['kbArticle', 'body'], ['widgetSession', 'user_agent'], ['contact', 'email'],
      // Codex round 5: inbound headers, remote links, and the browser's and the edge's own words.
      ['message', 'email_message_id'], ['message', 'email_in_reply_to'], ['mailDelivery', 'email_message_id'],
      ['kbArticle', 'url'], ['contact', 'external_id'], ['widgetOpening', 'city'], ['widgetSession', 'language'],
    ] as const) {
      expect(outside(entity), `${entity}.${field}`).toContain(field);
    }
  });

  it('declares no payload field the model marks as outside text', () => {
    expect(offending(ticket0Operations)).toEqual([]);
  });

  it('would catch one: a payload naming a marked column is found', () => {
    // kb-ingest-failed as v1 declared it, with the remote's error on the payload.
    const v1 = { fail: { emits: { entity: 'kbSource', type: 'ticket0.kb-ingest-failed', payload: ['id', 'url', 'last_error'] } } };
    expect(offending(v1)).toEqual(['ticket0.kb-ingest-failed: kbSource.last_error']);
  });

  /**
   * The runtime half, by SENTINEL (Codex round 5). A unique string is planted in every
   * marked column the desk can be made to write, through the operations that write it,
   * on a seeded world, and checked to be there BEFORE anything is discarded. Then the
   * queue runs — held, restored, discarded — and every payload of every event in the
   * outbox is searched for every sentinel, whatever key it might sit under. The model's
   * list of marked columns is what the plantings are held to: one added tomorrow fails
   * here until it is planted or exempted with its reason.
   */
  it('emits none: no event holds a planted sentinel from any marked column, under any key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket0-outside-text-'));
    try {
      const host = buildHost(dir);
      const world = await seed(host);
      const desk = world.substrat;
      const as = (p: { principal: PrincipalId }) => host.getScope(p.principal, desk.tenant, desk.scope);
      const admin = await as(desk.admin);
      const relay = await as(desk.relay);
      const widget = await as(desk.widget);
      const tag = ulid().slice(-8).toLowerCase();
      const sentinel = (column: string) => `snt${tag}${column.replace(/[^a-z]/gi, '').toLowerCase()}`;
      const planted = new Map<string, string>();
      const plant = (column: string, shape: (s: string) => string = (s) => s) => {
        const value = shape(sentinel(column));
        planted.set(column, value);
        return value;
      };
      const asEmail = (s: string) => `${s}@sentinel.example`;
      const asUrl = (s: string) => `https://sentinel.example/${s}`;
      const asMessageId = (s: string) => `<${s}@sentinel.example>`;
      // Not plantable, and why. Anything else the model marks must be planted below.
      const EXEMPT: Record<string, string> = {
        'widgetSession.country': 'a validated two-letter country code, cannot hold a sentinel',
        'widgetOpening.country': 'a validated two-letter country code, cannot hold a sentinel',
      };

      await admin.invoke('ticket0/configure-desk', { settings: { spamFilter: {} } });

      // The widget: a vouched visitor whose browser and edge say sentinel things.
      const client = (prefix: string) => ({
        userAgent: plant(`${prefix}.user_agent`),
        language: plant(`${prefix}.language`),
        device: {
          browser: plant(`${prefix}.browser`), browserVersion: plant(`${prefix}.browser_version`),
          os: plant(`${prefix}.os`), osVersion: plant(`${prefix}.os_version`), kind: 'desktop' as const,
        },
        geo: {
          country: 'SE', region: plant(`${prefix}.region`), city: plant(`${prefix}.city`),
          timezone: plant(`${prefix}.timezone`), continent: 'EU',
        },
      });
      const { secret } = (await admin.invoke('ticket0/rotate-verification-secret', {})) as { secret: string };
      const externalId = plant('contact.external_id');
      const origin = ((await widget.invoke('ticket0/widget-origins', {})) as { origins: string[] }).origins[0]!;
      const started = (await widget.invoke('ticket0/widget-start', {
        origin,
        client: client('widgetSession'),
        identity: {
          externalId,
          signature: await signIdentity(secret, externalId),
          email: plant('contact.email', asEmail),
          displayName: plant('contact.display_name'),
        },
      })) as { sessionId: string; token: string };
      const posted = (await widget.invoke('ticket0/widget-post', { ...started, body: 'a widget question' })) as {
        conversation_id: string;
      };
      // An opening that never speaks keeps its own client columns.
      await widget.invoke('ticket0/widget-start', { origin, client: client('widgetOpening') });

      // Mail from a stranger, every header and body field a sentinel — held by the filter.
      const junk = (await relay.invoke('ticket0/ingest-message', {
        conversationId: null,
        contactEmail: `held${tag}@sentinel.example`,
        contactName: null,
        subject: plant('conversation.subject'),
        bodyText: `${plant('message.body_text')} ${linky(4, tag)}`,
        bodyHtml: `<p>${plant('message.body_html')}</p>`,
        emailMessageId: plant('message.email_message_id', asMessageId),
        emailInReplyTo: plant('message.email_in_reply_to', asMessageId),
      })) as { conversation_id: string };
      planted.set('mailDelivery.email_message_id', planted.get('message.email_message_id')!);

      // The assistant's failure, quoting; a remote's failure; a fetched article; a block
      // rule; a staff profile; a signup; a customer's rating.
      await widget.invoke('ticket0/record-assistant-failure', {
        conversationId: posted.conversation_id, turnId: `turn-${tag}`, model: 'test/none', error: plant('aiTurn.error'),
      });
      const sourceId = ((await admin.invoke('ticket0/list-kb-sources', {})) as Page<{ id: string }>).entries[0]!.id;
      await admin.invoke('ticket0/record-kb-articles', {
        sourceId,
        articles: [{
          url: plant('kbArticle.url', asUrl), title: plant('kbArticle.title'),
          headingPath: plant('kbArticle.heading_path'), body: plant('kbArticle.body'),
        }],
      });
      await admin.invoke('ticket0/record-kb-ingest-failure', { sourceId, error: plant('kbSource.last_error') });
      await admin.invoke('ticket0/add-block-rule', { kind: 'email', value: plant('blockRule.value', asEmail) });
      await admin.invoke('ticket0/set-agent-profile', {
        displayName: plant('agentProfile.display_name'),
        avatarUrl: plant('agentProfile.avatar_url', asUrl),
        signature: plant('agentProfile.signature'),
      });
      const signupOrigin = ((await (await as(desk.signup)).invoke('ticket0/signup-origins', {})) as { origins: string[] }).origins[0]!;
      await (await as(desk.signup)).invoke('ticket0/submit-signup', {
        kind: 'waitlist', email: plant('signup.email', asEmail), note: plant('signup.note'), origin: signupOrigin,
      });
      const rated = (await relay.invoke('ticket0/ingest-message', {
        conversationId: null, contactEmail: desk.customer.email, contactName: desk.customer.name,
        subject: 'A rated question', bodyText: 'please help', emailMessageId: `<rated-${tag}@mail.example>`,
      })) as { conversation_id: string };
      await admin.invoke('ticket0/post-public-reply', { conversationId: rated.conversation_id, body: 'Done.' });
      await admin.invoke('ticket0/resolve', { conversationId: rated.conversation_id });
      await (await as(desk.customer)).invoke('ticket0/submit-csat', {
        conversationId: rated.conversation_id, score: 5, comment: plant('csat.comment'),
      });

      const file = join(dir, `${desk.tenant}__${desk.scope}.sqlite`);
      const read = <T,>(fn: (db: Database.Database) => T): T => {
        const db = new Database(file, { readonly: true });
        try { return fn(db); } finally { db.close(); }
      };
      // Held to the model: every marked column is planted or exempted, and every planting
      // is really in its column before the queue runs.
      const markedColumns = Object.entries(defs).flatMap(([entity]) => outside(entity).map((f) => `${entity}.${f}`));
      expect(markedColumns.filter((c) => !planted.has(c) && !(c in EXEMPT)), 'marked but never planted').toEqual([]);
      const missing = read((db) =>
        [...planted].filter(([column, value]) => {
          const [entity, field] = column.split('.') as [string, string];
          return !db.prepare(`SELECT 1 FROM ${defs[entity]!.table} WHERE instr(${field}, ?) > 0`).get(value);
        }).map(([column]) => column),
      );
      expect(missing, 'planted, but not in its column').toEqual([]);

      // The queue runs: the junk was held; a person discards it; the widget conversation is
      // suspended by hand and discarded too.
      expect((await admin.invoke('ticket0/get-conversation', { conversationId: junk.conversation_id })) as { quarantine: string })
        .toMatchObject({ quarantine: 'suspended' });
      await admin.invoke('ticket0/discard', { conversationId: junk.conversation_id });
      await admin.invoke('ticket0/suspend', { conversationId: posted.conversation_id });
      await admin.invoke('ticket0/discard', { conversationId: posted.conversation_id });

      const sentinels = [...planted.values()];
      const leaks = (events: { type: string; payload: string | null }[]) =>
        events.flatMap((e) => sentinels.filter((v) => e.payload?.includes(v)).map((v) => `${e.type} holds ${v}`));
      const outbox = () =>
        read((db) => db.prepare('SELECT id, type, entity_type, payload FROM _substrat_outbox').all() as {
          id: string; type: string; entity_type: string; payload: string | null;
        }[]);
      const events = outbox();
      expect(events.length).toBeGreaterThan(50);
      expect(leaks(events)).toEqual([]);
      // And by key, against the model, on every event.
      const byKey = events.flatMap((e) =>
        Object.keys(e.payload ? (JSON.parse(e.payload) as object) : {})
          .filter((k) => outside(e.entity_type).includes(k))
          .map((k) => `${e.type}: ${e.entity_type}.${k}`),
      );
      expect(byKey).toEqual([]);

      // The positive twin: an event that copies discarded junk under a key no marker names
      // — what a careless new emitter would write — is caught.
      const db = new Database(file);
      try {
        db.prepare(
          `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
             entity_type, entity_id, pii_class, payload)
           SELECT 'leak-${tag}', 'ticket0.careless-summary', 1, occurred_at, tenant_id, scope_id, actor,
                  'conversation', entity_id, 'none', ?
             FROM _substrat_outbox LIMIT 1`,
        ).run(JSON.stringify({ id: junk.conversation_id, summary: planted.get('conversation.subject') }));
      } finally {
        db.close();
      }
      expect(leaks(outbox())).toEqual([`ticket0.careless-summary holds ${planted.get('conversation.subject')}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
