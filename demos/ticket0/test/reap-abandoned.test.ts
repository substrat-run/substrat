/**
 * The reaper concept §9.1 named and nothing built until #1088.
 *
 * Two of this desk's doors are open to the whole internet, and each mints a
 * conversation from one sentence by somebody with no account. Nothing in the repo
 * could tell a desk that eventually clears those from one that carries every
 * abandoned "hello" for the rest of its life: an unreaped conversation passes every
 * other suite in this package, because every other suite asks a person to click.
 *
 * Time moves ON PURPOSE here, as it does in `snooze-timer.test.ts`: the host runs a
 * `manualClock`, so "five weeks later" is an assignment. Nothing sleeps, and nothing
 * shrinks the window to zero to get a pass — `ABANDONED_AFTER_DAYS` is the shipped
 * thirty in every case below.
 *
 * What each half proves:
 *   - the operation, invoked as the module's own system principal, is what says the
 *     sweep closes what is abandoned and — the larger half of the file — leaves alone
 *     everything that merely looks old;
 *   - `runDueSchedules`, the platform sweep, is what says the schedule is DECLARED and
 *     that provisioning granted the system principal `conversation:resolve`. A handler
 *     nobody ever calls passes the first and fails the second.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleId, type Page } from '@substrat-run/contracts';
import { manualClock, type ManualClock, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { ticket0Manifest } from '../src/manifest.js';
import { buildHost, seed, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let clock: ManualClock;

const TICKET0 = moduleId.parse(ticket0Manifest.id);

/** The shipped window, restated so a change to it fails here and is read, not guessed. */
const ABANDONED_AFTER_DAYS = 30;
const DAY = 86_400_000;

/** Distinct provider message ids without reaching for a clock this file controls. */
let arrivals = 0;

interface Conversation {
  id: string;
  state: string;
  assignee: string | null;
  resolved_at: string | null;
  updated_at: string;
}

/** The desk's own sweeps, as the platform invokes them: the module's system actor. */
async function timer(desk: Desk): Promise<ScopeStub> {
  return host.getSystemScope(TICKET0, desk.tenant, desk.scope);
}

async function reap(desk: Desk): Promise<number> {
  const swept = (await (await timer(desk)).invoke('ticket0/reap-abandoned')) as { reaped: number };
  return swept.reaped;
}

/**
 * Close whatever the seeded world already left lying in this desk's inbox.
 *
 * `seed()` builds a desk with mail in it, and by the time this file has advanced its
 * clock past a month some of that is abandoned by the definition under test — truly
 * so, which is why draining it is honest rather than a workaround. It is done where a
 * test asserts an exact COUNT, so that the number is about the rows that test created
 * rather than about how many conversations the fixture happens to seed.
 */
async function drain(desk: Desk): Promise<void> {
  while ((await reap(desk)) > 0) continue;
}

/**
 * Mail arriving from outside — the email door, and the state every conversation in
 * this file starts in. Nobody has read it, so it is `new`.
 */
async function arrives(desk: Desk, subject = 'Anyone there?', from?: string): Promise<string> {
  const nth = (arrivals += 1);
  const relay = await host.getScope(desk.relay.principal, desk.tenant, desk.scope);
  // No `In-Reply-To`, so this always opens a NEW conversation — even for an address the
  // desk already has a contact for, which is what the merge case below needs.
  const arrived = (await relay.invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: from ?? `stranger-${nth}@customer.example`,
    contactName: 'A Stranger',
    subject,
    bodyText: 'Hello?',
    emailMessageId: `<abandoned-${nth}@mail.example>`,
  })) as { conversation_id: string };
  return arrived.conversation_id;
}

/**
 * The conversation as an agent sees it — read back through the operation the app
 * calls, never out of the table. What a sweep wrote and what a person would see have
 * to be the same thing for any of this to mean anything.
 */
