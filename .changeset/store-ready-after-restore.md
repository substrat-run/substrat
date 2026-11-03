---
'@substrat-run/control-plane-api': minor
---

A restore asks each committed store `substrat.selfcheck` before the erasure replay and the deployment's load (D-69), waiting a bounded time for a store that answers 503 while it brings restored data forward. A store that stays 503 or answers a 5xx is named in `storesNotReady`, and the restore answers `incomplete: true` with a 502. A backup source that answers 503 is a store busy: a request says so, and a job waits with a growing backoff, honouring `Retry-After`, until its deadline.
