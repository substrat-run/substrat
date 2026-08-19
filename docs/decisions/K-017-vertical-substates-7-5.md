---
id: K-17
date: 2026-07-14
layer: kernel
title: "Vertical substates (§7.5)"
status: accepted
aliases: []
tracking: []
---
# K-17 — Vertical substates (§7.5)

Vertical **substates** (§7.5): verticals refine engine states via a manifest `substates` declaration; engines mark which states admit them (`extensibleStates`), invariant-bearing states admit none. Transitions *within* an engine state are vertical-owned; transitions *between* engine states stay engine operations only. Kernel stores and validates the substate and emits spine events for substate changes

## Why

Implements plan decision 26. Delivers §3's "extra states" promise without letting a substate path skip an engine state; FSM status-flow nuance (`awaiting_parts`, `pending_customer_approval`) is exactly where "vertical not powerful enough" would otherwise materialize first. Substates *blocking* an engine transition is open question 11's guard, not substate semantics
