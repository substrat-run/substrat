---
"@substrat-run/adapter-cloudflare": patch
---

`unarchiveScope` pushes the tenant's current permission projection into the scope before flipping it back to `active`. An archived scope sits outside the fan-out's status filter, so a tenant-level revoke that landed while it was archived never reached its local projection, and a bare status flip put that stale projection back on duty until the next tenant-level write or the reconciliation sweep (#1473).
