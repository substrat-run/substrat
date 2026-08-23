import { defineLifecycles } from '@substrat-run/contracts';
import { bookingEntities } from './entities.js';
import { bookingOperations } from './operations.js';

/**
 * The reservation's state machine, declared (#844).
 *
 * Checked against `bookingOperations` — the DECLARED registry — rather than the
 * handler map it used to read. Same names, but the declaration is the surface a
 * vertical binds to, so an edge naming an operation that no longer exists is now
 * caught against the thing callers actually see.
 *
 * ## `on` versus `allow` — the distinction this engine forced
 *
 * Three of the nine guards gate operations that move NOTHING. `booking/move`
 * changes a reservation's times, `booking/open` its fill target, `booking/join`
 * adds a participant — each legal only in `held` or `confirmed`, and none of
 * them a transition. Declaring them as edges would have put three self-loops on
 * the diagram that no code performs.
 *
 * ## Why `booking/join` is `allow` even though joining can confirm
 *
 * A join that fills the last place calls `confirmReservation` — so a join CAN
 * end with a confirmed reservation. It is still not an edge. The move is
 * `booking/confirm`'s, performed by the in-scope function join composes, and it
 * goes through this same check on the way. Declaring `join: 'confirmed'` would
 * claim every join confirms, which is false for all but the last one.
 *
 * That is the composition rule holding: an engine composed BY CALL gets its
 * invariant from the callee, so the machine describes what each verb does
 * itself, not what its callees might do next.
 *
 * ## Lazy expiry is not an edge either
 *
 * `held → expired` IS declared — `booking/expire` performs it. What is not
 * declared is the lapse: a hold past its deadline reads as `expired` through
 * `effectiveStateOf` without any transition occurring, which is a projection for
 * display and allocation. The condition on the edge (`not_yet_expired`) stays in
 * the handler, where a lifecycle deliberately cannot reach.
 *
 * ## No `extensible` states
 *
 * Every state here carries an allocation or capacity consequence, and the four
 * terminal ones release capacity. Refining any of them is not a vertical's to do
 * yet, and the absence says so rather than leaving it to be inferred.
 */
export const bookingLifecycles = defineLifecycles(
  bookingEntities,
  bookingOperations,
)({
  reservation: {
    field: 'state',
    initial: 'held',
    states: {
      /** A deadline-bearing claim on capacity. */
      held: {
        on: {
          'booking/confirm': 'confirmed',
          'booking/expire': 'expired',
          'booking/cancel': 'cancelled',
        },
        allow: ['booking/join', 'booking/open', 'booking/move'],
      },
      /** Capacity is committed. `complete` may skip `in_service` — starting is optional. */
      confirmed: {
        on: {
          'booking/start': 'in_service',
          'booking/complete': 'completed',
          'booking/no-show': 'no_show',
          'booking/cancel': 'cancelled',
        },
        allow: ['booking/join', 'booking/open', 'booking/move'],
      },
      /** Under way. No longer cancellable, and no longer re-timeable. */
      in_service: {
        on: {
          'booking/complete': 'completed',
          'booking/no-show': 'no_show',
        },
      },
      expired: { terminal: true },
      cancelled: { terminal: true },
      completed: { terminal: true },
      no_show: { terminal: true },
    },
  },
});
