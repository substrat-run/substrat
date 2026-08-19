---
id: D-51
date: 2026-08-15
layer: plan
title: "Regression safety comes from an acceptance ledger the user authored"
status: accepted
aliases: []
tracking: []
source: docs/architecture/builder/studio.md §13
---

# D-51 — Regression safety comes from an acceptance ledger the user authored

> **Ratified 2026-08-19.** Transcribed from docs/architecture/builder/studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**Regression safety comes from an acceptance ledger the user authored.** A pinned confirmation in chat becomes a named case in `spec/accepted.md` and a step in the scenario narrative; the whole ledger runs every turn; a break is reported in the builder's own words. Agent-authored tests stay, labelled as lint, and never gate a promotion.

## Why

An agent that writes both the implementation and its oracle can be wrong in the same direction twice, so the only assertions worth trusting are the ones it did not author — the golden-file gates that already exist (`lint:permissions`, `lint:api`, boundary-lint, migration replay) and the user's own accepted behaviours. This is also what makes the *chat* interface load-bearing rather than cosmetic: a terminal loop discards the acceptance signal, and the ledger is the only artifact that could later make an automated engine-upgrade checkable.
