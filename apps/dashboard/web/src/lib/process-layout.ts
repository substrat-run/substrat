import type { EmittedLifecycle, LifecycleFlowResult } from '@substrat-run/contracts';

/**
 * The process map's layout (#1744): a declared lifecycle drawn left to right, with the
 * replay's counts on it.
 *
 * The design hand-places ticket0's five states. A real app declares any machine, so the
 * layout is computed, and deterministic, so the same model always draws the same map:
 *
 * - **Columns by longest path from the initial state**, back edges set aside. A state sits
 *   one column right of the furthest state that leads into it, so the machine reads as the
 *   order things happen in rather than the order of the shortest route through it. A
 *   terminal state is pushed to the last column, where a reader looks for "done".
 * - **Rows** only when two states share a column; the busier one keeps the centre line.
 * - **Edges between adjacent columns on one row are straight.** One that skips a column
 *   arcs above, one that goes back arcs below — so a reopen reads as a return, not as
 *   another step forward.
 *
 * Edges are drawn per PAIR of states. A pair can be several declared operations (ticket0
 * reopens a resolved conversation on four), and the side panel lists them; the diagram
 * draws the one move.
 */

export const NODE_W = 140;
export const NODE_H = 88;
const COL_GAP = 58;
const ROW_GAP = 64;
const PAD_X = 20;

export interface LaidState {
  state: string;
  terminal: boolean;
  initial: boolean;
  /** On the spine: the busiest way from the initial state to a terminal one. */
  spine: boolean;
  /** May be fractional: a state off the spine sits between the spine states it joins. */
  column: number;
  row: number;
  x: number;
  y: number;
}

export interface LaidPair {
  /** `from>to`: the pair's id in a selection. */
  id: string;
  from: string;
  to: string;
  count: number;
  /** Every move between the two is one the declaration has. */
  declared: boolean;
  /** Some of the count is moves the declaration does NOT have. */
  undeclared: number;
  /** Some of the count was only seen on a later event (`seenLate`). */
  seenLate: number;
  kind: 'straight' | 'curve' | 'forward-arc' | 'back-arc' | 'self';
  d: string;
  /** Where the count label sits. */
  labelX: number;
  labelY: number;
  width: number;
  /** Declared, and nobody took it in the period — drawn dashed. */
  untaken: boolean;
}

export interface ProcessLayout {
  width: number;
  height: number;
  states: LaidState[];
  pairs: LaidPair[];
}

/**
 * A pair's id: a JSON tuple, because state names are any string — joined with a separator,
 * `a>b → c` and `a → b>c` would be one id.
 */
export const pairId = (from: string, to: string) => JSON.stringify([from, to]);

/** The machine's forward edges: every declared move, minus the ones that go back (DFS from the initial state). */
function forwardEdges(lc: EmittedLifecycle): Map<string, string[]> {
  const names = Object.keys(lc.states).sort();
  const next = (s: string) => [...new Set(Object.values(lc.states[s]?.on ?? {}))].filter((t) => t !== s && lc.states[t]).sort();
  const onStack = new Set<string>();
  const seen = new Set<string>();
  const forward = new Map<string, string[]>(names.map((n) => [n, []]));
  const visit = (s: string) => {
    seen.add(s);
    onStack.add(s);
    for (const t of next(s)) {
      if (onStack.has(t)) continue;
      forward.get(s)!.push(t);
      if (!seen.has(t)) visit(t);
    }
    onStack.delete(s);
  };
  if (lc.states[lc.initial]) visit(lc.initial);
  for (const n of names) if (!seen.has(n)) visit(n);
  return forward;
}

/**
 * The spine: the path from the initial state to a terminal one that carried the most moves,
 * and among equals the longest, then the alphabetically first — so it is the route most
 * instances took, and a model nothing has moved through yet still draws as its longest story.
 */
