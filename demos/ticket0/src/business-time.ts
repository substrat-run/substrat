/**
 * Business time: how much of a stretch of real time a desk was open for, and when a span
 * of open time starting now runs out (#1648).
 *
 * Pure. No `ctx`, no clock and no I/O: every instant comes in as an argument, so the
 * module that owns the SLA decides what "now" is, and a test can stand anywhere.
 * Ticket0's own until a second vertical needs it; the day that happens it moves to
 * `@substrat-run/contracts` unchanged, because nothing here knows what a desk is.
 *
 * A schedule is weekly windows in LOCAL wall-clock time, in one IANA timezone, plus
 * dated exceptions that replace a day's windows (`[]` is a holiday). Wall-clock times are
 * turned into instants per local date through `Intl.DateTimeFormat`, which workerd and
 * node both carry with full zone data, so there is no timezone library to keep current.
 *
 * DST follows Temporal's `'compatible'` disambiguation, the one a person means:
 *
 *   - a wall-clock time that does not exist (the hour skipped in spring) resolves
 *     FORWARD, by the length of the gap — "open at 02:30" on that night opens at 03:30;
 *   - a wall-clock time that happens twice (the hour repeated in autumn) takes the
 *     EARLIER of the two instants.
 *
 * What is counted is REAL elapsed time inside the windows. A 01:00–04:00 window on the
 * autumn night is four hours long and on the spring night two, because a customer
 * waiting through it waited that long. The usual 09:00–17:00 never meets a transition.
 *
 * The walk is bounded, whatever the schedule says. Days are walked one at a time, exactly,
 * for the first `EXACT_DAYS` (ten years) and across every exception. Beyond that, a stretch
 * of whole weeks with no exception in it holds exactly one of each weekday, so it is
 * counted by the weekly sum in one step instead of being walked — `test/business-time.test.ts`
 * drives a one-minute-a-week desk to a year-long target this way. Inside such a jump the
 * count is the windows' WALL-CLOCK length, so a window that straddles a DST transition more
 * than ten years out is off by that hour. A due ten years away is not one anybody escalates
 * on, and every due that matters is inside the exact walk.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** One opening, `HH:MM` local, `close` may be `24:00`. `open < close`. */
export interface BusinessWindow {
  readonly open: string;
  readonly close: string;
}

export interface BusinessSchedule {
  readonly timezone: string;
  readonly weekly: Readonly<Partial<Record<Weekday, readonly BusinessWindow[]>>>;
  /** A dated day whose windows REPLACE the weekday's; `[]` is closed all day. */
  readonly exceptions?: readonly { readonly date: string; readonly windows: readonly BusinessWindow[] }[];
}

/** How many local days are walked one at a time before whole weeks may be counted at once. */
const EXACT_DAYS = 3660;

const DAY = 86_400_000;
const MINUTE = 60_000;

/** A wall-clock time as a window names one: `HH:MM`, 24-hour, `24:00` the end of the day. */
export const WALL_CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** `HH:MM` → minutes since local midnight. `24:00` is 1440. */
export function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** `YYYY-MM-DD` → a civil day number (days since 1970-01-01), or NaN when it is no date. */
export function dayNumberOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-30 into March; a date that does not survive the round trip
  // is not a date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return ms / DAY;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Whether this runtime knows `timezone` as an IANA zone. Builds (and keeps) its formatter. */
export function isTimeZone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** The local wall clock at instant `t`, as if it were UTC, in ms. */
function wallClock(timezone: string, t: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(t))) {
    if (p.type !== 'literal' && p.type !== 'era') parts[p.type] = Number(p.value);
  }
  const utc = new Date(0);
  utc.setUTCFullYear(parts.year!, parts.month! - 1, parts.day!);
  utc.setUTCHours(parts.hour!, parts.minute!, parts.second!, 0);
  return utc.getTime() + (((t % 1000) + 1000) % 1000);
}

