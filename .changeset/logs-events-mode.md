---
"@substrat-run/dashboard-web": minor
---

Logs in Observability is now one stream card with two modes, Lines and Events, chosen by tabs along its top. Events groups an app's emitted events by event type, operation, actor, version, entity type, PII class or a payload field, with a bar per group and when each group last fired. Clicking an event type narrows the view to that type, grouped by the operation that emitted it. Existing links to the logs and events views still open the same mode.
