---
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

A vertical's internal `POST /internal/restore` and `POST /internal/snapshot` routes now require `tenantId` (#2035). This changes the behaviour of an internal route and **breaks any caller that sends no tenant**. The repo has no such caller: the control plane's `VerticalClient` sends the tenant on both.

A body without one is refused before any scope store is touched, so the refusal writes nothing. The answer is `400`, `application/problem+json`:

```json
{ "code": "validation_failed", "error": "the input did not parse",
  "errors": [{ "path": "tenantId", "message": "Invalid input: expected string, received undefined" }] }
```

To fix it, send the tenant the scope belongs to. The restore records it as the scope's tenant in the load's own transaction, then re-projects the vertical's roles for it. That repair now always runs. The snapshot records it on the copy and refuses a source that belongs to another tenant.

Why: a load that named no tenant could land a scope holding neither a tenant record nor role rows. A dump from a world that keeps its roles outside the scope is one example. A control-plane-less host's doors have nothing to check the (tenant, scope) pair against in such a scope, which is the compatibility state #2035 is meant to end.

`VerticalClient.snapshotScope` now types `tenantId` as required.

Deploy order: the control plane must be running a release that carries #2033 (control-plane-api 0.137.0 or later) before a vertical re-pushed on this vertical-host is snapshotted. An older control plane sends no tenant on a snapshot, and the snapshot is refused with the `400` above.
