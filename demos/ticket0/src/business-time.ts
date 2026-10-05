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
 * The walk is bounded, whatever the schedule says, and it never approximates: every day
 * it counts is walked, exactly, and it walks at most `EXACT_DAYS` local days (ten years).
 * Open time that is not reached inside that is not counted at all — `addBusinessMs` and
 * `businessMsBetween` return null, and the caller falls back to calendar time. So the
 * work is at most two zone lookups per open day of ten years, and every answer the module
 * does give is exact. A promise more than ten years of opening hours out is not one a
 * desk can make: `ticket0/configure-desk` refuses a business-clock target its hours cannot
 * reach inside the cap, so only an edge (a re-aim after the hours were made sparser) ever
 * meets the fallback.
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

/** The most local days a walk covers: ten years. Beyond it there is no answer, only null. */
export const EXACT_DAYS = 3660;

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
 * The two candidate offsets are the ones a day either side, which assumes a zone changes
 * offset at most once within any two days — true even of Samoa's day-long jump in 2011,
 * a single change. Each candidate is kept only if it round-trips. Two survivors is the
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
}

function compile(schedule: BusinessSchedule): Compiled | null {
  if (!isTimeZone(schedule.timezone)) return null;
  const windowsOf = (ws: readonly BusinessWindow[] | undefined) =>
    (ws ?? []).map((w) => [minutesOf(w.open), minutesOf(w.close)] as const);
  const weekly = WEEKDAYS.map((d) => windowsOf(schedule.weekly[d]));
  // A week with no open time has no business time in it, and nothing would ever fall due.
  if (!weekly.some((ws) => ws.length > 0)) return null;
  const exceptions = new Map<number, readonly (readonly [number, number])[]>();
  for (const e of schedule.exceptions ?? []) {
    const dn = dayNumberOf(e.date);
    if (!Number.isNaN(dn)) exceptions.set(dn, windowsOf(e.windows));
  }
  return {
    timezone: schedule.timezone,
    weekly,
    exceptions,
  };
}

/** The windows a local day keeps: its exception's, or its weekday's. */
function windowsOn(c: Compiled, day: number): readonly (readonly [number, number])[] {
  return c.exceptions.get(day) ?? c.weekly[(((day + 4) % 7) + 7) % 7]!;
}

/**
 * Minutes of one local day → instants, 'compatible'.
 *
 * `instantOf` per wall-clock time costs three or four zone lookups. On a day whose offset
 * is the same from the day before to the day after — every day but the few around a
 * transition — each candidate it would try IS that offset and round-trips, so its answer
 * is `local - offset`, and two lookups serve the whole day.
 */
function resolver(c: Compiled, day: number): ((minute: number) => number) | null {
  const steady = offsetAt(c.timezone, (day - 1) * DAY);
  if (steady === offsetAt(c.timezone, (day + 2) * DAY)) return (minute) => day * DAY + minute * MINUTE - steady;
  // A date the clock never shows has no openings at all (Codex round 6): Samoa skipped
  // 2011-12-30 whole, and nobody worked it. Its midnight would resolve a day forward, onto
  // a later date — which is how it is told apart from a partial gap, whose times resolve
  // forward within reach of the day they belong to and keep being counted.
  if (localDay(c.timezone, instantOf(c.timezone, day * DAY)) !== day) return null;
  return (minute) => instantOf(c.timezone, day * DAY + minute * MINUTE);
}

/**
 * A local day's openings as instants: a chronological union.
 *
 * Resolved one endpoint at a time, windows that are disjoint on the wall clock need not be
 * disjoint in real time on the spring night: 'compatible' carries an open inside the
 * skipped hour forward past the gap, which can take it beyond its own close just after
 * the gap (02:30–03:15: empty), or onto the next window (02:00–02:30 becomes 03:00–03:30,
 * over 03:00–03:15). So the day's openings are the UNION of the resolved intervals —
 * chronological, disjoint, none empty — and open time is never counted twice or below
 * zero. `openTime` carries the same union across midnight. What it can take away is step
 * 4 of `guaranteedBusinessMs`' proof.
 */
function openings(c: Compiled, day: number, at = resolver(c, day)): [number, number][] {
  if (at === null) return [];
  return union(windowsOn(c, day).map(([o, cl]) => [at(o), at(cl)] as const));
}

