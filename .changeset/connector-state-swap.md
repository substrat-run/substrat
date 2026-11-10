---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`HostAdmin.swapConnectorState` writes a connector's state row only if it still holds the value read, so two writers that raced on one row cannot both win.
