/**
 * Service levels (#1082): first-response and resolution targets, the breach state on the
 * conversation, and the sweep that tells the desk.
 *
 * Every claim the handler's comments make is driven here, and each in both directions. A
 * suite that only watched a breach get recorded would pass against a handler that
 * breached everything, and one that only watched it hold back would pass against a
 * handler that did nothing.
 *
 * Each block builds its OWN desk, for round-robin's reason: who gets told and what is
 * overdue are facts about exactly who is on the desk and exactly what is waiting.
 *
 * Time moves on a `manualClock`, and that is the whole instrument here. A target is an
 * instant; the only way to test one is to stand on either side of it.
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
import { SLA_TARGET_MAX_MINUTES } from '../spec/model.js';
import { ticket0Manifest } from '../src/manifest.js';
import { ASSISTANT_NAME, slaOverdueScan } from '../src/module.js';
import { ROLES } from '../src/provision.js';
import { buildHost } from '../src/seed.js';
import {
  formatMinutes,
  SLA_MAX_MINUTES,
  slaErrorOf,
  slaFormOf,
  slaMissedLabel,
  slaPayloadOf,
  type SlaForm,
} from '../app/src/sla.js';

let dir: string;
let host: ScopeHost;
let clock: ManualClock;

const TICKET0 = moduleId.parse(ticket0Manifest.id);
const staff = platformActorId.parse(ulid());
const ORIGIN = 'https://desk.example';
const MINUTE = 60_000;

interface Desk {
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly admin: PrincipalId;
  readonly relay: PrincipalId;
  readonly widget: PrincipalId;
  readonly assistantAutonomous: PrincipalId;
  readonly agents: PrincipalId[];
}

interface Conversation {
  id: string;
  state: string;
  assignee: string | null;
  priority: string;
  created_at: string;
  updated_at: string;
  first_public_reply_at: string | null;
  resolved_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_response_breached_at: string | null;
  resolution_breached_at: string | null;
  snoozed_at: string | null;
  snoozed_ms: number | null;
}

interface Sla {
  firstResponseMinutes?: Partial<Record<'low' | 'normal' | 'urgent', number>>;
  resolutionMinutes?: Partial<Record<'low' | 'normal' | 'urgent', number>>;
}

let desks = 0;

/**
 * A desk whose directory is exactly what the test says. The assistant has a profile, as
 * on a real desk, so every "everybody was told" here is a set it must be left out of.
 */
async function freshDesk(opts: { agents: number; autonomous?: boolean; sla?: Sla | null }): Promise<Desk> {
  desks += 1;
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: tenant, slug: `sla-${desks}`, name: `Desk ${desks}` });
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
  const assistantAutonomous = await mint('assistant-autonomous');

  await (await host.getScope(admin, tenant, scope)).invoke('ticket0/configure-desk', {
    allowedOrigins: [ORIGIN],
    assistantAutonomous: opts.autonomous ?? false,
    ...(opts.sla !== undefined ? { settings: { sla: opts.sla } } : {}),
  });
  await (await host.getScope(assistantAutonomous, tenant, scope)).invoke('ticket0/set-agent-profile', {
    displayName: ASSISTANT_NAME,
    avatarUrl: null,
    signature: null,
  });

  const desk: Desk = { tenant, scope, admin, relay, widget, assistantAutonomous, agents: [] };
  for (let i = 0; i < opts.agents; i++) {
    const p = await mint('agent');
    await (await host.getScope(p, tenant, scope)).invoke('ticket0/set-agent-profile', {
      displayName: `Agent ${i + 1}`,
      avatarUrl: null,
      signature: null,
    });
    desk.agents.push(p);
  }
  return desk;
}

const as = (desk: Desk, who: PrincipalId): Promise<ScopeStub> => host.getScope(who, desk.tenant, desk.scope);
const admin = (desk: Desk) => as(desk, desk.admin);
const agent = (desk: Desk) => as(desk, desk.agents[0]!);
const advance = (minutes: number) => clock.advance(minutes * MINUTE);
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * MINUTE).toISOString();

/** The desk's own timer, as the platform sweep invokes it: the module's system actor. */
async function sweep(desk: Desk): Promise<number> {
  const stub = await host.getSystemScope(TICKET0, desk.tenant, desk.scope);
  return ((await stub.invoke('ticket0/escalate-sla-breaches')) as { breached: number }).breached;
}

async function setSla(desk: Desk, sla: Sla | null): Promise<void> {
  await (await admin(desk)).invoke('ticket0/configure-desk', { settings: { sla } });
}

let mails = 0;

/** A mail arrives, a minute after whatever arrived before it. Returns the conversation. */
async function mail(desk: Desk, opts: { from?: string } = {}): Promise<string> {
  advance(1);
  mails += 1;
  const arrived = (await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: opts.from ?? `customer-${mails}@customer.example`,
    contactName: null,
    subject: `Question ${mails}`,
    bodyText: 'Something is not working.',
    emailMessageId: `<sla-${mails}@mail.example>`,
  })) as { conversation_id: string };
  return arrived.conversation_id;
}

/** The customer writes into an existing conversation. */
async function writeAgain(desk: Desk, conversationId: string, from: string): Promise<void> {
  mails += 1;
  await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
    conversationId,
    contactEmail: from,
    subject: 'Re: still broken',
    bodyText: 'Any news?',
    emailMessageId: `<sla-${mails}@mail.example>`,
  });
}

/** A visitor opens the widget and says something. */
async function chat(desk: Desk): Promise<{ conversationId: string; sessionId: string; token: string }> {
  advance(1);
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
  return (await (await admin(desk)).invoke('ticket0/get-conversation', { conversationId: id })) as Conversation;
}

async function reply(desk: Desk, conversationId: string, body = 'Looking now.'): Promise<void> {
  await (await agent(desk)).invoke('ticket0/post-public-reply', { conversationId, body });
}

