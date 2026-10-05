/**
 * Business time (#1648): the pure arithmetic under ticket0's business-hours service levels.
 *
 * Every case is an instant on either side of a closed stretch — a night, a weekend, a DST
 * transition, a holiday — because the only way a "4 business hours" promise goes wrong is
 * by counting time the desk was shut, or failing to count time it was open.
 */
import { describe, expect, it } from 'vitest';
import {
  addBusinessMs,
  businessMsBetween,
  dayNumberOf,
  describeSchedule,
  instantOf,
  type BusinessSchedule,
} from '../src/business-time.js';

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

describe('bounds: the walk ends, whatever the schedule says', () => {
  // One minute a week, and a target of a year (`SLA_TARGET_MAX_MINUTES`): 525 600 weeks.
  const target = 525_600 * MINUTE;
  const start = '2026-01-05T00:00:00.000Z'; // a Monday

  it('a one-minute week reaches a year-long target, and at the right minute', () => {
    const s: BusinessSchedule = { timezone: 'UTC', weekly: { mon: [{ open: '12:00', close: '12:01' }] } };
    const began = performance.now();
    const due = addBusinessMs(s, start, target)!;
    expect(performance.now() - began).toBeLessThan(5_000);
    // The 525 600th one-minute window ends 525 599 weeks after the first.
    expect(Date.parse(due)).toBe(Date.UTC(2026, 0, 5, 12, 1) + 525_599 * 7 * DAY);
    expect(businessMsBetween(s, start, due)).toBe(target);
  });

  it('an exception beyond the exact horizon still costs its week', () => {
    // The first Monday of 2060 is closed. It is past the ten-year exact walk, so the weeks
    // either side of it are counted at once and it must not be jumped over.
    let mon = dayNumberOf('2060-01-01');
    while ((((mon + 4) % 7) + 7) % 7 !== 1) mon++;
    const date = new Date(mon * DAY).toISOString().slice(0, 10);
    const s: BusinessSchedule = {
      timezone: 'UTC',
      weekly: { mon: [{ open: '12:00', close: '12:01' }] },
      exceptions: [{ date, windows: [] }],
    };
    const due = addBusinessMs(s, start, target)!;
    expect(Date.parse(due)).toBe(Date.UTC(2026, 0, 5, 12, 1) + 525_600 * 7 * DAY);
    expect(businessMsBetween(s, start, due)).toBe(target);
  });

  it('a zone with DST far out: a noon window is unaffected by the jump', () => {
    const s: BusinessSchedule = { timezone: 'Europe/Stockholm', weekly: { mon: [{ open: '12:00', close: '12:01' }] } };
    const due = addBusinessMs(s, start, target)!;
    const lastMonday = Date.UTC(2026, 0, 5) / DAY + 525_599 * 7;
    expect(Date.parse(due)).toBe(instantOf('Europe/Stockholm', lastMonday * DAY + (12 * 60 + 1) * MINUTE));
  });

  it('the first ten years are walked exactly: half a year of night windows loses the spring hour', () => {
    // 26 Sundays of 01:00–04:00 in Stockholm, one of them the night the clocks go forward.
    // Counted a week at a time by wall clock it would be 78 h; counted for real it is 77.
    const night: BusinessSchedule = { timezone: 'Europe/Stockholm', weekly: { sun: [{ open: '01:00', close: '04:00' }] } };
    expect(businessMsBetween(night, '2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toBe(77 * HOUR);
  });

  it('a schedule with no open time, or an unknown zone, is refused rather than walked', () => {
    expect(addBusinessMs({ timezone: 'UTC', weekly: {} }, start, HOUR)).toBeNull();
    expect(addBusinessMs({ timezone: 'UTC', weekly: { mon: [] } }, start, HOUR)).toBeNull();
    expect(addBusinessMs({ timezone: 'Mars/Olympus', weekly: { mon: nineToFive } }, start, HOUR)).toBeNull();
    expect(businessMsBetween({ timezone: 'UTC', weekly: {} }, start, '2026-02-01T00:00:00.000Z')).toBeNull();
  });
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
