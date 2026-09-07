---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Declared freshness expectations (#1232): a module may declare that a scope
should keep seeing an event — `freshness: [{ eventType: 'receipt.landed',
within: { hours: 24 } }]` — and the platform judges it where the evidence lives.
The expectation is refused at parse when it names a type the module neither
emits nor consumes (a typo would read as permanently stale forever), flattens
into the deploy manifest like `schedules`, and is evaluated during the
scope-side sweep pass — one indexed `MAX(occurred_at)` read of the scope's own
outbox, never a control-plane read of event history. Verdicts land as a third
sweep-run kind, `freshness`, with the judged event type as its own dimension
(never smuggled into `operation`) and the newest evidence in a new `observedAt`
column — so a HEALTHY row can still say "last receipt 3h ago".

Freshness writes on verdict CHANGE plus an hourly heartbeat, deliberately unlike
schedules: its steady state is `ok`, so per-pass rows would flood the strip with
green while the heartbeat keeps "no rows" unambiguous (a missing hourly row is a
stopped evaluator, at exactly the resolution a 24-hour expectation needs). The
`skipped` outcome means never-observed — a brand-new install must not open red.
The evaluator is deliberately NOT gated on the module's system grant (freshness
is a read of the scope's own outbox; the grant tuple only exists for modules
with permissioned schedules, and gating would silently disable the module shape
that needs this most), and a freshness-only module registers through its own
registry rather than the schedule map that would have dropped it. Duplicate
declarations of one type collapse to the tightest window — one row per
(scope, eventType), or the drain's dedupe index would eat one. CP-less verticals
report through the same batched sweep-runs intent, now kind-discriminated with
old payloads defaulting to `schedule` and meaning exactly what they meant.
