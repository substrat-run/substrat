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

`HostAdmin.redrainEvents(actor, tenantId, scopeId, { drainedBefore })` clears the stamp on rows stamped strictly before an instant, so the ordinary drain ships them again. The instant is required and is the whole safety property: clearing every stamp would also reopen rows already shipped to the rebuilt table and write them there twice. Strictly before, because a row stamped at exactly that instant went to the new table. An instant in the future is refused outright, wherever the call comes from: it would clear the stamps on rows the drain shipped *after* the rebuild, which is the double-write the required instant exists to prevent.

It is delegated to the vertical's deployment like the stamp it undoes, and exposed on the control plane as a staff/service-only route. Each call reopens a bounded batch rather than the whole window at once — the outbox is never pruned, so on a long-lived scope "every stamped row before an instant" is unbounded work, and one oversized attempt would fail and keep failing, leaving the scope that most needed reopening unable to finish. The call reports how many rows it reopened, and the caller repeats until that is zero; `pnpm lake:redrain` does this per scope, and the route says whether more remain so a single request is never mistaken for a finished window.

The audit trail is written in two parts, because the reopen and the record of it are separate writes. An **intent** row goes down before anything is reopened, naming the window: if the process dies in between, the attempt is still on the record — a retry would find the stamps already cleared, reopen nothing, and otherwise have had nothing to report. An **outcome** row follows only when rows actually moved, so re-running over a window already reopened still leaves no receipt claiming work it did not do. A second egress of a tenant's payloads is exactly what the audit log must not lose track of.

`scripts/lake-redrain.mjs` (`pnpm lake:redrain`) walks every active scope with it and is safe to re-run.

`scripts/lake-provision.mjs` now authenticates with its own `CF_LAKE_ADMIN_TOKEN` rather than `CF_API_TOKEN`. `CF_API_TOKEN` is pushed to the running control plane as a worker secret, so widening it would hand deletion of the audit lake to anything that compromises the plane. After creating a stream it prints the new id directly and the full rebuild sequence including the re-send, and it no longer prints "has no snapshots — nothing committed" directly below a warning that snapshots are being discarded.
