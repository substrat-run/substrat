---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/docs': patch
---

`EntityDef.stamps` takes the updated pair, `updatedAt` and `updatedBy`, held true by the host on every row a call emits about (#2166).

- A derived create writes all four stamps. A derived update writes the updated pair with every write it makes; one that sends nothing still writes nothing.
- The host holds the pair on every row an operation, a consumer or an imported-event handler emits about. The row must carry that call's `ctx.now()` and principal, or the call fails `internal` and rolls back. **An authored handler on an entity that declares the pair, and forgets to stamp a row it emits about, now fails**: set `updated_at` and `updated_by` wherever you write the row. The host reads the emits, not the writes. An emit about a stamped row counts as a write to it, so a handler that only announces the row stamps it too. A write that emits only about another entity, such as the parent, is not checked. A deleted row is not checked. Neither are kernel writes (archive, trash, restore, links, attachments, grants), which leave the pair as it was, nor an emit rolled back inside `ctx.atomic`.
- An entity that declares no updated stamp is never read, and a scope with no such entity pays nothing.
- `defineEntities` also refuses a stamp kind named twice, and an updated stamp on a composite primary key, which no event can name.
- The manifest gains `updatedStamps`, derived by `manifestEntities()`. It is optional and additive, and absent when no entity declares the pair, so existing manifests are unchanged.
