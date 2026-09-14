---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

A drained event now carries `causedBy`, so the causal link survives the trip to Tier 2.

The outbox has stored `caused_by` since #1237 — the event a given event was emitted in reaction to, and the only thing that lets a backwards walk continue past a consumer hop, where neither the operation nor the authorization chain can help. The shape a drain publishes did not carry it. Both adapters read the row with `SELECT *`, so the column was right there, and both then built the result from the envelope plus `operation` and `version` — and the envelope's own parse strips what it does not declare.

The consequence was not a missing field but a false one: the lake's `caused_by` would have been null on every row, reading as "nothing ever had a cause" rather than "this was never shipped". Sixteen of the outbox's seventeen shippable columns made the trip.

`causedBy` is required-and-nullable, exactly like `operation` and `version` beside it: the drain always has an answer, and "nothing was being delivered" is spelled `null` rather than by omitting the key. It reads from the outbox column rather than the envelope, on `version`'s precedent — the host stamps it during a delivery, so module code can neither forge nor suppress it.

The contract assertion lives where a non-null cause actually exists, in the causal-walk test rather than the drain test. A presence check over a directly emitted event would pass just as well against a hard-coded `null`, which is the bug itself; asserting that the drain reports `step1.id` for the consumer-emitted event, and `null` for the one that began the chain, fails on both.
