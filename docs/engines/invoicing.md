---
status: built
layer: kernel
description: The invoice-basis ledger — consumes delivery events, immutable after export.
---

# `engine-invoicing` — the invoice basis, immutable after export

Status: **built** — `@substrat-run/engine-invoicing`, live on npm.

> **Written after the fact**, from the source. This engine predates the convention of
> writing an engine design document; §7 marks what is genuinely open rather than
> reconstructing arguments nobody recorded.

**Composed by event** ([CLAUDE.md](../../CLAUDE.md)) — and it is the reference case for that
mode. The vertical *emits*; this engine consumes and is the only writer of its rows. There
are **deliberately no in-scope exports**. That absence is the design: `exported` means
immutable, and an engine that handed out a composable write path could not promise it,
because a half-finished caller could leave an exported basis mutated.

A vertical reads results back through the engine's own operations, or by consuming its
events into a side table keyed by the engine's id (D-28).

## 1. What it consumes, and the rule that shapes everything

```
workorder.completed      v1  ─┐
commerce.order-placed    v1  ─┼──▶  invoicing_underlag + invoicing_lines
timesheet.period-closed  v1  ─┘
```

**Snapshot, never join.** Prices and quantities are frozen from the event payload at the
moment of consumption; provenance is kept as `EntityRef` columns. The engine holds **zero
imports from the workorder engine** — star topology (D-19) enforced by there being nothing
to import. If a work order's prices later change, the basis does not, which is the point: an
invoice basis is a record of what was agreed, not a live view.

Three producers of three different shapes — field service, e-commerce, timesheets — is what
makes this an engine rather than Callout code, and it is D-27's extraction condition met
several times over.

## 2. Tables

| table | shape |
|---|---|
| `invoicing_underlag` | `id`, `number` (UNIQUE), `customer_type`/`customer_id`, `status` (`open` \| `exported`), `created_at`, `exported_at` |
| `invoicing_lines` | `id`, `underlag_id`, `document_type`/`document_id`, `source_type`/`source_id` (nullable), `article`, `description`, `qty`, `unit`, `unit_price_amount`, `currency`, `line_total_amount`, `created_at` |

**Two levels of provenance, split in migration `0002` (#328).** `document_*` says *which
delivery produced this line* — a work order, an order, a timesheet — and is always known, so
`NOT NULL`. `source_*` says *what the line itself is* — time versus material — and exists
only where a producer supplies it, so it is nullable. Before `0002` the document occupied
`source_*` and the per-line provenance the `workorder.completed` payload validates was
parsed and thrown away.

Money is stored as amount-string plus currency, never a float (K-14).

## 3. State machine

```
        (delivery event)                 export
   ∅ ──────────────────▶ open ──────────────────▶ exported
                          │                          │
                     lines accrete              immutable
```

`open` accretes lines as delivery events arrive. `export` is one-way. There is no reopen —
the compensating move is a new basis, which is what keeps an exported artifact evidence.

## 4. The invariant this engine exists for

**Immutable after export**, enforced in the engine and not by convention:

```
underlag <n> is 'exported' — exported underlag are immutable
```

Every write path checks the status first. Combined with the absence of in-scope exports
(above), there is no reachable code path — from a vertical, from another engine, from a
connector — that mutates an exported basis. That is a structural guarantee rather than a
reviewed one, which is the distinction the whole platform is built on.

## 5. Permissions

`invoicing:read` · `invoicing:export`, with their manifest descriptions and the role shape
the split argues for, at
[`apps/docs/engines/invoicing/surface.md`](../../apps/docs/engines/invoicing/surface.md#permissions).

`attachmentTargets` exposes `underlag` behind `invoicing:read`. Entitlement key:
`invoicing`. Note there is no `invoicing:create` — bases are created by *consuming an
event*, never by a permissioned call, which is what "composed by event" means at the
permission surface.

## 6. Events

What is emitted and consumed, with payloads, is at
[`apps/docs/engines/invoicing/events.md`](../../apps/docs/engines/invoicing/events.md)
(published at [substrat.net/engines/invoicing/events](https://substrat.net/engines/invoicing/events)).
The version argument below is what belongs here, and the published page does not carry it.

`invoicing.underlag-exported` is at **v2** because v1 stated `total` as a bare amount string with no
currency — on a financial artifact. `demos/callout/spec/testrun.md` had always specified
`total: Money`, so the bump is the code meeting its own spec rather than a change of intent.

**The bump shipped as a replace, deliberately violating D-28's dual-emit rule**, and the
reasoning is recorded in the source: consumer dispatch keys on event *type* only (the
`schemaVersion` in `consumes` is discarded at registration), so emitting v1 and v2 would
deliver **both** to every consumer of this type. This event's consumer is by design an
accounting connector, so that means **invoicing twice, silently**. A clean replace fails
loudly instead — a v1 consumer's strict parse rejects v2 and dead-letters, which someone
sees.

That is a workaround, not a resolution, and it is the concrete case behind kernel open
question 16 (§7).

## 7. Open questions

1. **D-28's dual-emit clause is unimplementable, and this engine is where it bites.**
   Either dispatch honours `(type, schemaVersion)`, or the clause is struck and every
   payload change becomes a loud-failure replace. The current state — a written rule the
   platform cannot execute — is the one option that should not survive review. Kernel open
   question 16; [#128](https://github.com/substrat-run/substrat/issues/128). The question
   says *decide before a third party consumes an engine event*; this package is on public
   npm.
2. **VAT is not modelled.** Lines carry a unit price and a line total, with no tax
   treatment. A third consumer asking for VAT carriage is
   [#326](https://github.com/substrat-run/substrat/issues/326), and
   `strategy/commerce-gaps.md` §4.1 walks what it would take.
3. **`number` is `MAX(number) + 1` per scope** — correct under serialized execution (K-6),
   stated because it would not be elsewhere.
