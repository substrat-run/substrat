---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
"@substrat-run/console": patch
---

A daily stale-scopes report finds the scopes nothing will clean up. Once a UTC day the platform sweep lists, from the directory alone: live scopes whose tenant is not active or whose vertical is gone, active primary scopes no hostname or peer binding reaches, scopes stuck provisioning, forks and previews with no expiry or past an expiry the GC has not reaped, and archived scopes with no archive date. It also lists active primary scopes with no routed request in 30 days, judged from the daily request rollup and only once the rollup covers the window. Each finding keeps when it was first and last seen. Staff read them at `GET /stale-scopes`, and the console lists them on the Scopes page. The report moves nothing. Contracts adds `staleScope`, `staleScopeTake`, `staleScopesReading` and `staleScopeFindingKind`. The kernel adds the `staleScopes` sweep option and the optional `HostAdmin.recordStaleScopes`, `listStaleScopes` and `listStaleScopeTakes`, which both adapters implement.
