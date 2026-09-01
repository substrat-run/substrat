---
'@substrat-run/adapter-sqlite': patch
---

The pure host's `clock` now decides when a grant, an entitlement or a schedule has expired, not just what `ctx.now()` reads. A frozen or manual clock can therefore be advanced past a grant's `expiresAt` and watch the check start denying, instead of the only option being a one-second window and a sleep. Hosts built without a `clock` are unchanged — the default is still the wall clock.
