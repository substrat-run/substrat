---
id: K-10
date: 2026-07-12
layer: kernel
title: "Stub exposes invoke(operation, input)"
status: accepted
aliases: []
tracking: []
---
# K-10 — Stub exposes invoke(operation, input)

Stub exposes `invoke(operation, input)`; `sql`/`emit`/`check` live in the `OperationContext` handlers see inside the scope

## Why

Closures can't cross RPC; module code runs colocated with data (§5.5), preserving "one hop, then local queries" on the DO adapter
