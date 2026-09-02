import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Hono } from 'hono';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import type { DevLogin } from '@substrat-run/dev-issuer';
import { buildRallyHost, seedRally, linkRallyLogins, type RallyWorld } from '../src/index.js';
import { createRallyApp } from '../src/routes.js';

/**
 * A `DevLogin` double: it asserts a subject from a test header instead of verifying a
 * signed token. ONLY the token verification is stubbed — everything downstream is real,
 * so these flows now walk the same `resolveIdentity(venue.tenantId, …)` the server does
 * and would fail if the persona → principal binding broke.
 *
 * `as` is a `sub` now, not a principal. That is the point: the test can no longer name a
 * principal directly, because neither can anything else.
 */
const stubLogin: DevLogin = {
  issuer: 'https://test.invalid',
  // The RP redirects are not what these flows test; the double refuses them outright.
  handle: () => Promise.reject(new Error('stubLogin serves no relying-party endpoints')),
  subject: (headers) => {
    const sub = headers.get('x-test-sub');
    return Promise.resolve(
      sub ? { sub, email: `${sub.replace('dev|', '')}@test.invalid`, name: sub } : null,
    );
  },
  caller: () => Promise.resolve(null),
};

/**
 * The flows, walked end to end through the REAL HTTP routes.
 *
 * scenario.test.ts calls operations directly, which is the right way to pin
 * invariants — and is structurally blind to the bugs this demo has actually
 * shipped. Every one of them was a wiring bug: an operation that worked with no
 * route in front of it, a link nothing read, a button with no path behind it.
 * A test that reaches for `ctx` cannot see any of that; one that goes through
 * the app can.
 *
 * The last test in this file is the important one: it fails if a registered
 * route is never exercised here, so "shipped but unreachable" becomes a red
 * build rather than something the user finds by clicking.
 */

const seen = new Set<string>();

