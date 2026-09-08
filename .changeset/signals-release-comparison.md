---
'@substrat-run/dashboard': minor
---

The per-version comparison (#1236): an Update comparison card on the app's
Observability tab shows the version this app RUNS beside the one an update
would move it to — requests, error rate, and CPU p50/p99 from the same 24-hour
version-stamped traffic the release ledger reads. It renders only when an
update actually exists; an app already on prod's head gets nothing, because an
empty comparison is not information. Requests and errors sum across a version's
scripts while the percentiles come from its busiest one — percentiles cannot be
summed, and the busiest script is where the latency story happened.

The (running, update) frame every per-app tab reasons about is now one helper,
`versionPair`, instead of three inline restatements: running is the bound
version, else the prod head for an unpinned scope, and an update is offered iff
prod points somewhere other than the version the scope effectively runs — the
rule that keeps an unpinned scope from being offered its own head as an update.
