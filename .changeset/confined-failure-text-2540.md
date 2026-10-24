---
'@substrat-run/control-plane-api': patch
---

A confined caller (a tenant credential or a builder) no longer reads what an upstream or a store answered when a failure reached installs that may not be its own (#2540). It sees only its own scopes and no upstream text; staff keep the text.

- **The answers.** A prod promote's failed in-place serve (`502`, whose `detail` is now the fixed sentence), its store backfill (`storeBackfill.error`) and an export-break listing that could not be read (`exportBreaksUnavailable`) say that the step failed and carry a `reference`. So does `storeError` on `POST /tenants/:tenantId/scopes/:scopeId/provision`, which a builder may call on any install of its own vertical. Staff are answered the text as before, with the reference beside it.
- **Where the text goes.** To the `control-plane.unhandled` log line, with the request's method, path, vertical, version and scope, and to an ops-failure row with no tenant on it, so it never appears in a tenant's `GET /ops-failures`. Both carry the reference. A staff search for `reference = <id>` finds the row.
- **Rows a tenant reads back.** An ops-failure row attributed to a tenant says what the request was answered, whoever made it, staff included. When the failure's own text differs (an unhandled throw, a store's answer), that text is recorded on a second row with no tenant under the same reference, and in the `control-plane.unhandled` log line, which now carries the reference, tenant and scope. This covers the 5xx backstop's row, the promote's serve row, and the store-mint rows of `POST /tenants/:tenantId/scopes/:scopeId/provision`.
