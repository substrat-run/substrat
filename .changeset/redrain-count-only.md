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

`redrainEvents` can now answer how many rows a window holds without reopening any of them: `countOnly: true` on its input, absent everywhere else, so the verb behaves exactly as before for every caller that does not ask. The count is UNBOUNDED where the reopen is batched at `REDRAIN_BATCH` — an aggregate materialises no rows, so it answers for the whole window in one call rather than the first batch of it — and it writes no admin receipt, because a count egresses nothing for K-24 to record and an intent row for a reopen that never happened is a false statement in the log that is evidence.

The transport keeps the two apart by PATH rather than by a flag, at both hops where the peer is deployed on its own clock: `POST /tenants/:tenantId/scopes/:scopeId/redrain-count` on the control plane and `POST /internal/redrain-count` on a vertical. A `countOnly` field on the existing routes would be stripped by an older deployment's Zod boundary, which would then reopen the window and answer with a number shaped exactly like the count that was asked for. A path it does not serve refuses instead, with the rows untouched.

`pnpm lake:redrain --drained-before=… --dry-run` therefore prints real per-scope totals and a fleet total, in place of the paragraph saying it could not know (#1545).
