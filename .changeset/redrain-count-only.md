---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane': patch
---

`redrainEvents` can now answer how many rows a window holds without reopening any of them: `countOnly: true` on its input, absent everywhere else, so the verb behaves exactly as before for every caller that does not ask. The count is UNBOUNDED where the reopen is batched at `REDRAIN_BATCH` — an aggregate materialises no rows, so it answers for the whole window in one call rather than the first batch of it.

A count leaves an **access-log** row, because it is a `HostAdmin` read and K-24 takes all reads rather than a chosen subset — the window it named and the number it found, so "who counted this tenant's outbox" has an answer. What it writes no row in is the **admin** log: those two receipts exist because a reopen is a second egress of a tenant's payloads, and a row claiming a redrain on a scope that was only counted would be a false statement in the log that is the evidence.

The transport keeps the two apart by PATH rather than by a flag, at both hops where the peer is deployed on its own clock: `POST /tenants/:tenantId/scopes/:scopeId/redrain-count` on the control plane and `POST /internal/redrain-count` on a vertical. A `countOnly` field on the existing routes would be stripped by an older deployment's Zod boundary, which would then reopen the window and answer with a number shaped exactly like the count that was asked for. A path it does not serve refuses instead, with the rows untouched.

`pnpm lake:redrain --drained-before=… --dry-run` therefore prints real per-scope totals and a fleet total, in place of the paragraph saying it could not know (#1545).
