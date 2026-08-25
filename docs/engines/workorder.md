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

```ts
createWorkOrder(ctx, input): WorkOrder
listOrders(ctx, page): Page<WorkOrder>
getWorkOrder(ctx, orderId): WorkOrder
getReportedLines(ctx, orderId): { time: TimeEntry[]; material: MaterialLine[] }
completeWorkOrder(ctx, { orderId, billable }): { order: WorkOrder; total: Money }
closeWorkOrder(ctx, { orderId }): WorkOrder
```

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

**Everything returned here is parsed, not asserted** ([#771](https://github.com/substrat-run/substrat/issues/771)).
D-28's additive-only rule is enforced by review; the failure it exists to prevent — a
vertical compiled against 0.3 running against 0.4, whose row shape moved — used to surface
as *wrong data on a screen* rather than a throw, because a return value crossed the seam
typed only by TypeScript, which is not there at runtime. `src/seam.ts` is the runtime half:

- `returns(schema, surface, value)` parses every published value with the same schema a
  composing vertical declares its `output` with. The refusal is `internal`, not
  `validation_failed`: the caller's input was already parsed, and the fault is on this side.
- `columnsOf(schema)` derives each `SELECT` list from that schema, so a read asks for
  exactly what the seam promises. `SELECT *` pinned the published shape to the physical
  table — a column added upstream crossed the seam, a column renamed arrived `undefined`.

Parsing is **always on**, bulk reads included: every read here is one row or one page
(#811), and dev-only validation would be absent exactly where the version skew lives.
`test/seam.test.ts` moves the tables under a running engine — drops a column, makes
`technician` nullable, retypes `number` — and asserts each one throws at the seam. The
other six engines have not been converted; this one is the reference.

## 5. Permissions

| key | description |
|---|---|
| `workorder:create` | Create work orders |
| `workorder:read` | Read work orders, time and material |
| `workorder:assign` | Assign a technician |
| `workorder:report` | Start work, report time and material |
| `workorder:complete` | Complete a work order (with billable lines) |
| `workorder:close` | Close a completed work order |

`attachmentTargets` exposes `workorder` behind `workorder:read`, and `entityRelations`
declares `workorder → facility`, which is what lets an entity-narrowed grant on a facility
resolve down to its orders (D-23 rule 3). Entitlement key: `workorder`.

## 6. Events — frozen once shipped (D-28)

All at `schemaVersion: 1`, all `piiClass: 'none'`:

`workorder.created` · `workorder.assigned` · `workorder.started` ·
`workorder.time-reported` · `workorder.material-reported` · `workorder.completed` ·
`workorder.closed`

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
