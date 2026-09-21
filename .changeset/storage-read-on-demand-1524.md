---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
'@substrat-run/console': patch
---

A tenant's storage can be read on demand: the size of each of its scope databases, and their sum.

`GET /meters/storage?tenantId=…` (staff-only) answers one page of the tenant's scopes, each
with its database size in bytes: `SqlStorage.databaseSize` on Cloudflare and
`page_count × page_size` on SQLite. A scope is read through `HostAdmin.scopeDatabaseSize` when it is co-located, and
through the vertical's new `/internal/database-size` when a vertical's deployment holds it.
The console's tenant page has a **Storage** card that reads only when the button is pressed.

Nothing is stored and nothing sweeps. Reading a scope's size wakes its Durable Object, so a
reading is bounded to one page of at most 200 scopes (default 50) with at most 8 reads in
flight, and there is no fleet-wide form. A scope whose read fails is listed with its error and left out
of the sum, and the reading says `complete: false`. Only a reading that covered every scope
with no failure is complete. Attachment files, per-tenant D1 databases and the lake are
not counted, and each reading names them in `excluded`.

`HostAdmin.scopeDatabaseSize` is a new required method on the kernel's host-admin interface.
`VerticalScopeHost.databaseSizeLocal` is optional, so a vertical built before it still
satisfies the interface, and its route answers 501 rather than a size.
