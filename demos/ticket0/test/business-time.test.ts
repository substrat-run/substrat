/**
 * Business time (#1648): the pure arithmetic under ticket0's business-hours service levels.
 *
 * Every case is an instant on either side of a closed stretch — a night, a weekend, a DST
 * transition, a holiday — because the only way a "4 business hours" promise goes wrong is
 * by counting time the desk was shut, or failing to count time it was open.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addBusinessMs,
  businessMsBetween,
  dayNumberOf,
  describeSchedule,
  EXACT_DAYS,
  guaranteedBusinessMs,
  instantOf,
  type BusinessSchedule,
} from '../src/business-time.js';
import { openInstants, oracleAdd, oracleBetween, SLOT } from './business-time-oracle.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const nineToFive = [{ open: '09:00', close: '17:00' }];
const weekdays = (timezone: string, extra: Partial<BusinessSchedule> = {}): BusinessSchedule => ({
  timezone,
  weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive },
  ...extra,
});
const UTC = weekdays('UTC');

describe('nights and weekends', () => {
  it('a Friday-afternoon message due in four hours falls due on Monday morning', () => {
    // 2026-10-02 is a Friday.
    expect(addBusinessMs(UTC, '2026-10-02T16:00:00.000Z', 4 * HOUR)).toBe('2026-10-05T12:00:00.000Z');
  });

  it('a night is skipped, and only the night', () => {
    expect(addBusinessMs(UTC, '2026-10-06T16:00:00.000Z', 2 * HOUR)).toBe('2026-10-07T10:00:00.000Z');
  });

  it('a message before opening starts its clock at opening', () => {
    expect(addBusinessMs(UTC, '2026-10-05T07:00:00.000Z', HOUR)).toBe('2026-10-05T10:00:00.000Z');
  });

  it('a target that ends exactly at closing is due at closing, not the next morning', () => {
    expect(addBusinessMs(UTC, '2026-10-05T13:00:00.000Z', 4 * HOUR)).toBe('2026-10-05T17:00:00.000Z');
  });

  it('a weekend message waits for Monday', () => {
    expect(addBusinessMs(UTC, '2026-10-03T11:00:00.000Z', 30 * MINUTE)).toBe('2026-10-05T09:30:00.000Z');
  });

  it('zero is the start itself, open or shut', () => {
    expect(addBusinessMs(UTC, '2026-10-03T11:00:00.000Z', 0)).toBe('2026-10-03T11:00:00.000Z');
  });

  it('counts only open time between two instants', () => {
    // Fri 16:00 → Mon 10:00: one hour Friday, one hour Monday.
    expect(businessMsBetween(UTC, '2026-10-02T16:00:00.000Z', '2026-10-05T10:00:00.000Z')).toBe(2 * HOUR);
    expect(businessMsBetween(UTC, '2026-10-05T10:00:00.000Z', '2026-10-02T16:00:00.000Z')).toBe(0);
  });

  it('a window may close at 24:00, and a desk open round the clock is calendar time', () => {
    const always: BusinessSchedule = {
      timezone: 'UTC',
      weekly: Object.fromEntries(
        ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ open: '00:00', close: '24:00' }]]),
      ),
    };
    expect(addBusinessMs(always, '2026-10-02T16:00:00.000Z', 50 * HOUR)).toBe('2026-10-04T18:00:00.000Z');
  });

  it('several windows a day: a lunch break is not counted', () => {
    const split: BusinessSchedule = {
      timezone: 'UTC',
      weekly: { mon: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '17:00' }] },
    };
    expect(addBusinessMs(split, '2026-10-05T11:00:00.000Z', 2 * HOUR)).toBe('2026-10-05T14:00:00.000Z');
  });
});

describe('timezones and DST', () => {
  const sthlm = weekdays('Europe/Stockholm');

  it('windows are local wall-clock time', () => {
    // 09:00 in Stockholm in October (CEST) is 07:00Z.
    expect(addBusinessMs(sthlm, '2026-10-05T05:00:00.000Z', HOUR)).toBe('2026-10-05T08:00:00.000Z');
  });

  it('a weekend spanning the spring transition: Friday CET, Monday CEST', () => {
    // Clocks go forward on Sunday 2026-03-29. Fri 16:00 CET = 15:00Z; Mon 10:00 CEST = 08:00Z.
    expect(addBusinessMs(sthlm, '2026-03-27T15:00:00.000Z', 2 * HOUR)).toBe('2026-03-30T08:00:00.000Z');
    expect(businessMsBetween(sthlm, '2026-03-27T15:00:00.000Z', '2026-03-30T08:00:00.000Z')).toBe(2 * HOUR);
  });

  it('a weekend spanning the autumn transition: Friday CEST, Monday CET', () => {
    // Clocks go back on Sunday 2026-10-25. Fri 16:00 CEST = 14:00Z; Mon 10:00 CET = 09:00Z.
    expect(addBusinessMs(sthlm, '2026-10-23T14:00:00.000Z', 2 * HOUR)).toBe('2026-10-26T09:00:00.000Z');
  });

  const night: BusinessSchedule = { timezone: 'Europe/Stockholm', weekly: { sun: [{ open: '01:00', close: '04:00' }] } };

  it('a window across the skipped hour is that much shorter: real time is counted', () => {
    // 01:00 CET = 00:00Z, 04:00 CEST = 02:00Z on 2026-03-29.
    expect(businessMsBetween(night, '2026-03-28T00:00:00.000Z', '2026-03-30T00:00:00.000Z')).toBe(2 * HOUR);
  });

  it('a window across the repeated hour is that much longer', () => {
    // 01:00 CEST = 23:00Z the day before, 04:00 CET = 03:00Z on 2026-10-25.
    expect(businessMsBetween(night, '2026-10-24T00:00:00.000Z', '2026-10-26T00:00:00.000Z')).toBe(4 * HOUR);
  });

  it("a wall-clock time inside the gap resolves forward ('compatible')", () => {
    const local = Date.UTC(2026, 2, 29, 2, 30);
    // 02:30 does not exist; it becomes 03:30 CEST = 01:30Z.
    expect(new Date(instantOf('Europe/Stockholm', local)).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it("a repeated wall-clock time takes the earlier instant ('compatible')", () => {
    const local = Date.UTC(2026, 9, 25, 2, 30);
    // 02:30 happens at 00:30Z (CEST) and again at 01:30Z (CET).
    expect(new Date(instantOf('Europe/Stockholm', local)).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('a zone west of UTC rolls the local date correctly', () => {
    const ny = weekdays('America/New_York');
    // Fri 2026-10-02 16:00 EDT = 20:00Z; two hours → Mon 10:00 EDT = 14:00Z.
    expect(addBusinessMs(ny, '2026-10-02T20:00:00.000Z', 2 * HOUR)).toBe('2026-10-05T14:00:00.000Z');
  });
});

describe('holidays and special days', () => {
  const xmas = weekdays('UTC', {
    exceptions: [
      { date: '2026-12-24', windows: [] },
      { date: '2026-12-25', windows: [] },
    ],
  });

  it('a closed exception is skipped like a weekend', () => {
    // Wed 23 Dec 16:00 + 2h: 1h Wed, then Thu/Fri closed, weekend, Mon 28 Dec 10:00.
    expect(addBusinessMs(xmas, '2026-12-23T16:00:00.000Z', 2 * HOUR)).toBe('2026-12-28T10:00:00.000Z');
    expect(addBusinessMs(UTC, '2026-12-23T16:00:00.000Z', 2 * HOUR)).toBe('2026-12-24T10:00:00.000Z');
  });

  it('an exception with windows replaces the day, it does not add to it', () => {
    const halfDay = weekdays('UTC', { exceptions: [{ date: '2026-12-24', windows: [{ open: '09:00', close: '12:00' }] }] });
    expect(addBusinessMs(halfDay, '2026-12-24T11:00:00.000Z', 2 * HOUR)).toBe('2026-12-25T10:00:00.000Z');
  });

  it('an exception may open a day the week leaves shut', () => {
    const saturday = weekdays('UTC', { exceptions: [{ date: '2026-10-03', windows: [{ open: '10:00', close: '12:00' }] }] });
    expect(addBusinessMs(saturday, '2026-10-02T16:30:00.000Z', HOUR)).toBe('2026-10-03T10:30:00.000Z');
  });
});

describe('round trip', () => {
  it('the open time between a start and its due is the target', () => {
    const s = weekdays('Europe/Stockholm', { exceptions: [{ date: '2026-10-07', windows: [] }] });
    for (const start of ['2026-10-02T16:00:00.000Z', '2026-10-03T11:00:00.000Z', '2026-10-06T08:15:00.000Z']) {
      for (const ms of [MINUTE, 4 * HOUR, 8 * HOUR, 37 * HOUR + 13 * MINUTE]) {
        const due = addBusinessMs(s, start, ms)!;
        expect(businessMsBetween(s, start, due)).toBe(ms);
      }
    }
  });
});

describe('bounds: an exact walk of at most ten years, and null beyond it', () => {
  // One minute a week, Mondays at noon UTC, from a TUESDAY: the walk covers local days
  // 0 … EXACT_DAYS - 1, whose last Monday is day 3653 (the 522nd), and day EXACT_DAYS — the
  // first day past the cap — is a Monday, so a cap one day too long would answer.
  const sparse: BusinessSchedule = { timezone: 'UTC', weekly: { mon: [{ open: '12:00', close: '12:01' }] } };
  const start = '2026-01-06T00:00:00.000Z';
  const lastMonday = 3653;

  it('the last minute inside the cap is answered exactly; one minute more is null', () => {
    expect((EXACT_DAYS + 1) % 7).toBe(0); // day EXACT_DAYS is a Monday, from a Tuesday
    expect(addBusinessMs(sparse, start, 522 * MINUTE)).toBe(
      new Date(Date.UTC(2026, 0, 6, 12, 1) + lastMonday * DAY).toISOString(),
    );
    expect(addBusinessMs(sparse, start, 523 * MINUTE)).toBeNull();
  });

  it('between: a span ending on the last day inside the cap is counted; one ending a day later is null', () => {
    const lastDay = new Date(Date.parse(start) + (EXACT_DAYS - 1) * DAY + 23 * 3_600_000).toISOString();
    const pastIt = new Date(Date.parse(start) + EXACT_DAYS * DAY + 13 * 3_600_000).toISOString();
    expect(businessMsBetween(sparse, start, lastDay)).toBe(522 * MINUTE);
    expect(businessMsBetween(sparse, start, pastIt)).toBeNull();
  });

  it("between: the cap's own 24:00 close is inside it; a millisecond later is not (Codex round 2)", () => {
    // Sundays round the clock, from a Tuesday: the walk's last day, 3659, is a Sunday whose
    // 24:00 close is the first instant of the day past the cap.
    const sundays: BusinessSchedule = { timezone: 'UTC', weekly: { sun: [{ open: '00:00', close: '24:00' }] } };
    const due = addBusinessMs(sundays, start, 523 * DAY)!;
    expect(due).toBe(new Date(Date.parse(start) + EXACT_DAYS * DAY).toISOString());
    expect(businessMsBetween(sundays, start, due)).toBe(523 * DAY);
    expect(businessMsBetween(sundays, start, new Date(Date.parse(due) + 1).toISOString())).toBeNull();
    // The same boundary in a zone with DST: the round trip holds where midnight is local.
    const sthlm = { ...sundays, timezone: 'Europe/Stockholm' };
    const local = addBusinessMs(sthlm, start, 522 * DAY);
    expect(local).not.toBeNull();
    expect(businessMsBetween(sthlm, start, local!)).toBe(522 * DAY);
  });

  it('a year-long target on a one-minute week is null, after a bounded number of zone lookups', () => {
    // Ten years of local days: 523 open Mondays at two lookups each, plus the start's.
    const lookups = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    expect(addBusinessMs(sparse, start, 525_600 * MINUTE)).toBeNull();
    expect(lookups.mock.calls.length).toBeLessThan(1_200);
    lookups.mockRestore();
  });

  it('a desk open every hour of every day does no more than two lookups per day of the cap', () => {
    const always: BusinessSchedule = {
      timezone: 'Europe/Stockholm',
      weekly: Object.fromEntries(
        ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ open: '00:00', close: '24:00' }]]),
      ),
    };
    const lookups = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    expect(addBusinessMs(always, start, 525_600 * MINUTE * 11)).toBeNull();
    // Two per steady day. A transition puts three days on the slow path (each day's check
    // spans the day before to the day after), a few more lookups for each time resolved
    // there, its midnight included: twenty transitions.
    expect(lookups.mock.calls.length).toBeLessThan(2 * EXACT_DAYS + 1_000);
    lookups.mockRestore();
  });

  it('a schedule with no open time, or an unknown zone, is refused rather than walked', () => {
    expect(addBusinessMs({ timezone: 'UTC', weekly: {} }, start, HOUR)).toBeNull();
    expect(addBusinessMs({ timezone: 'UTC', weekly: { mon: [] } }, start, HOUR)).toBeNull();
    expect(addBusinessMs({ timezone: 'Mars/Olympus', weekly: { mon: nineToFive } }, start, HOUR)).toBeNull();
    expect(businessMsBetween({ timezone: 'UTC', weekly: {} }, start, '2026-02-01T00:00:00.000Z')).toBeNull();
  });
});

describe('the open time guaranteed from every start (Codex round 2 on #2060)', () => {
  const tuesdays: BusinessSchedule = { timezone: 'UTC', weekly: { tue: [{ open: '12:00', close: '12:01' }] } };

  it('is 522 weeks of the week, less what exceptions can take and 22 forward jumps', () => {
    // Each jump costs min(twice the jump, twice the longest day): 2 minutes here, 4 h below.
    expect(guaranteedBusinessMs(tuesdays)).toBe((522 - 44) * MINUTE);
    expect(guaranteedBusinessMs(UTC)).toBe(522 * 40 * HOUR - 22 * 4 * HOUR);
    const withExceptions = weekdays('UTC', {
      exceptions: [
        { date: '2027-01-06', windows: [] }, // a Wednesday closed: −8 h
        { date: '2027-01-07', windows: [{ open: '09:00', close: '12:00' }] }, // a half Thursday: −5 h
        { date: '2027-01-09', windows: [{ open: '10:00', close: '14:00' }] }, // a Saturday opened: nothing
      ],
    });
    expect(guaranteedBusinessMs(withExceptions)).toBe(522 * 40 * HOUR - 13 * HOUR - 22 * 4 * HOUR);
    // Four short windows a day: a jump can fold up to its double, more than any one window.
    const quarters: BusinessSchedule = {
      timezone: 'UTC',
      weekly: { sun: ['01:00', '02:00', '03:00', '04:00'].map((o) => ({ open: o, close: `${o.slice(0, 2)}:30` })) },
    };
    expect(guaranteedBusinessMs(quarters)).toBe(522 * 2 * HOUR - 22 * 4 * HOUR);
    expect(guaranteedBusinessMs({ timezone: 'UTC', weekly: {} })).toBeNull();
  });

  it('is reached exactly from a start on every weekday, with the exceptions ahead of it', () => {
    const closing = {
      ...tuesdays,
      exceptions: Array.from({ length: 30 }, (_, i) => ({
        date: new Date(Date.UTC(2027, 0, 5) + i * 7 * DAY).toISOString().slice(0, 10), // 30 Tuesdays closed
        windows: [],
      })),
    };
    for (const schedule of [tuesdays, closing]) {
      const guaranteed = guaranteedBusinessMs(schedule)!;
      for (let k = 0; k < 7; k++) {
        const start = new Date(Date.UTC(2026, 9, 5) + k * DAY + 13 * HOUR).toISOString();
        expect(addBusinessMs(schedule, start, guaranteed)).not.toBeNull();
      }
    }
  });

  it("Codex's case: one minute more than the old check allowed from a Monday is null from a Wednesday", () => {
    // 523 minutes fits from Monday 2026-10-05 (the walk meets 523 Tuesdays), not from the
    // Wednesday after (it meets 522). The guarantee is below both.
    expect(addBusinessMs(tuesdays, '2026-10-05T00:00:00.000Z', 523 * MINUTE)).not.toBeNull();
    expect(addBusinessMs(tuesdays, '2026-10-07T00:00:00.000Z', 523 * MINUTE)).toBeNull();
    expect(guaranteedBusinessMs(tuesdays)!).toBeLessThan(523 * MINUTE);
  });
});

/**
 * The module against an oracle that shares none of its arithmetic (`business-time-oracle.ts`
 * steps real time a quarter-hour at a time and reads the wall clock). Windows straddle the
 * skipped hour and the repeated hour in both hemispheres, on the nights each zone changes:
 * Stockholm and New York (spring forward in March, back in October/November) and Sydney
 * (forward in October, back in April). Codex's round-1 case on #2060 is the last block.
 */