/** The spine, read the way an auditor would — harness code, read-only. */
function breachEvents(
  desk: Desk,
  conversationId: string,
): { actor: string; operation: string | null; authorization: string | null; payload: Record<string, unknown> }[] {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT actor, operation, authorization, payload FROM _substrat_outbox
            WHERE type = 'ticket0.sla-breached' AND entity_id = ? ORDER BY id`,
        )
        .all(conversationId) as { actor: string; operation: string | null; authorization: string | null; payload: string }[]
    ).map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  } finally {
    db.close();
  }
}

/** How many `escalated` notifications this person holds about this conversation. */
async function escalations(desk: Desk, who: PrincipalId, conversationId: string): Promise<number> {
  const page = (await (await as(desk, who)).invoke('ticket0/my-notifications', {})) as Page<{
    kind: string;
    conversation_id: string | null;
  }>;
  return page.entries.filter((n) => n.kind === 'escalated' && n.conversation_id === conversationId).length;
}

/** Stand in for a row this version never wrote. */
function writeSettings(desk: Desk, raw: string): void {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
  try {
    db.prepare('UPDATE ticket0_desk_settings SET settings = ?').run(raw);
  } finally {
    db.close();
  }
}

const FR_30: Sla = { firstResponseMinutes: { normal: 30 } };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-sla-'));
  clock = manualClock('2026-09-21T08:00:00.000Z');
  host = buildHost(dir, clock.read);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('off unless the desk sets a target', () => {
  it('a desk with no service levels stamps nothing and breaches nothing, however long it waits', async () => {
    const desk = await freshDesk({ agents: 1 });
    const waiting = await mail(desk);
    const row = await read(desk, waiting);
    expect(row.first_response_due_at).toBeNull();
    expect(row.resolution_due_at).toBeNull();
    advance(3 * 24 * 60);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, waiting)).first_response_breached_at).toBeNull();
  });

  it('with targets set, an arriving conversation is stamped from when it arrived, at its priority', async () => {
    const desk = await freshDesk({
      agents: 1,
      sla: { firstResponseMinutes: { normal: 60 }, resolutionMinutes: { normal: 480 } },
    });
    const settings = (await (await admin(desk)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(settings.settings)).toEqual({
      sla: { firstResponseMinutes: { normal: 60 }, resolutionMinutes: { normal: 480 } },
    });

    const row = await read(desk, await mail(desk));
    expect(row.priority).toBe('normal');
    expect(row.first_response_due_at).toBe(plus(row.created_at, 60));
    expect(row.resolution_due_at).toBe(plus(row.created_at, 480));
    expect(row.first_response_breached_at).toBeNull();
    expect(row.resolution_breached_at).toBeNull();
  });

  it('a priority the desk set no target for gets none', async () => {
    const desk = await freshDesk({ agents: 1, sla: { firstResponseMinutes: { urgent: 15 } } });
    const row = await read(desk, await mail(desk));
    expect(row.first_response_due_at).toBeNull();
    expect(row.resolution_due_at).toBeNull();
  });

  it('refuses a target it cannot mean, and keeps what was saved', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    const a = await admin(desk);
    for (const sla of [
      { firstResponse: { normal: 30 } }, // not a key
      { firstResponseMinutes: { high: 30 } }, // not a priority
      { firstResponseMinutes: { normal: 0 } }, // breached by arriving
      { firstResponseMinutes: { normal: 1.5 } }, // whole minutes only
      { firstResponseMinutes: { normal: SLA_TARGET_MAX_MINUTES + 1 } },
    ]) {
      await expect(a.invoke('ticket0/configure-desk', { settings: { sla } })).rejects.toThrow();
    }
    // The bounds themselves are accepted.
    await a.invoke('ticket0/configure-desk', {
      settings: { sla: { firstResponseMinutes: { low: SLA_TARGET_MAX_MINUTES, normal: 1 } } },
    });
    await setSla(desk, FR_30);
    const settings = (await a.invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(settings.settings)).toEqual({ sla: FR_30 });
  });

  it('a save that does not name the targets keeps them', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    await (await admin(desk)).invoke('ticket0/configure-desk', { settings: { roundRobin: false } });
    await (await admin(desk)).invoke('ticket0/configure-desk', { greeting: 'Hello again' });
    const row = await read(desk, await mail(desk));
    expect(row.first_response_due_at).toBe(plus(row.created_at, 30));
  });

  it('switched off, nothing is breached — not even a conversation stamped while it was on; back on, it is', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    // Both arrive while the desk has targets, so both are stamped with one.
    const late = await mail(desk);
    const repliedLate = await mail(desk);
    expect((await read(desk, repliedLate)).first_response_due_at).not.toBeNull();
    await setSla(desk, null);
    advance(31);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, late)).first_response_breached_at).toBeNull();
    // A late reply records nothing on a desk with no service levels either: the reply's
    // door is gated exactly as the sweep is.
    await reply(desk, repliedLate);
    expect((await read(desk, repliedLate)).first_response_breached_at).toBeNull();
    expect(breachEvents(desk, repliedLate)).toEqual([]);

    // Switched on again, the promise the unanswered one was given still stands. The one
    // that was answered is met, and stays unbreached.
    await setSla(desk, FR_30);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, late)).first_response_breached_at).toBe(clock.now());
    expect((await read(desk, repliedLate)).first_response_breached_at).toBeNull();
  });

  it('reads a value this version never wrote as no target at all', async () => {
    const desk = await freshDesk({ agents: 1 });
    writeSettings(desk, JSON.stringify({ sla: { firstResponseMinutes: { normal: 0 } } }));
    expect((await read(desk, await mail(desk))).first_response_due_at).toBeNull();
    writeSettings(desk, JSON.stringify({ sla: { firstResponseMinutes: { normal: '30' } } }));
    expect((await read(desk, await mail(desk))).first_response_due_at).toBeNull();
    writeSettings(desk, JSON.stringify({ sla: 'yes' }));
    expect((await read(desk, await mail(desk))).first_response_due_at).toBeNull();
    writeSettings(desk, 'not json');
    expect((await read(desk, await mail(desk))).first_response_due_at).toBeNull();
    advance(24 * 60);
    expect(await sweep(desk)).toBe(0);
    // And a well-formed one next to a key a later version wrote still counts.
    writeSettings(desk, JSON.stringify({ autoClose: 7, sla: FR_30 }));
    const row = await read(desk, await mail(desk));
    expect(row.first_response_due_at).toBe(plus(row.created_at, 30));
  });
});

describe('a conversation that arrived before the desk had targets is not held to them', () => {
  it('until somebody decides its priority — then it is, counted from when it arrived', async () => {
    const desk = await freshDesk({ agents: 1 });
    const backlog = await mail(desk);
    await setSla(desk, { firstResponseMinutes: { urgent: 15 } });
    advance(60);
    expect(await sweep(desk)).toBe(0);
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: backlog, priority: 'urgent' });
    const row = await read(desk, backlog);
    expect(row.first_response_due_at).toBe(plus(row.created_at, 15));
    // It has waited an hour for a fifteen-minute promise: late, and the sweep says so.
    expect(await sweep(desk)).toBe(1);
  });

  it('turning service levels on does not make the backlog late', async () => {
    const desk = await freshDesk({ agents: 1 });
    const backlog = await mail(desk);
    await setSla(desk, FR_30);
    advance(3 * 24 * 60);
    expect(await sweep(desk)).toBe(0);
    const row = await read(desk, backlog);
    expect(row.first_response_due_at).toBeNull();
    expect(row.first_response_breached_at).toBeNull();
    // Nor does answering it late: it had no target to be late for.
    await reply(desk, backlog);
    expect((await read(desk, backlog)).first_response_breached_at).toBeNull();
  });
});

describe('a new priority re-aims the targets that are still running, and only those', () => {
  const POLICY: Sla = {
    firstResponseMinutes: { normal: 60, urgent: 15 },
    resolutionMinutes: { normal: 480, urgent: 120 },
  };

  it('re-aims both, counted from when the conversation arrived, and says so on the event', async () => {
    const desk = await freshDesk({ agents: 1, sla: POLICY });
    const id = await mail(desk);
    advance(5);
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'urgent' });
    const row = await read(desk, id);
    expect(row.first_response_due_at).toBe(plus(row.created_at, 15));
    expect(row.resolution_due_at).toBe(plus(row.created_at, 120));

    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
    try {
      const { payload } = db
        .prepare(
          `SELECT payload FROM _substrat_outbox
            WHERE type = 'ticket0.conversation-priority-set' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(id) as { payload: string };
      expect(JSON.parse(payload)).toMatchObject({
        id,
        priority: 'urgent',
        first_response_due_at: row.first_response_due_at,
        resolution_due_at: row.resolution_due_at,
      });
    } finally {
      db.close();
    }
  });

  it('a target already met stays where it was; the one still running moves', async () => {
    const desk = await freshDesk({ agents: 1, sla: POLICY });
    const id = await mail(desk);
    await reply(desk, id);
    const before = await read(desk, id);
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'urgent' });
    const after = await read(desk, id);
    expect(after.first_response_due_at).toBe(before.first_response_due_at);
    expect(after.resolution_due_at).toBe(plus(after.created_at, 120));
  });

  it('a target already missed stays missed, and its due does not move', async () => {
    const desk = await freshDesk({ agents: 1, sla: POLICY });
    const id = await mail(desk);
    advance(61);
    expect(await sweep(desk)).toBe(1);
    const breached = await read(desk, id);
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'low' });
    const after = await read(desk, id);
    expect(after.first_response_breached_at).toBe(breached.first_response_breached_at);
    expect(after.first_response_due_at).toBe(breached.first_response_due_at);
    // The resolution target was still running, and `low` has none on this desk.
    expect(after.resolution_due_at).toBeNull();
  });

  it('lowering the priority does not erase a miss nobody had recorded — it records it and tells the holder', async () => {
    const desk = await freshDesk({ agents: 2, sla: { firstResponseMinutes: { normal: 60, low: 1440 } } });
    const id = await mail(desk);
    const holder = desk.agents[1]!;
    await (await admin(desk)).invoke('ticket0/assign', { conversationId: id, assignee: holder });
    const stamped = await read(desk, id);
    advance(61); // past the normal hour, and no sweep has run
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'low' });

    const row = await read(desk, id);
    expect(row.first_response_breached_at).toBe(clock.now());
    // Missed, so not re-aimed: `low`'s day would have made it on time.
    expect(row.first_response_due_at).toBe(stamped.first_response_due_at);
    expect(breachEvents(desk, id).map((e) => e.operation)).toEqual(['ticket0/set-priority']);
    // Still waiting, so somebody is told: the holder, not the person who re-prioritised.
    expect(await escalations(desk, holder, id)).toBe(1);
    expect(await escalations(desk, desk.agents[0]!, id)).toBe(0);
    expect(await sweep(desk)).toBe(0);
  });

  it('a conversation marked urgent after it waited is already late, and the next sweep says so', async () => {
    const desk = await freshDesk({ agents: 1, sla: POLICY });
    const id = await mail(desk);
    advance(20);
    expect(await sweep(desk)).toBe(0); // 20 minutes is inside the normal hour
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'urgent' });
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, id)).first_response_breached_at).toBe(clock.now());
  });

  it('editing the targets moves nothing already promised; re-prioritising under no policy clears what runs', async () => {
    const desk = await freshDesk({ agents: 1, sla: POLICY });
    const id = await mail(desk);
    const stamped = await read(desk, id);
    await setSla(desk, { firstResponseMinutes: { normal: 5 } });
    expect((await read(desk, id)).first_response_due_at).toBe(stamped.first_response_due_at);
    advance(10);
    // Late for the new policy, on time for the one it was given.
    expect(await sweep(desk)).toBe(0);

    await setSla(desk, null);
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'normal' });
    const cleared = await read(desk, id);
    expect(cleared.first_response_due_at).toBeNull();
    expect(cleared.resolution_due_at).toBeNull();
  });
});

