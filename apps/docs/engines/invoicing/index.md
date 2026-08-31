# Invoicing engine

`@substrat-run/engine-invoicing` — accumulates **invoice bases** (Swedish: *invoice basis*)
from billable events and makes them **immutable once exported**.

It is the reference example of star-topology composition *and* cross-domain reuse: it builds
invoice bases from events in more than one domain — work-order completions and retail
orders — with zero imports from either producer.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-invoicing` |
| **Entitlement key** | `invoicing` |
| **Owns** | invoice-basis accumulation, one-document-one-currency, immutability on export |
| **Emits** | `invoicing.underlag-updated` (v1), `invoicing.underlag-exported` (**v2**) |
| **Consumes** | `workorder.completed`, `commerce.order-placed` — with zero imports from either |
| **Permissions** | 2 (`invoicing:read` · `invoicing:export`) |
| **Composed** | **by event** — you emit, it consumes, you read back; [no in-scope functions, by design](./surface#in-scope-functions) |
| **Status** | product seed (0.x) — surfaces change until the first vertical ships |

## What it owns

- **Exported means immutable.** Once a basis is exported, nothing appends, nothing edits,
  and exporting again throws.
- **One document, one currency.** A delivery whose lines disagree on currency is rejected at
  write time rather than producing a total that means nothing.
- **Snapshot, not join.** Prices and quantities are frozen from the event payload;
  provenance is kept as `EntityRef` columns.
- **Idempotent on replay.** The source order is the dedup key, so a redelivered completion
  adds nothing rather than billing twice.

Details: [Domain model & invariants](./model).

## What it will not do

- **Issue invoices.** It produces the *basis* — billable lines with frozen prices and
  provenance, ready to hand to whatever actually invoices.
- **Bookkeeping.** Not a ledger, not accounts receivable, not payment tracking. That
  territory belongs to accounting systems, reached through connectors.
- **Pricing.** Prices arrive priced, in the event payload. The engine sums; it never rates.

## Is this a good match?

| Reach for it when | Look elsewhere when |
|---|---|
| Billable facts arrive as **events** from elsewhere | You want to build an invoice by hand in a form — nothing consumes to |
| You need a frozen, auditable basis handed to an accounting system | You need the invoice itself, with numbering and VAT logic |
| "What was this charge based on, and where did it come from?" must be answerable years later | Nobody will ever ask |
| You want prices frozen at the moment of the fact, not at read time | Re-pricing history is acceptable |
| Your bookkeeping lives in Fortnox/Visma-class software | You intend to *be* the ledger |

The clarifying question: **do you need the artifact that justifies an invoice, or the
invoice?** This engine owns the first and deliberately stops at the second.

Cross-domain reuse is proven here, not theoretical: the same immutability and snapshot
machinery serves a field-service firm (`workorder.completed`) and a coffee roaster
(`commerce.order-placed`), and adding the second was a purely additive change.
