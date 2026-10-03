---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A copy of a scope keeps the source's history and none of its power. A fork, a snapshot or a preview, or a backup of one scope restored onto a different scope, now starts with no link shares, so a live link no longer also opens the copy. Nothing the source had queued runs from the copy either: platform requests and job runs that were still in flight arrive settled as failed with a "not carried" reason, executor retries arrive finished, and events the source emitted are never delivered to the copy's consumers or executors, nor shipped to the event lake a second time. Events the copy emits itself flow as before. A backup restored into the scope it came from, or a scope moved onto a new version, keeps everything. A restore that does not say which scope its backup came from is treated as a copy, and one presented as the target's own backup is treated as a return. The kernel records a copy's origin in a new spine table, `_substrat_copy_origin`; `capabilitiesForLoad`, `settleCopiedWork` and `emittedHere` are the rules both adapters apply.