describe('first response: what counts, and what does not', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 1, autonomous: true, sla: FR_30 });
  });

  /** Arrive, act, let the target pass, sweep: was the first response met? */
  async function breachedAfter(act: (id: string) => Promise<void>, arrive = () => mail(desk)): Promise<boolean> {
    const id = await arrive();
    await act(id);
    advance(31);
    await sweep(desk);
    return (await read(desk, id)).first_response_breached_at !== null;
  }

  it('a person’s public reply counts', async () => {
    expect(await breachedAfter((id) => reply(desk, id))).toBe(false);
  });

  it('a reply at exactly the due instant is on time', async () => {
    const id = await mail(desk);
    advance(30);
    expect(clock.now()).toBe((await read(desk, id)).first_response_due_at);
    await reply(desk, id);
    advance(10);
    await sweep(desk);
    expect((await read(desk, id)).first_response_breached_at).toBeNull();
  });

  it('the assistant’s public reply counts — it is what the customer received', async () => {
    const assistant = await as(desk, desk.assistantAutonomous);
    const breached = await breachedAfter(
      async (id) => {
        await assistant.invoke('ticket0/post-public-reply', { conversationId: id, body: 'Settings, then API keys.' });
        const messages = (await (await admin(desk)).invoke('ticket0/list-messages', { conversationId: id })) as Page<{
          author_kind: string;
          visibility: string;
        }>;
        // The desk recorded it as the assistant's, not a person's.
        expect(messages.entries.filter((m) => m.visibility === 'public').map((m) => m.author_kind)).toContain(
          'assistant',
        );
      },
      async () => (await chat(desk)).conversationId,
    );
    expect(breached).toBe(false);
  });

  it('an internal note does not count — the customer has been told nothing', async () => {
    expect(
      await breachedAfter(async (id) => {
        await (await agent(desk)).invoke('ticket0/post-note', { conversationId: id, body: 'Looking into it.' });
      }),
    ).toBe(true);
  });

  it('the customer writing again does not count', async () => {
    const from = 'again@customer.example';
    expect(await breachedAfter((id) => writeAgain(desk, id, from), () => mail(desk, { from }))).toBe(true);
  });

  it('the acknowledgement a request for a person writes does not count — it is the promise, not the response', async () => {
    const widget = await as(desk, desk.widget);
    let session = { sessionId: '', token: '' };
    const breached = await breachedAfter(
      async () => {
        await widget.invoke('ticket0/request-human', session);
      },
      async () => {
        const started = await chat(desk);
        session = { sessionId: started.sessionId, token: started.token };
        return started.conversationId;
      },
    );
    expect(breached).toBe(true);
  });

  it('an assistant turn that was only drafted, or that escalated, does not count', async () => {
    const assistant = await as(desk, desk.assistantAutonomous);
    for (const outcome of ['drafted', 'escalated'] as const) {
      const breached = await breachedAfter(
        async (id) => {
          await assistant.invoke('ticket0/record-answer', {
            conversationId: id,
            turnId: `turn-${outcome}-${id}`,
            model: 'test/none',
            body: 'Here is how.',
            inputTokens: 1,
            outputTokens: 1,
            citedArticleIds: [],
            outcome,
          });
        },
        async () => (await chat(desk)).conversationId,
      );
      expect(breached, outcome).toBe(true);
    }
  });
});

