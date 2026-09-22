---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

Staff get a fleet-wide read for "is the platform's own intent drain keeping up".

`@substrat-run/contracts` adds `platformRequestBacklog` / `PlatformRequestBacklog`: a count
of platform-intent deliveries the drain has given up on TERMINALLY, over a window — never a
queue depth. A still-`pending` intent lives in the vertical's own scope DO (K-31) and is not
observable fleet-wide.

`@substrat-run/control-plane-api` adds `GET /platform-requests/backlog` (staff/service
only, tenant and builder credentials refused). It sums the ops-failure record's
`intent.<kind>` rows — the same one `/connections/health`'s connector dead-letter count
already reads — across every intent kind the platform registers plus one
`connector:<provider>` kind per provider that has (or had) a live connection, over the same
7-day window and per-kind bound as that dead-letter count. A count that hits the bound is
marked `capped`.

This is the backend half of the console's new Health → Services page (#1690 §2), which
composes it alongside the existing connection-health summary, sweep-run record, service
metrics and version-registry reads. No other package changed.
