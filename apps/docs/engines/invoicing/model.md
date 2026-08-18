---
description: "The invoicing engine's two tables, the immutable-after-export invariant, why lines snapshot their source rather than join to it, and the rule that one document carries one currency."
---

# Domain model & invariants

## Tables

Created by migration `0001-init`, inside each scope's own database:

- **`invoicing_underlag`** — id, sequential `number`, customer as `EntityRef` columns
  (`customer_type`/`customer_id`), `status` (`open`/`exported`), `created_at`, `exported_at`.
- **`invoicing_lines`** — underlag, provenance (`source_type`, `source_id`), article,
  description, qty, unit, unit price (amount + currency), line total, `created_at`.

There is no customer table and no article table — those are opaque refs the vertical owns.

## The immutability invariant

An underlag is `open` or `exported`:

- While **open**, consumed events append lines.
- **`invoicing/export`** flips it to `exported` — and from then on it is immutable. Nothing
  appends to it, nothing edits it, and attempting to export it again throws.
- Billable work arriving *after* export (a late time report, a re-opened order) opens a
  **new** underlag. History is never rewritten; late facts become new facts.

This is the engine invariant on top of the kernel's guarantees: the kernel makes events
trustworthy; the engine makes the financial artifact derived from them tamper-proof.

## Snapshot, not join

Each consumed event has its **own** consumer with its **own** Zod view of the payload — never
the producer's types. When a work order completes, the consumer:

1. **Parses its own view of the payload**:

   ```ts
   const completedPayload = z.object({
     orderId: z.string().min(1),
     number: z.number().int(),
     customer: entityRef,
     billable: z.array(z.object({ article, description, qty, unit,
                                  unitPrice: money, lineTotal: money, sourceType, sourceId })),
     total: money,
   });
   ```

2. **Guards against replay** — if lines for that `source_id` already exist, return.
3. **Finds or creates the open underlag** for that customer — one open collection per
   customer at a time.
4. **Copies the billable lines** with provenance (`source_type: 'workorder'`,
   `source_id: orderId`).
5. **Emits `invoicing.underlag-updated`.**

Prices and quantities are **frozen from the event payload** at the moment the work order
completed. If the vertical's price list changes tomorrow, yesterday's underlag doesn't —
which is exactly what an invoice basis must guarantee. Provenance is kept as `EntityRef`
columns, so every line can answer "where did you come from?" without the engine ever querying
the work-order tables.

The `commerce.order-placed` consumer is the same five steps with `source_type: 'order'` (a
discount arrives as a negative line, so the total stays net), plus one domain rule: **only
invoice-payment orders bill** — card and Swish settle through a payment connector, so those
events return early.

## Idempotency

Consumers are delivered **at-least-once** and run under a system actor. Three things keep the
handlers idempotent:

1. find-or-create on the underlag,
2. the kernel's delivery journal,
3. a **source-id guard** — before inserting anything, each consumer asks whether lines for
   that `source_id` already exist and returns if they do.

The source order is the dedup key, so a replayed completion adds nothing rather than billing
the customer twice.

Dispatch is **post-commit**, and each consumer runs in **its own transaction**. A consumer
that throws does not roll back the producer — it rolls back only its own work, and the
delivery is **dead-lettered** (journalled with the error) so one poison event can't wedge the
loop. That's why a malformed payload leaves no half-built underlag, and why `await` on the
producing operation tells you nothing about whether the consumer succeeded.

## One document, one currency

Totals use the sanctioned [exact decimal arithmetic](/concepts/money) — and `addMoney`, not
`addDecimal`, precisely because it is **currency-aware**. Summing 100 SEK and 100 EUR into
`200` is not a rounding error; it is a financial artifact stating a number that means nothing,
so the engine refuses instead.

A delivery whose lines disagree with each other, or with the lines already on the open
underlag, is rejected **at write time** and dead-lettered — so a mixed-currency event never
creates a document that can't be read or exported. Rejecting at read time instead would leave
a document that can never be listed or exported again.

::: warning Currency lives on the line, not the document
Currency is carried per line today, so an underlag with no lines has no currency to report and
falls back to `SEK` — attributing a currency to an empty document is exactly the guess this
engine shouldn't make. Hoisting currency onto the underlag itself is the honest fix; it needs
a migration and therefore a human review checkpoint.
:::
