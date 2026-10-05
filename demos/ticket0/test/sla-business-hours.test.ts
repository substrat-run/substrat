/**
 * Service levels on business hours (#1648): the desk's structured opening hours, the
 * `business` clock its targets may count on, and the line the widget shows.
 *
 * `test/business-time.test.ts` holds the arithmetic. This suite drives the desk through
 * its own operations and asks what the arithmetic is FOR: does the sweep leave a Friday
 * evening mail alone until Monday, does a snooze over a weekend give back the right
 * hours, does "due soon" at Friday 16:50 show Monday morning's work.
 *
 * Every test stands at a named instant (`at`), always later than the one before, so a
 * reader sees the weekday and the hour a claim depends on. The calendar twin of each
 * business-clock claim is asserted beside it, because a suite that only watched the due
 * land on Monday would pass against a clock that ignored the setting and a target that
 * happened to be long.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BUSINESS_EXCEPTIONS_MAX, BUSINESS_WINDOWS_PER_DAY_MAX } from '../spec/model.js';
import {
  emptyHoursForm,
  HOURS_EXCEPTIONS_MAX,
  HOURS_WINDOWS_PER_DAY_MAX,
  hoursFormOf,
  hoursPayloadOf,
} from '../app/src/business-hours.js';
import { slaFormOf, slaPayloadOf } from '../app/src/sla.js';
import { createKit, ORIGIN, type Desk } from './desk-kit.js';

const kit = createKit('ticket0-bh-');
afterAll(() => kit.dispose());

interface Conversation {
  id: string;
  created_at: string;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_response_breached_at: string | null;
  resolution_breached_at: string | null;
  snoozed_ms: number | null;
}

const nineToFive = [{ open: '09:00', close: '17:00' }];
const WEEKDAYS_UTC = {
  timezone: 'UTC',
  weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive },
};

async function freshDesk(settings: Record<string, unknown>): Promise<Desk> {
  const desk = await kit.freshDesk({ agents: 1 });
  await kit.configure(desk, settings);
  return desk;
}

const admin = (desk: Desk) => kit.as(desk, desk.admin);
const agent = (desk: Desk) => kit.as(desk, desk.agents[0]!);

/** Stand at `iso`. Always forward: the spine is a log, and a log does not go back. */
function at(iso: string): void {
  if (Date.parse(iso) < Date.parse(kit.clock.now())) throw new Error(`clock would go back to ${iso}`);
  kit.clock.set(iso);
}

let mails = 0;
/** A mail arrives at exactly the instant the test stands at (`kit.mail` moves the clock a minute first). */
async function mail(desk: Desk): Promise<string> {
  mails += 1;
  const arrived = (await (await kit.as(desk, desk.relay)).invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: `customer-${mails}@customer.example`,
    contactName: null,
    subject: `Question ${mails}`,
    bodyText: 'Something is not working.',
    emailMessageId: `<bh-${mails}@mail.example>`,
  })) as { conversation_id: string };
  return arrived.conversation_id;
}

const read = async (desk: Desk, id: string) =>
  (await (await admin(desk)).invoke('ticket0/get-conversation', { conversationId: id })) as Conversation;

const sweep = (desk: Desk) => kit.sweep(desk, 'ticket0/escalate-sla-breaches', 'breached');

const soon = async (desk: Desk, withinMinutes: number) =>
  ((await (await admin(desk)).invoke('ticket0/breaching-soon', { withinMinutes })) as {
    rows: { conversationId: string; target: string; dueAt: string }[];
  }).rows;

const widgetHours = async (desk: Desk) =>
  ((await (await kit.as(desk, desk.widget)).invoke('ticket0/widget-start', { origin: ORIGIN })) as {
    businessHours: string | null;
  }).businessHours;

const FR_4H = { firstResponseMinutes: { normal: 240 } };

