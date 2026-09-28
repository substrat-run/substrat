/**
 * Replay one entity's declared lifecycle over a scope's outbox (#1744) — the process map's
 * data, with no new write path.
 *
 * A transition is a status write inside an operation body, and the kernel never recorded
 * "entity X moved from A to B". It did record everything a replay needs: every event names
 * its entity, and (#1243) the operation that emitted it — which is exactly what a declared
 * edge is keyed by. So one entity's events, in order, give its state sequence, and the gaps
 * between moves give time-in-state.
 *
 * ## Where a state comes from
 *
 * **The payload first.** A fat event usually carries the row's lifecycle field, and when it
 * does that value is what the row actually held — no inference about what the operation
 * meant. It is read only from events classed `pii_class = 'none'`: the field is an enum, but
 * #1762's rule is per event, and a read that extracts from a classified payload is the kind
 * of exception that later grows.
 *
 * **The declaration otherwise.** An erased, classified or field-less event still names its
 * operation, and the operation column survives a shred. From the state the replay has the
 * entity in, `on[operation]` is where the declaration says it went. Counted apart
 * (`inferred`), because this half is faithful only while the code agrees with the model.
 *
 * The previous state decides what an event means, which is why this is a walk in order and
 * not a GROUP BY: `ticket0/ingest-message` is merely *allowed* in `open` and an *edge* out of
 * `resolved`, so the same operation is a move or not depending on where the entity was.
 *
 * ## Bounded
 *
 * One entity type's events, walked in `(entity_id, id)` order — the `_substrat_outbox_entity`
 * index — in keyset pages, up to `LIFECYCLE_FLOW_EVENT_BUDGET`. Past it the answer says
 * `complete: false`, and every count is a lower bound; it never quietly becomes a smaller
 * answer. History BEFORE the window is replayed too, since the state an entity was in when
 * the window opened is only known from it; events after `until` are not read at all.
 *
 * Same permission posture as every read in `timeline.ts`: the caller checks, this does not.
 */
import {
  LIFECYCLE_FLOW_EVENT_BUDGET,
  type LifecycleActorKind,
  type LifecycleFlowInput,
  type LifecycleFlowResult,
} from '@substrat-run/contracts';
import type { TimelineReader } from './timeline.js';

const PAGE = 1_000;
const STUCK_DEFAULT = 5;

interface EventRow {
  entity_id: string;
  id: string;
  occurred_at: string;
  operation: string | null;
  invocation_id: string | null;
  /** The envelope's actor, as stored: a JSON string for a principal, an object for the rest. */
  actor: string;
  /** The lifecycle field, extracted only from an unclassified, unerased payload. */
  state: string | null;
}

interface Stay {
  state: string;
  since: string;
}

interface EntityWalk {
  id: string;
  firstAt: string;
  /** True when the first event found the entity in the initial state — it started here. */
  startedInitial: boolean;
  stay: Stay;
  visited: Set<string>;
  lastOperation: string | null;
  lastAt: string;
  finishedAt: string | null;
  /** Invocations that already moved this entity by inference — one move per call. */
  inferredIn: Set<string>;
}

/**
 * The kind of actor a stored `actor` names — read off its JSON shape, never decoded in
 * full: a principal is a bare JSON string, every other kind an object keyed by its kind.
 */
function actorKindOf(stored: string): LifecycleActorKind {
  try {
    const actor: unknown = JSON.parse(stored);
    if (typeof actor === 'string') return 'principal';
    if (actor !== null && typeof actor === 'object') {
      for (const kind of ['system', 'connection', 'capability', 'vertical'] as const) {
        if (kind in actor) return kind;
      }
    }
  } catch {
    /* not JSON: counted as unknown below */
  }
  return 'unknown';
}

const ms = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));

/** Nearest-rank percentile over a sorted list. */
function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * A bound in the outbox's own spelling. `occurred_at` is compared as TEXT, and ISO 8601
 * orders as text only within one spelling: `…T00:00:00Z` sorts AFTER `…T00:00:00.000Z`
 * (`Z` > `.`), so a caller's second-precision `since` would drop the events at exactly
 * that instant. Rendered through `toISOString`, the format every emit stamps.
 */
function outboxInstant(name: string, value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new RangeError(`lifecycle flow: '${name}' is not an ISO 8601 instant: ${value}`);
  return new Date(t).toISOString();
}

