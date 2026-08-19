---
id: K-18
date: 2026-07-14
layer: kernel
title: "Queryable custom fields"
status: accepted
aliases: []
tracking: []
---
# K-18 — Queryable custom fields

**Queryable custom fields** (§7.5): D-6's field registry carries two obligations — registration materializes a *typed* index (`value_text | value_num | value_date | value_bool`; `filterable`/`sortable` fields get real SQLite indexes at registration), and engine list APIs accept registry-declared filter/sort predicates with correct pagination and counts, the kernel composing the join inside the scope DB

## Why

Implements plan decision 26. Types make comparison/sort correct (the `'9' > '10'` bug class); declaration is what makes indexing possible at all — freeform JSON indexes nothing (the SharePoint/unindexed-JSONB counterexample). Kernel-mediated typed queries do not violate §7.3: the ban is on *modules* entangling with each other's tables, not on the kernel mediating a declared query path
