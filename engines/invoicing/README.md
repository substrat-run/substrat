# @substrat-run/engine-invoicing

Invoicing engine for [Substrat](https://github.com/substrat-run/substrat) —
accumulates **invoice bases** (Swedish: *invoice basis*) from billable events and
makes them **immutable once exported**.

It produces the *basis* for an invoice: per-customer collections of billable lines
with frozen prices and provenance, ready to hand to whatever actually issues invoices
(typically an accounting connector). It is **not** a ledger, not accounts receivable,
not payment tracking.

## What it owns

- **Exported means immutable** — nothing appends, nothing edits, exporting twice throws.
- **One document, one currency** — a mixed-currency delivery is rejected at write time.
- **Snapshot, not join** — prices are frozen from the event payload, with provenance kept.
- **Idempotent on replay** — the source order is the dedup key, so a redelivery never
  bills twice.

## Install

```sh
pnpm add @substrat-run/engine-invoicing
```

```ts
import { invoicingModule } from '@substrat-run/engine-invoicing';

host.registerModule(invoicingModule);
```

That's the whole integration. Lines arrive by **event**, never by call: the engine consumes
`workorder.completed` and `commerce.order-placed` with **zero imports** from either producer,
parsing its own Zod view of each payload. To make a new domain billable, emit an event — you
never import this engine to do it.

## Documentation

**https://substrat.net/engines** — the domain model and invariants, the
operation/permission surface, event contracts and versioning, and how to compose or extend it.

The docs site is the single source of truth; this README deliberately doesn't restate it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/engine-workorder`](https://npmjs.com/package/@substrat-run/engine-workorder) —
  the producer of the billable events this engine consumes

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