function spineOf(lc: EmittedLifecycle, forward: Map<string, string[]>, weight: (a: string, b: string) => number): string[] {
  const memo = new Map<string, { w: number; path: string[] }>();
  const best = (s: string): { w: number; path: string[] } => {
    const hit = memo.get(s);
    if (hit) return hit;
    let out = { w: 0, path: [s] };
    for (const t of forward.get(s) ?? []) {
      const sub = best(t);
      const cand = { w: weight(s, t) + sub.w, path: [s, ...sub.path] };
      const better =
        cand.w > out.w ||
        (cand.w === out.w && cand.path.length > out.path.length) ||
        (cand.w === out.w && cand.path.length === out.path.length && cand.path.join() < out.path.join());
      if (out.path.length === 1 || better) out = cand;
    }
    memo.set(s, out);
    return out;
  };
  return lc.states[lc.initial] ? best(lc.initial).path : [];
}

export function processLayout(lc: EmittedLifecycle, flow: LifecycleFlowResult | null): ProcessLayout {
  const names = Object.keys(lc.states).sort();
  const forward = forwardEdges(lc);
  const counted = new Map<string, number>();
  for (const e of flow?.edges ?? []) counted.set(pairId(e.from, e.to), (counted.get(pairId(e.from, e.to)) ?? 0) + e.count);
  const spine = spineOf(lc, forward, (a, b) => counted.get(pairId(a, b)) ?? 0);
  const onSpine = new Set(spine);

  // Spine states in order on the centre line.
  const column = new Map<string, number>();
  const row = new Map<string, number>();
  spine.forEach((s, i) => {
    column.set(s, i);
    row.set(s, 0);
  });
  // Every other state beside the spine, between the spine states it joins; placed in
  // dependency order so a chain off the spine lands one step further along.
  const neighbours = (s: string) => {
    const ins = names.filter((n) => (forward.get(n) ?? []).includes(s));
    return [...ins, ...(forward.get(s) ?? [])];
  };
  const pending = names.filter((n) => !onSpine.has(n));
  const taken = new Set(spine.map((s) => `${column.get(s)}:0`));
  for (let guard = 0; pending.length > 0 && guard < names.length * 2; guard++) {
    const s = pending.shift()!;
    const placed = neighbours(s).filter((n) => column.has(n));
    if (placed.length === 0 && pending.some((p) => neighbours(s).includes(p))) {
      pending.push(s);
      continue;
    }
    // Halfway between its furthest way in and its nearest way on after that; half a step
    // past its way in when nothing leads on; past the end when nothing on the map joins it.
    const ins = placed.filter((n) => (forward.get(n) ?? []).includes(s)).map((n) => column.get(n)!);
    const outs = placed.filter((n) => (forward.get(s) ?? []).includes(n)).map((n) => column.get(n)!);
    const from = ins.length ? Math.max(...ins) : outs.length ? Math.min(...outs) - 1 : spine.length - 0.5;
    const onward = outs.filter((x) => x > from);
    const c = onward.length ? (from + Math.min(...onward)) / 2 : from + 0.5;
    // Above the line first, then below, then further out.
    let r = -1;
    for (let k = 1; taken.has(`${c}:${r}`); k++) r = k % 2 === 1 ? k - (k - 1) / 2 : -(k / 2 + 1);
    taken.add(`${c}:${r}`);
    column.set(s, c);
    row.set(s, r);
  }
  // A terminal state off the spine still reads as the end: past every other column.
  const lastCol = Math.max(0, ...column.values());
  for (const n of names) if (lc.states[n]?.terminal && !onSpine.has(n) && column.get(n)! < lastCol) column.set(n, lastCol);

  const rows = [...row.values()];
  const minRow = Math.min(0, ...rows);
  const maxRow = Math.max(0, ...rows);
  // The arcs along the centre line need the room between it and the states beside it:
  // count them first, and open each gap by as many arc lanes as will run through it.
  const drawnPairs = new Map<string, [string, string]>();
  for (const [from, def] of Object.entries(lc.states)) for (const to of Object.values(def.on ?? {})) drawnPairs.set(pairId(from, to), [from, to]);
  for (const e of flow?.edges ?? []) drawnPairs.set(pairId(e.from, e.to), [e.from, e.to]);
  let skips = 0;
  let returns = 0;
  for (const [from, to] of drawnPairs.values()) {
    if (!column.has(from) || !column.has(to) || from === to || row.get(from) !== 0 || row.get(to) !== 0) continue;
    const d = column.get(to)! - column.get(from)!;
    if (d > 1) skips++;
    else if (d < 0) returns++;
  }
  const lanesAbove = 40 + 20 * skips;
  const lanesBelow = 40 + 20 * returns;
  const gapAbove = Math.max(ROW_GAP, lanesAbove + 24);
  const gapBelow = Math.max(ROW_GAP, lanesBelow + 24);
  const centreY = (minRow < 0 ? 16 : lanesAbove + 16) + -minRow * (NODE_H + gapAbove);
  const yOf = (r: number) => centreY + (r < 0 ? r * (NODE_H + gapAbove) : r * (NODE_H + gapBelow));
  const states: LaidState[] = names.map((state) => ({
    state,
    terminal: lc.states[state]?.terminal === true,
    initial: state === lc.initial,
    spine: onSpine.has(state),
    column: column.get(state)!,
    row: row.get(state)!,
    x: PAD_X + column.get(state)! * (NODE_W + COL_GAP),
    y: yOf(row.get(state)!),
  }));
  const at = new Map(states.map((s) => [s.state, s]));

  // One pair per (from, to): the declaration's edges, plus whatever the replay saw.
  const pairs = new Map<string, { from: string; to: string; count: number; declared: boolean; undeclared: number; seenLate: number }>();
  const pairOf = (from: string, to: string) => {
    const id = pairId(from, to);
    const p = pairs.get(id) ?? { from, to, count: 0, declared: false, undeclared: 0, seenLate: 0 };
    pairs.set(id, p);
    return p;
  };
  for (const [from, def] of Object.entries(lc.states)) {
    for (const to of Object.values(def.on ?? {})) if (at.has(to)) pairOf(from, to).declared = true;
  }
  for (const e of flow?.edges ?? []) {
    if (!at.has(e.from) || !at.has(e.to)) continue;
    const p = pairOf(e.from, e.to);
    p.count += e.count;
    if (!e.declared) p.undeclared += e.count;
    if (e.seenLate) p.seenLate += e.count;
  }
  const maxCount = Math.max(1, ...[...pairs.values()].map((p) => p.count));
  const complete = flow?.observation.complete ?? false;

  let forwardArcs = 0;
  let backArcs = 0;
  const laid: LaidPair[] = [...pairs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, p]) => {
      const a = at.get(p.from)!;
      const b = at.get(p.to)!;
      const width = p.count === 0 ? 1.5 : 1.8 + (6.2 * p.count) / maxCount;
      const base = { id, ...p, width, untaken: p.count === 0 && p.declared && complete };
      const cx = (s: LaidState) => s.x + NODE_W / 2;
      const cy = (s: LaidState) => s.y + NODE_H / 2;
      if (a.state === b.state) {
        const x = cx(a);
        return { ...base, kind: 'self' as const, d: `M ${x - 20} ${a.y} C ${x - 30} ${a.y - 50}, ${x + 30} ${a.y - 50}, ${x + 20} ${a.y}`, labelX: x, labelY: a.y - 44 };
      }
      // Two states on the centre line, one step apart: a straight step.
      if (a.row === 0 && b.row === 0 && b.column === a.column + 1) {
        const y = cy(a);
        const x1 = a.x + NODE_W;
        const x2 = b.x;
        return { ...base, kind: 'straight' as const, d: `M ${x1} ${y} L ${x2} ${y}`, labelX: (x1 + x2) / 2, labelY: y };
      }
      // Along the spine but skipping or returning: arcs above (forward) and below (back).
      if (a.row === 0 && b.row === 0) {
        if (b.column > a.column) {
          const lift = 40 + 20 * forwardArcs++;
          const x1 = a.x + NODE_W * 0.72;
          const x2 = b.x + NODE_W * 0.28;
          const top = a.y - lift;
          return { ...base, kind: 'forward-arc' as const, d: `M ${x1} ${a.y} C ${x1} ${top}, ${x2} ${top}, ${x2} ${b.y}`, labelX: (x1 + x2) / 2, labelY: top + lift * 0.25 };
        }
        const drop = 40 + 20 * backArcs++;
        const x1 = a.x + NODE_W * 0.28;
        const x2 = b.x + NODE_W * 0.72;
        const y1 = a.y + NODE_H;
        const bottom = y1 + drop;
        return { ...base, kind: 'back-arc' as const, d: `M ${x1} ${y1} C ${x1} ${bottom}, ${x2} ${bottom}, ${x2} ${y1}`, labelX: (x1 + x2) / 2, labelY: bottom - drop * 0.25 };
      }
      // To or from a state beside the spine: a curve between the facing sides. An upward
      // move leaves and lands left of centre, a downward one right of it, so a pair's two
      // directions (open → snoozed, snoozed → open) run side by side instead of crossing.
      const up = b.y < a.y;
      const down = b.y > a.y;
      const lane = up ? -22 : 22;
      const x1 = up || down ? cx(a) + lane : b.x > a.x ? a.x + NODE_W : a.x;
      const y1 = up ? a.y : down ? a.y + NODE_H : cy(a);
      const x2 = up || down ? cx(b) + lane : b.x > a.x ? b.x : b.x + NODE_W;
      const y2 = up ? b.y + NODE_H : down ? b.y : cy(b);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const bend = Math.min(28, len * 0.14);
      // The right-hand normal of the direction of travel.
      const nx = -(y2 - y1) / len;
      const ny = (x2 - x1) / len;
      const qx = mx - nx * bend;
      const qy = my - ny * bend;
      return {
        ...base,
        kind: 'curve' as const,
        d: `M ${x1} ${y1} Q ${qx} ${qy}, ${x2} ${y2}`,
        labelX: (mx + qx) / 2,
        labelY: (my + qy) / 2,
      };
    });

  // Count labels must not cover each other: the busiest keep their place, and each other
  // one moves to the nearest free spot along the vertical. The width is the pill the
  // screen draws for the number.
  const placedLabels: { x: number; y: number; w: number }[] = [];
  const pillW = (n: number) => 12 + n.toLocaleString('en-US').length * 7;
  for (const p of [...laid].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))) {
    const w = pillW(p.count);
    const clash = (y: number) => placedLabels.some((q) => Math.abs(q.x - p.labelX) < (q.w + w) / 2 + 2 && Math.abs(q.y - y) < 20);
    const y = [0, -20, 20, -40, 40, -60, 60].map((d) => p.labelY + d).find((c) => !clash(c)) ?? p.labelY;
    p.labelY = y;
    placedLabels.push({ x: p.labelX, y, w });
  }

  const columns = Math.max(0, ...states.map((s) => s.column)) + 1;
  return {
    width: PAD_X * 2 + columns * NODE_W + (columns - 1) * COL_GAP,
    height: yOf(maxRow) + NODE_H + (maxRow > 0 ? 24 : lanesBelow + 16),
    states,
    pairs: laid,
  };
}