describe('the business clock decides when a target falls due', () => {
  it('a Friday-evening mail with four hours falls due on Monday, and the sweep waits for it', async () => {
    const desk = await freshDesk({ businessHours: WEEKDAYS_UTC, sla: { ...FR_4H, clock: 'business' } });
    at('2026-10-09T16:00:00.000Z'); // Friday 16:00
    const id = await mail(desk);
    // One hour on Friday, three on Monday.
    expect((await read(desk, id)).first_response_due_at).toBe('2026-10-12T12:00:00.000Z');

    at('2026-10-10T10:00:00.000Z'); // Saturday — calendar time has run out, business time has not
    expect(await sweep(desk)).toBe(0);
    at('2026-10-12T12:00:00.000Z'); // Monday, exactly due: on time
    expect(await sweep(desk)).toBe(0);
    at('2026-10-12T12:01:00.000Z');
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, id)).first_response_breached_at).toBe('2026-10-12T12:01:00.000Z');
  });

  it('the calendar twin: the same desk without the business clock is due that evening', async () => {
    const desk = await freshDesk({ businessHours: WEEKDAYS_UTC, sla: FR_4H });
    at('2026-10-16T16:00:00.000Z'); // Friday 16:00
    const id = await mail(desk);
    expect((await read(desk, id)).first_response_due_at).toBe('2026-10-16T20:00:00.000Z');
    at('2026-10-17T10:00:00.000Z');
    expect(await sweep(desk)).toBe(1);
  });

  it('the business clock with no hours to read counts calendar time — never a target that cannot run out', async () => {
    const desk = await freshDesk({ sla: { ...FR_4H, clock: 'business' } });
    at('2026-10-23T16:00:00.000Z'); // Friday
    const id = await mail(desk);
    expect((await read(desk, id)).first_response_due_at).toBe('2026-10-23T20:00:00.000Z');
  });

  it('a holiday is closed: a Monday exception pushes the due to Tuesday', async () => {
    const desk = await freshDesk({
      businessHours: { ...WEEKDAYS_UTC, exceptions: [{ date: '2026-11-02', windows: [] }] },
      sla: { ...FR_4H, clock: 'business' },
    });
    at('2026-10-30T16:00:00.000Z'); // Friday
    const id = await mail(desk);
    expect((await read(desk, id)).first_response_due_at).toBe('2026-11-03T12:00:00.000Z');
  });

  it('local hours in a DST zone: a weekend across the spring transition', async () => {
    const desk = await freshDesk({
      businessHours: { ...WEEKDAYS_UTC, timezone: 'Europe/Stockholm' },
      sla: { ...FR_4H, clock: 'business' },
    });
    // Stockholm moves to summer time on Sunday 2027-03-28. Fri 16:00 CET = 15:00Z.
    at('2027-03-26T15:00:00.000Z');
    const id = await mail(desk);
    // One hour Friday (CET), three Monday from 09:00 CEST = 07:00Z → 10:00Z.
    expect((await read(desk, id)).first_response_due_at).toBe('2027-03-29T10:00:00.000Z');
  });

  it('a new priority re-aims on the business clock, counted from arrival', async () => {
    const desk = await freshDesk({
      businessHours: WEEKDAYS_UTC,
      sla: { firstResponseMinutes: { normal: 240, urgent: 60 }, clock: 'business' },
    });
    at('2027-04-02T16:30:00.000Z'); // Friday 16:30
    const id = await mail(desk);
    at('2027-04-03T09:00:00.000Z'); // triaged on Saturday
    await (await agent(desk)).invoke('ticket0/set-priority', { conversationId: id, priority: 'urgent' });
    // Thirty minutes on Friday, thirty on Monday.
    expect((await read(desk, id)).first_response_due_at).toBe('2027-04-05T09:30:00.000Z');
  });
});

