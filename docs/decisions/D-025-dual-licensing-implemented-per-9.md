---
id: D-25
date: 2026-07-13
layer: plan
title: "Dual licensing implemented (per §9)"
status: accepted
aliases: []
tracking: []
---
# D-25 — Dual licensing implemented (per §9)

Dual licensing implemented (per §9): kernel, adapters, contract-tests, and engines under **AGPL-3.0-only + commercial**; **contracts (and future SDK) under Apache-2.0**; contributions under CLA; see LICENSING.md

## Why

AGPL makes the escrow/self-host exit real while blocking proprietary freeloading; the *interface* packages verticals import must never copyleft-capture customer applications (the moat is runtime enforcement, not schemas — §4) — the Grafana pattern (AGPL core, Apache client libs). Copyright line follows the kernel-legal-home decision (§11)
