---
id: D-26
date: 2026-07-14
layer: plan
title: "Engine extension model pinned (kernel-design §7.5, K-17/K-18)"
status: accepted
aliases: []
tracking: []
---
# D-26 — Engine extension model pinned (kernel-design §7.5, K-17/K-18)

Engine extension model pinned (kernel-design §7.5, K-17/K-18): verticals refine engine state machines via manifest-declared **substates** (within-state transitions vertical-owned; between-state transitions stay engine-only), and custom-field **registration materializes typed indexes** with engine list APIs accepting declared fields as filter/sort predicates

## Why

Closes the gap between §3's vertical-power promise ("extra states") and decision 6's no-EAV stance — without a mechanism, "verticals never fork engines" is discipline, not design. SAP's clean-core convergence (decades of in-core Z-table pain → sanctioned extension points) validates sealed engine schema + typed extension points; SharePoint/unindexed-JSONB is the counterexample the queryability obligation avoids
