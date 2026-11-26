---
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane": patch
---

A connection's connector sweep can now run from that connection's own alarm instead of the scheduled pass (K-69, step 4.2 of the tenant-scale RFC). `defineConnectionSweepDO` is one object per connection that holds only its address and its alarm: each run sweeps the one connection and arms the next at its provider's interval, or at the time a crash back-off or poll interval ends. A revoked connection clears its object. The control plane's `CONNECTOR_SWEEP_OWNER` (`connection`, unset by default) hands the sweep to these objects. The pass then only checks that each live connection's object is armed (logged as `connector-wake-check`) and sweeps a connection itself only when its object cannot be reached. Attempt rows, crash back-off, per-connection budgets, landings and the operator's pause are unchanged. `runConnectorSweep` takes `connections`, to sweep only those, and `onNextAttempt`, which reports when a connection the sweep waited out is worth trying again.
