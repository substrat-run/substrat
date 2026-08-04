---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
---

Guard `reapScope` so a still-serving scope can never be reaped. A serving app
always holds ≥1 bound hostname, so `reapScope` now refuses (fail closed) while
any hostname is bound to the scope — unbind first, a visible and reversible step.

The hole this closes: `reapScope` *assumed* "hostnames were released at archive",
which is true for the dashboard delete path (it unbinds) but not for a bare
console `archiveScope` (a status flip only). An archived-but-still-bound scope
walked straight into the irreversible wipe, taking a live app's storage with it.

The guard is enforced in two places — the host adapter (so the contract suite
asserts it for every adapter) and the per-scope reap route, ahead of the
vertical's `deleteScope` where the production wipe actually happens. `HostAdmin.reapScope`
gains an optional `{ force?: boolean }`: deliberate teardown (tenant reap §4.8,
retention sweeps §4.4) releases every name by design and sets `force: true`; the
interactive per-scope reap never does.
