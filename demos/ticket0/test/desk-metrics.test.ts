/**
 * The desk, measured (#1085) — and the only way to test a measurement of elapsed time
 * is to make time elapse on purpose.
 *
 * The host runs a `manualClock`, so "ninety minutes later" is an assignment: the
 * durations this suite asserts are exact seconds rather than "roughly", nothing sleeps,
 * and no window is shrunk to zero to buy a pass. Every fact is written through the
 * operations a person would use — an email arrives, an agent replies, an agent resolves,
 * a customer rates it — because a report assembled from rows a test inserted itself
 * would agree with the test forever and with the desk never.
 *
 * The window deliberately starts AFTER the seed. The seeded world is a working desk with
 * its own history, and a report that could not exclude it would be a report about the
 * fixture. Backlog is the one number that legitimately cannot be windowed — what is
 * waiting is a fact about now — so it is asserted as a DELTA against a baseline taken
 * before the story starts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualClock, type ManualClock, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { buildHost, seed, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let clock: ManualClock;

/** The seed runs here; everything the report is about happens after `WINDOW_FROM`. */
const SEEDED_AT = '2026-04-01T09:00:00.000Z';
const WINDOW_FROM = '2026-04-05T00:00:00.000Z';
const WINDOW_TO = '2026-04-07T00:00:00.000Z';

/** The story's timeline, named so an assertion below reads as arithmetic on it. */
const T = {
  aArrives: '2026-04-06T09:00:00.000Z',
  bArrives: '2026-04-06T09:10:00.000Z',
  aReplied: '2026-04-06T09:30:00.000Z', // 1800s after A arrived
  bReplied: '2026-04-06T10:00:00.000Z', // 3000s after B arrived
  aResolved: '2026-04-06T11:00:00.000Z', // 7200s after A arrived
  bResolved: '2026-04-06T13:00:00.000Z', // 13800s after B arrived
  cArrives: '2026-04-06T14:00:00.000Z', // left open, so the backlog has something in it
  rated: '2026-04-06T15:00:00.000Z',
} as const;

interface Metrics {
  from: string;
  to: string;
  volume: {
    opened: number;
    resolved: number;
    byChannel: { channel: string; opened: number; resolved: number }[];
  };
  firstResponse: { measured: number; medianSeconds: number | null; p90Seconds: number | null };
  resolution: { measured: number; medianSeconds: number | null; p90Seconds: number | null };
  backlog: {
    open: number;
    snoozed: number;
    unassigned: number;
    oldestUntouchedId: string | null;
    oldestUntouchedAgeSeconds: number | null;
  };
  agents: { principal: string; displayName: string | null; resolved: number; replies: number }[];
  csat: { responses: number; average: number | null };
  assistant: {
    turns: number;
    answered: number;
    drafted: number;
    escalated: number;
    failed: number;
    deflectionRate: number | null;
    escalationRate: number | null;
    failureRate: number | null;
    currency: string;
    cost: string;
    costPerResolved: string | null;
  };
}

type Role = 'admin' | 'agent' | 'assistant' | 'customer' | 'relay';

const at = (desk: Desk, role: Role): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

const desk = (): Desk => world.substrat;

const report = async (from = WINDOW_FROM, to = WINDOW_TO): Promise<Metrics> =>
  (await (await at(desk(), 'admin')).invoke('ticket0/desk-metrics', { from, to })) as Metrics;

/** An email arriving from outside, at the instant the clock currently reads. */
async function arrive(subject: string, id: string): Promise<string> {
  const relay = await at(desk(), 'relay');
  const message = (await relay.invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: desk().customer.email,
    contactName: desk().customer.name,
    subject,
    bodyText: `About ${subject}.`,
    emailMessageId: `<metrics-${id}@mail.example>`,
  })) as { conversation_id: string };
  return message.conversation_id;
}

