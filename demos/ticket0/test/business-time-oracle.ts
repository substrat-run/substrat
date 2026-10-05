/**
 * An independent oracle for `src/business-time.ts` (#1648, Codex rounds 1–4 on #2060).
 *
 * It shares nothing with the module under test: no offset arithmetic, no `instantOf`, no
 * day walk, no local-day unit. It steps real time in fixed SLOTS across the whole range and
 * asks a formatter of its own what the desk's wall clock reads at each one, as an ABSOLUTE
 * wall minute (the local date's day number × 1440 + the minute), so a reading is
 * comparable across midnight. Every window of every local date is then placed on that one
 * stream by its own reading of the documented `'compatible'` rule:
 *
 *   - an endpoint the clock shows is the FIRST slot that shows it (the earlier instant of
 *     a repeated time);
 *   - an endpoint the clock never shows was skipped: it moves forward by the length of the
 *     jump that skipped it — wherever that jump is, the same day or across midnight — to
 *     the slot that shows `endpoint + jump`;
 *   - `24:00` is the next date's `00:00`, placed the same way;
 *   - a date no slot shows at all was skipped whole, and its windows are not placed: a
 *     day that never happened was not worked.
 *
 * A window's slots run from where it opens to where it closes, and the open slots are the
 * UNION over every window of every date, taken over the slots themselves, which are
 * instants: two windows that land on the same quarter-hour — on one day, or one from each
 * side of a midnight a jump crosses — count it once.
 *
 * Exact for schedules whose windows, and zones whose transitions, sit on slot boundaries:
 * every case here uses quarter-hour windows, in zones that change on a quarter-hour.
 */
import type { BusinessSchedule } from '../src/business-time.js';

export const SLOT = 15 * 60_000;
const SLOT_MINUTES = 15;
const DAY = 86_400_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function reader(timezone: string): (t: number) => number {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (t) => {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hour = Number(p.hour) % 24; // some engines print midnight as 24 under hour12: false
    return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY) * 1440 + hour * 60 + Number(p.minute);
  };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const dateOf = (dayNumber: number) => new Date(dayNumber * DAY).toISOString().slice(0, 10);

/** The open slots' instants in [from, to), ascending: the union over every window. */
export function openInstants(schedule: BusinessSchedule, from: number, to: number): number[] {
  const read = reader(schedule.timezone);
  // A margin of two days either side, so every window that can land in range is placed.
  const t0 = Math.floor(from / SLOT) * SLOT - 2 * DAY;
  const t1 = to + 2 * DAY;
  const instants: number[] = [];
  const walls: number[] = [];
  for (let t = t0; t < t1; t += SLOT) {
    instants.push(t);
    walls.push(read(t));
  }
  const firstShowing = new Map<number, number>();
  walls.forEach((w, i) => {
    if (!firstShowing.has(w)) firstShowing.set(w, i);
  });
  const jumps: { before: number; after: number }[] = [];
  for (let i = 1; i < walls.length; i++) {
    if (walls[i]! - walls[i - 1]! > SLOT_MINUTES) jumps.push({ before: walls[i - 1]!, after: walls[i]! });
  }
  const place = (wall: number): number | undefined => {
    const shown = firstShowing.get(wall);
    if (shown !== undefined) return shown;
    const jump = jumps.find((j) => j.before < wall && wall < j.after);
    if (!jump) return undefined; // outside the slots generated
    return firstShowing.get(wall + (jump.after - jump.before - SLOT_MINUTES));
  };

  const open = new Set<number>();
  // A date no slot shows was skipped whole (Samoa, 2011-12-30): it has no hours to open.
  const shownDates = new Set(walls.map((w) => Math.floor(w / 1440)));
  const firstDate = Math.floor(walls[0]! / 1440) + 1;
  const lastDate = Math.floor(walls[walls.length - 1]! / 1440) - 1;
  for (let date = firstDate; date <= lastDate; date++) {
    if (!shownDates.has(date)) continue;
    const iso = dateOf(date);
    const windows =
      schedule.exceptions?.find((e) => e.date === iso)?.windows ??
      schedule.weekly[DAYS[(((date + 4) % 7) + 7) % 7]!] ??
      [];
    for (const w of windows) {
      const a = place(date * 1440 + minutesOf(w.open));
      const b = place(date * 1440 + minutesOf(w.close));
      if (a === undefined || b === undefined) throw new Error(`oracle: cannot place ${iso} ${w.open}–${w.close}`);
      for (let i = a; i < b; i++) open.add(instants[i]!);
    }
  }
  return [...open].filter((t) => t >= from && t < to).sort((x, y) => x - y);
}

/** Open time in [from, to). Both on slot boundaries. */
export function oracleBetween(schedule: BusinessSchedule, from: string, to: string): number {
  return openInstants(schedule, Date.parse(from), Date.parse(to)).length * SLOT;
}

/**
 * When `ms` of open time from `start` has passed, or null if it has not by `until`. `start`
 * on a slot boundary and `ms` a whole number of slots, so the answer is a slot's END.
 */
export function oracleAdd(schedule: BusinessSchedule, start: string, ms: number, until: string): string | null {
  const slots = openInstants(schedule, Date.parse(start), Date.parse(until));
  const n = Math.ceil(ms / SLOT);
  return n >= 1 && n <= slots.length ? new Date(slots[n - 1]! + SLOT).toISOString() : null;
}
