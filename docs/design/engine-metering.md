---
status: built
layer: kernel
description: The billable-usage ledger.
---

# `engine-metering` — the billable-usage ledger

Status: **built** — the engine ships on npm

> Surface sketch for the metering engine ([#646](https://github.com/substrat-run/substrat/issues/646)).
> Companion to [master-plan.md](../master-plan.md) decisions D-30 (*meter, don't bill*),
> D-31 (metering deferred "until a vertical meters something"), D-33 (the builder portal
> is the platform vertical whose composition includes "meters for their bill"), and
> [commercial-model.md §6](commercial-model.md) (what may be metered). The trigger fired:
> the builder token economy needs AI token usage recorded so it can be charged for, and
> the same bill wants requests, data stored, and other parameters.
>
> **Scope guard, stated once:** this engine answers *"how much of meter X was used in
> window W, per an append-only, idempotent ledger whose closed periods are frozen
> evidence"*. It knows **nothing** about prices, currencies, plans, or tiers — pricing is
> vertical vocabulary (the three-layer rule). It is also **not** the platform-metering
> plane: Analytics Engine datapoints (D-46's `substrat_egress` pattern) stay where they
> are, for cost attribution, abuse detection and spend caps — cheap, high-volume,
> lossy-tolerant. This engine is the **billable** plane: durable, idempotent, in the
> scope's SQL, auditable, because an invoice needs evidence a customer can dispute.

## 0. Settled decisions

### D-A: billable metering is an engine, in the scope's SQL — not kernel, not Analytics Engine

- Not kernel: usage entries are domain entities, and the kernel owns no domain entities.
  D-31's own carve-out ("§10's platform trap: kernel features nobody consumes yet")
  applies until the day a *non-billing* consumer wants the raw shape — at which point
  extracting a primitive **from** this engine is the normal path, same as
  `engine-absence` D-A.
- Not an invoicing extension: invoicing owns priced-lines → immutable-after-export
  underlag, a different invariant set that begins *after* pricing. Bolting usage capture
  onto it would make one engine own two unrelated state machines.
- Not Analytics Engine: AE is sampled and lossy by design — fine for attribution,
  disqualifying for a line item on an invoice.

The two planes stay separate on purpose. Per-request fleet metering stays AE unless a
period aggregate is actually charged; D-30's warning stands — per-operation billing
incentivizes coarser events and starves the audit spine.

### D-B: two entry kinds — counters and gauges — with different aggregation

"Charge by requests, data stored and other parameters" splits cleanly:

- A **counter** is a flow you *sum*: tokens, requests, e-signatures. Window aggregate =
  `Σ qty` over entries with `occurred_at` in the window. Deltas are **signed** decimals:
  a correction (over-recorded usage credited back) is a compensating entry, never an
  edit — the same discipline as every other ledger in the repo.
- A **gauge** is a level you *sample*: bytes stored, seats occupied. Window aggregate =
  `max(sample)` in the window; if the window holds no samples, the **latest sample at or
  before the window start carries forward** — a level persists between observations.
  Samples are non-negative. (Time-weighted average is a plausible later aggregation; it
  arrives additively as a per-meter option, never by reinterpreting shipped data.)

The kind lives on the **meter definition**, not the entry: `configureMeter` registers
`key → {kind, unit}` once, and kind/unit are **frozen after creation** — changing a
meter's unit mid-period corrupts every aggregate that spans the change. New unit = new
meter key.

### D-C: idempotency is the load-bearing invariant — `UNIQUE (meter_key, dedupe_key)`

Every `recordUsage` names a caller-supplied `dedupeKey` (for the builder: the turn id).
A replay with the **same** key and the same quantity returns the existing entry and
emits nothing — a retried turn or an at-least-once consumer can never double-bill. The
same key with a **different** quantity throws: that is an upstream bug, and swallowing
it silently would hide exactly the defect the key exists to catch. Uniqueness is per
meter, not global, so one turn records `ai.tokens.input` and `ai.tokens.output` under
one turn id. This mirrors invoicing's #328 consumer-dedup discipline at the ingest end.

### D-D: period close is an append-only window journal with a hard horizon

`closePeriod(ctx, {from, to})` (half-open `[from, to)`, UTC instants — engine-booking's
convention, deliberately unlike absence's inclusive days) aggregates every meter over
the window, writes an immutable period + line rows, and emits one fat
`metering.period-closed` event. Two rules make the aggregate *evidence* rather than a
snapshot:

- Closes are **monotonic and non-overlapping**: a new period's `from` must be ≥ the
  latest closed `to`. Gaps are allowed (metering may start mid-life); rewinds are not.
- The latest closed `to` is the **close horizon**: `recordUsage` refuses any entry with
  `occurred_at` before it. Nothing can land under an already-closed period, so a closed
  period's lines are reproducible from its entries forever. Late-arriving usage is
  recorded at observation time — the caller controls `occurred_at` and the default is
  now.

Counters with no entries in the window are omitted (a zero sum bills nothing); gauges
carry forward per D-B and appear with `entryCount: 0`.

### D-E: the engine owns quantities; the vertical owns prices — and the invoicing hand-off is event-shaped

`metering.period-closed` carries **unpriced** aggregated lines
(`{meterKey, kind, unit, qty, entryCount}`). The vertical maps meter keys → rates and
feeds invoicing — the same proven wiring as `timesheet.period-closed` → invoicing's
underlag consumer (snapshot-not-join, close id as the dedup key). The engine never
emits a `Money`; the day it does, it has crossed into vertical vocabulary.

### D-F: subjects are optional, opaque, and not data subjects

An entry may carry an attribution `EntityRef` (a builder project, a tenant noun) so a
vertical can split one scope's bill. It is opaque — the engine never dereferences it —
and unlike absence there is **no `DataSubjectId`**: meters count machines and bytes,
not people, and every event is `piiClass: 'none'`. A vertical that wants per-person
usage attribution is metering people and should think hard, then hang its own side
table off the entry id.

The subject is also the **only** tag slot, and that is a boundary, stated twice:

- **Subject ≠ meter dimension.** The meter key is the billing dimension (one frozen
  kind/unit, one line per closed period); encoding a resource id into it
  (`ai.tokens.input:msg-123`) explodes the registry and shatters the period lines. The
  *which* goes in `subject`, the *what* in the meter key.
- **Richer tagging is a vertical side table keyed by the entry id** (decision 28's
  standard pattern) — `recordUsage` returns the entry, the vertical stores
  `(entry.id, …)` in the same transaction. The dedupe key often *is* a resource id (a
  turn id) and doubles as a free lookup handle, but its contract is idempotency —
  nothing more is promised of it.

## 1. Surface

Permissions: `metering:read`, `metering:record`, `metering:configure`,
`metering:close`. Events: `metering.meter-configured`, `metering.usage-recorded`,
`metering.period-closed` (all v1, all `piiClass: 'none'`). No consumers, no schedules —
*when* to close a period is billing policy, which is vertical vocabulary; the vertical
calls `closePeriod` from its own schedule or operation.

In-scope functions (K-16; the caller holds the permission check when composing):
`configureMeter`, `listMeters`, `recordUsage`, `usageTotal` (same aggregation code path
as close — one source of truth), `listEntries`, `closePeriod`, `listPeriods`,
`periodLines`. Default operation bindings exist for all of them.

First consumer (follow-up, on the builder branch): `BuilderAgent` records
`ai.tokens.input` / `ai.tokens.output` per turn with the turn id as dedupe key, from
the `usage` event `AiSdkGenerator` already yields.
