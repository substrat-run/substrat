---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/kernel': patch
'@substrat-run/contract-tests': patch
---

Fixes the event drain on the hosted adapter. A Durable Object refuses a statement with more than 100 bound parameters, and marking a drained batch bound one parameter per event. The default batch is 200, so on a real Durable Object every default drain of more than 100 events failed and marked nothing. Reopening drained events (`redrainEvents`, up to 5000 per call) failed past 100 in the same way.

The platform's other statements that took a list now bind it as one JSON array too. These are the fleet listing's status filter and the audit log's action filter (neither list had a length bound, because an entry may repeat), the freshness probe's event types, and the cross-vertical export read and count. The node adapter has no parameter limit on platform SQL, so these failed only on the hosted adapter. They are converted on both, so the two adapters keep running the same statements.

Every converted statement is checked on workerd for behaviour past the limit. `contract-tests` drains, stamps and reopens 350 events in one scope, and filters the fleet and the audit log by 151-entry lists. The freshness probe and both export statements are run with 150 event types. The query plan is compared with the one-parameter-per-entry form's for three statements only: the export read, the export count and the drain-stamp count. Each uses the same index as before, on a scope with no table statistics. The other statements are checked for behaviour only. Once `ANALYZE` has run on a scope, the export read chooses a slower plan than the old form did; it returns the same rows (#1787).