/** The story, told once. Every step moves the clock before it acts. */
async function tellTheStory(): Promise<{ a: string; b: string; c: string }> {
  const agent = await at(desk(), 'agent');
  const assistant = await at(desk(), 'assistant');
  const customer = await at(desk(), 'customer');

  clock.set(T.aArrives);
  const a = await arrive('A duplicate charge', 'a');
  clock.set(T.bArrives);
  const b = await arrive('A password that will not reset', 'b');

  // Four turns on one conversation, one of each outcome — the four numbers the
  // assistant panel is made of, and the tokens they cost.
  await assistant.invoke('ticket0/record-answer', {
    conversationId: a,
    turnId: 'metrics-turn-answered',
    model: 'claude-sonnet-5',
    body: 'The duplicate charge was ours and it has been refunded.',
    inputTokens: 1000,
    outputTokens: 200,
    citedArticleIds: [],
    outcome: 'answered',
  });
  await assistant.invoke('ticket0/record-answer', {
    conversationId: a,
    turnId: 'metrics-turn-drafted',
    model: 'claude-sonnet-5',
    body: 'A draft somebody still has to read.',
    inputTokens: 500,
    outputTokens: 100,
    citedArticleIds: [],
    outcome: 'drafted',
  });
  await assistant.invoke('ticket0/record-answer', {
    conversationId: a,
    turnId: 'metrics-turn-escalated',
    model: 'claude-sonnet-5',
    body: 'This needs a person.',
    inputTokens: 300,
    outputTokens: 50,
    citedArticleIds: [],
    outcome: 'escalated',
  });
  await assistant.invoke('ticket0/record-answer', {
    conversationId: a,
    turnId: 'metrics-turn-failed',
    model: 'claude-sonnet-5',
    body: 'nothing',
    inputTokens: 0,
    outputTokens: 0,
    citedArticleIds: [],
    outcome: 'failed',
    error: '503 from the provider',
  });

  clock.set(T.aReplied);
  await agent.invoke('ticket0/assign', { conversationId: a, assignee: desk().agent.principal });
  await agent.invoke('ticket0/post-public-reply', { conversationId: a, body: 'Refunded — sorry.' });
  // An internal note in the same window, so the "replies" column proves it counts
  // public replies rather than everything an agent typed.
  await agent.invoke('ticket0/post-note', { conversationId: a, body: 'Refund reference 8812.' });

  clock.set(T.bReplied);
  await agent.invoke('ticket0/assign', { conversationId: b, assignee: desk().agent.principal });
  await agent.invoke('ticket0/post-public-reply', { conversationId: b, body: 'Reset link sent.' });

  clock.set(T.aResolved);
  await agent.invoke('ticket0/resolve', { conversationId: a });
  clock.set(T.bResolved);
  await agent.invoke('ticket0/resolve', { conversationId: b });

  clock.set(T.cArrives);
  const c = await arrive('A third thing nobody has picked up', 'c');

  clock.set(T.rated);
  await customer.invoke('ticket0/submit-csat', { conversationId: a, score: 5, comment: 'Fast.' });
  await customer.invoke('ticket0/submit-csat', { conversationId: b, score: 4, comment: null });

  return { a, b, c };
}

