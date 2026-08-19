---
id: D-21
date: 2026-07-12
layer: plan
title: "TypeScript end-to-end"
status: accepted
aliases: []
tracking: []
---
# D-21 — TypeScript end-to-end

TypeScript end-to-end; runtime validation generated from specs at every trust boundary; portability via WinterTC standards surface + adapters, not WASM; pnpm/npm distribution, verticals on Workers for Platforms; WASM module slot kept open for hot paths

## Why

Team-independent case (§5.8): language is downstream of the runtime; the SDK boundary is the value; workload is I/O-bound and per-scope serialized; Go can't express the type thesis; agents are the primary users
