---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

Platform intent handlers for the manager-vertical capability (#412): `provision-tenant`
and `set-entitlements`. A manager vertical (a console whose job is to add tenants — the
AuthHero console is the first consumer) enqueues via `ctx.requestPlatform`; the drain now
executes both kinds with `HostAdmin` authority. `provision-tenant` creates a NEW customer
tenant, grants its entitlements, and materializes its first scope running the PAYLOAD's
vertical exactly as a first install would (serving-deployment resolution, per-tenant store
mint (#301), `provisionInstance` with the #310 projection, config delivery, activate) —
all ids are payload-proposed join keys, so an at-least-once drain converges.
`set-entitlements` reconciles a managed tenant to a plan's target set — grant what's
named, revoke declared-but-absent — and re-projects into the tenant's auth scope via the
vertical's idempotent reconcile.

Because a new tenant has no proving parent scope, admissibility is bounded on the
MANAGER: a tenant-provisioner capability (the control plane's `TENANT_PROVISIONERS`
deployment config while every manager is first-party) and the manager's registry-declared
SKU universe, which bounds both grant and revoke. Contracts gain the wire schemas
(`provisionTenantPayload`, `setEntitlementsPayload`, `entitlementSelection`, kind
constants) matching the console's `intents.ts` verbatim.
