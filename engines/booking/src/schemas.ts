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
  now: z.string().optional(),
});
export type HoldReservationInput = z.infer<typeof holdReservationInput>;

export const joinReservationInput = z.object({
  reservationId: z.string().min(1),
  /**
   * The participant, as an opaque **data-subject** id — never a `PrincipalId`.
   * A participant is a person, so this must be shreddable: it keys the erasure
   * of the `participant-joined` / `participant-left` events below.
   */
  partyRef: dataSubjectId,
  share: money.optional(),
  now: z.string().optional(),
});
export type JoinReservationInput = z.infer<typeof joinReservationInput>;

export const leaveReservationInput = reservationIdIn.extend({
  participantId: z.string().min(1),
  now: z.string().optional(),
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
  now: z.string().optional(),
});
export type MoveReservationInput = z.infer<typeof moveReservationInput>;

export const openReservationInput = reservationIdIn.extend({
  fillTarget: z.number().int().min(1).nullable(),
  now: z.string().optional(),
});

/** `now` is injectable so lazy expiry renders identically in a test and a replay. */
export const reservationAtInput = reservationIdIn.extend({ now: z.string().optional() });

export const listReservationsInput = z.object({
  resourceId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  now: z.string().optional(),
});

export const availabilityInput = z.object({
  resourceId: z.string().min(1),
  from: z.string(),
  to: z.string(),
  now: z.string().optional(),
});
