---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
---

Events now carry when they last happened, not only how many there were — and the flow map can tell a path that stopped from one that never ran.

A count answers "did this ever work". It cannot answer "is it working now", and the difference is where the interesting failures live: a sync that fired four thousand times and went quiet two months ago looks perfectly healthy on volume alone. Every grouped event count is now accompanied by when that group last saw an event, so the question has an answer.

On an app's flow map, an event that has been recorded but not in the last thirty days is marked and says how long it has been — visibly different from one that has never been recorded at all, which stays drawn as an outline. The two are kept apart deliberately: a path that never ran may simply not be built yet, while one that ran and stopped means something changed. The findings list makes the same distinction, and words a stopped handler as the thing feeding it having stopped rather than the handler failing, because the handler is the component behaving correctly.

Nothing is claimed where nothing is known: a type whose recency could not be read is not called stale, and neither is anything at all when the events could not be counted in one pass.
