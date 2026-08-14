# Events

## Emitted

| Event | When |
|---|---|
| `metering.meter-configured` | a meter registered, or its description/active updated |
| `metering.usage-recorded` | a **new** usage entry lands — a deduped replay emits nothing |
| `metering.period-closed` | a window is frozen into lines; the billing hand-off |

Consumes nothing.

## Payload contracts

All payloads are **fat**: a consumer never reads back across the module boundary.

- `metering.meter-configured` — `{ key, kind, unit, active }`.
- `metering.usage-recorded` — `{ entryId, meterKey, kind, unit, qty, subject,
  occurredAt, dedupeKey }`. Because a deduped replay emits nothing, **the event stream
  is itself dedupe-clean**: a consumer summing `qty` per meter sees each observation
  exactly once (modulo the platform's at-least-once delivery — dedupe on `entryId`).
- `metering.period-closed` — `{ periodId, from, to, lines }`, where each line is
  `{ meterKey, kind, unit, qty, entryCount }`. **Quantities, never prices**: the
  vertical maps meter keys to rates and feeds [invoicing](/engines/invoicing/), exactly
  like the timesheet close hand-off ([composing](./composing)). Dedupe on `periodId`.

## PII

Every event is `piiClass: 'none'`, and — unlike the absence engine — writes take **no
`DataSubjectId`**: meters count machines and bytes, not people. The optional `subject`
ref is an attribution noun (a project, a message), not an identity. A vertical that
finds itself metering *people* per-person should stop and think — and if it proceeds,
hang its own PII-classified side table off the entry id rather than widening this
engine's events.

## Versioning

Every event is emitted at `schemaVersion: 1`. Payload fields are **frozen once
shipped**: additions are fine, renames/removals/retypes mean a `schemaVersion` bump with
a dual-emit deprecation window — the platform-wide rule, restated because billing
events are exactly the kind external consumers (a warehouse drain, a Stripe usage
connector) quietly grow to depend on.
