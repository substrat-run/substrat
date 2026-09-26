---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard-web': minor
---

Grouping your app's events by a payload field now counts only events that are not classed as personal data. Before, grouping by a field such as `email` or `body` gave one row per person or per message, which made the event explorer a way to search for people. Events classed as pseudonymous or direct personal data are now left out of the rows and counted separately, in a new `withheldPersonal` number beside `erased`, so you can see how many were left out. An event with an unrecognised class is left out too. For a payload grouping, the event total is now the grouped events plus `erased` plus `withheldPersonal`. Grouping by event type, operation, actor, version, entity type, PII class or invocation still counts every event.

An app last pushed before this change cannot withhold anything itself, so the control plane no longer passes its payload groupings on. It answers with no rows, counts every event that was not erased as withheld, and sets `withheldReason` to `vertical-predates-rule`. Grouping that app's events by type or any other built-in dimension still works, and pushing the app again brings payload groupings back.

In the dashboard's Logs › Events view, a payload grouping shows how many events were withheld as personal data, and says so plainly when all of them were. For an app pushed before this change, it says that payload groupings are unavailable until the app is pushed again.
