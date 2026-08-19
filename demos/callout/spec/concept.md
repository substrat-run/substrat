# Demo Vertical — "Callout" (milestone 1)

Status: draft v0.2 · Last updated: 2026-07-14

> Companion to [kernel-design.md](../../../docs/architecture/kernel-design.md) §12 (milestone-1 cut) and the master
> plan §13.4 (the 15-minute demo). Anonymization per the master plan: the feature set is
> derived from **the FSM vendor's** public product surface — deliberately, so demo work
> seeds the real engines cases 1 and 4 need.

## 1. What the demo must prove

1. **The three-layer split is real**: kernel owns no domain entities; engines own
   invariants; the vertical owns vocabulary, pricing, and screens.
2. **The star topology composes**: two engines cooperating through events + opaque refs,
   with zero imports between them (D-19, §7.3 worked example).
3. **Enforcement is structural**: a live cross-tenant attack from vertical code fails at
   the boundary, on stage.
4. **The agent loop works**: Claude Code scaffolds the vertical from manifests +
   contracts + one reference, up to the two human checkpoints (§5.6 acceptance test).

## 2. Shape: mini service-firm OS, bike shop as the reuse proof

**v1 demo** = "Callout": a small installations/service firm (el/VVS-flavored).
**v2 skin** = "Handlebar": a bike workshop running the *same engines* with different
vocabulary (repairs = work orders, mechanics = technicians). Two verticals on shared
engines is the thesis demonstrated, not claimed — it plays the shape-breaker role case 2
plays in the real sequence, at demo scale.

## 3. Tenancy setup

- Tenant = the service firm; scope = filial. Demo data: **two tenants × two scopes**
  (ElMontage AB: Stockholm + Uppsala; RörService AB: Göteborg + Malmö) — matching the
  milestone-1 cut, and giving the attack demo a victim.
- Principals covering the §4.2 acceptance list: an office admin (tenant-level role), a
  technician with roles at both filialer, a technician at exactly one, a customer-portal
  principal scoped to one filial's customer view, and — stretch — a subcontractor
  principal in tenant B holding a time-boxed capability grant into tenant A (the §8.4
  network wedge, at demo scale).

## 4. Decomposition of the FSM feature set

| Capability | Layer | Demo scope |
|---|---|---|
| Work orders + time + material | **Engine `engine-workorder`** | v1, core |
| Protocols/checklists (sign → immutable) | **Vertical code now, engine at milestone B** ([engine-protocol.md](../../../docs/engines/protocol.md), decision 27) | v1: self-inspection-electrical fill/sign + completion guard as `callout/*` ops; extraction when Handlebar's checklist forces it |
| Invoice basis | **Engine `engine-invoicing`** | v1, core — the star-topology showpiece |
| Scheduling/dispatch | Engine, **deferred** | demo shows assignment field + list |
| Automatic pricing per customer contract | **Vertical** | price list table + pricing hook |
| Contract/avtal mgmt w/ indexing | **Vertical** (simple table) | demo: one avtal per customer |
| Inventory, project mgmt | **Deferred** | no demo value per cost |
| Supplier invoices / EDI / payroll | **Connectors**, deferred | Fortnox export stubbed as file |
| Customer portal | **Kernel** (portal role + app shell) | read-only order status page |
| Mobile field capture | Kernel contract; offline deferred | plain form, event-shaped writes |

## 5. The two core engines

### 5.1 `engine-workorder` (work orders + time + material — one engine, D-19 chatty test)

- Tables: `workorder_orders`, `workorder_time_entries`, `workorder_material_lines`.
- Invariants (what the engine *is*): status state machine
  `draft → planned → in_progress → completed → closed` with no skips; time and material
  entries append-only, bound to an open order; every mutation emits an event; every
  operation checks a permission.
- Permissions: `workorder:create|read|assign|report|complete|close`.
- Emits: `workorder.created|assigned|time-reported|completed|closed` (v1 schemas).
- Consumes: nothing (leaf producer).
- Vertical extension points: order `kind` vocabulary, custom fields via attachment
  contract, pricing hook consulted at completion.

