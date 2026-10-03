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
import { createKit, type Desk } from './desk-kit.js';
import { DESK_TABLES, populateDesk } from './desk-fixture.js';
import {
  DESK_READS, DESK_READ_INDEXES, INBOX_PAGES, SUSPENDED_QUEUE, planUsesIndex, sorts, type DeskRead, type Shape,
} from './desk-read-shapes.js';

const reads = Object.entries(DESK_READS) as [string, DeskRead][];
const CONVERSATIONS = 3000;

let dir: string;
let db: Database.Database;
let indexesBefore: string[];
let beforeRows: unknown;
let beforeResults: unknown;
let beforePages: Record<string, string[]>;
/** Every statement the handlers prepared while the producer desk was driven. */
let sent: Set<string>;

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
function explain(shape: Shape): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${shape.sql}`).all(...shape.args) as { detail: string }[]).map((r) => r.detail);
}
function indexes(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ticket0_%' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
}
function rows() {
  return DESK_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
/** What every read answers, for the reads that answer (the writes are planned, not run). */
function results(): Record<string, unknown[]> {
  return Object.fromEntries(
    reads.filter(([, r]) => /^\s*SELECT/.test(r.sql)).map(([name, r]) => [name, db.prepare(r.sql).all(...r.args)]),
  );
}
/** Run `fn` inside a savepoint that is rolled back, so an index it drops comes back. */
function probe(fn: () => void): void {
  db.exec('SAVEPOINT probe');
  try { fn(); } finally { db.exec('ROLLBACK TO probe; RELEASE probe'); }
}

/**
 * Drive every handler a shape names on a desk of the CURRENT version, and record the text each
 * one prepares. Through the driver because that is where the statement exists as text; the
 * host prepares on the same `better-sqlite3` this suite imports.
 */
async function produce(): Promise<Set<string>> {
  const kit = createKit('ticket0-desk-reads-');
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
    kit.dispose();
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
  const statements = new Map<string, Database.Statement>();
  db.transaction(() => populateDesk((sql, ...args) => {
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    statement.run(...args);
  }, CONVERSATIONS))();
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('every shape is a statement the handlers send, as they send it', () => {
  const missing = [
    ...reads.map(([name, r]) => [`${name} (${r.operation})`, r.sql] as const),
    ...Object.entries(INBOX_PAGES).map(([name, p]) => [`page:${name}`, p.sql] as const),
    ['suspendedQueue', SUSPENDED_QUEUE.sql] as const,
  ]
    .filter(([, sql]) => !sent.has(squash(sql)))
    .map(([name]) => name);
  expect(missing).toEqual([]);
});

it('0023 adds exactly its seven indexes, and keeps every row and every read result across provisioning twice', () => {
  const after = indexes();
  expect(after.filter((name) => !indexesBefore.includes(name)).sort()).toEqual([...DESK_READ_INDEXES].sort());
  expect(indexesBefore.filter((name) => !after.includes(name))).toEqual([]);
  expect(rows()).toEqual(beforeRows);
  const answers = results();
  expect(answers).toEqual(beforeResults);
  // Non-empty answers, so "the same" is not two empty lists agreeing.
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
    const plan = explain(page);
    expect(plan, name).toEqual(beforePages[name]);
    expect(sorts(plan), name).toBe(false);
  }
});

it('list-suspended reads the queue through its partial index in id order, and only because it is pinned', () => {
  const plan = explain(SUSPENDED_QUEUE);
  expect(plan).toContainEqual(expect.stringMatching(/USING INDEX ticket0_conversations_suspended\b/));
  expect(sorts(plan)).toBe(false);
  // Unpinned, the planner takes the kernel's quarantine index and sorts the whole queue.
  expect(sorts(explain({ ...SUSPENDED_QUEUE, sql: SUSPENDED_QUEUE.sql.replace(' INDEXED BY ticket0_conversations_suspended', '') }))).toBe(true);
});

/** Each read seeks its index, and dropping that index alone makes the identical assertion fail. */
function seeksItsIndex({ read }: { read: DeskRead }): void {
  probe(() => {
    const assertion = () => expect(planUsesIndex(read, explain(read))).toBeNull();
    assertion();
    db.exec(`DROP INDEX ${read.index}`);
    expect(assertion).toThrow();
  });
}
const cases = (keep: (read: DeskRead) => boolean) => reads.filter(([, r]) => keep(r)).map(([name, read]) => ({ name, read }));

describe('without statistics, the plan production runs', () => {
  it.each(cases(() => true))('$name seeks $read.index; dropping it defeats the same assertion', seeksItsIndex);
});

// Last, because the statistics stay: each case's savepoint rolls back only its own DROP INDEX.
describe('with statistics, which the platform never collects', () => {
  beforeAll(() => { db.exec('ANALYZE'); });
  it.each(cases((r) => r.withStatistics))('$name seeks $read.index; dropping it defeats the same assertion', seeksItsIndex);
  // Stated rather than skipped: these counts go back to their single-column kernel index.
  it.each(cases((r) => !r.withStatistics))('$name leaves $read.index once statistics exist', ({ read }) => {
    expect(planUsesIndex(read, explain(read))).not.toBeNull();
  });
});
