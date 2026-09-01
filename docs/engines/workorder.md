---
status: built
layer: kernel
description: The work-order state machine, with append-only time and material reporting.
---

# `engine-workorder` — the order state machine, and append-only reporting

Status: **built** — `@substrat-run/engine-workorder`, live on npm.

> **Written after the fact.** This engine predates the convention of writing an engine
> design document, so this describes what is in the source rather than what was argued
> before it. Where a decision is recoverable from the code or a log entry it is stated;
> where it is not, §7 says so instead of inventing one.

**Composed by call** ([CLAUDE.md](../../CLAUDE.md)). Every piece of behaviour is a plain
exported function taking `ctx`; the registered operations are thin default bindings of
those functions. A vertical wraps them inside its own transaction and extends by
composition — the pricing moment (§4) is the reason that matters.

## 1. Tables

Three, all namespaced `workorder_*`, all in the scope database (K-11).

| table | shape |
|---|---|
| `workorder_orders` | `id`, `number` (UNIQUE, per-scope sequence), `facility_type`/`facility_id`, `customer_type`/`customer_id`, `kind`, `title`, `description`, `status`, `assigned_to`, `created_by`, `created_at`, `completed_at` |
| `workorder_time_entries` | `id`, `order_id`, `technician`, `hours`, `note`, `reported_at` |
| `workorder_material_lines` | `id`, `order_id`, `article`, `qty`, `note`, `reported_by`, `reported_at` |

Two things about this schema carry the engine's invariants rather than being incidental:

- **The facility and the customer are `EntityRef` pairs, not foreign keys.** `facility_type`
  + `facility_id` names something the *vertical* defines, and the engine never resolves it.
  That is D-28's private-schema rule from the inside: the engine has no idea what a facility
  is, which is exactly why a bike shop and a property manager can both use it.
- **The reporting tables have no `updated_at` and no update path.** Time and material are
  append-only by construction (§2), so there is nothing to stamp.

`status` carries a `CHECK (status IN ('planned','in_progress','completed','closed'))`. The
state machine is enforced twice — in SQLite and in `requireStatus` — because a `CHECK`
catches a bad write and the guard produces a message naming the order and the transition.

## 2. Invariants

These are what makes this an engine rather than a table a vertical could own:

1. **The state machine cannot skip states.** `requireStatus` gates every transition;
   `completeWorkOrder` demands `in_progress`, `closeWorkOrder` demands `completed`.
2. **Time and material entries are append-only.** Nothing in the surface updates or deletes
   a reported line. A correction is a new line, which is what makes the reported set
   evidence rather than current opinion.
3. **Every mutation emits a fat event** (§6) inside the same transaction as the write (K-4),
   so "changed without a record" is not expressible.
4. **The engine knows nothing about money it did not receive.** It sums the billable lines
   its caller hands it and never prices anything.

## 3. State machine

```
planned ──assign──▶ planned ──start──▶ in_progress ──complete──▶ completed ──close──▶ closed
                                            │
                                    report time / material
                                    (append-only, repeatable)
```

`assign` and the reporting transitions do not move `status`; they are recorded and emitted
but leave the order where it is. Only `start`, `complete` and `close` advance it.

## 4. In-scope exports — the composable surface

Engine logic lives in plain exports; the registered operations are thin
(`assertAllowed(await ctx.check(PERM.…))` + one call below).

