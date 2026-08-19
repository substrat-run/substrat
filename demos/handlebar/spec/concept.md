# Demo Vertical — "Handlebar" (v2 skin)

Status: draft v0.1 · Last updated: 2026-07-14

> The v2 bike-shop skin from [demos/callout/spec/concept.md](../../callout/spec/concept.md) §2:
> the *same engines* as Callout (`engine-workorder`, `engine-invoicing`) with
> different vocabulary. Two verticals on shared engines is the thesis demonstrated,
> not claimed. The vertical owns vocabulary, extra fields, price list, roles and
> screens — **nothing** that belongs to an engine's state machine.

## 1. The firm

**Kedja & Kugghjul Cykelverkstad AB** — a one-workshop bike repair shop in Stockholm
(Söder). Customers don't own facilities; they **bring bikes**. A repair (reparation)
*is* a work order; a mechanic (mekaniker) *is* a technician. The rival shop
**Trampolin Cykel AB** exists only to give the cross-tenant attack a perpetrator.

## 2. The cast

| Who | Role | Must be able to | Must be denied |
|---|---|---|---|
| **Greta** | verkstadschef (workshop-admin, tenant-level) | everything: customers, bikes, prices, full repair lifecycle, invoicing | — |
| **Måns** | mekaniker @ Söder | start repairs, report time & parts | assign, complete, invoicing |
| **Lisbeth** | portal customer (Crescent owner) | see exactly her own repairs + timeline | Otto's repairs, invoicing, any write |
| **Otto** | portal customer (Bianchi owner) | see exactly his own repairs | Lisbeth's repairs |
| **Rutger** | workshop-admin of *Trampolin Cykel* (tenant B) | everything in his own tenant | anything in tenant A: `unknown scope` on a forged pair, `permission denied` on every operation |

## 3. Vocabulary mapping onto the engines

| Handlebar says | Engine entity | Notes |
|---|---|---|
| Reparation | `workorder` | full state machine `planned → in_progress → completed → closed` |
| Mekaniker | technician (`assigned_to`) | |
| Cykel | the order's `facility` ref (`entityType: 'bike'`) | permission walk: `workorder → bike → customer` |
| Kund | `customer` ref | portal grants are entity-narrowed to the customer |
| Invoice basis | `invoicing` underlag | built by the invoicing engine from `workorder.completed`, snapshot not join |

Entity relations declared by this vertical: `bike → customer` **and**
`workorder → bike` (the engine links `workorder → <facility ref>`; this vertical's
facility-shaped entity is a bike, so the vertical declares that edge).

## 4. The vertical's own tables

- `bike_shop_customers` — id, number (unique), name, phone, created_at.
- `bike_shop_bikes` — id, customer_id → customers, label ("Crescent Elina 3-vxl"),
  frame_no, created_at.
- `bike_shop_price_list` — article, description, unit, price_amount (TEXT decimal),
  currency (SEK), min_qty, internal flag.

## 5. Pricing (the vertical-owned moment)

At completion the vertical reads the engine's reported lines, prices them, and calls
the engine's `completeWorkOrder` — one transaction:

- **Mekanikertid** (`labor`): 495 SEK/tim, minimum billable **0.5 tim** — a quick
  puncture fix still bills the half-hour minimum.
- **Parts** (`sb:*` articles): per price list, e.g. innerslang 28" 89 SEK,
  kedja 9-växlad 249 SEK.
- **Internal articles** (`verkstadsmtrl`) are dropped from the invoice.

## 6. Permissions & roles (vertical-defined, per tenant)

- New keys: `customer:manage` (customers + price list), `bike:manage` (register bikes).
- `workshop-admin`: both new keys + all `workorder:*` + `invoicing:read|export`.
- `mechanic`: `workorder:read`, `workorder:report`.
- Portal customers hold **no role** — one entity-narrowed grant each:
  `workorder:read` on `customer:<their id>`.

## 7. The scenario the test replays

1. Migrations journaled for all three modules in the scope's SQLite file.
2. Greta registers a repair for Lisbeth's Crescent ("Punktering bakhjul, växlar hoppar").
3. Assign Måns → start → report **0.25 tim** + 1 innerslang + 1 verkstadsmtrl.
4. Denials hold: Måns can't assign; Rutger gets `unknown scope` on the forged pair
   and `permission denied` with the correct one; Lisbeth can't report time.
5. Priced completion: 0.25 < 0.5 min → labor **0.5 × 495 = 247.5**; innerslang
   **89**; verkstadsmtrl dropped. Total **336.5** — exact to the öre.
   Reporting time after completion fails (`invalid transition`).
6. The invoicing engine consumed `workorder.completed`: one open underlag, total
   336.5, both lines with provenance back to the repair.
7. Portal isolation: Lisbeth sees exactly her repair (proof walk), Otto sees
   nothing, Lisbeth's `invoicing/list` is denied.
8. Export makes the underlag immutable; the next completed repair opens a new one.
9. Close ends the state machine; `planned → closed` skip is impossible.

## 8. Screens (copy-and-own from Callout's app)

Same shell, bike vocabulary: **Reparationer** list (bike column instead of
facility), repair detail with mechanic actions + priced completion sheet,
**Invoice basis** review, portal **"Mina reparationer"**. Dev API on :8872,
web on :5272 — runs side by side with Callout.
