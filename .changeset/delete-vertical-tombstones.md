---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
---

`deleteVertical`'s bound-scope refusal no longer counts `reaped` tombstones —
they are terminal history, and counting them made any vertical that ever had an
install permanently undeletable. An `archived` scope (a deleted app) still
blocks, since unarchive can restore it, but the refusal now names the actual
remaining step ("reap or restore them first") instead of telling the caller to
delete an app that is already gone. Contract-tested in both adapters.