describe('late is on record whether or not a sweep ran in between', () => {
  it('a reply after the due instant records the breach itself — and tells nobody, because it is answered', async () => {
    const desk = await freshDesk({ agents: 2, sla: FR_30 });
    const id = await mail(desk);
    advance(31);
    await reply(desk, id);
    const row = await read(desk, id);
    expect(row.first_response_breached_at).toBe(clock.now());

    const [event] = breachEvents(desk, id);
    expect(event!.operation).toBe('ticket0/post-public-reply');
    expect(event!.payload).toMatchObject({ id, target: 'first_response', due_at: row.first_response_due_at });
    for (const who of desk.agents) expect(await escalations(desk, who, id)).toBe(0);

    // And the sweep does not record it a second time.
    expect(await sweep(desk)).toBe(0);
    expect(breachEvents(desk, id)).toHaveLength(1);
  });

  it('resolving after the resolution target records it the same way', async () => {
    const desk = await freshDesk({ agents: 1, sla: { resolutionMinutes: { normal: 60 } } });
    const id = await mail(desk);
    await reply(desk, id);
    advance(61);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: id });
    const row = await read(desk, id);
    expect(row.resolution_breached_at).toBe(clock.now());
    expect(breachEvents(desk, id).map((e) => [e.operation, e.payload.target])).toEqual([
      ['ticket0/resolve', 'resolution'],
    ]);
  });

  it('on time is not late: a reply and a resolution inside their targets record nothing', async () => {
    const desk = await freshDesk({
      agents: 1,
      sla: { firstResponseMinutes: { normal: 30 }, resolutionMinutes: { normal: 60 } },
    });
    const id = await mail(desk);
    advance(29);
    await reply(desk, id);
    advance(30);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: id });
    const row = await read(desk, id);
    expect(row.first_response_breached_at).toBeNull();
    expect(row.resolution_breached_at).toBeNull();
    expect(breachEvents(desk, id)).toEqual([]);
  });
});

