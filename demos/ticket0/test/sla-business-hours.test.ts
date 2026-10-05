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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleId, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { BUSINESS_EXCEPTIONS_MAX } from '../spec/model.js';
import { ticket0Manifest } from '../src/manifest.js';
import { ROLES } from '../src/provision.js';
import { buildHost } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let clock: ManualClock;

const TICKET0 = moduleId.parse(ticket0Manifest.id);
const staff = platformActorId.parse(ulid());
const ORIGIN = 'https://desk.example';

interface Desk {
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly admin: PrincipalId;
  readonly relay: PrincipalId;
  readonly widget: PrincipalId;
  readonly agent: PrincipalId;
}

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

let desks = 0;

async function freshDesk(settings: Record<string, unknown>): Promise<Desk> {
  desks += 1;
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: tenant, slug: `bh-${desks}`, name: `Desk ${desks}` });
  await host.admin.grantEntitlement(staff, tenant, ticket0Manifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  const node = { tenantId: tenant, scopeId: scope };
  const mint = async (roleKey: string) => {
    const p = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: p, roleKey, node });
    return p;
  };
  const desk: Desk = {
    tenant,
    scope,
    admin: await mint('desk-admin'),
    relay: await mint('relay'),
    widget: await mint('widget'),
    agent: await mint('agent'),
  };
  await (await as(desk, desk.admin)).invoke('ticket0/configure-desk', { allowedOrigins: [ORIGIN], settings });
  await (await as(desk, desk.agent)).invoke('ticket0/set-agent-profile', {
    displayName: 'Agent',
    avatarUrl: null,
    signature: null,
  });
  return desk;
}

const as = (desk: Desk, who: PrincipalId): Promise<ScopeStub> => host.getScope(who, desk.tenant, desk.scope);
const admin = (desk: Desk) => as(desk, desk.admin);
const agent = (desk: Desk) => as(desk, desk.agent);

/** Stand at `iso`. Always forward: the spine is a log, and a log does not go back. */
function at(iso: string): void {
  if (Date.parse(iso) < Date.parse(clock.now())) throw new Error(`clock would go back to ${iso}`);
  clock.set(iso);
}

let mails = 0;
async function mail(desk: Desk): Promise<string> {
  mails += 1;
  const arrived = (await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
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

async function sweep(desk: Desk): Promise<number> {
  const stub = await host.getSystemScope(TICKET0, desk.tenant, desk.scope);
  return ((await stub.invoke('ticket0/escalate-sla-breaches')) as { breached: number }).breached;
}

const soon = async (desk: Desk, withinMinutes: number) =>
  ((await (await admin(desk)).invoke('ticket0/breaching-soon', { withinMinutes })) as {
    rows: { conversationId: string; target: string; dueAt: string }[];
  }).rows;

const widgetHours = async (desk: Desk) =>
  ((await (await as(desk, desk.widget)).invoke('ticket0/widget-start', { origin: ORIGIN })) as {
    businessHours: string | null;
  }).businessHours;

const FR_4H = { firstResponseMinutes: { normal: 240 } };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-bh-'));
  // A Monday. Every test moves forward from wherever the last one left the clock.
  clock = manualClock('2026-10-05T08:00:00.000Z');
  host = buildHost(dir, clock.read);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
    await a.invoke('ticket0/assign', { conversationId: id, assignee: desk.agent });
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
    await a.invoke('ticket0/assign', { conversationId: id, assignee: desk.agent });
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
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
    try {
      db.prepare('UPDATE ticket0_desk_settings SET settings = ?').run(
        JSON.stringify({ sla: { ...FR_4H, clock: 'business' }, businessHours: { tz: 'UTC', days: 'weekdays' } }),
      );
    } finally {
      db.close();
    }
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
