---
'@substrat-run/control-plane-api': patch
---

A confined caller (a tenant credential or a builder) no longer reads what an upstream or a store answered when a failure reached installs that may not be its own (#2540). It sees only its own scopes and no upstream text; staff keep the text.

- **The answers.** A prod promote's failed in-place serve (`502`, whose `detail` is now the fixed sentence), its store backfill (`storeBackfill.error`) and an export-break listing that could not be read (`exportBreaksUnavailable`) say that the step failed and carry a `reference`. So does `storeError` on `POST /tenants/:tenantId/scopes/:scopeId/provision`, which a builder may call on any install of its own vertical. Staff are answered the text as before, with the reference beside it.
- **Where the text goes.** To the `control-plane.unhandled` log line, with the request's method, path, vertical, version and scope, and to an ops-failure row with no tenant on it, so it never appears in a tenant's `GET /ops-failures`. Both carry the reference. A staff search for `reference = <id>` finds the row.
- **The 5xx backstop.** A row written for a confined caller's failed request says what that caller was answered, never the text of the throw behind it. An unhandled throw's text stays in `onError`'s log line, which now carries the request's reference, tenant and scope, and the row carries the same reference. Staff's rows keep the throw's text.
