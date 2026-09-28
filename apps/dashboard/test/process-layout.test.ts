import { describe, expect, it } from 'vitest';
import type { EmittedLifecycle, LifecycleFlowResult } from '@substrat-run/contracts';
import { formatDuration, funnelRows, processLayout } from '../web/src/lib/process-layout.js';

/**
 * The process map's computed layout (#1744). The design hand-places one machine; these
 * pin the rules that let any declared machine draw sensibly and the same way every time.
 */

/** ticket0's support conversation, as its model.json emits it (operations trimmed to the edges). */
const CONVERSATION: EmittedLifecycle = {
  field: 'state',
  initial: 'new',
  states: {
    closed: { terminal: true },
    new: { on: { 'ticket0/assign': 'open', 'ticket0/close': 'closed', 'ticket0/resolve': 'resolved' } },
    open: { on: { 'ticket0/close': 'closed', 'ticket0/resolve': 'resolved', 'ticket0/snooze': 'snoozed' } },
    resolved: { on: { 'ticket0/close': 'closed', 'ticket0/ingest-message': 'open', 'ticket0/widget-post': 'open' } },
    snoozed: { on: { 'ticket0/close': 'closed', 'ticket0/resolve': 'resolved', 'ticket0/wake': 'open' } },
  },
};

const flow = (edges: Array<Partial<LifecycleFlowResult['edges'][number]> & { from: string; to: string; count: number }>, complete = true) =>
  ({
    edges: edges.map((e) => ({ operation: 'op', actors: {}, declared: true, seenLate: false, ...e })),
    states: [],
    funnel: { started: 10, reached: { new: 10, open: 8, resolved: 6, closed: 5 } },
    observation: { complete },
  }) as unknown as LifecycleFlowResult;

const col = (l: ReturnType<typeof processLayout>, s: string) => l.states.find((x) => x.state === s)!.column;