async function readConversation(desk: Desk, id: string): Promise<Conversation> {
  const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
  return (await agent.invoke('ticket0/get-conversation', {
    conversationId: id,
  })) as Conversation;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-reap-'));
  clock = manualClock('2026-03-02T09:00:00.000Z');
  host = buildHost(dir, clock.read);
  world = await seed(host);
  // `seed()` builds two desks with mail already in them, and this file's clock outruns
  // the retention window many times over — so the fixture's own inbox is abandoned by
  // the very definition under test. Age it past the window once and clear it here, so
  // that every count asserted below is about the conversations that test created.
  clock.advance((ABANDONED_AFTER_DAYS + 1) * DAY);
  await drain(world.substrat);
  await drain(world.kestrel);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a conversation nobody ever picked up eventually leaves the inbox', () => {
  let abandoned = '';

  it('leaves it alone the day before the window elapses', async () => {
    abandoned = await arrives(world.substrat, 'Nobody will read this');
    clock.advance(ABANDONED_AFTER_DAYS * DAY - DAY);

    // The sweep runs — it always runs — and reaps nothing. "Closed nothing" is the
    // assertion that separates a retention window from a switch that empties an inbox.
    expect(await reap(world.substrat)).toBe(0);
    expect((await readConversation(world.substrat, abandoned)).state).toBe('new');
  });

  it('closes it once the window has passed', async () => {
    clock.advance(2 * DAY);

    expect(await reap(world.substrat)).toBe(1);
    expect((await readConversation(world.substrat, abandoned)).state).toBe('closed');
  });

  it('does not launder the metric: a reaped conversation was never resolved', async () => {
    // `resolved_at` is written by `ticket0/resolve` and by nothing else, and the desk
    // reports count that column rather than `state`. A reaper that filled it in would
    // turn a month of silence into a month of answered mail.
    expect((await readConversation(world.substrat, abandoned)).resolved_at).toBeNull();
  });

  it('reaps nothing on a second pass — closed is not a state it can find again', async () => {
    expect(await reap(world.substrat)).toBe(0);
  });

  it('takes it out of the inbox a person actually looks at', async () => {
    const agent = await host.getScope(
      world.substrat.agent.principal,
      world.substrat.tenant,
      world.substrat.scope,
    );
    const inbox = (await agent.invoke('ticket0/list-conversations', {})) as Page<Conversation>;
    expect(inbox.entries.map((c) => c.id)).not.toContain(abandoned);
  });
});

describe('what the window measures is silence, not age', () => {
  it('a thread the customer added to yesterday is a day old, not a month', async () => {
    const desk = world.substrat;
    const id = await arrives(desk, 'Still talking');
    clock.advance(25 * DAY);

    // The same person writes again into the thread they already opened. This is the
    // case a reaper keyed on `created_at` gets wrong, and gets wrong silently: the
    // conversation is a month old and somebody is in the middle of it.
    const relay = await host.getScope(desk.relay.principal, desk.tenant, desk.scope);
    await relay.invoke('ticket0/ingest-message', {
      conversationId: id,
      contactEmail: 'ignored@customer.example',
      contactName: 'A Stranger',
      subject: 'Still talking',
      bodyText: 'Just following up.',
      emailMessageId: `<followup-${(arrivals += 1)}@mail.example>`,
    });

    clock.advance(10 * DAY);
    expect(await reap(desk)).toBe(0);
    expect((await readConversation(desk, id)).state).toBe('new');

    // And it does go, once the silence itself reaches a month.
    clock.advance(21 * DAY);
    expect(await reap(desk)).toBe(1);
    expect((await readConversation(desk, id)).state).toBe('closed');
  });
});

