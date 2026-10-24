---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
---

The reserved-key rule's paths left unjudged by #2447 are decided (#2531).

- **vertical-host: the owner hand-over needs the person's door.** `POST /internal/owner-transfer` now answers 501, before the owner record moves and with nothing seated or revoked, when the scope host has no `scopeRoleRefusal`. Such a host predates the person's door and would seat the new owner through the platform's door. The message asks for the adapter beside `@substrat-run/vertical-host` to be upgraded. This is an availability change for a skewed pair only: a vertical that pins this `vertical-host` with an adapter from before the person's door cannot hand its owner seat over until it upgrades the adapter.
- **adapter-cloudflare: the ScopeDO's one-row projection RPCs are removed.** `projectRole`, `projectTenantTuple` and `revokeProjectedRole` had no shipped caller, and wrote what they were handed without judging it. Every projected role row now arrives through `applyProjection`. No wrangler migration is needed; a test seeds such rows straight into the scope's storage instead.
- **Decided and left as is**, each stated in K-55 and on the permissions page: data copies the platform or staff make (an in-deployment snapshot, a staff restore or import on a host the control plane runs; the stale projected roles such a restore leaves are #2555), the directory fan-out, the platform's role doors (the record of a principal's kind belongs with the host principal's lifecycle, or #1824 part 2), a role defined on a Cloudflare coordinator for a tenant with no scope yet, the owner grants an install gives, a key reserved only through a schedule on a host that registers no modules, and the coordinator's scope-seat read before the ControlPlaneDO's `defineRole`.
