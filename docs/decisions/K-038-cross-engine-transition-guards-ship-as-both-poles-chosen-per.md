---
id: K-38
date: 2026-08-19
layer: kernel
title: "Cross-engine transition guards ship as both poles, chosen per case"
status: accepted
aliases: []
tracking: []
source: docs/design/engine-protocol.md §6 (built 2026-07-20; entry unwritten until now)
---

# K-38 — Cross-engine transition guards ship as both poles, chosen per case

> **Ratified 2026-08-19.** Transcribed from docs/design/engine-protocol.md §6 (built 2026-07-20; entry unwritten until now) during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**Open question 11 is answered with both options, each carrying the case it fits.** *Pole 1 — vertical-composed:* the vertical's operation calls the engine's in-scope predicate (`requireSigned(ctx, entityRef, templateKey)`) before the engine transition. Zero kernel machinery; it is glue an edit can silently drop. **It is still the right pole when the policy is conditional on vertical data** — Callout owes an egenkontroll only on `montage` orders, and `order.kind` is Callout vocabulary the kernel must never learn. *Pole 2 — manifest-declared:* the guard is declared in the manifest and the kernel evaluates it before the transition, so it is visible to review and cannot be dropped by an edit. Both are implemented and shipped.

## Why

The open question framed these as alternatives and asked for one. Two verticals gating transitions on signatures showed they answer different questions: a guard that depends on vertical vocabulary **cannot** move into the manifest without teaching the kernel a vertical's domain, and a guard that must survive review **cannot** stay glue. Choosing one pole would have forced one of those two failures. The manifest change was additive as predicted, so shipping both cost nothing structural. **Note:** engine-protocol.md has recorded this as "awaits ratification" since 2026-07-20; the Phase-2 log split is what surfaced that it had never been written down.
