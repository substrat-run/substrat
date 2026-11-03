---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/connector-fortnox': minor
---

A deployment can ask for an immediate poll of its scope's bindings of one provider (`/internal/connections/sync`, `syncConnections` in vertical-host) and reads what each poll did; Fortnox answers it through `pollFortnoxScope`, and `sweepFortnoxLedger` takes an optional `scopeId`.
