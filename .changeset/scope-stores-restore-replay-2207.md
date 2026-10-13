---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/router': patch
---

A restore re-erases tombstoned subjects from scope stores without ever refusing the restore. The replay reads the target scope's erasure marks and, when the source is a scope of the same tenant on this host, the source's too. When the source is unknown (another host's backup, an upload, a deleted snapshot), the restore still lands and returns `storeErasureIncomplete: true` with `storeErasureSourceUnknown: true`; the restore route answers `incomplete` and `sourceUnknown`. The result is present only when `storeErasuresReplayed > 0` or `storeErasureIncomplete`; absent means no erasure had to be replayed and none is missing, which is also what `restoreScope` returned before. The kernel exports `replayStoreErasures`, which both adapters and the control plane use. A hosted snapshot reports its fork's replay on its answer the same way. The restore route refuses, before any write, a dump store whose binding the destination's version does not declare or whose kind differs. The control plane now names a scope's stores from the version its script runs, through one resolver, `scopeStoresOf`, used for backup, full pull, snapshot, reap, restore, erasure and the sweep. Before, an install on the serving pin was backed up, reaped, restored and erased without its store. The router's route read applies the same rule, and gives a scope pinned to a script other than the current serving one no store. A store list that cannot be resolved refuses with 503 once a store kind is registered (`mayHoldScopeStores` in contracts), and a hosted control plane with no route to the store scripts refuses rather than skips (`unreachablePlatformScopeStores`).
