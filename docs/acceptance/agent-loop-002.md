---
status: historical
layer: plan
description: Agent-loop acceptance run 002.
---

# Agent-loop acceptance run 002 — office screens (extend, not scaffold)

Date: 2026-07-14 · Benchmark variant: extending existing verticals, the shape most real
agent work takes · Result: **PASS, no checkpoints triggered**

## Setup

One task statement to a fresh agent: *add the two missing v0 office screens to both
demo verticals per views.md §1.3 (customer management) and §1.5 (price list), using
each vertical's existing operations; follow repo conventions; don't commit.* No file
list, no API hints.

## What came back

Customer + price-list screens in both apps (ServiceCo and CykelService, each in its
own vocabulary), three thin server routes per vertical wrapping existing operations,
typed api.ts client methods, nav links gated office-vs-portal. Notable: the §1.5
price simulator shows *which pricing rule fired* (min-qty / reported / internal-
dropped), and the agent implemented display-math with string decimals over BigInt
rather than floats — the money rule held even where the SDK isn't importable.

Gates (agent-run, then independently re-verified): build, typecheck, boundary lint,
both 9/9 scenario suites, plus an agent-authored 12-assertion runtime smoke test
against scratch data dirs covering every new route's operation path and the denials
(technician/mechanic denied `customer:manage`).

## Signal for the benchmark

- Zero mechanical pushback from the platform — first-try green on all gates. The
  reference apps carried the UI conventions; the layer rules carried the rest.
- The agent correctly determined that **neither human checkpoint applies** (no
  migration, no permission change) and said so explicitly rather than inventing
  approval theater — the checkpoint discipline generalizes.
- Judgment calls were sane: flat hash routes to match the apps (spec said
  `/settings/prices`), no delete affordance because no delete operation exists.

## Follow-ups surfaced

- Nav items are portal-vs-office gated only; a `check()`-driven permission-aware nav
  (kernel-design §7.4, manifest `ui.nav.permission`) remains future shell work.
- views.md §1.3's full customer DetailLayout (open orders, underlag, timeline tabs)
  is still open — run 002 built the list/create/add slice.
