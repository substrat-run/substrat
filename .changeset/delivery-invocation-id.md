---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A delivery now records which request attempted it, so a retry can be told apart from the call that first produced the work.

Events already carried the identifier of the request that produced them, and a delivery could be traced back to its event. What that gave was the call that *emitted* the work, never the call that *attempted to deliver* it — and for anything with retries those are routinely different. The first attempt happens while the original request is still finishing; every attempt after it happens on a background sweep minutes or hours later. So a delivery that eventually gave up appeared to belong to the request that started it, and the work that actually failed was filed under a call that had long since returned successfully.

The identifier now goes onto the delivery as each attempt is written, on both the self-hosted and the hosted store, and it moves with the row — a record always describes its most recent attempt, the way the attempt count and the timestamp already do. Nothing is invented where none was supplied: a background sweep, a scheduled run or a seeding script records none, which reads as unrecorded rather than as an attempt that belonged to nowhere. Deliveries already recorded keep that unrecorded value; nothing can decide afterwards which attempt produced them.

Both places a delivery is read carry the new field — the view of what one event set off, and the list of deliveries that gave up. The second of those already showed a request identifier, which was the emitting call; it now shows both, and describes each for what it is.

No application code changes to adopt it. It does take a redeploy: the identifier is minted by platform code an app bundles into its own deployment, so an app already running keeps recording nothing until it is rebuilt on this version and pushed.
