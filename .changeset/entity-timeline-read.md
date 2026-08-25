---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/demo-callout': patch
'@substrat-run/demo-handlebar': patch
'@substrat-run/demo-manyfold': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-rally': patch
---

An entity's history is a read the kernel owns

Reading `_substrat_outbox` for one entity is a sanctioned projection — rule 3 bans writes
to the spine, not reads, because "show me the history of this thing" has no other source.
What was missing was a supported SHAPE, and five demos wrote the query by hand in its
absence. They did not agree, and the disagreements were not cosmetic.

| Demo | Order | Cursor |
|---|---|---|
| callout, handlebar | `rowid` | `rowid` |
| meridian, rally | `occurred_at, rowid` | `occurred_at` |
| manyfold | `rowid` | *(unpaged)* |

**Meridian's and rally's paging dropped events.** The step was `occurred_at > ?`, so every
row sharing the last one's timestamp was skipped — and sharing it is the norm, not a rare
tie: `ctx.now()` is stable for a whole invocation (#812), so every event one operation
emits carries the identical instant. A page boundary inside them lost the rest, and no
test would have caught it.

```ts
import { readTimeline } from '@substrat-run/kernel';

assertAllowed(await ctx.check(WO.read, entity));   // the caller checks. always
return readTimeline(ctx, entity, input);           // { entries, nextCursor }
```

Each entry is `{ id, type, occurredAt, actor }`, and two of those four are not what the
hand-written `SELECT` was getting:

- **`actor` is the union, decoded.** The column stores `JSON.stringify(actor)` over
  `PrincipalId | { system } | { connection }`, so a principal is stored *with its quotes*.
  `SELECT actor` returns a string that looks usable and is not; the obvious repair — trim
  the quotes — then breaks on a system actor. An agent building a timeline hit this as a
  real bug and had to read the adapter source to find it.
- **`id` is the entity's version at that point** (#901) — the token `ctx.versionOf`
  returns and `If-Match` compares (#129), so listing the history, naming a version and
  refusing a stale write stop being three vocabularies. It is therefore the cursor:
  `ORDER BY id` is creation order because `ulid()` is monotonic, and `OUTBOX_ENTITY_INDEX`
  makes the walk a seek with no new DDL. A `rowid` cursor could use neither, and does not
  survive a restore.

`readHistory` is the same walk with what a history VIEW needs — `payload`, `authorization`
(which permission, and which grant), `piiClass`/`subjectId`. Two nullables there are facts
rather than gaps: **`payload` is null after an erasure**, because a shred keeps the
envelope and destroys what was said, so a history correctly degrades to "someone changed
this, then"; and `authorization` is null when the row predates it being recorded, which is
not the same as having checked nothing.

Neither read checks a permission, deliberately. A helper that gated itself would be a
second, invisible policy surface; one that gated itself on nothing would be an unchecked
path into every event in the scope. Both are worse than the one line at the call site.

Also fixed on the way: Callout's and Handlebar's hand-mounted timeline routes never applied
the page projection `mountOperations` does for declared routes, so since these operations
became paged (#811) they answered `{ entries, nextCursor }` to an app that typed the body
as an array and called `.map` on it. The scenarios invoke the operation and never the
route, so nothing saw it. Both now emit the `Link` continuation and both apps WALK it —
reading only the body is how a history strip silently stops at twenty events, which an
order reaches in a working week — and a route-level test drives more events than one page
fits over real HTTP, since that is the only layer where the truncation exists.

Both adapters are held to all of it by a new contract suite.
