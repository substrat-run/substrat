import type { CauseChain, EventDelivery, HistoryEntry } from '@substrat-run/contracts';
import { actorLabel } from './history';

/**
 * How the Event history card reads (#1767) — the derivations behind `EntityTimeline`'s
 * rows and its investigation strips, kept pure so they are asserted rather than eyeballed.
 *
 * Everything here is derived from fields `readHistory` and the cause/effects reads
 * already return. Nothing is phrased that the record does not say: the "summary" of a
 * row is its operation, not a business sentence, and a before-value is only ever the
 * previous event's own statement of the same key.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** `Tue 23 Sep 15:41:02`, in the reader's own time zone. An unparseable instant is shown as it came. */
export function eventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Newest first, by id. An event id is a ULID minted in order, so it is the spine's own
 * sequence — two events of one call share an `occurredAt` to the millisecond, and
 * sorting by time would order them by chance.
 */
export function newestFirst<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const payloadObject = (p: unknown): Record<string, unknown> | null =>
  p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;

/**
 * The events that moved the entity's lifecycle field — the rows the design sets in
 * primary text. Walked oldest first: an event is a transition when its payload carries
 * the field and the value differs from the last one an earlier event carried (the first
 * value seen counts, since it is where the lifecycle began). An event that does not
 * carry the field says nothing about it and never counts.
 *
 * With no lifecycle field known (the model declares none for this entity, or could not
 * be read) the answer is empty: no row is emphasised rather than a guessed one.
 */
export function stateChangingIds(oldestFirst: readonly HistoryEntry[], field: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!field) return ids;
  let last: string | undefined;
  for (const e of oldestFirst) {
    const p = payloadObject(e.payload);
    if (!p || !(field in p)) continue;
    const value = JSON.stringify(p[field]);
    if (value !== last) ids.add(e.id);
    last = value;
  }
  return ids;
}

/**
 * A row's summary, from the three fields that can honestly make one: the operation it
 * was emitted from, the cause when a consumer emitted it, and whether its payload is
 * still there. No business prose — the record does not hold any.
 */
export function eventSummary(e: Pick<HistoryEntry, 'operation' | 'causedBy' | 'payload' | 'decodeError'>): string {
  const from = e.operation
    ? e.operation
    : e.causedBy
      ? 'emitted by a consumer, reacting to an earlier event'
      : 'no operation recorded';
  if (e.decodeError) return `${from} · not read whole (${e.decodeError})`;
  if (e.payload == null) return `${from} · payload erased`;
  return from;
}

export interface PayloadRow {
  key: string;
  value: string;
  /** The previous event's value for this key, present only when it carried the key and it differs. */
  was?: string;
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The payload as key/value rows, with a struck-through "was" where the PREVIOUS event
 * of this record carried the same key with a different value.
 *
 * Events are fat but not full state, so nothing stores a before-state: the only honest
 * "before" is what the event before this one said about the same key. A key the
 * previous event did not carry gets no "was" — rendering one as `null` would claim the
 * field was empty, when the record says nothing about it. Null when there is no object
 * payload to split (erased, or a scalar), so the caller shows it whole.
 */
export function payloadRows(entry: Pick<HistoryEntry, 'payload'>, previous?: Pick<HistoryEntry, 'payload'>): PayloadRow[] | null {
  const cur = payloadObject(entry.payload);
  if (!cur) return null;
  const prev = previous ? payloadObject(previous.payload) : null;
  return Object.entries(cur).map(([key, v]) => {
    const row: PayloadRow = { key, value: show(v) };
    if (prev && key in prev && JSON.stringify(prev[key]) !== JSON.stringify(v)) row.was = show(prev[key]);
    return row;
  });
}

/** `+380 ms`, `+2.1 s`, `+4 min`, `+3 h` — how long after the event something happened. */
export function after(ms: number): string {
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `+${Math.round(ms / 60_000)} min`;
  return `+${Math.round(ms / 3_600_000)} h`;
}

export type Tone = 'success' | 'warning' | 'danger';

/**
 * One consumer's delivery, as the effect tree's status column.
 *
 * The three states stay apart — a retry and a give-up both carry an error, and merging
 * them would promise a retry that is not coming. The delay is only drawn for a
 * delivered row: its `at` is when it was handled, while a retrying row's `at` is the
 * last ATTEMPT, and a "+2 s" there would read as a delivery that has not happened. No
 * attempt ceiling is shown, because the delivery row does not record one.
 */
export function deliveryStatus(d: Pick<EventDelivery, 'state' | 'at' | 'attempts'>, occurredAt: string): { glyph: string; text: string; tone: Tone } {
  if (d.state === 'delivered') {
    const gap = Date.parse(d.at) - Date.parse(occurredAt);
    return { glyph: '✓', text: Number.isFinite(gap) && gap >= 0 ? after(gap) : 'handled', tone: 'success' };
  }
  const n = `${d.attempts} attempt${d.attempts === 1 ? '' : 's'}`;
  if (d.state === 'retrying') return { glyph: '⟳', text: `retrying · ${n} so far`, tone: 'warning' };
  return { glyph: '✕', text: `gave up after ${n}`, tone: 'danger' };
}

export type CauseChipKind = 'actor' | 'op' | 'event' | 'cut';
export interface CauseChip {
  kind: CauseChipKind;
  label: string;
  /** The event id, for an `event` chip — so a chip naming a row on screen can open it. */
  eventId?: string;
  title?: string;
}

/**
 * A cause chain as the Why? strip's chips, read left to right the way it happened:
 * who began it, the operation they ran, then each event down to the one asked about.
 *
 * The chain arrives newest first; it is reversed here. Only an `operation` ending names
 * a beginning — the actor and operation of the chain's oldest event. Every other ending
 * opens with a `cut` chip instead, because a trail that ran out and a trail that began
 * are the same shape, and the chips must not let one pass for the other.
 */
export function causeChips(chain: CauseChain): CauseChip[] {
  const oldest = [...chain.chain].reverse();
  const root = oldest[0];
  const chips: CauseChip[] = [];
  if (chain.terminal === 'operation' && root) {
    chips.push({ kind: 'actor', label: actorLabel(root.actor) });
    if (root.operation) {
      chips.push({ kind: 'op', label: root.operation, title: root.version ? `version ${root.version}` : undefined });
    }
  } else if (chain.terminal === 'imported') {
    chips.push({ kind: 'cut', label: chain.imported ? `${chain.imported.vertical} app` : 'another app' });
  } else {
    const CUT: Record<string, string> = { unrecorded: 'trail not recorded', depth: 'more above', missing: 'cause missing', cycle: 'loop' };
    chips.push({ kind: 'cut', label: CUT[chain.terminal] ?? chain.terminal });
  }
  for (const e of oldest) chips.push({ kind: 'event', label: e.type, eventId: e.id });
  return chips;
}
