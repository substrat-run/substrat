import type { DeadLetter, FlowEdge, FlowGraph, FlowNode } from './api';

/**
 * The flow map's six-column layout (#1767), derived from the worker's flow graph.
 *
 * The worker lays its graph out in four bands (triggers, modules, events, the outside),
 * and the redesign draws six columns left to right. Two of the extra columns are the
 * outside band split by kind — connections and outbound hosts are already separate node
 * kinds. The third, consumers, is derived from the `consumes` edges: a module that
 * handles an event is drawn a second time, in the consumers column, and the edge lands
 * there instead of pointing back at the module. That is the same declared fact the
 * worker's edge carried ("module m handles type t"), drawn where the design reads it, so
 * nothing is invented by the split.
 *
 * The worker's own `x`/`y` are ignored here: they belong to the banded layout.
 */

export type FlowColumnKey = 'trigger' | 'module' | 'event' | 'consumer' | 'connection' | 'egress';

export const FLOW_COLUMNS: { key: FlowColumnKey; label: string }[] = [
  { key: 'trigger', label: 'Triggers' },
  { key: 'module', label: 'Modules' },
  { key: 'event', label: 'Events' },
  { key: 'consumer', label: 'Consumers' },
  { key: 'connection', label: 'Connections' },
  { key: 'egress', label: 'Outbound hosts' },
];

/**
 * ✓ healthy, ▲ degraded, ● failing, ◌ declared and unused (drawn dashed), ? not known —
 * a consumer whose dead letters could not be read. Unknown is its own mark because the
 * alternative is ✓, and a green tick over data nobody read is a claim the map cannot make.
 */
export type FlowHealth = 'ok' | 'warn' | 'fail' | 'unused' | 'unknown';

export const HEALTH_GLYPH: Record<FlowHealth, string> = { ok: '✓', warn: '▲', fail: '●', unused: '◌', unknown: '?' };

export interface LaidNode {
  id: string;
  column: FlowColumnKey;
  label: string;
  sublabel: string | null;
  /** The worker's sentence for the node, or ours for a derived consumer. */
  title: string;
  health: FlowHealth;
  x: number;
  y: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  kind: FlowEdge['kind'];
  /** Dashed when either end is declared and unused: a path nothing has taken. */
  dashed: boolean;
  d: string;
}

export interface FlowLayout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  columns: { key: FlowColumnKey; label: string; x: number }[];
  width: number;
  height: number;
}

export const NODE_W = 122;
export const NODE_H = 30;
const COL_STEP = 130;
const TOP = 24;
const ROW_STEP = 42;

/**
 * A node's health from what the worker recorded about it. `silent` is proven silence
 * (declared, observation complete, nothing recorded) and `stale` is a path that ran and
 * stopped — different stories, so they get different marks.
 */
export function nodeHealth(n: Pick<FlowNode, 'silent' | 'stale' | 'status'>): FlowHealth {
  if (n.status === 'danger') return 'fail';
  if (n.silent) return 'unused';
  if (n.status === 'warn' || n.stale) return 'warn';
  return 'ok';
}

/** The consumer node's id for a module, kept apart from the module's own node. */
export const consumerId = (moduleId: string): string => `consumer:${moduleId}`;

/**
 * `deadLetters` is the rows loaded so far, or `null` when none could be read (still
 * loading, or the read failed). Null leaves every consumer without a failure seen
 * `unknown` rather than `ok`.
 */
