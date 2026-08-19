---
id: K-19
date: 2026-07-15
layer: kernel
title: "Read-path tiering (§5.6)"
status: accepted
aliases: []
tracking: []
---
# K-19 — Read-path tiering (§5.6)

Read-path tiering (§5.6): in-scope projections first (denormalized tables in the scope DB, committed with the write); outbox-fed external read model as the escape hatch; Tier 2 is history, never a UI read tier. Global read replication rejected as a platform tier, sanctioned per-surface for public stale-tolerant reads. Operations gain an additive `readonly` manifest flag

## Why

Serialization is a *duration* problem, not a concurrency one — one isolate cannot parallelize reads, so reads get fast by getting short. The rejection is load-bearing: replicas break K-7 residency, and D1 bookmarks cannot restore read-your-writes across the outbox boundary (D1 versions ≠ DO versions). `readonly` is free now, expensive to retrofit
