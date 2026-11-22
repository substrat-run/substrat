---
"@substrat-run/kernel": minor
---

A connector sweep the pass died in is waited out (doubling, capped) instead of run again on every pass; each connection's sweep is held to a byte and time share, can be paused, and runs on its own through `runConnectorSweep`.
