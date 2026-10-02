---
"@substrat-run/kernel": minor
"@substrat-run/contracts": minor
"@substrat-run/contract-tests": minor
---

Add `readScopeTimeline` / `readScopeHistory`: the scope-wide counterparts of `readTimeline` / `readHistory`. They walk everything in the scope since a watermark (the last applied event `id`), each entry carrying the `entity` it was about, optionally narrowed by `entityType`, decoded with the same null-is-a-fact semantics as the per-entity reads. Like them, they check no permission — the caller's check in front of a scope-wide walk must itself be scope-wide. New contract schemas `scopeTimelineEntry` / `scopeHistoryEntry`, and the timeline contract suite covers the walk on both adapters.
