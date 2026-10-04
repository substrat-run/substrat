import { describe, expect, it } from 'vitest';
import { businessGrid, businessRows, lifecycleMovesOf, type LifecycleMove } from '../src/business-volumes.js';

/** Pulse's business rows (#1750): the grid one read is asked for, and its answer as rows. */
describe('businessGrid', () => {
  it('ends on the window’s end, rounded up to a whole second, and covers two days', () => {
    const g = businessGrid({ since: '2026-10-03T12:00:00.250Z', until: '2026-10-04T12:00:00.250Z' }, 60);
    expect(g).toEqual({ since: '2026-10-02T12:00:01.000Z', until: '2026-10-04T12:00:01.000Z', bucketMinutes: 60 });
  });

  it('covers a window longer than two days whole, on the window’s own bins', () => {
    const g = businessGrid({ since: '2026-10-01T12:00:00.000Z', until: '2026-10-04T12:00:00.000Z' }, 60);
    expect(g.since).toBe('2026-10-01T12:00:00.000Z');
  });
});

describe('businessRows', () => {
  const MOVE: LifecycleMove = { entityType: 'order', state: 'closed', terminal: true, fromInitial: false, operations: ['shop/close', 'shop/void'] };
  const grid = businessGrid({ since: '2026-10-03T12:00:00.000Z', until: '2026-10-04T12:00:00.000Z' }, 60);

  it('splits today from yesterday exactly on a bucket edge, folding every operation of a move', () => {
    const [row] = businessRows('s1', [MOVE], {
      ...grid,
      series: [
        // The last bucket of yesterday and the first of today, side by side.
        { entityType: 'order', operation: 'shop/close', total: 2, buckets: [{ start: '2026-10-03T11:00:00.000Z', count: 2 }] },
        { entityType: 'order', operation: 'shop/void', total: 5, buckets: [{ start: '2026-10-03T12:00:00.000Z', count: 5 }] },
      ],
    }, { since: '2026-10-03T12:00:00.000Z', until: '2026-10-04T12:00:00.000Z' });
    expect(row).toMatchObject({ today: 5, yesterday: 2 });
    // The series is the card's window only: yesterday's bucket is not drawn on it.
    expect(row!.buckets).toHaveLength(24);
    expect(row!.buckets[0]).toEqual({ start: '2026-10-03T12:00:00.000Z', count: 5 });
    expect(row!.buckets.slice(1).every((b) => b.count === 0)).toBe(true);
  });
});

describe('lifecycleMovesOf (#1750)', () => {
  it('keeps an operation only when every appearance of it is an edge into one state', () => {
    const moves = lifecycleMovesOf({
      conversation: {
        field: 'state',
        initial: 'new',
        states: {
          new: { on: { 'desk/assign': 'open', 'desk/close': 'closed', 'desk/resolve': 'resolved' } },
          open: { on: { 'desk/resolve': 'resolved', 'desk/close': 'closed', 'desk/park': 'open' }, allow: ['desk/ingest'] },
          resolved: { on: { 'desk/ingest': 'open', 'desk/close': 'closed', 'desk/flip': 'open' } },
          snoozed: { on: { 'desk/flip': 'closed' } },
          closed: { terminal: true },
        },
      },
    });
    expect(moves).toEqual([
      { entityType: 'conversation', state: 'closed', terminal: true, fromInitial: false, operations: ['desk/close'] },
      { entityType: 'conversation', state: 'open', terminal: false, fromInitial: true, operations: ['desk/assign'] },
      { entityType: 'conversation', state: 'resolved', terminal: false, fromInitial: false, operations: ['desk/resolve'] },
    ]);
    // Left out, each for its reason: `desk/ingest` is also merely allowed; `desk/park` is a
    // self-loop; `desk/flip` leads to two different states.
    const ops = moves.flatMap((m) => m.operations);
    for (const op of ['desk/ingest', 'desk/park', 'desk/flip']) expect(ops).not.toContain(op);
  });

  it('keeps opening apart from reopening: one row out of the initial state, another back from later', () => {
    const moves = lifecycleMovesOf({
      ticket: {
        field: 'state',
        initial: 'new',
        states: {
          new: { on: { 'desk/open': 'open' } },
          open: { on: { 'desk/wait': 'pending', 'desk/close': 'closed' } },
          pending: { on: { 'desk/reopen': 'open', 'desk/close': 'closed' } },
          closed: { terminal: true },
        },
      },
    });
    expect(moves.map((m) => [m.state, m.fromInitial, m.operations])).toEqual([
      ['closed', false, ['desk/close']],
      ['open', true, ['desk/open']],
      ['open', false, ['desk/reopen']],
      ['pending', false, ['desk/wait']],
    ]);
  });

  it('answers nothing for a model with no lifecycles', () => {
    expect(lifecycleMovesOf(undefined)).toEqual([]);
    expect(lifecycleMovesOf({})).toEqual([]);
  });
});
