---
'@substrat-run/demo-auth-server': patch
---

The auth server answers the platform's reconcile, so its installs stop being asked again on every sweep pass.

Since a promote of a listed vertical re-runs provisioning on its installs, the control plane sends every auth-server install a `POST /internal/reconcile`. There was no such route: the `/internal/*` catch-all answered `501`, the sweep counted each install `unsupported`, wrote no receipt for it, and asked the same install again on the next pass and every one after. Each ask took a slot of the pass's batch.

The route wakes the install's issuer, which brings its schema to the served version, and answers `200 { tenantId, scopeId }` when the issuer knows the install. It writes nothing: a reconcile carries no `slug` or `name`, so re-running the provision would have blanked what the provision recorded. An install the issuer never recorded, or one recorded for another tenant, answers `409`, as vertical-host's reconcile does, so the sweep records no receipt for a provision that never happened. It stays a failure the sweep reports, not a silent skip.

The workerd suite this change adds is the demo's first: it compares every table of an issuer's SQLite after one provision and after a second provision plus two reconciles, and they are identical. Every other `/internal/*` verb the demo does not implement still answers `501`.
