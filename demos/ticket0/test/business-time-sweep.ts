import { expect } from 'vitest';
import { addBusinessMs, businessMsBetween, type BusinessSchedule } from '../src/business-time.js';
import { openInstants, SLOT } from './business-time-oracle.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

// A different week for every weekday: one closed, with windows touching midnight on
// both sides of the transitions. Identical days hid a skipped day counted differently
// depending on where the walk began (Codex round 6 on #2060).
const w = (open: string, close: string) => ({ open, close });
const VARIED: BusinessSchedule['weekly'] = {
  mon: [w('00:00', '00:45'), w('09:00', '12:00')],
  tue: [],
  wed: [w('01:30', '03:15'), w('23:45', '24:00')],
  thu: [w('22:45', '23:30'), w('23:30', '24:00')],
  fri: [w('09:00', '10:00')],
  sat: [w('00:15', '02:30'), w('23:00', '23:30')],
  sun: [w('01:00', '04:00'), w('23:45', '24:00')],
};
const localDate = (timezone: string, t: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

/** The varied week, with exceptions on the transition's own date(s) and the dates beside them. */
const aroundTransition = (timezone: string, at: number): BusinessSchedule => {
  const leaving = localDate(timezone, at - MINUTE);
  const arriving = localDate(timezone, at);
  const before = localDate(timezone, at - DAY);
  const after = localDate(timezone, at + DAY);
  const exceptions = new Map<string, { open: string; close: string }[]>([
    [before, [w('00:15', '01:00'), w('22:30', '23:45')]],
    [after, []],
    // A late-evening skipped hour (Nuuk) carries an opening past midnight.
    [leaving, [w('00:00', '01:15'), w('02:00', '03:00'), w('22:30', '22:45'), w('23:15', '23:45')]],
    [arriving, [w('00:00', '00:30'), w('01:45', '03:30'), w('23:00', '23:15')]],
  ]);
  return { timezone, weekly: VARIED, exceptions: [...exceptions].map(([date, windows]) => ({ date, windows })) };
};

/** The instants where the zone's offset changes in those years, found with a formatter of its own. */
function transitions(timezone: string, fromYear: number, toYear: number): number[] {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
  const offset = (t: number) => f.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')!.value;
  const found: number[] = [];
  for (let t = Date.UTC(fromYear, 0, 1, 12); t < Date.UTC(toYear + 1, 0, 1, 12); t += DAY) {
    if (offset(t) === offset(t + DAY)) continue;
    let [lo, hi] = [t, t + DAY];
    while (hi - lo > SLOT) {
      const mid = lo + Math.floor((hi - lo) / 2 / SLOT) * SLOT;
      if (offset(mid) === offset(lo)) lo = mid;
      else hi = mid;
    }
    found.push(hi);
  }
  return found;
}

export async function sweepTransitions(timezone: string, fromYear: number, toYear: number, fewest: number): Promise<void> {
  const nights = transitions(timezone, fromYear, toYear);
  expect(nights.length).toBeGreaterThanOrEqual(fewest);
  for (const at of nights) {
    // Yield between CPU-heavy transitions so Vitest's worker RPC remains responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const s = aroundTransition(timezone, at);
    const from = new Date(at - 2 * DAY).toISOString();
    const to = new Date(at + 2 * DAY).toISOString();
    const slots = openInstants(s, Date.parse(from), Date.parse(to));
    const total = businessMsBetween(s, from, to)!;
    expect(total).toBe(slots.length * SLOT);
    let previous = '';
    for (let k = 1; k <= slots.length; k++) {
      const due = addBusinessMs(s, from, k * SLOT)!;
      expect(due).toBe(new Date(slots[k - 1]! + SLOT).toISOString());
      expect(due > previous).toBe(true);
      expect(businessMsBetween(s, from, due)).toBe(k * SLOT);
      previous = due;
    }
    // Path independence: splitting a-to-c at b gives the same open time and dues.
    for (let t = Date.parse(from); t <= Date.parse(to); t += SLOT) {
      const b = new Date(t).toISOString();
      const ab = businessMsBetween(s, from, b)!;
      expect(ab + businessMsBetween(s, b, to)!).toBe(total);
      if ((t - Date.parse(from)) % (4 * SLOT) === 0) {
        for (const x of [SLOT, 5 * SLOT]) expect(addBusinessMs(s, b, x)).toBe(addBusinessMs(s, from, ab + x));
      }
    }
  }
}
