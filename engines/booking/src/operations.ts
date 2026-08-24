/**
 * The booking engine's declared operation surface (#707/#738/#865).
 *
 * ## Why this file exists now
 *
 * It used to not. `index.ts` carried an `OPERATIONS` map of handlers and a note
 * explaining that the map was "the only description of this engine's operation
 * surface", which is why the lifecycle had to live at the bottom of the same
 * file. That note is deleted along with the arrangement it described: a
 * DECLARATION imports only `entities.ts` and `schemas.ts`, so nothing here
 * reaches back into the implementation and there is no cycle to dodge.
 *
 * The immediate reason is #865: `entityCheckConformanceSuite` derives its
 * behavioural pair from `permission` and `input`, and seven of this engine's
 * checks narrow to a reservation. Undeclared, they were not merely untested but
 * undeclarable — `ctx.check(PERM.confirm, reservationRef(id))` and
 * `ctx.check(PERM.confirm)` are the same to a compiler, and the second lets
 * anyone holding `booking:confirm` anywhere in the scope confirm anyone's
 * reservation.
 *
 * What is deliberately NOT here is `http`. An engine is entity-agnostic and owns
 * no URL shape: a padel club calls a reservation a court booking and a clinic
 * calls it an appointment, and both are right. The path is the composing
 * vertical's decision, declared with `defineEngineRoutes` against these names.
 *
 * ## The node checks are a fact, not an omission
 *
 * Four operations check at the NODE while taking a `reservationId`, and that
 * asymmetry is deliberate enough to be worth naming: `booking/expire` sweeps a
 * lapsed hold and `booking/start` / `booking/complete` / `booking/no-show` are
 * service-desk verbs. Each is staff work over whatever reservation is in front
 * of them, not a participant reaching their own booking — so the authority is
 * scope-wide and a narrowed grant would not widen to cover it. `booking/get`
 * and the five participant-facing mutations narrow, because there a grant on
 * one reservation is the whole of someone's access.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { bookingEntities } from './entities.js';
import {
  availabilityInput,
  cancelReservationInput,
  createResourceInput,
  freeInterval,
  holdReservationInput,
  joinReservationInput,
  leaveReservationInput,
  listReservationsInput,
  listResourcesInput,
  moveReservationInput,
  openReservationInput,
  participant,
  reservation,
  reservationAtInput,
  reservationIdIn,
  resource,
  setResourceActiveInput,
} from './schemas.js';

/** The keys these operations check. Mirrors `PERM` in index.ts. */
export const BOOKING_PERMISSIONS = [
  'booking:create',
  'booking:read',
  'booking:hold',
  'booking:confirm',
  'booking:cancel',
  'booking:move',
  'booking:complete',
  'booking:manage-resources',
] as const;

/** The narrowed check five mutations and one read share. */
const onReservation = (key: (typeof BOOKING_PERMISSIONS)[number]) =>
  ({ key, entity: 'reservation', idFrom: 'reservationId' }) as const;

export const bookingOperations = defineOperations(bookingEntities, BOOKING_PERMISSIONS)({
  'booking/create-resource': {
    summary: 'Register a bookable resource',
    permission: 'booking:manage-resources',
    input: createResourceInput,
    output: resource,
  },

  'booking/set-resource-active': {
    summary: 'Take a resource in or out of service',
    permission: 'booking:manage-resources',
    input: setResourceActiveInput,
    output: resource,
  },

  'booking/list-resources': {
    summary: 'Bookable resources, by name',
    permission: 'booking:read',
    input: listResourcesInput,
    inputOptional: true,
    output: resource,
    // Kernel-composed: a resource list is a plain table walk, so the `WHERE`,
    // the `ORDER BY`, the keyset tie-break and the indexes are all the kernel's.
    // `name` first because that is the order this list shipped with.
    paged: {
      over: {
        entity: 'resource',
        sortable: ['name', 'kind', 'created_at'],
        filterable: ['kind', 'active'],
      },
    },
  },

  'booking/hold': {
    summary: 'Place a tentative hold on a slot',
    permission: 'booking:hold',
    input: holdReservationInput,
    output: reservation,
  },

  'booking/confirm': {
    summary: 'Confirm a held reservation',
    permission: onReservation('booking:confirm'),
    input: reservationAtInput,
    output: reservation,
  },

  'booking/expire': {
    summary: 'Sweep a hold whose deadline has passed',
    // Node, deliberately — see the header. A sweep acts on whatever has lapsed.
    permission: 'booking:confirm',
    input: reservationAtInput,
    output: reservation,
  },

  'booking/join': {
    summary: 'Join a reservation that is on offer',
    permission: onReservation('booking:create'),
    input: joinReservationInput,
    output: z.object({ participant, reservation }),
  },

  'booking/leave': {
    summary: 'Leave a reservation previously joined',
    permission: onReservation('booking:cancel'),
    input: leaveReservationInput,
    output: reservation,
  },

  'booking/cancel': {
    summary: 'Cancel a reservation',
    permission: onReservation('booking:cancel'),
    input: cancelReservationInput,
    output: reservation,
  },

  'booking/move': {
    summary: 'Reschedule a reservation to another slot or resource',
    permission: onReservation('booking:move'),
    input: moveReservationInput,
    output: reservation,
  },

  'booking/open': {
    summary: 'Put a reservation on offer, or take it off',
    // Whoever may confirm a reservation may decide whether it is on offer.
    permission: onReservation('booking:confirm'),
    input: openReservationInput,
    output: reservation,
  },

  'booking/start': {
    summary: 'Start service on a reservation',
    permission: 'booking:complete',
    input: reservationIdIn,
    output: reservation,
  },

  'booking/complete': {
    summary: 'Complete a reservation',
    permission: 'booking:complete',
    input: reservationIdIn,
    output: reservation,
  },

  'booking/no-show': {
    summary: 'Mark a reservation as a no-show',
    permission: 'booking:complete',
    input: reservationIdIn,
    output: reservation,
  },

  'booking/get': {
    summary: 'One reservation with its participants',
    permission: onReservation('booking:read'),
    input: reservationAtInput,
    output: z.object({ reservation, participants: z.array(participant) }),
  },

  'booking/list': {
    summary: 'Reservations overlapping a window',
    permission: 'booking:read',
    input: listReservationsInput,
    inputOptional: true,
    output: reservation,
    /**
     * Handler-composed, and the cursor is `id` rather than `startsAt`.
     *
     * The window is an OVERLAP test — `starts_at < to AND ends_at > from` — and
     * the kernel's filter vocabulary is equality only, deliberately (a range
     * vocabulary is where a filter becomes a query language). So this read owns
     * its own `WHERE`, and `paged.sortKey` names the field the cursor walks.
     *
     * It has to be a UNIQUE field. This list shipped `ORDER BY starts_at, id`,
     * and a keyset cursor on `starts_at` skips and repeats rows wherever two
     * reservations share a start — which on a court schedule is every hour. Ids
     * are ULIDs, so `id` is unique and still roughly chronological by creation.
     * A caller rendering a calendar sorts the page by `startsAt` itself.
     */
    paged: { sortKey: 'id' },
  },

  'booking/availability': {
    summary: 'Free intervals on a resource within a window',
    permission: 'booking:read',
    input: availabilityInput,
    output: freeInterval,
    /**
     * A computed fold, not a table walk — so handler-composed, like the list
     * above. The segments this returns are DISJOINT and returned in order, so
     * `startsAt` is unique among them and is a sound cursor where it would not
     * be over reservation rows.
     */
    paged: { sortKey: 'startsAt' },
  },
});