let story: { a: string; b: string; c: string };
let baseline: Metrics;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-metrics-'));
  clock = manualClock(SEEDED_AT);
  host = buildHost(dir, clock.read);
  world = await seed(host);
  // Taken before anything below happens, so the backlog assertions are about THIS story
  // and not about how many threads the fixture happens to leave open.
  clock.set(T.aArrives);
  baseline = await report();
  story = await tellTheStory();
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a desk that cannot be measured is a desk nobody can run', () => {
  it('counts what arrived and what was settled, per channel', async () => {
    const m = await report();
    expect(m.volume.opened).toBe(3);
    expect(m.volume.resolved).toBe(2);
    const email = m.volume.byChannel.find((c) => c.channel === 'email');
    expect(email).toEqual({ channel: 'email', opened: 3, resolved: 2 });
  });

  it('measures first response and resolution in real elapsed seconds', async () => {
    const m = await report();
    // A replied after 30 minutes, B after 50. Nearest rank over two values: the median
    // is the first, p90 the second — every answer a duration that actually happened.
    expect(m.firstResponse).toEqual({ measured: 2, medianSeconds: 1800, p90Seconds: 3000 });
    // A resolved 2h after it arrived, B 3h50m after.
    expect(m.resolution).toEqual({ measured: 2, medianSeconds: 7200, p90Seconds: 13800 });
  });

  it('leaves the untouched conversation in the backlog, and ages it', async () => {
    const m = await report();
    // A and B were resolved, C never picked up: one more open, one more unassigned.
    expect(m.backlog.open - baseline.backlog.open).toBe(1);
    expect(m.backlog.unassigned - baseline.backlog.unassigned).toBe(1);
    expect(m.backlog.oldestUntouchedId).not.toBeNull();
    expect(m.backlog.oldestUntouchedAgeSeconds).toBeGreaterThan(0);
  });

  it('credits the agent with the resolutions and the PUBLIC replies only', async () => {
    const m = await report();
    const anna = m.agents.find((a) => a.principal === String(desk().agent.principal));
    expect(anna).toBeDefined();
    expect(anna!.resolved).toBe(2);
    // Two public replies and one internal note; the note is not a reply to anybody.
    expect(anna!.replies).toBe(2);
    expect(anna!.displayName).toBe(desk().agent.name);
  });

  it('averages the satisfaction the customer actually left', async () => {
    const m = await report();
    expect(m.csat).toEqual({ responses: 2, average: 4.5 });
  });

  /** The number the product is about: what the assistant settled, over what it cost. */
  it('reports deflection, escalation and failure as rates over the turns', async () => {
    const m = await report();
    expect(m.assistant.turns).toBe(4);
    expect(m.assistant.answered).toBe(1);
    expect(m.assistant.drafted).toBe(1);
    expect(m.assistant.escalated).toBe(1);
    expect(m.assistant.failed).toBe(1);
    expect(m.assistant.deflectionRate).toBe(0.25);
    expect(m.assistant.escalationRate).toBe(0.25);
    expect(m.assistant.failureRate).toBe(0.25);
  });

  it('prices those turns from the desk’s own rate card, and divides by what was resolved', async () => {
    const m = await report();
    // 1800 input tokens x 0.000003 = 0.0054 ; 350 output x 0.000015 = 0.00525.
    expect(m.assistant.cost).toBe('0.01065');
    expect(m.assistant.currency).toBe('EUR');
    // Two resolved conversations. A decimal string, never a float — 0.01065 / 2 is
    // exactly 0.005325 and it is allowed to stay that way.
    expect(m.assistant.costPerResolved).toBe('0.005325');
  });

  it('answers empty rather than wrong for a window in which nothing happened', async () => {
    const m = await report('2026-04-02T00:00:00.000Z', '2026-04-03T00:00:00.000Z');
    expect(m.volume.opened).toBe(0);
    expect(m.volume.resolved).toBe(0);
    // Null, not zero: there is no median of nothing, and a 0 here would read as
    // "answered instantly" on the screen.
    expect(m.firstResponse).toEqual({ measured: 0, medianSeconds: null, p90Seconds: null });
    expect(m.resolution).toEqual({ measured: 0, medianSeconds: null, p90Seconds: null });
    expect(m.csat.average).toBeNull();
    expect(m.assistant.deflectionRate).toBeNull();
    expect(m.assistant.costPerResolved).toBeNull();
    expect(m.assistant.cost).toBe('0');
  });

  /**
   * The window is applied as a TEXT comparison over canonical UTC — which is only the
   * same as comparing instants while both ends are canonical too. A window end that is
   * not would not throw; it would sort arbitrarily and produce a plausible report with
   * the wrong rows in it. So the shape is refused at the door instead.
   */
  it('refuses a window end that is not an instant at all', async () => {
    const admin = await at(desk(), 'admin');
    for (const from of ['', '0', 'last tuesday', '2026-04-06']) {
      await expect(admin.invoke('ticket0/desk-metrics', { from })).rejects.toThrow();
    }
  });

  it('…and converts one written with an offset rather than comparing it as text', async () => {
    const admin = await at(desk(), 'admin');
    // 11:00−02:00 is 13:00Z. As TEXT it sorts before 14:00Z and before 09:00Z, so a
    // window that started there un-normalised would sweep in the whole morning; as an
    // instant it starts at B's resolution and catches only what came after.
    const m = (await admin.invoke('ticket0/desk-metrics', {
      from: '2026-04-06T11:00:00-02:00',
      to: WINDOW_TO,
    })) as Metrics;
    expect(m.from).toBe('2026-04-06T13:00:00.000Z');
    expect(m.volume.opened).toBe(1); // C, at 14:00Z
    expect(m.volume.resolved).toBe(1); // B, resolved exactly on the boundary
  });

  it('defaults to a trailing window when the caller names neither end', async () => {
    clock.set('2026-04-08T09:00:00.000Z');
    const m = (await (await at(desk(), 'admin')).invoke('ticket0/desk-metrics', {})) as Metrics;
    expect(m.to).toBe('2026-04-08T09:00:00.000Z');
    expect(m.from).toBe('2026-03-09T09:00:00.000Z');
    // Thirty days back reaches the story AND the seed, so this is the whole desk.
    expect(m.volume.opened).toBeGreaterThanOrEqual(3);
  });

  /**
   * The denial is the point, not an appendix. Cost has one door, and a report whose
   * headline is cost-per-resolved is the same money seen through a division — so it
   * refuses the agent who works the whole inbox, exactly as `usage-summary` does.
   */
  it('refuses the agent who works the inbox, because it is the money with a denominator', async () => {
    const agent = await at(desk(), 'agent');
    await expect(agent.invoke('ticket0/desk-metrics', {})).rejects.toThrow(/permission denied/i);
  });

  it('…and the conversation the report counted is one the same agent can still open', async () => {
    // Without this control the refusal above would pass just as happily for a broken
    // principal or an unregistered module.
    const agent = await at(desk(), 'agent');
    const conversation = (await agent.invoke('ticket0/get-conversation', {
      conversationId: story.c,
    })) as { id: string; state: string };
    expect(conversation.id).toBe(story.c);
    expect(conversation.state).toBe('new');
  });
});
