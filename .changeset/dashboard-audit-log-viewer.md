---
'@substrat-run/dashboard': minor
---

Dashboard: per-scope Audit tab (#479). Each app gains an Audit tab that renders its
scope's slice of the control-plane admin log — every privileged action against the
scope, newest first, with cursor pagination and a read-only before/after detail. A pure
consumer of the audit spine the platform already captures: the tenant-narrowed control
plane pins `tenantId`, so the viewer can only ever read the caller's own tenant.
