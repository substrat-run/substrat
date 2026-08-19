# Metering engine

`@substrat-run/engine-metering` — billable usage as an **append-only, idempotent meter
ledger whose closed periods are frozen billing evidence**. It counts what happened —
tokens, requests, bytes stored — and deliberately knows nothing about what any of it
costs: pricing is the vertical's.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-metering` |
| **Entitlement key** | `metering` |
| **Owns** | the append-only usage ledger, idempotent ingest, the counter/gauge aggregation split, the period-close journal and its horizon |
| **Emits** | 3 events, `metering.usage-recorded` → `metering.period-closed` ([events](./events)) |
| **Consumes** | nothing — it is a source, not a sink |
| **Permissions** | 4 (`metering:read` · `record` · `configure` · `close`) |
| **Status** | product seed (0.x) — surfaces change until the first vertical ships |

## What it owns

- **The ledger is append-only, always.** A usage entry is never edited or deleted; an
  over-recorded counter is corrected by a **compensating entry** with a negative delta,
  so the record of what was believed when survives — the same discipline as every other
  ledger on the platform.
- **Ingest is idempotent by construction.** Every `recordUsage` names a caller-supplied
  **dedupe key**, unique per meter. A replay with the same key and quantity returns the
  existing entry — no second row, no second event, no double bill. The same key with a
  *different* quantity throws: that is an upstream bug, and swallowing it would hide
  exactly the defect the key exists to catch.
- **Counters and gauges aggregate differently, on purpose.** A *counter* (tokens,
  requests) is a flow you **sum**; a *gauge* (bytes stored, seats) is a level you
  **sample** — its window aggregate is the max in-window, and a gauge with no samples in
  a window **carries its last level forward**. The kind lives on the meter definition
  and is frozen after creation.
- **A closed period is evidence, not a snapshot.** `closePeriod` freezes a half-open
  `[from, to)` window into immutable per-meter lines and emits one fat event. Closes are
  monotonic, and the latest closed `to` is a **hard horizon**: no new entry may land
  behind it, so a closed period's lines stay reproducible from its entries forever.
- **Entries may carry an opaque attribution ref.** An optional `subject`
  (`EntityRef` — a builder project, a message, whatever the vertical's noun is) tags an
  entry for bill-splitting and filtering. The engine never dereferences it.

### The property worth understanding

**This is the *billable* metering plane, and it is deliberately not the only one.** The
platform's high-volume telemetry — per-request, per-subrequest, per-egress-verdict —
rides Analytics Engine datapoints: cheap, unbounded, lossy-tolerant, right for cost
attribution and abuse detection, and disqualified from invoices by its sampling. This
engine is the other plane: durable, transactional, in the scope's own SQL, auditable —
because an invoice needs evidence a customer can dispute. If you are metering something
high-volume for billing, **pre-aggregate before recording** (one entry per hour or day,
with the bucket id as the dedupe key) rather than mirroring the firehose into the ledger
([composing](./composing)).

## What it will not do

- **No prices, no currency, no plans.** `metering.period-closed` carries *unpriced*
  quantities. The vertical maps meter keys to rates and feeds
  [invoicing](/engines/invoicing/) — the day this engine emits a `Money`, it has crossed
  into vertical vocabulary.
- **No close schedule.** *When* to close a period — monthly, weekly, on demand — is
  billing policy, which is vertical vocabulary. The vertical calls `closePeriod` from
  its own schedule or operation.
- **No collection.** The engine records what callers hand it; observing the usage (an
  AI turn's token count, a storage sample) is the vertical's or platform's job.
- **No per-subject bill splitting in closed lines (v0).** Lines aggregate per meter
  across all subjects; per-subject detail stays queryable from the entries. Grouping
  lines by `(meter, subject)` is a plausible additive extension when a vertical needs
  the *bill itself* split.
- **No spend caps or rate limits.** Those are enforcement, live on the platform plane,
  and must not depend on a ledger a scope owner could starve.

## Where it came from

Unlike its siblings, this engine was **not extracted from a vertical** — it was built
against a named first consumer with the second in sight, and the decision log carries
that honestly. The platform's billing doctrine (*meter everything, bill the few*)
deferred metering "until a vertical meters something"; the **builder portal's token
economy** is that trigger — AI turns whose token usage must be recorded so it can be
charged for. Vertical AI features are the anticipated second consumer. The design
decisions — the two planes, the dedupe contract, the horizon — are pinned in
`docs/engines/metering.md` in the repository.
