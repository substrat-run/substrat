---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

A declared lifecycle can now be counted on a clock. `readOperationSeries` answers how many calls made each lifecycle move per time bucket, such as how many orders were closed in each half hour, from the outbox with no new write path. A call that emitted several events about one record counts once.

`lifecycleMovesOf` picks the moves from a model's declared lifecycles. It keeps an operation only when every place the declaration names it is an edge into the same state. Such an operation's calls are always that move, so the count is exact; an operation that is also merely allowed somewhere is left out.

The read covers at most seven days and answers in one aggregate statement over the outbox's primary key, with no new index. It is exposed as the `operationSeries` platform read, through the vertical's new `/internal/operation-series` route and the control plane's `operation-series` route, and logged like every other scope read with the window and entity types only. A vertical serves the read once it is pushed on this release. `ulidFloor` joins `ulidCeiling` in the kernel.