describe('resolution: what meets it, and what never breaches', () => {
  const RES_60: Sla = { resolutionMinutes: { normal: 60 } };

  it('resolved on time stays met, even after the customer writes again and it waits past the target', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const from = 'thanks@customer.example';
    const id = await mail(desk, { from });
    await reply(desk, id);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: id });
    await writeAgain(desk, id, from);
    expect((await read(desk, id)).state).toBe('open');
    advance(24 * 60);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, id)).resolution_breached_at).toBeNull();
  });

  it('closed without being resolved never breaches — the desk said it was not its to answer', async () => {
    const desk = await freshDesk({ agents: 1, sla: { ...RES_60, ...FR_30 } });
    const id = await mail(desk);
    await (await admin(desk)).invoke('ticket0/close', { conversationId: id });
    advance(24 * 60);
    expect(await sweep(desk)).toBe(0);
    const row = await read(desk, id);
    expect(row.first_response_breached_at).toBeNull();
    expect(row.resolution_breached_at).toBeNull();
  });

  // This pinned "a snooze does not stop the clock, for either target" until #1648, which
  // changed that property on purpose: resolution pauses, first response does not. The
  // pause itself is driven in its own block below.
  it('a snooze stops the resolution clock and not the first-response one (#1648)', async () => {
    const desk = await freshDesk({ agents: 1, sla: { ...RES_60, ...FR_30 } });
    const a = await agent(desk);
    // Parked before anybody answered: the customer is still waiting for a first word.
    const unanswered = await mail(desk);
    await a.invoke('ticket0/assign', { conversationId: unanswered, assignee: desk.agents[0] });
    await a.invoke('ticket0/snooze', { conversationId: unanswered, until: plus(clock.now(), 180) });
    // Answered, then parked: waiting on the customer, which is not the desk's time.
    const answered = await mail(desk);
    await reply(desk, answered);
    await a.invoke('ticket0/snooze', { conversationId: answered, until: plus(clock.now(), 180) });

    advance(61);
    // Only the unanswered one's first response. Before #1648 this was 3: both
    // resolutions breached while parked.
    expect(await sweep(desk)).toBe(1);
    const u = await read(desk, unanswered);
    const r = await read(desk, answered);
    expect(u.state).toBe('snoozed');
    expect(u.first_response_breached_at).not.toBeNull();
    expect(u.resolution_breached_at).toBeNull();
    expect(r.state).toBe('snoozed');
    expect(r.first_response_breached_at).toBeNull();
    expect(r.resolution_breached_at).toBeNull();
  });

  it('the losing half of a merge is never breached; the survivor keeps its own targets', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    const loser = await mail(desk, { from: 'twice@customer.example' });
    const survivor = await mail(desk, { from: 'twice@customer.example' });
    await (await admin(desk)).invoke('ticket0/merge', { conversationId: loser, intoConversationId: survivor });
    advance(31);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, loser)).first_response_breached_at).toBeNull();
    expect((await read(desk, survivor)).first_response_breached_at).not.toBeNull();
  });
});

/**
 * A snooze pauses the resolution target (#1648). The time a conversation sleeps is given
 * back to its resolution due when it wakes, by whichever door it wakes through, and a due
 * that fell inside the snooze is never a breach.
 */