/** Milliseconds as the map writes a duration: the largest unit and the one below it. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ];
  const i = units.findIndex(([, size]) => ms >= size);
  const [u, size] = units[i]!;
  const whole = Math.floor(ms / size);
  const below = units[i + 1];
  if (!below) return `${whole}${u}`;
  const rest = Math.floor((ms - whole * size) / below[1]);
  return rest > 0 ? `${whole}${u} ${rest}${below[0]}` : `${whole}${u}`;
}

/** The funnel's rows, in column order: the share of starts that reached each state, now and before. */
export function funnelRows(
  layout: ProcessLayout,
  current: LifecycleFlowResult,
  previous: LifecycleFlowResult | null,
): { state: string; reached: number; share: number | null; previousShare: number | null }[] {
  const share = (f: LifecycleFlowResult | null, s: string) =>
    f && f.funnel.started > 0 ? (f.funnel.reached[s] ?? 0) / f.funnel.started : null;
  return [...layout.states]
    .sort((a, b) => a.column - b.column || a.row - b.row || a.state.localeCompare(b.state))
    .map((s) => ({
      state: s.state,
      reached: current.funnel.reached[s.state] ?? 0,
      share: share(current, s.state),
      previousShare: share(previous, s.state),
    }));
}

/** One refused move drawn as a stub (#1745): where the record was, what was tried, how often. */
export interface LaidStub {
  /** `from|attempted|operation` — the stub's id in a selection. */
  id: string;
  from: string;
  attempted: string | null;
  operation: string;
  count: number;
  /** The stroke: out of the state's top edge, up and to the right. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
  label: string;
}

/** The pill a stub's label is drawn in — one width, for the layout that places it and the screen that draws it. */
export const stubPillWidth = (label: string) => 14 + label.length * 6.4;

export const stubId = (r: { from: string; attempted: string | null; operation: string }) => `${r.from}|${r.attempted ?? ''}|${r.operation}`;

/** How far apart two stubs out of one state sit: along its top edge, and in height. */
const STUB_STEP_X = 34;
const STUB_LANE = 24;

export interface RefusalStubs {
  stubs: LaidStub[];
  /**
   * Refusals out of a state the model does not declare (#1745 review): there is no node to
   * draw them from, so the screen lists them instead — never drops them.
   */
  unplaced: { from: string; attempted: string | null; operation: string; count: number }[];
  /**
   * The topmost y the stubs reach, 0 when they stay inside the layout. A stub out of a
   * top-row state rises above it; the drawing's viewBox starts here so nothing is clipped.
   */
  top: number;
}

/**
 * Where each refused move is drawn. A short stroke leaves the top edge of the state the
 * record was in and ends in a cross — it goes nowhere, which is the point — with its count
 * in a pill beyond it. Several out of one state each get their own lane upward, so no two
 * pills share a height, and their anchors wrap along that state's top edge rather than
 * running off it; the busiest is nearest the corner and lowest.
 */
export function refusalStubs(
  layout: ProcessLayout,
  refused: { from: string; attempted: string | null; operation: string; count: number }[],
): RefusalStubs {
  const at = new Map(layout.states.map((s) => [s.state, s]));
  const perState = new Map<string, number>();
  const perEdge = Math.max(1, Math.floor((NODE_W - 22 - 12) / STUB_STEP_X) + 1);
  const stubs: LaidStub[] = [];
  const unplaced: RefusalStubs['unplaced'] = [];
  let top = 0;
  for (const r of [...refused].sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation))) {
    const s = at.get(r.from);
    if (!s) {
      unplaced.push(r);
      continue;
    }
    const i = perState.get(r.from) ?? 0;
    perState.set(r.from, i + 1);
    const x1 = s.x + NODE_W - 22 - (i % perEdge) * STUB_STEP_X;
    const y1 = s.y;
    const x2 = x1 + 14;
    const y2 = y1 - 30 - i * STUB_LANE;
    const label = `${r.from} → ${r.attempted ?? '?'} ×${r.count.toLocaleString('en-US')}`;
    // Kept inside the drawing: a refusal out of the rightmost state (typically the terminal
    // one — "closed → open") would otherwise put its pill past the edge.
    const w = stubPillWidth(label);
    const labelX = Math.min(Math.max(x2, w / 2 + 4), layout.width - w / 2 - 4);
    const labelY = y2 - 14;
    top = Math.min(top, labelY - 12);
    stubs.push({ id: stubId(r), from: r.from, attempted: r.attempted, operation: r.operation, count: r.count, x1, y1, x2, y2, labelX, labelY, label });
  }
  return { stubs, unplaced, top };
}
