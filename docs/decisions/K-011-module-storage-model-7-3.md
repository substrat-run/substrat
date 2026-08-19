---
id: K-11
date: 2026-07-13
layer: kernel
title: "Module storage model (§7.3)"
status: accepted
aliases: []
tracking: []
---
# K-11 — Module storage model (§7.3)

Module storage model (§7.3): engines own namespaced tables + module-journaled migrations in the shared scope DB, never databases; no cross-module FKs; event ordering only within (scope, module); no cross-module transactions promised; outbox is per-database

## Why

Outbox atomicity requires one DB per consistency domain; forbidding cross-module coupling keeps per-engine sharding and Shape B migration available as ops changes, not contract changes