/** Intervals as a chronological union: sorted, disjoint, none empty. */
function union(intervals: readonly (readonly [number, number])[]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (b <= a) continue;
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/**
 * The open time from `start` onwards: ONE chronological stream of disjoint, non-empty
 * instant intervals, each clipped to begin no earlier than `start` and to end no later
 * than the cap — the local midnight that ends the walk's last day.
 *
 * The local day is not the unit of disjointness (Codex round 4 on #2060). A day's windows
 * are resolved on that day, but a skipped hour can carry them into the next: in Nuuk the
 * clocks go from 23:00 on Saturday to 00:00 on Sunday, so Saturday 23:00–23:30 resolves to
 * Sunday 00:00–00:30 and lies exactly over a Sunday window there. So the days' openings
 * are merged into one union, and two facts make a one-day lookahead enough for that:
 *
 *   - every opening of day `d` starts at or after `M_d`, that day's local midnight as an
 *     instant: 'compatible' resolution only moves a time FORWARD, and wall time after a
 *     skipped hour lands at or after the midnight it follows;
 *   - `M_d` never decreases with `d`. It need not increase: a local day can last no real
 *     time at all. Samoa skipped 2011-12-30 whole (`Pacific/Apia` went from UTC−10 to
 *     UTC+14), so that date's midnight and the next are one instant, and every time on it
 *     resolves a day forward, onto the 31st's — a skipped day contributes nothing the 31st
 *     does not, and its windows land in the union beside the 31st's.
 *
 * So before day `d` is merged in, everything already merged that ends by `M_d` can never
 * meet a later opening, and is final. Only what reaches past it is held back. (Holding one
 * that ends exactly at `M_d` a day longer would change nothing: it could only merge with
 * an opening that starts where it ends, and an adjacent pair counts the same as two.)
 *
 * The cap is an instant for the same reason: the walk never looks at the day after its
 * last, whose openings start at or after that day's midnight, so nothing before that
 * midnight is missing and nothing after it is known. A window of the last day that a
 * skipped hour carries past it is counted only up to it.
 */
function* openTime(c: Compiled, start: number): Generator<readonly [number, number]> {
  const first = localDay(c.timezone, start);
  const cap = instantOf(c.timezone, (first + EXACT_DAYS) * DAY);
  let held: [number, number][] = [];
  const release = function* (upTo: number) {
    while (held.length > 0 && held[0]![1] <= upTo) {
      const [a, b] = held.shift()!;
      if (b > start) yield [Math.max(a, start), b] as const;
    }
  };
  // From the day BEFORE the start's: a skipped hour at the end of that day can carry its
  // windows past midnight into the start's own day (Nuuk's Saturday 23:00–23:30 lands on
  // Sunday), and the stream must not depend on where it was entered — a walk from Sunday
  // 00:10 must count what a walk from Saturday counts after 00:10. A jump is at most a day,
  // and a date with no instants has no openings, so nothing reaches from further back.
  for (let day = first - 1; day < first + EXACT_DAYS; day++) {
    // A closed day adds nothing, and costs no lookup: everything held is final. It comes
    // from earlier days, whose wall times lie before this day's 00:00, and a jump moves a
    // time forward by at most a day (Samoa's 2011 jump was exactly one), so it ends by the
    // NEXT midnight, at or after which the next openings start.
    if (windowsOn(c, day).length === 0) {
      yield* release(Infinity);
      continue;
    }
    const at = resolver(c, day);
    if (at === null) continue; // a date the clock never shows: no openings; what is held waits for the next day
    yield* release(at(0));
    held = union([...held, ...openings(c, day, at)]);
  }
  held = held.filter(([a]) => a < cap).map(([a, b]) => [a, Math.min(b, cap)]);
  yield* release(Infinity);
}

/**
 * The instant at which `ms` of open time, counted from `start`, has passed. `ms` of zero
 * is `start` itself, open or not. Null when that is not inside the cap, or for a schedule
 * this module refuses (an unknown zone, or no open time in the week): the caller's
 * fallback, never a guess.
 */
export function addBusinessMs(schedule: BusinessSchedule, start: string, ms: number): string | null {
  const c = compile(schedule);
  if (c === null) return null;
  const from = Date.parse(start);
  let remaining = Math.max(0, ms);
  if (remaining === 0) return new Date(from).toISOString();
  for (const [a, b] of openTime(c, from)) {
    if (remaining <= b - a) return new Date(a + remaining).toISOString();
    remaining -= b - a;
  }
  return null;
}

/**
 * How much open time lies in [from, to). Zero when `to` is not after `from`. Null when `to`
 * is past the cap counted from `from` — later than the local midnight that ends the walk's
 * last day, which is itself allowed, being that day's `24:00` close and so an instant
 * `addBusinessMs` can answer — or for a refused schedule, as above.
 */
export function businessMsBetween(schedule: BusinessSchedule, from: string, to: string): number | null {
  const c = compile(schedule);
  if (c === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!(end > start)) return 0;
  if (end > instantOf(c.timezone, (localDay(c.timezone, start) + EXACT_DAYS) * DAY)) return null; // past the cap
  let total = 0;
  for (const [a, b] of openTime(c, start)) {
    if (a >= end) break;
    total += Math.min(b, end) - a;
  }
  return total;
}

/**
 * The most open time this schedule promises from ANY start, inside the cap (#1648, Codex
 * round 2 on #2060): a target no longer than this is reached by `addBusinessMs` from every
 * start whose ten years keep step 4's stated assumption — every start from now on — so it
 * is always counted exactly and never falls back to calendar time. Null for a schedule `compile` refuses.
 *
 * The proof, for a start on local day `d`:
 *
 *   1. The walk covers days `d … d + EXACT_DAYS - 1`. Every opening on days `d + 1 …` lies
 *      wholly after the start (it begins at or after that day's local midnight) and wholly
 *      inside the walk, so it is counted in full. The start's own day is ignored here,
 *      which only lowers the bound.
 *   2. Days `d + 1 … d + 7 × FULL_WEEKS` (`FULL_WEEKS = ⌊(EXACT_DAYS - 1) / 7⌋ = 522`) are
 *      522 runs of seven consecutive days, so each weekday appears exactly 522 times. With
 *      no exception and no clock change, their wall-clock open time is `522 × week`.
 *   3. An exception replaces one dated day. Wherever it falls, it can take away at most
 *      `max(0, that weekday's open time − the exception's)` — its weekday is fixed by its
 *      date — so all of them together take at most the sum of that over the list.
 *   4. A clock change takes open time only where it moves the clock FORWARD by a jump `G`
 *      at wall time `J`. Read wall time as one line across midnight (date × 1440 + minute)
 *      and real time as the stream `openTime` merges across midnight too. A backward jump
 *      takes nothing: with the earlier instant for a repeated time, wall maps to real time
 *      in order, so openings stay disjoint and a window across the fold only grows.
 *      Forward: wall time before `J` keeps its instants, and wall time from `J + 2G` on
 *      keeps its lengths and lands at or after `J + G` in real time, clear of everything
 *      earlier — so every opening outside wall `[J, J + 2G)` keeps its length and its place
 *      in the union, and all the open time the jump can take, whether by shortening a
 *      window, emptying one, folding one onto the next, or carrying one past midnight onto
 *      the next day's (Nuuk, whose clocks go from 23:00 to 00:00), is wall time inside that
 *      range: at most `2G`, and never more than the open time of the at most two local days
 *      the range touches. A jump on the start's own day can fold its windows onto day
 *      `d + 1`'s, so it is one of those counted. Here the code cannot measure, since no
 *      sampling of `Intl` proves a stretch free of transitions, so the bound rests on a
 *      stated assumption about the zone: it moves its clocks forward at most
 *      `FORWARD_JUMPS_PER_YEAR` times a year, by at most `FORWARD_JUMP_MAX` each time, over the
 *      ten years a walk covers. True of every zone's rules today (Morocco's Ramadan
 *      suspension is the busiest, at two forward and two back), and so of every walk that
 *      starts now or later, which every conversation does. It is NOT true of every date the
 *      type accepts: the dateline moves jumped a whole day forward (`Pacific/Kwajalein`
 *      1993, `Pacific/Kiritimati` 1994-12-31, `Pacific/Apia` 2011-12-30). A walk across one
 *      of those is still exact; it is only this guarantee that does not cover it. Days `d … d + 7 × 522` lie inside eleven
 *      calendar years, so at most `11 × 2` forward jumps, each costing at most
 *      `min(2 × FORWARD_JUMP_MAX, 2 × the longest day's open time)`.
 *   5. The walk is clipped at the midnight that ends its last day, `d + EXACT_DAYS - 1`, which
 *      lies after every day counted above, so the clip takes nothing from them.
 *
 * So `522 × week − exceptions − 22 × min(4 h, 2 × the longest day's open time)` of open time is counted
 * from every start, whatever weekday it falls on and whichever exceptions its ten years
 * contain. Wall-clock arithmetic only: no walk, no clock, the same answer on any day.
 */
export function guaranteedBusinessMs(schedule: BusinessSchedule): number | null {
  const c = compile(schedule);
  if (c === null) return null;
  const wall = (ws: readonly (readonly [number, number])[]) => ws.reduce((sum, [o, cl]) => sum + (cl - o) * MINUTE, 0);
  const week = c.weekly.reduce((sum, ws) => sum + wall(ws), 0);
  let exceptions = 0;
  for (const [day, ws] of c.exceptions) {
    exceptions += Math.max(0, wall(c.weekly[(((day + 4) % 7) + 7) % 7]!) - wall(ws));
  }
  const longestDay = Math.max(...[...c.weekly, ...c.exceptions.values()].map(wall));
  const jumps = FORWARD_JUMP_YEARS * FORWARD_JUMPS_PER_YEAR * Math.min(2 * FORWARD_JUMP_MAX, 2 * longestDay);
  return Math.max(0, FULL_WEEKS * week - exceptions - jumps);
}

/** Complete weeks every walk counts in full after its start's own day: ⌊3659 / 7⌋. */
const FULL_WEEKS = Math.floor((EXACT_DAYS - 1) / 7);
/** Calendar years 522 weeks can touch. */
const FORWARD_JUMP_YEARS = 11;
/** The stated assumption about a zone, in `guaranteedBusinessMs`' proof. */
const FORWARD_JUMPS_PER_YEAR = 2;
const FORWARD_JUMP_MAX = 2 * 60 * MINUTE;

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
