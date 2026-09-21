/**
 * Round-robin — the first of the desk's built-in behaviours (#1083).
 *
 * Every claim the handler's comments make is driven here rather than taken on trust,
 * and each one in both directions: a suite that only watched round-robin assign would
 * pass against a handler that assigned everything, and one that only watched it hold
 * back would pass against a handler that did nothing.
 *
 * Each block builds its OWN desk rather than reading the seeded two. The seeded
 * inbox is full of conversations nobody picked up, and the ring is the desk's whole
 * directory. Asserting "the next person" means knowing exactly who is on the desk and
 * exactly what is waiting, and a shared world would make every count here a fact about
 * whichever test ran first.
 *
 * Time moves on purpose, on a `manualClock`: round-robin hands out the OLDEST waiting
 * conversation first, and a minute between arrivals is what makes "oldest" an answer
 * rather than a tie.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  moduleId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { ticket0Manifest } from '../src/manifest.js';
import { ASSISTANT_NAME } from '../src/module.js';
import { ROLES } from '../src/provision.js';
import { buildHost } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let clock: ManualClock;

const TICKET0 = moduleId.parse(ticket0Manifest.id);
const staff = platformActorId.parse(ulid());
const ORIGIN = 'https://desk.example';

interface Desk {
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly admin: PrincipalId;
  readonly relay: PrincipalId;
  readonly widget: PrincipalId;
  readonly assistant: PrincipalId;
  readonly assistantAutonomous: PrincipalId;
  /** The people in the ring, in the order they joined — NOT ring order. */
  readonly agents: PrincipalId[];
}

interface Conversation {
  id: string;
  state: string;
  assignee: string | null;
  first_assigned_at: string | null;
}

let desks = 0;

/**
 * A desk whose directory is exactly what the test says it is.
 *
 * Both assistants have a profile, as they do on a real desk (their messages need a
 * byline), so every ring here is a ring the assistant is IN the directory of and must
 * be left out of. The admin has none: they configure the desk and are not in line.
 */
async function freshDesk(opts: { agents: number; autonomous?: boolean }): Promise<Desk> {
  desks += 1;
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: tenant, slug: `round-robin-${desks}`, name: `Desk ${desks}` });
  await host.admin.grantEntitlement(staff, tenant, ticket0Manifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);

  const node = { tenantId: tenant, scopeId: scope };
  const mint = async (roleKey: string) => {
    const p = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: p, roleKey, node });
    return p;
  };

  const admin = await mint('desk-admin');
  const relay = await mint('relay');
  const widget = await mint('widget');
  const assistant = await mint('assistant');
  const assistantAutonomous = await mint('assistant-autonomous');

  const adminStub = await host.getScope(admin, tenant, scope);
  await adminStub.invoke('ticket0/configure-desk', {
    allowedOrigins: [ORIGIN],
    assistantAutonomous: opts.autonomous ?? false,
  });
  for (const who of [assistant, assistantAutonomous]) {
    await (await host.getScope(who, tenant, scope)).invoke('ticket0/set-agent-profile', {
      displayName: ASSISTANT_NAME,
      avatarUrl: null,
      signature: null,
    });
  }

  const desk: Desk = { tenant, scope, admin, relay, widget, assistant, assistantAutonomous, agents: [] };
  for (let i = 0; i < opts.agents; i++) await hire(desk);
  return desk;
}

/** Somebody starts working this desk: an agent role, and the profile that puts them in the directory. */
async function hire(desk: Desk): Promise<PrincipalId> {
  const p = principalId.parse(ulid());
  await host.admin.assignRole(staff, {
    principalId: p,
    roleKey: 'agent',
    node: { tenantId: desk.tenant, scopeId: desk.scope },
  });
  await (await host.getScope(p, desk.tenant, desk.scope)).invoke('ticket0/set-agent-profile', {
    displayName: `Agent ${desk.agents.length + 1}`,
    avatarUrl: null,
    signature: null,
  });
  desk.agents.push(p);
  return p;
}

const as = (desk: Desk, who: PrincipalId): Promise<ScopeStub> => host.getScope(who, desk.tenant, desk.scope);

