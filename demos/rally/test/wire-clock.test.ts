import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { Reservation } from '@substrat-run/engine-booking';
import { buildRallyHost, seedRally, type RallyWorld } from '../src/index.js';

/**
 * THE CLOCK IS NOT ON THE WIRE (#1065, and #961/#1055 one layer down).
 *
 * `engine-booking` judges every expiry against `nowOr(ctx, now)`, which prefers a
 * caller-supplied instant over `ctx.now()`. RallyPoint composes the engine by
 * call, so for as long as its own operation inputs declared `now` and forwarded
 * it, an ordinary HTTP caller — one holding nothing more than the permission the
 * operation already requires — chose that instant. Two things follow from that,
 * and this file is the two of them:
 *
 *   - back-date, and a hold that lapsed ten minutes ago confirms as if it were
 *     live: the court is handed to whoever asks late, over the head of whoever
 *     the engine already freed it for;
 *   - post-date, and someone else's LIVE hold looks expired, so the slot it is
 *     protecting can be taken out from under them.
 *
 * Neither is reachable now: the host parses each invocation against the declared
 * input first, and `now` is not in any of them, so it is stripped with the other
 * unknown keys before the handler runs. Time still passes in this suite — it
 * passes on the HOST's clock, which is the one thing an attacker on the wire
 * cannot reach.
 */
describe('RallyPoint: the wire cannot choose the instant (#1065)', () => {
  const HOLD_MINUTES = 10; // `rally/set-venue` in the seed
  const DATE = '2026-07-20';
  const NOW = '2026-07-20T06:00:00.000Z';
  const PAST = '2026-07-20T05:00:00.000Z';
  const FUTURE = '2026-07-21T06:00:00.000Z';
  const clock = manualClock(NOW);

  let dir: string;
  let host: SqliteScopeHost;
  let w: RallyWorld;
  let ravi: ScopeStub; // receptionist: holds booking:hold and booking:confirm

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rally-wire-clock-'));
    host = buildRallyHost(dir, { clock: clock.read });
    w = await seedRally(host, dir);
    ravi = await host.getScope(w.ravi, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cannot confirm a lapsed hold by back-dating the wire', async () => {
    const held = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court1,
      memberId: w.elinId,
      date: DATE,
      time: '09:00',
      duration: 60,
    });
    expect(held.reservation.state).toBe('held');

    // The hold lapses on the host's clock — nobody swept it, expiry is lazy.
    clock.advance((HOLD_MINUTES + 1) * 60_000);

    // The caller holds `booking:confirm` on this very reservation and sends the
    // instant the hold was still alive at. It is stripped, not honoured.
    await expect(
      ravi.invoke('rally/confirm-booking', {
        reservationId: held.reservation.id,
        now: NOW,
      }),
    ).rejects.toThrow(/hold expired/i);

    // …and a far-past instant is no better: this is not a tolerance to widen.
    await expect(
      ravi.invoke('rally/confirm-booking', { reservationId: held.reservation.id, now: PAST }),
    ).rejects.toThrow(/hold expired/i);
  });

  it('cannot sweep a live hold by post-dating the wire', async () => {
    clock.set(NOW);
    const held = await ravi.invoke<{ reservation: Reservation }>('rally/book-court', {
      resourceId: w.court2,
      memberId: w.elinId,
      date: DATE,
      time: '10:00',
      duration: 60,
    });
    expect(held.reservation.state).toBe('held');

    // A day into the future would make that hold long dead, if the wire decided.
    await expect(
      ravi.invoke('rally/book-court', {
        resourceId: w.court2,
        memberId: w.johanId,
        date: DATE,
        time: '10:00',
        duration: 60,
        now: FUTURE,
      }),
    ).rejects.toThrow(/slot unavailable/i);

    // The hold is untouched, so its owner can still confirm it at the real instant.
    const confirmed = await ravi.invoke<{ reservation: Reservation }>('rally/confirm-booking', {
      reservationId: held.reservation.id,
    });
    expect(confirmed.reservation.state).toBe('confirmed');
  });

  it('reads report the host’s instant, not the reader’s', async () => {
    clock.set(NOW);
    const match = await ravi.invoke<{ reservation: Reservation }>('rally/create-open-match', {
      resourceId: w.court1,
      memberId: w.elinId,
      date: DATE,
      time: '20:30',
      duration: 90,
      fillTarget: 4,
      levelMin: '3.0',
      levelMax: '4.0',
    });

    // A match link dies at the start (`matchLandingOp`). Asking from "tomorrow"
    // used to be enough to kill it for the asker; now the answer is the club's.
    const landing = await ravi.invoke<{ status: string }>('rally/match', {
      reservationId: match.reservation.id,
      now: FUTURE,
    });
    expect(landing.status).toBe('open');

    // And the mirror: once the host's clock is past the deadline the link is
    // dead — an open match holds until its own start — and back-dating the read
    // does not resurrect it.
    clock.set('2026-07-21T00:00:00.000Z');
    const later = await ravi.invoke<{ status: string }>('rally/match', {
      reservationId: match.reservation.id,
      now: NOW,
    });
    expect(later.status).toBe('gone');
    clock.set(NOW);
  });
});
