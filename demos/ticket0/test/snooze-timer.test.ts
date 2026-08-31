/**
 * The one thing in this desk that happens because time passed (#1082).
 *
 * `snooze` is a claim about the future — park it and it comes back — and until this
 * suite existed nothing in the repo could tell a desk that honours that claim from
 * one that does not. A conversation left snoozed forever passes every other test in
 * this package, because every other test asks a person to click.
 *
 * Time here moves ON PURPOSE. The host runs a `manualClock`, so "an hour later" is an
 * assignment rather than a `setTimeout`: exact, instant, and the interesting branch
 * actually runs. Nothing sleeps and nothing shrinks a window to zero to get a pass.
 *
 * Two doors are driven, because they fail differently:
 *   - the operation, through the module's own system principal, which is what proves
 *     the handler wakes what is due and leaves what is not;
 *   - `runDueSchedules`, the platform sweep, which is what proves the schedule is
 *     DECLARED and that provisioning granted the system principal the key it checks.
 *     A handler nobody ever calls would pass the first and fail the second.
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

/** Distinct provider message ids without reaching for a clock this file controls. */
let arrivals = 0;

interface Conversation {
  id: string;
  state: string;
  assignee: string | null;
  snoozed_until: string | null;
}
interface Notification {
  id: string;
  kind: string;
  conversation_id: string | null;
}

/** The desk's own timer, as the platform sweep invokes it: the module's system actor. */
async function timer(desk: Desk): Promise<ScopeStub> {
  return host.getSystemScope(TICKET0, desk.tenant, desk.scope);
}

/**
 * A conversation that has arrived, been picked up by somebody, and is therefore in
 * the one state a snooze may be taken from. The assignee matters: they are who the
 * wake is announced to.
 */
async function openAndAssigned(desk: Desk): Promise<string> {
  const relay = await host.getScope(desk.relay.principal, desk.tenant, desk.scope);
  const arrived = (await relay.invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: 'later@customer.example',
    contactName: 'Later',
    subject: 'Something for next week',
    bodyText: 'No rush on this one.',
    emailMessageId: `<later-${(arrivals += 1)}@mail.example>`,
  })) as { conversation_id: string };

  const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
  const assigned = (await agent.invoke('ticket0/assign', {
    conversationId: arrived.conversation_id,
    assignee: desk.admin.principal,
  })) as Conversation;
  expect(assigned.state).toBe('open');
  return assigned.id;
}

/**
 * The conversation as an agent sees it — read back through the operation the app
 * calls, never out of the table. What the sweep wrote and what a person would see
 * have to be the same thing for any of this to mean anything.
 */
async function readConversation(desk: Desk, id: string): Promise<Conversation> {
  const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
  return (await agent.invoke('ticket0/get-conversation', {
    conversationId: id,
  })) as Conversation;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-snooze-'));
  clock = manualClock('2026-03-02T09:00:00.000Z');
  host = buildHost(dir, clock.read);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a snooze is a promise about the future, and something has to keep it', () => {
  let parked = '';

  it('parks a conversation until a time nobody has reached yet', async () => {
    const desk = world.substrat;
    parked = await openAndAssigned(desk);

    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
    const snoozed = (await agent.invoke('ticket0/snooze', {
      conversationId: parked,
      until: new Date(Date.parse(clock.now()) + 60 * 60_000).toISOString(),
    })) as Conversation;

    expect(snoozed.state).toBe('snoozed');
    expect(snoozed.snoozed_until).not.toBeNull();
  });

  it('leaves it alone while the hour has not passed', async () => {
    // The sweep runs — it always runs — and finds nothing due. "Woke nothing" is the
    // assertion that separates a timer from a switch that empties the snooze queue.
    const swept = (await (await timer(world.substrat)).invoke('ticket0/wake-snoozed')) as {
      woke: number;
    };
    expect(swept.woke).toBe(0);
    expect((await readConversation(world.substrat, parked)).state).toBe('snoozed');
  });

  it('brings it back once the time is reached, and clears the alarm', async () => {
    clock.advance(90 * 60_000);

    const swept = (await (await timer(world.substrat)).invoke('ticket0/wake-snoozed')) as {
      woke: number;
    };
    expect(swept.woke).toBe(1);

    const woken = await readConversation(world.substrat, parked);
    expect(woken.state).toBe('open');
    // Cleared, not merely passed: a lapsed timestamp left behind would wake the same
    // conversation on every sweep for the rest of the desk's life.
    expect(woken.snoozed_until).toBeNull();
  });

  it('tells whoever is holding it — the notification kind that had no producer', async () => {
    const desk = world.substrat;
    const admin = await host.getScope(desk.admin.principal, desk.tenant, desk.scope);
    const mine = (await admin.invoke('ticket0/my-notifications', {})) as Page<Notification>;
    const woke = mine.entries.filter((n) => n.kind === 'snooze-woke');

    expect(woke.map((n) => n.conversation_id)).toContain(parked);
  });

  it('wakes nothing on a second pass — the conversation is no longer snoozed', async () => {
    const swept = (await (await timer(world.substrat)).invoke('ticket0/wake-snoozed')) as {
      woke: number;
    };
    expect(swept.woke).toBe(0);
  });
});

