---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
---

A dropped Tier-2 lake table can now be rebuilt without losing history.

The drain stamps `drained_at` on every outbox row it ships, and until now the stamp was one-way. That mattered as soon as a lake table had to be dropped: a Pipelines stream cannot change its schema in place and a sink refuses to write to an existing table, so adding a column means a new table. Dropping the old one did not clear the stamps, so every event already shipped became history the drain would never offer again, and the new table started with a silent hole behind it.

`HostAdmin.redrainEvents(actor, tenantId, scopeId, { drainedBefore })` clears the stamp on rows stamped strictly before an instant, so the ordinary drain ships them again. The instant is required and is the whole safety property: clearing every stamp would also reopen rows already shipped to the rebuilt table and write them there twice. Strictly before, because a row stamped at exactly that instant went to the new table. It is delegated to the vertical's deployment like the stamp it undoes, exposed on the control plane as a staff/service-only route, and audited as a `redrainEvents` admin row written only when something changed — so re-running over a window already reopened leaves no receipt claiming work it did not do.

`scripts/lake-redrain.mjs` (`pnpm lake:redrain`) walks every active scope with it and is safe to re-run.

`scripts/lake-provision.mjs` now authenticates with its own `CF_LAKE_ADMIN_TOKEN` rather than `CF_API_TOKEN`. `CF_API_TOKEN` is pushed to the running control plane as a worker secret, so widening it would hand deletion of the audit lake to anything that compromises the plane. After creating a stream it prints the new id directly and the full rebuild sequence including the re-send, and it no longer prints "has no snapshots — nothing committed" directly below a warning that snapshots are being discarded.
