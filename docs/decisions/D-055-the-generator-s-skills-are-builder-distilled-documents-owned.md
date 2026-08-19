---
id: D-55
date: 2026-08-15
layer: plan
title: "The generator's skills are builder-distilled documents owned by the studio"
status: accepted
aliases: []
tracking: []
source: docs/architecture/builder/studio.md §13
---

# D-55 — The generator's skills are builder-distilled documents owned by the studio

> **Ratified 2026-08-19.** Transcribed from docs/architecture/builder/studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**The generator's skills are builder-distilled documents owned by the studio.** The generator reads `apps/builder/skills/`, not the repo's Claude Code skills. The originals assume monorepo access, a deploy CLI and curl — all unreachable or denied in the project-rooted sandbox — and they duplicate the system prompt's module rules. The distilled pair carries the engine coverage map + concept template (interview) and inline code shapes replacing unreachable reference files (build), at roughly a third of the size.

## Why

Every turn billed the same rules twice and pointed the model at files it cannot read. Consequence accepted: a second document to keep in sync when platform surfaces change — the studio's files say so in their header, and `evals/` (D-52) is the mechanism that catches a drifted skill producing a vertical that no longer passes the gates.
