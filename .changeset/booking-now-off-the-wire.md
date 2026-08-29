---
'@substrat-run/engine-booking': minor
---

`now` is no longer an operation input (#961). Every declared booking input — hold,
confirm, expire, join, leave, open, move, get, list, availability — used to accept an
optional `now` that the engine preferred over `ctx.now()`, so a caller holding
`booking:confirm` could confirm an expired hold by back-dating it, or sweep a live one
by post-dating it. The wire schemas drop the field and the host's input parse strips
it; the in-scope functions keep `now?` (`holdReservationCall`, `joinReservationCall`,
`moveReservationCall` are the wire inputs plus `now`, and `HoldReservationInput` /
`JoinReservationInput` / `MoveReservationInput` still name that shape), so a vertical
composing by call and a test still choose the instant. `reservationAtInput` is now a
deprecated alias of `reservationIdIn`.
