import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dataSubjectId, moneyOf, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { manualClock } from '@substrat-run/kernel';
import {
  PERM,
  SlotUnavailable,
  availability,
  bookingModule,
  cancelReservation,
  completeReservation,
  confirmReservation,
  createResource,
  expireReservation,
  getReservation,
  holdReservation,
  joinReservation,
  leaveReservation,
  listReservations,
  moveReservation,
  openReservation,
  type FreeInterval,
  type Reservation,
  type Resource,
} from '../src/index.js';

/**
 * The reservation engine, tested directly.
 *
 * Every test pins `now` explicitly rather than leaning on the wall clock, so the
 * suite is deterministic and does not rot when the fixture dates fall into the
 * past. The in-scope calls pass it; the operations cannot be handed one (#961),
 * so the host's clock is pinned to the same instant and moved on purpose.
 */

const NOW = '2026-07-20T12:00:00.000Z';
const EXPIRES = '2026-07-20T12:10:00.000Z';
const AFTER_EXPIRY = '2026-07-20T12:11:00.000Z';

const T17 = '2026-07-20T17:00:00.000Z';
const T1730 = '2026-07-20T17:30:00.000Z';
const T1830 = '2026-07-20T18:30:00.000Z';
const T19 = '2026-07-20T19:00:00.000Z';
const T2030 = '2026-07-20T20:30:00.000Z';

/**
 * Participants are data subjects, so `partyRef` is a ULID-shaped DataSubjectId —
 * it keys crypto-shredding. Crockford base32 excludes I, L, O and U.
 */
const player = (n: number) => dataSubjectId.parse(`01JPADEK${'A'.repeat(17)}${n}`);