**The signatures live in one place, and it is not here:**
[`apps/docs/engines/workorder/surface.md`](../../apps/docs/engines/workorder/surface.md),
published at [substrat.net/engines/workorder/surface](https://substrat.net/engines/workorder/surface).
That page is what a vertical reads, so it carries what a caller needs and this one did not —
that `getWorkOrder` throws on an id naming nothing, and that `listOrders` takes the kernel's
`PageParams` and answers a `CountedPage` under `total: true`. Two lists of the same
signatures is the drift [`docs/README.md`](../README.md) means by *nothing belongs in both*.
What stays here is the reasoning the published page does not carry.

`assignWorkOrder`, `startWorkOrder`, `reportTime` and `reportMaterial` were extracted from
their operation handlers in [#975](https://github.com/substrat-run/substrat/issues/975);
until then the four carried their UPDATE/INSERT and emit inline, so a vertical could not
assign, start or report inside its own transaction without forking. Their inputs are the
schemas the operations declare (`operations.ts`), parsed on the way in.

**The caller owns the permission check.** These functions are the composable half of K-16;
the registered operations bind them behind `assertAllowed(await ctx.check(PERM.…))`. A
vertical calling them directly must do its own check — that is not an oversight, it is what
lets a vertical gate the same behaviour on its own permission.

**`completeWorkOrder` takes the billable lines rather than deriving them, and that is the
whole seam.** Pricing is vertical vocabulary — a workshop's hourly rate, a property
manager's ROT split, a shop's article prices — so the engine sums what it is given
(`addMoney` over `Money`, never floats — K-14) and emits the total. `getReportedLines` is
the read the vertical prices *from*. Callout's completion operation is the reference: read
the lines, price them in vertical code, pass them back, all in one transaction.

**Everything returned here is parsed, not asserted** ([#771](https://github.com/substrat-run/substrat/issues/771)),
and this engine is where that was worked out. D-28's additive-only rule is enforced by
review; the failure it exists to prevent — a vertical compiled against 0.3 running against
0.4, whose row shape moved — used to surface as *wrong data on a screen* rather than a
throw, because a return value crossed the seam typed only by TypeScript, which is not there
at runtime. `src/seam.ts` is one line of `engineSeam('engine-workorder')`
([#970](https://github.com/substrat-run/substrat/issues/970)); the `returns` and
`columnsOf` helpers it binds live in `@substrat-run/contracts`, and what they do is on the
published page. `test/seam.test.ts` moves the tables under a running engine — drops a
column, makes `technician` nullable, retypes `number` — and asserts each one throws at the
seam. Every other engine has since been converted the same way; this one was the reference,
not the exception.

## 5. Permissions

`workorder:create` · `workorder:read` · `workorder:assign` · `workorder:report` ·
`workorder:complete` · `workorder:close` — each with the description the manifest declares,
and the role shapes they compose into, at
[`apps/docs/engines/workorder/surface.md`](../../apps/docs/engines/workorder/surface.md#permissions).

`workorder:create` is declared with no operation binding it: creation is `createWorkOrder`
only, so the key exists for the vertical that composes it to check. `attachmentTargets`
exposes `workorder` behind `workorder:read`, and `entityRelations` declares
`workorder → facility`, which is what lets an entity-narrowed grant on a facility resolve
down to its orders (D-23 rule 3). Entitlement key: `workorder`.

## 6. Events — frozen once shipped (D-28)

All seven — each with its `schemaVersion`, its `piiClass` and what its payload carries — are at
[`apps/docs/engines/workorder/events.md`](../../apps/docs/engines/workorder/events.md)
(published at [substrat.net/engines/workorder/events](https://substrat.net/engines/workorder/events)).
The copy this page used to carry called all seven `piiClass: 'none'`; two of them —
`workorder.assigned` and `workorder.time-reported`, which name a technician — are
`pseudonymous`, and a PII claim is the last thing that should live in a second list.

`consumes` is empty. This engine is a pure producer.

`workorder.completed` is the load-bearing one: it carries the order, its facility and
customer refs, the billable lines and the total, because the invoicing engine consumes it
and must never need a cross-module read (the fat-event rule). That payload is frozen —
changing it is a `schemaVersion` bump, and see §7 for why that is currently harder than
D-28 implies.

## 7. Open questions

1. **The dual-emit hazard applies to this engine's events too.** Consumer dispatch routes on
   event *type* alone, so a `schemaVersion` bump on `workorder.completed` cannot be
   dual-emitted safely — the deprecation window would deliver both versions to invoicing.
   Kernel open question 16; [#128](https://github.com/substrat-run/substrat/issues/128).
   This engine is on public npm, so the deadline that question set for itself has passed.
2. **`number` is a per-scope sequence computed as `MAX(number) + 1`.** Correct under the
   scope's serialized execution (K-6), and worth stating because it would not be correct
   anywhere else.
3. **No decision log entry covers this engine's extraction.** It was built alongside Callout
   rather than extracted at a second vertical, which is the order D-27 warns about. It has
   since acquired second consumers, so the hypothesis held — but it was not tested the way
   the discipline intends.