describe('everything a person has touched is off limits, however old', () => {
  /**
   * The three states that are not `new`, each reached the way a desk reaches it, each
   * then left for twice the window. A reaper that widened its query to "old" instead
   * of "untouched" closes all three, and every one of them is somebody's work.
   */
  it('never closes one that was assigned, answered, snoozed or resolved', async () => {
    const desk = world.kestrel;
    await drain(desk);
    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);

    const assigned = await arrives(desk, 'Picked up');
    await agent.invoke('ticket0/assign', {
      conversationId: assigned,
      assignee: desk.admin.principal,
    });

    const answered = await arrives(desk, 'Answered');
    await agent.invoke('ticket0/post-public-reply', {
      conversationId: answered,
      body: 'On it.',
    });

    const parked = await arrives(desk, 'Parked');
    await agent.invoke('ticket0/assign', { conversationId: parked, assignee: desk.admin.principal });
    await agent.invoke('ticket0/snooze', {
      conversationId: parked,
      until: new Date(Date.parse(clock.now()) + 90 * DAY).toISOString(),
    });

    const done = await arrives(desk, 'Done');
    await agent.invoke('ticket0/post-public-reply', { conversationId: done, body: 'Sorted.' });
    await agent.invoke('ticket0/resolve', { conversationId: done });

    // And one nobody touched beside them, so a sweep that reaped nothing for the wrong
    // reason — a broken predicate, say — fails here too.
    const untouched = await arrives(desk, 'Nobody touched this one');

    clock.advance(2 * ABANDONED_AFTER_DAYS * DAY);
    expect(await reap(desk)).toBe(1);

    expect((await readConversation(desk, untouched)).state).toBe('closed');
    expect((await readConversation(desk, assigned)).state).toBe('open');
    expect((await readConversation(desk, answered)).state).toBe('open');
    expect((await readConversation(desk, parked)).state).toBe('snoozed');
    expect((await readConversation(desk, done)).state).toBe('resolved');
  });

  /**
   * The losing half of a merge. It is already folded into a survivor and out of every
   * list the desk reads, and its state stayed `new` because merging moves nothing —
   * so it is the one row that matches "untouched and silent" while not being in the
   * inbox at all. Closing it would publish a second event about a conversation that
   * had stopped being one.
   */
  it('leaves a merged conversation to its survivor', async () => {
    const desk = world.kestrel;
    // `conversation:merge` is a desk-admin key, per `PERMISSIONS.md` — an agent does
    // not hold it.
    const admin = await host.getScope(desk.admin.principal, desk.tenant, desk.scope);

    // Merging is same-contact-only, so both halves are the same person writing twice.
    const twice = 'wrote-twice@customer.example';
    const survivor = await arrives(desk, 'The real one', twice);
    const folded = await arrives(desk, 'The same person, twice', twice);
    const merged = (await admin.invoke('ticket0/merge', {
      conversationId: folded,
      intoConversationId: survivor,
    })) as { merged_into: string | null };
    expect(merged.merged_into).toBe(survivor);

    clock.advance(2 * ABANDONED_AFTER_DAYS * DAY);
    await reap(desk);

    expect((await readConversation(desk, folded)).state).toBe('new');
  });
});

describe('the platform sweep is the caller, and one desk never reaches another', () => {
  it('fires the declared schedule, and it does the same thing', async () => {
    const desk = world.substrat;
    const id = await arrives(desk, 'For the schedule to find');
    clock.advance((ABANDONED_AFTER_DAYS + 1) * DAY);

    // No operation name here on purpose. The sweep reads what the manifest declares,
    // and it runs as the system principal provisioning granted — so this is also the
    // only assertion in the file that `conversation:resolve` is a key the schedule
    // actually holds. Remove the declaration and the conversation stays `new`.
    const report = await host.runDueSchedules(TICKET0, desk.tenant, desk.scope);
    expect(report.errors).toEqual([]);
    expect(report.runs).toContainEqual({ operation: 'ticket0/reap-abandoned', outcome: 'ok' });

    expect((await readConversation(desk, id)).state).toBe('closed');
  });

  it('sweeping Kestrel closes nothing of Substrat’s', async () => {
    await drain(world.kestrel);
    const kestrelId = await arrives(world.kestrel, 'Kestrel’s');
    const substratId = await arrives(world.substrat, 'Substrat’s');
    clock.advance((ABANDONED_AFTER_DAYS + 1) * DAY);

    expect(await reap(world.kestrel)).toBe(1);
    expect((await readConversation(world.kestrel, kestrelId)).state).toBe('closed');
    expect((await readConversation(world.substrat, substratId)).state).toBe('new');
  });
});
