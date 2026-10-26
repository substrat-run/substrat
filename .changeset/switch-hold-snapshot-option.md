---
'@substrat-run/adapter-cloudflare': minor
---

`CloudflareScopeHost` takes `switchHoldSnapshotMs`, how long one read of the rewind hold serves a pass (#1819). It defaults to `SWITCH_HOLD_SNAPSHOT_MS` (2 s), so a deployment that sets nothing behaves as before. A rewind's settle is derived from it (half as long again, 3 s at the default) and cannot be set on its own, so it always outlasts the snapshot. The option exists so tests do not have to wait the production seconds.
