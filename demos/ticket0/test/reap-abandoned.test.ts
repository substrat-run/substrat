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
 * shrinks the window to zero to get a pass — the default is the shipped thirty in
 * every case up to the last block, which is where a desk says a number of its own and
 * the file advances the clock against THAT.
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

/** The shipped DEFAULT window — what a desk that has said nothing reaps at. Restated
 *  rather than imported, so a change to it fails here and is read, not guessed. */
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

/** Only the column this file is about — the rest of the row is other suites' business. */
interface DeskSettings {
  abandoned_after_days: number | null;
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
   * A drafted answer nobody has sent yet.
   *
   * `ticket0/record-answer` is an `allow` on `new` rather than an edge out of it, so a
   * supervised assistant writing an answer leaves the conversation exactly where it
   * was — the one way a `new` conversation has been worked on. Reaping it strands the
   * draft twice: `closed` is terminal, so it can never be sent, and
   * `ticket0/assistant-health` goes on listing it as waiting, because its predicate
   * asks whether a public reply followed the turn and a closed conversation never gets
   * one. That is the "sits on this list forever with nothing able to clear it" the
   * health read was written to avoid, arriving through the back door.
   */
  it('leaves one the assistant has drafted an answer on — and the queue stays clearable', async () => {
    const desk = world.kestrel;
    const drafted = await arrives(desk, 'The assistant wrote something');
    const assistant = await host.getScope(desk.assistant.principal, desk.tenant, desk.scope);
    await assistant.invoke('ticket0/record-answer', {
      conversationId: drafted,
      turnId: `turn-${(arrivals += 1)}`,
      model: 'test/fake',
      body: 'Here is what I would say.',
      inputTokens: 5,
      outputTokens: 5,
      citedArticleIds: [],
      outcome: 'drafted',
    });
    expect((await readConversation(desk, drafted)).state).toBe('new');

    clock.advance(2 * ABANDONED_AFTER_DAYS * DAY);
    await reap(desk);
    expect((await readConversation(desk, drafted)).state).toBe('new');

    // And the draft is still sendable, which is the property the state was protecting.
    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
    await agent.invoke('ticket0/post-public-reply', {
      conversationId: drafted,
      body: 'Here is what I would say.',
    });
    expect((await readConversation(desk, drafted)).state).toBe('open');
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

  /**
   * The other half of a merge, and the one that bites.
   *
   * Merging wrote `updated_at` on the LOSER only, so an old conversation chosen as the
   * SURVIVOR absorbed a whole thread this morning and still read as untouched since
   * whenever it last spoke — reapable on the very next sweep, the day after a person
   * deliberately kept it. `ticket0/merge` now touches the survivor too.
   */
  it('a survivor a person merged into today is not reaped tomorrow', async () => {
    const desk = world.kestrel;
    const admin = await host.getScope(desk.admin.principal, desk.tenant, desk.scope);
    const both = 'merged-late@customer.example';

    const survivor = await arrives(desk, 'The old thread', both);
    // Long enough that the survivor is well past the window on its own clock.
    clock.advance(2 * ABANDONED_AFTER_DAYS * DAY);
    const loser = await arrives(desk, 'The same person, again', both);
    await admin.invoke('ticket0/merge', { conversationId: loser, intoConversationId: survivor });

    clock.advance(DAY);
    await reap(desk);
    expect((await readConversation(desk, survivor)).state).toBe('new');

    // And it is not exempt forever — silence from here still counts.
    clock.advance((ABANDONED_AFTER_DAYS + 1) * DAY);
    await reap(desk);
    expect((await readConversation(desk, survivor)).state).toBe('closed');
  });
});

describe('the batch bounds a transaction, it does not cap the feature', () => {
  /**
   * The claim `REAP_BATCH`'s comment makes, checked rather than asserted in prose.
   *
   * The scheduler fires a due schedule ONCE per sweep and records the run — a full
   * batch does not invoke it again — so the only thing that makes a capped batch a
   * bound rather than a ceiling is that the next sweep picks up where this one
   * stopped. A handler that filtered on something it then failed to change, or a query
   * whose ordering let the same 200 rows win every pass, would leave the remainder
   * `new` forever and look exactly like this test's first line.
   */
  it('stops at the batch and the next sweep takes the rest', async () => {
    const desk = world.kestrel;
    await drain(desk);
    const REAP_BATCH = 200;
    const extra = 5;
    for (let i = 0; i < REAP_BATCH + extra; i += 1) await arrives(desk, `Flood ${i}`);

    clock.advance((ABANDONED_AFTER_DAYS + 1) * DAY);
    expect(await reap(desk)).toBe(REAP_BATCH);
    expect(await reap(desk)).toBe(extra);
    expect(await reap(desk)).toBe(0);
  }, 60_000);
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

/**
 * The window is the desk's (#1088, the deferred half).
 *
 * Every case above runs on a desk that has never said anything about retention, and
 * they are the proof that the migration is behaviour-preserving: `abandoned_after_days`
 * is null on both of these desks throughout, and thirty is what they reap at.
 *
 * What this block adds is the other direction, and it is written to fail LOUDLY if the
 * column is not actually read. A handler that ignored it would still pass "a desk with
 * no setting reaps at thirty" — so the setting is moved BOTH ways here, shortened and
 * lengthened, and each is asserted at a moment that contradicts the default: a
 * seven-day desk closing mail eight days old, and a ninety-day desk still holding mail
 * that is forty days old and would be long gone at thirty.
 *
 * Kestrel throughout, so Substrat's desk stays the one with no setting on it, and the
 * setting is put back at the end of each case — the clock is shared with every test
 * above and a desk left at seven days would reap a later fixture out from under itself.
 */
describe('how long a desk waits is the desk’s own decision', () => {
  const desk = () => world.kestrel;

  /** `desk:configure` is a desk-admin key; an agent does not hold it. */
  async function configure(input: { abandonedAfterDays?: number | null }): Promise<DeskSettings> {
    const admin = await host.getScope(desk().admin.principal, desk().tenant, desk().scope);
    return (await admin.invoke('ticket0/configure-desk', input)) as DeskSettings;
  }

  async function readDesk(which: Desk): Promise<DeskSettings> {
    const admin = await host.getScope(which.admin.principal, which.tenant, which.scope);
    return (await admin.invoke('ticket0/get-desk')) as DeskSettings;
  }

  /**
   * Clear this desk's inbox whatever each row's age, then hand the window back.
   *
   * `drain()` alone reaps only what the CURRENT window admits, so a case that then
   * shortens the window would sweep up whatever sat between the two numbers and count
   * it as its own. The shared clock is years past the fixture by now, so one day
   * catches everything reapable — and the rows the sweep is supposed to spare (a
   * drafted answer, the losing half of a merge) are spared at any window, which is
   * exactly why this is safe to do here.
   */
  async function emptyInbox(): Promise<void> {
    await configure({ abandonedAfterDays: 1 });
    await drain(desk());
    await configure({ abandonedAfterDays: null });
  }

  it('a desk that has never said carries no setting, and reaps at the platform’s thirty', async () => {
    // The migration's whole claim, stated where it can fail: neither desk was
    // back-filled, and these are the desks every case above measured at thirty.
    expect((await readDesk(world.substrat)).abandoned_after_days).toBeNull();
    expect((await readDesk(world.kestrel)).abandoned_after_days).toBeNull();

    await emptyInbox();
    const id = await arrives(desk(), 'Nobody said otherwise');
    clock.advance(ABANDONED_AFTER_DAYS * DAY - DAY);
    expect(await reap(desk())).toBe(0);
    clock.advance(2 * DAY);
    expect(await reap(desk())).toBe(1);
    expect((await readConversation(desk(), id)).state).toBe('closed');
  });

  it('a desk that says seven reaps on the eighth day, three weeks before the default would', async () => {
    await emptyInbox();
    expect((await configure({ abandonedAfterDays: 7 })).abandoned_after_days).toBe(7);

    const id = await arrives(desk(), 'A desk in a hurry');
    clock.advance(6 * DAY);
    // Six days of silence is not seven, so the shorter window is a window and not a
    // switch — the same assertion the default case makes the day before thirty.
    expect(await reap(desk())).toBe(0);

    clock.advance(2 * DAY);
    expect(await reap(desk())).toBe(1);
    // Eight days. A handler still reading the constant would have left this `new` for
    // another three weeks, which is the failure this case exists to catch.
    expect((await readConversation(desk(), id)).state).toBe('closed');

    await configure({ abandonedAfterDays: null });
  });

  it('a desk that says ninety still has its mail at forty days, when thirty would have taken it', async () => {
    await emptyInbox();
    expect((await configure({ abandonedAfterDays: 90 })).abandoned_after_days).toBe(90);

    const id = await arrives(desk(), 'A desk that waits');
    clock.advance(40 * DAY);
    expect(await reap(desk())).toBe(0);
    expect((await readConversation(desk(), id)).state).toBe('new');

    clock.advance(51 * DAY);
    expect(await reap(desk())).toBe(1);
    expect((await readConversation(desk(), id)).state).toBe('closed');

    await configure({ abandonedAfterDays: null });
  });

  it('clearing the setting hands the window back to the platform', async () => {
    await emptyInbox();
    await configure({ abandonedAfterDays: 7 });
    // An explicit null is not the same as saying nothing: without it there is no way
    // back to the default once a desk has typed a number over it.
    expect((await configure({ abandonedAfterDays: null })).abandoned_after_days).toBeNull();

    const id = await arrives(desk(), 'Back to the default');
    clock.advance(8 * DAY);
    expect(await reap(desk())).toBe(0);

    clock.advance((ABANDONED_AFTER_DAYS - 8 + 1) * DAY);
    expect(await reap(desk())).toBe(1);
    expect((await readConversation(desk(), id)).state).toBe('closed');
  });

  it('leaves the setting alone when the call does not mention it', async () => {
    await configure({ abandonedAfterDays: 45 });
    const admin = await host.getScope(desk().admin.principal, desk().tenant, desk().scope);
    await admin.invoke('ticket0/configure-desk', { greeting: 'Hello again' });

    expect((await readDesk(desk())).abandoned_after_days).toBe(45);
    await configure({ abandonedAfterDays: null });
  });

  /**
   * `closed` is terminal, so the floor is what keeps "reap" from meaning "empty the
   * inbox on the next tick". Refused at the boundary by the declared input — the host
   * parses before the handler runs — which is why this asserts a rejected call rather
   * than a row that was written and then ignored.
   */
  it('refuses a window that would close this morning’s mail, or one that means never', async () => {
    for (const days of [0, -1, 1.5, 3651]) {
      await expect(configure({ abandonedAfterDays: days })).rejects.toThrow();
    }
    expect((await readDesk(desk())).abandoned_after_days).toBeNull();
  });
});
