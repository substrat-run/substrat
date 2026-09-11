---
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': minor
---

The event explorer is on screen (#1239 stage 1). An Events panel on the app's
Observability tab groups the app's own events by a dimension — type, operation,
actor, version, entity type, PII class — or by any top-level payload field
(nested paths are a deliberate v1 omission), narrows them to one event type and
a window, and counts them. "Which operation emits most of
this", "which version were these under", answered on what the spine already
holds.

`facetEvents` landed as a kernel helper with no caller; this is the path to it:
the vertical's `/internal/facets`, a control-plane route delegating like the
history read, and the dashboard's own read.

Two things the view states rather than implies. **An erased payload is not a
missing value** — grouping by a payload field over a shredded event yields the
same null a never-present key does, so the erased count is shown beside the
buckets instead of folded into a "no value" row, and a distribution over
redacted history cannot read as complete. **A truncated result says so** — the
bucket list is capped, and a tail that exists but is not shown must not read as
a tail that does not exist.

Grouping applies on submit rather than per keystroke: every query is a scope
read, and a half-typed field name is a query nobody asked for. The chosen window
is resolved at submit too, so the counts on screen stay an answer to the question
that was asked.

What stage 1 does not yet carry, and #1239 stays open for: filtering by a
dimension's or a payload field's VALUE (the narrowing today is event type plus
the window), and counts over time — a facet is one total per bucket, not a
series.
