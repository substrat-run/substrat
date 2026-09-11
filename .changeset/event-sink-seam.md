---
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
---

The event drain runs (#1334, ingest complete). `EventSink` joins `AccessLogSink`
as a kernel-named seam the platform binds an implementation to, the sweep gains
an event-drain phase over every active scope, and `createR2EventSink` writes the
batches as partitioned NDJSON.

The order is the safety property, and it is the same one the access-log drain
already documents: read the oldest undrained events, ship them and let the sink
confirm durability, and only then stamp `drainedAt`. Reversing the last two would
mark events as shipped that never left — and unlike the access log nothing
downstream would notice, because the stamp is the only record of what the lake is
supposed to hold. A repeat is the acceptable failure; a silent hole is not.

Absent a sink, no scope is drained — the same "absent is a supported answer"
shape `accessLogSink` and `recordSweepRun` already have. One scope's failure is
reported and never stamps, so its events are taken again next tick, and a scope
whose batch fills the budget is reported rather than looped so one busy scope
cannot starve the pass. Nothing is pruned: the outbox still serves consumers,
replay and `readHistory`, so the stamp buys knowing what has left, not deletion.

This establishes durable Tier 2 ingestion. It does **not** bound scope storage:
nothing is deleted from `_substrat_outbox`, which still serves consumers, replay
and `readHistory`, so a scope's events keep accumulating exactly as before. What
the stamp buys is knowing what has left; a retention policy is a separate
decision that has not been made.

**NDJSON to R2 rather than Pipelines-to-Iceberg for v1, deliberately.** §5.3
settles that "Iceberg is the contract, the query engine is replaceable" and
leaves R2 SQL's fitness open pending a benchmark, so this uses a bucket the
platform already operates without committing the ingest path to a product
decision nobody has made. Objects are partitioned by tenant, scope and the UTC
day each event OCCURRED — a batch spanning midnight is split, so a `day=`
partition never contains another day's events. The drain is at-least-once by
design, so a reader deduplicates on event id.
