---
id: K-31
date: 2026-07-20
layer: kernel
title: "Provisioning is control-plane-driven (pull). The vertical's self-registration is a dev…"
status: accepted
aliases: []
tracking: ["#31", "#49"]
---
# K-31 — Provisioning is control-plane-driven (pull). The vertical's self-registration is a dev…

**Provisioning is control-plane-driven (pull). The vertical's self-registration is a dev affordance and must be unreachable in production** (first-flow §6 decision 3, answered; #31 blocker 1). The deciding fact is not preference but capability: **only the vertical can create a usable scope DO**, because the DO class bundles kernel, engines and modules and lives in the vertical's own deployment (D-30/K-20) — the control plane's `SCOPE` binding is the module-less placeholder. A control-plane → vertical call is therefore unavoidable whichever way registration nominally flows, and once it exists, push is a second way to do the same thing. **Self-serve requires pull regardless**: a customer clicking "create an instance" is a decision the vertical has no way to learn, and push can only mirror what a vertical already did. **The trust direction inverts correctly**: push hands the vertical a token that creates tenants and grants entitlements in the directory — substantial authority pointing the wrong way once verticals are customer code (K-28) — whereas pull means the platform decides and the vertical executes for a tenant the platform already recorded, matching K-27's boundary. **Two phases, already modelled**: `scopeStatus` begins with `provisioning`, so a directory row exists before the vertical has created the DO and only the vertical's confirmation moves it to `active` — the same recorded-is-not-serving distinction `hostnameStatus` makes, so this needs no new machinery. Push survives **gated**, like `STANDALONE` and `ALLOW_DEV_HEADER`, so a vertical run standalone still registers itself for local dev

## Why

Worth a decision rather than an implementation detail because the skeleton's own note said push could "invert later without changing the directory contract", and that is half true: the contract survives, the AUTHORITY model does not, and inverting it after customer code is running is a migration rather than a refactor. Two costs, stated. The control plane needs a binding per vertical — the same static map the router carries, the same Workers-for-Platforms swap later, and the same auth shape as K-27 (no public route plus a shared secret). And partial failure becomes real: a directory row can exist with no scope behind it, which is precisely what `provisioning` is for, but it makes the **reconciliation sweep (#49) load-bearing rather than hygiene** — "0 failed" is unfalsifiable today, and under two-phase provisioning it would also be false. Instance-creation order is fixed by K-30: tenant → scope (pull) → hostname bound in the scope's own jurisdiction → activate, because a hostname whose region contradicts its scope must never resolve
