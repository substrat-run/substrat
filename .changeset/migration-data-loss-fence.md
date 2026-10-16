---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/engine-invoicing": patch
"@substrat-run/demo-meridian": patch
---

A migration you wrote can no longer quietly lose data a scope holds. Before and after each authored migration, inside its transaction, the kernel counts each table's rows and each column's values by storage class. It refuses a migration that leaves a table that held rows gone or shorter, or a column that held values gone, emptier or retyped. Renames and the usual create-copy-drop-rename rebuild are followed; a table that holds nothing may be dropped or reshaped freely. A refusal fails the scope closed like any failed migration, with its data intact. When the loss is intended, declare it on the migration beside its SQL: `moves: { source: target }`, verified by the counts, or `discards: { target: reason }`, with a required reason. Neither changes the migration's digest. The invoicing engine's `0002-split-line-provenance` now declares the provenance it moves. `@substrat-run/adapter-sqlite` exports `SCOPE_SPINE_DDL` for tools that replay migrations outside a host.