describe('engine-booking', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;
  const clock = manualClock(NOW);

  beforeEach(async () => {
    clock.set(NOW);
    h = await engineHarness({ modules: [bookingModule], clock: clock.read });
    staff = await h.as([
      PERM.create,
      PERM.read,
      PERM.hold,
      PERM.confirm,
      PERM.cancel,
      PERM.move,
      PERM.complete,
      PERM.manageResources,
    ]);
  });
  afterEach(async () => {
    await h.close();
  });

  const court = (name = 'Bana 1', capacity?: number) =>
    h.run((ctx) => createResource(ctx, { kind: 'court', name, capacity }));

  const hold = (
    resourceId: string,
    startsAt = T17,
    endsAt = T1830,
    extra: Record<string, unknown> = {},
  ) =>
    h.run((ctx) =>
      holdReservation(ctx, { resourceId, startsAt, endsAt, expiresAt: EXPIRES, now: NOW, ...extra }),
    );

  // -- resources -----------------------------------------------------------

  it('creates a court with capacity 1 by default', async () => {
    const r = await court();
    expect(r.capacity).toBe(1);
    expect(r.active).toBe(true);
    expect(h.eventsOfType('booking.resource-created')).toHaveLength(1);
  });

  // -- the allocation invariant -------------------------------------------

  it('holds a free slot and confirms it', async () => {
    const r = await court();
    const held = await hold(r.id);
    expect(held.state).toBe('held');
    expect(held.expiresAt).toBe(EXPIRES);

    const confirmed = await h.run((ctx) =>
      confirmReservation(ctx, { reservationId: held.id, now: NOW }),
    );
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.expiresAt).toBeNull();
    expect(h.eventsOfType('booking.confirmed')).toHaveLength(1);
  });

  it('rejects an overlapping hold with SlotUnavailable — no lock involved', async () => {
    const r = await court();
    await hold(r.id);
    await expect(hold(r.id)).rejects.toThrow(SlotUnavailable);
  });

  it('rejects a partial overlap, not just an exact one', async () => {
    const r = await court();
    await hold(r.id, T17, T19);
    await expect(hold(r.id, T1830, T2030)).rejects.toThrow(SlotUnavailable);
  });

  it('treats intervals as HALF-OPEN: back-to-back bookings do not collide', async () => {
    const r = await court();
    await hold(r.id, T17, T1830);
    const next = await hold(r.id, T1830, T19); // starts exactly where the last ends
    expect(next.state).toBe('held');
  });

  it('compares instants by moment, not by string — an offset and a Z collide', async () => {
    const r = await court();
    await hold(r.id, T17, T1830); // 17:00Z–18:30Z
    // 19:00+02:00 IS 17:00Z. A naive lexicographic compare would miss this.
    await expect(
      hold(r.id, '2026-07-20T19:00:00+02:00', '2026-07-20T20:30:00+02:00'),
    ).rejects.toThrow(SlotUnavailable);
  });

  it('frees the slot lazily once a hold expires — no sweep required', async () => {
    const r = await court();
    await hold(r.id);
    await expect(hold(r.id)).rejects.toThrow(SlotUnavailable);

    // Same slot, but asked for after the hold's deadline.
    const later = await h.run((ctx) =>
      holdReservation(ctx, {
        resourceId: r.id,
        startsAt: T17,
        endsAt: T1830,
        expiresAt: '2026-07-20T12:20:00.000Z',
        now: AFTER_EXPIRY,
      }),
    );
    expect(later.state).toBe('held');
  });

  it('refuses to confirm a hold that has expired', async () => {
    const r = await court();
    const held = await hold(r.id);
    await expect(
      h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: AFTER_EXPIRY })),
    ).rejects.toThrow(/expired/);
  });

  it('expireReservation moves held → expired and emits', async () => {
    const r = await court();
    const held = await hold(r.id);
    const expired = await h.run((ctx) =>
      expireReservation(ctx, { reservationId: held.id, now: AFTER_EXPIRY }),
    );
    expect(expired.state).toBe('expired');
    expect(h.eventsOfType('booking.expired')).toHaveLength(1);
  });

  it('will not expire a hold that is still alive', async () => {
    const r = await court();
    const held = await hold(r.id);
    await expect(
      h.run((ctx) => expireReservation(ctx, { reservationId: held.id, now: NOW })),
    ).rejects.toThrow(/not expired yet/);
  });

  it('rejects a hold whose deadline is already past', async () => {
    const r = await court();
    await expect(
      h.run((ctx) =>
        holdReservation(ctx, {
          resourceId: r.id,
          startsAt: T17,
          endsAt: T1830,
          expiresAt: NOW,
          now: AFTER_EXPIRY,
        }),
      ),
    ).rejects.toThrow(/already be expired/);
  });

  it('rejects an inverted interval', async () => {
    const r = await court();
    await expect(hold(r.id, T1830, T17)).rejects.toThrow();
  });

  it('rejects booking an inactive resource', async () => {
    const r = await court();
    await staff.invoke('booking/set-resource-active', { resourceId: r.id, active: false });
    await expect(hold(r.id)).rejects.toThrow(/inactive/);
  });

  // -- capacity > 1 (fungible pools) --------------------------------------

  it('allows concurrent allocations up to capacity, then rejects', async () => {
    const rackets = await court('Racketpool', 3);
    await hold(rackets.id);
    await hold(rackets.id);
    await hold(rackets.id);
    await expect(hold(rackets.id)).rejects.toThrow(SlotUnavailable);
  });

  it('counts quantity, not just rows, against capacity', async () => {
    const rackets = await court('Racketpool', 3);
    await hold(rackets.id, T17, T1830, { quantity: 2 });
    await expect(hold(rackets.id, T17, T1830, { quantity: 2 })).rejects.toThrow(SlotUnavailable);
    const ok = await hold(rackets.id, T17, T1830, { quantity: 1 });
    expect(ok.state).toBe('held');
  });

  // -- the open match: fill target auto-confirms ---------------------------

  it('auto-confirms when the fill target is reached — the open-match mechanic', async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 4 });

    const join = (partyRef: ReturnType<typeof player>) =>
      h.run((ctx) =>
        joinReservation(ctx, {
          reservationId: match.id,
          partyRef,
          share: moneyOf('120', 'SEK'),
          now: NOW,
        }),
      );

    for (const p of [player(1), player(2), player(3)]) {
      const { reservation } = await join(p);
      expect(reservation.state).toBe('held'); // still filling
    }

    const { reservation } = await join(player(4));
    expect(reservation.state).toBe('confirmed'); // the 4th tips it
    expect(h.eventsOfType('booking.participant-joined')).toHaveLength(4);
    expect(h.eventsOfType('booking.confirmed')).toHaveLength(1);
  });

  it('refuses a duplicate party and a full match', async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 2 });
    const join = (partyRef: ReturnType<typeof player>) =>
      h.run((ctx) => joinReservation(ctx, { reservationId: match.id, partyRef, now: NOW }));

    await join(player(1));
    await expect(join(player(1))).rejects.toThrow(/already joined/);
    await join(player(2)); // fills and confirms
    await expect(join(player(3))).rejects.toThrow(/full/);
  });

  it('leaving is a soft record — the row survives and the count drops', async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 4 });
    const { participant } = await h.run((ctx) =>
      joinReservation(ctx, { reservationId: match.id, partyRef: player(1), now: NOW }),
    );
    await h.run((ctx) =>
      leaveReservation(ctx, {
        reservationId: match.id,
        participantId: participant.id,
        now: NOW,
      }),
    );

    const { participants } = await staff.invoke<{ participants: { leftAt: string | null }[] }>(
      'booking/get',
      { reservationId: match.id },
    );
    expect(participants).toHaveLength(1); // not deleted
    expect(participants[0]!.leftAt).toBe(NOW);
    expect(h.eventsOfType('booking.participant-left')).toHaveLength(1);
  });

  // -- the state machine cannot skip --------------------------------------

  it('cannot complete a reservation that was never confirmed', async () => {
    const r = await court();
    const held = await hold(r.id);
    await expect(
      h.run((ctx) => completeReservation(ctx, { reservationId: held.id })),
    ).rejects.toThrow(/invalid transition/);
  });

  it('cannot cancel a completed reservation', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    await h.run((ctx) => completeReservation(ctx, { reservationId: held.id }));
    await expect(
      h.run((ctx) => cancelReservation(ctx, { reservationId: held.id })),
    ).rejects.toThrow(/invalid transition/);
  });

  it('a cancelled slot becomes bookable again', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    await expect(hold(r.id)).rejects.toThrow(SlotUnavailable);

    await h.run((ctx) => cancelReservation(ctx, { reservationId: held.id }));
    const again = await hold(r.id);
    expect(again.state).toBe('held');
  });

  // -- the fat completion event -------------------------------------------

  const playedMatch = async () => {
    const r = await court();
    const match = await hold(r.id, T17, T1830, { fillTarget: 2 });
    for (const n of [1, 2]) {
      await h.run((ctx) =>
        joinReservation(ctx, {
          reservationId: match.id,
          partyRef: player(n),
          share: moneyOf('120', 'SEK'),
          now: NOW,
        }),
      );
    }
    await h.run((ctx) => completeReservation(ctx, { reservationId: match.id }));
    return match;
  };

  it('completion carries the business facts and NO participant identities', async () => {
    await playedMatch();

    const [evt] = h.eventsOfType('booking.completed');
    const payload = evt!.payload as Record<string, unknown> & {
      resource: { name: string };
      startsAt: string;
      participantCount: number;
    };
    expect(evt!.schemaVersion).toBe(1);
    expect(payload.resource.name).toBe('Bana 1');
    expect(payload.startsAt).toBe(T17);
    expect(payload.participantCount).toBe(2);

    // The club's business record survives an erasure: it names no one.
    expect(JSON.stringify(payload)).not.toContain(player(1));
    expect(payload.participants).toBeUndefined();
  });

  it('the roster travels per-participant, each keyed to its own data subject', async () => {
    await playedMatch();

    const joined = h.eventsOfType('booking.participant-joined');
    expect(joined).toHaveLength(2);
    // These carry piiClass 'pseudonymous'; the kernel REJECTS such an event without
    // a subjectId, so the fact they emitted at all proves the erasure key is set.
    const payload = joined[0]!.payload as { partyRef: string; share: { amount: string } };
    expect(payload.partyRef).toBe(player(1));
    expect(payload.share.amount).toBe('120');
  });

  // -- availability --------------------------------------------------------

  it('reports the gaps around a booking', async () => {
    const r = await court();
    const held = await hold(r.id, T17, T1830);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));

    const free = await h.run((ctx) =>
      availability(ctx, { resourceId: r.id, from: NOW, to: T2030, now: NOW }),
    );
    expect(free).toEqual<FreeInterval[]>([
      { startsAt: NOW, endsAt: T17, available: 1 },
      { startsAt: T1830, endsAt: T2030, available: 1 },
    ]);
  });

  it('reports remaining capacity on a pool rather than a boolean', async () => {
    const pool = await court('Racketpool', 3);
    await hold(pool.id, T17, T1830, { quantity: 2 });

    const free = await h.run((ctx) =>
      availability(ctx, { resourceId: pool.id, from: T17, to: T1830, now: NOW }),
    );
    expect(free).toEqual<FreeInterval[]>([{ startsAt: T17, endsAt: T1830, available: 1 }]);
  });

  it('ignores expired holds when reporting availability', async () => {
    const r = await court();
    await hold(r.id, T17, T1830);
    const free = await h.run((ctx) =>
      availability(ctx, { resourceId: r.id, from: T17, to: T1830, now: AFTER_EXPIRY }),
    );
    expect(free).toEqual<FreeInterval[]>([{ startsAt: T17, endsAt: T1830, available: 1 }]);
  });

  // -- opening an existing reservation to others ----------------------------

  it('opens a private booking to others, and closes it again', async () => {
    const r = await court();
    const held = await hold(r.id);
    expect(held.fillTarget).toBeNull(); // private

    const opened = await h.run((ctx) =>
      openReservation(ctx, { reservationId: held.id, fillTarget: 4, now: NOW }),
    );
    expect(opened.fillTarget).toBe(4);
    expect(h.eventsOfType('booking.opened')).toHaveLength(1);

    const closed = await h.run((ctx) =>
      openReservation(ctx, { reservationId: held.id, fillTarget: null, now: NOW }),
    );
    expect(closed.fillTarget).toBeNull();
  });

  it('refuses to open fewer places than are already taken', async () => {
    const r = await court();
    const held = await hold(r.id, T17, T1830, { fillTarget: 4 });
    for (const n of [1, 2, 3]) {
      await h.run((ctx) =>
        joinReservation(ctx, { reservationId: held.id, partyRef: player(n), now: NOW }),
      );
    }
    await expect(
      h.run((ctx) => openReservation(ctx, { reservationId: held.id, fillTarget: 2, now: NOW })),
    ).rejects.toThrow(/already on this reservation/);
  });

  it('an opened booking then auto-confirms when it fills', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    await h.run((ctx) =>
      joinReservation(ctx, { reservationId: held.id, partyRef: player(1), now: NOW }),
    );
    // Opening a CONFIRMED booking is the "invite others to my game" case.
    const opened = await h.run((ctx) =>
      openReservation(ctx, { reservationId: held.id, fillTarget: 2, now: NOW }),
    );
    expect(opened.fillTarget).toBe(2);
    const { reservation } = await h.run((ctx) =>
      joinReservation(ctx, { reservationId: held.id, partyRef: player(2), now: NOW }),
    );
    expect(reservation.state).toBe('confirmed'); // already was, and stays
  });

  // -- move (reschedule) ---------------------------------------------------

  it('moves to another court, keeping identity and roster', async () => {
    const one = await court('Bana 1');
    const two = await court('Bana 2');
    const match = await hold(one.id, T17, T1830, { fillTarget: 4 });
    await h.run((ctx) =>
      joinReservation(ctx, { reservationId: match.id, partyRef: player(1), now: NOW }),
    );

    const moved = await h.run((ctx) =>
      moveReservation(ctx, { reservationId: match.id, resourceId: two.id, now: NOW }),
    );
    expect(moved.id).toBe(match.id); // same reservation, not a rebook
    expect(moved.resourceId).toBe(two.id);
    expect(moved.startsAt).toBe(T17);

    const { participants } = await h.run((ctx) => getReservation(ctx, match.id, NOW));
    expect(participants).toHaveLength(1); // roster survives the move
  });

  it('shifting by start alone preserves the booked duration', async () => {
    const r = await court();
    const held = await hold(r.id, T17, T1830); // 90 minutes
    const moved = await h.run((ctx) =>
      moveReservation(ctx, { reservationId: held.id, startsAt: T1730, now: NOW }),
    );
    expect(moved.startsAt).toBe(T1730);
    expect(moved.endsAt).toBe(T19); // 17:30 + 90m, not the old 18:30
  });

  it('allows a nudge that overlaps its OWN old slot', async () => {
    const r = await court();
    const held = await hold(r.id, T17, T1830);
    const moved = await h.run((ctx) =>
      moveReservation(ctx, { reservationId: held.id, startsAt: T1730, endsAt: T19, now: NOW }),
    );
    expect(moved.startsAt).toBe(T1730);
  });

  it('rejects a move onto an occupied slot', async () => {
    const r = await court();
    await hold(r.id, T19, T2030);
    const held = await hold(r.id, T17, T1830);
    await expect(
      h.run((ctx) =>
        moveReservation(ctx, { reservationId: held.id, startsAt: T19, endsAt: T2030, now: NOW }),
      ),
    ).rejects.toThrow(SlotUnavailable);
  });

  it('emits booking.moved carrying from and to', async () => {
    const one = await court('Bana 1');
    const two = await court('Bana 2');
    const held = await hold(one.id, T17, T1830);
    await h.run((ctx) =>
      moveReservation(ctx, { reservationId: held.id, resourceId: two.id, now: NOW }),
    );

    const [evt] = h.eventsOfType('booking.moved');
    const payload = evt!.payload as {
      from: { resourceId: string };
      to: { resourceId: string };
      resource: { name: string };
    };
    expect(payload.from.resourceId).toBe(one.id);
    expect(payload.to.resourceId).toBe(two.id);
    expect(payload.resource.name).toBe('Bana 2');
  });

  it('cannot move a completed reservation', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    await h.run((ctx) => completeReservation(ctx, { reservationId: held.id }));
    await expect(
      h.run((ctx) => moveReservation(ctx, { reservationId: held.id, startsAt: T19, now: NOW })),
    ).rejects.toThrow(/invalid transition/);
  });

  it('frees the vacated slot after a move', async () => {
    const r = await court();
    const held = await hold(r.id, T17, T1830);
    await h.run((ctx) =>
      moveReservation(ctx, { reservationId: held.id, startsAt: T19, endsAt: T2030, now: NOW }),
    );
    const backfill = await hold(r.id, T17, T1830);
    expect(backfill.state).toBe('held');
  });

  // -- effective state: lazy expiry must not lie to a read ------------------

  it('an expired hold READS as expired without anyone sweeping it', async () => {
    const r = await court();
    const held = await hold(r.id);
    expect(held.effectiveState).toBe('held');

    const [listed] = await h.run((ctx) =>
      listReservations(ctx, { resourceId: r.id, now: AFTER_EXPIRY }),
    );
    expect(listed!.state).toBe('held'); // the row is untouched
    expect(listed!.effectiveState).toBe('expired'); // but it reads honestly
  });

  it('computes effectiveState from the INJECTED clock, never wall time', async () => {
    // The dates are deliberately long past. Under wall clock this hold is expired by
    // years, so if anything reads `new Date()` instead of the clock it was handed,
    // this fails — and keeps failing, rather than waiting for real time to drift past
    // a constant. That is how the bug got in: a default of `new Date().toISOString()`
    // on the mapper meant every caller that forgot to pass `now` silently used wall
    // time, which stayed invisible until a date passed and then looked like flakiness.
    const PAST = '2020-01-01T00:00:00.000Z';
    const PAST_EXPIRY = '2020-01-01T00:10:00.000Z';

    const r = await court();
    const [held] = await h.run((ctx) => [
      holdReservation(ctx, {
        resourceId: r.id,
        startsAt: '2020-01-01T09:00:00.000Z',
        endsAt: '2020-01-01T10:00:00.000Z',
        expiresAt: PAST_EXPIRY,
        now: PAST,
      }),
    ]);
    expect(held!.effectiveState).toBe('held');

    // And the same row read at a later injected instant is expired — so the clock is
    // genuinely being used, not merely ignored in a way that happens to pass.
    const [listed] = await h.run((ctx) =>
      listReservations(ctx, { resourceId: r.id, now: PAST_EXPIRY }),
    );
    expect(listed!.effectiveState).toBe('expired');
  });

  it('a live hold reads as held', async () => {
    const r = await court();
    await hold(r.id);
    const [listed] = await h.run((ctx) => listReservations(ctx, { resourceId: r.id, now: NOW }));
    expect(listed!.effectiveState).toBe('held');
  });

  it('after a real sweep, stored and effective state agree', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => expireReservation(ctx, { reservationId: held.id, now: AFTER_EXPIRY }));
    const { reservation } = await h.run((ctx) => getReservation(ctx, held.id, AFTER_EXPIRY));
    expect(reservation.state).toBe('expired');
    expect(reservation.effectiveState).toBe('expired');
  });

  it('a confirmed reservation is unaffected by the clock', async () => {
    const r = await court();
    const held = await hold(r.id);
    await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: NOW }));
    const { reservation } = await h.run((ctx) => getReservation(ctx, held.id, AFTER_EXPIRY));
    expect(reservation.effectiveState).toBe('confirmed');
  });

  // -- permissions ---------------------------------------------------------

  it('refuses every operation to a principal holding nothing', async () => {
    const r = await court();
    const nobody = await h.as([]);
    await expect(nobody.invoke('booking/list')).rejects.toThrow(/permission denied/);
    await expect(
      nobody.invoke('booking/hold', {
        resourceId: r.id,
        startsAt: T17,
        endsAt: T1830,
        expiresAt: EXPIRES,
        now: NOW,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('separates holding from managing resources', async () => {
    const booker = await h.as([PERM.read, PERM.hold]);
    await expect(
      booker.invoke('booking/create-resource', { kind: 'court', name: 'Bana 9' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('separates rescheduling from cancelling', async () => {
    const r = await court();
    const held = await hold(r.id);
    const canceller = await h.as([PERM.read, PERM.cancel]);
    await expect(
      canceller.invoke('booking/move', { reservationId: held.id, startsAt: T19 }),
    ).rejects.toThrow(/permission denied/);
  });

  it('registers operations that round-trip through the kernel', async () => {
    const r = await staff.invoke<Resource>('booking/create-resource', {
      kind: 'court',
      name: 'Bana 2',
    });
    const held = await staff.invoke<Reservation>('booking/hold', {
      resourceId: r.id,
      startsAt: T17,
      endsAt: T1830,
      expiresAt: EXPIRES,
    });
    const confirmed = await staff.invoke<Reservation>('booking/confirm', {
      reservationId: held.id,
    });
    expect(confirmed.state).toBe('confirmed');

    // `booking/list` pages (#811): the kernel-side shape is `Page<Reservation>`,
    // and the entries are the list this test always asserted on.
    const list = await staff.invoke<Page<Reservation>>('booking/list', { resourceId: r.id });
    expect(list.entries).toHaveLength(1);
    expect(list.nextCursor).toBeNull();
  });

  // -- the clock is not on the wire (#961) ---------------------------------
  //
  // `nowOr` prefers an explicit `now` over `ctx.now()`, which is fine in scope
  // and a hole over HTTP: a caller with `booking:confirm` would confirm an
  // expired hold by back-dating it, or sweep a live one by post-dating it. The
  // declared inputs carry no `now`, so the host's parse strips it and every
  // operation judges against the host clock — which is what these move.

  const wireHold = () =>
    staff
      .invoke<Resource>('booking/create-resource', { kind: 'court', name: 'Bana 3' })
      .then((r) =>
        staff.invoke<Reservation>('booking/hold', {
          resourceId: r.id,
          startsAt: T17,
          endsAt: T1830,
          expiresAt: EXPIRES,
        }),
      );

  it('an expired hold cannot be confirmed by back-dating `now` over the wire', async () => {
    const held = await wireHold();
    clock.set(AFTER_EXPIRY);
    await expect(
      staff.invoke('booking/confirm', { reservationId: held.id, now: NOW }),
    ).rejects.toThrow(/expired/);
    expect(h.eventsOfType('booking.confirmed')).toHaveLength(0);
  });

  it('a live hold cannot be swept by post-dating `now` over the wire', async () => {
    const held = await wireHold();
    await expect(
      staff.invoke('booking/expire', { reservationId: held.id, now: AFTER_EXPIRY }),
    ).rejects.toThrow(/not expired yet/);
    expect(h.eventsOfType('booking.expired')).toHaveLength(0);
  });

  it('a hold cannot pre-date the clock to place a deadline that has already passed', async () => {
    const r = await staff.invoke<Resource>('booking/create-resource', {
      kind: 'court',
      name: 'Bana 4',
    });
    clock.set(AFTER_EXPIRY);
    await expect(
      staff.invoke('booking/hold', {
        resourceId: r.id,
        startsAt: T17,
        endsAt: T1830,
        expiresAt: EXPIRES,
        now: NOW,
      }),
    ).rejects.toThrow(/already be expired/);
  });

  it('a read renders lazy expiry against the host clock, whatever `now` it was sent', async () => {
    const held = await wireHold();
    clock.set(AFTER_EXPIRY);
    const { reservation } = await staff.invoke<{ reservation: Reservation }>('booking/get', {
      reservationId: held.id,
      now: NOW,
    });
    expect(reservation.state).toBe('held');
    expect(reservation.effectiveState).toBe('expired');
  });

  it('the same instant, moved in scope, still works for a composing vertical', async () => {
    // The in-scope function keeps `now` — that is how a vertical replays or a
    // test pins a moment — and it is the one place the choice is the caller's.
    const held = await wireHold();
    await expect(
      h.run((ctx) => confirmReservation(ctx, { reservationId: held.id, now: AFTER_EXPIRY })),
    ).rejects.toThrow(/expired/);
    const confirmed = await h.run((ctx) => confirmReservation(ctx, { reservationId: held.id }));
    expect(confirmed.state).toBe('confirmed');
  });
});
