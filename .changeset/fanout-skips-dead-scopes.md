---
'@substrat-run/adapter-cloudflare': patch
---

Scope-local permission fan-out stops projecting into dead scopes. A
tenant-level write (a role definition, an assignment, a grant, a membership, an
entitlement, an identity link) fans the tenant's projection into its scopes —
and it selected them with no status filter, so `archived` and `reaped` rows were
included.

A reaped scope's storage was deliberately `deleteAll()`d — *"the bytes are gone,
so there is no restore"* — so writing a projection into its Durable Object
recreated storage for a scope the platform believes dead. Silently, on every
membership change, and unboundedly in the number of apps a tenant has ever
archived. The fan-out now targets `provisioning`, `active` and `suspended` only:
a scope mid-provision pulls the projection itself and one idempotent write beats
racing that pull, and suspension is reversible, so a suspended scope must not
come back with a stale projection.

Found while sizing the fan-out for #1343, which the scope-local-permissions
design named as its open question 1 — "the dashboard's own many-scope tenant is
the case to size".
