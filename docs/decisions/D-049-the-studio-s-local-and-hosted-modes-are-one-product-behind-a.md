---
id: D-49
date: 2026-08-15
layer: plan
title: "The studio's local and hosted modes are one product behind a `Workspace` interface"
status: accepted
aliases: []
tracking: []
source: docs/architecture/builder/studio.md §13
---

# D-49 — The studio's local and hosted modes are one product behind a `Workspace` interface

> **Ratified 2026-08-19.** Transcribed from docs/architecture/builder/studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**The studio's local and hosted modes are one product behind a `Workspace` interface.** The method (skills, checks, git, commit-per-turn) is identical; only `exec`, file access and port exposure differ.

## Why

The local loop is the reference implementation and already works, so the hosted one is a shell over it — and a shared interface is what stops the two from silently diverging into different definitions of "a build."