describe('agrees with an independent wall-clock walk, across DST in both hemispheres', () => {
  // Transition-night exceptions whose endpoints fall INSIDE the skipped or repeated hour,
  // in each zone's own nights, so the endpoint rule is exercised on both sides.
  const NIGHTS: Record<string, { date: string; windows: { open: string; close: string }[] }[]> = {
    'Europe/Stockholm': [
      { date: '2026-10-25', windows: [{ open: '01:00', close: '02:30' }] }, // close in the fold
      { date: '2027-03-28', windows: [{ open: '02:30', close: '03:45' }] }, // open in the gap
      // Open in the gap, carried past a close just after it: empty, never negative (CodeRabbit).
      { date: '2028-03-26', windows: [{ open: '02:30', close: '03:15' }, { open: '05:00', close: '05:30' }] },
    ],
    'America/New_York': [
      { date: '2026-11-01', windows: [{ open: '01:15', close: '01:45' }] }, // both in the fold
      { date: '2027-03-14', windows: [{ open: '02:15', close: '03:30' }] }, // open in the gap
    ],
    'Australia/Sydney': [
      { date: '2026-04-05', windows: [{ open: '02:30', close: '05:00' }] }, // open in the fold
      { date: '2026-10-04', windows: [{ open: '01:00', close: '02:45' }] }, // close in the gap
    ],
  };
  const across = (timezone: string): BusinessSchedule => ({
    timezone,
    weekly: { sun: [{ open: '01:00', close: '04:00' }], wed: [{ open: '09:00', close: '17:30' }] },
    exceptions: NIGHTS[timezone],
  });
  const from = '2026-01-01T00:00:00.000Z';
  // The oracle reads the wall clock some 35 000 times per year it covers: slow on purpose.
  const ORACLE_MS = 120_000;

  for (const timezone of ['Europe/Stockholm', 'America/New_York', 'Australia/Sydney']) {
    const s = across(timezone);
    it(`${timezone}: due instants over three years`, () => {
      for (const hours of [3, 50.25, 400, 1234.5]) {
        const ms = hours * HOUR;
        expect(addBusinessMs(s, from, ms)).toBe(oracleAdd(s, from, ms, '2030-01-01T00:00:00.000Z'));
      }
    }, ORACLE_MS);

    it(`${timezone}: open time between instants, each year's transitions inside`, () => {
      for (const [a, b] of [
        ['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
        ['2026-03-27T06:15:00.000Z', '2026-11-05T13:45:00.000Z'],
        ['2027-03-26T00:00:00.000Z', '2027-04-10T00:00:00.000Z'],
        ['2026-09-30T00:00:00.000Z', '2028-04-15T00:00:00.000Z'],
      ] as const) {
        expect(businessMsBetween(s, a, b)).toBe(oracleBetween(s, a, b));
      }
    }, ORACLE_MS);
  }

  describe("an endpoint inside the repeated or the skipped hour ('compatible', Codex round 2)", () => {
    // Each night's open time, worked out by hand from the zone's offsets — a third opinion
    // beside the module and the oracle, so neither can drift into agreeing with the other.
    const cases: [string, string, string, string, number][] = [
      // zone, the night's date, from, to (spanning the night), minutes
      ['Europe/Stockholm', '2026-10-25', '2026-10-24T12:00:00.000Z', '2026-10-25T12:00:00.000Z', 90],
      ['Europe/Stockholm', '2027-03-28', '2027-03-27T12:00:00.000Z', '2027-03-28T12:00:00.000Z', 15],
      ['Europe/Stockholm', '2028-03-26', '2028-03-25T12:00:00.000Z', '2028-03-26T12:00:00.000Z', 30],
      ['America/New_York', '2026-11-01', '2026-11-01T00:00:00.000Z', '2026-11-01T12:00:00.000Z', 30],
      ['America/New_York', '2027-03-14', '2027-03-14T00:00:00.000Z', '2027-03-14T12:00:00.000Z', 15],
      ['Australia/Sydney', '2026-04-05', '2026-04-04T10:00:00.000Z', '2026-04-05T10:00:00.000Z', 210],
      ['Australia/Sydney', '2026-10-04', '2026-10-03T10:00:00.000Z', '2026-10-04T10:00:00.000Z', 105],
    ];
    for (const [timezone, night, a, b, minutes] of cases) {
      it(`${timezone} on ${night}: ${minutes} minutes, by hand, by the module and by the oracle`, () => {
        const s: BusinessSchedule = { timezone, weekly: {}, exceptions: NIGHTS[timezone] };
        // `weekly: {}` alone is refused; one far-off weekday window keeps the schedule valid
        // and outside every span here.
        const valid = { ...s, weekly: { thu: [{ open: '12:00', close: '12:15' }] } };
        expect(businessMsBetween(valid, a, b)).toBe(minutes * MINUTE);
        expect(oracleBetween(valid, a, b)).toBe(minutes * MINUTE);
      });
    }
  });

  describe('windows the spring night folds onto each other are a union (Codex round 3)', () => {
    // 02:00–02:30 lies in the skipped hour and moves to 03:00–03:30 real, over 03:00–03:15.
    const fold = (date: string) => [{ date, windows: [{ open: '02:00', close: '02:30' }, { open: '03:00', close: '03:15' }] }];
    const SPRING: [string, string, string][] = [
      // zone, its spring night, 00:00 local that night as UTC
      ['Europe/Stockholm', '2029-03-25', '2029-03-24T23:00:00.000Z'],
      ['America/New_York', '2028-03-12', '2028-03-12T05:00:00.000Z'],
      ['Australia/Sydney', '2027-10-03', '2027-10-02T14:00:00.000Z'],
    ];
    const scheduleFor = (timezone: string, date: string): BusinessSchedule => ({
      timezone,
      weekly: { thu: [{ open: '12:00', close: '12:15' }] },
      exceptions: fold(date),
    });

    it('Stockholm 2027-03-28: thirty minutes, by hand, by the module and by the oracle', () => {
      const s = scheduleFor('Europe/Stockholm', '2027-03-28');
      const [a, b] = ['2027-03-27T23:00:00.000Z', '2027-03-28T12:00:00.000Z'];
      // Both windows are 01:00Z–01:30Z and 01:00Z–01:15Z in real time: the union is 30 min.
      expect(businessMsBetween(s, a, b)).toBe(30 * MINUTE);
      expect(oracleBetween(s, a, b)).toBe(30 * MINUTE);
      expect(addBusinessMs(s, a, 20 * MINUTE)).toBe('2027-03-28T01:20:00.000Z');
      expect(addBusinessMs(s, a, 30 * MINUTE)).toBe('2027-03-28T01:30:00.000Z');
      // Past the union, the next opening is the following Thursday's.
      expect(addBusinessMs(s, a, 40 * MINUTE)).toBe('2027-04-01T10:10:00.000Z'); // 12:10 CEST
    });

    for (const [timezone, night, midnight] of SPRING) {
      it(`${timezone} on ${night}: due instants never go back as the target grows, and match the oracle`, () => {
        const s = scheduleFor(timezone, night);
        let previous = '';
        for (let minutes = 15; minutes <= 60; minutes += 15) {
          const due = addBusinessMs(s, midnight, minutes * MINUTE)!;
          expect(due >= previous).toBe(true);
          expect(due).toBe(oracleAdd(s, midnight, minutes * MINUTE, '2030-01-01T00:00:00.000Z'));
          previous = due;
        }
      }, ORACLE_MS);

      it(`${timezone} on ${night}: add then between round-trips over the folded windows`, () => {
        const s = scheduleFor(timezone, night);
        for (const minutes of [5, 15, 29, 30, 31, 45]) {
          const due = addBusinessMs(s, midnight, minutes * MINUTE)!;
          expect(businessMsBetween(s, midnight, due)).toBe(minutes * MINUTE);
        }
        expect(businessMsBetween(s, midnight, new Date(Date.parse(midnight) + 12 * HOUR).toISOString())).toBe(30 * MINUTE);
      });
    }
  });

  describe("Codex's case: Stockholm, Sundays 01:00–04:00, from 2026-01-01", () => {
    const sundays: BusinessSchedule = { timezone: 'Europe/Stockholm', weekly: { sun: [{ open: '01:00', close: '04:00' }] } };
    // The cap, as the oracle sees it: the end of the 3660th local day after the start's.
    const cap = '2036-01-01T00:00:00.000Z';

    it('inside the cap the due is the wall clock’s, to the minute', () => {
      const ms = 1_500 * HOUR;
      const due = addBusinessMs(sundays, from, ms);
      expect(due).not.toBeNull();
      expect(due).toBe(oracleAdd(sundays, from, ms, cap));
    }, ORACLE_MS);

    it('1606 h lies past the cap: null — never the hour-off instant the week jump gave', () => {
      expect(oracleAdd(sundays, from, 1_606 * HOUR, cap)).toBeNull();
      expect(addBusinessMs(sundays, from, 1_606 * HOUR)).toBeNull();
    }, ORACLE_MS);
  });
});

/**
 * One stream across midnight (Codex round 4 on #2060). A skipped hour can carry a day's
 * window onto the next day's instants, so disjointness is a property of the whole stream,
 * not of a local day. Checked by hand on the shape Codex found, then as a property over
 * every transition from 2025 to 2035 in zones that between them change at 23:00 (Nuuk), at
 * midnight (Havana, Beirut), by half an hour (Lord Howe), at 02:45 (Chatham), and in both
 * hemispheres, against the oracle — which places windows on its own cross-midnight stream.
 */
describe('openings are one union across midnight', () => {
  it("Nuuk's 23:00 → 00:00 night: Saturday 23:00–23:30 and Sunday 00:00–00:30 are the same half hour", () => {
    const nuuk: BusinessSchedule = {
      timezone: 'America/Nuuk',
      weekly: { sat: [{ open: '23:00', close: '23:30' }], sun: [{ open: '00:00', close: '00:30' }] },
    };
    const from = '2027-03-28T00:00:00.000Z'; // Saturday 22:00 in Nuuk (UTC−2)
    // Both windows resolve to 01:00Z–01:30Z: thirty minutes, by hand, module and oracle.
    expect(businessMsBetween(nuuk, from, '2027-03-28T01:30:00.000Z')).toBe(30 * MINUTE);
    expect(oracleBetween(nuuk, from, '2027-03-28T01:30:00.000Z')).toBe(30 * MINUTE);
    expect(addBusinessMs(nuuk, from, 30 * MINUTE)).toBe('2027-03-28T01:30:00.000Z');
    // Ten minutes more is a week later: Saturday 23:00 at UTC−1 is 2027-04-04T00:00Z.
    expect(addBusinessMs(nuuk, from, 40 * MINUTE)).toBe('2027-04-04T00:10:00.000Z');
    // The oracle counts whole quarter-hours: compared at 45 minutes.
    expect(addBusinessMs(nuuk, from, 45 * MINUTE)).toBe(oracleAdd(nuuk, from, 45 * MINUTE, '2027-04-10T00:00:00.000Z'));
  });

  it('Samoa skipped 2011-12-30: its windows land on the 31st’s, and a window ending at its 24:00 is empty', () => {
    // Every day 09:00–10:00 and 23:00–24:00. UTC−10 until 2011-12-30T10:00Z, UTC+14 after.
    const apia: BusinessSchedule = {
      timezone: 'Pacific/Apia',
      weekly: Object.fromEntries(
        ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [
          d,
          [{ open: '09:00', close: '10:00' }, { open: '23:00', close: '24:00' }],
        ]),
      ),
    };
    // By hand, over 2011-12-29T00:00Z … 2011-12-31T12:00Z:
    //   28th 23:00–24:00 (UTC−10)  → 29th 09:00Z–10:00Z
    //   29th 09:00–10:00            → 29th 19:00Z–20:00Z
    //   29th 23:00–24:00            → 30th 09:00Z–10:00Z (24:00 is the skipped 30th's 00:00,
    //                                 moved a day forward to the 31st's, 10:00Z)
    //   30th 09:00–10:00 (skipped) → a day forward, 31st 09:00–10:00 = 30th 19:00Z–20:00Z
    //   30th 23:00–24:00 (skipped) → opens on the 31st at 23:00 (31st 09:00Z) but closes at
    //                                 the 31st's 00:00 (30th 10:00Z): empty
    //   31st 09:00–10:00 (UTC+14)  → 30th 19:00Z–20:00Z: the same hour as the 30th's
    //   31st 23:00–24:00            → 31st 09:00Z–10:00Z
    // Five hours, where counting the 30th's and the 31st's mornings apart would give six.
    const [from, to] = ['2011-12-29T00:00:00.000Z', '2011-12-31T12:00:00.000Z'];
    expect(businessMsBetween(apia, from, to)).toBe(5 * HOUR);
    expect(oracleBetween(apia, from, to)).toBe(5 * HOUR);
    expect(addBusinessMs(apia, from, 3 * HOUR)).toBe('2011-12-30T10:00:00.000Z');
    expect(addBusinessMs(apia, from, 4 * HOUR)).toBe('2011-12-30T20:00:00.000Z');
    expect(addBusinessMs(apia, from, 5 * HOUR)).toBe('2011-12-31T10:00:00.000Z');
    expect(businessMsBetween(apia, from, '2011-12-30T20:00:00.000Z')).toBe(4 * HOUR);
  });

  it("a window the cap's last night carries past the cap is not counted: the walk cannot see the next day", () => {
    // Start so that the walk's last day is Nuuk's spring Saturday, 2036-03-29: its 23:00–23:30
    // is skipped into Sunday, past the midnight that ends the walk, where the day after (never
    // walked) could hold earlier open time. So the stream stops at that midnight.
    const nuuk: BusinessSchedule = { timezone: 'America/Nuuk', weekly: { sat: [{ open: '23:00', close: '23:30' }] } };
    const lastDay = dayNumberOf('2036-03-29');
    const start = new Date((lastDay - (EXACT_DAYS - 1)) * DAY + 12 * HOUR).toISOString();
    const cap = '2036-03-30T01:00:00.000Z'; // Sunday 00:00 at UTC−1, the first instant past the walk
    const counted = businessMsBetween(nuuk, start, cap)!;
    expect(counted % (30 * MINUTE)).toBe(0);
    const due = addBusinessMs(nuuk, start, counted)!;
    expect(businessMsBetween(nuuk, start, due)).toBe(counted);
    expect(Date.parse(due)).toBeLessThan(Date.parse(cap));
    expect(addBusinessMs(nuuk, start, counted + MINUTE)).toBeNull();
  });

  // zone, years searched (inclusive), the fewest transitions those years must hold
  const ZONES: [string, number, number, number][] = [
    ['America/Nuuk', 2025, 2035, 20],
    ['Europe/Stockholm', 2025, 2035, 20],
    ['America/New_York', 2025, 2035, 20],
    ['Australia/Sydney', 2025, 2035, 20],
    ['Australia/Lord_Howe', 2025, 2035, 20],
    ['Pacific/Chatham', 2025, 2035, 20],
    ['America/Havana', 2025, 2035, 20],
    ['Asia/Beirut', 2025, 2035, 20],
    // The dateline moves, each skipping a whole local day (Codex round 5): Samoa's DST and
    // its jump from UTC−10 to UTC+14 over 2011-12-30, Kiribati's Line Islands over
    // 1994-12-31, and the Marshall Islands' Kwajalein over 1993-08-21.
    ['Pacific/Apia', 2010, 2012, 4],
    ['Pacific/Kiritimati', 1994, 1995, 1],
    ['Pacific/Kwajalein', 1993, 1993, 1],
  ];
  // Every day the same: windows touching midnight on both sides, one across 02:00–03:00.
  const allWeek = (timezone: string): BusinessSchedule => {
    const day = [
      { open: '00:00', close: '00:45' },
      { open: '01:30', close: '03:15' },
      { open: '22:45', close: '23:30' },
      { open: '23:45', close: '24:00' },
    ];
    return { timezone, weekly: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, day])) };
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

  for (const [timezone, fromYear, toYear, fewest] of ZONES) {
    it(`${timezone}: every transition ${fromYear}–${toYear} — oracle agreement, monotonic dues, add/between round trip`, () => {
      const s = allWeek(timezone);
      const nights = transitions(timezone, fromYear, toYear);
      expect(nights.length).toBeGreaterThanOrEqual(fewest);
      for (const at of nights) {
        const from = new Date(at - 2 * DAY).toISOString();
        const to = new Date(at + 2 * DAY).toISOString();
        const slots = openInstants(s, Date.parse(from), Date.parse(to));
        expect(businessMsBetween(s, from, to)).toBe(slots.length * SLOT);
        let previous = '';
        for (let k = 1; k <= slots.length; k++) {
          const due = addBusinessMs(s, from, k * SLOT)!;
          expect(due).toBe(new Date(slots[k - 1]! + SLOT).toISOString());
          expect(due > previous).toBe(true);
          expect(businessMsBetween(s, from, due)).toBe(k * SLOT);
          previous = due;
        }
      }
    }, 300_000);
  }
});