/** The desk's own timer, as the platform sweep invokes it: the module's system actor. */
async function sweep(desk: Desk): Promise<number> {
  const stub = await host.getSystemScope(TICKET0, desk.tenant, desk.scope);
  return ((await stub.invoke('ticket0/assign-round-robin')) as { assigned: number }).assigned;
}

async function switchRoundRobin(desk: Desk, on: boolean): Promise<void> {
  await (await as(desk, desk.admin)).invoke('ticket0/configure-desk', { settings: { roundRobin: on } });
}

let mails = 0;

/** A mail arrives, a minute after whatever arrived before it. Returns the conversation. */
async function mail(desk: Desk, opts: { from?: string; emailMessageId?: string } = {}): Promise<string> {
  clock.advance(60_000);
  mails += 1;
  const arrived = (await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: opts.from ?? `customer-${mails}@customer.example`,
    contactName: null,
    subject: `Question ${mails}`,
    bodyText: 'Something is not working.',
    emailMessageId: opts.emailMessageId ?? `<rr-${mails}@mail.example>`,
  })) as { conversation_id: string };
  return arrived.conversation_id;
}

/** A visitor opens the widget and says something. */
async function chat(desk: Desk): Promise<{ conversationId: string; sessionId: string; token: string }> {
  clock.advance(60_000);
  const widget = await as(desk, desk.widget);
  const started = (await widget.invoke('ticket0/widget-start', { origin: ORIGIN })) as {
    sessionId: string;
    token: string;
  };
  const posted = (await widget.invoke('ticket0/widget-post', {
    sessionId: started.sessionId,
    token: started.token,
    body: 'How do I rotate a key?',
  })) as { conversation_id: string };
  return { conversationId: posted.conversation_id, ...started };
}

/** Read back through the operation the app calls, never out of the table. */
async function read(desk: Desk, id: string): Promise<Conversation> {
  return (await (await as(desk, desk.admin)).invoke('ticket0/get-conversation', {
    conversationId: id,
  })) as Conversation;
}

/**
 * The spine, read the way an auditor would — harness code, so the scope's own SQLite
 * file is fair game (`SqliteScopeHost` names it after the pair). Read-only.
 */
