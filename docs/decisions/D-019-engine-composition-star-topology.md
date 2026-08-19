---
id: D-19
date: 2026-07-12
layer: plan
title: "Engine composition = star topology"
status: accepted
aliases: []
tracking: []
---
# D-19 — Engine composition = star topology

Engine composition = star topology: engines talk only to the kernel (opaque refs, events, vertical-owned orchestration); chatty engine pairs merge into one engine

## Why

N kernel contracts instead of N² engine pairs (Odoo treadmill avoided); engines stay independently versionable and licensable (§3)
