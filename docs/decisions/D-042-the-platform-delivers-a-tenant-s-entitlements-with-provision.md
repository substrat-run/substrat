---
id: D-42
date: 2026-07-28
layer: plan
title: "The platform delivers a tenant's entitlements WITH provisioning, and grant/revoke…"
status: accepted
aliases: []
tracking: ["#310"]
---
# D-42 — The platform delivers a tenant's entitlements WITH provisioning, and grant/revoke…

**The platform delivers a tenant's entitlements WITH provisioning, and grant/revoke propagation to a live dispatched vertical rides re-provision** ([#310](https://github.com/substrat-run/substrat/issues/310); completes D-41's scoped-out item). D-41 projected entitlements into a scope but left the platform→dispatched-vertical seam un-wired: a freshly provisioned CP-less scope got *no* entitlements, so its `entitlements_enforced` marker stayed off and the gate trusted upstream. Now the control-plane's single provision choke point (`POST /verticals/:slug/instances`) **gathers the tenant's entitlements itself** (`admin.listEntitlements` — platform-authoritative, never trusting the caller's body) and delivers them on the provision payload; the vertical parses them (`entitlementGrant`, reusing the contract) and hands them to `provisionScopeLocal`, which projects them and flips enforcement on. Both console and dashboard route through that one endpoint, so one injection covers every production path. **Propagation of a later grant/revoke to an already-live dispatched worker rides a re-provision** — the same idempotent K-31 call, and the same mechanism role-definition changes already use — rather than a new push-on-grant fan-out channel; meanwhile expiry still enforces locally because the projected row carries it

## Why

The seam looked like it needed touching in four places (control-plane-api, console, dashboard, each vertical) until the call graph showed console and dashboard both POST to the *same* control-plane endpoint — so the authoritative gather belongs there, once, and the callers stay unchanged. Deciding re-provision is the propagation channel (not building a push-on-grant fan-out) is the same judgment D-41's marker encodes: the platform already re-provisions to heal role projections (the Egeryds runbook), so entitlements riding that path adds no new failure mode, whereas a bespoke grant→vertical push would add one for a case expiry already covers. A dedicated push channel stays available if a future SLA needs sub-re-provision revocation latency
