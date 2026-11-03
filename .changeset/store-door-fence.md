---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

Deleting a scope now fences its stores. A deletion path sends `substrat.fence`, which the store entry answers in front of any driver: it marks the object, waits for the calls inside it, and hands the driver its `substrat.wipe`. The object then answers 410 `store_fenced` to a vertical's call, whenever it was signed, and refuses the platform's stage and commit, so nothing can recreate a deleted store. The retention sweep takes its copy-move claim before it fences, so a refused reap leaves the stores whole. A vertical reads a fenced store as `not_found`, with `storeCode: store_fenced`. Where a scope's row stays, the directory records the fence first (`markScopeStoresFenced`), and the scope then cannot be unarchived or restored into, nor its tenant un-deleted. The control plane uploads store scripts from its own bundled entry, so it deploys first and its walk replaces them; until the walk reaches a script a reap gets 502 and fails closed, after a snapshot or preview reap has unbound its names. No driver release is approved yet.
