/**
 * engine-booking's event contract (#696) — what a VERTICAL imports so that
 * consuming this engine by event is checked rather than guessed.
 *
 * TYPES ONLY. The runtime contract is still the fat payload and **the
 * consumer's own Zod parse** (kernel `EventContract`,
 * `packages/kernel/src/scope-host.ts`); `emitBookingEvent` forwards to
 * `ctx.emit` unchanged — one extra call in the stack, and no change in what is
 * emitted.
 *
 * VERTICAL-FACING ONLY. A sibling engine consuming one of these must NOT import
 * it — R1 (star topology) forbids the import, and the defensive parse is what
 * lets an engine ride out #128's dual-emit window.
 *
 * **No completion group.** A group says two events report ONE fact by different
 * routes, so handling a subset strands the entity; the engine-protocol case is
 * the reference, where both events are built from one shared `base` and
 * `complete` rides on whichever signature happens to arrive last. Nothing here
 * has that shape. The four terminal transitions — `completed`, `cancelled`,
 * `expired`, `no-show` — do share a consequence (the lifecycle's "the four
 * terminal ones release capacity"), but they are four different facts about why,
 * each built at its own site, and a consumer that wants only `completed` is not
 * making the mistake #696 was filed for. Grouping them would force three no-op
 * handlers on every reader to buy nothing.
 *
 * Additive, like every other engine surface: a new event type may appear, an
 * existing payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput, Money } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/** A resource, as it rides a reservation's fat payload — never the stored row. */
export interface BookingResourceRef {
  id: string;
  kind: string;
  name: string;
}

/** Where a reservation sits, or sat: one resource over one interval. */
export interface BookingSlot {
  resourceId: string;
  startsAt: string;
  endsAt: string;
}

/** A bookable resource was added to the scope. */
export interface BookingResourceCreatedPayload {
  resourceId: string;
  kind: string;
  name: string;
  capacity: number;
}

/** A deadline-bearing claim on capacity — the initial state of every reservation. */
export interface BookingHeldPayload {
  reservationId: string;
  resource: BookingResourceRef;
  startsAt: string;
  endsAt: string;
  quantity: number;
  expiresAt: string;
  /** How many places are on offer; null for a private booking. */
  fillTarget: number | null;
}

/** held → confirmed. Capacity is committed. */
export interface BookingConfirmedPayload {
  reservationId: string;
  resource: BookingResourceRef;
  startsAt: string;
  endsAt: string;
  quantity: number;
  participantCount: number;
}

/**
 * A hold whose deadline passed was swept.
 *
 * Expiry is LAZY: a reservation reads as expired through `effectiveState`
 * without any transition occurring, so this event announces the sweep, not the
 * lapse. A consumer that never sees it has not necessarily missed an expiry.
 */
export interface BookingExpiredPayload {
  reservationId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  participantCount: number;
}

/** Someone joined an open reservation. Filling the last place auto-confirms it. */
export interface BookingParticipantJoinedPayload {
  reservationId: string;
  participantId: string;
  /**
   * The participant, as an opaque data-subject id — never a `PrincipalId`, and
   * declared as the wire type rather than the brand it is minted as. It is what
   * `subjectId` keys this event's erasure on.
   */
  partyRef: string;
  share: Money | null;
  /** How many are on it after this join. */
  joined: number;
  fillTarget: number | null;
}

/** Places were put on offer, or the offer was changed or closed (`fillTarget: null`). */
export interface BookingOpenedPayload {
  reservationId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  fillTarget: number | null;
  participantCount: number;
}

/** A soft leave — the row stays, so the record of who was in stays intact. */
export interface BookingParticipantLeftPayload {
  reservationId: string;
  participantId: string;
  partyRef: string;
  /** How many are still on it. */
  remaining: number;
  fillTarget: number | null;
}

/** Terminal: the reservation was called off before it ran. */
export interface BookingCancelledPayload {
  reservationId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  participantCount: number;
}

/** Rescheduled to another slot and/or resource, keeping identity and participants. */
export interface BookingMovedPayload {
  reservationId: string;
  from: BookingSlot;
  to: BookingSlot;
  resource: BookingResourceRef;
  participantCount: number;
}

/** confirmed → in_service. Starting is optional; a booking may complete without it. */
export interface BookingStartedPayload {
  reservationId: string;
  resourceId: string;
}

/**
 * Terminal: the reservation ran.
 *
 * Deliberately fat — resource, interval and how many were on it — so an
 * invoicing consumer can raise split charges and an out-of-kernel consumer can
 * build cross-club history, neither needing a cross-module read.
 */
export interface BookingCompletedPayload {
  reservationId: string;
  resource: BookingResourceRef;
  startsAt: string;
  endsAt: string;
  quantity: number;
  participantCount: number;
}

/** Terminal: nobody turned up. Distinct from a cancellation, and usually billable. */
export interface BookingNoShowPayload {
  reservationId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  participantCount: number;
}

/**
 * engine-booking's event contract — the twelve event types this engine emits and
 * the payload each one carries.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[BookingEvents]>()({ … })` and gets typed payloads plus
 * rejection of an event type this engine does not emit.
 */
export type BookingEvents = {
  events: {
    'booking.resource-created': BookingResourceCreatedPayload;
    'booking.held': BookingHeldPayload;
    'booking.confirmed': BookingConfirmedPayload;
    'booking.expired': BookingExpiredPayload;
    'booking.participant-joined': BookingParticipantJoinedPayload;
    'booking.opened': BookingOpenedPayload;
    'booking.participant-left': BookingParticipantLeftPayload;
    'booking.cancelled': BookingCancelledPayload;
    'booking.moved': BookingMovedPayload;
    'booking.started': BookingStartedPayload;
    'booking.completed': BookingCompletedPayload;
    'booking.no-show': BookingNoShowPayload;
  };
};

/** Every event type this engine emits. */
export type BookingEventType = keyof BookingEvents['events'];

/**
 * Every event type this engine emits, and the `schemaVersion` each is emitted at.
 *
 * The ONE home for that number (#1597): `emitBookingEvent` stamps it onto every
 * emission and the manifest's `emits` is derived from it below, so the two cannot
 * drift. `satisfies` holds it to exactly the types `BookingEvents` declares — a type
 * missing here, or one the map does not know, is a compile error. Bumping a
 * version is K-39's REPLACE: change it here, and the payload type beside it.
 */
export const bookingEventVersions = {
  'booking.held': 1,
  'booking.confirmed': 1,
  'booking.expired': 1,
  'booking.cancelled': 1,
  'booking.moved': 1,
  'booking.started': 1,
  'booking.completed': 1,
  'booking.no-show': 1,
  'booking.participant-joined': 1,
  'booking.participant-left': 1,
  'booking.opened': 1,
  'booking.resource-created': 1,
} as const satisfies Record<BookingEventType, number>;

/** The manifest's `events.emits`, read off {@link bookingEventVersions} — never hand-declared. */
export const bookingEmitDeclarations: { type: string; schemaVersion: number }[] = Object.entries(
  bookingEventVersions,
).map(([type, schemaVersion]) => ({ type, schemaVersion }));

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `BookingEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so a map declared beside the
 * emit sites would be checked by nobody and could rot silently into a lie a
 * vertical compiles against. Routing every emit through here makes the map the
 * *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitBookingEvent<K extends BookingEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload' | 'schemaVersion'> & {
    type: K;
    payload: BookingEvents['events'][K];
  },
): void {
  ctx.emit({ ...event, schemaVersion: bookingEventVersions[event.type] });
}