/** The zone's offset from UTC at instant `t`, in ms (positive east of Greenwich). */
function offsetAt(timezone: string, t: number): number {
  return wallClock(timezone, t) - t;
}

/**
 * The instant a local wall-clock time names, with `'compatible'` disambiguation.
 *
 * The two candidate offsets are the ones a day either side; a zone changes offset at most
 * once in a day. Each candidate is kept only if it round-trips. Two survivors is the
 * repeated hour, and the earlier instant wins; none is the skipped hour, and the offset
 * from BEFORE the gap carries the time forward past it.
 */
export function instantOf(timezone: string, local: number): number {
  const before = offsetAt(timezone, local - DAY);
  const after = offsetAt(timezone, local + DAY);
  const valid = [before, after]
    .map((o) => local - o)
    .filter((t) => offsetAt(timezone, t) === local - t);
  if (valid.length > 0) return Math.min(...valid);
  return local - before;
}

/** The civil day number the zone is on at instant `t`. */
function localDay(timezone: string, t: number): number {
  return Math.floor(wallClock(timezone, t) / DAY);
}

/** A schedule, compiled once per call into the form the walk reads. */
interface Compiled {
  readonly timezone: string;
  /** Per weekday (0 = Sunday), windows as [openMinute, closeMinute). */
  readonly weekly: readonly (readonly (readonly [number, number])[])[];
  readonly exceptions: ReadonlyMap<number, readonly (readonly [number, number])[]>;
  /** Exception day numbers, ascending. */
  readonly exceptionDays: readonly number[];
  /** The week's open time by wall clock, in ms. Positive, or the schedule is refused. */
  readonly weekMs: number;
}

function compile(schedule: BusinessSchedule): Compiled | null {
  if (!isTimeZone(schedule.timezone)) return null;
  const windowsOf = (ws: readonly BusinessWindow[] | undefined) =>
    (ws ?? []).map((w) => [minutesOf(w.open), minutesOf(w.close)] as const);
  const weekly = WEEKDAYS.map((d) => windowsOf(schedule.weekly[d]));
  const weekMs = weekly.flat().reduce((sum, [o, c]) => sum + (c - o) * MINUTE, 0);
  if (!(weekMs > 0)) return null;
  const exceptions = new Map<number, readonly (readonly [number, number])[]>();
  for (const e of schedule.exceptions ?? []) {
    const dn = dayNumberOf(e.date);
    if (!Number.isNaN(dn)) exceptions.set(dn, windowsOf(e.windows));
  }
  return {
    timezone: schedule.timezone,
    weekly,
    exceptions,
    exceptionDays: [...exceptions.keys()].sort((a, b) => a - b),
    weekMs,
  };
}

/**
 * A local day's openings as instants, earliest first.
 *
 * `instantOf` per wall-clock time costs three or four zone lookups. On a day whose offset
 * is the same from the day before to the day after — every day but the two a year around
 * a transition — each candidate it would try IS that offset and round-trips, so its answer
 * is `local - offset`, and two lookups serve the whole day.
 */
function openings(c: Compiled, day: number): (readonly [number, number])[] {
  const windows = c.exceptions.get(day) ?? c.weekly[(((day + 4) % 7) + 7) % 7]!;
  if (windows.length === 0) return [];
  const steady = offsetAt(c.timezone, (day - 1) * DAY);
  const at =
    steady === offsetAt(c.timezone, (day + 2) * DAY)
      ? (minute: number) => day * DAY + minute * MINUTE - steady
      : (minute: number) => instantOf(c.timezone, day * DAY + minute * MINUTE);
  return windows.map(([o, cl]) => [at(o), at(cl)] as const);
}

/** The first exception on or after `day`, or Infinity. */
function nextException(c: Compiled, day: number): number {
  for (const d of c.exceptionDays) if (d >= day) return d;
  return Infinity;
}

/**
 * The open time from `start` onwards, in order, without end: each opening as `[from, to)`
 * (clipped to begin no earlier than `start`), or `{ weeks }` — open time counted a whole
 * stretch at once rather than walked.
 *
 * Whole weeks are counted only past the exact horizon, never across an exception, never
 * up to `limitDay(day)` (exclusive), and always one fewer than fits, so the last stretch is
 * walked. The consumer stops it.
 */