describe('the line the widget shows', () => {
  it('runs consecutive equal days together, drops closed days, and names the zone', () => {
    const s: BusinessSchedule = {
      timezone: 'Europe/Stockholm',
      weekly: { ...weekdays('x').weekly, sat: [{ open: '10:00', close: '14:00' }] },
      exceptions: [{ date: '2026-12-24', windows: [] }],
    };
    expect(describeSchedule(s)).toBe('Mon–Fri 09:00–17:00; Sat 10:00–14:00 (Europe/Stockholm)');
  });

  it('does not run together equal days that are not consecutive', () => {
    const s: BusinessSchedule = {
      timezone: 'UTC',
      weekly: { mon: nineToFive, tue: [{ open: '10:00', close: '12:00' }], wed: nineToFive },
    };
    expect(describeSchedule(s)).toBe('Mon 09:00–17:00; Tue 10:00–12:00; Wed 09:00–17:00 (UTC)');
  });

  it('lists every window of a split day', () => {
    const s: BusinessSchedule = {
      timezone: 'UTC',
      weekly: { mon: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '17:00' }], sun: nineToFive },
    };
    expect(describeSchedule(s)).toBe('Mon 09:00–12:00, 13:00–17:00; Sun 09:00–17:00 (UTC)');
  });
});
