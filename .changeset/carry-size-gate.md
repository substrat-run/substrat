---
'@substrat-run/control-plane-api': minor
---

A copy of a scope into another scope's store is refused before its first page when the source is larger than `COPY_MAX_BYTES` (4 GiB, `copyMaxBytes` on `createControlPlaneApi`). The refusal is a 413 naming the size, where the copy used to fail at the destination's commit. `beginTransfer` and `transferScope` take the limit as `maxBytes`.