function* openTime(
  c: Compiled,
  start: number,
  limitDay: (day: number) => number,
): Generator<readonly [number, number] | { readonly weeks: number }> {
  for (let day = localDay(c.timezone, start), walked = 0; ; walked++, day++) {
    if (walked >= EXACT_DAYS) {
      const room = Math.min(nextException(c, day), limitDay(day)) - day;
      const skip = Math.floor(room / 7) - 1;
      if (skip > 0) {
        yield { weeks: skip * c.weekMs };
        day += skip * 7;
      }
    }
    for (const [open, close] of openings(c, day)) if (close > start) yield [Math.max(open, start), close];
  }
}

/**
 * The instant at which `ms` of open time, counted from `start`, has passed. `ms` of zero
 * is `start` itself, open or not. Null for a schedule this module refuses (an unknown
 * zone, or no open time in the week) — the caller's fallback, never a guess.
 */
export function addBusinessMs(schedule: BusinessSchedule, start: string, ms: number): string | null {
  const c = compile(schedule);
  if (c === null) return null;
  const from = Date.parse(start);
  let remaining = Math.max(0, ms);
  if (remaining === 0) return new Date(from).toISOString();
  // A jump never reaches past the week `remaining` runs out in, so it never overshoots.
  for (const piece of openTime(c, from, (day) => day + Math.ceil(remaining / c.weekMs) * 7)) {
    if ('weeks' in piece) {
      remaining -= piece.weeks;
      continue;
    }
    const [a, b] = piece;
    if (remaining <= b - a) return new Date(a + remaining).toISOString();
    remaining -= b - a;
  }
  throw new Error('unreachable: open time never ends');
}

/** How much open time lies in [from, to). Zero when `to` is not after `from`; null as above. */
export function businessMsBetween(schedule: BusinessSchedule, from: string, to: string): number | null {
  const c = compile(schedule);
  if (c === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!(end > start)) return 0;
  const lastDay = localDay(c.timezone, end);
  let total = 0;
  for (const piece of openTime(c, start, () => lastDay)) {
    if ('weeks' in piece) {
      total += piece.weeks;
      continue;
    }
    const [a, b] = piece;
    if (a >= end) break;
    total += Math.min(b, end) - a;
  }
  return total;
}

const label = (d: Weekday) => d[0]!.toUpperCase() + d.slice(1);
/** The order a week is read in: Monday first. */
const READING_ORDER: readonly Weekday[] = [...WEEKDAYS.slice(1), WEEKDAYS[0]];

/**
 * The schedule as one line a visitor reads: consecutive days with the same windows run
 * together, closed days are left out, and the zone closes it —
 * `Mon–Fri 09:00–17:00; Sat 10:00–14:00 (Europe/Stockholm)`.
 *
 * Exceptions are not in it. This is the standing week, shown beside a chat box; a list
 * of dates would be a calendar.
 */
export function describeSchedule(schedule: BusinessSchedule): string {
  const hours = (d: Weekday) =>
    (schedule.weekly[d] ?? []).map((w) => `${w.open}–${w.close}`).join(', ');
  const groups: { from: Weekday; to: Weekday; hours: string }[] = [];
  for (const d of READING_ORDER) {
    const h = hours(d);
    const last = groups[groups.length - 1];
    // `last` always ends on the day before `d`, closed days included, so equal hours on
    // either side of a different day never run together.
    if (last && last.hours === h) {
      last.to = d;
    } else {
      groups.push({ from: d, to: d, hours: h });
    }
  }
  const open = groups
    .filter((g) => g.hours !== '')
    .map((g) => `${g.from === g.to ? label(g.from) : `${label(g.from)}–${label(g.to)}`} ${g.hours}`);
  return `${open.join('; ')} (${schedule.timezone})`;
}
