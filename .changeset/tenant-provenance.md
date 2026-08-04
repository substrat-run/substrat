---
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

Record tenant **provenance** so the fleet can tell an app-provisioned customer tenant
from a first-class one. `Tenant` gains `provisionedByTenant: TenantId | null` — a FK to
the manager's tenant, set only when a manager vertical creates the tenant via the
`provision-tenant` platform intent (#412), and null for a direct staff create.

The value is host-derived, never caller-supplied: `provisionTenantHandler` stamps
`ctx.tenantId` (the manager tenant the host resolved from the provisioning scope's
directory row — the vertical can't forge it), and the direct `POST /tenants` route forces
it null. `createTenantInput` gains the field as **optional** (drain supplies it; staff
create omits it), so the `HostAdmin.createTenant` signature is unchanged and every
existing call site keeps compiling. Both adapters persist a nullable
`provisioned_by_tenant` column (a directory schema change, not a module migration).

This unblocks the #412 invariant-2 entitlement-ownership bound (a listed manager may only
`set-entitlements` on tenants it provisioned) — this change records the ownership fact;
enabling that enforcement is a separate follow-up.
