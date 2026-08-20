# Domain model & invariants

## The state machine

**Declared**, in `engines/workorder/src/lifecycle.ts`, and emitted to
`engines/workorder/model.json` — this is the first engine to adopt a
[lifecycle](/concepts/lifecycle). The table below is written from that declaration; the
declaration is the source, and `pnpm lint:model --check` is what keeps this page from
drifting away from it.

```
planned ──start──▶ in_progress ──complete──▶ completed ──close──▶ closed
```

| Operation | Legal in | Moves to | Permission |
|---|---|---|---|
| `workorder/create` | — | `planned` (the declared `initial`) | `workorder:create` |
| `workorder/assign` | `planned` | — | `workorder:assign` |
| `workorder/start` | `planned` | `in_progress` | `workorder:report` |
| `workorder/report-time` | `planned`, `in_progress` | — | `workorder:report` |
| `workorder/report-material` | `planned`, `in_progress` | — | `workorder:report` |
| `workorder/complete` | `in_progress` | `completed` | `workorder:complete` |
| `workorder/close` | `completed` | `closed` | `workorder:close` |

The rows with no target are `allow` entries — legal in that state, moving nothing.
Assignment is a field, not a state, which is why `assign` leaves the order in `planned`.

`in_progress` is the one state marked `extensible`, so a vertical may refine it with
substates (`awaiting_parts`, `pending_customer_approval`). `completed` and `closed` carry
billing consequences and admit none. `closed` is `terminal`.

Invalid transitions throw a `conflict` carrying `reason: 'invalid_transition'` — a
`completed` order cannot be started, a `planned` order cannot be completed. The engine owns
this; no caller can skip a state.

## Tables

Created by migration `0001-init`, inside each scope's own database:

- **`workorder_orders`** — id, sequential `number` (per scope), `facility` and `customer` as
  opaque `EntityRef` columns, vertical-defined `kind`, title/description, status, assignment,
  provenance (`created_by`, `created_at`, `completed_at`).
- **`workorder_time_entries`** — order, technician, decimal `hours`, note, `reported_at`.
- **`workorder_material_lines`** — order, article, decimal `qty`, note, reporter, `reported_at`.

Notice what's *absent*: no facility table, no customer table, no price columns. The engine
references facilities and customers as opaque refs the vertical owns, and it records
quantities, not prices — **quantities are facts, prices are business decisions.**

## The invariants

1. **The state machine cannot skip states** (above).
2. **Time and material are append-only.** There is no update or delete operation for reported
   entries. Corrections are a vertical-level concern (a compensating entry), never a silent
   edit.
3. **The reporter is the principal.** Time entries record `ctx.principal` as the technician;
   material lines record the reporter. Attribution comes from the ambient context, not from
   the input — a caller cannot claim someone else did the work.
4. **Every mutation emits a fat event** ([events](./events)).

## Completion: the pricing boundary

`complete` is where the engine meets money, and the boundary is precise: **the vertical
prices, the engine freezes.**

```ts
await stub.invoke('workorder/complete', {
  orderId,
  billable: [
    {
      article: 'TIME', description: 'Servicetekniker', qty: '2.5', unit: 'h',
      unitPrice: moneyOf('850', 'SEK'), lineTotal: moneyOf('2125', 'SEK'),
      sourceType: 'time', sourceId: timeEntryId,
    },
    // ...
  ],
});
```

Each billable line carries **provenance** (`sourceType: 'time' | 'material'`, `sourceId`)
back to the reported entry it prices. The engine validates the lines (Zod + [exact decimal
arithmetic](/concepts/money)), sums the total with `addMoney`, transitions the order, and
emits `workorder.completed` with the full billable snapshot in the payload.

The engine never *derives* a price from a reported entry — it has no rates to derive from.
It checks that what it was handed is arithmetically sound, then makes it permanent.
