---
id: K-20
date: 2026-07-15
layer: kernel
title: "Control plane"
status: accepted
aliases: []
twin: D-30   # restates the same decision — collapse candidate
tracking: []
---
# K-20 — Control plane

**Control plane** ([control-plane.md](../architecture/control-plane.md), implements plan decision 30): the control plane is the **shared platform layer N per-vertical deployments sit on**, not an admin app — §5.5 already shares routing, custom hostnames, tenancy, identity, entitlements and Tier 2; only the scope-DO class is per-vertical. Merging the DO classes is rejected (lockstep engine upgrades across differently-owned verticals — §7.8/open question 12). Builds what §3.2/§3.3/§5.4 specified and nobody implemented: `tenants` table, real lifecycle transitions, an entitlement store that reads `manifest.entitlementKey`, and a `PlatformActor` + append-only admin audit log wrapping every mutation (including `HostAdmin`'s five unaudited methods). The admin's **effecting** half is out-of-band host code — never module code; its **record-keeping** half may later be a vertical in a platform tenant. Only path into scope data stays §5.4's audited admin-query RPC. Billing deferred: meters 1–2 free, 3–4 uncomputable

## Why

K-8 (no raw DO namespace binding) plus one-deployment-per-vertical means an admin *vertical* has no addressable path to another vertical's scopes — impotent, not dangerous — so the effecting half must be out-of-band, and granting it the path would be building this anyway. The audit log is the platform's own `_substrat_outbox` on the same argument as K-4: a surface that can act without a durable record of who acted is worse than no surface (and that a hand-built log *is* the outbox is the argument for eventually dogfooding the record-keeping half). Forces open question 5 (entitlement check on the module-load hot path or cached with event invalidation) to be answered by a benchmark, and promotes open question 9 (orchestrating N deployments) from footnote to centre
