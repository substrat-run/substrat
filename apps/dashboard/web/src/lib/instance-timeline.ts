import type { Actor, EmittedLifecycle, HistoryEntry } from '@substrat-run/contracts';

/**
 * One record's lifecycle, told from its own history (#1916, design §5): where its time
 * went, and what moved it.
 *
 * The same replay the process map runs over a whole entity type (`readLifecycleFlow`,
 * #1903), for one record and in the browser, over the history the Event history card
 * already reads. The rules match it, so a record here and its counts there agree:
 *
 * - **The payload first.** An event that carries the lifecycle field says what the row
 *   held. A new value is a move.
 * - **The declaration otherwise.** An event without it (erased, or a payload that does not
 *   carry the field) still names its operation, and `on[operation]` from where the record
 *   was says where it went.
 * - **A move first seen late** — the payload shows a new state under an operation that is
 *   no edge for it, while the declaration has one — is kept, with no operation claimed.
 *   The call that made it recorded nothing on this record.
 */

export interface Stay {
  state: string;
  since: string;
  /** Null while the record is still in it. */
  until: string | null;
  ms: number;
  terminal: boolean;
}

export type ActorKind = 'person' | 'consumer' | 'connector' | 'link' | 'app' | 'unknown';

export interface Move {
  eventId: string;
  at: string;
  from: string;
  to: string;
  /** Null when no operation made it (a consumer's emit) or the move was only seen late. */
  operation: string | null;
  actor: Actor;
  actorKind: ActorKind;
  invocationId: string | null;
  /** The declaration has an edge from `from` to `to`. */
  declared: boolean;
  /** Back into a state the record had already been in. */
  reopen: boolean;
  seenLate: boolean;
}

export interface InstanceTimeline {
  /** When the first event of the record happened — the start of what is on record. */
  startedAt: string;
  current: string;
  stays: Stay[];
  moves: Move[];
  /** First event to the terminal state, or to `now` while it is still moving. */
  lifecycleMs: number;
  finished: boolean;
  reopens: number;
  /** Distinct calls that recorded something on this record. */
  calls: number;
  /** Who made the most moves, and how many. Null when nothing moved it. */
  topActor: { kind: ActorKind; label: string; moves: number } | null;
}

export function actorKindOf(actor: Actor): ActorKind {
  if (typeof actor === 'string') return 'person';
  if (actor === null || typeof actor !== 'object') return 'unknown';
  if ('system' in actor) return 'consumer';
  if ('connection' in actor) return 'connector';
  if ('capability' in actor) return 'link';
  if ('vertical' in actor) return 'app';
  return 'unknown';
}

/**
 * The lifecycle field, read only from an event classed as carrying no personal data — the
 * process map's rule (#1762, `readLifecycleFlow`), so a record here takes the same path it
 * takes there. A classified event is treated as field-less, and the declaration decides.
 */
const stateIn = (e: HistoryEntry, field: string): string | null => {
  if (e.piiClass !== 'none') return null;
  const p = e.payload;
  if (p === null || typeof p !== 'object') return null;
  const v = (p as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : null;
};

const ms = (a: string, b: string) => Math.max(0, Date.parse(b) - Date.parse(a));

/**
 * Replay the record's events (any order; sorted here by id, which is time) against its
 * lifecycle. `now` closes the stay the record is still in.
 */
export function instanceTimeline(
  entries: HistoryEntry[],
  lifecycle: EmittedLifecycle,
  now: string,
  labelOf: (actor: Actor) => string = (a) => (typeof a === 'string' ? a : JSON.stringify(a)),
): InstanceTimeline | null {
  const asc = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (asc.length === 0) return null;
  const declared = (s: string | null): s is string => s !== null && Object.prototype.hasOwnProperty.call(lifecycle.states, s);
  const target = (from: string, op: string | null) => (op === null ? undefined : lifecycle.states[from]?.on?.[op]);
  const hasEdge = (from: string, to: string) => Object.values(lifecycle.states[from]?.on ?? {}).includes(to);
  const terminal = (s: string) => lifecycle.states[s]?.terminal === true;

  const first = asc[0]!;
  const firstState = stateIn(first, lifecycle.field);
  let current = declared(firstState) ? firstState : lifecycle.initial;
  let since = first.occurredAt;
  const visited = new Set([current]);
  const stays: Stay[] = [];
  const moves: Move[] = [];
  const movedIn = new Set<string>();

  const move = (e: HistoryEntry, to: string, operation: string | null, seenLate: boolean) => {
    stays.push({ state: current, since, until: e.occurredAt, ms: ms(since, e.occurredAt), terminal: terminal(current) });
    moves.push({
      eventId: e.id,
      at: e.occurredAt,
      from: current,
      to,
      operation,
      actor: e.actor,
      actorKind: actorKindOf(e.actor),
      invocationId: e.invocationId,
      declared: hasEdge(current, to),
      reopen: visited.has(to),
      seenLate,
    });
    visited.add(to);
    current = to;
    since = e.occurredAt;
  };

  // A record found mid-life (its first event already in a later state) only moved on
  // record if the declaration has that edge out of the initial state under the first op.
  if (current !== lifecycle.initial && target(lifecycle.initial, first.operation) === current) {
    current = lifecycle.initial;
    move(first, firstState!, first.operation, false);
  }

  for (const e of asc.slice(1)) {
    const s = stateIn(e, lifecycle.field);
    if (declared(s)) {
      if (s === current) continue;
      if (e.operation !== null && target(current, e.operation) === s) move(e, s, e.operation, false);
      else if (e.operation !== null && hasEdge(current, s)) move(e, s, null, true);
      else move(e, s, e.operation, false);
      continue;
    }
    const to = target(current, e.operation);
    const call = e.invocationId;
    if (to !== undefined && to !== current && !(call !== null && movedIn.has(call))) {
      if (call !== null) movedIn.add(call);
      move(e, to, e.operation, false);
    }
  }
  const finished = terminal(current);
  stays.push({ state: current, since, until: null, ms: finished ? 0 : ms(since, now), terminal: finished });

  const tally = new Map<string, { kind: ActorKind; label: string; moves: number }>();
  for (const m of moves) {
    const label = labelOf(m.actor);
    const t = tally.get(label) ?? { kind: m.actorKind, label, moves: 0 };
    t.moves += 1;
    tally.set(label, t);
  }
  const topActor = [...tally.values()].sort((a, b) => b.moves - a.moves || a.label.localeCompare(b.label))[0] ?? null;
  const end = finished ? since : now;
  return {
    startedAt: first.occurredAt,
    current,
    stays,
    moves,
    lifecycleMs: ms(first.occurredAt, end),
    finished,
    reopens: moves.filter((m) => m.reopen).length,
    calls: new Set(asc.map((e) => e.invocationId).filter((x): x is string => x !== null)).size,
    topActor,
  };
}

/** Where each day starts along the record's span, as a share of it — the to-scale bar's ticks. */
export function dayTicks(from: string, to: string): { at: number; share: number; label: string }[] {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!(b > a)) return [];
  const span = b - a;
  const day = 86_400_000;
  // Too many days to label legibly: fall back to weeks.
  const step = span / day > 21 ? 7 * day : day;
  const ticks: { at: number; share: number; label: string }[] = [];
  for (let t = Math.ceil(a / day) * day; t < b; t += step) {
    const d = new Date(t);
    ticks.push({ at: t, share: (t - a) / span, label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }) });
  }
  return ticks;
}