describe('the alarm is an instant, because a timer compares it as text', () => {
  it('normalises an offset to UTC rather than sorting it wrong', async () => {
    const desk = world.substrat;
    const id = await openAndAssigned(desk);
    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);

    // 11:00+02:00 is 09:00 UTC. Stored verbatim it sorts as though it were 11:00 UTC
    // — two hours late — and every comparison the sweep makes is wrong by the offset.
    const snoozed = (await agent.invoke('ticket0/snooze', {
      conversationId: id,
      until: '2026-03-09T11:00:00+02:00',
    })) as Conversation;
    expect(snoozed.snoozed_until).toBe('2026-03-09T09:00:00.000Z');
  });

  it('refuses a value that is not a timestamp at all', async () => {
    const desk = world.substrat;
    const id = await openAndAssigned(desk);
    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);

    // Not a pedantic refusal: an unparseable alarm either sorts before every instant
    // and wakes at once, or after every instant and never wakes. Both are silent.
    await expect(
      agent.invoke('ticket0/snooze', { conversationId: id, until: 'next tuesday' }),
    ).rejects.toThrow();
    expect((await readConversation(desk, id)).state).toBe('open');
  });
});

describe('the platform sweep is the caller, and one desk never reaches another', () => {
  it('fires the declared schedule, and it does the same thing', async () => {
    const desk = world.substrat;
    const id = await openAndAssigned(desk);
    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
    await agent.invoke('ticket0/snooze', {
      conversationId: id,
      until: new Date(Date.parse(clock.now()) + 30 * 60_000).toISOString(),
    });

    clock.advance(45 * 60_000);

    // No operation name here on purpose. The sweep reads what the manifest declares;
    // if the schedule were removed, this goes to `fired: 0` and the conversation
    // stays snoozed — which is exactly the regression this file exists to catch.
    const report = await host.runDueSchedules(TICKET0, desk.tenant, desk.scope);
    expect(report.errors).toEqual([]);
    expect(report.fired).toBe(1);

    expect((await readConversation(desk, id)).state).toBe('open');
  });

  it('sweeping Kestrel wakes nothing of Substrat’s', async () => {
    const kestrel = world.kestrel;
    const parked = await openAndAssigned(kestrel);
    const substratParked = await openAndAssigned(world.substrat);

    for (const [desk, id] of [
      [kestrel, parked],
      [world.substrat, substratParked],
    ] as const) {
      const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
      await agent.invoke('ticket0/snooze', {
        conversationId: id,
        until: new Date(Date.parse(clock.now()) + 10 * 60_000).toISOString(),
      });
    }

    clock.advance(20 * 60_000);
    const swept = (await (await timer(kestrel)).invoke('ticket0/wake-snoozed')) as { woke: number };

    expect(swept.woke).toBe(1);
    expect((await readConversation(kestrel, parked)).state).toBe('open');
    expect((await readConversation(world.substrat, substratParked)).state).toBe('snoozed');
  });
});