describe('a business-clock target the hours cannot meet within ten years is refused, naming it', () => {
  const sparse = { timezone: 'UTC', weekly: { mon: [{ open: '12:00', close: '12:01' }] } };
  const message = /The urgent resolution target of 525600 minutes can't be met within ten years of these opening hours/;

  it('refused when the target arrives on hours too sparse for it, and the desk keeps what it had', async () => {
    const desk = await freshDesk({ businessHours: sparse, sla: { ...FR_4H, clock: 'business' } });
    await expect(
      (await admin(desk)).invoke('ticket0/configure-desk', {
        settings: { sla: { ...FR_4H, resolutionMinutes: { urgent: 525_600 }, clock: 'business' } },
      }),
    ).rejects.toThrow(message);
    const saved = (await (await admin(desk)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(saved.settings).sla).toEqual({ ...FR_4H, clock: 'business' });
  });

  it('refused just the same when the hours change under a target that was met', async () => {
    const desk = await freshDesk({
      businessHours: WEEKDAYS_UTC,
      sla: { resolutionMinutes: { urgent: 525_600 }, clock: 'business' },
    });
    await expect(
      (await admin(desk)).invoke('ticket0/configure-desk', { settings: { businessHours: sparse } }),
    ).rejects.toThrow(message);
    expect(await widgetHours(desk)).toBe('Mon–Fri 09:00–17:00 (UTC)');
  });

  it('the twins: the same target on calendar time, and a target the sparse hours can meet, are accepted', async () => {
    const desk = await freshDesk({ businessHours: sparse });
    await (await admin(desk)).invoke('ticket0/configure-desk', {
      settings: { sla: { resolutionMinutes: { urgent: 525_600 } } },
    });
    // The one-minute week guarantees 478 minutes from any start (522 weeks less 22 jumps of
    // twice the day): 478 is accepted.
    await (await admin(desk)).invoke('ticket0/configure-desk', {
      settings: { sla: { resolutionMinutes: { urgent: 478 }, clock: 'business' } },
    });
    const saved = (await (await admin(desk)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(JSON.parse(saved.settings).sla).toEqual({ resolutionMinutes: { urgent: 478 }, clock: 'business' });
  });
});

describe('a snooze on the business clock gives back business time (#1648)', () => {
  it('a snooze over a weekend gives back the open hours it covered, and first response still runs', async () => {
    const desk = await freshDesk({
      businessHours: WEEKDAYS_UTC,
      sla: { firstResponseMinutes: { normal: 540 }, resolutionMinutes: { normal: 240, urgent: 240 }, clock: 'business' },
    });
    at('2027-04-08T16:00:00.000Z'); // Thursday 16:00
    const id = await mail(desk);
    const before = await read(desk, id);
    expect(before.resolution_due_at).toBe('2027-04-09T12:00:00.000Z'); // Fri 12:00
    expect(before.first_response_due_at).toBe('2027-04-09T17:00:00.000Z'); // Fri 17:00

    at('2027-04-08T16:30:00.000Z');
    const a = await agent(desk);
    await a.invoke('ticket0/assign', { conversationId: id, assignee: desk.agents[0] });
    await a.invoke('ticket0/snooze', { conversationId: id, until: '2027-04-12T09:30:00.000Z' });
    at('2027-04-12T09:30:00.000Z'); // Monday 09:30
    await a.invoke('ticket0/wake', { conversationId: id });

    const after = await read(desk, id);
    // Asleep for 30 min Thursday + 8 h Friday + 30 min Monday of desk time = 9 h. The
    // resolution target had 3.5 h left when it slept, and has 3.5 h left now: 13:00.
    expect(after.snoozed_ms).toBe(9 * 3_600_000);
    expect(after.resolution_due_at).toBe('2027-04-12T13:00:00.000Z');
    // First response does not pause: it fell due on Friday while the conversation slept.
    expect(after.first_response_due_at).toBe('2027-04-09T17:00:00.000Z');
    expect(await sweep(desk)).toBe(1);
    expect((await read(desk, id)).first_response_breached_at).not.toBeNull();
    expect((await read(desk, id)).resolution_breached_at).toBeNull();

    // A re-aim counts past the 9 business hours given back, in business time, from
    // arrival: 4 h + 9 h of desk time after Thursday 16:00 is Monday 13:00 again. Read as
    // calendar time it would be Friday 05:00, and late.
    await a.invoke('ticket0/set-priority', { conversationId: id, priority: 'urgent' });
    expect((await read(desk, id)).resolution_due_at).toBe('2027-04-12T13:00:00.000Z');
  });

  it('the calendar twin: the same snooze gives back every hour it lasted', async () => {
    const desk = await freshDesk({
      businessHours: WEEKDAYS_UTC,
      sla: { resolutionMinutes: { normal: 240 } },
    });
    at('2027-04-15T16:00:00.000Z'); // Thursday 16:00, due 20:00
    const id = await mail(desk);
    at('2027-04-15T16:30:00.000Z');
    const a = await agent(desk);
    await a.invoke('ticket0/assign', { conversationId: id, assignee: desk.agents[0] });
    await a.invoke('ticket0/snooze', { conversationId: id, until: '2027-04-19T09:30:00.000Z' });
    at('2027-04-19T09:30:00.000Z');
    await a.invoke('ticket0/wake', { conversationId: id });
    // 89 hours asleep: 20:00 Thursday + 89 h = 13:00 Monday. The same instant the business
    // clock reached, because on both clocks the target keeps the 3.5 h it had left; what
    // differs is how much was given back, which is what a later re-aim counts past.
    const after = await read(desk, id);
    expect(after.resolution_due_at).toBe('2027-04-19T13:00:00.000Z');
    expect(after.snoozed_ms).toBe(89 * 3_600_000);
  });
});

describe('breaching soon counts its window on the targets’ clock', () => {
  it('at Friday 16:50, a due of Monday 09:10 is twenty business minutes away and shows', async () => {
    const desk = await freshDesk({ businessHours: WEEKDAYS_UTC, sla: { firstResponseMinutes: { normal: 30 }, clock: 'business' } });
    at('2027-04-23T16:40:00.000Z'); // Friday 16:40: 20 min Friday + 10 min Monday
    const id = await mail(desk);
    expect((await read(desk, id)).first_response_due_at).toBe('2027-04-26T09:10:00.000Z');
    at('2027-04-23T16:50:00.000Z');
    expect((await soon(desk, 60)).map((r) => r.conversationId)).toEqual([id]);
    // Inclusive at the edge, exclusive past it: exactly twenty business minutes left.
    expect((await soon(desk, 20)).map((r) => r.conversationId)).toEqual([id]);
    expect(await soon(desk, 19)).toEqual([]);
  });

  it('the calendar twin: on calendar time Monday is sixty-four hours away and does not', async () => {
    const desk = await freshDesk({ businessHours: WEEKDAYS_UTC, sla: { firstResponseMinutes: { normal: 3870 } } });
    at('2027-04-30T16:50:00.000Z'); // Friday 16:50; due Monday 09:20 by the calendar
    const id = await mail(desk);
    expect((await read(desk, id)).first_response_due_at).toBe('2027-05-03T09:20:00.000Z');
    expect(await soon(desk, 60)).toEqual([]);
  });
});

describe('the line the widget shows', () => {
  it('is derived from the structured hours, falls back to the note, and goes back to it when they are cleared', async () => {
    const desk = await freshDesk({});
    const a = await admin(desk);
    await a.invoke('ticket0/configure-desk', { businessHours: 'Weekdays, roughly nine to five' });
    expect(await widgetHours(desk)).toBe('Weekdays, roughly nine to five');

    await a.invoke('ticket0/configure-desk', {
      settings: { businessHours: { ...WEEKDAYS_UTC, timezone: 'Europe/Stockholm', weekly: { ...WEEKDAYS_UTC.weekly, sat: [{ open: '10:00', close: '14:00' }] } } },
    });
    expect(await widgetHours(desk)).toBe('Mon–Fri 09:00–17:00; Sat 10:00–14:00 (Europe/Stockholm)');

    await a.invoke('ticket0/configure-desk', { settings: { businessHours: null } });
    expect(await widgetHours(desk)).toBe('Weekdays, roughly nine to five');
  });

  it('a desk that said neither says nothing', async () => {
    expect(await widgetHours(await freshDesk({}))).toBeNull();
  });

  it('a stored shape this version never wrote reads as no hours: the note shows, and the clock is the calendar', async () => {
    const desk = await freshDesk({ sla: { ...FR_4H, clock: 'business' } });
    await (await admin(desk)).invoke('ticket0/configure-desk', { businessHours: 'Ring us' });
    kit.sql(desk, (db) =>
      db.prepare('UPDATE ticket0_desk_settings SET settings = ?').run(
        JSON.stringify({ sla: { ...FR_4H, clock: 'business' }, businessHours: { tz: 'UTC', days: 'weekdays' } }),
      ),
    );
    expect(await widgetHours(desk)).toBe('Ring us');
    at('2027-05-07T16:00:00.000Z'); // Friday
    const id = await mail(desk);
    expect((await read(desk, id)).first_response_due_at).toBe('2027-05-07T20:00:00.000Z');
  });
});

describe('configure-desk refuses hours it cannot mean, and keeps what was saved', () => {
  const refused: [string, unknown][] = [
    ['an unknown timezone', { ...WEEKDAYS_UTC, timezone: 'Mars/Olympus' }],
    ['a week with no open time', { timezone: 'UTC', weekly: { mon: [] } }],
    ['a window that closes before it opens', { timezone: 'UTC', weekly: { mon: [{ open: '17:00', close: '09:00' }] } }],
    ['overlapping windows', { timezone: 'UTC', weekly: { mon: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }] } }],
    ['windows out of order', { timezone: 'UTC', weekly: { mon: [{ open: '13:00', close: '17:00' }, { open: '09:00', close: '12:00' }] } }],
    ['a time that is not one', { timezone: 'UTC', weekly: { mon: [{ open: '09:00', close: '24:30' }] } }],
    ['a day that is not one', { timezone: 'UTC', weekly: { mon: nineToFive, someday: nineToFive } }],
    ['a date that is not one', { ...WEEKDAYS_UTC, exceptions: [{ date: '2026-02-30', windows: [] }] }],
    ['two exceptions for one date', { ...WEEKDAYS_UTC, exceptions: [{ date: '2026-12-24', windows: [] }, { date: '2026-12-24', windows: nineToFive }] }],
    [
      'more exceptions than the walk is bounded for',
      {
        ...WEEKDAYS_UTC,
        exceptions: Array.from({ length: BUSINESS_EXCEPTIONS_MAX + 1 }, (_, i) => ({
          date: new Date(Date.UTC(2030, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
          windows: [],
        })),
      },
    ],
  ];

  it.each(refused)('refuses %s', async (_, businessHours) => {
    const desk = await freshDesk({ businessHours: WEEKDAYS_UTC });
    await expect((await admin(desk)).invoke('ticket0/configure-desk', { settings: { businessHours } })).rejects.toThrow();
    expect(await widgetHours(desk)).toBe('Mon–Fri 09:00–17:00 (UTC)');
  });

  it('accepts the edges: a window to 24:00, four windows a day, a year of exceptions', async () => {
    const desk = await freshDesk({});
    await (await admin(desk)).invoke('ticket0/configure-desk', {
      settings: {
        businessHours: {
          timezone: 'UTC',
          weekly: {
            mon: [
              { open: '00:00', close: '06:00' },
              { open: '06:00', close: '12:00' },
              { open: '13:00', close: '18:00' },
              { open: '19:00', close: '24:00' },
            ],
          },
          exceptions: Array.from({ length: BUSINESS_EXCEPTIONS_MAX }, (_, i) => ({
            date: new Date(Date.UTC(2030, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
            windows: [],
          })),
        },
      },
    });
    expect(await widgetHours(desk)).toBe('Mon 00:00–06:00, 06:00–12:00, 13:00–18:00, 19:00–24:00 (UTC)');
  });
});

describe('the Settings form says what the desk will do', () => {
  it('bounds the boxes by the same numbers the desk does', () => {
    expect(HOURS_WINDOWS_PER_DAY_MAX).toBe(BUSINESS_WINDOWS_PER_DAY_MAX);
    expect(HOURS_EXCEPTIONS_MAX).toBe(BUSINESS_EXCEPTIONS_MAX);
  });

  it('round-trips through the real desk: hours, exceptions and the business clock', async () => {
    const desk = await freshDesk({});
    const hours = emptyHoursForm();
    hours.timezone = 'Europe/Stockholm';
    for (const d of ['mon', 'tue', 'wed', 'thu'] as const) hours.days[d] = '09:00–17:00';
    hours.days.fri = '09:00–12:00, 13:00–15:00';
    hours.exceptions = '2027-12-24 closed\n2027-12-31 09:00–12:00';
    const payload = hoursPayloadOf(hours);
    expect(payload).toEqual({
      setting: {
        timezone: 'Europe/Stockholm',
        weekly: {
          mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive,
          fri: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '15:00' }],
        },
        exceptions: [
          { date: '2027-12-24', windows: [] },
          { date: '2027-12-31', windows: [{ open: '09:00', close: '12:00' }] },
        ],
      },
    });
    const sla = slaFormOf(null);
    sla.firstResponse.normal = '240';
    sla.businessClock = true;
    expect(slaPayloadOf(sla)).toEqual({ firstResponseMinutes: { normal: 240 }, clock: 'business' });

    await (await admin(desk)).invoke('ticket0/configure-desk', {
      settings: { businessHours: 'setting' in payload ? payload.setting : null, sla: slaPayloadOf(sla) },
    });
    const saved = (await (await admin(desk)).invoke('ticket0/get-desk', {})) as { settings: string };
    expect(hoursFormOf(saved.settings)).toEqual(hours);
    expect(slaFormOf(saved.settings)).toEqual(sla);
    expect(await widgetHours(desk)).toBe('Mon–Thu 09:00–17:00; Fri 09:00–12:00, 13:00–15:00 (Europe/Stockholm)');
  });

  it('every box empty saves as no structured hours; the clock box unticked sends no clock', () => {
    expect(hoursPayloadOf(emptyHoursForm())).toEqual({ setting: null });
    const sla = slaFormOf(null);
    sla.firstResponse.normal = '30';
    expect(slaPayloadOf(sla)).toEqual({ firstResponseMinutes: { normal: 30 } });
  });

  it('accepts a hyphen for the dash, and reads it back with the dash', () => {
    const hours = emptyHoursForm();
    hours.timezone = 'UTC';
    hours.days.mon = '09:00-17:00';
    expect(hoursPayloadOf(hours)).toEqual({ setting: { timezone: 'UTC', weekly: { mon: nineToFive } } });
  });

  it('names the box it will not save', () => {
    const withDay = (text: string, timezone = 'UTC') => {
      const hours = emptyHoursForm();
      hours.timezone = timezone;
      hours.days.tue = text;
      return hoursPayloadOf(hours);
    };
    expect(withDay('9 to 5')).toEqual({ error: expect.stringMatching(/^Tuesday: "9 to 5" is not a window/) });
    expect(withDay('17:00–09:00')).toEqual({ error: expect.stringMatching(/^Tuesday: .*closes before it opens/) });
    expect(withDay('09:00–13:00, 12:00–17:00')).toEqual({ error: expect.stringMatching(/^Tuesday: .*overlap/) });
    expect(withDay('09:00–24:30')).toEqual({ error: expect.stringMatching(/^Tuesday: .*00:00–24:00/) });
    expect(withDay('00:00–01:00, 02:00–03:00, 04:00–05:00, 06:00–07:00, 08:00–09:00')).toEqual({
      error: expect.stringMatching(/^Tuesday: at most 4/),
    });
    expect(withDay('09:00–17:00', '')).toEqual({ error: expect.stringMatching(/^Timezone: required/) });
    expect(withDay('09:00–17:00', 'Mars/Olympus')).toEqual({ error: expect.stringMatching(/^Timezone: "Mars\/Olympus"/) });
    expect(withDay('', 'UTC')).toEqual({ error: 'Open on at least one day of the week.' });

    const withException = (line: string) => {
      const hours = emptyHoursForm();
      hours.timezone = 'UTC';
      hours.days.mon = '09:00–17:00';
      hours.exceptions = line;
      return hoursPayloadOf(hours);
    };
    expect(withException('Christmas closed')).toEqual({ error: expect.stringMatching(/start with a date/) });
    expect(withException('2027-02-30 closed')).toEqual({ error: expect.stringMatching(/start with a date/) });
    expect(withException('2027-12-24')).toEqual({ error: expect.stringMatching(/say "closed"/) });
    expect(withException('2027-12-24 closed\n2027-12-24 closed')).toEqual({ error: expect.stringMatching(/listed twice/) });
  });

  it('shows empty boxes for a stored shape the desk would not apply', () => {
    expect(hoursFormOf(JSON.stringify({ businessHours: { tz: 'UTC' } }))).toEqual(emptyHoursForm());
    expect(hoursFormOf('not json')).toEqual(emptyHoursForm());
    expect(hoursFormOf(JSON.stringify({ businessHours: null }))).toEqual(emptyHoursForm());
  });
});

describe("a saved business-clock target is met exactly from every start (Codex round 2)", () => {
  const tuesdays = { timezone: 'UTC', weekly: { tue: [{ open: '12:00', close: '12:01' }] } };

  it('523 minutes is refused even on a Monday, when it would fit from that Monday alone', async () => {
    at('2027-06-07T00:00:00.000Z'); // Monday
    const desk = await freshDesk({ businessHours: tuesdays });
    await expect(
      (await admin(desk)).invoke('ticket0/configure-desk', {
        settings: { sla: { firstResponseMinutes: { normal: 523 }, clock: 'business' } },
      }),
    ).rejects.toThrow(/The normal first-response target of 523 minutes can't be met within ten years/);
  });

  it('a target saved on a Monday stamps an exact business due on a conversation arriving on Wednesday', async () => {
    at('2027-06-14T00:00:00.000Z'); // Monday
    const desk = await freshDesk({ businessHours: tuesdays, sla: { firstResponseMinutes: { normal: 478 }, clock: 'business' } });
    at('2027-06-16T00:00:00.000Z'); // Wednesday: its ten years hold one Tuesday fewer
    const id = await mail(desk);
    // The 478th Tuesday noon minute after 2027-06-16, never 478 calendar minutes later.
    const due = (await read(desk, id)).first_response_due_at!;
    expect(due).toBe(new Date(Date.UTC(2027, 5, 22, 12, 1) + 477 * 7 * 86_400_000).toISOString());
  });
});
