import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { errorCodeOf, toProblem } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  bookingModule,
  createResource,
  expireReservation,
  getReservation,
  holdReservation,
} from '../src/index.js';

/**
 * The engine's refusals, classified (#113 phase 2b).
 *
 * Every message here is unchanged from before the taxonomy — that is the point, and it
 * is what let 78 throw sites convert without touching a single assertion elsewhere. What
 * changed is that a transport no longer has to guess a status from the wording.
 *
 * The three classes an engine actually raises, pinned against real operations rather
 * than constructed errors, because the classification is a claim about THIS code:
 *
 * - a missing entity is `not_found` (404), not the caller's 400;
 * - a refused state machine or broken invariant is `conflict` (409);
 * - malformed input is `validation_failed` (400).
 */
const NOW = '2026-07-20T12:00:00.000Z';
const EXPIRES = '2026-07-20T12:10:00.000Z';
const T17 = '2026-07-20T17:00:00.000Z';
const T1830 = '2026-07-20T18:30:00.000Z';

describe('engine-booking refusals carry a code', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [bookingModule] });
    staff = await h.as([PERM.create, PERM.read, PERM.hold, PERM.manageResources]);
  });
  afterEach(async () => {
    await h.close();
  });

  const thrownBy = async (run: () => Promise<unknown>): Promise<Error> =>
    run().then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: Error) => err,
    );

  it('classifies a missing entity as not_found', async () => {
    const err = await thrownBy(() =>
      h.run((ctx) => getReservation(ctx, '01JPANOTHINGHERE000000000')),
    );
    expect(err.message).toMatch(/reservation not found/);
    expect(errorCodeOf(err)).toBe('not_found');
    expect(toProblem(err).status).toBe(404);
  });

  it('classifies a refused invariant as conflict', async () => {
    const resource = await h.run((ctx) => createResource(ctx, { kind: 'court', name: 'Bana 1' }));
    const held = await h.run((ctx) =>
      holdReservation(ctx, {
        resourceId: resource.id,
        startsAt: T17,
        endsAt: T1830,
        expiresAt: EXPIRES,
        now: NOW,
      }),
    );
    // Expiring a hold that has not expired: the state machine refusing, which is a
    // conflict with the world as it is — not a malformed request.
    const err = await thrownBy(() =>
      h.run((ctx) => expireReservation(ctx, { reservationId: held.id, now: NOW })),
    );
    expect(err.message).toMatch(/has not expired yet/);
    expect(errorCodeOf(err)).toBe('conflict');
    expect(toProblem(err).status).toBe(409);
  });

  it('classifies malformed input as validation_failed', async () => {
    const resource = await h.run((ctx) => createResource(ctx, { kind: 'court', name: 'Bana 2' }));
    const err = await thrownBy(() =>
      h.run((ctx) =>
        holdReservation(ctx, {
          resourceId: resource.id,
          // Ends before it starts — the caller's mistake, not a state conflict.
          startsAt: T1830,
          endsAt: T17,
          expiresAt: EXPIRES,
          now: NOW,
        }),
      ),
    );
    expect(err.message).toMatch(/invalid interval/);
    expect(errorCodeOf(err)).toBe('validation_failed');
    expect(toProblem(err).status).toBe(400);
  });

  it('leaves the messages byte-identical, which is why nothing else had to change', async () => {
    const err = await thrownBy(() =>
      h.run((ctx) => getReservation(ctx, '01JPANOTHINGHERE000000000')),
    );
    // The exact string the pre-taxonomy engine threw, and the one existing callers and
    // regex-matching transports still see.
    expect(err.message).toBe('reservation not found: 01JPANOTHINGHERE000000000');
    expect(staff).toBeDefined();
  });
});
