---
'@substrat-run/engine-booking': minor
---

Booking's state machine is declared (#844).

The seven reservation states were written out twice — as the `state` column's `z.enum` in
`entities.ts` and again as `reservationState` in `index.ts` — and the edges between them a
third time, as whatever states each of nine `requireState` call sites happened to pass.
`reservationState` is now taken from the entity registry, and the machine is declared with
`defineLifecycles`.

**The format needed no changes**, which was the point of adopting the hardest case second.
Three findings, all expressible as they stand:

- **Three of the nine guards are not transitions.** `join`, `open` and `move` are legal in
  `held` or `confirmed` and move nothing — `allow`, not `on`. Declaring them as edges would
  have put three self-loops on the diagram that no code performs.
- **A join that fills the last place still isn't an edge.** It ends confirmed, but the move
  belongs to `booking/confirm`, the in-scope function it composes, and goes through the same
  check on the way. `join → confirmed` would claim every join confirms.
- **Lazy expiry is not an edge.** `held → expired` is one (`booking/expire` performs it);
  the *lapse* is not. The guard runs on the stored state, so a lapsed hold is still refused
  by `confirm` with its own `hold_expired` reason rather than being flattened into
  `invalid_transition`.

`BOOKING_CONFLICT_REASONS` now references the shared `INVALID_TRANSITION` constant, since
that reason is raised by `assertTransition` rather than by this engine.

Behaviour unchanged: 55 tests pass untouched, and no migration — the state set is the same.
