---
'@substrat-run/control-plane-api': minor
'@substrat-run/demo-callout': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-manyfold': patch
---

The platform delivers a tenant's entitlements WITH provisioning, so a dispatched vertical
projects them (#310) — completing the seam #304 left open.

#304 projected entitlements into a scope but left the platform→dispatched-vertical path un-wired:
a freshly provisioned CP-less scope received no entitlements, so its `entitlements_enforced` marker
stayed off and the gate trusted upstream (only expiry, carried on the row, enforced locally).

- **`ProvisionInstanceInput` gains `entitlements`**, delivered on the provision payload.
- **The control-plane gathers them itself** at the single provision choke point
  (`POST /verticals/:slug/instances`) via `admin.listEntitlements` — platform-authoritative, never
  trusting the caller's body. Console and dashboard both route through that endpoint, so one
  injection covers every production path.
- **The demo verticals (callout, meridian, manyfold)** parse `entitlements` (reusing the
  `entitlementGrant` contract) and hand them to `provisionScopeLocal`, which projects them and flips
  enforcement on.

Propagation of a later grant/revoke to an already-live dispatched worker **rides a re-provision**
(the idempotent K-31 call, the same channel role-definition changes use) rather than a new
push-on-grant fan-out; expiry keeps enforcing locally meanwhile. A dedicated push channel stays
available if a future SLA needs sub-re-provision revocation latency. Decision D-42.
