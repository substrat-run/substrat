import { dataSubjectId, money, substratError, z } from '@substrat-run/contracts';
import { bookingEntities } from './entities.js';

/**
 * engine-booking's schemas — what it ACCEPTS and what it ANSWERS (#707/#865).
 *
 * The published projections were seven hand-written `export interface`s in
 * `index.ts`, and the operation inputs were a mix of exported schemas and inline
 * TypeScript types on each handler. Both moved here because `defineOperations`
 * declares an operation's `input` and `output` as schemas, and a TypeScript
 * interface cannot be one — the alternative was a zod schema beside each
 * interface saying the same thing twice, which is the two-descriptions defect
 * this engine already deleted once (see `reservationState` below).
 *
 * They live in their own file rather than in `operations.ts` for the reason
 * `entities.ts` does: `index.ts` needs them too, and a declaration file that
 * imports the implementation is the cycle the old `OPERATIONS` note described.
 * Nothing here imports `index.ts`, so the direction stays acyclic.
 *
 * Row versus published, the distinction `entities.ts` draws: a `ResourceRow` has
 * `active` as 0/1 and `created_at` in snake_case because SQLite has no boolean
 * and the column is what it is. `Resource` publishes `active: boolean` and
 * `createdAt`. The registry describes what is STORED; this describes what is
 * ANSWERED, and `toResource`/`toReservation` in `index.ts` are the one crossing.
 */

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/** Parse to a canonical ISO instant, or refuse. */
export function toInstant(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw substratError('validation_failed', `invalid instant: ${value}`);
  return new Date(ms).toISOString();
}

export const instantIn = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid instant' })
  .transform(toInstant);

// ---------------------------------------------------------------------------
// Published projections
// ---------------------------------------------------------------------------

/**
 * The reservation's states — **taken from the entity registry, not restated**.
 *
 * Moved here from `index.ts` unchanged. Reading the column's own schema keeps
 * storage and domain unable to disagree (#844).
 */
export const reservationState = bookingEntities.reservation.fields.shape.state;
export type ReservationState = z.infer<typeof reservationState>;

export const resource = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  capacity: z.number(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type Resource = z.infer<typeof resource>;

export const participant = z.object({
  id: z.string(),
  partyRef: z.string(),
  share: money.nullable(),
  joinedAt: z.string(),
  leftAt: z.string().nullable(),
});
export type Participant = z.infer<typeof participant>;

export const reservation = z.object({
  id: z.string(),
  resourceId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** The state as stored. A `held` row keeps saying `held` until someone sweeps it. */
  state: reservationState,
  /**
   * What the row actually means *now* — `expired` once a hold's deadline has passed,
   * whether or not anyone has swept it.
   *
   * Expiry is lazy, so `state` alone would render a dead hold as a live one: the
   * console calendar would show a HELD cell counting down past 0:00 forever. Read
   * paths render this; the transition guards use the stored `state`.
   */
  effectiveState: reservationState,
  quantity: z.number(),
  expiresAt: z.string().nullable(),
  fillTarget: z.number().nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Reservation = z.infer<typeof reservation>;

export const freeInterval = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  available: z.number(),
});
export type FreeInterval = z.infer<typeof freeInterval>;

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

/**
 * The instant an IN-SCOPE call judges expiry against — never on the wire (#961).
 *
 * `nowOr` prefers it over `ctx.now()`, which is exactly why no operation input
 * below carries it: a caller who could send `now` would confirm an expired hold
 * by back-dating it, or sweep someone's live hold by post-dating it — R6's ban on
 * ambient clocks re-opened through the input schema. The host parses each
 * declared input before the handler runs and a wire `now` is stripped with the
 * other undeclared keys, so an operation always judges against the operation's
 * own instant.
 *
 * A vertical composing the engine by call may still pass it, which is what keeps
 * lazy expiry testable and replayable at a chosen moment; so may a test, though
 * a `manualClock` on the host is the shape that exercises the wire path too.
 */
export const atInstant = z.object({ now: z.string().optional() });

/** Every reservation-scoped operation opens with this, and most add nothing. */
export const reservationIdIn = z.object({ reservationId: z.string().min(1) });

export const createResourceInput = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  capacity: z.number().int().min(1).optional(),
});
export type CreateResourceInput = z.infer<typeof createResourceInput>;

export const setResourceActiveInput = z.object({
  resourceId: z.string().min(1),
  active: z.boolean(),
});
export type SetResourceActiveInput = z.infer<typeof setResourceActiveInput>;

export const listResourcesInput = z.object({ kind: z.string().min(1).optional() });

export const holdReservationInput = z.object({
  resourceId: z.string().min(1),
  startsAt: instantIn,
  endsAt: instantIn,
  expiresAt: instantIn,
  quantity: z.number().int().min(1).optional(),
  fillTarget: z.number().int().min(1).optional(),
  note: z.string().optional(),
});
/** What `holdReservation(ctx, …)` takes in scope: the wire input plus `now`. */
export const holdReservationCall = holdReservationInput.extend(atInstant.shape);
export type HoldReservationInput = z.infer<typeof holdReservationCall>;

export const joinReservationInput = z.object({
  reservationId: z.string().min(1),
  /**
   * The participant, as an opaque **data-subject** id — never a `PrincipalId`.
   * A participant is a person, so this must be shreddable: it keys the erasure
   * of the `participant-joined` / `participant-left` events below.
   */
  partyRef: dataSubjectId,
  share: money.optional(),
});
/** What `joinReservation(ctx, …)` takes in scope: the wire input plus `now`. */
export const joinReservationCall = joinReservationInput.extend(atInstant.shape);
export type JoinReservationInput = z.infer<typeof joinReservationCall>;

export const leaveReservationInput = reservationIdIn.extend({
  participantId: z.string().min(1),
});

export const cancelReservationInput = reservationIdIn.extend({
  reason: z.string().optional(),
});

export const moveReservationInput = z.object({
  reservationId: z.string().min(1),
  /** Target resource. Omitted = stay on the current one. */
  resourceId: z.string().min(1).optional(),
  /** New start. Given alone, the booking is *shifted* — its duration is preserved. */
  startsAt: instantIn.optional(),
  /** New end. Given alone, the booking is re-sized from its existing start. */
  endsAt: instantIn.optional(),
});
/** What `moveReservation(ctx, …)` takes in scope: the wire input plus `now`. */
export const moveReservationCall = moveReservationInput.extend(atInstant.shape);
export type MoveReservationInput = z.infer<typeof moveReservationCall>;

export const openReservationInput = reservationIdIn.extend({
  fillTarget: z.number().int().min(1).nullable(),
});

/**
 * @deprecated Identical to `reservationIdIn` since `now` left the wire (#961);
 * kept so a caller that named it keeps compiling.
 */
export const reservationAtInput = reservationIdIn;

export const listReservationsInput = z.object({
  resourceId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const availabilityInput = z.object({
  resourceId: z.string().min(1),
  from: z.string(),
  to: z.string(),
});
