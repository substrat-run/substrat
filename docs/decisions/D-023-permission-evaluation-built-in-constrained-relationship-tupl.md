---
id: D-23
date: 2026-07-13
layer: plan
title: "Permission evaluation = built-in constrained relationship-tuple engine (FGA-shaped)"
status: accepted
aliases: []
tracking: []
---
# D-23 — Permission evaluation = built-in constrained relationship-tuple engine (FGA-shaped)

Permission evaluation = built-in **constrained relationship-tuple engine** (FGA-shaped): fixed four-rule derivation algebra (role expansion; tenancy-tree inheritance; manifest-declared entity parent edges, depth-capped; org/group membership); no negation, no configurable rewrites; tuples scope-local, evaluated inside the scope's serialization domain; checks return tuple **proof paths**. Roles/grants stay the authored surface; verticals never see tuples; OpenFGA remains the swap target

## Why

Resolves the §11 open question (built-in vs OpenFGA) with both: DO-per-scope serialization removes Zanzibar's consistency problem (no zookies), so the mini-engine is genuinely small; entity-level portal access (the FSM shape: end customers within a filial scope) needs graph resolution the identity layer cannot do; proof paths power explain / view-as / the reviewable permission diff (§7.8). Implements 16
