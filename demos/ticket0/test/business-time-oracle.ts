/**
 * An independent oracle for `src/business-time.ts` (#1648, Codex rounds 1 and 2 on #2060).
 *
 * It shares nothing with the module under test: no offset arithmetic, no `instantOf`, no
 * day walk. It steps real time in fixed SLOTS, asks a formatter of its own what the desk's
 * wall clock reads at each one, and groups the slots by the local date they fall on. A
 * window is then placed on that day's own list of slots, by its own reading of the
 * documented `'compatible'` rule for an endpoint the clock does not show exactly once:
 *
 *   - an endpoint inside a REPEATED hour is the FIRST slot that shows it;
 *   - an endpoint inside a SKIPPED hour is moved forward by the length of the skip: the
 *     slot that shows `endpoint + gap`, where the gap is how far the clock jumped;
 *   - `24:00` is the end of the day's last slot.
 *
 * A slot is open when it lies between where the window opens and where it closes. So a
 * window that closes inside the repeated hour counts the first pass of that hour up to the
 * close and none of the second pass, and one that opens inside the skipped hour starts
 * after it — which is what the module must agree with.
 *
 * Exact for schedules whose windows, and zones whose transitions, sit on slot boundaries:
 * every case here uses quarter-hour windows in zones that change on the hour.
 */
import type { BusinessSchedule, BusinessWindow } from '../src/business-time.js';

export const SLOT = 15 * 60_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface Slot {
  readonly t: number;
  readonly minute: number;
}
interface LocalDay {
  readonly date: string;
  readonly weekday: number;
  readonly slots: Slot[];
}

function reader(timezone: string): (t: number) => { date: string; weekday: number; minute: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (t) => {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hour = Number(p.hour) % 24; // some engines print midnight as 24 under hour12: false
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: weekdays[p.weekday!]!, minute: hour * 60 + Number(p.minute) };
  };
}

/** Whole local days, in order, from the one `from` falls on until the one `to` falls on. */
function* localDays(timezone: string, from: number, to: number): Generator<LocalDay> {
  const read = reader(timezone);
  // Back far enough that the first day is whole: no zone is more than a day from UTC.
  let t = Math.floor(from / SLOT) * SLOT - 2 * 86_400_000;
  const startDate = read(from).date;
  let day: LocalDay | null = null;
  for (; ; t += SLOT) {
    const r = read(t);
    if (r.date < startDate) continue;
    if (day && r.date !== day.date) {
      yield day;
      if (t > to) return;
    }
    if (!day || r.date !== day.date) day = { date: r.date, weekday: r.weekday, slots: [] };
    day.slots.push({ t, minute: r.minute });
  }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Where an endpoint lands on this day's slots, as an index into them ('compatible'). */
function place(day: LocalDay, endpoint: number): number {
  if (endpoint === 24 * 60) return day.slots.length;
  const first = day.slots.findIndex((s) => s.minute === endpoint);
  if (first !== -1) return first; // shown once, or the first of two showings
  // Not shown: skipped. Find the jump that skips it, and move forward by its length.
  for (let i = 1; i < day.slots.length; i++) {
    const before = day.slots[i - 1]!.minute;
    const after = day.slots[i]!.minute;
    if (before < endpoint && endpoint < after) {
      const gap = after - before - SLOT / 60_000;
      const moved = day.slots.findIndex((s) => s.minute === endpoint + gap);
      return moved === -1 ? i : moved;
    }
  }
  return day.slots.findIndex((s) => s.minute > endpoint);
}

/**
 * The day's open slots: each window's slots, as placed above, and a slot open under two
 * windows counted ONCE — the union is taken over the slots themselves, which are instants,
 * so two windows the spring night folds onto each other cannot count the same quarter-hour
 * twice. Returned in time order.
 */
function openSlots(schedule: BusinessSchedule, day: LocalDay): Slot[] {
  const windows: readonly BusinessWindow[] =
    schedule.exceptions?.find((e) => e.date === day.date)?.windows ?? schedule.weekly[DAYS[day.weekday]!] ?? [];
  const open = new Map<number, Slot>();
  for (const w of windows) {
    for (const s of day.slots.slice(place(day, minutes(w.open)), place(day, minutes(w.close)))) open.set(s.t, s);
  }
  return [...open.values()].sort((a, b) => a.t - b.t);
}

/** Open time in [from, to), slot by slot. Both on slot boundaries. */
export function oracleBetween(schedule: BusinessSchedule, from: string, to: string): number {
  const [a, b] = [Date.parse(from), Date.parse(to)];
  let total = 0;
  for (const day of localDays(schedule.timezone, a, b)) {
    for (const s of openSlots(schedule, day)) if (s.t >= a && s.t < b) total += SLOT;
  }
  return total;
}

/**
 * When `ms` of open time from `start` has passed, or null if it has not by `until`. `start`
 * on a slot boundary and `ms` a whole number of slots, so the answer is a slot's END.
 */
export function oracleAdd(schedule: BusinessSchedule, start: string, ms: number, until: string): string | null {
  const [a, end] = [Date.parse(start), Date.parse(until)];
  let remaining = ms;
  for (const day of localDays(schedule.timezone, a, end)) {
    for (const s of openSlots(schedule, day)) {
      if (s.t < a || s.t >= end) continue;
      remaining -= SLOT;
      if (remaining <= 0) return new Date(s.t + SLOT).toISOString();
    }
  }
  return null;
}