describe('a snooze pauses the resolution clock, and waking gives the time back (#1648)', () => {
  const RES_60: Sla = { resolutionMinutes: { normal: 60 } };

  /** The desk's timer behind `snooze`, as the platform sweep invokes it. */
  async function timer(desk: Desk): Promise<number> {
    const stub = await host.getSystemScope(TICKET0, desk.tenant, desk.scope);
    return ((await stub.invoke('ticket0/wake-snoozed')) as { woke: number }).woke;
  }

  /** Arrived and answered: its resolution target is the one still running. */
  async function answered(desk: Desk, opts: { from?: string } = {}): Promise<Conversation> {
    const id = await mail(desk, opts);
    await reply(desk, id);
    return read(desk, id);
  }

  async function snooze(desk: Desk, id: string, minutes: number): Promise<void> {
    await (await agent(desk)).invoke('ticket0/snooze', { conversationId: id, until: plus(clock.now(), minutes) });
  }

  async function wake(desk: Desk, id: string): Promise<void> {
    await (await agent(desk)).invoke('ticket0/wake', { conversationId: id });
  }

  /**
   * Stand in for a conversation snoozed before `snoozed_at` existed — every conversation
   * asleep on a desk the moment this deploys. Harness code.
   */
  function forgetSnoozeStart(desk: Desk, id: string): void {
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
    try {
      db.prepare('UPDATE ticket0_conversations SET snoozed_at = NULL WHERE id = ?').run(id);
    } finally {
      db.close();
    }
  }

  it('the timer wakes it with the time it slept added, and a due that passed while it slept is no breach', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const before = await answered(desk);
    advance(10);
    await snooze(desk, before.id, 180);
    expect((await read(desk, before.id)).snoozed_at).toBe(clock.now());

    // The original due passes two hours into the snooze. Paused, it is not in the scan.
    advance(180);
    expect(clock.now() > before.resolution_due_at!).toBe(true);
    expect(await sweep(desk)).toBe(0);

    expect(await timer(desk)).toBe(1);
    const woke = await read(desk, before.id);
    expect(woke.state).toBe('open');
    expect(woke.snoozed_at).toBeNull();
    expect(woke.snoozed_ms).toBe(180 * MINUTE);
    expect(woke.resolution_due_at).toBe(plus(before.resolution_due_at!, 180));
    // Woken, it is recomputed before anything reads it: the sweep that follows finds
    // nothing late.
    expect(await sweep(desk)).toBe(0);
    expect(woke.resolution_breached_at).toBeNull();

    // …and the pushed-back due is a real one. At it, on time; one minute past, missed.
    advance((Date.parse(woke.resolution_due_at!) - Date.parse(clock.now())) / MINUTE);
    expect(await sweep(desk)).toBe(0);
    advance(1);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, before.id)).resolution_breached_at).toBe(clock.now());
  });

  it('a person waking it by hand gives back exactly what the timer does', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const byHand = await answered(desk);
    const byTimer = await answered(desk);
    advance(5);
    await snooze(desk, byHand.id, 120);
    await snooze(desk, byTimer.id, 120);
    advance(120);
    await wake(desk, byHand.id);
    expect(await timer(desk)).toBe(1);

    const h = await read(desk, byHand.id);
    const t = await read(desk, byTimer.id);
    expect(h.resolution_due_at).toBe(plus(byHand.resolution_due_at!, 120));
    expect(t.resolution_due_at).toBe(plus(byTimer.resolution_due_at!, 120));
    expect(h.snoozed_ms).toBe(t.snoozed_ms);
  });

  it('the customer writing into it wakes it the same way', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const from = 'back@customer.example';
    const before = await answered(desk, { from });
    await snooze(desk, before.id, 600);
    advance(90);
    await writeAgain(desk, before.id, from);
    const after = await read(desk, before.id);
    expect(after.state).toBe('open');
    expect(after.snoozed_at).toBeNull();
    expect(after.resolution_due_at).toBe(plus(before.resolution_due_at!, 90));
  });

  it('repeated snoozes add up', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const before = await answered(desk);
    await snooze(desk, before.id, 600);
    advance(100);
    await wake(desk, before.id);
    advance(5);
    await snooze(desk, before.id, 600);
    advance(50);
    await wake(desk, before.id);
    const after = await read(desk, before.id);
    expect(after.snoozed_ms).toBe(150 * MINUTE);
    expect(after.resolution_due_at).toBe(plus(before.resolution_due_at!, 150));
  });

  it('first response keeps running while it sleeps, and waking gives it nothing back', async () => {
    const desk = await freshDesk({ agents: 1, sla: { ...RES_60, ...FR_30 } });
    const id = await mail(desk);
    const before = await read(desk, id);
    await (await agent(desk)).invoke('ticket0/assign', { conversationId: id, assignee: desk.agents[0] });
    await snooze(desk, id, 600);
    advance(20);
    await wake(desk, id);
    const after = await read(desk, id);
    expect(after.first_response_due_at).toBe(before.first_response_due_at);
    expect(after.resolution_due_at).toBe(plus(before.resolution_due_at!, 20));
  });

  it('resolved while it sleeps is not late, though its original due passed during the snooze', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const before = await answered(desk);
    await snooze(desk, before.id, 600);
    advance(200);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: before.id });
    const after = await read(desk, before.id);
    expect(after.state).toBe('resolved');
    expect(after.snoozed_at).toBeNull();
    expect(after.resolution_breached_at).toBeNull();
    expect(breachEvents(desk, before.id)).toEqual([]);
    // The resolve ended the snooze before it judged lateness: the due it met is the one
    // the snooze pushed back, and the time was counted once, not twice.
    expect(after.resolution_due_at).toBe(plus(before.resolution_due_at!, 200));
    expect(after.snoozed_ms).toBe(200 * MINUTE);
  });

  it('a late resolve or reply is judged against the pushed-back due — on either side of it', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const onTime = await answered(desk);
    const late = await answered(desk);
    advance(10);
    await snooze(desk, onTime.id, 120);
    await snooze(desk, late.id, 120);
    advance(120);
    expect(await timer(desk)).toBe(2);
    // Past both original dues, and before both pushed-back ones. No sweep runs from here,
    // so the resolve is the only thing that can record lateness.
    const pushed = (await read(desk, onTime.id)).resolution_due_at!;
    advance((Date.parse(pushed) - Date.parse(clock.now())) / MINUTE - 5);
    expect(clock.now() > onTime.resolution_due_at!).toBe(true);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: onTime.id });
    expect((await read(desk, onTime.id)).resolution_breached_at).toBeNull();

    advance(10);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: late.id });
    expect((await read(desk, late.id)).resolution_breached_at).toBe(clock.now());
    expect(breachEvents(desk, late.id).map((e) => e.operation)).toEqual(['ticket0/resolve']);
  });

  it('snoozing a conversation already late records the miss first, and tells nobody', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const late = await answered(desk);
    const onTime = await answered(desk);
    await (await admin(desk)).invoke('ticket0/assign', { conversationId: late.id, assignee: desk.agents[0] });
    // No sweep has run: only the snooze can notice.
    advance(60);
    await snooze(desk, onTime.id, 600);
    await snooze(desk, late.id, 600);
    expect((await read(desk, onTime.id)).resolution_breached_at).toBeNull();
    const row = await read(desk, late.id);
    expect(row.state).toBe('snoozed');
    expect(row.resolution_breached_at).toBe(clock.now());
    expect(breachEvents(desk, late.id).map((e) => e.operation)).toEqual(['ticket0/snooze']);
    expect(await escalations(desk, desk.agents[0]!, late.id)).toBe(0);
    // A miss is history: waking does not move its due or un-miss it.
    advance(30);
    await wake(desk, late.id);
    const woke = await read(desk, late.id);
    expect(woke.resolution_due_at).toBe(late.resolution_due_at);
    expect(woke.resolution_breached_at).toBe(row.resolution_breached_at);
  });

  it('a priority change re-aims past the time already slept, and a snooze in progress is added when it ends', async () => {
    const RES_BY_PRIORITY: Sla = { resolutionMinutes: { normal: 600, urgent: 240 } };
    const desk = await freshDesk({ agents: 1, sla: RES_BY_PRIORITY });
    const a = await agent(desk);
    const slept = await answered(desk);
    const never = await answered(desk);
    const during = await answered(desk);

    await snooze(desk, slept.id, 600);
    advance(100);
    await wake(desk, slept.id);
    await a.invoke('ticket0/set-priority', { conversationId: slept.id, priority: 'urgent' });
    await a.invoke('ticket0/set-priority', { conversationId: never.id, priority: 'urgent' });
    expect((await read(desk, slept.id)).resolution_due_at).toBe(plus(slept.created_at, 240 + 100));
    expect((await read(desk, never.id)).resolution_due_at).toBe(plus(never.created_at, 240));

    await snooze(desk, during.id, 600);
    advance(30);
    await a.invoke('ticket0/set-priority', { conversationId: during.id, priority: 'urgent' });
    expect((await read(desk, during.id)).resolution_due_at).toBe(plus(during.created_at, 240));
    advance(70);
    await wake(desk, during.id);
    expect((await read(desk, during.id)).resolution_due_at).toBe(plus(during.created_at, 240 + 100));
  });

  it('closing a sleeping conversation ends its snooze too', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const before = await answered(desk);
    await snooze(desk, before.id, 600);
    advance(15);
    await (await admin(desk)).invoke('ticket0/close', { conversationId: before.id });
    const after = await read(desk, before.id);
    expect(after.snoozed_at).toBeNull();
    expect(after.snoozed_ms).toBe(15 * MINUTE);
  });

  it('one snoozed before the pause existed keeps its clock running until it wakes', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const legacy = await answered(desk);
    const resolvedFromLegacy = await answered(desk);
    for (const c of [legacy, resolvedFromLegacy]) {
      await snooze(desk, c.id, 600);
      forgetSnoozeStart(desk, c.id);
    }

    // Both stay asleep past their dues, with the clock running as it always did: a
    // resolve straight out of the snooze records its own miss, and the sweep sees the other.
    advance(70);
    await (await agent(desk)).invoke('ticket0/resolve', { conversationId: resolvedFromLegacy.id });
    expect((await read(desk, resolvedFromLegacy.id)).resolution_breached_at).toBe(clock.now());
    expect(await sweep(desk)).toBe(1);
    const l = await read(desk, legacy.id);
    expect(l.state).toBe('snoozed');
    expect(l.resolution_breached_at).toBe(clock.now());
    // Nothing to give back when it wakes.
    await wake(desk, legacy.id);
    expect((await read(desk, legacy.id)).resolution_due_at).toBe(legacy.resolution_due_at);
    expect((await read(desk, legacy.id)).snoozed_ms).toBeNull();
  });

  it('one snoozed before the pause existed wakes with nothing given back, and its next snooze pauses', async () => {
    const desk = await freshDesk({ agents: 1, sla: RES_60 });
    const c = await answered(desk);
    await snooze(desk, c.id, 600);
    forgetSnoozeStart(desk, c.id);
    advance(10);
    await wake(desk, c.id);
    expect((await read(desk, c.id)).resolution_due_at).toBe(c.resolution_due_at);
    await snooze(desk, c.id, 600);
    advance(100);
    expect(await sweep(desk)).toBe(0);
    await wake(desk, c.id);
    expect((await read(desk, c.id)).resolution_due_at).toBe(plus(c.resolution_due_at!, 100));
  });
});