describe('processLayout', () => {
  it('with nothing counted, draws the longest story on the centre line', () => {
    const l = processLayout(CONVERSATION, null);
    expect(['new', 'open', 'snoozed', 'resolved', 'closed'].map((s) => col(l, s))).toEqual([0, 1, 2, 3, 4]);
    expect(l.states.every((s) => s.row === 0)).toBe(true);
  });

  it('puts the route most instances took on the centre line, and a side trip beside it, between its ends', () => {
    // The design's own picture: new → open → resolved → closed, with snoozed above.
    const l = processLayout(
      CONVERSATION,
      flow([
        { from: 'new', to: 'open', count: 1284 },
        { from: 'open', to: 'resolved', count: 1102 },
        { from: 'resolved', to: 'closed', count: 1016 },
        { from: 'open', to: 'snoozed', count: 412 },
        { from: 'snoozed', to: 'resolved', count: 44 },
      ]),
    );
    const s = (name: string) => l.states.find((x) => x.state === name)!;
    expect(['new', 'open', 'resolved', 'closed'].map((n) => [s(n).column, s(n).row])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect([s('snoozed').column, s('snoozed').row]).toEqual([1.5, -1]);
    // Its two directions with open are separate curves.
    const k = (from: string, to: string) => l.pairs.find((p) => p.from === from && p.to === to)!;
    expect(k('open', 'snoozed').kind).toBe('curve');
    expect(k('snoozed', 'open').d).not.toBe(k('open', 'snoozed').d);
  });

  it('draws one move per pair of states, however many operations declare it', () => {
    const l = processLayout(CONVERSATION, null);
    const reopen = l.pairs.filter((p) => p.from === 'resolved' && p.to === 'open');
    expect(reopen).toHaveLength(1);
    expect(reopen[0]!.kind).toBe('back-arc');
  });

  it('draws a step straight, a skip above and a return below', () => {
    const l = processLayout(CONVERSATION, null);
    const kind = (from: string, to: string) => l.pairs.find((p) => p.from === from && p.to === to)!.kind;
    expect(kind('new', 'open')).toBe('straight');
    expect(kind('open', 'resolved')).toBe('forward-arc');
    expect(kind('snoozed', 'open')).toBe('back-arc');
  });

  it('scales width by count, and dashes a declared pair nobody took only when the replay was complete', () => {
    const l = processLayout(CONVERSATION, flow([{ from: 'new', to: 'open', count: 10 }, { from: 'open', to: 'resolved', count: 5 }]));
    const p = (from: string, to: string) => l.pairs.find((x) => x.from === from && x.to === to)!;
    expect(p('new', 'open').width).toBeCloseTo(8);
    expect(p('open', 'resolved').width).toBeCloseTo(4.9);
    expect(p('open', 'snoozed').untaken).toBe(true);
    const partial = processLayout(CONVERSATION, flow([{ from: 'new', to: 'open', count: 1 }], false));
    expect(partial.pairs.find((x) => x.from === 'open' && x.to === 'snoozed')!.untaken).toBe(false);
  });

  it('adds a pair the declaration lacks, and says how much of each pair was undeclared or seen late', () => {
    const l = processLayout(
      CONVERSATION,
      flow([
        { from: 'closed', to: 'open', count: 2, declared: false },
        { from: 'resolved', to: 'open', count: 3, operation: null, seenLate: true },
        { from: 'resolved', to: 'open', count: 1 },
      ]),
    );
    expect(l.pairs.find((x) => x.id === 'closed>open')).toMatchObject({ declared: false, undeclared: 2 });
    expect(l.pairs.find((x) => x.id === 'resolved>open')).toMatchObject({ declared: true, count: 4, seenLate: 3 });
  });

  it('stacks states that share a column, and still places one the initial state cannot reach', () => {
    const lc: EmittedLifecycle = {
      field: 's',
      initial: 'a',
      states: { a: { on: { x: 'b', y: 'c' } }, b: { on: { z: 'd' } }, c: { on: { z: 'd' } }, d: { terminal: true }, orphan: {} },
    };
    const l = processLayout(lc, null);
    // A diamond: one branch is the spine, the other sits beside it in the same column.
    expect(col(l, 'b')).toBe(1);
    expect(col(l, 'c')).toBe(1);
    expect(new Set([l.states.find((s) => s.state === 'b')!.row, l.states.find((s) => s.state === 'c')!.row]).size).toBe(2);
    expect(l.states.find((s) => s.state === 'orphan')).toBeDefined();
  });

  it('keeps count labels from covering each other', () => {
    const l = processLayout(
      CONVERSATION,
      flow([
        { from: 'new', to: 'open', count: 1284 },
        { from: 'open', to: 'resolved', count: 1102 },
        { from: 'resolved', to: 'closed', count: 1016 },
        { from: 'open', to: 'snoozed', count: 412 },
        { from: 'snoozed', to: 'open', count: 368 },
        { from: 'new', to: 'resolved', count: 7 },
        { from: 'open', to: 'closed', count: 31 },
      ]),
    );
    const boxes = l.pairs.map((p) => ({ x: p.labelX, y: p.labelY, w: 12 + p.count.toLocaleString('en-US').length * 7 }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < 18, `${l.pairs[i]!.id} vs ${l.pairs[j]!.id}`).toBe(false);
      }
  });

  it('is the same map every time for the same model', () => {
    expect(processLayout(CONVERSATION, null)).toEqual(processLayout(CONVERSATION, null));
  });
});

describe('formatDuration', () => {
  it('writes the largest unit and the one below it', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(52 * 60_000)).toBe('52m');
    expect(formatDuration(3 * 3_600_000 + 40 * 60_000)).toBe('3h 40m');
    expect(formatDuration(86_400_000 + 5 * 60_000)).toBe('1d');
    expect(formatDuration(2 * 86_400_000 + 6 * 3_600_000)).toBe('2d 6h');
  });
});

describe('funnelRows', () => {
  it('gives each state the share of starts that reached it, now and before, in column order', () => {
    const l = processLayout(CONVERSATION, null);
    const rows = funnelRows(l, flow([]), flow([]));
    expect(rows.map((r) => r.state)).toEqual(['new', 'open', 'snoozed', 'resolved', 'closed']);
    expect(rows.find((r) => r.state === 'resolved')).toMatchObject({ reached: 6, share: 0.6, previousShare: 0.6 });
  });
});
