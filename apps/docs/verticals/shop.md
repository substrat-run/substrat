# Kallkälla (coffee shop)

`demos/shop` — a small-batch coffee roaster in Stockholm (Kallkälla Kaffe AB) running a web shop:
beans (whole/ground × 250 g/1 kg) and brewing gear, checkout **mot faktura** (on invoice).

## Overview

Kallkälla is deliberately the *third* vertical, doing a different job than the work-order shops
([Callout](/verticals/callout), [Handlebar](/verticals/handlebar)). It proves three things they
can't:

- **A published engine reused across a genuinely different domain.** [`invoicing`](/engines/invoicing/)
  builds an invoice basis from a **retail order**, not a service work order — the same
  snapshot-not-join consumer, fed by a different event. Star-topology reuse, outside the domain the
  engine was extracted from.
- **Additive engine evolution, on stage.** Invoicing learns a *second* input event
  (`commerce.order-placed`) **additively** — a new `consumes` entry and a second consumer with its
  own Zod parse — while the existing `workorder.completed` path stays frozen and untouched. This is
  the [additive-evolution rule](/concepts/modules) demonstrated, not asserted.
- **A new invariant shape: no oversell.** Not a state machine — a **reservation ledger**. You
  cannot sell more than exists.

### The no-oversell invariant

`available = on_hand − Σ(active reservations)`. A cart add succeeds only if `available ≥ qty`,
else it throws out-of-stock. Reservations are lines on an **open cart**; expiry is **lazy** —
elapsed holds are excluded on read and swept opportunistically on the next write, so there is no
timer or cron (default hold 900 s). Checkout re-verifies `on_hand` in case a hold lapsed.

It is enforced in the vertical's **own commerce module**, not an engine — and it is atomic for the
same reason RallyPoint's booking is: operations serialize per scope (K-6), so "read available, then
reserve" never interleaves. This is the extraction seam for a future `engine-inventory` /
`engine-order` — named for the *second* retail vertical (decision 27), not built ahead of one.
Its companion invariant: an order is **immutable after placement** (`cart → placed → fulfilled →
closed`, no skips).

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-shop` |
| **Engines composed** | [`invoicing`](/engines/invoicing/) (+ the vertical's own commerce module) |
| **Own tables** | `shop_products` · `shop_variants` · `shop_stock` · `shop_customers` · `shop_discounts` · `shop_carts` · `shop_cart_lines` · `shop_orders` · `shop_order_lines` |
| **Roles** | `public` (browse) · `shopper` (browse + checkout) · `warehouse` (fulfil, read, stock) · `shop-admin` (all) — portal customers hold an entity-narrowed `order:read` grant |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/shop/PERMISSIONS.md) — 10 keys, 2 modules, 4 roles |
| **Auth** | [OIDC-only](/concepts/identity#two-real-choices-made-differently) — login lives at the issuer (locally the [dev issuer](/concepts/identity#the-dev-issuer-local), whose `/authorize` lists [the cast](/concepts/identity#in-the-demo)), and the vertical only maps the authenticated `sub` → a principal; plus an anonymous browse-only principal, which is not a credential store |
| **Apps** | **four** processes over one API: the dev issuer (`:8879`, `ISSUER_PORT`) first, then API (`:8873`), storefront (`:5273`), back-office (`:5274`, `ADMIN_PORT`) |
| **Status** | Working — demo seed |

## Two audiences, one source of truth

The storefront and the back-office are **separate Vite apps** — different chrome, different
audience — both proxying `/api` to **one** API, so every action runs the same kernel permission
check behind both. The split is presentation and audience, never a second source of truth. This is
the sharpest illustration in the repo that "customer-facing" and "staff-facing" are surfaces over
one authority.

## The cast & what's denied

| Who | Holds | Cannot |
|---|---|---|
| **Astrid** | `shop-admin`, tenant level | — (catalog, prices, stock, discounts, fulfil, invoicing) |
| **Gustav** | `warehouse` | **set prices**, create discounts, or touch **invoicing** — he adjusts stock and fulfils orders |
| **Elin** — Café Pascal | entity-narrowed `order:read` on her own customer | see Otto's orders, write anything, or invoice — she sees only her own orders |
| **Otto** — Kontoret | the same, for his customer | see Elin's orders |
| *(not logged in)* | `public` — browse-only | anything but browsing the catalogue — a thin role on the same code path, not an auth bypass |
| **Rurik** — admin of rival tenant *Bönfeber* | `shop-admin` in his own tenant | anything of Kallkälla's — the cross-tenant denial |

Signing in as Gustav and watching *Invoice basis* disappear from the nav — and 403 if you ask for
it directly — is the whole thesis in one click: **the issuer authenticated you, the kernel
authorized you.**

## Run it

```bash
pnpm --filter @substrat-run/demo-shop dev
# issuer      http://localhost:8879
# API         http://localhost:8873
# storefront  http://localhost:5273
# back-office  http://localhost:5274
```

Two suites: `test/scenario.test.ts` (the oversell throw on the last-unit race, checkout mot faktura
with a discount, frozen order lines, the invoicing underlag with provenance, lazy TTL release, the
no-skip state machine, and every denial vector) and `test/provision.test.ts`.

## Deliberately out of scope

Payment capture (Swish/card), tax, shipping rates, multi-warehouse, and returns — a card/Swish
order would settle through a deferred payment connector, and only **mot faktura** produces an
invoice basis. The extracted inventory/order engines wait on a second retail vertical.
