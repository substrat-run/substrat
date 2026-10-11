---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/docs': patch
---

**Behaviour change to a documented rule (#901): a kernel state move no longer moves an entity's version** (#2191). `ctx.archive`, `ctx.unarchive`, `ctx.trash` and `ctx.restore` change no field anyone read. They set only the kernel's own `_substrat_*_at` columns. So the version, which an operation's `If-Match` is compared against, now skips their four events. Before this, a client that read a row, moved it and then sent a guarded write got `412 precondition_failed` ("changed since you read it") although nothing had changed, and the move operations hand back no `ETag` it could have used instead. Now the tag it holds still matches. A real edit in between still refuses it.

- Contracts exports `ENTITY_STATE_MOVE_TYPES`, the four move types, and the kernel's `entityVersionQuery` leaves them out. The query is now `ORDER BY id DESC LIMIT 1` over the existing `(entity_type, entity_id, id)` index, so it still walks the index and does not aggregate. Both adapters run the same SQL.
- **Archive is not write-refused.** A trashed row refuses writes on its own. An archived row does not: an edit sent with a tag read before someone archived the row is admitted, lands on the archived row, and the row stays archived.
- Only these four. The other kernel-authored events about an entity (a link or relink, a grant top-up or retirement, a holder bound or unbound, an attachment added or removed) still move the version. Whether any of them is content is a separate decision.
- A row whose only events are moves, such as one seeded without an event, has no version, as it had none before it was moved.
- **At deploy:** the rule changes for a vertical when it is next pushed on a release carrying this. A client holding a tag it read from a row whose newest event was a move, or an idempotent replay recorded from such a call, gets one `412` on its next guarded write, re-reads and carries on. That is the safe direction: no write is admitted that the old rule would have refused for a content change.

The concurrency docs (`concepts/api-design`, `concepts/scope-host`) state the rule.
