/**
 * An independent oracle for `src/business-time.ts` (#1648, Codex round 1 on #2060).
 *
 * It shares nothing with the module under test: no offset arithmetic, no `instantOf`, no
 * day walk. It steps real time in fixed SLOTS and asks a formatter of its own what the
 * desk's wall clock reads at each one; a slot is open when that reading falls inside a
 * window of that local weekday (or of that date's exception). So whatever DST does — a
 * skipped hour, a repeated one, either hemisphere — the oracle sees it the way a person
 * watching the office clock would, and the module is right only if it agrees.
 *
 * Exact for schedules whose windows, and zones whose transitions, sit on slot boundaries:
 * every case here uses quarter-hour windows in zones that change on the hour.
 */
import type { BusinessSchedule } from '../src/business-time.js';

export const SLOT = 15 * 60_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

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

function isOpen(schedule: BusinessSchedule, read: ReturnType<typeof reader>, t: number): boolean {
  const { date, weekday, minute } = read(t);
  const windows =
    schedule.exceptions?.find((e) => e.date === date)?.windows ?? schedule.weekly[DAYS[weekday]!] ?? [];
  const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return windows.some((w) => minute >= m(w.open) && minute < m(w.close));
}

/** Open time in [from, to), slot by slot. `from` must sit on a slot boundary. */
export function oracleBetween(schedule: BusinessSchedule, from: string, to: string): number {
  const read = reader(schedule.timezone);
  let total = 0;
  for (let t = Date.parse(from); t < Date.parse(to); t += SLOT) if (isOpen(schedule, read, t)) total += SLOT;
  return total;
}

/**
 * When `ms` of open time from `start` has passed, or null if it has not by `until`. `start`
 * on a slot boundary and `ms` a whole number of slots, so the answer is a slot's END.
 */
export function oracleAdd(schedule: BusinessSchedule, start: string, ms: number, until: string): string | null {
  const read = reader(schedule.timezone);
  let remaining = ms;
  const end = Date.parse(until);
  for (let t = Date.parse(start); t < end; t += SLOT) {
    if (!isOpen(schedule, read, t)) continue;
    remaining -= SLOT;
    if (remaining <= 0) return new Date(t + SLOT).toISOString();
  }
  return null;
}
