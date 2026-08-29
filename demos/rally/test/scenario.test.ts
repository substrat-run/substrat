import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { manualClock, ulid, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { principalId, type Money,
  type Page,
} from '@substrat-run/contracts';
import type { Reservation } from '@substrat-run/engine-booking';
import {
  RALLY_PLATFORM_ACTOR,
  buildRallyHost,
  seedRally,
  zonedToInstant,
  type MemberRow,
  type RallyWorld,
  type SlotFit,
} from '../src/index.js';

/**
 * The RallyPoint scenario (spec/concept.md §11): provision → venue hours →
 * priced booking → the lost race → hold expiry → maintenance → open match →
 * portal isolation → the cross-tenant attack.
 *
 * The suite is deterministic — and does not rot when the fixture dates fall into
 * the past — because the HOST runs on a clock this file owns. It used to pin the
 * instant by sending `now` on every clock-sensitive call, which meant the wire
 * carried the clock: #1065 removed that, so the pin moved to where it belongs and
 * these calls now travel exactly the path an HTTP caller does.
 */
describe('RallyPoint demo scenario (spec §11)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: RallyWorld;
  let astrid: ScopeStub; // club-admin
  let ravi: ScopeStub; // receptionist @ Solna
  let nils: ScopeStub; // coach

  // 2026-07-20 is inside CEST (UTC+2), so 19:00 local is 17:00Z.
  const DATE = '2026-07-20';
  const NOW = '2026-07-20T06:00:00.000Z';
  const LATER = '2026-07-20T06:11:00.000Z'; // past a 10-minute hold
  const clock = manualClock(NOW);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-rally-'));
    host = buildRallyHost(dir, { clock: clock.read });
    w = await seedRally(host, dir);
    astrid = await host.getScope(w.astrid, w.t1, w.s1);
    ravi = await host.getScope(w.ravi, w.t1, w.s1);
    nils = await host.getScope(w.nils, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies every module journal', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/demo-rally',
      '@substrat-run/engine-booking',
      '@substrat-run/engine-invites',
      '@substrat-run/engine-invoicing',
    ]);
  });

  it('2. converts local wall time to an instant across the DST offset', () => {
    // The engine is timezone-free; this conversion is the vertical's whole job.
    expect(zonedToInstant(DATE, '19:00', 'Europe/Stockholm')).toBe('2026-07-20T17:00:00.000Z');
    // Winter, the same wall clock is UTC+1.
    expect(zonedToInstant('2026-01-20', '19:00', 'Europe/Stockholm')).toBe(
      '2026-01-20T18:00:00.000Z',
    );
  });

  it('3. availability reports which durations actually fit each start', async () => {
    const slots = (await ravi.invoke<Page<SlotFit>>('rally/availability', {
      resourceId: w.court1,
      date: DATE,
    })).entries;
    expect(slots.length).toBeGreaterThan(0);
    // An empty court opens at 07:00 local and every duration fits.
    expect(slots[0]!.startsAt).toBe(zonedToInstant(DATE, '07:00', 'Europe/Stockholm'));
    expect(slots[0]!.fits).toEqual([60, 90, 120]);
    // Bana 2 is configured 90-only-and-under, so 120 never appears.
    const bana2 = (await ravi.invoke<Page<SlotFit>>('rally/availability', {
      resourceId: w.court2,
      date: DATE,
    })).entries;
    expect(bana2[0]!.fits).toEqual([60, 90]);
  });

  it('4. ravi books a peak slot: rule + tier resolve to the öre', async () => {
    const booked = await ravi.invoke<{
      reservation: Reservation;
      price: Money;
      ruleLabel: string;
    }>('rally/book-court', {
      resourceId: w.court1,
      memberId: w.elinId,
      date: DATE,
      time: '19:00',
      duration: 90,
    });
    expect(booked.reservation.state).toBe('held');
    expect(booked.reservation.startsAt).toBe('2026-07-20T17:00:00.000Z');
    // Högtrafik 17–21 = 340 kr flat. There is NO membership discount: padel
    // prices the court, not the customer. Duration is an input, not a multiplier.
    expect(booked.price.amount).toBe('340');
    expect(booked.ruleLabel).toContain('Högtrafik');

    const confirmed = await ravi.invoke<{ reservation: Reservation }>('rally/confirm-booking', {
      reservationId: booked.reservation.id,
    });
    expect(confirmed.reservation.state).toBe('confirmed');
  });

  it('5. THE LOST RACE: the second booking of the same slot is refused', async () => {
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1,
        memberId: w.johanId,
        date: DATE,
        time: '19:00',
        duration: 90,
      }),
    ).rejects.toThrow(/slot unavailable/i);
  });

  it('6. availability now shows the booked window gone', async () => {
    const slots = (await ravi.invoke<Page<SlotFit>>('rally/availability', {
      resourceId: w.court1,
      date: DATE,
    })).entries;
    const at19 = slots.find((s) => s.startsAt === '2026-07-20T17:00:00.000Z');
    expect(at19).toBeUndefined();
  });

  it('7. a hold that expires frees the slot again — no sweep', async () => {
    const held = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2,
      memberId: w.johanId,
      date: DATE,
      time: '09:00',
      duration: 60,
    });
    expect(held.reservation.state).toBe('held');

    // Same slot, asked for after the 10-minute hold lapsed. The lapse is real
    // time passing for the whole host, not a `now` this caller chose.
    clock.set(LATER);
    const second = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2,
      memberId: w.elinId,
      date: DATE,
      time: '09:00',
      duration: 60,
    });
    expect(second.reservation.state).toBe('held');

    // Back to the scenario's opening instant: every step after this one is
    // written against it, and the eleven minutes were this test's alone.
    clock.set(NOW);
  });

  it('8. bookings outside the opening window are refused by the vertical', async () => {
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1,
        memberId: w.elinId,
        date: DATE,
        time: '05:00', // club opens 07:00
        duration: 60,
      }),
    ).rejects.toThrow(/outside opening hours/);
  });

  it('9. a duration the court does not offer is refused', async () => {
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court2, // 60/90 only
        memberId: w.elinId,
        date: DATE,
        time: '12:00',
        duration: 120,
      }),
    ).rejects.toThrow(/not bookable on this court/);
  });

  it('10. a closure shuts the day, and the calendar agrees', async () => {
    await astrid.invoke('rally/add-closure', {
      onDate: '2026-07-21',
      reason: 'Klubbmästerskap',
    });
    const slots = (await ravi.invoke<Page<SlotFit>>('rally/availability', {
      resourceId: w.court1,
      date: '2026-07-21',
    })).entries;
    expect(slots).toEqual([]);
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1, memberId: w.elinId, date: '2026-07-21',
        time: '19:00', duration: 90,
      }),
    ).rejects.toThrow(/closed/);
  });

  it('11. maintenance blocks the court through the SAME overlap invariant', async () => {
    await astrid.invoke('rally/block-maintenance', {
      resourceId: w.court1,
      date: DATE,
      time: '13:00',
      duration: 120,
      reason: 'Omslipning',
    });
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court1, memberId: w.elinId, date: DATE,
        time: '13:00', duration: 60,
      }),
    ).rejects.toThrow(/slot unavailable/i);
  });

  it('12. an open match fills and auto-confirms on the last join', async () => {
    const match = await astrid.invoke<{
      reservation: Reservation;
      price: Money;
      sharePerPlayer: Money;
    }>('rally/create-open-match', {
      resourceId: w.court1,
      memberId: w.elinId,
      date: DATE,
      time: '20:30',
      duration: 90,
      fillTarget: 2,
      levelMin: '3.0',
      levelMax: '4.0',
    });
    // The host is already IN. Opening a court you are not on is never the intent,
    // and without it a 4-player match starts at 0/4 — the fill meter, the share
    // split and the auto-confirm would all count one short.
    expect(match.reservation.state).toBe('held'); // 1 of 2 — still filling
    expect(match.reservation.fillTarget).toBe(2);
    expect(match.sharePerPlayer.amount).toBe('170'); // 340 / 2

    const detail = await astrid.invoke<{ participants: unknown[] }>('booking/get', {
      reservationId: match.reservation.id,
    });
    expect(detail.participants).toHaveLength(1);

    // …so the host cannot double-join their own match.
    await expect(
      astrid.invoke('rally/join-match', {
        reservationId: match.reservation.id, memberId: w.elinId,
      }),
    ).rejects.toThrow(/already joined/);

    const second = await astrid.invoke<{ reservation: Reservation }>('rally/join-match', {
      reservationId: match.reservation.id, memberId: w.johanId,
    });
    expect(second.reservation.state).toBe('confirmed'); // the 2nd tips it
  });

  it('13. the level band is vertical policy and it holds', async () => {
    const match = await astrid.invoke<{ reservation: Reservation }>('rally/create-open-match', {
      resourceId: w.court2, memberId: w.elinId, date: DATE,
      time: '15:00', duration: 60, fillTarget: 2,
      levelMin: '4.5', levelMax: '6.0',
    });
    // Elin is 3.4 — below her own match's band.
    await expect(
      astrid.invoke('rally/join-match', {
        reservationId: match.reservation.id, memberId: w.elinId,
      }),
    ).rejects.toThrow(/outside the band/);
  });

  it('14. the denials hold: coach, receptionist, and the cross-tenant attacker', async () => {
    // A coach may read the calendar but never take a booking.
    await expect(
      nils.invoke('rally/book-court', {
        resourceId: w.court1, memberId: w.elinId, date: DATE,
        time: '11:00', duration: 60,
      }),
    ).rejects.toThrow(/permission denied/);

    // A receptionist takes bookings but does not re-cut the club's hours.
    await expect(
      ravi.invoke('rally/set-hours', { weekday: 3, opensAt: '06:00', closesAt: '23:00' }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      ravi.invoke('booking/create-resource', { kind: 'court', name: 'Smygbana' }),
    ).rejects.toThrow(/permission denied/);

    // Ravi holds a role at Solna only — Nacka is not his.
    await expect(host.getScope(w.ravi, w.t1, w.s1b)).resolves.toBeDefined();
    const raviNacka = await host.getScope(w.ravi, w.t1, w.s1b);
    await expect(raviNacka.invoke('rally/list-members')).rejects.toThrow(/permission denied/);

    // Rutger runs another club. Claiming RallyPoint's scope under his own tenant
    // is not a permission failure — the scope does not exist for him at all.
    await expect(host.getScope(w.rutger, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    const rutger = await host.getScope(w.rutger, w.t2, w.s2);
    // A paged read answers with an envelope; an empty scope is an empty page.
    await expect(rutger.invoke('rally/list-members')).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
  });

  it('15. the coach read is the WHOLE calendar — deliberate, not an oversight', async () => {
    // Accepted at the permission checkpoint (spec §9): a coach holds plain
    // booking:read, so they see every court and every booking — not only their
    // own lessons. Pinned here so narrowing it later is a visible, tested change
    // rather than a silent one.
    const coachSees = (await nils.invoke<Page<Reservation>>('rally/portal-bookings')).entries;
    const staffSees = (await astrid.invoke<Page<Reservation>>('rally/portal-bookings')).entries;
    expect(coachSees.length).toBe(staffSees.length);
    expect(coachSees.length).toBeGreaterThan(0);

    // Read-only, though: no writes of any kind.
    await expect(
      nils.invoke('rally/create-member', { partyRef: w.johanParty, name: 'Smyg' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('16. a player browses free slots and books, without reading the club’s book', async () => {
    const elin = await host.getScope(w.elin, w.t1, w.s1);

    // Holds NO role. Browsing is a scope-wide grant: free/busy carries no identities.
    const courts = (await elin.invoke<Page<{ id: string; name: string }>>('rally/courts')).entries;
    expect(courts.length).toBeGreaterThan(0);
    const slots = (await elin.invoke<Page<SlotFit>>('rally/availability', {
      resourceId: w.court2,
      date: DATE,
    })).entries;
    expect(slots.length).toBeGreaterThan(0);

    // Taking a free court is public capability; the booking becomes hers.
    const booked = await elin.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2, memberId: w.elinId, date: DATE,
      time: '16:00', duration: 60,
    });
    const confirmed = await elin.invoke<{ reservation: Reservation }>('rally/confirm-booking', {
      reservationId: booked.reservation.id,
    });
    expect(confirmed.reservation.state).toBe('confirmed');

    // But she still cannot read the roster or the club's own surfaces.
    await expect(elin.invoke('rally/list-members')).rejects.toThrow(/permission denied/);
    await expect(elin.invoke('booking/list')).rejects.toThrow(/permission denied/);
  });

  it('17. portal isolation: a player sees their own booking and no one else’s', async () => {
    const elin = await host.getScope(w.elin, w.t1, w.s1);
    const johan = await host.getScope(w.johan, w.t1, w.s1);

    const elinsBookings = (await elin.invoke<Page<Reservation>>('rally/portal-bookings')).entries;
    const johansBookings = (await johan.invoke<Page<Reservation>>('rally/portal-bookings')).entries;

    // Both must be non-empty, or "no overlap" would be vacuously true.
    expect(elinsBookings.length).toBeGreaterThan(0);
    expect(johansBookings.length).toBeGreaterThan(0);
    const elinIds = new Set(elinsBookings.map((r) => r.id));
    for (const r of johansBookings) expect(elinIds.has(r.id)).toBe(false);

    // Neither sees the club's full book: staff see strictly more.
    const all = (await astrid.invoke<Page<Reservation>>('rally/portal-bookings')).entries;
    expect(all.length).toBeGreaterThan(elinsBookings.length + johansBookings.length - 1);

    // And the portal principal cannot reach staff surfaces at all.
    await expect(elin.invoke('rally/list-members')).rejects.toThrow(/permission denied/);
    await expect(elin.invoke('rally/set-hours', { weekday: 1 })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('18. the state machine cannot skip', async () => {
    const booked = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court1, memberId: w.elinId, date: DATE,
      time: '08:00', duration: 60,
    });
    await ravi.invoke('rally/confirm-booking', {
      reservationId: booked.reservation.id,
    });
    await expect(
      ravi.invoke('rally/confirm-booking', { reservationId: booked.reservation.id }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('19. floodlights are priced by SEASON, not by the clock', async () => {
    // Same wall-clock hour, six months apart. In July 16:00 is daylight and
    // costs base rate; in December it is pitch dark and the lights are billed.
    const july = await ravi.invoke<{ price: Money; ruleLabel: string }>('rally/book-court', {
      resourceId: w.court1, memberId: w.elinId, date: DATE,
      time: '16:00', duration: 60,
    });
    expect(july.price.amount).toBe('220'); // Bas, 60 min
    expect(july.ruleLabel).toContain('Bas');

    const december = await ravi.invoke<{ price: Money; ruleLabel: string }>('rally/book-court', {
      resourceId: w.court1, memberId: w.elinId, date: '2026-12-15',
      time: '16:00', duration: 60,
    });
    // Winter dark at 16:00: the floodlight rule for 60 min, not the base rate.
    expect(december.price.amount).toBe('340');
    expect(december.ruleLabel).toContain('Belysning');
  });

  it('20. a credit pack gives more than it charges', async () => {
    const bought = await astrid.invoke<{ balance: Money; paid: Money; received: Money }>(
      'rally/buy-credits',
      { memberId: w.johanId, packKey: 'klipp-5' },
    );
    // Five games at 340, paid for four.
    expect(bought.paid.amount).toBe('1360');
    expect(bought.received.amount).toBe('1700');
    expect(bought.balance.amount).toBe('1700');
  });

  it('21. paying from the wallet debits exactly the court price', async () => {
    const booked = await astrid.invoke<{ reservation: Reservation; price: Money }>(
      'rally/book-court',
      {
        resourceId: w.court2, memberId: w.johanId, date: DATE,
        time: '11:00', duration: 60,
      },
    );
    const paid = await astrid.invoke<{
      reservation: Reservation;
      paidFromWallet: boolean;
      balance: Money | null;
    }>('rally/confirm-booking', {
      reservationId: booked.reservation.id, payWith: 'wallet',
    });
    expect(paid.reservation.state).toBe('confirmed');
    expect(paid.paidFromWallet).toBe(true);
    expect(paid.balance!.amount).toBe('1480'); // 1700 − 220 (Bas, 60 min)
  });

  it('22. ATOMICITY: an unaffordable booking leaves neither a charge nor a court', async () => {
    // Elin has no balance at all.
    const booked = await astrid.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2, memberId: w.elinId, date: DATE,
      time: '12:00', duration: 60,
    });
    await expect(
      astrid.invoke('rally/confirm-booking', {
        reservationId: booked.reservation.id, payWith: 'wallet',
      }),
    ).rejects.toThrow(/insufficient balance/);

    // The debit and the confirm are one transaction in one Durable Object, so
    // the rollback took the confirm with it: still held, and no ledger entry.
    const after = await astrid.invoke<{ reservation: Reservation }>('booking/get', {
      reservationId: booked.reservation.id,
    });
    expect(after.reservation.state).toBe('held');
    const wallet = await astrid.invoke<{ balance: Money; entries: unknown[] }>('rally/wallet', {
      memberId: w.elinId,
    });
    expect(wallet.balance.amount).toBe('0');
    expect(wallet.entries).toHaveLength(0);
  });

  it('23. a subscription is a wallet topped up on a schedule', async () => {
    await astrid.invoke('rally/subscribe', {
      memberId: w.elinId, planKey: 'manadskort', on: '2026-08-01',
    });
    const first = await astrid.invoke<{ charged: number; creditedOre: number }>('rally/run-billing', {
      on: '2026-08-01',
    });
    expect(first.charged).toBe(1);
    expect(first.creditedOre).toBe(120000); // pays 999 kr, receives 1200 kr

    const wallet = await astrid.invoke<{ balance: Money }>('rally/wallet', {
      memberId: w.elinId,
    });
    expect(wallet.balance.amount).toBe('1200');

    // Idempotent within the month: the cycle advanced next_charge_on.
    const again = await astrid.invoke<{ charged: number }>('rally/run-billing', { on: '2026-08-15' });
    expect(again.charged).toBe(0);

    const next = await astrid.invoke<{ charged: number }>('rally/run-billing', { on: '2026-09-01' });
    expect(next.charged).toBe(1);
  });

  it('24. a player reads their own wallet and nobody else’s', async () => {
    const elin = await host.getScope(w.elin, w.t1, w.s1);
    await expect(elin.invoke('rally/wallet', { memberId: w.elinId })).resolves.toBeDefined();
    await expect(elin.invoke('rally/wallet', { memberId: w.johanId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('25. members are the vertical’s vocabulary, keyed to a global player ref', async () => {
    const members = (await astrid.invoke<Page<MemberRow>>('rally/list-members')).entries;
    expect(members.map((m) => m.name).sort()).toEqual(['Elin Kastberg', 'Johan Ek']);
    expect(members.find((m) => m.name === 'Elin Kastberg')!.party_ref).toBe(w.elinParty);
  });
});

/**
 * The invite path, end to end (#35). The first thing in the repo that exercises
 * the whole seam at once: a vertical composes the invites engine, the engine
 * emits rather than writing, an out-of-band executor effects the KERNEL
 * membership, and the vertical's own consumer creates the club's member row.
 *
 * Two records, two owners, one acceptance — the property that could not be
 * checked by reading the design.
 */
describe('RallyPoint: inviting a player', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: RallyWorld;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rally-invite-'));
    host = buildRallyHost(dir);
    w = await seedRally(host, dir);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns an accepted invitation into a kernel membership AND a club member row', async () => {
    const admin = await host.getScope(w.astrid, w.t1, w.s1);
    const partyRef = ulid();
    const { invitationId } = await admin.invoke<{ invitationId: string }>('rally/invite-player', {
      orgId: w.org1,
      identifier: 'ny.spelare@example.com',
      name: 'Ny Spelare',
      partyRef,
    });

    // Nothing yet: an invitation confers nothing until the recipient acts.
    expect(await host.admin.listMembers(RALLY_PLATFORM_ACTOR, w.t1, w.org1)).toEqual([]);

    const newcomer = principalId.parse(ulid());
    const theirs = await host.getScope(newcomer, w.t1, w.s1);
    await theirs.invoke('invites/accept', {
      invitationId,
      identifier: 'ny.spelare@example.com',
    });

    // The KERNEL membership — effected by the executor, never by the engine.
    const members = await host.admin.listMembers(RALLY_PLATFORM_ACTOR, w.t1, w.org1);
    expect(members.map((m) => m.principal)).toEqual([newcomer]);

    // ...and RallyPoint's OWN record, from its consumer on the same acceptance.
    const roster = (await admin.invoke<Page<MemberRow>>('rally/list-members')).entries;
    expect(roster.find((m) => m.party_ref === partyRef)?.name).toBe('Ny Spelare');

    // The split trail joins: the admin row names the event that caused it.
    const added = (await host.admin.auditLog(RALLY_PLATFORM_ACTOR, { tenantId: w.t1 })).find(
      (e) => e.action === 'addMember',
    );
    expect(added?.causedBy).toEqual(expect.any(String));
  });

  it('does not leak whether an address has already been invited', async () => {
    const admin = await host.getScope(w.astrid, w.t1, w.s1);
    const invite = () =>
      admin.invoke<{ invitationId: string }>('rally/invite-player', {
        orgId: w.org1,
        identifier: 'samma@example.com',
        name: 'Samma Person',
        partyRef: ulid(),
      });
    // Re-inviting must succeed and look identical, or a club can probe the
    // platform's membership one address at a time.
    const first = await invite();
    expect((await invite()).invitationId).toBe(first.invitationId);
  });
});
