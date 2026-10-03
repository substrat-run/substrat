/** #1554, the second pass (0023): the desk reads that still scanned, measured on an upgraded,
 * populated scope with every competing index the kernel derives. Each new index is the one its
 * read names; removing it must lose that seek. The SQL is held to what the handlers send. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES } from '../src/provision.js';
import { ticket0Manifest } from '../src/manifest.js';
import { createKit, type Desk, type Kit } from './desk-kit.js';
import { DESK_READS, DESK_READ_INDEXES, INBOX_PAGES, SUSPENDED_QUEUE, planUsesIndex, type DeskRead } from './desk-read-shapes.js';

type Shape = { sql: string; args: readonly (string | number)[] };
const reads = Object.entries(DESK_READS) as [string, DeskRead][];
const AGENTS = ['agent-0', 'agent-1', 'agent-2', 'agent-3'];
const CONVERSATIONS = 3000;
const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();

let dir: string;
let db: Database.Database;
let indexesBefore: string[];
let beforeRows: unknown;
let beforeResults: unknown;
let beforePages: Record<string, string[]>;
/** Every statement the handlers prepared while the producer desk was driven. */
let sent: Set<string>;
let kit: Kit;

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
function explain(shape: Shape): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${shape.sql}`).all(...shape.args) as { detail: string }[]).map((r) => r.detail);
}
function indexes(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ticket0_%' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
}
/** The literal tables a desk read touches, in a stable order. Fixture facts, not the model's. */
function rows() {
  return [
    'SELECT * FROM ticket0_conversations ORDER BY id',
    'SELECT * FROM ticket0_notifications ORDER BY id',
    'SELECT * FROM ticket0_widget_sessions ORDER BY id',
    'SELECT * FROM ticket0_mail_deliveries ORDER BY email_message_id',
    'SELECT * FROM ticket0_messages ORDER BY id',
    'SELECT * FROM ticket0_conversation_follows ORDER BY principal, conversation_id',
  ].map((sql) => db.prepare(sql).all());
}
/** What every read answers, for the reads that answer (the writes are planned, not run). */
function results() {
  return Object.fromEntries(
    reads.filter(([, r]) => /^\s*SELECT/.test(r.sql)).map(([name, r]) => [name, db.prepare(r.sql).all(...r.args)]),
  );
}

/**
 * A desk that has been running: most of its history closed, a live inbox, a held queue and a
 * few tombstones, mail with Message-IDs and widget chats with sessions, notifications for
 * several people, and follows. The stand-in ids the shapes bind (`c-plan`, `agent-1`) are
 * among the rows, so each read's result is a real one.
 */
function populate() {
  const contact = db.prepare('INSERT INTO ticket0_contacts (id, email, created_at) VALUES (?, ?, ?)');
  const conversation = db.prepare(`INSERT INTO ticket0_conversations
    (id, contact_id, channel, subject, state, assignee, priority, created_at, updated_at, quarantine)
    VALUES (?, ?, ?, 'Fixture', ?, ?, ?, ?, ?, ?)`);
  const message = db.prepare(`INSERT INTO ticket0_messages
    (id, conversation_id, author_kind, visibility, body_text, email_message_id, created_at)
    VALUES (?, ?, ?, 'public', 'Fixture', ?, ?)`);
  const notification = db.prepare(`INSERT INTO ticket0_notifications (id, principal, kind, conversation_id, read_at, created_at)
    VALUES (?, ?, 'replied', ?, NULL, ?)`);
  const session = db.prepare(`INSERT INTO ticket0_widget_sessions
    (id, conversation_id, contact_id, origin, token_hash, started_at, last_seen_at) VALUES (?, ?, ?, 'https://desk.example', ?, ?, ?)`);
  const delivery = db.prepare(`INSERT INTO ticket0_mail_deliveries (email_message_id, conversation_id, message_id, direction, recorded_at)
    VALUES (?, ?, ?, 'inbound', ?)`);
  const follow = db.prepare('INSERT INTO ticket0_conversation_follows (principal, conversation_id) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 0; i < CONVERSATIONS; i++) {
      const id = i === 0 ? 'c-plan' : `c${String(i).padStart(5, '0')}`;
      const k = `k${i % 1000}`;
      if (i < 1000) contact.run(k, `person-${i}@customer.example`, at(i));
      const live = i % 10 === 0;
      const state = live ? ['new', 'open', 'snoozed', 'resolved'][(i / 10) % 4]! : 'closed';
      const quarantine = i % 97 === 0 ? 'suspended' : i % 89 === 0 ? 'discarded' : null;
      const channel = i % 2 === 0 ? 'email' : 'widget';
      conversation.run(id, k, channel, state, state === 'new' ? null : AGENTS[i % 4]!,
        ['low', 'normal', 'urgent'][i % 3]!, at(i), at(i + 1), quarantine);
      for (let j = 0; j < 3; j++) {
        const mail = channel === 'email' && j !== 1 ? `<${id}-${j}@mail.example>` : null;
        message.run(`${id}-m${j}`, id, j === 1 ? 'agent' : 'contact', mail, at(i));
        if (mail) delivery.run(mail, id, `${id}-m${j}`, at(i));
      }
      for (let j = 0; j < 3; j++) notification.run(`${id}-n${j}`, AGENTS[(i + j) % 4]!, id, at(i));
      if (channel === 'widget' || id === 'c-plan') session.run(`${id}-s`, id, k, `hash-${id}`, at(i), at(i + 1));
      if (i % 3 === 0) follow.run(AGENTS[i % 4]!, id);
    }
    // The one the thread read looks up: an inbound mail the shape's Message-ID names.
    message.run('m-plan', 'c-plan', 'contact', '<m@mail.example>', at(0));
  })();
}

/**
 * Drive every handler a shape names on a desk of the CURRENT version, and record the text each
 * one prepares. Through the driver because that is where the statement exists as text; the
 * host prepares on the same `better-sqlite3` this suite imports.
 */
async function produce(): Promise<Set<string>> {
  kit = createKit('ticket0-desk-reads-');
  const desk: Desk = await kit.freshDesk({ agents: 1 });
  const agent: PrincipalId = desk.agents[0]!;
  const admin = await kit.as(desk, desk.admin);
  const relay = await kit.as(desk, desk.relay);
  const seen = new Set<string>();
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    seen.add(squash(sql));
    return prepare.call(this, sql);
  });
  try {
    // A mail, assigned (a notification), answered by the customer by In-Reply-To, followed.
    const mailed = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null, contactEmail: 'ana@customer.example', contactName: null,
      subject: 'Plans', bodyText: 'Hello.', emailMessageId: '<first@mail.example>',
    })) as { conversation_id: string };
    const first = mailed.conversation_id;
    await admin.invoke('ticket0/assign', { conversationId: first, assignee: agent });
    await relay.invoke('ticket0/ingest-message', {
      conversationId: null, contactEmail: 'ana@customer.example', contactName: null,
      subject: 'Re: Plans', bodyText: 'Still here.', emailMessageId: '<second@mail.example>',
      emailInReplyTo: '<first@mail.example>',
    });
    await admin.invoke('ticket0/follow-conversation', { conversationId: first, follower: agent });
    await admin.invoke('ticket0/list-participants', { conversationId: first });
    const mine = await kit.as(desk, agent);
    await mine.invoke('ticket0/my-notifications', {});
    await mine.invoke('ticket0/my-notifications', { cursor: '0' });
    // A widget chat, and the rail's read of its session.
    const { conversationId: chat } = await kit.chat(desk);
    await admin.invoke('ticket0/widget-session', { conversationId: chat });
    // The inbox, unfiltered, by each filter, and the held queue.
    for (const input of [{}, { state: 'new' }, { channel: 'email' }, { priority: 'urgent' }, { assignee: agent }, { queue: 'suspended' }]) {
      await admin.invoke('ticket0/list-conversations', input);
    }
    // Merge two of one contact's conversations; suspend, list and discard a third.
    const loser = await kit.mail(desk, { from: 'bo@customer.example' });
    const survivor = await kit.mail(desk, { from: 'bo@customer.example' });
    await admin.invoke('ticket0/follow-conversation', { conversationId: loser, follower: agent });
    await admin.invoke('ticket0/merge', { conversationId: loser, intoConversationId: survivor });
    const junk = await kit.mail(desk, { from: 'junk@spam.example' });
    await admin.invoke('ticket0/suspend', { conversationId: junk });
    await admin.invoke('ticket0/list-suspended', {});
    await admin.invoke('ticket0/discard', { conversationId: junk });
  } finally {
    spy.mockRestore();
  }
  return seen;
}

beforeAll(async () => {
  sent = await produce();

  dir = mkdtempSync(join(tmpdir(), 'ticket0-desk-reads-'));
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  const provision = { tenantId: tenant, scopeId: scope, vertical: 'ticket0' };
  // The version this upgrades FROM: everything through 0022.
  const previous = new SqliteScopeHost({ dir });
  for (const module of MODULES) previous.registerModule(module.manifest.id === ticket0Manifest.id
    ? { ...module, migrations: (module.migrations ?? []).filter((m) => m.version <= '0022') }
    : module);
  try {
    await previous.admin.createTenant(actor, { id: tenant, slug: 'desk-reads', name: 'Desk reads' });
    await previous.admin.grantEntitlement(actor, tenant, ticket0Manifest.entitlementKey as string);
    await previous.provisionScope(actor, provision);
  } finally { await previous.close(); }
  const filename = join(dir, `${tenant}__${scope}.sqlite`);
  db = new Database(filename);
  populate();
  indexesBefore = indexes();
  beforeRows = rows();
  beforeResults = results();
  beforePages = Object.fromEntries(Object.entries(INBOX_PAGES).map(([name, page]) => [name, explain(page)]));
  db.close();
  const upgraded = new SqliteScopeHost({ dir });
  for (const module of MODULES) upgraded.registerModule(module);
  try {
    await upgraded.provisionScope(actor, provision);
    // A second provision applies nothing and changes nothing.
    await upgraded.provisionScope(actor, provision);
  } finally { await upgraded.close(); }
  db = new Database(filename);
}, 60_000);

afterAll(() => {
  db?.close();
  kit?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('every shape is a statement the handlers send, as they send it', () => {
  const missing = [
    ...reads.map(([name, r]) => [name, r.sql] as const),
    ...Object.entries(INBOX_PAGES).map(([name, p]) => [`page:${name}`, p.sql] as const),
    ['suspendedQueue', SUSPENDED_QUEUE.sql] as const,
  ]
    .filter(([, sql]) => !sent.has(squash(sql)))
    .map(([name]) => name);
  expect(missing).toEqual([]);
});

it('0023 adds exactly its seven indexes, and keeps every row and every read result across provisioning twice', () => {
  expect(indexes().filter((name) => !indexesBefore.includes(name)).sort()).toEqual([...DESK_READ_INDEXES].sort());
  expect(indexesBefore.filter((name) => !indexes().includes(name))).toEqual([]);
  expect(rows()).toEqual(beforeRows);
  expect(results()).toEqual(beforeResults);
  // Non-empty answers, so "the same" is not two empty lists agreeing.
  const answers = results() as Record<string, unknown[]>;
  // 300 live conversations, less the seven of them held: four suspended, three discarded.
  expect(answers.inboxCount).toEqual([{ n: 293 }]);
  expect(answers.suspendedCount).toEqual([{ n: 4 }]);
  expect(answers.myNotifications).toHaveLength(51);
  expect(answers.widgetSession).toHaveLength(1);
  expect(answers.threadRepliedTo).toEqual([{ conversation_id: 'c-plan' }]);
  expect(answers.followers).toEqual([{ principal: 'agent-0' }]);
});

it('the inbox pages plan exactly as they did: 0023 moves none of them', () => {
  for (const [name, page] of Object.entries(INBOX_PAGES)) {
    expect(explain(page), name).toEqual(beforePages[name]);
    expect(explain(page).some((d) => d.startsWith('USE TEMP B-TREE')), name).toBe(false);
  }
});

it('list-suspended reads the queue through its partial index in id order, and only because it is pinned', () => {
  const plan = explain(SUSPENDED_QUEUE);
  expect(plan).toContainEqual(expect.stringMatching(/USING INDEX ticket0_conversations_suspended\b/));
  expect(plan.some((d) => d.startsWith('USE TEMP B-TREE'))).toBe(false);
  // Unpinned, the planner takes the kernel's quarantine index and sorts the whole queue.
  const unpinned = explain({ ...SUSPENDED_QUEUE, sql: SUSPENDED_QUEUE.sql.replace(' INDEXED BY ticket0_conversations_suspended', '') });
  expect(unpinned).toContainEqual('USE TEMP B-TREE FOR ORDER BY');
});

describe.each([false, true])('planner with ANALYZE=%s', (analyzed) => {
  const cases = reads.filter(([, r]) => !analyzed || r.withStatistics).map(([name, read]) => ({ name, read }));
  it.each(cases)('$name seeks $read.index; dropping it defeats the same assertion', ({ read }) => {
    db.exec('SAVEPOINT probe');
    try {
      if (analyzed) db.exec('ANALYZE');
      const assertion = () => expect(planUsesIndex(read, explain(read))).toBeNull();
      assertion();
      db.exec(`DROP INDEX ${read.index}`);
      // The mutation twin: the identical positive assertion, with only this index reverted.
      expect(assertion).toThrow();
    } finally { db.exec('ROLLBACK TO probe; RELEASE probe'); }
  });

  if (analyzed) {
    // Stated rather than skipped: with statistics, which the platform never collects, these
    // two counts go back to their single-column kernel index. Without, they are covered above.
    it.each(reads.filter(([, r]) => !r.withStatistics).map(([name, read]) => ({ name, read })))(
      '$name leaves $read.index once statistics exist',
      ({ read }) => {
        db.exec('SAVEPOINT probe');
        try {
          db.exec('ANALYZE');
          expect(planUsesIndex(read, explain(read))).not.toBeNull();
        } finally { db.exec('ROLLBACK TO probe; RELEASE probe'); }
      },
    );
  }
});