export function flowLayout(graph: FlowGraph, deadLetters: readonly DeadLetter[] | null = []): FlowLayout {
  const cols = new Map<FlowColumnKey, LaidNode[]>(FLOW_COLUMNS.map((c) => [c.key, []]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: Omit<LaidNode, 'x' | 'y'>[] = graph.nodes.map((n) => ({
    id: n.id,
    column: n.kind,
    label: n.label,
    sublabel: n.sublabel,
    title: n.title,
    health: nodeHealth(n),
  }));

  // Dead letters name their consumer by module id. Only the rows loaded so far are
  // counted, so a consumer is marked failing when one is seen and never cleared by
  // absence — the list is paged, and an unloaded page is not a clean bill.
  const dead = new Map<string, { n: number; types: Set<string> }>();
  for (const d of deadLetters ?? []) {
    const had = dead.get(d.consumer) ?? { n: 0, types: new Set<string>() };
    had.n += 1;
    had.types.add(d.eventType);
    dead.set(d.consumer, had);
  }

  const edges: Omit<LaidEdge, 'd' | 'dashed'>[] = [];
  const consumers = new Map<string, string[]>();
  for (const e of graph.edges) {
    const target = byId.get(e.to);
    if (e.kind === 'consumes' && target?.kind === 'module') {
      const handled = consumers.get(target.label) ?? [];
      handled.push(byId.get(e.from)?.label ?? e.from);
      consumers.set(target.label, handled);
      edges.push({ from: e.from, to: consumerId(target.label), kind: e.kind });
    } else {
      edges.push({ from: e.from, to: e.to, kind: e.kind });
    }
  }
  for (const [moduleId, types] of [...consumers].sort(([a], [b]) => a.localeCompare(b))) {
    const failed = dead.get(moduleId)?.n ?? 0;
    const unread = deadLetters === null && failed === 0;
    nodes.push({
      id: consumerId(moduleId),
      column: 'consumer',
      label: moduleId,
      sublabel: failed > 0 ? deadLetterCount(failed) : unread ? 'dead letters unread' : null,
      title:
        `${moduleId} handles ${types.length} event ${types.length === 1 ? 'type' : 'types'}: ${types.join(', ')}.` +
        (failed > 0 ? ` ${failed} ${failed === 1 ? 'delivery' : 'deliveries'} to it gave up.` : '') +
        (unread ? ' Its dead letters could not be read, so whether any delivery to it gave up is not known.' : ''),
      health: failed > 0 ? 'fail' : unread ? 'unknown' : 'ok',
    });
  }

  // A dead letter can name a consumer the declaration draws no node for: an executor
  // (`executor:<id>`, a connector or platform handler), or a module the running version
  // no longer declares as consuming anything. Each gets a failing node of its own in the
  // consumers column, fed by the event types it gave up on, so every dead letter the
  // panel lists is also somewhere on the map.
  const eventNode = new Map(graph.nodes.filter((n) => n.kind === 'event').map((n) => [n.label, n.id]));
  for (const [consumer, { n, types }] of [...dead].filter(([c]) => !consumers.has(c)).sort(([a], [b]) => a.localeCompare(b))) {
    const executor = consumer.startsWith('executor:');
    nodes.push({
      id: consumerId(consumer),
      column: 'consumer',
      label: consumer,
      sublabel: `${executor ? 'executor' : 'not declared'} · ${deadLetterCount(n)}`,
      title:
        `${consumer} ${executor ? 'is an executor, which the declaration does not draw' : 'is not a consumer the running version declares — it was removed, or stopped consuming'}. ` +
        `${n} ${n === 1 ? 'delivery' : 'deliveries'} to it gave up, for ${[...types].sort().join(', ')}.`,
      health: 'fail',
    });
    for (const t of types) {
      const from = eventNode.get(t);
      if (from) edges.push({ from, to: consumerId(consumer), kind: 'consumes' });
    }
  }

  const laid: LaidNode[] = [];
  const colIndex = new Map(FLOW_COLUMNS.map((c, i) => [c.key, i]));
  for (const n of nodes) {
    const list = cols.get(n.column)!;
    const node = { ...n, x: 4 + colIndex.get(n.column)! * COL_STEP, y: TOP + list.length * ROW_STEP };
    list.push(node);
    laid.push(node);
  }
  const pos = new Map(laid.map((n) => [n.id, n]));
  const rows = Math.max(1, ...[...cols.values()].map((l) => l.length));

  return {
    nodes: laid,
    edges: edges.flatMap((e) => {
      const p = pos.get(e.from);
      const q = pos.get(e.to);
      if (!p || !q) return [];
      const x1 = p.x + NODE_W;
      const y1 = p.y + NODE_H / 2;
      const x2 = q.x;
      const y2 = q.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      return [{ ...e, dashed: p.health === 'unused' || q.health === 'unused', d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` }];
    }),
    columns: FLOW_COLUMNS.map((c, i) => ({ ...c, x: 4 + i * COL_STEP })),
    width: 4 + (FLOW_COLUMNS.length - 1) * COL_STEP + NODE_W,
    height: TOP + rows * ROW_STEP,
  };
}

const deadLetterCount = (n: number) => `${n} dead ${n === 1 ? 'letter' : 'letters'}`;

type Link = Pick<LaidEdge, 'from' | 'to'>;

/**
 * What feeds a node and what it feeds, all the way along: every ancestor, every
 * descendant, and the edges on those paths. Transitive rather than one hop, because
 * "why is this consumer failing" is answered by the trigger two columns back. Up and
 * down are walked apart so an edge between two upstream siblings that does not pass
 * through the selection stays unlit.
 */
export function highlight(edges: readonly Link[], sel: string): { nodes: Set<string>; edges: Set<Link> } {
  const up = walk(edges, sel, (e) => [e.to, e.from]);
  const down = walk(edges, sel, (e) => [e.from, e.to]);
  return {
    nodes: new Set([...up, ...down]),
    edges: new Set(edges.filter((e) => (up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to)))),
  };
}

function walk(edges: readonly Link[], start: string, step: (e: Link) => [string, string]): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of edges) {
      const [here, there] = step(e);
      if (here === at && !seen.has(there)) {
        seen.add(there);
        queue.push(there);
      }
    }
  }
  return seen;
}
