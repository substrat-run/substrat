---
id: K-16
date: 2026-07-13
layer: kernel
title: "In-scope composition (demos/callout/spec/testrun.md §9.2)"
status: accepted
aliases: []
tracking: []
---
# K-16 — In-scope composition (demos/callout/spec/testrun.md §9.2)

In-scope composition (demos/callout/spec/testrun.md §9.2): engines export plain functions taking `ctx`; a vertical's operation may call them — same transaction, same serialization; registered operations are default bindings of these functions. Plus `ctx.link(child, parent)` writing manifest-declared relation tuples, and kernel-managed at-least-once local event dispatch with a `_substrat_deliveries` journal

## Why

Vertical-owned orchestration (D-19) needs one-transaction composition (e.g. price-then-complete); invariants hold because everything still flows through ctx; `link` is the write path for D-23 rule 3
