import { describe, expect, it } from 'vitest';
import type { EmittedLifecycle, HistoryEntry } from '@substrat-run/contracts';
import { actorKindOf, dayTicks, instanceTimeline } from '../web/src/lib/instance-timeline.js';

/** One record's lifecycle from its history (#1916) — the process map's replay, for one record. */

const LC: EmittedLifecycle = {
  field: 'state',
  initial: 'new',
  states: {
    new: { on: { 'desk/assign': 'open' } },
    open: { on: { 'desk/resolve': 'resolved', 'desk/snooze': 'snoozed' } },
    snoozed: { on: { 'desk/wake': 'open' } },
    resolved: { on: { 'desk/ingest': 'open', 'desk/close': 'closed' } },
    closed: { terminal: true },
  },
};

let n = 0;
const ev = (at: string, op: string | null, payload: unknown, over: Record<string, unknown> = {}): HistoryEntry =>
  ({
    id: `01J${String(++n).padStart(23, '0')}`,
    type: 't',
    occurredAt: at,
    actor: 'prin_ada',
    payload,
    operation: op,
    invocationId: `CALL${n}`,
    ...over,
  }) as unknown as HistoryEntry;

const H = (h: number) => new Date(Date.parse('2026-09-21T00:00:00.000Z') + h * 3_600_000).toISOString();

describe('instanceTimeline', () => {
  it('tells where the time went: one stay per state, the last one still open', () => {
    const t = instanceTimeline(
      [ev(H(0), 'desk/create', { state: 'new' }), ev(H(2), 'desk/assign', { state: 'open' }), ev(H(10), 'desk/resolve', { state: 'resolved' })],
      LC,
      H(34),
    )!;
    expect(t.stays.map((s) => [s.state, s.ms / 3_600_000, s.until === null])).toEqual([
      ['new', 2, false],
      ['open', 8, false],
      ['resolved', 24, true],
    ]);
    expect(t.moves.map((m) => `${m.from}>${m.to} ${m.operation}`)).toEqual(['new>open desk/assign', 'open>resolved desk/resolve']);
    expect(t).toMatchObject({ current: 'resolved', finished: false, lifecycleMs: 34 * 3_600_000, calls: 3, reopens: 0 });
  });

  it('stops the clock at the terminal state, and counts a reopen', () => {
    const t = instanceTimeline(
      [
        ev(H(0), 'desk/create', { state: 'new' }),
        ev(H(1), 'desk/assign', { state: 'open' }),
        ev(H(3), 'desk/resolve', { state: 'resolved' }),
        ev(H(5), 'desk/ingest', { state: 'open' }),
        ev(H(6), 'desk/resolve', { state: 'resolved' }),
        ev(H(9), 'desk/close', { state: 'closed' }),
      ],
      LC,
      H(100),
    )!;
    expect(t.finished).toBe(true);
    expect(t.lifecycleMs).toBe(9 * 3_600_000);
    expect(t.reopens).toBe(2); // back into open, and back into resolved
    expect(t.stays.at(-1)).toMatchObject({ state: 'closed', ms: 0, terminal: true });
  });

  it('reads the move from the declared edge when the event does not carry the state', () => {
    const t = instanceTimeline([ev(H(0), 'desk/create', { state: 'new' }), ev(H(1), 'desk/assign', null), ev(H(2), 'desk/snooze', { note: 'x' })], LC, H(3))!;
    expect(t.moves.map((m) => m.to)).toEqual(['open', 'snoozed']);
  });

  it('keeps a move first seen on a later event without blaming the operation that reported it', () => {
    const t = instanceTimeline(
      [ev(H(0), 'desk/create', { state: 'new' }), ev(H(1), 'desk/assign', { state: 'open' }), ev(H(2), 'desk/resolve', { state: 'resolved' }), ev(H(4), 'desk/set-priority', { state: 'open' })],
      LC,
      H(5),
    )!;
    expect(t.moves.at(-1)).toMatchObject({ from: 'resolved', to: 'open', operation: null, seenLate: true, declared: true });
  });

  it('flags a move the declaration does not have, and a consumer’s move with no operation', () => {
    const t = instanceTimeline(
      [
        ev(H(0), 'desk/create', { state: 'new' }),
        ev(H(1), 'desk/assign', { state: 'resolved' }),
        ev(H(2), null, { state: 'open' }, { actor: { system: 'desk' } }),
      ],
      LC,
      H(3),
    )!;
    expect(t.moves[0]).toMatchObject({ from: 'new', to: 'resolved', operation: 'desk/assign', declared: false });
    expect(t.moves[1]).toMatchObject({ operation: null, seenLate: false, actorKind: 'consumer' });
  });

  it('moves once per call when a call emitted several state-less events', () => {
    const t = instanceTimeline([ev(H(0), 'desk/create', { state: 'new' }), ev(H(1), 'desk/assign', null, { invocationId: 'C' }), ev(H(1), 'desk/assign', null, { invocationId: 'C' })], LC, H(2))!;
    expect(t.moves).toHaveLength(1);
  });

  it('names who moved it most', () => {
    const t = instanceTimeline(
      [
        ev(H(0), 'desk/create', { state: 'new' }),
        ev(H(1), 'desk/assign', { state: 'open' }, { actor: 'prin_bo' }),
        ev(H(2), 'desk/snooze', { state: 'snoozed' }, { actor: { system: 'desk' } }),
        ev(H(3), 'desk/wake', { state: 'open' }, { actor: { system: 'desk' } }),
      ],
      LC,
      H(4),
      (a) => (typeof a === 'string' ? a : 'system · desk'),
    )!;
    expect(t.topActor).toEqual({ kind: 'consumer', label: 'system · desk', moves: 2 });
  });

  it('starts a record found mid-life where it was found, unless its first operation is the edge out of the initial state', () => {
    expect(instanceTimeline([ev(H(0), 'desk/ingest', { state: 'resolved' })], LC, H(1))!).toMatchObject({ current: 'resolved', moves: [] });
    const t = instanceTimeline([ev(H(0), 'desk/assign', { state: 'open' })], LC, H(1))!;
    expect(t.moves.map((m) => `${m.from}>${m.to}`)).toEqual(['new>open']);
  });

  it('is null for a record with no history', () => {
    expect(instanceTimeline([], LC, H(0))).toBeNull();
  });
});

describe('actorKindOf', () => {
  it('reads the kind off the actor’s shape', () => {
    expect(['p', { system: 's' }, { connection: 'c' }, { capability: 'k' }, { vertical: 'v', scope: 's' }].map((a) => actorKindOf(a as never))).toEqual([
      'person', 'consumer', 'connector', 'link', 'app',
    ]);
  });
});

describe('dayTicks', () => {
  it('marks each midnight along the span, as a share of it', () => {
    const ticks = dayTicks('2026-09-21T12:00:00.000Z', '2026-09-23T12:00:00.000Z');
    expect(ticks.map((t) => t.share)).toEqual([0.25, 0.75]);
    expect(ticks[0]!.label).toBe('Tue 22');
  });
});