describe('RallyPoint flows (through the HTTP surface)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: Hono;
  let w: RallyWorld;

  /** A date safely in the future, so holds and windows behave like the real app. */
  const soon = (plusDays = 10): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + plusDays);
    // The club keeps weekday hours (07:00–23:00); weekends open later and close
    // earlier (08:00–22:00). The fixed times below assume weekday hours, so roll
    // off Sat/Sun — otherwise the suite fails whenever today+N lands on a weekend.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const DATE = soon();

  const call = async (
    path: string,
    opts: { as?: string; venue?: string; method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    seen.add(`${opts.method ?? 'GET'} ${path.split('?')[0]!.replace(/\/[0-9A-HJKMNP-TV-Z]{26}/g, '/:id')}`);
    const res = await app.request(path, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opts.as ? { 'x-test-sub': opts.as } : {}),
        ...(opts.venue ? { 'x-venue': opts.venue } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const ok = async (path: string, opts: Parameters<typeof call>[1] = {}) => {
    const r = await call(path, opts);
    expect({ path, status: r.status, body: r.body }).toMatchObject({ status: 200 });
    return r.body;
  };

  let astrid: string;
  let ravi: string;
  let nils: string;
  let elin: string;
  let johan: string;
  let rutger: string;
  let elinM: string;
  let johanM: string;
  let court: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-rally-flows-'));
    host = buildRallyHost(dir);
    w = await seedRally(host, dir);
    await linkRallyLogins(host, w);
    app = createRallyApp(host, w, stubLogin);

    astrid = 'dev|astrid';
    ravi = 'dev|ravi';
    nils = 'dev|nils';
    elin = 'dev|elin';
    johan = 'dev|johan';
    rutger = 'dev|rutger';
    // The member ids come from `rally/whoami` now — the seam this migration added. They
    // used to come from a hardcoded persona → member map the dev server shipped to the
    // browser, which is exactly what made the player app work only here.
    elinM = (await ok('/api/whoami', { as: elin })).memberId;
    johanM = (await ok('/api/whoami', { as: johan })).memberId;
    const courts = await ok('/api/courts', { as: astrid });
    court = courts[0].id;
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -- who can see which club ----------------------------------------------

  it('venue reachability is the permission model, not a UI preference', async () => {
    expect((await ok('/api/my-venues', { as: astrid })).map((v: any) => v.key)).toEqual([
      'solna',
      'nacka',
    ]);
    expect((await ok('/api/my-venues', { as: ravi })).map((v: any) => v.key)).toEqual(['solna']);
    expect((await ok('/api/my-venues', { as: rutger })).map((v: any) => v.key)).toEqual([
      'goteborg',
    ]);
    // Astrid may name Göteborg's scope; she just cannot do anything in it.
    expect((await call('/api/venue', { as: astrid, venue: 'goteborg' })).status).toBe(403);
  });

  // -- the player's whole booking journey ----------------------------------

  it('a player browses, books, and pays — without ever reading the club’s book', async () => {
    const courts = await ok('/api/browse/courts', { as: elin });
    expect(courts.length).toBeGreaterThan(0);

    const slots = await ok(`/api/availability?resourceId=${court}&date=${DATE}`, { as: elin });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].fits.length).toBeGreaterThan(0);

    const booked = await ok('/api/bookings', {
      as: elin,
      method: 'POST',
      body: { resourceId: court, memberId: elinM, date: DATE, time: '19:00', duration: 90 },
    });
    expect(booked.reservation.state).toBe('held');
    expect(booked.price.amount).toBe('340'); // Högtrafik, no customer discount

    const confirmed = await ok(`/api/bookings/${booked.reservation.id}/confirm`, {
      as: elin,
      method: 'POST',
      body: {},
    });
    expect(confirmed.reservation.state).toBe('confirmed');

    // Hers, and only hers.
    const mine = await ok('/api/portal/bookings', { as: elin });
    expect(mine.some((r: any) => r.id === booked.reservation.id)).toBe(true);
    expect((await call('/api/members', { as: elin })).status).toBe(403);
    expect((await call('/api/reservations', { as: elin })).status).toBe(403);
  });

  it('the same slot twice is a 409 the UI can act on', async () => {
    await ok('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: johanM, date: DATE, time: '14:00', duration: 60 },
    });
    const clash = await call('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: elinM, date: DATE, time: '14:00', duration: 60 },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
  });

  // -- wallet, packs, subscriptions ----------------------------------------

  it('buys credit, pays a booking from it, and subscribes', async () => {
    const bought = await ok('/api/wallet/buy', {
      as: elin,
      method: 'POST',
      body: { memberId: elinM, packKey: 'klipp-5' },
    });
    expect(Number(bought.received.amount)).toBeGreaterThan(Number(bought.paid.amount));

    const b = await ok('/api/bookings', {
      as: elin,
      method: 'POST',
      body: { resourceId: court, memberId: elinM, date: DATE, time: '10:00', duration: 60 },
    });
    const paid = await ok(`/api/bookings/${b.reservation.id}/confirm`, {
      as: elin,
      method: 'POST',
      body: { payWith: 'wallet' },
    });
    expect(paid.paidFromWallet).toBe(true);

    const wallet = await ok(`/api/wallet?memberId=${elinM}`, { as: elin });
    expect(wallet.entries.length).toBe(2); // the pack, then the booking

    const sub = await ok('/api/subscriptions', {
      as: elin,
      method: 'POST',
      body: { memberId: elinM, planKey: 'manadskort', on: DATE },
    });
    const run = await ok('/api/billing/run', { as: astrid, method: 'POST', body: { on: DATE } });
    expect(run.charged).toBe(1);

    // Cancelling stops the next cycle without clawing back what was credited.
    const cancelled = await ok(`/api/subscriptions/${sub.id}/cancel`, {
      as: elin, method: 'POST', body: {},
    });
    expect(cancelled.status).toBe('cancelled');
    const after = await ok('/api/billing/run', {
      as: astrid, method: 'POST', body: { on: soon(45) },
    });
    expect(after.charged).toBe(0);
  });

  // -- open matches, and the shared link -----------------------------------

  it('opens a match, shares the link, and the link fills and then dies', async () => {
    const made = await ok('/api/matches', {
      as: elin,
      method: 'POST',
      body: {
        resourceId: court, memberId: elinM, date: DATE, time: '21:00', duration: 90,
        fillTarget: 2, levelMin: '3.0', levelMax: '4.5',
      },
    });
    const id = made.reservation.id;

    // The host occupies a spot, so it is on offer at 1/2 — not 0/2.
    const list = await ok('/api/matches', { as: johan });
    const offered = list.find((m: any) => m.reservationId === id);
    expect(offered.joined).toBe(1);

    // The link resolves for someone who is not in it yet.
    const landing = await ok(`/api/matches/${id}`, { as: johan });
    expect(landing.status).toBe('open');
    expect(landing.venueName).toContain('Solna');

    await ok(`/api/matches/${id}/join`, { as: johan, method: 'POST', body: { memberId: johanM } });

    // …and the same link now tells the truth to the next person.
    expect((await ok(`/api/matches/${id}`, { as: elin })).status).toBe('full');
    expect((await ok('/api/matches', { as: johan })).some((m: any) => m.reservationId === id)).toBe(
      false,
    );
  });

  // -- booking a time rather than a court ------------------------------------

  it('a player books a TIME; the court is assigned, or filtered, never asked for', async () => {
    // Availability is the venue's, not one court's: a start is offered if ANY
    // court can take it, and says which.
    const slots = await ok(`/api/venue-availability?date=${DATE}`, { as: elin });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].courts.length).toBeGreaterThan(1);

    // Filters narrow the pool BEFORE the grid, so a filtered slot never appears
    // offering a court the player excluded.
    const roofed = await ok(`/api/venue-availability?date=${DATE}&cover=indoor,covered`, {
      as: elin,
    });
    for (const s of roofed) {
      for (const c of s.courts) expect(['indoor', 'covered']).toContain(c.cover);
    }
    const openAir = await ok(`/api/venue-availability?date=${DATE}&cover=open`, { as: elin });
    for (const s of openAir) for (const c of s.courts) expect(c.cover).toBe('open');

    // Step 2 asks what it costs BEFORE committing, and which courts could take
    // it — until this existed, the only way to learn a price was to take the slot.
    const quote = await ok(
      `/api/quote?date=${DATE}&time=13:00&duration=90`,
      { as: elin },
    );
    expect(Number(quote.price.amount)).toBeGreaterThan(0);
    expect(quote.courts.length).toBeGreaterThan(0);

    // PRICE MUST MOVE WITH DURATION. It did not, for a long time: every rule was
    // a flat amount with no duration, so 60, 90 and 120 minutes all resolved to
    // the same rule and the same number, and nothing noticed.
    const [q60, q90, q120] = await Promise.all([
      ok(`/api/quote?date=${DATE}&time=19:00&duration=60`, { as: elin }),
      ok(`/api/quote?date=${DATE}&time=19:00&duration=90`, { as: elin }),
      ok(`/api/quote?date=${DATE}&time=19:00&duration=120`, { as: elin }),
    ]);
    expect(Number(q60.price.amount)).toBeLessThan(Number(q90.price.amount));
    expect(Number(q90.price.amount)).toBeLessThan(Number(q120.price.amount));

    // …and peak still outranks base at the same duration, which is the thing a
    // duration-only rule would silently break.
    const offPeak90 = await ok(`/api/quote?date=${DATE}&time=12:00&duration=90`, { as: elin });
    expect(Number(offPeak90.price.amount)).toBeLessThan(Number(q90.price.amount));
    // The quote is the same arithmetic book-court will do, so they cannot disagree.
    const sample = await ok('/api/bookings', {
      as: elin, method: 'POST',
      body: { memberId: elinM, date: DATE, time: '13:00', duration: 90 },
    });
    expect(sample.price.amount).toBe(quote.price.amount);

    // Booking with no resourceId at all: the vertical picks one.
    const booked = await ok('/api/bookings', {
      as: elin,
      method: 'POST',
      body: { memberId: elinM, date: DATE, time: '16:00', duration: 60, cover: ['open'] },
    });
    expect(booked.reservation.resourceId).toBeTruthy();
    const courts = await ok('/api/browse/courts', { as: elin });
    const picked = courts.find((c: any) => c.id === booked.reservation.resourceId);
    expect(picked.cover).toBe('open'); // honoured the filter
  });

  it('lists clubs and open matches across every club the caller can reach', async () => {
    // Discovery is not access. The club list comes from the DIRECTORY, so every
    // club exists to everyone — a player must be able to find a club they have
    // not joined, which is the whole point of a club list.
    const clubs = await ok('/api/clubs', { as: elin });
    expect(clubs.map((c: any) => c.key).sort()).toEqual(['goteborg', 'nacka', 'solna']);
    expect((await ok('/api/clubs', { as: rutger })).map((c: any) => c.key).sort()).toEqual([
      'goteborg', 'nacka', 'solna',
    ]);

    // Which of them she can ACT in is the separate question, and still narrow.
    expect((await ok('/api/my-venues', { as: elin })).map((v: any) => v.key).sort()).toEqual([
      'nacka', 'solna',
    ]);

    await ok('/api/matches', {
      as: elin, method: 'POST',
      body: {
        memberId: elinM, date: DATE, time: '18:00', duration: 90,
        fillTarget: 4, levelMin: '3.0', levelMax: '4.5',
      },
    });
    const everywhere = await ok('/api/matches?all=1', { as: elin });
    expect(everywhere.length).toBeGreaterThan(0);
    expect(everywhere.every((m: any) => m.venue && m.venueLabel)).toBe(true);
  });

  it('the CLUB can open a game nobody owns, with every place on offer', async () => {
    // The common case in a real club: staff open a court, no host, 4 places free.
    const clubGame = await ok('/api/matches', {
      as: astrid, method: 'POST',
      body: {
        date: DATE, time: '09:00', duration: 90,
        fillTarget: 4, levelMin: '2.0', levelMax: '5.0',
      },
    });
    const landing = await ok(`/api/matches/${clubGame.reservation.id}`, { as: elin });
    expect(landing.joined).toBe(0); // nobody is on it — the club is not a player
    expect(landing.players).toHaveLength(0);

    // …and a player can still sign up to it.
    await ok(`/api/matches/${clubGame.reservation.id}/join`, {
      as: elin, method: 'POST', body: { memberId: elinM },
    });
    expect((await ok(`/api/matches/${clubGame.reservation.id}`, { as: elin })).joined).toBe(1);
  });

  it('a player opens a booking they already hold, to find players', async () => {
    const b = await ok('/api/bookings', {
      as: elin, method: 'POST',
      body: { memberId: elinM, date: DATE, time: '07:00', duration: 90 },
    });
    await ok(`/api/bookings/${b.reservation.id}/confirm`, { as: elin, method: 'POST', body: {} });

    // It is private until she says otherwise: not on offer anywhere.
    expect(
      (await ok('/api/matches', { as: johan })).some(
        (m: any) => m.reservationId === b.reservation.id,
      ),
    ).toBe(false);

    const opened = await ok(`/api/bookings/${b.reservation.id}/open`, {
      as: elin, method: 'POST',
      body: { spots: 3, levelMin: '3.0', levelMax: '4.5' },
    });
    expect(opened.reservation.fillTarget).toBe(4); // she is on it + 3 places

    const offered = (await ok('/api/matches', { as: johan })).find(
      (m: any) => m.reservationId === b.reservation.id,
    );
    expect(offered.joined).toBe(1);
    expect(offered.players[0].name).toBe('Elin Kastberg');
  });

  it('a match shows WHO is playing; the club roster stays shut', async () => {
    const made = await ok('/api/matches', {
      as: elin, method: 'POST',
      body: {
        memberId: elinM, date: DATE, time: '17:00', duration: 90,
        fillTarget: 4, levelMin: '3.0', levelMax: '4.5',
      },
    });
    const landing = await ok(`/api/matches/${made.reservation.id}`, { as: johan });
    // Publishing a match IS the consent: you cannot ask someone to commit to
    // three anonymous slots.
    expect(landing.players).toHaveLength(1);
    expect(landing.players[0].name).toBe('Elin Kastberg');
    expect(landing.players[0].level).toBe('3.4');

    // …and it is still not a door to the customer list.
    expect((await call('/api/members', { as: johan })).status).toBe(403);
  });

  it('people you have played with, at this club', async () => {
    const played = await ok(`/api/played-with?memberId=${elinM}`, { as: elin });
    expect(Array.isArray(played)).toBe(true);
    // Elin's own record is never in her own list.
    expect(played.every((p: any) => p.name !== 'Elin Kastberg')).toBe(true);
    // And it is narrowed: she cannot read Johan's.
    expect((await call(`/api/played-with?memberId=${johanM}`, { as: elin })).status).toBe(403);
  });

  // -- what reception does all day -----------------------------------------

  it('reception books, moves, marks a no-show and cancels', async () => {
    const b = await ok('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: johanM, date: DATE, time: '11:30', duration: 60 },
    });
    const id = b.reservation.id;
    await ok(`/api/bookings/${id}/confirm`, { as: ravi, method: 'POST', body: {} });

    const detail = await ok(`/api/reservations/${id}`, { as: ravi });
    expect(detail.reservation.id).toBe(id);

    const moved = await ok(`/api/bookings/${id}/move`, {
      as: ravi,
      method: 'POST',
      body: { startsAt: new Date(Date.parse(b.reservation.startsAt) + 3600_000).toISOString() },
    });
    expect(moved.startsAt).not.toBe(b.reservation.startsAt);

    await ok(`/api/bookings/${id}/players`, {
      as: ravi,
      method: 'POST',
      body: { memberId: elinM },
    });
    await ok(`/api/bookings/${id}/no-show`, { as: ravi, method: 'POST', body: {} });

    const c = await ok('/api/bookings', {
      as: ravi,
      method: 'POST',
      body: { resourceId: court, memberId: johanM, date: DATE, time: '15:00', duration: 60 },
    });
    await ok(`/api/bookings/${c.reservation.id}/cancel`, {
      as: ravi, method: 'POST', body: { reason: 'kund' },
    });

    const day = await ok(
      `/api/reservations?from=${DATE}T00:00:00.000Z&to=${DATE}T23:59:59.999Z`,
      { as: ravi },
    );
    expect(day.length).toBeGreaterThan(0);
    await ok(`/api/timeline?entityType=reservation&entityId=${id}`, { as: ravi });
  });

  // -- what an owner configures --------------------------------------------

  it('an owner configures the club and reads its numbers', async () => {
    await ok('/api/venue', {
      as: astrid, method: 'POST',
      body: { name: 'RallyPoint Solna', timezone: 'Europe/Stockholm', holdMinutes: 10 },
    });
    await ok('/api/hours', {
      as: astrid, method: 'POST', body: { weekday: 3, opensAt: '07:00', closesAt: '23:00' },
    });
    const newCourt = await ok('/api/courts', {
      as: astrid, method: 'POST', body: { name: 'Bana 9', durations: '60,90' },
    });
    await ok('/api/court-hours', {
      as: astrid, method: 'POST',
      body: { resourceId: newCourt.id, weekday: 3, opensAt: '09:00', closesAt: '21:00' },
    });
    await ok(`/api/courts/${newCourt.id}/active`, {
      as: astrid, method: 'POST', body: { active: false },
    });
    await ok('/api/closures', {
      as: astrid, method: 'POST', body: { onDate: soon(40), reason: 'Klubbmästerskap' },
    });
    await ok('/api/price-rules', {
      as: astrid, method: 'POST', body: { label: 'Morgon', fromTime: '06:00', toTime: '09:00', amount: '200' },
    });
    await ok('/api/packs', {
      as: astrid, method: 'POST',
      body: { key: 'klipp-3', title: '3 för 2', priceOre: 68000, creditOre: 102000 },
    });
    await ok('/api/plans', {
      as: astrid, method: 'POST',
      body: { key: 'guld', title: 'Guld', monthlyOre: 199900, monthlyCreditOre: 250000 },
    });
    await ok('/api/members', {
      as: astrid, method: 'POST',
      body: { partyRef: '01JTESTAAAAAAAAAAAAAAAAAAB', name: 'Ny Spelare' },
    });

    // The resolved grid, not the rule list — a hole in the matrix is invisible
    // in the rules and obvious here.
    const matrix = await ok(`/api/price-matrix?date=${DATE}`, { as: astrid });
    expect(matrix.length).toBeGreaterThan(0);
    const evening = matrix.find((r: any) => r.time === '19:00');
    const amounts = evening.cells.map((c: any) => Number(c.amount));
    expect(new Set(amounts).size).toBe(3); // three lengths, three prices

    const occ = await ok(`/api/occupancy?from=${DATE}&to=${DATE}`, { as: astrid });
    expect(occ.openHours).toBeGreaterThan(0);
    const roles = await ok('/api/roles', { as: astrid });
    expect(roles.map((r: any) => r.key).sort()).toEqual(['club-admin', 'coach', 'receptionist']);

    await ok('/api/maintenance', {
      as: astrid, method: 'POST',
      body: { resourceId: court, date: DATE, time: '12:00', duration: 60, reason: 'Omslipning' },
    });
  });

  // -- inviting a player, through the surface the desk actually uses ---------

  it('invite → accept → roster, and revocation closes the door', async () => {
    // The desk invites by name and email only — no partyRef (the module mints
    // the player ref) and no orgId (the server pins it to the venue).
    const { invitationId } = await ok('/api/invites', {
      as: astrid, method: 'POST',
      // The address the issuer will assert for `dev|saga` — the acceptance is checked
      // against the TOKEN now, so the invite has to name the same address.
      body: { name: 'Saga Lindqvist', identifier: 'saga@test.invalid' },
    });

    // The desk sees it under the name the club filed it as.
    const open = await ok('/api/invites', { as: astrid });
    expect(open.find((i: any) => i.id === invitationId)).toMatchObject({
      state: 'invited',
      name: 'Saga Lindqvist',
    });

    // Being invited confers nothing.
    const before = await ok('/api/members', { as: astrid });
    expect(before.some((m: any) => m.name === 'Saga Lindqvist')).toBe(false);

    // The recipient accepts as a FRESH login — a subject the directory has never seen.
    // The proof the engine re-hashes is the email from the VERIFIED token, so the body
    // carries only the invitation id: the acceptor cannot name their own identifier any
    // more, which is what the dev-header path used to let them do.
    await ok('/api/invites/accept', {
      as: 'dev|saga', method: 'POST',
      body: { invitationId },
    });

    // ...and only now does the roster have them.
    const after = await ok('/api/members', { as: astrid });
    expect(after.some((m: any) => m.name === 'Saga Lindqvist')).toBe(true);

    // And the member row is BOUND to the login that accepted. Joining by invitation is
    // the only way a real install gains a player, and the consumer was dropping the
    // principal the acceptance handed it — so `whoami` answered `memberId: null` and
    // Saga's own app showed her the "you belong to no club here" screen while the desk
    // could see her on the roster. Asserted through whoami, because that read is the
    // only thing the player app has.
    const saga = await ok('/api/whoami', { as: 'dev|saga' });
    expect(saga.memberId).not.toBeNull();
    expect(after.find((m: any) => m.name === 'Saga Lindqvist').id).toBe(saga.memberId);

    // The wrong email is refused — and the refusal does not say why.
    const second = await ok('/api/invites', {
      as: astrid, method: 'POST',
      body: { name: 'Andra Spelaren', identifier: 'andra@test.invalid' },
    });
    // The wrong PERSON, which is now the only way to be wrong: `dev|fel` presents a
    // token asserting fel@test.invalid, and the invitation was hashed against andra's.
    const wrong = await call('/api/invites/accept', {
      as: 'dev|fel', method: 'POST',
      body: { invitationId: second.invitationId },
    });
    expect(wrong.status).toBe(400);

    // Revoked: the RIGHT email now fails the same, indistinguishable way.
    await ok(`/api/invites/${second.invitationId}/revoke`, { as: astrid, method: 'POST' });
    const revoked = await call('/api/invites/accept', {
      as: 'dev|andra', method: 'POST',
      body: { invitationId: second.invitationId },
    });
    expect(revoked.status).toBe(400);

    // Desk vocabulary, not engine keys: the receptionist runs this flow too,
    // the coach does not, and nobody anonymous reaches the engine at all.
    expect((await call('/api/invites', { as: ravi })).status).toBe(200);
    expect((await call('/api/invites', { as: nils })).status).toBe(403);
    // Anonymous is 401 — the ONE answer this route separates out, and it is not a
    // refusal of the invitation. The two above (400) still say nothing about which way
    // the invitation was wrong; this one says nothing about the invitation at all,
    // because the session is asked about first. The recipient's screen turns it into a
    // sign-in button instead of telling them their good link was bad.
    expect(
      (await call('/api/invites/accept', {
        method: 'POST',
        body: { invitationId },
      })).status,
    ).toBe(401);
  });

  // -- the denials, at the surface a browser actually hits -------------------

  it('every boundary answers the same way through HTTP as it does in-scope', async () => {
    // Coach: reads the calendar, books nothing.
    expect((await call('/api/reservations', { as: nils })).status).toBe(200);
    expect(
      (await call('/api/bookings', {
        as: nils, method: 'POST',
        body: { resourceId: court, memberId: elinM, date: DATE, time: '13:00', duration: 60 },
      })).status,
    ).toBe(403);

    // Receptionist: books all day, re-cuts nothing.
    expect((await call('/api/hours', { as: ravi, method: 'POST', body: { weekday: 2 } })).status).toBe(403);
    expect((await call('/api/roles', { as: ravi })).status).toBe(403);

    // Player: no roster, no book, no roles, no other wallet.
    expect((await call('/api/roles', { as: elin })).status).toBe(403);
    expect((await call(`/api/wallet?memberId=${johanM}`, { as: elin })).status).toBe(403);
    expect((await call(`/api/occupancy?from=${DATE}&to=${DATE}`, { as: elin })).status).toBe(403);

    // No principal at all.
    expect((await call('/api/venue')).status).toBe(403);

    // Another company's admin, pointed at this club's scope. Note this is 403
    // and NOT the `unknown scope` 404 the in-scope test sees: there, the
    // attacker names the (tenant, scope) pair himself and gets it wrong. Here
    // the SERVER supplies the pair from its venue table, so he cannot mis-pair
    // it — he reaches a real scope and is refused by the permission model
    // instead. A stronger answer, from one layer further in.
    expect((await call('/api/members', { as: rutger, venue: 'solna' })).status).toBe(403);
  });

  // -- the guard that makes "shipped but unreachable" a red build -----------

  it('every registered route is exercised by these flows', () => {
    const registered = new Set(
      app.routes
        .filter((r) => r.path.startsWith('/api'))
        .map((r) => `${r.method} ${r.path.replace(/:[a-zA-Z]+/g, ':id')}`),
    );
    const untested = [...registered].filter((r) => !seen.has(r)).sort();
    expect({ untested }).toEqual({ untested: [] });
  });
});
