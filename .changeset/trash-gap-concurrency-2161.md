---
'@substrat-run/contracts': patch
'@substrat-run/docs': patch
---

`trashRefusalGapsOf` also names an operation that addresses a trashable entity by an input id under a check that is not on that entity — a scope-wide key, or another entity's — when its `concurrency: { over, idFrom }` says which entity the id names (#2161). Each gap now carries `via: 'check' | 'concurrency'`. `lint:model` prints the new kind as a warning, as it does the resolved-check kind. The host refuses neither on a trashed entity, so the handler must ask `ctx.entityState`, or the check should move onto the row.

The ticket0 page says what the saved-reply trash does.