describe('a breach is recorded once and announced once', () => {
  it('to whoever holds it; a second sweep finds nothing and tells nobody again', async () => {
    const desk = await freshDesk({ agents: 2, sla: FR_30 });
    const id = await mail(desk);
    const holder = desk.agents[1]!;
    await (await admin(desk)).invoke('ticket0/assign', { conversationId: id, assignee: holder });
    advance(31);

    expect(await sweep(desk)).toBe(1);
    const stamped = (await read(desk, id)).first_response_breached_at;
    expect(stamped).toBe(clock.now());
    expect(await escalations(desk, holder, id)).toBe(1);
    expect(await escalations(desk, desk.agents[0]!, id)).toBe(0);

    advance(5);
    expect(await sweep(desk)).toBe(0);
    advance(5);
    expect(await sweep(desk)).toBe(0);
    expect((await read(desk, id)).first_response_breached_at).toBe(stamped);
    expect(breachEvents(desk, id)).toHaveLength(1);
    expect(await escalations(desk, holder, id)).toBe(1);
  });

  it('to everybody on the desk when nobody holds it — the assistant excepted', async () => {
    const desk = await freshDesk({ agents: 3, sla: FR_30 });
    const id = await mail(desk);
    advance(31);
    expect(await sweep(desk)).toBe(1);
    for (const who of desk.agents) expect(await escalations(desk, who, id)).toBe(1);
    // The assistant holds no key to read its own notifications, so the table is read
    // directly: nothing was written for it at all.
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
    try {
      const rows = db
        .prepare(`SELECT principal FROM ticket0_notifications WHERE kind = 'escalated' AND conversation_id = ?`)
        .all(id) as { principal: string }[];
      expect(rows.map((r) => r.principal).sort()).toEqual([...desk.agents].sort());
    } finally {
      db.close();
    }
  });

  it('both targets missed in one run: two breaches on the trail, one notice per person', async () => {
    const desk = await freshDesk({
      agents: 1,
      sla: { firstResponseMinutes: { normal: 30 }, resolutionMinutes: { normal: 60 } },
    });
    const id = await mail(desk);
    advance(61);
    expect(await sweep(desk)).toBe(2);
    const row = await read(desk, id);
    expect(row.first_response_breached_at).toBe(clock.now());
    expect(row.resolution_breached_at).toBe(clock.now());
    expect(breachEvents(desk, id).map((e) => e.payload.target)).toEqual(['first_response', 'resolution']);
    expect(await escalations(desk, desk.agents[0]!, id)).toBe(1);
  });

  it('leaves `updated_at` alone: a breach is not activity, and moves no inbox and no reaper', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    const id = await mail(desk);
    const before = (await read(desk, id)).updated_at;
    advance(31);
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, id)).updated_at).toBe(before);
  });
});

describe('its own key, a real check, and a trail that names the behaviour', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk({ agents: 1, sla: FR_30 });
  });

  it('records who acted, under which check, and which behaviour it was', async () => {
    const id = await mail(desk);
    advance(31);
    expect(await sweep(desk)).toBe(1);

    const [event] = breachEvents(desk, id);
    expect(JSON.parse(event!.actor)).toEqual({ system: ticket0Manifest.id });
    expect(event!.operation).toBe('ticket0/escalate-sla-breaches');
    const permissions = (JSON.parse(event!.authorization ?? '[]') as { permission: string }[]).map(
      (a) => a.permission,
    );
    expect(permissions).toContain('conversation:escalate');
    // Not recorded as an assignment: that is why the key is its own.
    expect(permissions).not.toContain('conversation:assign');
    const row = await read(desk, id);
    expect(event!.payload).toEqual({
      id,
      target: 'first_response',
      due_at: row.first_response_due_at,
      breached_at: row.first_response_breached_at,
      priority: 'normal',
      state: 'new',
      assignee: null,
    });
  });

  it('is refused to every person, the desk admin included — no role holds the key', async () => {
    await mail(desk);
    advance(31);
    for (const who of [desk.admin, desk.agents[0]!, desk.relay]) {
      await expect((await as(desk, who)).invoke('ticket0/escalate-sla-breaches')).rejects.toThrow(/denied/i);
    }
    // And allowed to the desk's own schedule, on the same desk, a moment later.
    expect(await sweep(desk)).toBe(1);
  });

  it('stops for a desk whose system grant is revoked — the check is a real one', async () => {
    await mail(desk);
    advance(31);
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
    try {
      const removed = db
        .prepare(`DELETE FROM _substrat_tuples WHERE subject = ? AND relation = 'granted:conversation:escalate'`)
        .run(`system:${ticket0Manifest.id}`);
      expect(removed.changes).toBe(1);
    } finally {
      db.close();
    }
    await expect(sweep(desk)).rejects.toThrow(/denied/i);
  });
});