function assignedEvents(
  desk: Desk,
  conversationId: string,
): { actor: string; operation: string | null; authorization: string | null; payload: string }[] {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT actor, operation, authorization, payload FROM _substrat_outbox
          WHERE type = 'ticket0.conversation-assigned' AND entity_id = ? ORDER BY id`,
      )
      .all(conversationId) as {
      actor: string;
      operation: string | null;
      authorization: string | null;
      payload: string;
    }[];
  } finally {
    db.close();
  }
}

/** Stand in for a row this version never wrote — a later version's key, or a corrupt one. */
function writeSettings(desk: Desk, raw: string): void {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
  try {
    db.prepare('UPDATE ticket0_desk_settings SET settings = ?').run(raw);
  } finally {
    db.close();
  }
}

async function assignedNotifications(desk: Desk, who: PrincipalId, conversationId: string): Promise<number> {
  const page = (await (await as(desk, who)).invoke('ticket0/my-notifications', {})) as Page<{
    kind: string;
    conversation_id: string | null;
  }>;
  return page.entries.filter((n) => n.kind === 'assigned' && n.conversation_id === conversationId).length;
}

/** The ring's order: by principal, ascending — the same comparison SQLite's `ORDER BY` makes on ULIDs. */
const ringOf = (desk: Desk): PrincipalId[] => [...desk.agents].sort();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-round-robin-'));
  clock = manualClock('2026-09-21T08:00:00.000Z');
  host = buildHost(dir, clock.read);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('off unless the desk switches it on', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 2 });
  });

  it('a desk that has never said has no settings, and hands out nothing', async () => {
    const settings = (await (await as(desk, desk.admin)).invoke('ticket0/get-desk', {})) as Record<string, unknown>;
    expect(settings.settings).toBeNull();
    // The cursor is bookkeeping, and the desk read does not publish it.
    expect(settings).not.toHaveProperty('round_robin_last');
    expect(settings).not.toHaveProperty('verification_secret');

    const waiting = await mail(desk);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, waiting)).assignee).toBeNull();
    expect(assignedEvents(desk, waiting)).toEqual([]);
  });

  it('switched on, the same sweep hands out what is waiting — the backlog included', async () => {
    await switchRoundRobin(desk, true);
    const settings = (await (await as(desk, desk.admin)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(settings.settings)).toEqual({ roundRobin: true });

    // The conversation from the previous case arrived while the switch was off. It is
    // still nobody's, so it is the desk's to hand out: that is what "everything
    // unassigned" means, and it is what an admin gets on the first tick after saving.
    expect(await sweep(desk)).toBe(1);
  });

  it('a save that does not mention the switches leaves them where they are', async () => {
    await (await as(desk, desk.admin)).invoke('ticket0/configure-desk', { greeting: 'Hello again' });
    const waiting = await mail(desk);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, waiting)).assignee).not.toBeNull();
  });

  it('switched off, it stops — and the next arrival waits for a person', async () => {
    await switchRoundRobin(desk, false);
    const waiting = await mail(desk);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, waiting)).assignee).toBeNull();
  });

  it('refuses a key it does not know, rather than saving a switch that switches nothing', async () => {
    const admin = await as(desk, desk.admin);
    await expect(
      admin.invoke('ticket0/configure-desk', { settings: { roundrobin: true } }),
    ).rejects.toThrow();
    const settings = (await admin.invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(settings.settings)).toEqual({ roundRobin: false });
  });

  it('carries the switches on the trail, so the day it was turned on can be found', async () => {
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
    try {
      const payloads = (
        db
          .prepare(`SELECT payload FROM _substrat_outbox WHERE type = 'ticket0.desk-configured' ORDER BY id`)
          .all() as { payload: string }[]
      ).map((r) => JSON.parse(r.payload) as { settings: string | null });
      expect(payloads.map((p) => p.settings)).toContain(JSON.stringify({ roundRobin: true }));
      expect(payloads.at(-1)!.settings).toBe(JSON.stringify({ roundRobin: false }));
    } finally {
      db.close();
    }
  });

  it('keeps a key a later version wrote, and reads anything that is not an object as off', async () => {
    // A rollback: the row holds a switch this version has never heard of. Turning
    // round-robin on must not take it away.
    writeSettings(desk, JSON.stringify({ autoClose: 7 }));
    await switchRoundRobin(desk, true);
    const settings = (await (await as(desk, desk.admin)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(settings.settings)).toEqual({ autoClose: 7, roundRobin: true });

    const first = await mail(desk);
    expect(await sweep(desk)).toBeGreaterThanOrEqual(1);
    expect((await read(desk, first)).assignee).not.toBeNull();

    // A value nobody wrote on purpose. The safe answer is the one the desk never
    // opted into.
    writeSettings(desk, 'not json');
    const second = await mail(desk);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, second)).assignee).toBeNull();
    writeSettings(desk, JSON.stringify({ roundRobin: 'yes' }));
    expect(await sweep(desk)).toBe(0);
  });
});

describe('the ring: in turn, by principal, with the assistant never in it', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 3 });
    await switchRoundRobin(desk, true);
  });

  it('hands the oldest first, one person at a time, and comes back round', async () => {
    const waiting = [await mail(desk), await mail(desk), await mail(desk), await mail(desk)];
    expect(await sweep(desk)).toBe(4);

    const ring = ringOf(desk);
    const got = await Promise.all(waiting.map(async (id) => (await read(desk, id)).assignee));
    expect(got).toEqual([ring[0], ring[1], ring[2], ring[0]]);
    // Both assistants have a profile and neither is ever in line.
    expect(got).not.toContain(desk.assistant);
    expect(got).not.toContain(desk.assistantAutonomous);
  });

  it('remembers where it stopped: the next run picks up after the last person', async () => {
    // Without the cursor this would be ring[0] again — every tick would start the ring
    // over, and the first person in it would get every conversation that arrived alone.
    const next = await mail(desk);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, next)).assignee).toBe(ringOf(desk)[1]);
  });

  it('assigns the way a person does: the conversation moves to open and its assignee is told', async () => {
    const next = await mail(desk);
    expect((await read(desk, next)).state).toBe('new');
    await sweep(desk);
    const row = await read(desk, next);
    expect(row.state).toBe('open');
    expect(row.first_assigned_at).not.toBeNull();
    expect(await assignedNotifications(desk, row.assignee as PrincipalId, next)).toBe(1);
  });
});

describe('a desk with nobody to hand anything to', () => {
  it('assigns nothing, leaves the conversation in the inbox, and is not an error', async () => {
    // The directory holds the two assistants and nobody else.
    const desk = await freshDesk({ agents: 0 });
    await switchRoundRobin(desk, true);
    const waiting = await mail(desk);

    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, waiting)).assignee).toBeNull();

    const report = await host.runDueSchedules(TICKET0, desk.tenant, desk.scope);
    expect(report.errors).toEqual([]);
    expect(report.runs).toContainEqual({ operation: 'ticket0/assign-round-robin', outcome: 'ok' });

    // Somebody joins, and the conversation that waited is theirs on the next tick.
    const first = await hire(desk);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, waiting)).assignee).toBe(first);
  });
});

describe('a decision a person made is not overruled', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 2 });
    await switchRoundRobin(desk, true);
  });

  it('a conversation somebody put back stays put; one nobody ever had is handed out', async () => {
    const admin = await as(desk, desk.admin);
    const putBack = await mail(desk);
    await admin.invoke('ticket0/assign', { conversationId: putBack, assignee: desk.agents[0] });
    await admin.invoke('ticket0/assign', { conversationId: putBack, assignee: null });
    const unassigned = await read(desk, putBack);
    expect(unassigned.assignee).toBeNull();
    // Unassigning leaves the stamp standing — that is the whole mechanism.
    expect(unassigned.first_assigned_at).not.toBeNull();

    const neverHad = await mail(desk);

    // One sweep, both conversations in front of it, and it tells them apart.
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, putBack)).assignee).toBeNull();
    expect((await read(desk, neverHad)).assignee).not.toBeNull();

    // And it does not come back for it on a later tick either.
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, putBack)).assignee).toBeNull();
  });

  it('a conversation a person assigned keeps its person', async () => {
    const taken = await mail(desk);
    await (await as(desk, desk.admin)).invoke('ticket0/assign', {
      conversationId: taken,
      assignee: desk.agents[1],
    });
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, taken)).assignee).toBe(desk.agents[1]);
    expect(assignedEvents(desk, taken)).toHaveLength(1);
  });

  it('so does one assigned before the stamp existed', async () => {
    // A row from before the migration: somebody holds it, and `first_assigned_at` is
    // null because the column did not exist when they were given it. The stamp alone
    // would read that as never assigned; `assignee` is what keeps it theirs.
    const older = await mail(desk);
    await (await as(desk, desk.admin)).invoke('ticket0/assign', {
      conversationId: older,
      assignee: desk.agents[0],
    });
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
    try {
      db.prepare('UPDATE ticket0_conversations SET first_assigned_at = NULL WHERE id = ?').run(older);
    } finally {
      db.close();
    }
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, older)).assignee).toBe(desk.agents[0]);
    expect(assignedEvents(desk, older)).toHaveLength(1);
  });
});

describe('it hands each conversation out once', () => {
  let desk: Desk;
  let handed = '';
  beforeAll(async () => {
    desk = await freshDesk({ agents: 2 });
    await switchRoundRobin(desk, true);
  });

  it('a second sweep finds nothing it has already handled', async () => {
    handed = await mail(desk, { from: 'twice@customer.example', emailMessageId: '<twice@mail.example>' });
    expect(await sweep(desk)).toBe(1);
    expect(await sweep(desk)).toBe(0);
    expect(assignedEvents(desk, handed)).toHaveLength(1);
    const assignee = (await read(desk, handed)).assignee as PrincipalId;
    expect(await assignedNotifications(desk, assignee, handed)).toBe(1);
  });

  it('a redelivered mail is the same conversation, and is not handed out again', async () => {
    const before = (await read(desk, handed)).assignee;
    const again = await mail(desk, { from: 'twice@customer.example', emailMessageId: '<twice@mail.example>' });
    expect(again).toBe(handed);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, handed)).assignee).toBe(before);
    expect(assignedEvents(desk, handed)).toHaveLength(1);
  });

  it('the customer writing again does not move it to somebody else', async () => {
    const before = (await read(desk, handed)).assignee;
    await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
      conversationId: handed,
      contactEmail: 'twice@customer.example',
      subject: 'Re: still broken',
      bodyText: 'Any news?',
      emailMessageId: '<twice-2@mail.example>',
    });
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, handed)).assignee).toBe(before);
    expect(assignedEvents(desk, handed)).toHaveLength(1);
  });
});

describe('only live work, and only the conversation a merge kept', () => {
  it('takes new and open; leaves snoozed until it wakes, and never resolved, closed or merged-away', async () => {
    const desk = await freshDesk({ agents: 1 });
    const agent = await as(desk, desk.agents[0]!);
    const admin = await as(desk, desk.admin);

    // Open and never assigned: an agent answered without taking it.
    const answered = await mail(desk);
    await agent.invoke('ticket0/post-public-reply', { conversationId: answered, body: 'Looking now.' });

    const parked = await mail(desk);
    await agent.invoke('ticket0/post-public-reply', { conversationId: parked, body: 'Back to you Monday.' });
    await agent.invoke('ticket0/snooze', {
      conversationId: parked,
      until: new Date(Date.parse(clock.now()) + 60 * 60_000).toISOString(),
    });

    const done = await mail(desk);
    await agent.invoke('ticket0/post-public-reply', { conversationId: done, body: 'Fixed.' });
    await agent.invoke('ticket0/resolve', { conversationId: done });

    const closed = await mail(desk);
    await admin.invoke('ticket0/close', { conversationId: closed });

    const loser = await mail(desk, { from: 'same@customer.example' });
    const survivor = await mail(desk, { from: 'same@customer.example' });
    await admin.invoke('ticket0/merge', { conversationId: loser, intoConversationId: survivor });

    await switchRoundRobin(desk, true);
    expect(await sweep(desk)).toBe(2);
    expect((await read(desk, answered)).assignee).toBe(desk.agents[0]);
    expect((await read(desk, survivor)).assignee).toBe(desk.agents[0]);
    for (const id of [parked, done, closed, loser]) expect((await read(desk, id)).assignee).toBeNull();

    // The snooze lapses, the timer wakes it, and the next round-robin tick takes it.
    clock.advance(2 * 60 * 60_000);
    await (await host.getSystemScope(TICKET0, desk.tenant, desk.scope)).invoke('ticket0/wake-snoozed');
    expect((await read(desk, parked)).state).toBe('open');
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, parked)).assignee).toBe(desk.agents[0]);
  });
});

describe('the assistant keeps what it is answering, until it hands it to a person', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 2, autonomous: true });
    await switchRoundRobin(desk, true);
  });

  it('leaves a widget conversation the assistant is answering; hands out mail, which it never answers', async () => {
    const chatting = await chat(desk);
    // The assistant answered it: a drafted turn, sent, and marked answered.
    const assistant = await as(desk, desk.assistantAutonomous);
    await assistant.invoke('ticket0/record-answer', {
      conversationId: chatting.conversationId,
      turnId: 'answered-turn',
      model: 'test/none',
      body: 'Settings, then API keys, then Rotate.',
      inputTokens: 1,
      outputTokens: 1,
      citedArticleIds: [],
      outcome: 'drafted',
    });
    await assistant.invoke('ticket0/post-public-reply', {
      conversationId: chatting.conversationId,
      body: 'Settings, then API keys, then Rotate.',
      turnId: 'answered-turn',
    });
    expect((await read(desk, chatting.conversationId)).state).toBe('open');

    const mailed = await mail(desk);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, chatting.conversationId)).assignee).toBeNull();
    expect((await read(desk, mailed)).assignee).not.toBeNull();
  });

  it('hands it out once the visitor asks for a person', async () => {
    const chatting = await chat(desk);
    expect(await sweep(desk)).toBe(0);

    await (await as(desk, desk.widget)).invoke('ticket0/request-human', {
      sessionId: chatting.sessionId,
      token: chatting.token,
    });
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, chatting.conversationId)).assignee).not.toBeNull();
  });

  it('hands it out once the assistant escalates — the documentation had nothing', async () => {
    const chatting = await chat(desk);
    expect(await sweep(desk)).toBe(0);

    await (await as(desk, desk.assistantAutonomous)).invoke('ticket0/record-answer', {
      conversationId: chatting.conversationId,
      turnId: 'escalated-turn',
      model: 'test/none',
      body: 'I could not find anything about that.',
      inputTokens: 1,
      outputTokens: 1,
      citedArticleIds: [],
      outcome: 'escalated',
    });
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, chatting.conversationId)).assignee).not.toBeNull();
  });

  it('hands it out once the assistant could not run at all', async () => {
    const chatting = await chat(desk);
    expect(await sweep(desk)).toBe(0);

    await (await as(desk, desk.widget)).invoke('ticket0/record-assistant-failure', {
      conversationId: chatting.conversationId,
      turnId: 'failed-turn',
      model: 'test/none',
      error: 'the model did not answer',
    });
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, chatting.conversationId)).assignee).not.toBeNull();
  });

  it('on a supervised desk the assistant sends nothing, so every widget conversation is a person’s', async () => {
    const supervised = await freshDesk({ agents: 1, autonomous: false });
    await switchRoundRobin(supervised, true);
    const chatting = await chat(supervised);
    expect(await sweep(supervised)).toBe(1);
    expect((await read(supervised, chatting.conversationId)).assignee).toBe(supervised.agents[0]);
  });
});

describe('the same permission and the same trail as a person’s assign', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 1 });
    await switchRoundRobin(desk, true);
  });

  it('records who acted, under which check, and which behaviour it was', async () => {
    const waiting = await mail(desk);
    expect(await sweep(desk)).toBe(1);

    const [event] = assignedEvents(desk, waiting);
    expect(JSON.parse(event!.actor)).toEqual({ system: ticket0Manifest.id });
    // The operation is kernel-stamped: the trail names the behaviour, not merely "the system".
    expect(event!.operation).toBe('ticket0/assign-round-robin');
    const authorization = JSON.parse(event!.authorization ?? '[]') as { permission: string }[];
    expect(authorization.map((a) => a.permission)).toContain('conversation:assign');
    expect(JSON.parse(event!.payload)).toMatchObject({ id: waiting, assignee: desk.agents[0], state: 'open' });
  });

  it('is refused to a principal that does not hold conversation:assign', async () => {
    await mail(desk);
    await expect((await as(desk, desk.relay)).invoke('ticket0/assign-round-robin')).rejects.toThrow(
      /denied/i,
    );
    // And allowed to one that does — it is the key being checked, not who is asking.
    expect(((await (await as(desk, desk.agents[0]!)).invoke('ticket0/assign-round-robin')) as {
      assigned: number;
    }).assigned).toBe(1);
    // Refused with nothing waiting too. The per-conversation check only runs when there
    // is a conversation, so this is the node check's alone: a caller without the key
    // gets no answer at all, not a zero.
    await expect((await as(desk, desk.relay)).invoke('ticket0/assign-round-robin')).rejects.toThrow(
      /denied/i,
    );
  });

  it('stops for a desk whose system grant is revoked — the check is a real one', async () => {
    // Unlike an event consumer, whose checks the kernel allows unconditionally, the
    // schedule's principal holds exactly what provisioning granted it. Take the tuple
    // away and the same call is refused.
    await mail(desk);
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
    try {
      const removed = db
        .prepare(`DELETE FROM _substrat_tuples WHERE subject = ? AND relation = 'granted:conversation:assign'`)
        .run(`system:${ticket0Manifest.id}`);
      expect(removed.changes).toBe(1);
    } finally {
      db.close();
    }
    await expect(sweep(desk)).rejects.toThrow(/denied/i);
  });
});

describe('the platform sweep is the caller', () => {
  it('fires the declared schedule, and the conversation is handed out', async () => {
    const desk = await freshDesk({ agents: 1 });
    await switchRoundRobin(desk, true);
    const waiting = await mail(desk);

    // Nothing here invokes the operation: the sweep reads what the manifest declares,
    // and provisioning granted the system principal the key it checks.
    const report = await host.runDueSchedules(TICKET0, desk.tenant, desk.scope);
    expect(report.errors).toEqual([]);
    expect(report.runs).toContainEqual({ operation: 'ticket0/assign-round-robin', outcome: 'ok' });
    expect((await read(desk, waiting)).assignee).toBe(desk.agents[0]);
  });
});
