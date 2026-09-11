---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
---

Events now carry when they last happened, not only how many there were — and the flow map can tell a path that stopped from one that never ran.

A count answers "did this ever work". It cannot answer "is it working now", and the difference is where the interesting failures live: a sync that fired four thousand times and went quiet two months ago looks perfectly healthy on volume alone. Every grouped event count is now accompanied by when that group last saw an event, so the question has an answer.

On an app's flow map, an event that has been recorded but not in the last thirty days is marked and says how long it has been — visibly different from one that has never been recorded at all, which stays drawn as an outline. The two are kept apart deliberately: a path that never ran may simply not be built yet, while one that ran and stopped means something changed. The findings list makes the same distinction, and words a stopped handler as the thing feeding it having stopped rather than the handler failing, because the handler is the component behaving correctly.

Nothing is claimed where nothing is known, and the line falls between what was seen and what was not. A type whose recency could not be read is not called stale. Where an app has more kinds of event than can be counted in one pass, nothing is reported as never recorded — a type missing from a shortened list is not evidence that it never happened — while the events that were counted are still judged on how recently they ran.

Staleness is reported for the event type rather than for a module: the counts are grouped by type, so saying a particular module emitted all of them would be a claim the numbers do not support, and plainly wrong where two modules carry the same type. The modules are named as having declared it, which is what a deploy actually records.