describe('the scans are indexed, because they run on every tick', () => {
  it('each seeks its own partial index and sorts nothing', async () => {
    // A real scope's database, as the adapter built it: the module's migrations AND the
    // kernel's list indexes on `state`, `priority` and `assignee`, which are exactly the
    // competition for a WHERE that names `state`.
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    await mail(desk);
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
    try {
      for (const [target, index] of [
        ['first_response', 'ticket0_conversations_first_response_running'],
        ['resolution', 'ticket0_conversations_resolution_running'],
      ] as const) {
        const plan = (
          db.prepare(`EXPLAIN QUERY PLAN ${slaOverdueScan(target)}`).all(clock.now(), 200) as { detail: string }[]
        ).map((r) => r.detail);
        expect(plan, target).toContainEqual(
          expect.stringMatching(new RegExp(`^SEARCH ticket0_conversations USING INDEX ${index}\\b`)),
        );
        expect(plan.filter((d) => /^SCAN\b/.test(d)), target).toEqual([]);
        expect(plan.filter((d) => /TEMP B-TREE/.test(d)), target).toEqual([]);
      }
      // The plan alone would pass on 0012's index as well, since the scan's WHERE implies
      // the older, wider one. Migration 0014 (#1648) narrows the resolution index to the
      // conversations no snooze is holding, and that is a fact about the index itself.
      const where = (index: string) =>
        (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) as { sql: string })
          .sql;
      expect(where('ticket0_conversations_resolution_running')).toMatch(/AND snoozed_at IS NULL$/);
      expect(where('ticket0_conversations_first_response_running')).not.toMatch(/snoozed_at/);
    } finally {
      db.close();
    }
  });
});

describe('the platform sweep is the caller', () => {
  it('fires the declared schedule under the grant provisioning gave it, and the breach is recorded', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    const id = await mail(desk);
    advance(31);
    // Nothing here invokes the operation: the sweep reads what the manifest declares,
    // and provisioning granted the system principal `conversation:escalate`.
    const report = await host.runDueSchedules(TICKET0, desk.tenant, desk.scope);
    expect(report.errors).toEqual([]);
    expect(report.runs).toContainEqual({ operation: 'ticket0/escalate-sla-breaches', outcome: 'ok' });
    expect((await read(desk, id)).first_response_breached_at).toBe(clock.now());
  });
});

describe('the Settings form says what the desk will do', () => {
  const empty = (): SlaForm => slaFormOf(null);

  it('bounds the boxes by the same number the desk does', () => {
    expect(SLA_MAX_MINUTES).toBe(SLA_TARGET_MAX_MINUTES);
  });

  it('round-trips through the real desk: what it saves is what the desk stamps, and what it reads back', async () => {
    const desk = await freshDesk({ agents: 1 });
    const form = empty();
    form.firstResponse.urgent = '15';
    form.firstResponse.normal = '240';
    form.resolution.urgent = '480';
    expect(slaErrorOf(form)).toBeNull();
    const payload = slaPayloadOf(form);
    expect(payload).toEqual({ firstResponseMinutes: { urgent: 15, normal: 240 }, resolutionMinutes: { urgent: 480 } });

    await (await admin(desk)).invoke('ticket0/configure-desk', { settings: { roundRobin: false, sla: payload } });
    const saved = (await (await admin(desk)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(slaFormOf(saved.settings)).toEqual(form);
    const row = await read(desk, await mail(desk));
    expect(row.first_response_due_at).toBe(plus(row.created_at, 240));
    expect(row.resolution_due_at).toBeNull();
  });

  it('six empty boxes save as off, and the desk hears off', async () => {
    const desk = await freshDesk({ agents: 1, sla: FR_30 });
    expect(slaPayloadOf(empty())).toBeNull();
    await (await admin(desk)).invoke('ticket0/configure-desk', { settings: { sla: slaPayloadOf(empty()) } });
    const row = await read(desk, await mail(desk));
    expect(row.first_response_due_at).toBeNull();
    const saved = (await (await admin(desk)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(slaFormOf(saved.settings)).toEqual(empty());
  });

  it('names the box it will not save, and accepts the bounds themselves', () => {
    const at = (value: string) => {
      const form = empty();
      form.resolution.low = value;
      return slaErrorOf(form);
    };
    expect(at('0')).toMatch(/Resolution, low: at least 1 minute/);
    expect(at('1.5')).toMatch(/whole minutes/);
    expect(at('abc')).toMatch(/whole minutes/);
    expect(at(String(SLA_MAX_MINUTES + 1))).toMatch(/at most/);
    expect(at('1')).toBeNull();
    expect(at(String(SLA_MAX_MINUTES))).toBeNull();
    expect(at('')).toBeNull();
    expect(at('   ')).toBeNull();
  });

  it('shows an empty box for anything the desk would not apply, rather than a target it ignores', () => {
    const raw = JSON.stringify({
      sla: { firstResponseMinutes: { urgent: 0, normal: '30', low: 1.5 }, resolutionMinutes: { normal: 60 } },
    });
    const form = slaFormOf(raw);
    expect(form.firstResponse).toEqual({ urgent: '', normal: '', low: '' });
    expect(form.resolution).toEqual({ urgent: '', normal: '60', low: '' });
    expect(slaFormOf('not json')).toEqual(empty());
    expect(slaFormOf(JSON.stringify({ sla: null }))).toEqual(empty());
  });

  it('reads minutes back as a duration', () => {
    expect(formatMinutes(15)).toBe('15 min');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(480)).toBe('8 h');
    expect(formatMinutes(2880)).toBe('2 d');
    expect(formatMinutes(1501)).toBe('1 d 1 h 1 min');
  });
});

describe('the inbox row says what the desk recorded, and nothing more', () => {
  it('names the target missed from the stamps alone', async () => {
    const desk = await freshDesk({
      agents: 1,
      sla: { firstResponseMinutes: { normal: 30 }, resolutionMinutes: { normal: 60 } },
    });
    const id = await mail(desk);
    // Overdue by the clock, but not yet swept: the row says nothing, as the desk has said nothing.
    advance(31);
    expect(slaMissedLabel(await read(desk, id))).toBeNull();
    await sweep(desk);
    expect(slaMissedLabel(await read(desk, id))).toBe('missed first-response target');
    advance(30);
    await sweep(desk);
    expect(slaMissedLabel(await read(desk, id))).toBe('missed both targets');
    expect(
      slaMissedLabel({ first_response_breached_at: null, resolution_breached_at: '2026-09-21T09:00:00.000Z' }),
    ).toBe('missed resolution target');
  });
});
