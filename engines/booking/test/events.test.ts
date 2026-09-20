/**
 * #696 — engine-booking's published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `BookingEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-booking typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 */
import { describe, expect, it } from 'vitest';
import type { DataSubjectId } from '@substrat-run/contracts';
import { consumersFor, type OperationContext } from '@substrat-run/kernel';

import { emitBookingEvent } from '../src/events.js';
/**
 * The PUBLIC surface, imported the way a vertical imports it — from the package
 * root, not from `src/events.ts`. Everything below is checked through these, so
 * a name missing or mistyped in `src/index.ts` fails here instead of leaving
 * every gate green while the documented import breaks.
 */
import type {
  BookingEvents,
  BookingEventType,
  BookingResourceRef,
  BookingSlot,
  BookingResourceCreatedPayload,
  BookingHeldPayload,
  BookingConfirmedPayload,
  BookingExpiredPayload,
  BookingParticipantJoinedPayload,
  BookingOpenedPayload,
  BookingParticipantLeftPayload,
  BookingCancelledPayload,
  BookingMovedPayload,
  BookingStartedPayload,
  BookingCompletedPayload,
  BookingNoShowPayload,
} from '../src/index.js';

/** Every published name, referenced — an absent re-export cannot compile. */
type _PublishedSurface = [
  BookingEvents extends never ? never : true,
  BookingEventType extends never ? never : true,
  BookingResourceRef extends never ? never : true,
  BookingSlot extends never ? never : true,
  BookingResourceCreatedPayload extends never ? never : true,
  BookingHeldPayload extends never ? never : true,
  BookingConfirmedPayload extends never ? never : true,
  BookingExpiredPayload extends never ? never : true,
  BookingParticipantJoinedPayload extends never ? never : true,
  BookingOpenedPayload extends never ? never : true,
  BookingParticipantLeftPayload extends never ? never : true,
  BookingCancelledPayload extends never ? never : true,
  BookingMovedPayload extends never ? never : true,
  BookingStartedPayload extends never ? never : true,
  BookingCompletedPayload extends never ? never : true,
  BookingNoShowPayload extends never ? never : true,
];

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets.
// ===========================================================================

// --- positive twin: declared keys, typed payloads ---------------------------
const wellFormed = consumersFor<[BookingEvents]>()({
  'booking.completed': async (_ctx, event) => {
    // `resource` is an object, not the resource id — a distinction a cast hides.
    void event.payload.resource.name;
    void event.payload.participantCount;
  },
  'booking.participant-joined': async (_ctx, event) => {
    // `share` is nullable Money, so a consumer must decide what "no share" means.
    void event.payload.share?.currency;
  },
});

// --- an event type this engine does not emit -------------------------------
consumersFor<[BookingEvents]>()({
  'booking.completed': async () => {},
  // @ts-expect-error engine-booking emits no 'booking.rescheduled' — it is 'booking.moved'
  'booking.rescheduled': async () => {},
});

// --- the one confusion this engine's payloads actually invite ---------------
// Five payloads carry a bare `resourceId` and four carry a `resource` object.
// Reading the wrong one used to be a cast that compiled and a screen that said
// `undefined`.
consumersFor<[BookingEvents]>()({
  'booking.no-show': async (_ctx, event) => {
    const id: string = event.payload.resourceId; // accepted
    void id;
    // @ts-expect-error 'booking.no-show' carries the id, not the resource object
    void event.payload.resource.name;
  },
});

// --- a payload field the producer does not send -----------------------------
consumersFor<[BookingEvents]>()({
  'booking.cancelled': async (_ctx, event) => {
    const reason: string | null = event.payload.reason; // accepted, and nullable
    void reason;
    // @ts-expect-error nobody is named on a cancellation payload
    void event.payload.cancelledBy;
  },
});

// ---------------------------------------------------------------------------
// NO COMPLETION GROUP, on purpose — see `src/events.ts`. The four terminal
// transitions share a consequence but are four different facts, so handling
// exactly one must stay legitimate. This is the positive twin for
// engine-protocol's completion-group negative: that constraint is real there
// BECAUSE it is absent here.
// ---------------------------------------------------------------------------
consumersFor<[BookingEvents]>()({
  'booking.completed': async () => {},
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(ctx: OperationContext, moved: BookingMovedPayload, party: DataSubjectId): void {
  // --- positive twin: the declared types, accepted --------------------------
  emitBookingEvent(ctx, {
    type: 'booking.moved',
    schemaVersion: 1,
    entity: { entityType: 'reservation', entityId: '01J' },
    piiClass: 'none',
    payload: moved,
  });

  emitBookingEvent(ctx, {
    type: 'booking.participant-joined',
    schemaVersion: 1,
    entity: { entityType: 'reservation', entityId: '01J' },
    piiClass: 'pseudonymous',
    subjectId: party,
    payload: { reservationId: '01J', participantId: '01K', partyRef: party, share: null, joined: 1, fillTarget: 4 },
  });

  // --- an event type the map does not declare -------------------------------
  emitBookingEvent(ctx, {
    // @ts-expect-error engine-booking declares no 'booking.resource-retired'
    type: 'booking.resource-retired',
    schemaVersion: 1,
    entity: { entityType: 'resource', entityId: '01J' },
    piiClass: 'none',
    payload: { reservationId: '01J', resourceId: '01K' },
  });

  // --- a payload field the map does not declare -----------------------------
  emitBookingEvent(ctx, {
    type: 'booking.started',
    schemaVersion: 1,
    entity: { entityType: 'reservation', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'startedBy' is not on BookingStartedPayload
    payload: { reservationId: '01J', resourceId: '01K', startedBy: 'p1' },
  });

  // --- a payload field the map declares and the emit drops ------------------
  emitBookingEvent(ctx, {
    type: 'booking.held',
    schemaVersion: 1,
    entity: { entityType: 'reservation', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'expiresAt' is required — a hold without a deadline is not a hold
    payload: {
      reservationId: '01J',
      resource: { id: '01K', kind: 'court', name: 'Court 1' },
      startsAt: '2026-09-20T10:00:00.000Z',
      endsAt: '2026-09-20T11:00:00.000Z',
      quantity: 1,
      fillTarget: null,
    },
  });

  // --- a nullable field handed over as required, and vice versa -------------
  emitBookingEvent(ctx, {
    type: 'booking.opened',
    schemaVersion: 1,
    entity: { entityType: 'reservation', entityId: '01J' },
    piiClass: 'none',
    payload: {
      reservationId: '01J',
      resourceId: '01K',
      startsAt: '2026-09-20T10:00:00.000Z',
      endsAt: '2026-09-20T11:00:00.000Z',
      // @ts-expect-error `fillTarget: null` closes the offer — `undefined` is not the same answer
      fillTarget: undefined,
      participantCount: 0,
    },
  });
}
void _emitSiteChecks;

describe('#696 engine-booking event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitBookingEvent(ctx, {
      type: 'booking.started',
      schemaVersion: 1,
      entity: { entityType: 'reservation', entityId: '01J' },
      piiClass: 'none',
      payload: { reservationId: '01J', resourceId: '01K' },
    });
    expect(emitted).toEqual([
      {
        type: 'booking.started',
        schemaVersion: 1,
        entity: { entityType: 'reservation', entityId: '01J' },
        piiClass: 'none',
        payload: { reservationId: '01J', resourceId: '01K' },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual(['booking.completed', 'booking.participant-joined']);
  });
});
