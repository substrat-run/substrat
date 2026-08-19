---
id: D-41
date: 2026-07-28
layer: plan
title: "A hosted vertical reads its entitlements at request time from a scope-local projection —…"
status: accepted
aliases: []
tracking: ["#304", "#302", "#33"]
---
# D-41 — A hosted vertical reads its entitlements at request time from a scope-local projection —…

**A hosted vertical reads its entitlements at request time from a scope-local projection — settling kernel open-question 5 with the routing cache's answer** ([#304](https://github.com/substrat-run/substrat/issues/304); scope-local-permissions.md §3/§7, control-plane.md §4.3). Entitlements were a coordinator-only, trust-at-provision check: it gated *module loading* but a dispatched worker could not read `plan`/`quota`/`tier` at request time (the `CONTROL_PLANE` binding is forbidden by the sandbox contract, D-302/#302), and a CP-less scope short-circuited the gate to `true` — enforcing *nothing* in-request, not even expiry. Now entitlements are **projected into each scope** beside roles/tuples (the scope-local-permissions machinery, extended not duplicated): `ctx.entitlement(key)`/`ctx.entitlements()` read them locally (a console-managed scope reads over the same RPC the permission checker uses), the per-operation gate fails closed against the projection, and a grant/revoke fans out to invalidate. This is **open-question 5's answer** — cached in scope DOs with event invalidation — and deliberately the SAME project-on-write mechanism K-26/K-30 defer the routing/suspension cache to, per control-plane.md §4's "settle once for both". Two calls, per #33's grain: **expose, don't enforce** `quota`/`plan` (the kernel gates presence + expiry; the vertical counts its own usage), and **fail-closed** enforcement that flips **per scope** via an `entitlements_enforced` marker the first time entitlements are projected — so a scope provisioned before #304 keeps trusting upstream until a fan-out/reconcile/re-provision back-fills it, stranding no live scope

## Why

The tell that this belonged to the projection, not a new mechanism, was in the docs already: scope-local-permissions.md §3 listed entitlements as the one checker-adjacent input *not* projected, and control-plane.md §4 said the entitlement cache and the routing cache "should be settled once, for both". #304 is cashing both notes. The marker is the honest reading of "fail-closed + reconcile back-fill": strictness is real, but it activates where projection has actually reached, so correctness never arrives as an outage. Scoped out (a follow-up, consistent with role-projection's own limit): the platform→dispatched-vertical provision path (control-plane-api) does not yet *pass* entitlements into `provisionScopeLocal`, so re-projection to a live dispatched worker rides re-provision/reconcile until that is wired — expiry still enforces locally meanwhile, because the projected row carries it