export function readLifecycleFlow(ctx: TimelineReader, input: LifecycleFlowInput): LifecycleFlowResult {
  const { lifecycle } = input;
  const since = outboxInstant('since', input.since);
  const until = outboxInstant('until', input.until);
  const stuckLimit = input.stuckLimit ?? STUCK_DEFAULT;
  const states = lifecycle.states;
  const declared = (s: string): boolean => Object.prototype.hasOwnProperty.call(states, s);
  const terminal = (s: string): boolean => states[s]?.terminal === true;
  const targetOf = (from: string, op: string): string | undefined => states[from]?.on?.[op];
  /** Operations that are an edge out of SOME state — the ones whose absence from here is a question. */
  const edgeOps = new Set(Object.values(states).flatMap((s) => Object.keys(s.on ?? {})));
  const hasEdge = (from: string, to: string): boolean => Object.values(states[from]?.on ?? {}).includes(to);
  const inWindow = (at: string): boolean => at >= since && at < until;

  // Every declared edge, so one nobody took is present at 0 rather than absent.
  const edges = new Map<string, LifecycleFlowResult['edges'][number]>();
  const edgeKey = (from: string, to: string, op: string) => `${from}\u0000${to}\u0000${op}`;
  for (const [from, def] of Object.entries(states)) {
    for (const [op, to] of Object.entries(def.on ?? {})) {
      edges.set(edgeKey(from, to, op), { from, to, operation: op, count: 0, actors: {}, declared: true, seenLate: false });
    }
  }
  const entered = new Map<string, number>();
  const dwell = new Map<string, number[]>();
  const current = new Map<string, number>();
  const stuck = new Map<string, Array<{ entityId: string; since: string; lastOperation: string | null; lastAt: string }>>();
  const lifecycleMs: number[] = [];
  const reached = new Map<string, number>();
  let started = 0;
  let finished = 0;
  let entities = 0;
  let events = 0;
  let inferred = 0;
  let unexplained = 0;
  let seenLate = 0;

  const move = (
    walk: EntityWalk,
    to: string,
    op: string | null,
    at: string,
    isDeclared: boolean,
    actor: string,
    seenLate = false,
  ) => {
    const from = walk.stay.state;
    if (inWindow(at)) {
      const key = `${edgeKey(from, to, op ?? '')}${seenLate ? '\u0000late' : ''}`;
      const edge = edges.get(key) ?? { from, to, operation: op, count: 0, actors: {}, declared: isDeclared, seenLate };
      edge.count += 1;
      const kind = actorKindOf(actor);
      edge.actors[kind] = (edge.actors[kind] ?? 0) + 1;
      edges.set(key, edge);
      entered.set(to, (entered.get(to) ?? 0) + 1);
      const stays = dwell.get(from) ?? [];
      stays.push(ms(walk.stay.since, at));
      dwell.set(from, stays);
    }
    walk.stay = { state: to, since: at };
    walk.visited.add(to);
    if (terminal(to) && walk.finishedAt === null) walk.finishedAt = at;
  };

  const settle = (walk: EntityWalk) => {
    entities += 1;
    const s = walk.stay.state;
    current.set(s, (current.get(s) ?? 0) + 1);
    if (!terminal(s)) {
      const list = stuck.get(s) ?? [];
      list.push({ entityId: walk.id, since: walk.stay.since, lastOperation: walk.lastOperation, lastAt: walk.lastAt });
      // Keep only the oldest few: sorted by entry, truncated as it grows.
      list.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
      if (list.length > stuckLimit) list.length = stuckLimit;
      stuck.set(s, list);
    }
    if (walk.startedInitial && inWindow(walk.firstAt)) {
      started += 1;
      for (const v of walk.visited) reached.set(v, (reached.get(v) ?? 0) + 1);
    }
    if (walk.finishedAt !== null && inWindow(walk.finishedAt)) {
      finished += 1;
      lifecycleMs.push(ms(walk.firstAt, walk.finishedAt));
    }
  };

  const step = (walk: EntityWalk, row: EventRow) => {
    const op = row.operation;
    const payloadState = row.state !== null && declared(row.state) ? row.state : null;
    if (payloadState !== null) {
      const from = walk.stay.state;
      if (payloadState !== from) {
        if (op !== null && targetOf(from, op) === payloadState) {
          move(walk, payloadState, op, row.occurred_at, true, row.actor);
        } else if (op !== null && hasEdge(from, payloadState)) {
          // The declaration HAS a way from here to there, and this event's operation is not
          // it: the move was made by a call that emitted nothing about this entity, and this
          // event is merely the first to show the new state. Filed against the declared
          // pair with no operation — never blamed on the operation that happened to report
          // it — at this event's time, which is when it became visible, not when it happened.
          seenLate += inWindow(row.occurred_at) ? 1 : 0;
          move(walk, payloadState, null, row.occurred_at, true, row.actor, true);
        } else {
          // Either a move the declaration has no edge for, or a consumer's own emit (no
          // operation), which no declaration of operations can hold.
          move(walk, payloadState, op, row.occurred_at, false, row.actor);
        }
      }
    } else if (op !== null) {
      const target = targetOf(walk.stay.state, op);
      const call = row.invocation_id;
      if (target !== undefined && target !== walk.stay.state && !(call !== null && walk.inferredIn.has(call))) {
        inferred += inWindow(row.occurred_at) ? 1 : 0;
        if (call !== null) walk.inferredIn.add(call);
        move(walk, target, op, row.occurred_at, true, row.actor);
      } else if (target === undefined && edgeOps.has(op) && !(states[walk.stay.state]?.allow ?? []).includes(op)) {
        unexplained += inWindow(row.occurred_at) ? 1 : 0;
      }
    }
    walk.lastOperation = op;
    walk.lastAt = row.occurred_at;
  };

  const begin = (row: EventRow): EntityWalk => {
    // The first event establishes where the entity is. A payload that says so is believed;
    // otherwise the entity starts where the declaration says rows start.
    const first = row.state !== null && declared(row.state) ? row.state : lifecycle.initial;
    const walk: EntityWalk = {
      id: row.entity_id,
      firstAt: row.occurred_at,
      startedInitial: first === lifecycle.initial,
      stay: { state: lifecycle.initial, since: row.occurred_at },
      visited: new Set([lifecycle.initial]),
      lastOperation: null,
      lastAt: row.occurred_at,
      finishedAt: null,
      inferredIn: new Set(),
    };
    if (first !== lifecycle.initial) {
      // Found mid-life (created before the outbox recorded it, or by a path that emitted
      // nothing). Its first move is only a transition if the declaration has that edge out
      // of the initial state; otherwise the walk simply starts where it was found.
      const op = row.operation;
      if (op !== null && targetOf(lifecycle.initial, op) === first) {
        // Created by a path that emitted nothing, then moved by a declared edge out of the
        // initial state: it did start in the initial state, so it counts as a start.
        walk.startedInitial = true;
        move(walk, first, op, row.occurred_at, true, row.actor);
      } else {
        walk.stay = { state: first, since: row.occurred_at };
        walk.visited = new Set([first]);
        if (terminal(first)) walk.finishedAt = row.occurred_at;
      }
      walk.lastOperation = op;
      return walk;
    }
    step(walk, row);
    return walk;
  };

  let walk: EntityWalk | null = null;
  let after: { entity: string; id: string } | null = null;
  let complete = true;
  const path = `$.${lifecycle.field}`;
  for (;;) {
    if (events >= LIFECYCLE_FLOW_EVENT_BUDGET) {
      complete = false;
      break;
    }
    const take = Math.min(PAGE, LIFECYCLE_FLOW_EVENT_BUDGET - events);
    const rows: EventRow[] = ctx.sql.query<EventRow>(
      `SELECT entity_id, id, occurred_at, operation, invocation_id, actor,
              CASE WHEN pii_class = 'none' AND payload IS NOT NULL
                   THEN CAST(json_extract(payload, ?) AS TEXT) END AS state
         FROM _substrat_outbox
        WHERE entity_type = ? AND occurred_at < ?${after ? ' AND (entity_id > ? OR (entity_id = ? AND id > ?))' : ''}
        ORDER BY entity_id, id
        LIMIT ?`,
      [path, input.entityType, until, ...(after ? [after.entity, after.entity, after.id] : []), take],
    );
    for (const row of rows) {
      events += 1;
      if (walk === null || walk.id !== row.entity_id) {
        if (walk !== null) settle(walk);
        walk = begin(row);
      } else {
        step(walk, row);
      }
    }
    if (rows.length < take) break;
    const last: EventRow = rows[rows.length - 1]!;
    after = { entity: last.entity_id, id: last.id };
  }
  // The entity the budget cut off mid-walk is settled like the rest: its state so far is a
  // lower bound like every other count once `complete` is false.
  if (walk !== null) settle(walk);

  const medianOf = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return percentile(sorted, 0.5);
  };

  return {
    entityType: input.entityType,
    since,
    until,
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || (a.operation ?? '').localeCompare(b.operation ?? ''),
    ),
    states: Object.keys(states)
      .sort()
      .map((state) => {
        const stays = [...(dwell.get(state) ?? [])].sort((a, b) => a - b);
        return {
          state,
          terminal: terminal(state),
          current: current.get(state) ?? 0,
          entered: entered.get(state) ?? 0,
          dwell: stays.length === 0 ? null : { samples: stays.length, medianMs: percentile(stays, 0.5), p90Ms: percentile(stays, 0.9) },
          stuck: stuck.get(state) ?? [],
        };
      }),
    funnel: { started, reached: Object.fromEntries([...reached].sort(([a], [b]) => a.localeCompare(b))) },
    totals: {
      started,
      finished,
      inFlight: [...current].filter(([s]) => !terminal(s)).reduce((n, [, c]) => n + c, 0),
      medianLifecycleMs: medianOf(lifecycleMs),
    },
    observation: { entities, events, inferred, unexplained, seenLate, complete },
  };
}
