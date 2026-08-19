---
id: D-30
date: 2026-07-15
layer: plan
title: "Control plane = the shared layer across N per-vertical deployments; billing deferred"
status: accepted
aliases: []
twin: K-20   # restates the same decision — collapse candidate
tracking: []
---
# D-30 — Control plane = the shared layer across N per-vertical deployments; billing deferred

**Control plane = the shared layer across N per-vertical deployments; billing deferred** ([design/control-plane.md](../architecture/control-plane.md), K-20). §5.5's one-deployment-per-vertical is a *versioning and blast-radius* boundary, not duplicated platform: routing, custom hostnames, tenancy, identity, entitlements, and the Tier-2 sink are already kernel-owned and shared — the **only** per-vertical thing is the scope-DO class (the app binary). Merging the DO classes is **rejected**: it makes migrations globally ordered across unrelated verticals, merges blast radius, and forces **lockstep engine upgrades across verticals owned by different companies**. Build four things the directory was specified to hold and does not: a real `tenants` table, the §3.3 lifecycle transitions (un-archive stays a restore), an **entitlement store that finally reads `manifest.entitlementKey`**, and a `PlatformActor` + append-only **admin audit log** on every mutation (wrapping `HostAdmin`'s five unaudited methods). The admin's **effecting** half (provision/suspend/entitlements/admin-query RPC) is out-of-band host code and can never be module code (K-8: no raw DO binding — an admin vertical would be *impotent*, not dangerous); its **record-keeping** half *can* be a vertical in a platform tenant, deferred to the second vertical. Console is thin over these and is the home for the permission-diff human checkpoint. **Billing: meter, don't bill** — meters 1 (active scopes) and 2 (entitlements) fall out free; 3 and 4 are uncomputable today. Auth gates *exposing* the console, not building it

## Why

The directory (§3.2) was specified as "the only complete inventory of tenants and scopes" and only the scope half was built — a tenant is an FK string, and D-20's entitlement gate is a field nothing reads. The console isn't a feature on a finished kernel; it's what forces the shared layer to exist. The merge rejection is §7.8/open-question-12's push-upgrade lesson applied to ourselves: adopting the Odoo/SAP treadmill to save operating a deployment is a bad trade, and the shared-bundle counter-design converts a *structural* guarantee into a *config* one — the move K-3 and K-8 refuse everywhere else. The vertical/effecting split is D-18's triage rule (effects on the outside world are connectors); the tell is that a hand-built admin audit log *is* `_substrat_outbox`. Billing deferral follows from the meters: 3 needs the Tier-2 fan-in sink (per-scope outbox can't aggregate; reads emit nothing; `drained_at` written nowhere) and 4 needs cross-tenant orders — a meter you cannot compute is a data-pipeline project, not a pricing decision. The `PlatformActor` seam is D-16 cashed in: the actions decide the auth, so building them first is what makes the auth designable
