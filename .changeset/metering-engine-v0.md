---
'@substrat-run/engine-metering': minor
---

`engine-metering` v0 (#646): the billable-usage ledger. D-31 deferred metering
"until a vertical meters something" — the builder token economy is that trigger.
The engine owns an append-only usage ledger over configured meters (kind/unit
frozen after creation), idempotent ingest keyed by `(meter, dedupeKey)` (a
replayed turn can never double-bill; a reused key with a different qty throws),
the counter/gauge aggregation split (counters sum signed deltas; gauges take
max-in-window and carry their level across silent windows), and an append-only
period-close journal whose latest `to` is a hard horizon no new entry may land
behind — closed periods stay reproducible from their entries forever.

`closePeriod` emits one fat `metering.period-closed` event with **unpriced**
lines (`{meterKey, kind, unit, qty, entryCount}`): pricing is vertical
vocabulary, and the vertical feeds invoicing exactly like the
`timesheet.period-closed` hand-off. This is the *billable* metering plane;
platform metering stays Analytics Engine (D-46 pattern) — two planes, kept
separate on purpose (`docs/design/engine-metering.md`).
