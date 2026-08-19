---
id: K-21
date: 2026-07-19
layer: kernel
title: "Revoking a tuple tombstones it, and assignment authority is a set comparison the kernel owns"
status: accepted
aliases: []
tracking: []
---
# K-21 — Revoking a tuple tombstones it, and assignment authority is a set comparison the kernel owns

**Revoking a tuple tombstones it, and assignment authority is a set comparison the kernel owns** (implements plan decision 31; narrows open question 15). Two decisions the membership seam ([membership.md](../design/membership.md) §4/§5.1) cannot be built without, settled together because both are "how does the kernel say *no longer*". (1) **Tombstone, never delete.** A tuple that stops granting access keeps its row and gains a `revoked_at` the checker's walk skips — deletion is rejected outright. This costs a predicate on the hot path and is the price of the audit property K-4 rests on. It applies to every relation in `_substrat_tuples` / `_substrat_tenant_tuples`, membership included, so there is exactly one revocation mechanism rather than one per relation. Open question 15's remaining half (whether the kernel offers `relink` for entity parent edges, and what happens to proofs already issued) sits **on top of** this rather than beside it: `relink` = tombstone the old edge + link the new + emit a spine event. (2) **Assignment authority is one kernel-resolved comparison, not N checks.** §5.1 bounds role assignment by the assigner's own authority — assign `R` at `N` only if you already hold every permission `R` carries at `N` — which asks whether one principal's effective set *contains* a role's set. `ctx.check` answers one permission at a time and each call walks tuples, so N-checks repeats the same walk N times per invite acceptance. The kernel instead resolves the assigner's effective permission set once and compares. Effective means narrowing-aware: an entity-narrowed grant does not satisfy the bound for the unnarrowed permission

## Why

(1) is D-32 cashed in. Once the paid layer is an *operated* compliance product pursuing ISO 27001 + SOC 2 Type II, "who had access, when was it revoked, and what proves it was granted" stops being an architectural preference and becomes a deliverable — and deletion cannot produce the second half. That also retires open question 15's "accept permanence" option, since a building changing management company while the old manager's staff keep access is exactly the finding an auditor writes up. Deciding storage now and `relink` later is safe **because** they compose; deciding them as alternatives is what would have forced a rewrite. (2) follows §4.3's rule that the kernel stays the only place "who can do what" is enumerable — the comparison is that enumeration turned inward, and putting it in the kernel is what stops each vertical hand-rolling a privilege-escalation check. The cost is real and worth stating: every invite acceptance pays one set resolution, which is why it is one and not N
