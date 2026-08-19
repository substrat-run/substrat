---
id: D-52
date: 2026-08-15
layer: plan
title: "The generator itself is regression-tested against frozen concept fixtures (`evals/`)"
status: accepted
aliases: []
tracking: []
source: docs/architecture/builder/studio.md §13
---

# D-52 — The generator itself is regression-tested against frozen concept fixtures (`evals/`)

> **Ratified 2026-08-19.** Transcribed from docs/architecture/builder/studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**The generator itself is regression-tested against frozen concept fixtures (`evals/`).** Any change to the skills, the model, the effort level or the harness runs N stored concepts and compares structural outcomes.

## Why

The skills are the product, so a prompt edit is a fleet-wide behaviour change with no reviewable diff — this is what `packages/contract-tests` is for adapters, applied to the thing that writes every future vertical.
