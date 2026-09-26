import type { ObsQuery } from './observability-query';
import type { LogMode } from './log-stream';

/**
 * The Logs query bar's chips (#1767): every filter the URL carries, as a removable chip.
 * The URL stays the one source of truth — a chip is a query key read back, and removing
 * it navigates without that key — so a chip can never show a filter the read did not use.
 *
 * Only the open mode's filters are chips: level, message and invocation narrow Lines; type
 * and grouping narrow Events. The others stay in the URL untouched, so switching modes
 * and back finds them where they were.
 */
export interface LogChip {
  key: string;
  value: string;
  /** The query keys removing this chip clears. */
  clears: (keyof ObsQuery)[];
}

export const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const LEVEL_VALUES = ['error', 'warn', 'info', 'log', 'debug'] as const;

/** "01J8ZQ…89AB": the head says which era, the tail tells two neighbours apart. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function logChips(q: ObsQuery, mode: LogMode): LogChip[] {
  if (mode === 'events') {
    const out: LogChip[] = [];
    if (q.type) out.push({ key: 'type', value: q.type, clears: ['type'] });
    if (q.field) out.push({ key: 'group by', value: `payload.${q.field}`, clears: ['groupBy', 'field'] });
    else if (q.groupBy && q.groupBy !== 'type') out.push({ key: 'group by', value: q.groupBy, clears: ['groupBy'] });
    return out;
  }
  const out: LogChip[] = [];
  if (q.level) out.push({ key: 'level', value: q.level, clears: ['level'] });
  if (q.search) out.push({ key: 'message', value: q.search, clears: ['search'] });
  if (q.invocationId) out.push({ key: 'invocation', value: shortId(q.invocationId), clears: ['invocationId'] });
  return out;
}

/** The query with every key the chips name cleared — `Clear`, or one chip's ×. */
export function without(q: ObsQuery, keys: (keyof ObsQuery)[]): ObsQuery {
  const next = { ...q };
  for (const k of keys) delete next[k];
  return next;
}

/**
 * The custom window as its chip reads it: "2026-09-01 10:00–11:00 UTC". The start always
 * carries its date, and the end repeats one whenever it falls on another UTC day — a window
 * can span up to 72 hours, and two bare clocks would read "10:00–10:00" for a whole day.
 */
export function windowLabel(from: string, to: string): string {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return `${from}–${to}`;
  const [aIso, bIso] = [new Date(a).toISOString(), new Date(b).toISOString()];
  const [aDay, aTime, bDay, bTime] = [aIso.slice(0, 10), aIso.slice(11, 16), bIso.slice(0, 10), bIso.slice(11, 16)];
  return aDay === bDay ? `${aDay} ${aTime}–${bTime} UTC` : `${aDay} ${aTime} – ${bDay} ${bTime} UTC`;
}

/**
 * What typing into the bar and pressing Enter adds. `level:error` and `invocation:<ULID>`
 * name those filters in Lines, `type:<type>` in Events; anything else is the message search
 * in Lines and the event type in Events. A malformed, empty or other-mode key is refused
 * with the reason rather than searched for as text: the reader typed a filter, and matching
 * it as a message would answer a different question with an empty list — and writing an
 * other-mode key would filter nothing and show no chip.
 */
export function parseBarText(text: string, mode: LogMode): { add: Partial<ObsQuery> } | { error: string } | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(level|invocation|type):\s*(.*)$/i.exec(t);
  if (m) {
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'type' && mode !== 'events') return { error: 'type: filters apply in Events.' };
    if (key !== 'type' && mode === 'events') return { error: `${key}: filters apply in Lines.` };
    if (!value) return { error: `${key}: needs a value after the colon.` };
    if (key === 'type') return { add: { type: value } };
    if (key === 'level') {
      const level = value.toLowerCase();
      return (LEVEL_VALUES as readonly string[]).includes(level)
        ? { add: { level } }
        : { error: `Level is one of ${LEVEL_VALUES.join(', ')}.` };
    }
    return ULID.test(value) ? { add: { invocationId: value } } : { error: 'An invocation ID is a 26-character ULID.' };
  }
  if (mode === 'events') return { add: { type: t } };
  // The read caps a search at 200 characters; a longer one would be refused there.
  return t.length <= 200 ? { add: { search: t } } : { error: 'A message search is at most 200 characters.' };
}