### 5.2 `engine-invoicing` (invoice basis)

- Tables: `invoicing_underlag`, `invoicing_lines`.
- Consumes: `workorder.completed` — builds billable lines by **snapshot, not join**
  (§7.3 worked example: frozen hours/rates/ROT at billing time + `EntityRef` provenance
  back to the order). Zero imports from `engine-workorder`.
- Invariants: an underlag is immutable once marked `exported`; lines always carry
  provenance refs; idempotent on event redelivery (event id is the dedup key).
- Emits: `invoicing.underlag-created|exported`.
- Demo integration: "export to Fortnox" writes a file through a connector stub.

### 5.3 What their cooperation demonstrates

Complete a work order → `workorder.completed` on the spine → invoicing line appears with
drill-down to the order. Then edit the order's time entries *after* completion is
blocked by the engine invariant — and the already-created invoice line wouldn't change
anyway, because it snapshotted. Star topology, outbox atomicity, and accounting
semantics in one 60-second beat.

## 6. The vertical ("Callout")

Owns everything with a user's fingerprints on it: ärende/order vocabulary and extra
fields, the price-list + avtal tables and the pricing hook, role *definitions* for its
personas (office-admin, technician, customer), screens (dispatch list, technician
mobile capture form, customer portal page, invoice basis review), and the manifest
wiring both engines + Fortnox stub. Screens compose via the manifest `ui` contributions
into `@substrat-run/shell` (shadcn-admin seed) per kernel-design §7.4 — the engines ship
default headless-first screens; the demo vertical uses them copy-and-own. **No raw DB, no fetch, no event forging — lint and
the contract surface make the vertical boring by construction.** The v2 bike-shop skin
replaces vocabulary, price list, and screens only.

## 7. The 15-minute script

1. **(3 min) Agent scaffold**: Claude Code, given manifests + contracts + the Callout
   reference, scaffolds the Handlebar vertical — schema, permissions, screens — up to
   the two human checkpoints: the migration dry-run diff and the permission diff, shown
   as the reviewable artifacts they are.
2. **(4 min) Business flow**: create order at ElMontage Stockholm → assign technician →
   report time/material → sign protocol (stretch) → complete → invoice basis line
   appears with provenance drill-down.
3. **(2 min) Permission tree**: view-as the single-filial technician (no Uppsala
   orders), view-as the customer (their orders only). `explain` shows *why* for each.
4. **(3 min) The attack**: patch the vertical live with code attempting to read
   RörService's orders — forged scope ID, direct SQL, cross-tenant stub request. Lint
   catches what it can in CI; the boundary rejects the rest at runtime, audited. This is
   the §10 enforcement table, performed.
5. **(2 min) The exit**: stop the demo, `substrat dev` the same data on plain SQLite
   files, open one in a SQLite browser — the escrow/eject story, shown not told.

6. *(stretch beat)* Cross-tenant grant: RörService as subcontractor receives one
   ElMontage order via capability grant — the §8.4 network wedge in miniature.

## 8. Build order

1. `engine-workorder` v0 on the pure adapter (first real manifest-carrying package —
   forces manifest loading, migrations journal, permission declarations).
2. `engine-invoicing` v0 (forces event consumption + idempotent redelivery).
3. Callout vertical (forces the SDK surface, zod-openapi HTTP layer, screens).
4. Demo harness: seed script, the attack script, view-as.
5. Handlebar skin (agent-scaffolded — this *is* the acceptance test, §5.6).

Deferred, deliberately: scheduling engine, inventory, offline capture, EDI, Cloudflare
adapter (demo runs pure-SQLite, K-5), real Fortnox connector.

## 9. Definition of done

An agent, pointed at the repo, scaffolds Handlebar to the checkpoints without human
prompting beyond the task statement; all contract tests green on the pure adapter; the
attack script exits non-zero at every attempt vector; the demo runs start-to-finish in
under 15 minutes on a laptop with no network.
