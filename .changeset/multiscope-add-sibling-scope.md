---
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
---

Self-serve multi-scope, M1: add a sibling scope to an app the tenant already runs.

New builder-reachable, tenant-narrowed `POST /tenants/:tenantId/scopes` route on the control
plane. It authorizes by `parentScopeId` — the existing app scope must belong to the caller's
tenant, which proves the entitlement — and the new scope INHERITS that app's vertical and
jurisdiction, so a caller can never name a vertical it does not already run. It then runs the
same provision → materialize-instance (K-31) → activate sequence `createApp` runs for an app's
first scope. A builder is confined to its own tenant (foreign tenants read as 404, K-3
existence-hiding); staff may target any tenant. No site-count quota is enforced yet — an open
product question tracked in the design doc. The dashboard's `TenantNarrowedControlPlane` gains
an `addSiblingScope` method over the new route.

Also pins a regression (#355): `provisionScopeLocal` applies a scope's module migrations at
provision time — own tables created and journaled before any first `getScope` — so a
freshly-provisioned scope is never born content-less.
