---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The recorded sweep history no longer drops one of two entries when a recurring schedule and a freshness expectation in the same app happen to share a name.

An app's sweep reports its outcomes in batches, one batch per pass, and each entry is filed under the thing it is about: a schedule under its operation name, a freshness expectation under its event type. Nothing keeps those two sets of names apart — `orders.placed` is an ordinary name for either — and duplicate protection judged an entry by its batch and that name alone, without asking which kind it was. So when a schedule and a freshness expectation in one app shared a name, whichever of the two arrived second in a batch was discarded as a duplicate, with no error. The history then showed a gap, and a gap is exactly what a stopped freshness check or a missed schedule run looks like there.

Duplicate protection now takes the kind into account, so the two entries are kept side by side. A batch delivered twice is still recorded once.

Existing platform stores are updated the next time they start, on both the self-hosted and the hosted store: the duplicate check is replaced, and every entry already recorded is kept exactly as it was. Nothing to change to adopt it.
