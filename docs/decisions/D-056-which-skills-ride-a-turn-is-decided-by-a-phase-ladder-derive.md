---
id: D-56
date: 2026-08-15
layer: plan
title: "Which skills ride a turn is decided by a phase ladder derived from workspace facts"
status: accepted
aliases: []
tracking: []
source: docs/design/builder-studio.md §13
---

# D-56 — Which skills ride a turn is decided by a phase ladder derived from workspace facts

> **Ratified 2026-08-19.** Transcribed from docs/design/builder-studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**Which skills ride a turn is decided by a phase ladder derived from workspace facts.** Three phases — interview (no `spec/concept.md`), scaffold (no `src/module.ts` yet), iterate — gate a skill manifest (`phase.ts`) shared by both hosts; the UI's phase stepper renders the same server-emitted facts, so what the user sees IS what the generator is loaded for. Prefix content changes only at phase boundaries.

## Why

A phase the loader cannot detect at turn start is a phase it cannot enforce — which is why "planning" and "design" are not phases; they happen inside interview turns with no workspace fact between them. Per-turn dynamic prefix selection would invalidate the prompt cache from byte one: anything finer-grained than a phase belongs behind a read tool, not in the prefix. The ladder is monotonic in practice; a deliberate re-design (deleting or rewriting the concept) moves it backward honestly, because the facts moved.
