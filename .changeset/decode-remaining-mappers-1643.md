---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
'@substrat-run/contract-tests': patch
---

Three more spine reads check what they return instead of casting it.

The delivery list an event's effects carry, the scope's dead-letter list and the denial summary
grouped by operation each read stored columns and handed them back typed as valid, without asking
the value. A delivery whose `attempts` was `-1`, `1.5` or text reached a caller typed as a
non-negative integer. They are decoded against their published schemas now, on the same rule as the
history and denial reads.

**A column with an honest empty value comes back empty, and says so.** A nullable column that
does not decode (a delivery's error or call id, a bucket's operation) reads as `null` beside a new
optional `decodeError` on `EventDelivery`, `DeadLetter` and `DenialOperationBucket`. A healthy row
carries none, so a clean list reads exactly as it did.

**A column with none is refused, naming it.** `attempts`, a time, an id or a consumer that breaks
its schema throws with the column named, rather than being returned as though it were fine.

Two additions to `@substrat-run/contracts`, both additive. `DeadLetter` had no schema and is now
one (`deadLetter`); its type is unchanged. `deliveryConsumer` names what a delivery's consumer can
be: a module id, or `executor:<id>` for an executor, with whatever id registration accepted (it takes any string). The contract used to type it as a bare module
id, which an executor's delivery never was; `EventDelivery.consumer` accepts both now, and its
inferred type is the same.
