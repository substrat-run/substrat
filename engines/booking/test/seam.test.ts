import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dataSubjectId, errorCodeOf, moneyOf, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  availability,
  bookingModule,
  createResource,
  getReservation,
  holdReservation,
  joinReservation,
  listResources,
  type Reservation,
  type Resource,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { reservationRow, resourceRow } from '../src/entities.js';

/**
 * The seam, under drift (#771) — engine-booking's copy of workorder's suite.
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime, and `SELECT *` pinned the
 * published shape to whatever the physical table happened to hold.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const NOW = '2026-07-20T12:00:00.000Z';
const EXPIRES = '2026-07-20T12:10:00.000Z';
const T17 = '2026-07-20T17:00:00.000Z';
const T1830 = '2026-07-20T18:30:00.000Z';
const T20 = '2026-07-20T20:00:00.000Z';

const player = dataSubjectId.parse(`01JPADEK${'A'.repeat(17)}1`);

describe('engine-booking — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [bookingModule] });
    staff = await h.as([PERM.create, PERM.read, PERM.hold, PERM.confirm, PERM.manageResources]);
  });
  afterEach(async () => {
    await h.close();
  });

  const court = (name = 'Bana 1') => h.run((ctx) => createResource(ctx, { kind: 'court', name }));

  const hold = (resourceId: string, startsAt = T17, endsAt = T1830) =>
    h.run((ctx) =>
      holdReservation(ctx, { resourceId, startsAt, endsAt, expiresAt: EXPIRES, now: NOW }),
    );

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql));

  // -- the SELECT list is derived from the row schema ---------------------------

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(resourceRow)).toBe('id, kind, name, capacity, active, created_at');
    expect(columnsOf(reservationRow)).toBe(
      'id, resource_id, starts_at, ends_at, state, quantity, expires_at, fill_target, note, created_by, created_at',
    );
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    const c = await court();
    const r = await hold(c.id);
    // The published shape still says `note`; the table no longer does.
    await drift('ALTER TABLE booking_reservations DROP COLUMN note');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(h.run((ctx) => getReservation(ctx, r.id, NOW))).rejects.toThrow(
      /no such column: note/,
    );
  });

  it('a column added upstream never crosses the seam', async () => {
    await drift('ALTER TABLE booking_resources ADD COLUMN internal_rate TEXT');
    const c = await court();
    await drift(`UPDATE booking_resources SET internal_rate = '199'`);

    const listed = await h.run((ctx) => listResources(ctx));
    const paged = await staff.invoke<Page<Resource>>('booking/list-resources');
    for (const row of [c, ...listed, ...paged.entries]) {
      expect(Object.keys(row)).toEqual(['id', 'kind', 'name', 'capacity', 'active', 'createdAt']);
      expect(row).not.toHaveProperty('internal_rate');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ------------------

  it('a reservation whose row drifted throws at the seam', async () => {
    const c = await court();
    const r = await hold(c.id);
    // `quantity` is INTEGER in the table and `z.number()` in the published shape;
    // SQLite keeps a non-numeric literal as text, which is exactly the retype an
    // additive-only rule exists to forbid and nothing at runtime enforced.
    await drift(`UPDATE booking_reservations SET quantity = 'two'`);

    await expect(h.run((ctx) => getReservation(ctx, r.id, NOW))).rejects.toThrow(
      /does not match the shape this engine publishes.*quantity/s,
    );
  });

  it('a resource whose row drifted throws at the seam, on every path out', async () => {
    const c = await court();
    await drift(`UPDATE booking_resources SET capacity = 'four'`);

    await expect(h.run((ctx) => listResources(ctx))).rejects.toThrow(
      /does not match the shape this engine publishes.*capacity/s,
    );
    await expect(staff.invoke('booking/list-resources')).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    // The computed fold is published through the same seam: a text capacity would
    // otherwise become NaN arithmetic and an availability of nothing, silently.
    await expect(
      h.run((ctx) => availability(ctx, { resourceId: c.id, from: T17, to: T20, now: NOW })),
    ).rejects.toThrow(/does not match the shape this engine publishes/);
  });

  it('a retyped `active` is caught BEFORE it is normalised to a boolean', async () => {
    const c = await court();
    // `active` is 0/1 and `toResource` reads it with `=== 1`. A text value would
    // not fail the published parse — it would quietly publish the court as
    // inactive and its calendar as empty. (`'1'` would be coerced back to an
    // integer by SQLite's column affinity, so the drift has to be non-numeric.)
    await drift(`UPDATE booking_resources SET active = 'yes'`);

    await expect(h.run((ctx) => listResources(ctx))).rejects.toThrow(
      /resource row .* does not match the shape this engine publishes.*active/s,
    );
    await expect(
      h.run((ctx) => availability(ctx, { resourceId: c.id, from: T17, to: T20, now: NOW })),
    ).rejects.toThrow(/does not match the shape this engine publishes.*active/s);
    await expect(hold(c.id)).rejects.toThrow(/does not match the shape this engine publishes/);
  });

  it('the page walk parses every entry it publishes, not just the first read', async () => {
    const c = await court();
    await hold(c.id);
    const second = await hold(c.id, T1830, T20);
    await drift(`UPDATE booking_reservations SET quantity = 'two' WHERE id = '${second.id}'`);

    // Wrong data on page one is the failure this closes: the entry rendered fine
    // and its quantity was a string nobody declared.
    await expect(staff.invoke<Page<Reservation>>('booking/list')).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
  });

  it('a participant whose row drifted throws at the seam', async () => {
    const c = await court();
    const r = await hold(c.id);
    await h.run((ctx) =>
      joinReservation(ctx, {
        reservationId: r.id,
        partyRef: player,
        share: moneyOf('120.00', 'SEK'),
        now: NOW,
      }),
    );
    // Engine 0.4 stores the share as free text; a vertical compiled against 0.3
    // declared its operation output with `money`.
    await drift(`UPDATE booking_participants SET share_amount = 'tolv kronor'`);

    await expect(h.run((ctx) => getReservation(ctx, r.id, NOW))).rejects.toThrow(
      /does not match the shape this engine publishes.*share/s,
    );
    // The whole read refuses — a half-published roster would be the wrong-data
    // failure wearing an exception.
    await expect(staff.invoke('booking/get', { reservationId: r.id, now: NOW })).rejects.toThrow(
      /does not match the shape/,
    );
  });

  it('blames the engine, not the caller: a drifted row is `internal`', async () => {
    const c = await court();
    const r = await hold(c.id);
    await drift(`UPDATE booking_reservations SET quantity = 'two'`);

    // The caller's input was already parsed and is not what went wrong, so this
    // must not answer 400 `validation_failed` — that is a lie a client acts on.
    const err = await h.run((ctx) => getReservation(ctx, r.id, NOW)).catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe('internal');
  });
});
