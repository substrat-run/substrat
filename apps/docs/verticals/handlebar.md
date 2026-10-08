# Handlebar (bike workshop)

`demos/handlebar` — a one-workshop bike-repair shop (Kedja & Kugghjul Cykelverkstad AB,
Stockholm): customers bring bikes in, mechanics repair them, the shop prices and invoices the job.

## Overview

Handlebar is the **engine-reuse proof**. It began as the *v2 skin* — the **same engines as the
first field-service demo (Callout, since removed), under different vocabulary** — so "two verticals
on shared engines" was demonstrated rather than claimed. The vertical owns only vocabulary, extra fields, its price
list, roles, and screens; nothing in any engine's state machine is touched.

A repair *is* a [work order](/engines/workorder/): `reparation`, on a `cykel`
(`facility`), worked by a `mekaniker` (`assigned_to`), priced and invoiced through the same
[invoicing](/engines/invoicing/) path the field-service demo used. The interesting part is the third engine.

### It forced the protocol engine out

Handlebar is the vertical that made [`protocol`](/engines/protocol/) an engine. Its
`tillståndsrapport` — a per-bike condition report — needed the same **sign → immutable** invariant
the field-service demo's checklists had, but in a *different shape*:

- the **workshop signs** it (freezing the content forever), and the **customer counter-signs the
  same frozen content at pickup** — a second signature on already-frozen content;
- fills are **append-only**;
- filling and signing are **different roles** (the mechanic fills; the workshop lead signs).

A second shape of the same invariant is exactly what proves an invariant belongs in an engine and
not in one vertical's code. So it was extracted — and Handlebar keeps only the template's
vocabulary; every invariant (sign-freeze, counter-sign on frozen content, append-only responses,
verifiable hash) lives in `@substrat-run/engine-protocol`.

That extraction also lets Handlebar lean on **manifest-declared** mechanisms where the
field-service demo used code: a declared guard `protocol/all-signed` (`countersigned: true`) sits `before`
`bike-shop/close-repair`, and the vertical `withdraws` the engine's own `workorder/close` so the
*only* door to `closed` is the guarded operation. The field-service demo composed the equivalent
guard as conditional vertical glue; Handlebar declares it. Two poles of the same seam.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-handlebar` |
| **Engines composed** | [`workorder`](/engines/workorder/) · [`invoicing`](/engines/invoicing/) · [`protocol`](/engines/protocol/) |
| **Own tables** | `bike_shop_customers` · `bike_shop_bikes` · `bike_shop_price_list` |
| **Roles** | `workshop-admin` (15 keys) · `mechanic` (4: `protocol:fill`/`read`, `workorder:read`/`report`) — portal customers hold no role, only entity-narrowed `protocol:countersign`/`read` + `workorder:read` per customer |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/handlebar/PERMISSIONS.md) — 19 keys, 4 modules, 2 roles |
| **Apps** | node API (`:8872`) + React SPA (`:5272`) |
| **Status** | Working — demo seed |

## The cast & what's denied

| Who | Holds | Cannot |
|---|---|---|
| **Greta** — verkstadschef | `workshop-admin`, tenant level | — (the whole lifecycle: customers, bikes, prices, repairs, invoicing) |
| **Måns** — mekaniker | `mechanic` at the work scope | **assign**, complete, or invoice — only start repairs and report time & parts |
| **Lisbeth** — portal customer (Crescent owner) | no role; entity-narrowed grants on her own customer | see Otto's repairs, write anything, or invoice — she sees her own repairs + timeline and **counter-signs** her report |
| **Otto** — portal customer (Bianchi owner) | the same, for his customer | see Lisbeth's repairs |
| **Rutger** — admin of rival tenant *Trampolin Cykel AB* | `workshop-admin` in his own tenant | anything here — `unknown scope` on a forged pair, `permission denied` on every operation |

Provisioning yields **only** what a customer gets — one tenant, one scope, roles, and an owner with
`workshop-admin`. The named cast and the rival tenant are demo fixtures, structurally unreachable
from provisioning (`provisionHandlebar` returns a shape with no room for a cast).

## Run it

```bash
pnpm --filter @substrat-run/demo-handlebar dev
# API  http://localhost:8872
# web  http://localhost:5272
```

Two suites: `test/provision.test.ts` (one tenant/one scope, only the owner gets a role, idempotent)
and `test/scenario.test.ts` — the 13-step scenario covering the priced completion, the
star-topology invoicing event, portal isolation, immutable export, the withdrawn
`workorder/close`, append-only fill with the fill/sign split, sign-freeze + customer counter-sign on
the same content, and the manifest guard gating pickup.
