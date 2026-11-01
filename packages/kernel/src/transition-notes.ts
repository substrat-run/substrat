/**
 * #2762: the lifecycle moves an operation caused, noted where they are decided.
 *
 * The scope holds no model, and a move is a status write in an operation body, so nothing the
 * host sees afterwards (the events, whose payloads rarely carry the state) can say which state an
 * entity left. `assertTransition` can: it holds the declaration, the record and the state it was
 * in. Handed the operation's context, it notes each legal move here (`ctx.noteTransition`), and
 * the host reports them after the commit on `InvokeOptions.onEmitted`, which is what puts
 * `conversation: open → resolved` on the request line.
 *
 * Noted into the invocation's `signals`, which `ctx.atomic` already marks and restores, so a move
 * inside a rolled-back sub-transaction is dropped with its writes, and a rolled-back operation
 * reports nothing at all. Consumer dispatch carries no signals and notes nothing.
 */
import { OBJECT_ID, refusalEntityType, type NotedTransition } from '@substrat-run/contracts';
import type { EmittedReport, EmittedTransition } from './scope-host.js';

/** How many entities' moves one invocation reports, in the order they first moved. */
export const TRANSITION_REPORT_CAP = 8;

/** The invocation's notes, when its caller asked for a report; absent otherwise. */
export interface TransitionTally {
  transitions?: NotedTransition[];
}

/**
 * A state as a line may carry it. A note normally holds the declaration's own names, but the
 * verb is on `ctx`, so a module could hand it anything; what is not shaped like a name is
 * dropped rather than written to a log line.
 */
const STATE = /^[\w.-]{1,64}$/;
/** The record's id: the tuple grammar's id half, and no longer than a line should carry. */
const ENTITY_ID_MAX = 128;

const refOf = (t: NotedTransition): string => `${t.entityType}:${t.entityId}`;

/** `ctx.noteTransition` over one invocation's tally. A no-op where nobody asked. */
export function noteTransitionInto(tally: TransitionTally | undefined): (t: NotedTransition) => void {
  return (t) => {
    const notes = tally?.transitions;
    if (!notes) return;
    // Runtime types first: the verb is on `ctx`, so a caller outside the type system can hand it
    // `null` or nothing, which `refusalEntityType` passes through and a pattern test stringifies.
    if (typeof t.entityType !== 'string' || refusalEntityType(t.entityType) !== t.entityType) return;
    if (typeof t.entityId !== 'string' || t.entityId.length > ENTITY_ID_MAX || !OBJECT_ID.test(t.entityId)) return;
    if (typeof t.to !== 'string' || !STATE.test(t.to)) return;
    if (t.from !== null && (typeof t.from !== 'string' || !STATE.test(t.from))) return;
    // Bounded by entity: past the cap, only an entity already noted is followed further.
    const ref = refOf(t);
    if (!notes.some((n) => refOf(n) === ref) && new Set(notes.map(refOf)).size >= TRANSITION_REPORT_CAP) return;
    notes.push({ entityType: t.entityType, entityId: t.entityId, from: t.from, to: t.to });
  };
}

/**
 * The emitted report with the invocation's moves, when it noted any: one entry per entity, from
 * the state it left first to the state it reached last, in the order the entities first moved.
 * An entity that came back to where it started did not move. With no note the report is left
 * without `transitions` — "not recorded", since a module that never hands `assertTransition`
 * its context notes nothing either, and the two must not read as the same `[]`.
 */
export function withTransitions(report: EmittedReport, notes: readonly NotedTransition[] | undefined): EmittedReport {
  return notes && notes.length > 0 ? { ...report, transitions: transitionsOf(notes) } : report;
}

function transitionsOf(notes: readonly NotedTransition[]): EmittedTransition[] {
  const byRef = new Map<string, { from: string | null; to: string }>();
  for (const n of notes) {
    const seen = byRef.get(refOf(n));
    if (seen) seen.to = n.to;
    else byRef.set(refOf(n), { from: n.from, to: n.to });
  }
  return [...byRef].filter(([, m]) => m.from !== m.to).map(([entity, m]) => ({ entity, from: m.from, to: m.to }));
}
