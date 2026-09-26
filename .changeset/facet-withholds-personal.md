---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/dashboard-web': minor
---

The event explorer now groups by a payload field only over events whose PII class is `none`. Before, grouping by a field such as `email` or `body` gave one row per person or per message. Events classed as pseudonymous or direct personal data are now left out of the rows and counted separately, in a new `withheldPersonal` number beside `erased`, so you can see how many were left out. An event with an unrecognised class is left out too. For a payload grouping, the event total is now the grouped events plus `erased` plus `withheldPersonal`. Grouping by event type, operation, actor, version, entity type, PII class or invocation still counts every event.

The class belongs to the whole event, not to one field, so an event classed `none` that carries personal data anyway is still grouped. The explorer is also not the only way to read the outbox: the SQL console and the table browse read the same events and are not narrowed by this change.

An app pushed with Substrat packages from before this release cannot withhold anything itself, so the control plane no longer passes on its payload groupings. It answers with no rows, counts every event that was not erased as withheld, and sets `withheldReason` to `vertical-predates-rule`. Grouping that app's events by type or any other built-in dimension still works. Pushing the app again is not enough on its own, because its version ranges do not reach this release: update the app's Substrat packages to this release, then push it.

The access log entry for an event-explorer read now records `withheldPersonal`, and `withheldReason` when it is set, so an audit shows what a read held back.

In the dashboard's Logs › Events view, a payload grouping shows how many events were withheld as personal data, and says so plainly when all of them were. For an app on older Substrat packages, it says that payload groupings are unavailable until its packages are updated and it is pushed again.
