---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

A control-plane-less scope host now checks the (tenant, scope) pair against the scope's own record (#2016). Until now the router's pair was trusted as asserted, and a mismatched pair was refused only because grants are keyed by tenant.

- Every door into a scope holds the pair to the tenant the scope was provisioned for (its `provisioned_for` receipt, #1738): invoke, attachments, the system, capability, peer and connector doors, jobs, the retry driver and the operator reads. A scope of another tenant is refused with K-3's `not_found` ("unknown scope for tenant"), before any guard, handler or store lookup runs. The check rides the one Durable Object call the CP-less lifecycle gate already made (`ScopeDO.admission`), so a door costs no extra round-trip.
- A scope provisioned before the receipt existed is judged by its role rows, as the served-here gate already did. A scope that holds neither (a load from a world that keeps its roles elsewhere, before its repair) refuses no one, and the permission gate decides as before.
- The receipt is back-filled only from the platform's word: a provision, a reconcile, a restore's repair, or a lifecycle delivery that now names the tenant (`/internal/lifecycle` takes an optional `tenantId`; `VerticalClient.setLifecycle` sends it). A delivery for a tenant the scope is foreign to is refused (409) and stores nothing. A request's tenant is never recorded.
- A load keeps the store's own receipt and never the dump's, so a restore no longer leaves a window with none. `/internal/restore` and `/internal/snapshot` pass the tenant through (`restoreScopeLocal`'s `tenantId`, `snapshotScopeLocal`'s third argument): the copy records it as its own, a store provisioned for another tenant refuses the load, and a snapshot of another tenant's scope is refused before anything is copied. A platform that sends no tenant gets the old behaviour.
