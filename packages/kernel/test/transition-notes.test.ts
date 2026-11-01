/**
 * #2762: what `ctx.noteTransition` keeps and how the report folds it — the bounds and the name
 * gate a line relies on, which the adapter suites never reach.
 */
import { describe, expect, it } from 'vitest';
import type { NotedTransition } from '@substrat-run/contracts';
import { noteTransitionInto, TRANSITION_REPORT_CAP, withTransitions, type TransitionTally } from '../src/index.js';

const report = { events: [], total: 0 };
const move = (entityId: string, from: string | null, to: string, entityType = 'ticket'): NotedTransition => ({
  entityType,
  entityId,
  from,
  to,
});

/** The report for these notes, each passed through the gate as `ctx.noteTransition` would. */
const reported = (notes: NotedTransition[]) => {
  const tally: TransitionTally = { transitions: [] };
  const note = noteTransitionInto(tally);
  for (const n of notes) note(n);
  return withTransitions(report, tally.transitions).transitions;
};

describe('transition notes (#2762)', () => {
  it.each([
    ['folds an entity to the state it left first and reached last', [move('a', 'new', 'open'), move('a', 'open', 'done')], [{ entity: 'ticket:a', from: 'new', to: 'done' }]],
    ['leaves out an entity that came back to where it started', [move('a', 'new', 'open'), move('a', 'open', 'new')], []],
    [
      'keeps the first entities to move up to the cap, and follows those past it',
      [...Array.from({ length: TRANSITION_REPORT_CAP + 1 }, (_, i) => move(`e${i}`, 'new', 'open')), move('e0', 'open', 'done')],
      Array.from({ length: TRANSITION_REPORT_CAP }, (_, i) => ({ entity: `ticket:e${i}`, from: 'new', to: i === 0 ? 'done' : 'open' })),
    ],
    [
      'drops a note whose type, id or states are not shaped like names',
      [move('a', 'new', 'open', 'not a type'), move('has space', 'new', 'open'), move('x'.repeat(129), 'new', 'open'), move('b', 'new', 'a state?'), move('c', 'a state?', 'open')],
      undefined,
    ],
  ])('%s', (_, notes, expected) => {
    expect(reported(notes)).toEqual(expected);
  });

  it('reports nothing — not recorded, never `[]` — when nothing was noted, or nobody asked', () => {
    expect(withTransitions(report, [])).toBe(report);
    expect(withTransitions(report, undefined)).toBe(report);
    const unasked: TransitionTally = {};
    noteTransitionInto(unasked)(move('a', 'new', 'open'));
    expect(unasked.transitions).toBeUndefined();
  });
});
