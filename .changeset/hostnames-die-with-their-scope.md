---
'@substrat-run/control-plane-api': minor
---

Hostnames die with their scope. Deleting an app archived its scope but left
every hostname row behind — the default mint lingered on the Domains page
(App column showing a raw scope ULID), and the #423 heal pass would flip it
back to `active` forever. Two-sided fix: the dashboard's `deprovisionApp` now
unbinds ALL of the scope's hostnames (default mint, per-surface mints, custom
domains — the CP DELETE releases a custom domain's Cloudflare object), and
`reconcilePendingHostnames` opens with an orphan pass that unbinds any row —
whatever its status — whose scope is `archiving`/`archived`/`reaped`, so
existing orphans clear on the next sweep instead of needing a manual click.
`HostnameReconcileAdmin` grows `listScopes` + `unbindHostname` (both already
on `HostAdmin`), and the reconcile result reports `orphaned`.
