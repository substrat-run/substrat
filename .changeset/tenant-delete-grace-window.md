---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
'@substrat-run/console': minor
---

Tenant delete with a grace window (§4.8, #36): reclaim a deleted tenant's data instead of
stranding it forever. `deleting` was a dead status — written once (a dashboard team-delete)
and never consumed, so a tenant marked for deletion kept every byte. This finishes the
lifecycle as the tenant analogue of §4.4's scope reap.

`tenantStatus` gains a terminal `reaped` past `deleting`, and the `tenants` row gains a
`deletingAt` timestamp (stamped on entering `deleting`, cleared on un-delete) so the grace
window can be aged. `deleting` stays a reversible pause — every scope already fails `getScope`
closed under a non-active tenant, so nothing is destroyed until a reap, and an un-delete (→
`active`) restores the tenant whole. `reapTenant` (new on `HostAdmin`, directory-side only)
clears the tenant's PII/config directory rows — identities and identity pools, membership
tuples, roles, entitlements, orgs — and flips the row to a `reaped` tombstone, keeping the
`tenants` row (burned slug + history) and `_substrat_admin_log` whole. It refuses any tenant
not in `deleting`; `reaped` is unreachable via `setTenantStatus`.

Delivered over one seam, two ways: a staff-only `POST /tenants/:t/reap` ("reap now", armed in
the console behind a type-the-slug dialog, refused with 409 unless the tenant is `deleting`),
and a `runPlatformSweep` phase that reaps tenants whose `deletingAt` is older than
`TENANT_RETENTION_DAYS` — opt-in and unset by default, because the reap is irreversible. The
per-scope byte-wipe runs above the kernel: the reaper archives-if-needed then reaps each scope
through the existing `reapScopeFn` seam (so the control plane's orchestrated per-scope wipe
applies for free), then clears the directory via `reapTenant`.

Also settles #36's retention question: the admin log is the compliance witness (bokföringslagen
§5.3) and is deliberately **never swept** — no TTL. The bound against dumping an ever-growing
table lives on the read surface instead: `GET /admin-log` now defaults a page size (the
in-process `auditLog` stays unbounded, so an internal caller that wants everything still gets it,
and `nextCursor` walks the whole log).

Full-tenant export (GDPR Art. 20 portability) is intentionally out of scope here — the per-scope
`exportScope` seam it builds on already exists.
